// js/roads-straighten.js
// Road chain straightening (Laplacian smoothing).
// Plain script: shares the global scope with the other js/ files,
// so load order in index.html matters.

// ============================================================
// ROAD STRAIGHTENING
// ============================================================
//
// A final relaxation over the finished network. Nodes where
// exactly two roads meet are mid-chain: they are not junctions,
// just kinks left over from the Voronoi corners the network was
// built from. Each one is nudged toward the midpoint of its two
// neighbours.
//
// Repeated gently, this makes every chain converge on the
// straight line between the junctions that anchor its ends -
// so the segments along a chain drift toward a shared slope
// instead of zig-zagging. Junctions themselves never move, so
// the network's topology, its degrees and its connectivity are
// all untouched; only the geometry relaxes.
//
// The pull is a fraction per iteration, so the change is
// gradual rather than snapping straight.
// ============================================================

function straightenRoadChains(net, strength, anchors) {

    if (!net || !net.edges.length) {
        return 0;
    }

    const nodes = net.nodes;

    // Adjacency over ROAD edges only. Facility spurs are
    // excluded so a spur doesn't drag a chain sideways.
    const neighbours =
        Array.from({ length: nodes.length }, () => []);

    for (const [a, b] of net.edges) {
        neighbours[a].push(b);
        neighbours[b].push(a);
    }

    const fixed = anchors || new Set();

    let moved = 0;

    // Read from a snapshot so every node in this iteration sees
    // the same geometry - otherwise the sweep order biases which
    // way the chain drifts.
    const snapshot =
        nodes.map(p => ({ x: p.x, y: p.y }));

    for (let i = 0; i < nodes.length; i++) {

        // Only mid-chain nodes. Degree 1 is a dead end, degree
        // 3+ is a real junction: both stay put.
        if (neighbours[i].length !== 2) {
            continue;
        }

        if (fixed.has(i)) {
            continue;
        }

        const a = snapshot[neighbours[i][0]];
        const b = snapshot[neighbours[i][1]];

        const targetX = (a.x + b.x) / 2;
        const targetY = (a.y + b.y) / 2;

        const nextX =
            snapshot[i].x + (targetX - snapshot[i].x) * strength;

        const nextY =
            snapshot[i].y + (targetY - snapshot[i].y) * strength;

        // Roads may not wander into the sea.
        if (!isLand(nextX, nextY)) {
            continue;
        }

        nodes[i].x = nextX;
        nodes[i].y = nextY;

        moved++;
    }

    return moved;
}


// How far a chain still deviates from straight: mean distance
// from each mid-chain node to the line through its neighbours.
// Falls toward zero as the chains align.
function chainDeviation(net) {

    if (!net || !net.edges.length) {
        return 0;
    }

    const nodes = net.nodes;

    const neighbours =
        Array.from({ length: nodes.length }, () => []);

    for (const [a, b] of net.edges) {
        neighbours[a].push(b);
        neighbours[b].push(a);
    }

    let sum = 0;
    let count = 0;

    for (let i = 0; i < nodes.length; i++) {

        if (neighbours[i].length !== 2) {
            continue;
        }

        const p = nodes[i];
        const a = nodes[neighbours[i][0]];
        const b = nodes[neighbours[i][1]];

        sum += Math.hypot(
            p.x - (a.x + b.x) / 2,
            p.y - (a.y + b.y) / 2
        );

        count++;
    }

    return count ? sum / count : 0;
}


// ============================================================
// VALIDATE AFTER STRAIGHTENING
// ============================================================
//
// Each straightening move checks only that the point itself
// lands on buildable land. The ROADS at that point can still end
// up over water or forest, outside the city, or across another
// road. Compared with the positions from before straightening
// (`before`, one {x, y} per node), every road that became invalid
// has its moved ends put back; that is repeated, since putting
// one point back can break a neighbouring road, until nothing new
// is broken. Roads that were already invalid before (kept
// bridges) are not touched.
// ============================================================

function segmentsCross(p, q, r, s) {

    const orient = (a, b, c) =>
        (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);

    const d1 = orient(r, s, p);
    const d2 = orient(r, s, q);
    const d3 = orient(p, q, r);
    const d4 = orient(p, q, s);

    return d1 * d2 < 0 && d3 * d4 < 0;
}


// Pairs of edges (by index) that cross, from a grid of buckets.
function crossingEdgePairs(nodes, edges, cellSize) {

    const grid = new Map();
    const pairs = [];
    const seen = new Set();

    edges.forEach(([a, b], i) => {

        const p = nodes[a];
        const q = nodes[b];

        const x0 = Math.floor(Math.min(p.x, q.x) / cellSize);
        const x1 = Math.floor(Math.max(p.x, q.x) / cellSize);
        const y0 = Math.floor(Math.min(p.y, q.y) / cellSize);
        const y1 = Math.floor(Math.max(p.y, q.y) / cellSize);

        for (let gx = x0; gx <= x1; gx++) {
            for (let gy = y0; gy <= y1; gy++) {

                const key = `${gx},${gy}`;

                if (!grid.has(key)) {
                    grid.set(key, []);
                }

                for (const j of grid.get(key)) {

                    const [c, d] = edges[j];

                    if (a === c || a === d || b === c || b === d) {
                        continue;
                    }

                    const id = j * edges.length + i;

                    if (seen.has(id)) {
                        continue;
                    }

                    seen.add(id);

                    if (segmentsCross(p, q, nodes[c], nodes[d])) {
                        pairs.push([j, i]);
                    }
                }

                grid.get(key).push(i);
            }
        }
    });

    return pairs;
}


function validateStraightenedNetwork(net, before) {

    const nodes = net.nodes;
    const edges = net.allEdges;

    const city =
        cityClosed
            ? getBoundaryPolygonPoints(200).map(q => [q.x, q.y])
            : [];

    const moved = i =>
        nodes[i].x !== before[i].x || nodes[i].y !== before[i].y;

    const leavesCity = (p, q) => roadLeavesCity(p, q, city);

    const reasons = { ground: 0, city: 0, crossing: 0 };

    let restored = 0;

    for (let round = 0; round < 8; round++) {

        const fix = new Set();

        const mark = (...ends) => {
            for (const x of ends) {
                if (moved(x)) {
                    fix.add(x);
                }
            }
        };

        for (const [a, b] of edges) {

            if (!moved(a) && !moved(b)) {
                continue;
            }

            if (
                roadCrossingKind(nodes[a], nodes[b]) &&
                !roadCrossingKind(before[a], before[b])
            ) {
                reasons.ground++;
                mark(a, b);
            } else if (
                leavesCity(nodes[a], nodes[b]) &&
                !leavesCity(before[a], before[b])
            ) {
                reasons.city++;
                mark(a, b);
            }
        }

        for (const [i, j] of crossingEdgePairs(nodes, edges, 4 * R)) {

            const [a, b] = edges[i];
            const [c, d] = edges[j];

            if (!segmentsCross(before[a], before[b], before[c], before[d])) {
                reasons.crossing++;
                mark(a, b, c, d);
            }
        }

        if (!fix.size) {
            break;
        }

        for (const x of fix) {
            nodes[x].x = before[x].x;
            nodes[x].y = before[x].y;
            restored++;
        }
    }

    return { restored, reasons };
}
