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
