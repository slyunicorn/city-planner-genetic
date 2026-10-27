// js/buildings.js
// Buildable block cells (shared by facilities, hatching and
// buildings) and the gray building footprints drawn in them.
// Plain script: shares the global scope with the other js/ files,
// so load order in index.html matters.

// ============================================================
// BLOCK CELLS
// ============================================================
//
// One block = one Voronoi cell of the block points, clipped to
// the city. A block is BUILDABLE when less than a quarter of its
// area is unbuildable ground (sampled on a 6 x 6 grid against
// isLand(), so sea level and every land cover rule count).
//
// This is the single rule for "can something go in this block":
//   - the hatched overlay marks exactly the blocks that fail it
//   - facilities may only be placed in / moved into blocks that
//     pass it
//   - only blocks that pass it get a building
//
// The cells are cached: recomputing them on every facility epoch
// and every simplification frame would be wasted work, since
// they only change when the block points, the boundary, the
// land cover mask or the sea level change - all part of the key.
// ============================================================

const BLOCK_UNBUILDABLE_LIMIT = 0.25;
const BLOCK_SAMPLE = 6;

let blockCellsCache = null;


// Share (0..1) of a polygon's area that is unbuildable,
// sampled on a BLOCK_SAMPLE x BLOCK_SAMPLE grid over its box.
function cellUnbuildableFraction(polygon) {

    const xs = polygon.map(p => p[0]);
    const ys = polygon.map(p => p[1]);

    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);

    let total = 0;
    let blocked = 0;

    for (let sy = 0; sy < BLOCK_SAMPLE; sy++) {
        for (let sx = 0; sx < BLOCK_SAMPLE; sx++) {

            const px = minX + (sx + 0.5) / BLOCK_SAMPLE * (maxX - minX);
            const py = minY + (sy + 0.5) / BLOCK_SAMPLE * (maxY - minY);

            if (!d3.polygonContains(polygon, [px, py])) {
                continue;
            }

            total++;

            if (!isLand(px, py)) {
                blocked++;
            }
        }
    }

    // Too thin for any sample to land inside: judge by its centre.
    if (total === 0) {
        const [cx, cy] = d3.polygonCentroid(polygon);
        return isLand(cx, cy) ? 0 : 1;
    }

    return blocked / total;
}


function getBlockCells() {

    const generators =
        getInsideCityPoints();

    if (generators.length < 2) {
        return null;
    }

    // Cheap fingerprint of the block points' positions.
    let fingerprint = generators.length;

    for (let i = 0; i < generators.length; i++) {
        fingerprint +=
            generators[i].x * (i + 1) * 0.6180339 +
            generators[i].y * (i + 1) * 1.4142135;
    }

    const key =
        `${cityClosed ? getBoundaryPath() : "open"}|` +
        `${seaLevelM}|${R}|${fingerprint}`;

    if (
        blockCellsCache &&
        blockCellsCache.key === key &&
        blockCellsCache.habMask === habMask
    ) {
        return blockCellsCache;
    }

    const delaunay =
        d3.Delaunay.from(generators, d => d.x, d => d.y);

    const voronoi =
        delaunay.voronoi(getVoronoiExtent());

    const cityPolygon =
        cityClosed
            ? getBoundaryPolygonPoints(200).map(q => [q.x, q.y])
            : [];

    const cells = generators.map((site, i) => {

        const raw = voronoi.cellPolygon(i);

        if (!raw) {
            return null;
        }

        const polygon =
            cityPolygon.length
                ? clipPolygonToConvex(cityPolygon, raw)
                : raw.slice(0, -1);

        if (polygon.length < 3) {
            return { site, polygon, unbuildable: 1, buildable: false };
        }

        const unbuildable =
            cellUnbuildableFraction(polygon);

        return {
            site,
            polygon,
            unbuildable,
            buildable: unbuildable < BLOCK_UNBUILDABLE_LIMIT
        };
    });

    blockCellsCache = {
        key,
        habMask,
        delaunay,
        cells,
        buildings: null,

        // The block a point falls in is its nearest block point's
        // cell, so delaunay.find() is the lookup.
        isBuildableAt(x, y) {
            const cell = cells[delaunay.find(x, y)];
            return !!cell && cell.buildable;
        }
    };

    return blockCellsCache;
}


// ============================================================
// BUILDINGS
// ============================================================
//
// One quadrilateral per plot that has room for it. A plot is a
// buildable block, or 2-4 neighbouring blocks combined (below).
//
//   1. Orientation: the plot's longest edge. That edge is a
//      street frontage, so the building faces the street.
//   2. Size: in that frame, the largest box with the plot's own
//      aspect ratio, centred on the plot centroid, that still
//      fits inside the plot (binary search on its scale: all
//      corners inside and no plot edge crossing the box, which
//      also holds for the non-convex combined plots), then
//      shrunk to BUILDING_FILL of that so a small setback is
//      left between the building and the surrounding roads.
//   3. Shape: a stable per-plot hash narrows one side of the
//      box by up to BUILDING_TAPER, so the footprints are a mix
//      of rectangles and trapezoids rather than identical boxes.
//      Narrowing only ever moves corners inward, so the result
//      still fits.
//   4. Room: plots whose building would have a side shorter
//      than BUILDING_MIN_SIDE * R, or whose footprint touches
//      unbuildable ground, get none.
//
// A building that a road runs through (Urquhart can keep a short
// diagonal across a block, the extra-edges slider adds more, and
// straightening moves roads) is shrunk step by step
// (BUILDING_SHRINK_STEPS) until it clears every road, and only
// dropped if even the smallest step still collides or breaks the
// minimum size.
//
// Buildings are the last step: drawBuildings() draws nothing
// until a Simplify run has finished (buildingsReady, state.js),
// and the footprints are computed then, on the final roads.
// ============================================================

const BUILDING_FILL = 0.8;
const BUILDING_MIN_SIDE = 0.2;
const BUILDING_TAPER = 0.3;

// Scales tried, in order, when a road runs through a building.
const BUILDING_SHRINK_STEPS = [1, 0.85, 0.7, 0.55];

// How many buildings the last drawBuildings() showed, and what
// kind (see planBuildings()).
let shownBuildingCount = 0;
let shownBuildingStats = null;


// Does segment p-q properly cross segment a-b?
function segmentsCross(p, q, a, b) {

    const cross = (o, u, v) =>
        (u[0] - o[0]) * (v[1] - o[1]) -
        (u[1] - o[1]) * (v[0] - o[0]);

    const d1 = cross(a, b, p);
    const d2 = cross(a, b, q);
    const d3_ = cross(p, q, a);
    const d4 = cross(p, q, b);

    return d1 * d2 < 0 && d3_ * d4 < 0;
}


// Is the quadrilateral inside the polygon? Corners inside and no
// polygon edge crossing a side (corners alone are enough only
// for a convex polygon).
function quadInsidePolygon(quad, polygon) {

    if (!quad.every(p => d3.polygonContains(polygon, p))) {
        return false;
    }

    for (let k = 0; k < polygon.length; k++) {

        const a = polygon[k];
        const b = polygon[(k + 1) % polygon.length];

        for (let s = 0; s < 4; s++) {
            if (segmentsCross(quad[s], quad[(s + 1) % 4], a, b)) {
                return false;
            }
        }
    }

    return true;
}


// `anyShape`: try every edge direction of the plot's convex hull
// and a few box proportions (BUILDING_ASPECTS, besides the plot's
// own), and keep the largest box. For combined plots, whose
// longest edge often runs across their long axis and whose
// outline is pinched where the plots meet.
const BUILDING_ASPECTS = [1, 1.5, 2, 2.5];

function buildingForBlock(polygon, anyShape = false) {

    const [cx, cy] = d3.polygonCentroid(polygon);

    if (!Number.isFinite(cx) || !Number.isFinite(cy) || !isLand(cx, cy)) {
        return null;
    }

    // 1. Orientation: the longest edge, or every hull edge.
    const ring = anyShape ? d3.polygonHull(polygon) || polygon : polygon;

    let longest = -1;
    const angles = [];

    for (let k = 0; k < ring.length; k++) {

        const a = ring[k];
        const b = ring[(k + 1) % ring.length];

        const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
        const angle = Math.atan2(b[1] - a[1], b[0] - a[0]);

        if (anyShape) {
            angles.push(angle);
        } else if (len > longest) {
            longest = len;
            angles[0] = angle;
        }
    }

    // 2. For one orientation (and box proportion, width / height;
    //    default the plot's own in that frame): the largest box
    //    inside the plot.
    const fitAt = (angle, aspect) => {

        const cos = Math.cos(angle);
        const sin = Math.sin(angle);

        const local = polygon.map(([x, y]) => [
            (x - cx) * cos + (y - cy) * sin,
            -(x - cx) * sin + (y - cy) * cos
        ]);

        const us = local.map(p => p[0]);
        const vs = local.map(p => p[1]);

        let width = Math.max(...us) - Math.min(...us);
        let height = Math.max(...vs) - Math.min(...vs);

        if (aspect) {
            const side = Math.sqrt(width * height);
            width = side * Math.sqrt(aspect);
            height = side / Math.sqrt(aspect);
        }

        const fits = s => {

            const hw = s * width / 2;
            const hh = s * height / 2;

            return quadInsidePolygon(
                [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]],
                local
            );
        };

        let lo = 0;
        let hi = 1;

        for (let i = 0; i < 18; i++) {

            const mid = (lo + hi) / 2;

            if (fits(mid)) {
                lo = mid;
            } else {
                hi = mid;
            }
        }

        return { cos, sin, width, height, scale: lo, area: lo * lo * width * height };
    };

    let fit = null;

    for (const angle of angles) {
        for (const aspect of anyShape ? [0, ...BUILDING_ASPECTS] : [0]) {
            const f = fitAt(angle, aspect);
            if (!fit || f.area > fit.area) {
                fit = f;
            }
        }
    }

    const { cos, sin, width, height } = fit;

    const toWorld = ([u, v]) => [
        cx + u * cos - v * sin,
        cy + u * sin + v * cos
    ];

    const fullScale = fit.scale * BUILDING_FILL;

    // 3. Per-plot variety: narrow one side into a trapezoid.
    const h = Math.sin(cx * 12.9898 + cy * 78.233) * 43758.5453;
    const r = h - Math.floor(h);

    const taper = r < 0.4 ? 0 : (r - 0.4) / 0.6 * BUILDING_TAPER;
    const narrowTop = r * 1000 % 2 < 1;

    // The footprint at `f` times the full size, or null when it
    // is too small (4.) or a corner is on unbuildable ground.
    const at = f => {

        const hw = f * fullScale * width / 2;
        const hh = f * fullScale * height / 2;

        if (2 * Math.min(hw, hh) < BUILDING_MIN_SIDE * R) {
            return null;
        }

        const top = narrowTop ? hw * (1 - taper) : hw;
        const bottom = narrowTop ? hw : hw * (1 - taper);

        const corners = [
            [-top, -hh], [top, -hh], [bottom, hh], [-bottom, hh]
        ].map(toWorld);

        return corners.some(([x, y]) => !isLand(x, y))
            ? null
            : corners;
    };

    // Smallest step that is valid at all; none -> no building.
    if (!BUILDING_SHRINK_STEPS.some(f => at(f))) {
        return null;
    }

    return { at };
}


// Does segment p-q touch the quadrilateral? Either crosses one of
// its edges or lies inside it.
function segmentHitsQuad(p, q, quad) {

    if (
        d3.polygonContains(quad, p) ||
        d3.polygonContains(quad, q)
    ) {
        return true;
    }

    for (let k = 0; k < 4; k++) {
        if (segmentsCross(p, q, quad[k], quad[(k + 1) % 4])) {
            return true;
        }
    }

    return false;
}


// The roads (and facility spurs) of the current network, bucketed
// on a grid for the two questions buildings ask:
//   clear(quad, ignore)    no road runs through the footprint
//   crosses(p, q, ignore)  a road crosses segment p-q
// Roads ending at node `ignore` (a facility's own spurs) do not
// count.
// With no network every footprint is clear.
function roadSegmentIndex() {

    const net =
        urquhartToggle.checked && roadNetwork && !roadNetworkDirty
            ? roadNetwork
            : null;

    if (!net) {
        return { net: null, clear: () => true, crosses: () => false };
    }

    const size = Math.max(4, R * 2);
    const buckets = new Map();
    const bucketKey = (bx, by) => by * 65536 + bx;

    const visit = (xs, ys, fn) => {

        const bx0 = Math.floor(Math.min(...xs) / size);
        const bx1 = Math.floor(Math.max(...xs) / size);
        const by0 = Math.floor(Math.min(...ys) / size);
        const by1 = Math.floor(Math.max(...ys) / size);

        for (let by = by0; by <= by1; by++) {
            for (let bx = bx0; bx <= bx1; bx++) {
                if (fn(bucketKey(bx, by)) === false) {
                    return false;
                }
            }
        }

        return true;
    };

    for (const [a, b] of net.edges.concat(net.facilityEdges)) {

        const p = [net.nodes[a].x, net.nodes[a].y];
        const q = [net.nodes[b].x, net.nodes[b].y];
        const segment = { a, b, p, q };

        visit([p[0], q[0]], [p[1], q[1]], key => {
            if (!buckets.has(key)) {
                buckets.set(key, []);
            }
            buckets.get(key).push(segment);
        });
    }

    return {

        net,

        clear(quad, ignore = -1) {
            return visit(quad.map(c => c[0]), quad.map(c => c[1]), key => {
                for (const s of buckets.get(key) || []) {
                    if (s.a !== ignore && s.b !== ignore && segmentHitsQuad(s.p, s.q, quad)) {
                        return false;
                    }
                }
            });
        },

        crosses(p, q, ignore = -1) {
            return !visit([p[0], q[0]], [p[1], q[1]], key => {
                for (const s of buckets.get(key) || []) {
                    if (s.a !== ignore && s.b !== ignore && segmentsCross(p, q, s.p, s.q)) {
                        return false;
                    }
                }
            });
        }
    };
}


// ============================================================
// COMBINED PLOTS AND FACILITY BUILDINGS
// ============================================================
//
// planBuildings() decides, on the final roads, which blocks are
// built on together and which buildings belong to a facility:
//
//   1. Facility buildings. Each facility (of the visible layers)
//      sits in a buildable block; that block's building takes
//      the facility's colour. Its own spurs (the access road
//      from the facility to the street) do not count as roads
//      running through it.
//   2. Amenities are always bigger: their block is combined
//      with one neighbour into a 2-plot building (yellow). When
//      every neighbour is across a road, the amenity keeps its
//      one block but builds on all of it (no setback).
//   3. Some other blocks combine too: a block starts a group
//      with chance MERGE_START_CHANCE (stable per block) and
//      takes in neighbours, longest shared edge first, up to
//      2-4 plots in all.
//
// Two blocks can only combine when they share an edge of at
// least MERGE_MIN_EDGE_R * R, no road (or spur) runs between
// them - no road crosses the line between the two block points,
// which is exactly where the road on their shared edge would be
// - neither is a facility's block (except the amenity's own
// pair), and the combined plot is compact (area / convex hull
// area >= MERGE_MIN_COMPACTNESS). The combined plot's building
// (oriented along whichever edge gives the biggest one) must
// clear every road, shrinking by BUILDING_SHRINK_STEPS if needed,
// and still be at least MERGE_MIN_GAIN times the biggest building
// its plots would get alone; otherwise the group is tried one
// plot smaller, down to single blocks.
//
// A facility whose block ends up with no building (too small,
// or a road through it) colours the nearest single-plot building
// within FACILITY_BUILDING_REACH_R * R instead.
// ============================================================

const MERGE_START_CHANCE = 0.12;
const MERGE_MIN_EDGE_R = 0.25;
const MERGE_MIN_COMPACTNESS = 0.75;
const MERGE_MIN_GAIN = 1.3;
const FACILITY_BUILDING_REACH_R = 1.5;


// Stable pseudo-random 0..1 from a position and a salt.
function hash01(x, y, salt) {
    const h = Math.sin(x * 12.9898 + y * 78.233 + salt * 37.719) * 43758.5453;
    return h - Math.floor(h);
}


// Outline of polygons that tile a region without gaps (blocks
// sharing whole edges): every edge used by two of them in
// opposite directions is inside and dropped, the rest is chained
// into the outline. Null when that is not one simple loop (a
// hole, or two polygons touching only at a corner).
function mergePolygons(polygons) {

    const key = p => `${Math.round(p[0] * 100)},${Math.round(p[1] * 100)}`;

    const edges = new Map();

    for (const polygon of polygons) {

        const ring =
            d3.polygonArea(polygon) < 0 ? polygon.slice().reverse() : polygon;

        for (let k = 0; k < ring.length; k++) {

            const a = ring[k];
            const b = ring[(k + 1) % ring.length];
            const ka = key(a);
            const kb = key(b);

            if (ka === kb) {
                continue;
            }

            if (edges.has(`${kb}>${ka}`)) {
                edges.delete(`${kb}>${ka}`);
            } else {
                edges.set(`${ka}>${kb}`, { a, ka, kb });
            }
        }
    }

    const next = new Map();

    for (const e of edges.values()) {

        if (next.has(e.ka)) {
            return null;
        }

        next.set(e.ka, e);
    }

    const first = edges.values().next().value;

    if (!first) {
        return null;
    }

    const outline = [];
    let e = first;

    do {
        outline.push(e.a);
        e = next.get(e.kb);
    } while (e && e !== first && outline.length <= edges.size);

    return e === first && outline.length === edges.size ? outline : null;
}


function planBuildings(blocks) {

    const roads = roadSegmentIndex();

    // Facilities of the visible layers, and their network nodes
    // (for their own spurs).
    const facilityKey = [];
    const facilities = [];

    for (const layer of FACILITY_LAYERS) {

        if (!layer.visible) {
            continue;
        }

        for (const p of layer.points) {
            facilities.push({ layer, x: p.x, y: p.y });
            facilityKey.push(`${layer.key}:${p.x},${p.y}`);
        }
    }

    const key = facilityKey.join("|");

    if (blocks.plan && blocks.plan.net === roads.net && blocks.plan.key === key) {
        return blocks.plan;
    }

    const cells = blocks.cells;
    const n = cells.length;

    // Which network node each facility is.
    if (roads.net) {

        const nodeAt = new Map();

        roads.net.nodes.forEach((p, i) => {
            if (p.kind === "facility") {
                nodeAt.set(`${p.x},${p.y}`, i);
            }
        });

        for (const f of facilities) {
            f.node = nodeAt.get(`${f.x},${f.y}`) ?? -1;
        }
    }

    // Facility blocks (first facility wins a shared block).
    const facilityOf = new Array(n).fill(null);

    for (const f of facilities) {

        const b = blocks.delaunay.find(f.x, f.y);

        if (cells[b] && cells[b].buildable && !facilityOf[b]) {
            facilityOf[b] = f;
        }
    }

    // Shared edge length of two neighbouring cells (0 if none).
    const vkey = p => `${Math.round(p[0] * 100)},${Math.round(p[1] * 100)}`;

    const sharedEdge = (i, j) => {

        const mine = new Map(cells[i].polygon.map(p => [vkey(p), p]));
        const common = cells[j].polygon.filter(p => mine.has(vkey(p)));

        return common.length === 2
            ? Math.hypot(common[0][0] - common[1][0], common[0][1] - common[1][1])
            : 0;
    };

    const site = i => [cells[i].site.x, cells[i].site.y];

    // Neighbours i may combine with, longest shared edge first.
    const partners = (i, ignore = -1) => {

        const out = [];

        for (const j of blocks.delaunay.neighbors(i)) {

            if (!cells[j] || !cells[j].buildable) {
                continue;
            }

            const edge = sharedEdge(i, j);

            if (edge < MERGE_MIN_EDGE_R * R || roads.crosses(site(i), site(j), ignore)) {
                continue;
            }

            out.push([edge, j]);
        }

        return out.sort((a, b) => b[0] - a[0]).map(e => e[1]);
    };

    const singles = computeBuildings(blocks);

    const used = new Uint8Array(n);
    const items = [];

    const stats = {
        combined: 0,
        combinedPlots: 0,
        amenityPairs: 0,
        amenities: 0,
        coloured: { emergency: 0, amenity: 0, shop: 0 }
    };

    // A combined plot's building, clear of roads at full size,
    // or null.
    const combinedBuilding = (group, ignore) => {

        const outline = mergePolygons(group.map(i => cells[i].polygon));

        if (!outline) {
            return null;
        }

        const hull = d3.polygonHull(outline);

        if (
            !hull ||
            Math.abs(d3.polygonArea(outline)) <
                MERGE_MIN_COMPACTNESS * Math.abs(d3.polygonArea(hull))
        ) {
            return null;
        }

        const building = buildingForBlock(outline, true);

        if (!building) {
            return null;
        }

        // Worth it only when clearly bigger than the biggest
        // building its plots would have had on their own.
        const alone = Math.max(0, ...group.map(i => {
            const single = singles[i] && singles[i].at(1);
            return single ? Math.abs(d3.polygonArea(single)) : 0;
        }));

        for (const f of BUILDING_SHRINK_STEPS) {

            const quad = building.at(f);

            if (
                quad &&
                Math.abs(d3.polygonArea(quad)) >= MERGE_MIN_GAIN * alone &&
                roads.clear(quad, ignore)
            ) {
                return quad;
            }
        }

        return null;
    };

    // 2. Amenities: their block plus one neighbour.
    for (let i = 0; i < n; i++) {

        const f = facilityOf[i];

        if (!f || f.layer.key !== "amenity") {
            continue;
        }

        stats.amenities++;

        for (const j of partners(i, f.node)) {

            if (used[j] || facilityOf[j]) {
                continue;
            }

            const quad = combinedBuilding([i, j], f.node);

            if (quad) {
                used[i] = used[j] = 1;
                items.push({ quad, layer: f.layer, facility: f, plots: 2 });
                stats.amenityPairs++;
                break;
            }
        }
    }

    // 3. Other combined plots, in a stable shuffled order.
    const order =
        [...Array(n).keys()]
            .filter(i => cells[i] && cells[i].buildable)
            .sort((a, b) =>
                hash01(cells[a].site.x, cells[a].site.y, 1) -
                hash01(cells[b].site.x, cells[b].site.y, 1));

    for (const i of order) {

        const { x, y } = cells[i].site;

        if (used[i] || facilityOf[i] || hash01(x, y, 2) >= MERGE_START_CHANCE) {
            continue;
        }

        const size = 2 + Math.floor(hash01(x, y, 3) * 3);
        const group = [i];

        while (group.length < size) {

            let added = false;

            for (const g of group) {

                const j =
                    partners(g).find(k => !used[k] && !facilityOf[k] && !group.includes(k));

                if (j !== undefined) {
                    group.push(j);
                    added = true;
                    break;
                }
            }

            if (!added) {
                break;
            }
        }

        while (group.length >= 2) {

            const quad = combinedBuilding(group, -1);

            if (quad) {
                for (const g of group) {
                    used[g] = 1;
                }
                items.push({ quad, layer: null, plots: group.length });
                stats.combined++;
                stats.combinedPlots += group.length;
                break;
            }

            group.pop();
        }
    }

    // 4. Single plots (including the other facility blocks), at
    //    the largest shrink step clear of roads. An amenity that
    //    found no partner (every neighbour across a road) still
    //    gets a bigger building: the whole box, no setback.

    for (let i = 0; i < n; i++) {

        if (used[i] || !singles[i]) {
            continue;
        }

        const f = facilityOf[i];

        const steps =
            f && f.layer.key === "amenity"
                ? [1 / BUILDING_FILL, ...BUILDING_SHRINK_STEPS]
                : BUILDING_SHRINK_STEPS;

        for (const s of steps) {

            const quad = singles[i].at(s);

            if (quad && roads.clear(quad, f ? f.node : -1)) {
                items.push({ quad, layer: f ? f.layer : null, facility: f, plots: 1 });
                used[i] = 1;
                break;
            }
        }
    }

    // A facility left without a building of its own colours the
    // nearest plain single-plot building nearby.
    for (const f of facilities) {

        if (items.some(it => it.facility === f)) {
            continue;
        }

        let best = null;
        let bestD = FACILITY_BUILDING_REACH_R * R;

        for (const it of items) {

            if (it.layer || it.plots !== 1) {
                continue;
            }

            const [cx, cy] = d3.polygonCentroid(it.quad);
            const d = Math.hypot(cx - f.x, cy - f.y);

            if (d < bestD) {
                bestD = d;
                best = it;
            }
        }

        if (best) {
            best.layer = f.layer;
            best.facility = f;
        }
    }

    for (const it of items) {
        if (it.layer) {
            stats.coloured[it.layer.key]++;
        }
    }

    blocks.plan = { net: roads.net, key, items, stats };

    return blocks.plan;
}


// An area in px^2 as m^2 when the scale is known.
function areaLabel(px2) {

    return metresPerPixel
        ? `${Math.round(px2 * metresPerPixel * metresPerPixel)} m²`
        : `${Math.round(px2)} px²`;
}


// Single-plot building per block (index = block index; null
// where the block is unbuildable or too small).
function computeBuildings(blocks) {

    if (blocks.buildings) {
        return blocks.buildings;
    }

    blocks.buildings =
        blocks.cells.map(cell =>
            cell && cell.buildable ? buildingForBlock(cell.polygon) : null);

    return blocks.buildings;
}


// ============================================================
// SIZE CAP
// ============================================================
//
// No building may be bigger than "Max building size" times the
// smallest single-plot building. A bigger one is shrunk around
// its own centre to exactly that area; shrinking a footprint
// towards its centre keeps it inside itself, so it stays inside
// its plot and clear of roads. Applied at draw time, so moving
// the slider needs no new plan.
// ============================================================

function capBuildingSizes(items) {

    const ratio = Number(maxBuildingSlider.value);
    const area = q => Math.abs(d3.polygonArea(q));

    const singles =
        items.filter(it => it.plots === 1).map(it => area(it.quad));

    if (!singles.length) {
        return { quads: items.map(it => it.quad), capped: 0, ratio, limit: Infinity };
    }

    const limit = ratio * Math.min(...singles);

    let capped = 0;

    const quads = items.map(it => {

        const a = area(it.quad);

        if (a <= limit) {
            return it.quad;
        }

        capped++;

        const k = Math.sqrt(limit / a);
        const [cx, cy] = d3.polygonCentroid(it.quad);

        return it.quad.map(([x, y]) => [cx + (x - cx) * k, cy + (y - cy) * k]);
    });

    return { quads, capped, ratio, limit };
}


function buildingSummary() {

    const s = shownBuildingStats;

    if (!s) {
        return `${shownBuildingCount} buildings`;
    }

    return (
        `${shownBuildingCount} buildings; ${s.combined} of them ` +
        `on combined plots (${s.combinedPlots} plots, 2-4 each); ` +
        `facility buildings: ${s.coloured.emergency} emergency (red), ` +
        `${s.coloured.amenity} amenity (yellow; ${s.amenityPairs} of ` +
        `${s.amenities} on 2 plots), ${s.coloured.shop} shop (purple); ` +
        `size cap ${s.cap.ratio}x the smallest single building ` +
        `(${areaLabel(s.cap.limit)}): ${s.cap.capped} shrunk`
    );
}


function drawBuildings() {

    buildingLayer.selectAll("*").remove();

    shownBuildingCount = 0;
    shownBuildingStats = null;

    if (!buildingsToggle.checked || !cityClosed || !buildingsReady) {
        return;
    }

    const blocks = getBlockCells();

    if (!blocks) {
        return;
    }

    const plan = planBuildings(blocks);

    const cap = capBuildingSizes(plan.items);

    shownBuildingCount = plan.items.length;
    shownBuildingStats = { ...plan.stats, cap };

    // One path per colour - thousands of <path> elements would
    // slow every redraw.
    const paths = new Map();

    plan.items.forEach((item, i) => {

        const k = item.layer ? item.layer.key : "";

        paths.set(
            k,
            (paths.get(k) || "") +
            "M" + cap.quads[i].map(c => `${c[0]},${c[1]}`).join("L") + "Z"
        );
    });

    for (const [k, d] of paths) {

        const layer = FACILITY_LAYERS.find(l => l.key === k);

        const path =
            buildingLayer
                .append("path")
                .attr("class", layer ? "building facility-building" : "building")
                .attr("d", d);

        if (layer) {
            path.attr("data-layer", k).style("fill", layer.color);
        }
    }
}
