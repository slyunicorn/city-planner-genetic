#!/usr/bin/env python3
"""
Real road network from OpenStreetMap, to compare with the generated
plan on the metrics page ("Real roads vs plan").

  1. A one-time copy of a Geofabrik region that keeps only the roads
     (<region>-roads.osm.pbf, ROAD_CLASSES) and their nodes, plus a
     way index (bounding box per road, osm_landcover.way_index()).
  2. Per area: the roads whose box meets the area (an index lookup),
     then their nodes, both read with an id filter that runs in C++.
  3. Written as compact JSON: node lon/lat, and each road as a list of
     node indices (shared nodes = junctions). Stretches far outside
     the area are cut off.

Used by tools/serve.py (/api/roads/...). Also runnable on its own:
  tools/.venv/bin/python tools/osm_roads.py --lat 12.9229 --lon 80.1275 \\
      --radius 3000 --pbf tools/data/southern-zone-latest.osm.pbf
"""

import argparse
import datetime
import json
import os
import sys
import time

import osmium

import osm_landcover


# Streets a car can use - what the plan's roads stand for. Service
# roads (driveways, parking aisles), tracks, paths and footways are
# left out.
ROAD_CLASSES = (
    "motorway", "trunk", "primary", "secondary", "tertiary",
    "motorway_link", "trunk_link", "primary_link", "secondary_link",
    "tertiary_link", "unclassified", "residential", "living_street", "road",
)

# Kept around the requested area, as a share of its size.
AREA_PAD = 0.05


def is_road(way):
    return (way.tags.get("highway") in ROAD_CLASSES
            and way.tags.get("area") != "yes")


def off_ground(tags):
    """Bridge, tunnel or another layer: crosses roads without meeting them."""
    return (tags.get("bridge", "no") != "no"
            or tags.get("tunnel", "no") != "no"
            or tags.get("layer", "0") not in ("0", ""))


def filter_roads_pbf(src, dst, log=print):
    """One-time copy of a region with only ROAD_CLASSES ways and their nodes."""

    t = time.time()
    tmp = dst + ".tmp.osm.pbf"

    road_filter = osmium.filter.TagFilter(*[("highway", c) for c in ROAD_CLASSES])

    with osmium.BackReferenceWriter(tmp, ref_src=src, overwrite=True,
                                    remove_tags=False) as writer:
        for way in osmium.FileProcessor(src, osmium.osm.WAY).with_filter(road_filter):
            writer.add(way)

    os.replace(tmp, dst)

    # The copy's own header has no data date; keep the source's.
    with open(dst + ".date", "w") as f:
        f.write(data_date(src))

    log(f"  roads of {os.path.basename(src)} -> {os.path.getsize(dst) / 1e6:.0f} MB "
        f"({time.time() - t:.0f} s)")


def data_date(pbf):
    """Date of the OSM data in a .osm.pbf (replication timestamp, else file time)."""

    if os.path.exists(pbf + ".date"):
        with open(pbf + ".date") as f:
            return f.read().strip()

    try:
        header = osmium.io.Reader(pbf, osmium.osm.NOTHING).header()
        stamp = header.get("osmosis_replication_timestamp")
        if stamp:
            return stamp[:10]
    except Exception:
        pass

    return datetime.date.fromtimestamp(os.path.getmtime(pbf)).isoformat()


def build_roads(pbf, bbox, out, log=print, should_stop=lambda: False):
    """
    Write the roads around bbox = (west, south, east, north) from one
    roads .osm.pbf, or a list of them (an area on a region border), to
    `out` as JSON. Returns the number of roads.
    """

    pbfs = [pbf] if isinstance(pbf, str) else list(pbf)

    west, south, east, north = bbox
    px = (east - west) * AREA_PAD
    py = (north - south) * AREA_PAD
    w, s, e, n = west - px, south - py, east + px, north + py

    ways = {}
    coords = {}

    for src in pbfs:

        t = time.time()

        ids, boxes = osm_landcover.way_index(src, set(), log, should_stop, keep=is_road)

        near = ids[(boxes[:, 0] <= e) & (boxes[:, 2] >= w) &
                   (boxes[:, 1] <= n) & (boxes[:, 3] >= s)]

        for way in osmium.FileProcessor(src, osmium.osm.WAY) \
                .with_filter(osmium.filter.IdFilter(near.tolist())):

            if should_stop():
                raise osm_landcover.Cancelled()

            if way.id in ways or not is_road(way):
                continue

            ways[way.id] = {
                "h": way.tags.get("highway"),
                "l": 1 if off_ground(way.tags) else 0,
                "refs": [nd.ref for nd in way.nodes],
            }

        wanted = {r for way in ways.values() for r in way["refs"]} - coords.keys()

        for node in osmium.FileProcessor(src, osmium.osm.NODE) \
                .with_filter(osmium.filter.IdFilter(wanted)):
            if node.location.valid():
                coords[node.id] = (round(node.location.lon, 7), round(node.location.lat, 7))

        log(f"  {os.path.basename(src)}: {len(ways):,} roads, {len(coords):,} nodes "
            f"({time.time() - t:.0f} s)")

    if should_stop():
        raise osm_landcover.Cancelled()

    # Keep the stretches near the area: runs of segments whose box
    # meets the padded area.
    def near_area(a, b):
        return (min(a[0], b[0]) <= e and max(a[0], b[0]) >= w and
                min(a[1], b[1]) <= n and max(a[1], b[1]) >= s)

    index = {}
    nodes = []
    out_ways = []

    def node_index(ref):
        if ref not in index:
            index[ref] = len(nodes)
            nodes.append(coords[ref])
        return index[ref]

    for way in ways.values():

        run = []
        refs = way["refs"]

        for k in range(len(refs) - 1):

            a = coords.get(refs[k])
            b = coords.get(refs[k + 1])

            if a is not None and b is not None and near_area(a, b):
                if not run:
                    run.append(refs[k])
                run.append(refs[k + 1])
                continue

            if len(run) >= 2:
                out_ways.append({"h": way["h"], "l": way["l"], "n": [node_index(r) for r in run]})
            run = []

        if len(run) >= 2:
            out_ways.append({"h": way["h"], "l": way["l"], "n": [node_index(r) for r in run]})

    if not out_ways:
        raise ValueError("no mapped roads in this area")

    tmp = out + ".tmp"

    with open(tmp, "w") as f:
        json.dump({
            "source": "OpenStreetMap",
            "date": max(data_date(p) for p in pbfs),
            "files": [os.path.basename(p) for p in pbfs],
            "bbox": list(bbox),
            "classes": list(ROAD_CLASSES),
            "nodes": nodes,
            "ways": out_ways,
        }, f, separators=(",", ":"))

    os.replace(tmp, out)

    log(f"Wrote {os.path.basename(out)}: {len(out_ways):,} road pieces, "
        f"{len(nodes):,} nodes ({os.path.getsize(out) / 1e6:.1f} MB)")

    return len(out_ways)


def main():

    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--lat", type=float, required=True)
    ap.add_argument("--lon", type=float, required=True)
    ap.add_argument("--radius", type=float, required=True, help="metres")
    ap.add_argument("--pbf", required=True,
                    help="Geofabrik .osm.pbf (a -roads.osm.pbf copy is made next to it)")
    ap.add_argument("--out", default=None)
    args = ap.parse_args()

    src = args.pbf

    if not src.endswith("-roads.osm.pbf"):
        roads = src.replace("-latest.osm.pbf", "-roads.osm.pbf")
        if roads == src:
            roads = os.path.splitext(src)[0] + "-roads.osm.pbf"
        if not os.path.exists(roads):
            filter_roads_pbf(src, roads)
        src = roads

    out = args.out or os.path.join(
        os.path.dirname(os.path.abspath(__file__)), "data",
        f"osm_roads_{args.lat:.4f}_{args.lon:.4f}.json")

    try:
        build_roads(src, osm_landcover.area_bbox(args.lat, args.lon, args.radius), out)
    except ValueError as e:
        sys.exit(str(e))


if __name__ == "__main__":
    main()
