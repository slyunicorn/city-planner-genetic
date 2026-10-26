// js/urquhart.js
// Urquhart graph - the building network.
// Plain script: shares the global scope with the other js/ files,
// so load order in index.html matters.

// ============================================================
// URQUHART GRAPH — the building network
// ============================================================
//
// Each base point is a building. The Urquhart graph connects
// them into a street-like network:
//
//   1. Triangulate the buildings (Delaunay).
//   2. From every triangle, delete its LONGEST edge.
//   3. Whatever survives is the network.
//
// An edge shared by two triangles is deleted if it is longest
// in either of them.
//
// Why this graph and not the raw Delaunay: Delaunay connects
// far more pairs than a real street layout does, including
// long thin slivers along the boundary. Urquhart strips those
// while provably keeping the network connected - by the MST
// cycle property the longest edge of a triangle can never be
// in the Euclidean minimum spanning tree, so deleting it never
// disconnects anything. EMST is a subgraph of Urquhart, which
// is a subgraph of Delaunay.
//
// (Urquhart proposed it as a cheap approximation of the
// relative neighbourhood graph. The two are not always equal -
// Toussaint later found counterexamples - but it stays a good
// approximation and is far cheaper to build.)
// ============================================================

function computeUrquhartSplit(pts) {

    if (pts.length < 3) {
        return { kept: [], removed: [] };
    }

    const delaunay =
        d3.Delaunay.from(
            pts,
            d => d.x,
            d => d.y
        );

    const triangles = delaunay.triangles;

    const edgeKey = (a, b) =>
        a < b ? `${a},${b}` : `${b},${a}`;

    const lengthSq = (a, b) => {
        const dx = pts[a].x - pts[b].x;
        const dy = pts[a].y - pts[b].y;
        return dx * dx + dy * dy;
    };

    const allEdges = new Map();
    const dropped = new Set();

    for (
        let t = 0;
        t < triangles.length;
        t += 3
    ) {

        const a = triangles[t];
        const b = triangles[t + 1];
        const c = triangles[t + 2];

        const edges = [
            [a, b],
            [b, c],
            [c, a]
        ];

        let longest = -1;
        let longestIndex = 0;

        for (let i = 0; i < 3; i++) {

            const key =
                edgeKey(edges[i][0], edges[i][1]);

            allEdges.set(key, edges[i]);

            const len =
                lengthSq(edges[i][0], edges[i][1]);

            if (len > longest) {
                longest = len;
                longestIndex = i;
            }
        }

        dropped.add(
            edgeKey(
                edges[longestIndex][0],
                edges[longestIndex][1]
            )
        );
    }

    const kept = [];
    const removed = [];

    for (const [key, edge] of allEdges) {

        if (dropped.has(key)) {
            removed.push(edge);
        } else {
            kept.push(edge);
        }
    }

    return { kept, removed };
}


// Convenience wrapper: just the surviving edges.
function computeUrquhartEdges(pts) {
    return computeUrquhartSplit(pts).kept;
}


// ------------------------------------------------------------
// Collect the polygon vertices
// ------------------------------------------------------------
//
// The buildings are the CORNERS of the base Voronoi cells, not
// the generator points. Every corner is a circumcentre where
// three cells meet, so adjacent cells report the same corner
// and the raw sweep contains each one roughly three times -
// hence the dedupe.
//
// cellPolygon() returns a closed ring with the first point
// repeated at the end, so the last entry is skipped.
// ------------------------------------------------------------

// Snap tolerance for treating two corners as the same point.
// Shared circumcentres come back bit-identical, but cells
// clipped against the extent can land a hair apart.
const VERTEX_SNAP = 100;   // 1/100 px

let buildingPoints = [];


// Points where segment p-q crosses the closed polygon (array of
// [x, y]). The endpoints are put in a fixed order first, so the
// edge two neighbouring cells share yields bit-identical points
// from both sides and dedupes cleanly.
function segmentPolygonCrossings(p, q, polygon) {

    const [a, b] =
        p[0] < q[0] || (p[0] === q[0] && p[1] <= q[1])
            ? [p, q]
            : [q, p];

    const minX = a[0];
    const maxX = b[0];
    const minY = Math.min(a[1], b[1]);
    const maxY = Math.max(a[1], b[1]);

    const rx = b[0] - a[0];
    const ry = b[1] - a[1];

    const out = [];

    for (let j = 0; j < polygon.length; j++) {

        const c = polygon[j];
        const d = polygon[(j + 1) % polygon.length];

        if (
            Math.max(c[0], d[0]) < minX ||
            Math.min(c[0], d[0]) > maxX ||
            Math.max(c[1], d[1]) < minY ||
            Math.min(c[1], d[1]) > maxY
        ) {
            continue;
        }

        const sx = d[0] - c[0];
        const sy = d[1] - c[1];

        const den = rx * sy - ry * sx;

        if (Math.abs(den) < 1e-12) {
            continue;
        }

        const t = ((c[0] - a[0]) * sy - (c[1] - a[1]) * sx) / den;
        const u = ((c[0] - a[0]) * ry - (c[1] - a[1]) * rx) / den;

        if (t >= 0 && t <= 1 && u >= 0 && u < 1) {
            out.push([a[0] + rx * t, a[1] + ry * t]);
        }
    }

    return out;
}

function collectPolygonVertices() {

    buildingPoints = [];

    const generators =
        getInsideCityPoints();

    if (generators.length < 3) {
        return buildingPoints;
    }

    const delaunay =
        d3.Delaunay.from(
            generators,
            d => d.x,
            d => d.y
        );

    const voronoi =
        delaunay.voronoi(
            getVoronoiExtent()
        );

    const polygon =
        cityClosed && boundaryPoints.length >= 3
            ? getBoundaryPolygonPoints(200).map(q => [q.x, q.y])
            : [];

    const seen = new Map();

    const addCorner = (x, y) => {

        const key =
            `${Math.round(x * VERTEX_SNAP)},` +
            `${Math.round(y * VERTEX_SNAP)}`;

        if (!seen.has(key)) {
            seen.set(key, { x, y });
        }
    };

    // Where a cell's edges cross the city boundary. Corners
    // outside the city are dropped below, so without these an
    // edge cell would have roads on its inner side only; with
    // them every cell is closed off along the boundary too.
    const boundaryCrossings = [];

    for (
        let i = 0;
        i < generators.length;
        i++
    ) {

        const cell =
            voronoi.cellPolygon(i);

        if (!cell) {
            continue;
        }

        // Skip the repeated closing vertex.
        for (
            let k = 0;
            k < cell.length - 1;
            k++
        ) {

            addCorner(cell[k][0], cell[k][1]);

            if (polygon.length) {
                boundaryCrossings.push(
                    ...segmentPolygonCrossings(
                        cell[k],
                        cell[k + 1],
                        polygon
                    )
                );
            }
        }
    }

    let corners = [...seen.values()];

    // Same city + land rules the generators obey.
    if (polygon.length) {

        corners =
            corners.filter(p =>
                d3.polygonContains(
                    polygon,
                    [p.x, p.y]
                )
            );

        // Added after the containment filter: they sit ON the
        // boundary, where polygonContains is a coin toss.
        const before = seen.size;

        for (const [x, y] of boundaryCrossings) {
            addCorner(x, y);
        }

        corners.push(...[...seen.values()].slice(before));
    }

    buildingPoints =
        corners.filter(p => isLand(p.x, p.y));

    return buildingPoints;
}
