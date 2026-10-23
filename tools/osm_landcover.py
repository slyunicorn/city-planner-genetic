#!/usr/bin/env python3
"""
Offline OpenStreetMap land cover for the AI City Planner.

The browser's three live land cover sources (ESA bucket, Esri, Overpass)
can all be blocked by CORS or by the network. osmnx normally downloads
from Overpass too, so it is fed a local file instead:

  1. A Geofabrik .osm.pbf extract (download once; plain HTTPS).
  2. pyosmium cuts the area around the city out of it, keeping only
     water / land-use / natural features, into a small .osm XML file.
  3. osmnx.features_from_xml() turns that into polygons and lines.
  4. rasterio burns them into a single-band GeoTIFF (EPSG:4326) using
     the same WorldCover class codes the app uses.

Load the result in the app with "Load from file (.tif)".

Example (Chennai, same numbers as the Terrain tab):
  tools/.venv/bin/python tools/osm_landcover.py \
      --lat 12.9229 --lon 80.1275 --radius 30000 \
      --pbf tools/data/southern-zone-latest.osm.pbf
"""

import argparse
import math
import os
import sys
import time

import numpy as np
import pandas as pd
import osmium
import osmnx as ox
import rasterio
from rasterio.features import rasterize
from rasterio.transform import from_bounds
from shapely.geometry import box
from shapely.ops import linemerge, split


# Same tag -> WorldCover code mapping as OSM_NATURAL / OSM_LANDUSE in
# js/landcover.js, plus a few water and mangrove tags OSM uses.
OSM_NATURAL = {
    "water": 80, "wetland": 90, "wood": 10, "scrub": 20, "heath": 20,
    "grassland": 30, "bare_rock": 60, "sand": 60, "scree": 60,
    "beach": 60, "mud": 60, "glacier": 70,
}

OSM_LANDUSE = {
    "forest": 10, "farmland": 40, "farmyard": 40, "orchard": 40,
    "vineyard": 40, "meadow": 30, "grass": 30, "residential": 50,
    "industrial": 50, "commercial": 50, "retail": 50, "construction": 50,
    "brownfield": 50, "cemetery": 50, "military": 50, "quarry": 60,
    "reservoir": 80, "basin": 80, "salt_pond": 80, "aquaculture": 80,
}

# Line waterways: total width in metres they are drawn with.
WATERWAY_WIDTH_M = {"river": 30, "canal": 12, "stream": 4, "drain": 3}

# Draw low-priority classes first so water ends up on top
# (OSM_DRAW_ORDER in js/landcover.js, with mangrove next to wetland).
DRAW_ORDER = [20, 30, 40, 60, 10, 50, 90, 95, 70, 80]

KEYS = ("natural", "landuse", "waterway", "water", "wetland")


def class_of(tags):
    """WorldCover code for one feature's tags, or None."""

    natural = tags.get("natural")
    landuse = tags.get("landuse")

    if natural == "wetland" and tags.get("wetland") == "mangrove":
        return 95
    if natural in OSM_NATURAL:
        return OSM_NATURAL[natural]
    if landuse in OSM_LANDUSE:
        return OSM_LANDUSE[landuse]
    if tags.get("waterway") == "riverbank":
        return 80
    return None


def sea_polygons(coastlines, bbox):
    """
    Sea inside bbox, from natural=coastline lines. OSM draws every
    coastline with land on the left and water on the right, so the
    box is cut along the coast and each piece is tested against the
    nearest stretch of coastline. Terrain tiles often give the sea
    surface as 0 m, which the sea-level check does not catch.
    """

    if not coastlines:
        return []

    frame = box(*bbox)
    coast = linemerge(coastlines, directed=True)
    lines = list(getattr(coast, "geoms", [coast]))

    sea = []

    for face in split(frame, coast).geoms:

        p = face.representative_point()
        line = min(lines, key=lambda l: l.distance(p))

        d = line.project(p)
        a = line.interpolate(max(0.0, d - 1e-5))
        b = line.interpolate(min(line.length, d + 1e-5))

        # Negative cross product = point is right of the line = sea.
        cross = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x)

        if cross < 0:
            sea.append(face)

    return sea


def area_bbox(lat, lon, radius_m, pad=0.05):
    """Lon/lat box around the terrain square, with a small margin."""

    dlat = radius_m / 111_320.0
    dlon = radius_m / (111_320.0 * math.cos(math.radians(lat)))

    dlat *= 1 + pad
    dlon *= 1 + pad

    return lon - dlon, lat - dlat, lon + dlon, lat + dlat


def relevant(tags):
    return any(k in tags for k in KEYS)


def filter_pbf(src, dst, log=print):
    """
    One-time copy of a region keeping only land cover features (and
    the nodes / member ways they need). Later area extracts scan this
    much smaller file instead of the whole region.
    """

    t = time.time()
    tmp = dst + ".tmp.osm.pbf"

    with osmium.BackReferenceWriter(tmp, ref_src=src, overwrite=True,
                                    remove_tags=False) as writer:
        for obj in osmium.FileProcessor(src, osmium.osm.WAY | osmium.osm.RELATION) \
                .with_filter(osmium.filter.KeyFilter(*KEYS)):
            writer.add(obj)

    os.replace(tmp, dst)
    log(f"  filtered {os.path.basename(src)} -> {os.path.getsize(dst) / 1e6:.0f} MB "
        f"({time.time() - t:.0f} s)")


class Cancelled(Exception):
    pass


def extract_xml(pbf, bbox, xml_path, log=print, should_stop=lambda: False):
    """
    Write the relevant features inside bbox to an .osm XML file that
    osmnx can read. Three cheap passes over the PBF:
      1. relations: remember tagged multipolygons and their member ways
      2. ways (with node locations): keep those touching the bbox
      3. relations again: write the ones with a member in the bbox
    BackReferenceWriter then adds every referenced way and node.
    """

    west, south, east, north = bbox

    def in_bbox(way):
        for n in way.nodes:
            loc = n.location
            if loc.valid() and west <= loc.lon <= east and south <= loc.lat <= north:
                return True
        return False

    t = time.time()

    member_ways = set()
    for rel in osmium.FileProcessor(pbf, osmium.osm.RELATION) \
            .with_filter(osmium.filter.KeyFilter(*KEYS)):
        if should_stop():
            raise Cancelled()
        if rel.tags.get("type") == "multipolygon":
            member_ways.update(m.ref for m in rel.members if m.type == "w")

    log(f"  pass 1: {len(member_ways):,} candidate member ways "
          f"({time.time() - t:.0f} s)")

    t = time.time()
    rel_ways_in = set()
    n_ways = 0

    with osmium.BackReferenceWriter(xml_path, ref_src=pbf, overwrite=True) as writer:

        # Nodes still feed the location index but are dropped in C++
        # before reaching Python, which would otherwise be very slow.
        for way in osmium.FileProcessor(pbf, osmium.osm.NODE | osmium.osm.WAY) \
                .with_locations() \
                .with_filter(osmium.filter.EntityFilter(osmium.osm.WAY)):

            if should_stop():
                raise Cancelled()

            tagged = relevant(way.tags)

            if not tagged and way.id not in member_ways:
                continue

            if not in_bbox(way):
                continue

            if tagged:
                writer.add_way(way)
                n_ways += 1

            if way.id in member_ways:
                rel_ways_in.add(way.id)

        log(f"  pass 2: {n_ways:,} tagged ways in the area "
              f"({time.time() - t:.0f} s)")

        t = time.time()
        n_rels = 0

        for rel in osmium.FileProcessor(pbf, osmium.osm.RELATION) \
                .with_filter(osmium.filter.KeyFilter(*KEYS)):
            if rel.tags.get("type") != "multipolygon":
                continue
            if any(m.type == "w" and m.ref in rel_ways_in for m in rel.members):
                writer.add_relation(rel)
                n_rels += 1

        log(f"  pass 3: {n_rels:,} multipolygon relations in the area "
              f"({time.time() - t:.0f} s); writing XML...")


# The app samples land cover at 384 x 384, so very large areas do
# not need 10 m pixels; cap the raster side to keep memory sane.
MAX_SIDE_PX = 6000


def build_landcover(pbf, bbox, out, res=10.0, log=print, should_stop=lambda: False):
    """
    Build the land cover GeoTIFF for bbox = (west, south, east, north)
    from one local .osm.pbf, or a list of them (an area on the border of
    two regions). Returns the % of pixels that got a class.
    Raises ValueError when the area has no mapped features.
    """

    pbfs = [pbf] if isinstance(pbf, str) else list(pbf)

    west, south, east, north = bbox
    mid_lat = (south + north) / 2
    tags = {k: True for k in KEYS}

    log(f"Area: W {west:.4f}  S {south:.4f}  E {east:.4f}  N {north:.4f}")

    frames = []

    for i, src in enumerate(pbfs):

        xml_path = os.path.splitext(out)[0] + f".extract{i}.osm"

        log(f"1/3 Extracting OSM features from {os.path.basename(src)}")
        try:
            extract_xml(src, bbox, xml_path, log, should_stop)
            if should_stop():
                raise Cancelled()

            log("2/3 Building geometries with osmnx")
            frames.append(ox.features_from_xml(xml_path, tags=tags))
        except ox._errors.InsufficientResponseError:
            pass
        finally:
            if os.path.exists(xml_path):
                os.remove(xml_path)

    if not frames:
        raise ValueError("no mapped water / land-use features in this area")

    # Features near a region border are in both extracts.
    gdf = pd.concat(frames) if len(frames) > 1 else frames[0]
    gdf = gdf[~gdf.index.duplicated()]
    log(f"  {len(gdf):,} features")

    # Pixel grid in lon/lat with roughly `res` metres per pixel.
    deg_lat = res / 111_320.0
    deg_lon = res / (111_320.0 * math.cos(math.radians(mid_lat)))
    width = int(math.ceil((east - west) / deg_lon))
    height = int(math.ceil((north - south) / deg_lat))
    scale = max(width, height) / MAX_SIDE_PX
    if scale > 1:
        width = int(math.ceil(width / scale))
        height = int(math.ceil(height / scale))
    transform = from_bounds(west, south, east, north, width, height)

    # Lines (rivers, canals) get a real width, buffered in metres.
    utm = ox.projection.project_gdf(gdf)

    by_code = {}
    coastlines = []

    for (geom, geom_m, tags_row) in zip(gdf.geometry, utm.geometry,
                                        gdf.drop(columns="geometry").to_dict("records")):

        row_tags = {k: v for k, v in tags_row.items()
                    if isinstance(v, str)}

        kind = geom.geom_type

        if kind in ("Polygon", "MultiPolygon"):
            code = class_of(row_tags)
            if code:
                by_code.setdefault(code, []).append(geom)

        elif kind == "LineString" and row_tags.get("natural") == "coastline":
            coastlines.append(geom)

        elif kind in ("LineString", "MultiLineString"):
            width_m = WATERWAY_WIDTH_M.get(row_tags.get("waterway"))
            if width_m:
                buffered = ox.projection.project_geometry(
                    geom_m.buffer(width_m / 2),
                    crs=utm.crs, to_latlong=True)[0]
                by_code.setdefault(80, []).append(buffered)

    if should_stop():
        raise Cancelled()

    log("3/3 Rasterising")
    raster = np.zeros((height, width), dtype=np.uint8)

    # Sea first, so anything mapped on top of it (piers, islands,
    # beaches) keeps its own class.
    sea = sea_polygons(coastlines, bbox)
    if sea:
        rasterize(((g, 80) for g in sea), out=raster, transform=transform)
    log(f"  sea: {len(sea)} pieces from {len(coastlines)} coastline ways")

    for code in DRAW_ORDER:
        shapes = by_code.get(code)
        if not shapes:
            continue
        rasterize(((g, code) for g in shapes), out=raster,
                  transform=transform, all_touched=False)
        log(f"  class {code}: {len(shapes):,} shapes")

    if not raster.any():
        raise ValueError("no mapped water / land-use features in this area")

    with rasterio.open(
        out, "w", driver="GTiff", width=width, height=height, count=1,
        dtype="uint8", crs="EPSG:4326", transform=transform,
        compress="deflate", tiled=True, nodata=None,
    ) as dst:
        dst.write(raster, 1)
        # Read by the app to show the right attribution.
        dst.update_tags(SOURCE="OpenStreetMap")

    covered = 100.0 * np.count_nonzero(raster) / raster.size
    log(f"Wrote {os.path.basename(out)} ({width}x{height}, "
        f"{covered:.0f}% of pixels mapped)")
    return covered


def main():

    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--lat", type=float, required=True)
    ap.add_argument("--lon", type=float, required=True)
    ap.add_argument("--radius", type=float, required=True,
                    help="metres, same as the Terrain tab")
    ap.add_argument("--pbf", required=True,
                    help="Geofabrik .osm.pbf covering the area")
    ap.add_argument("--res", type=float, default=10.0,
                    help="output pixel size in metres (default 10)")
    ap.add_argument("--out", default=None,
                    help="output .tif (default tools/data/osm_landcover_<lat>_<lon>.tif)")
    args = ap.parse_args()

    if not os.path.exists(args.pbf):
        sys.exit(f"PBF not found: {args.pbf}\n"
                 "Download one from https://download.geofabrik.de/ first.")

    here = os.path.dirname(os.path.abspath(__file__))
    out = args.out or os.path.join(
        here, "data", f"osm_landcover_{args.lat:.4f}_{args.lon:.4f}.tif")

    try:
        build_landcover(args.pbf, area_bbox(args.lat, args.lon, args.radius),
                        out, args.res)
    except ValueError as e:
        sys.exit(str(e))

    print('Load it in the app with "Load from file (.tif)".')


if __name__ == "__main__":
    main()
