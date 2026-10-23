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

    const seen = new Map();

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

            const x = cell[k][0];
            const y = cell[k][1];

            const key =
                `${Math.round(x * VERTEX_SNAP)},` +
                `${Math.round(y * VERTEX_SNAP)}`;

            if (!seen.has(key)) {
                seen.set(key, { x, y });
            }
        }
    }

    let corners = [...seen.values()];

    // Same city + land rules the generators obey.
    if (cityClosed && boundaryPoints.length >= 3) {

        const polygon =
            getBoundaryPolygonPoints(200)
                .map(q => [q.x, q.y]);

        if (polygon.length) {

            corners =
                corners.filter(p =>
                    d3.polygonContains(
                        polygon,
                        [p.x, p.y]
                    )
                );
        }
    }

    buildingPoints =
        corners.filter(p => isLand(p.x, p.y));

    return buildingPoints;
}
