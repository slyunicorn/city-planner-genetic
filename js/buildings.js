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
// One gray quadrilateral per buildable block that has room for
// it:
//
//   1. Orientation: the block's longest edge. That edge is a
//      street frontage, so the building faces the street.
//   2. Size: in that frame, the largest box with the block's own
//      aspect ratio, centred on the block centroid, that still
//      fits inside the block (binary search on its scale), then
//      shrunk to BUILDING_FILL of that so a small setback is left
//      between the building and the surrounding roads.
//   3. Shape: a stable per-block hash narrows one side of the
//      box by up to BUILDING_TAPER, so the footprints are a mix
//      of rectangles and trapezoids rather than identical boxes.
//      Narrowing only ever moves corners inward, so the result
//      still fits.
//   4. Room: blocks whose building would have a side shorter
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

// How many buildings the last drawBuildings() showed.
let shownBuildingCount = 0;


function buildingForBlock(polygon) {

    // 1. Longest edge -> orientation.
    let longest = -1;
    let angle = 0;

    for (let k = 0; k < polygon.length; k++) {

        const a = polygon[k];
        const b = polygon[(k + 1) % polygon.length];

        const len = Math.hypot(b[0] - a[0], b[1] - a[1]);

        if (len > longest) {
            longest = len;
            angle = Math.atan2(b[1] - a[1], b[0] - a[0]);
        }
    }

    const [cx, cy] = d3.polygonCentroid(polygon);

    if (!Number.isFinite(cx) || !Number.isFinite(cy)) {
        return null;
    }

    const cos = Math.cos(angle);
    const sin = Math.sin(angle);

    const toLocal = ([x, y]) => [
        (x - cx) * cos + (y - cy) * sin,
        -(x - cx) * sin + (y - cy) * cos
    ];

    const toWorld = ([u, v]) => [
        cx + u * cos - v * sin,
        cy + u * sin + v * cos
    ];

    const local = polygon.map(toLocal);

    const us = local.map(p => p[0]);
    const vs = local.map(p => p[1]);

    const width = Math.max(...us) - Math.min(...us);
    const height = Math.max(...vs) - Math.min(...vs);

    // 2. Largest scale whose corners and edge midpoints are all
    //    inside the block.
    const fits = s => {

        const hw = s * width / 2;
        const hh = s * height / 2;

        return [
            [-hw, -hh], [0, -hh], [hw, -hh], [hw, 0],
            [hw, hh], [0, hh], [-hw, hh], [-hw, 0]
        ].every(p => d3.polygonContains(local, p));
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

    const fullScale = lo * BUILDING_FILL;

    // 3. Per-block variety: narrow one side into a trapezoid.
    const h = Math.sin(cx * 12.9898 + cy * 78.233) * 43758.5453;
    const r = h - Math.floor(h);

    const taper = r < 0.4 ? 0 : (r - 0.4) / 0.6 * BUILDING_TAPER;
    const narrowTop = r * 1000 % 2 < 1;

    if (!isLand(cx, cy)) {
        return null;
    }

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


function computeBuildings(blocks) {

    if (blocks.buildings) {
        return blocks.buildings;
    }

    blocks.buildings = [];

    for (const cell of blocks.cells) {

        if (!cell || !cell.buildable) {
            continue;
        }

        const building = buildingForBlock(cell.polygon);

        if (building) {
            blocks.buildings.push(building);
        }
    }

    return blocks.buildings;
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

    const cross = (o, a, b) =>
        (a[0] - o[0]) * (b[1] - o[1]) -
        (a[1] - o[1]) * (b[0] - o[0]);

    for (let k = 0; k < 4; k++) {

        const a = quad[k];
        const b = quad[(k + 1) % 4];

        const d1 = cross(a, b, p);
        const d2 = cross(a, b, q);
        const d3_ = cross(p, q, a);
        const d4 = cross(p, q, b);

        if (d1 * d2 < 0 && d3_ * d4 < 0) {
            return true;
        }
    }

    return false;
}


// Footprints to draw: each building at the largest of its
// BUILDING_SHRINK_STEPS that no road of the current network runs
// through. Buildings with no such step are left out.
function buildingsClearOfRoads(buildings) {

    const largest = b => {
        for (const f of BUILDING_SHRINK_STEPS) {
            const quad = b.at(f);
            if (quad) {
                return quad;
            }
        }
        return null;
    };

    if (
        !urquhartToggle.checked ||
        !roadNetwork ||
        roadNetworkDirty
    ) {
        return buildings.map(largest).filter(Boolean);
    }

    const net = roadNetwork;
    const size = Math.max(4, R * 2);

    const buckets = new Map();

    const bucketKey = (bx, by) => by * 65536 + bx;

    for (const [a, b] of net.edges.concat(net.facilityEdges)) {

        const p = net.nodes[a];
        const q = net.nodes[b];

        const bx0 = Math.floor(Math.min(p.x, q.x) / size);
        const bx1 = Math.floor(Math.max(p.x, q.x) / size);
        const by0 = Math.floor(Math.min(p.y, q.y) / size);
        const by1 = Math.floor(Math.max(p.y, q.y) / size);

        for (let by = by0; by <= by1; by++) {
            for (let bx = bx0; bx <= bx1; bx++) {

                const key = bucketKey(bx, by);

                if (!buckets.has(key)) {
                    buckets.set(key, []);
                }

                buckets.get(key).push([[p.x, p.y], [q.x, q.y]]);
            }
        }
    }

    const clear = quad => {

        const xs = quad.map(c => c[0]);
        const ys = quad.map(c => c[1]);

        const bx0 = Math.floor(Math.min(...xs) / size);
        const bx1 = Math.floor(Math.max(...xs) / size);
        const by0 = Math.floor(Math.min(...ys) / size);
        const by1 = Math.floor(Math.max(...ys) / size);

        for (let by = by0; by <= by1; by++) {
            for (let bx = bx0; bx <= bx1; bx++) {

                for (const [p, q] of buckets.get(bucketKey(bx, by)) || []) {
                    if (segmentHitsQuad(p, q, quad)) {
                        return false;
                    }
                }
            }
        }

        return true;
    };

    const out = [];

    for (const b of buildings) {
        for (const f of BUILDING_SHRINK_STEPS) {

            const quad = b.at(f);

            if (quad && clear(quad)) {
                out.push(quad);
                break;
            }
        }
    }

    return out;
}


function drawBuildings() {

    buildingLayer.selectAll("*").remove();

    shownBuildingCount = 0;

    if (!buildingsToggle.checked || !cityClosed || !buildingsReady) {
        return;
    }

    const blocks = getBlockCells();

    if (!blocks) {
        return;
    }

    const shown =
        buildingsClearOfRoads(computeBuildings(blocks));

    shownBuildingCount = shown.length;

    if (!shown.length) {
        return;
    }

    // One path for every building - thousands of <path> elements
    // would slow every redraw.
    let d = "";

    for (const quad of shown) {
        d +=
            "M" +
            quad.map(c => `${c[0]},${c[1]}`).join("L") +
            "Z";
    }

    buildingLayer
        .append("path")
        .attr("class", "building")
        .attr("d", d);
}

