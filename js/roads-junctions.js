// js/roads-junctions.js
// Junction selection for road pruning.
// Plain script: shares the global scope with the other js/ files,
// so load order in index.html matters.

// ============================================================
// ROAD JUNCTIONS
// ============================================================
//
// Not every node of the Urquhart graph should be a junction.
// A junction wants to sit in an OPEN spot that is RINGED by
// dense building clusters - the corner of a plaza, not a point
// buried inside a tight block. So each node is scored on two
// densities:
//
//   ownDensity(i)        nodes within `radius` of i
//   ringDensity(i)       mean ownDensity of i's graph neighbours
//
//   score(i) = ringDensity(i) - ownDensity(i)
//
// High score = neighbours are crowded, i itself is not. That is
// exactly "surrounds the dense points while sitting in a
// sparser area".
//
// Selection is then greedy by score with one hard rule: a
// junction may never be adjacent to another junction. That
// makes the chosen set independent in the graph, so junctions
// are always separated by at least one ordinary node and never
// clump into a chain.
// ============================================================

function computeLocalDensities(graph, radius) {

    const n = graph.nodes.length;
    const density = new Float64Array(n);
    const r2 = radius * radius;

    // Bucket into a grid so this stays linear-ish instead of
    // comparing every node against every other one.
    const cell = radius || 1;
    const buckets = new Map();

    const keyOf = (x, y) =>
        `${Math.floor(x / cell)},${Math.floor(y / cell)}`;

    graph.nodes.forEach((p, i) => {

        const key = keyOf(p.x, p.y);

        if (!buckets.has(key)) {
            buckets.set(key, []);
        }

        buckets.get(key).push(i);
    });

    for (let i = 0; i < n; i++) {

        const p = graph.nodes[i];

        const gx = Math.floor(p.x / cell);
        const gy = Math.floor(p.y / cell);

        let count = 0;

        for (let dx = -1; dx <= 1; dx++) {

            for (let dy = -1; dy <= 1; dy++) {

                const list =
                    buckets.get(`${gx + dx},${gy + dy}`);

                if (!list) {
                    continue;
                }

                for (const j of list) {

                    if (j === i) {
                        continue;
                    }

                    const q = graph.nodes[j];
                    const ddx = q.x - p.x;
                    const ddy = q.y - p.y;

                    if (ddx * ddx + ddy * ddy <= r2) {
                        count++;
                    }
                }
            }
        }

        density[i] = count;
    }

    return density;
}


function graphNeighbours(graph, cell) {

    const out = [];

    for (const ei of graph.adj[cell]) {

        const e = graph.edges[ei];

        if (!e.alive) {
            continue;
        }

        out.push(e.a === cell ? e.b : e.a);
    }

    return out;
}


function selectRoadJunctions(graph, options) {

    const opts = options || {};

    const radius = opts.radius ?? 40;
    const minDegree = opts.minDegree ?? 2;

    const density =
        computeLocalDensities(graph, radius);

    const scored = [];

    for (let i = 0; i < graph.nodes.length; i++) {

        if (graph.degree[i] < minDegree) {
            continue;
        }

        const nbrs = graphNeighbours(graph, i);

        if (!nbrs.length) {
            continue;
        }

        let ring = 0;

        for (const j of nbrs) {
            ring += density[j];
        }

        ring /= nbrs.length;

        scored.push({
            node: i,
            score: ring - density[i],
            own: density[i],
            ring
        });
    }

    scored.sort((a, b) => b.score - a.score);

    const isJunction =
        new Uint8Array(graph.nodes.length);

    const blocked =
        new Uint8Array(graph.nodes.length);

    const chosen = [];

    for (const candidate of scored) {

        // Hard rule: never adjacent to an existing junction.
        if (blocked[candidate.node]) {
            continue;
        }

        isJunction[candidate.node] = 1;
        chosen.push(candidate);

        for (const j of graphNeighbours(graph, candidate.node)) {
            blocked[j] = 1;
        }
    }

    return {
        junctions: chosen.map(c => c.node),
        isJunction,
        detail: chosen,
        density,
        radius
    };
}


function shuffleInPlace(array, random) {

    for (let i = array.length - 1; i > 0; i--) {

        const j = Math.floor(random() * (i + 1));

        const t = array[i];
        array[i] = array[j];
        array[j] = t;
    }

    return array;
}


function selectAndRemoveRoad(graph, cell, k, rng) {

    const random = rng || Math.random;

    if (getCellDegree(graph, cell) <= 1) {
        return -1;
    }

    // Shuffled, not sorted by length: the length preference is
    // already inside Q via the road-length penalty, so sorting
    // here would apply it twice AND make the walk deterministic.
    // Randomising the order is what makes two runs produce
    // genuinely different cities.
    const candidates =
        shuffleInPlace(cellConnections(graph, cell), random);

    for (const candidate of candidates) {

        const p =
            calculateRemovalProbability(
                graph,
                candidate.edge,
                k
            );

        if (p <= 0) {
            continue;
        }

        if (random() < p) {
            removeRoad(graph, candidate.edge);
            return candidate.edge;
        }
    }

    return -1;
}


// ------------------------------------------------------------
// Main loop
// ------------------------------------------------------------
