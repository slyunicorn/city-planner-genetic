#!/usr/bin/env python3
"""
Local server for the AI City Planner.

Serves the app (like `python3 -m http.server`) and builds OpenStreetMap
land cover on demand, so the browser gets land cover automatically even
when ESA / Esri / Overpass are blocked:

  1. The app sends the bbox of the terrain it just loaded.
  2. The smallest Geofabrik region covering it is picked from
     Geofabrik's index, and its .osm.pbf is downloaded with curl the
     first time (kept in tools/data/ for next time).
  3. tools/osm_landcover.py turns it into a land cover GeoTIFF, which
     is cached per area and handed back to the app.

Run from the repo root:
  tools/.venv/bin/python tools/serve.py          # then open http://localhost:8000/
"""

import argparse
import functools
import hashlib
import http.server
import json
import os
import subprocess
import sys
import threading
import time
import traceback
import urllib.error
import urllib.parse
import urllib.request
import uuid

from shapely import union_all
from shapely.geometry import box, shape
from shapely.prepared import prep

import osm_landcover


HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
DATA = os.path.join(HERE, "data")
CACHE = os.path.join(DATA, "cache")

INDEX_URL = "https://download.geofabrik.de/index-v1.json"
INDEX_PATH = os.path.join(DATA, "geofabrik-index-v1.json")
INDEX_MAX_AGE_S = 30 * 24 * 3600

# Refuse absurd requests (the app's largest sensible radius is tens of km).
MAX_BBOX_DEG = 3.0

# Bump when the raster format or classes change, to ignore old cache files.
CACHE_VERSION = "1"


jobs = {}
jobs_lock = threading.Lock()

# One build at a time: each one scans a whole .osm.pbf, and two
# downloads of the same region would clobber each other.
build_lock = threading.Lock()

_regions = None


# ------------------------------------------------------------
# Geofabrik regions
# ------------------------------------------------------------

def curl(url, dest, job=None, label=None):
    """Download url to dest with curl (resumable), reporting progress."""

    part = dest + ".part"
    total = None

    try:
        req = urllib.request.Request(url, method="HEAD")
        with urllib.request.urlopen(req, timeout=30) as r:
            total = int(r.headers.get("Content-Length") or 0) or None
    except Exception:
        pass

    proc = subprocess.Popen(
        ["curl", "-sS", "-L", "--fail", "-C", "-", "-o", part, url],
        stderr=subprocess.PIPE, text=True)

    while proc.poll() is None:
        if job and label:
            have = os.path.getsize(part) if os.path.exists(part) else 0
            pct = f"{100 * have / total:.0f}% of " if total else ""
            size = f"{(total or have) / 1e6:.0f} MB"
            job_message(job, f"Downloading {label}: {pct}{size}")
        time.sleep(1)

    if proc.returncode != 0:
        raise RuntimeError(
            f"download of {url} failed: {proc.stderr.read().strip() or proc.returncode}")

    os.replace(part, dest)


def load_regions():
    global _regions

    if _regions is not None:
        return _regions

    fresh = (os.path.exists(INDEX_PATH)
             and time.time() - os.path.getmtime(INDEX_PATH) < INDEX_MAX_AGE_S)
    if not fresh:
        curl(INDEX_URL, INDEX_PATH)

    with open(INDEX_PATH) as f:
        index = json.load(f)

    _regions = []
    for feat in index["features"]:
        props = feat["properties"]
        if not feat.get("geometry") or "pbf" not in props.get("urls", {}):
            continue
        geom = shape(feat["geometry"])
        _regions.append({
            "id": props["id"], "name": props["name"],
            "parent": props.get("parent"),
            "url": props["urls"]["pbf"],
            "shape": geom, "geom": prep(geom), "area": geom.area,
        })

    return _regions


def pick_region(bbox):
    """Smallest Geofabrik region covering the whole bbox (else its centre)."""

    area = box(*bbox)
    regions = load_regions()

    covering = [r for r in regions if r["geom"].covers(area)]
    if not covering:
        covering = [r for r in regions if r["geom"].covers(area.centroid)]
    if not covering:
        raise ValueError("no Geofabrik extract covers this location")

    return min(covering, key=lambda r: r["area"])


def region_paths(region):
    name = region["id"].replace("/", "_")
    return (os.path.join(DATA, f"{name}-latest.osm.pbf"),
            os.path.join(DATA, f"{name}-landcover.osm.pbf"))


def is_ready(region):
    return os.path.exists(region_paths(region)[1])


def children(region):
    return [r for r in load_regions() if r["parent"] == region["id"]]


def resolve_regions(region, area):
    """
    Regions whose data together cover `area` inside `region`, preferring
    ones already prepared on disk. An area on the border of two Indian
    zones is built from both zones instead of downloading all of India,
    and nothing bigger than a leaf region is ever downloaded when its
    sub-regions can do the job.
    """

    if is_ready(region):
        return [region]

    part = area.intersection(region["shape"])
    kids = [k for k in children(region)
            if k["shape"].intersection(part).area > 0]

    if not kids:
        return [region]

    # Sub-regions that leave a real gap (not a full partition): use the parent.
    gap = part.difference(union_all([k["shape"] for k in kids]))
    if gap.area > 0.01 * part.area:
        return [region]

    out = []
    for k in kids:
        out += resolve_regions(k, area)
    return out


def ensure_pbf(region, job):
    name = region["id"].replace("/", "_")
    path, filtered = region_paths(region)

    if not os.path.exists(path):
        curl(region["url"], path, job, f"OSM extract '{region['name']}'")

        # Geofabrik publishes an md5 next to every extract.
        try:
            with urllib.request.urlopen(region["url"] + ".md5", timeout=30) as r:
                want = r.read().decode().split()[0]
            job_message(job, "Checking download")
            h = hashlib.md5()
            with open(path, "rb") as f:
                for chunk in iter(lambda: f.read(1 << 20), b""):
                    h.update(chunk)
            if h.hexdigest() != want:
                os.remove(path)
                raise RuntimeError(f"{name} download is corrupt (md5 mismatch); try again")
        except urllib.error.URLError:
            pass

    # One-time land-cover-only copy: area builds scan ~8x less data.
    if not os.path.exists(filtered):
        job_message(job, f"Preparing '{region['name']}' for fast lookups "
                         "(one time per region, about 2 min)")
        osm_landcover.filter_pbf(path, filtered, log=lambda s: print("[landcover]", s))

    return filtered


# ------------------------------------------------------------
# Jobs
# ------------------------------------------------------------

def job_message(job, msg):
    job["message"] = msg.strip()
    if job.get("console"):
        print("\r  " + job["message"].ljust(70), end="", flush=True)


def cache_path(bbox):
    key = CACHE_VERSION + ":" + ",".join(f"{v:.4f}" for v in bbox)
    return os.path.join(CACHE, hashlib.sha1(key.encode()).hexdigest()[:16] + ".tif")


def run_job(job):
    bbox = job["bbox"]
    out = job["file"]

    try:
        if not build_lock.acquire(blocking=False):
            job_message(job, "Waiting for the previous area to finish")
            build_lock.acquire()

        try:
            if job["cancel"]:
                raise osm_landcover.Cancelled()

            if not os.path.exists(out):
                job_message(job, "Finding the OSM region for this area")
                regions = resolve_regions(pick_region(bbox), box(*bbox))
                print(f"[landcover] {fmt_bbox(bbox)} -> Geofabrik "
                      + ", ".join(f"'{r['id']}'" for r in regions))

                pbf = [ensure_pbf(r, job) for r in regions]

                def log(line):
                    print("[landcover]", line)
                    job_message(job, line)

                tmp = out[:-4] + ".tmp.tif"
                osm_landcover.build_landcover(
                    pbf, bbox, tmp, log=log, should_stop=lambda: job["cancel"])
                os.replace(tmp, out)
        finally:
            build_lock.release()

        job["state"] = "done"
        job_message(job, "Done")

    except osm_landcover.Cancelled:
        print(f"[landcover] cancelled {fmt_bbox(bbox)} (newer area requested)")
        job["state"] = "error"
        job_message(job, "cancelled: a newer area was requested")

    except Exception as e:
        traceback.print_exc()
        job["state"] = "error"
        job_message(job, str(e) or type(e).__name__)


def leaves(region):
    kids = children(region)
    if not kids:
        return [region]
    return [leaf for k in kids for leaf in leaves(k)]


def prefetch(region_id):
    """Download and prepare every leaf region under region_id, up front."""

    matches = [r for r in load_regions() if r["id"] == region_id]
    if not matches:
        sys.exit(f"unknown Geofabrik region '{region_id}' (see {INDEX_PATH})")

    todo = leaves(matches[0])
    print(f"Prefetching {len(todo)} region(s) under '{region_id}': "
          + ", ".join(r["id"] for r in todo))

    for i, r in enumerate(todo, 1):
        print(f"[{i}/{len(todo)}] {r['name']}")
        if is_ready(r):
            print("  already prepared")
            continue
        ensure_pbf(r, {"console": True})
        print(f"\r  ready: {os.path.basename(region_paths(r)[1])}".ljust(72))

    print("All prepared. Land cover for these areas now needs no downloads.")


def fmt_bbox(b):
    return f"W {b[0]:.4f} S {b[1]:.4f} E {b[2]:.4f} N {b[3]:.4f}"


def start_job(bbox):
    out = cache_path(bbox)

    with jobs_lock:
        # Same area already being built: share that job.
        for job in jobs.values():
            if job["file"] == out and job["state"] == "running":
                return job

        # The app only ever wants its newest area; stop older builds
        # so this one does not queue behind them.
        for old in jobs.values():
            if old["state"] == "running":
                old["cancel"] = True

        job = {"id": uuid.uuid4().hex, "bbox": bbox, "file": out,
               "state": "running", "message": "Starting", "cancel": False}
        jobs[job["id"]] = job

    if os.path.exists(out):
        job["state"] = "done"
        job_message(job, "Cached")
    else:
        threading.Thread(target=run_job, args=(job,), daemon=True).start()

    return job


# ------------------------------------------------------------
# HTTP
# ------------------------------------------------------------

class Handler(http.server.SimpleHTTPRequestHandler):

    def end_headers(self):
        # Always serve the newest JS/CSS while developing.
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, fmt, *args):
        if "/api/landcover/status" not in self.path:
            super().log_message(fmt, *args)

    def send_json(self, obj, code=200):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        url = urllib.parse.urlparse(self.path)

        if not url.path.startswith("/api/"):
            return super().do_GET()

        q = {k: v[0] for k, v in urllib.parse.parse_qs(url.query).items()}

        try:
            if url.path == "/api/health":
                return self.send_json({"ok": True})

            if url.path == "/api/landcover/start":
                bbox = tuple(float(q[k]) for k in ("west", "south", "east", "north"))
                w, s, e, n = bbox
                if not (-180 <= w < e <= 180 and -85 <= s < n <= 85):
                    return self.send_json({"error": "bad bbox"}, 400)
                if e - w > MAX_BBOX_DEG or n - s > MAX_BBOX_DEG:
                    return self.send_json({"error": "area too large"}, 400)
                job = start_job(bbox)
                return self.send_json({"id": job["id"]})

            job = jobs.get(q.get("id", ""))
            if not job:
                return self.send_json({"error": "unknown job"}, 404)

            if url.path == "/api/landcover/status":
                return self.send_json({"state": job["state"], "message": job["message"]})

            if url.path == "/api/landcover/result":
                if job["state"] != "done":
                    return self.send_json({"error": "not ready"}, 409)
                with open(job["file"], "rb") as f:
                    body = f.read()
                self.send_response(200)
                self.send_header("Content-Type", "image/tiff")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
                return

            return self.send_json({"error": "not found"}, 404)

        except (KeyError, ValueError) as e:
            return self.send_json({"error": f"bad request: {e}"}, 400)


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--port", type=int, default=8000)
    ap.add_argument("--prefetch", metavar="REGION",
                    help="download and prepare a Geofabrik region (e.g. india) "
                         "and all its sub-regions, then exit")
    args = ap.parse_args()

    os.makedirs(CACHE, exist_ok=True)

    # Show build progress immediately even when output is not a terminal.
    sys.stdout.reconfigure(line_buffering=True)

    if args.prefetch:
        return prefetch(args.prefetch)

    handler = functools.partial(Handler, directory=ROOT)
    server = http.server.ThreadingHTTPServer(("127.0.0.1", args.port), handler)

    print(f"Serving {ROOT}")
    print(f"Open http://localhost:{args.port}/  (Ctrl+C to stop)")

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
