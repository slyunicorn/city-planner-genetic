// js/roads-hierarchy.js
// Main / smaller road classification and turn-aware main-road
// straightening. Runs once, on the final simplified network.
// Plain script: shares the global scope with the other js/ files,
// so load order in index.html matters.

// ============================================================
// ROAD CHAINS ("strokes")
// ============================================================
//
// A road you would drive along does not stop at every junction:
// it carries on through the branch that continues most straight.
// So chains are traced like that:
//
//   1. At every node, pair up its roads by how straight the
//      continuation is. The deflection of a pair is the angle
//      you turn by going in along one and out along the other
//      (0 = dead straight). Pairs are taken smallest deflection
//      first, each road used once per node, and only while the
//      deflection is <= CHAIN_MAX_DEFLECTION. Any other road at
//      that node ends there.
//   2. Follow the pairings from road to road. Each road lands in
//      exactly one chain; a chain is a path (or a loop).
//
// Classification: chains are ranked by length, and the longest
// ones are MAIN roads until together they cover the "Main road
// share" of all road length; everything else is a SMALLER road.
// A share, not a fixed length, so it works at any city size.
//
// Facility spurs are not part of any chain.
// ============================================================

const CHAIN_MAX_DEFLECTION = 50 * Math.PI / 180;

// Turn-aware main-road straightening.
const MAIN_STRAIGHTEN_ITERATIONS = 30;
const MAIN_STRAIGHTEN_STRENGTH = 0.3;


function buildRoadChains(net) {

    const nodes = net.nodes;
    const edges = net.edges;

    const incident =
        Array.from({ length: nodes.length }, () => []);

    edges.forEach(([a, b], i) => {
        incident[a].push(i);
        incident[b].push(i);
    });

    const other = (i, v) =>
        edges[i][0] === v ? edges[i][1] : edges[i][0];

    // partner.get(`${v}:${e}`) = the road that continues road e
    // through node v.
    const partner = new Map();

    for (let v = 0; v < nodes.length; v++) {

        const list = incident[v];

        if (list.length < 2) {
            continue;
        }

        const dirs = list.map(i => {

            const w = nodes[other(i, v)];
            const dx = w.x - nodes[v].x;
            const dy = w.y - nodes[v].y;
            const len = Math.hypot(dx, dy) || 1;

            return [dx / len, dy / len];
        });

        const pairs = [];

        for (let i = 0; i < list.length; i++) {
            for (let j = i + 1; j < list.length; j++) {

                // Straight through = the two roads leave v in
                // opposite directions.
                const dot =
                    dirs[i][0] * dirs[j][0] + dirs[i][1] * dirs[j][1];

                const deflection =
                    Math.acos(Math.max(-1, Math.min(1, -dot)));

                if (deflection <= CHAIN_MAX_DEFLECTION) {
                    pairs.push([deflection, list[i], list[j]]);
                }
            }
        }

        pairs.sort((p, q) => p[0] - q[0]);

        const taken = new Set();

        for (const [, ei, ej] of pairs) {

            if (taken.has(ei) || taken.has(ej)) {
                continue;
            }

            taken.add(ei);
            taken.add(ej);

            partner.set(`${v}:${ei}`, ej);
            partner.set(`${v}:${ej}`, ei);
        }
    }

    const used = new Uint8Array(edges.length);
    const chains = [];

    // Walk from node `v` onward, having arrived along road `e`.
    const walk = (v, e) => {

        const path = [];

        for (;;) {

            const next = partner.get(`${v}:${e}`);

            if (next === undefined || used[next]) {
                return path;
            }

            used[next] = 1;

            const w = other(next, v);

            path.push({ edge: next, node: w });

            v = w;
            e = next;
        }
    };

    for (let start = 0; start < edges.length; start++) {

        if (used[start]) {
            continue;
        }

        used[start] = 1;

        const [a, b] = edges[start];

        const forward = walk(b, start);
        const backward = walk(a, start);

        // nodes: backward (reversed) .. a, b .. forward
        const chainNodes =
            backward.map(s => s.node).reverse()
                .concat([a, b])
                .concat(forward.map(s => s.node));

        const chainEdges =
            backward.map(s => s.edge).reverse()
                .concat([start])
                .concat(forward.map(s => s.edge));

        let length = 0;

        for (let k = 1; k < chainNodes.length; k++) {
            length += Math.hypot(
                nodes[chainNodes[k]].x - nodes[chainNodes[k - 1]].x,
                nodes[chainNodes[k]].y - nodes[chainNodes[k - 1]].y
            );
        }

        chains.push({
            nodes: chainNodes,
            edges: chainEdges,
            length,
            loop: chainNodes[0] === chainNodes[chainNodes.length - 1]
        });
    }

    return chains;
}


// Mark the longest chains as main roads until they cover `share`
// (0..1) of the total road length. Sets net.chains and
// net.mainRoads (Set of edgeKeyOf keys).
function classifyRoads(net, share) {

    const chains =
        buildRoadChains(net).sort((p, q) => q.length - p.length);

    const total =
        chains.reduce((sum, c) => sum + c.length, 0);

    let covered = 0;

    for (const chain of chains) {

        chain.main = total > 0 && covered < share * total;

        if (chain.main) {
            covered += chain.length;
        }
    }

    net.chains = chains;
    net.mainRoads = new Set();

    for (const chain of chains) {
        if (chain.main) {
            for (const i of chain.edges) {
                net.mainRoads.add(edgeKeyOf(...net.edges[i]));
            }
        }
    }

    return chains;
}


// ============================================================
// TURN-AWARE MAIN-ROAD STRAIGHTENING
// ============================================================
//
// For each interior point of a main road, the turn is the angle
// between the segment coming in and the segment going out
// (0 = straight on).
//
//   turn <  threshold  -> a wobble: pull the point toward the
//                         midpoint of its two neighbours ON THIS
//                         ROAD, by MAIN_STRAIGHTEN_STRENGTH
//   turn >= threshold  -> a real corner: leave it, move on to
//                         the next point
//
// Repeated for MAIN_STRAIGHTEN_ITERATIONS, Jacobi-style (every
// point reads the same snapshot), so wobbles iron out while the
// corners that give the road its shape stay put.
//
// Unlike the general chain straightening, this does move points
// where smaller roads branch off - that is the whole point, a
// main road should run straight past its side streets. It never
// moves the two ends of a main road, a point where two main roads
// meet, or a point onto unbuildable ground.
// ============================================================

function turnAngle(p, c, n) {

    const ax = c.x - p.x;
    const ay = c.y - p.y;
    const bx = n.x - c.x;
    const by = n.y - c.y;

    const la = Math.hypot(ax, ay);
    const lb = Math.hypot(bx, by);

    if (la < 1e-9 || lb < 1e-9) {
        return 0;
    }

    return Math.acos(
        Math.max(-1, Math.min(1, (ax * bx + ay * by) / (la * lb)))
    );
}


function mainRoadFixedNodes(net) {

    const fixed = new Set();
    const seenOn = new Map();

    net.chains.forEach((chain, ci) => {

        if (!chain.main) {
            return;
        }

        if (!chain.loop) {
            fixed.add(chain.nodes[0]);
            fixed.add(chain.nodes[chain.nodes.length - 1]);
        }

        for (const v of chain.nodes) {

            const prev = seenOn.get(v);

            if (prev !== undefined && prev !== ci) {
                fixed.add(v);
            }

            seenOn.set(v, ci);
        }
    });

    return fixed;
}


// One iteration. Returns { moved, kept } - points pulled
// straighter, and points left alone as real corners.
function straightenMainRoadsStep(net, maxTurn, fixed) {

    const nodes = net.nodes;

    const snapshot =
        nodes.map(p => ({ x: p.x, y: p.y }));

    let moved = 0;
    let kept = 0;

    for (const chain of net.chains) {

        if (!chain.main) {
            continue;
        }

        const path = chain.nodes;

        for (let k = 1; k < path.length - 1; k++) {

            const v = path[k];

            if (fixed.has(v)) {
                continue;
            }

            const p = snapshot[path[k - 1]];
            const c = snapshot[v];
            const n = snapshot[path[k + 1]];

            if (turnAngle(p, c, n) >= maxTurn) {
                kept++;
                continue;
            }

            const nextX =
                c.x + ((p.x + n.x) / 2 - c.x) * MAIN_STRAIGHTEN_STRENGTH;

            const nextY =
                c.y + ((p.y + n.y) / 2 - c.y) * MAIN_STRAIGHTEN_STRENGTH;

            if (!isLand(nextX, nextY)) {
                continue;
            }

            nodes[v].x = nextX;
            nodes[v].y = nextY;

            moved++;
        }
    }

    return { moved, kept };
}


// The main-road points whose turn is under `maxTurn` right now,
// as [previous, point, next] node triples - the turns the
// straightening is meant to iron out.
function gentleMainRoadTurns(net, maxTurn) {

    const sites = [];

    for (const chain of net.chains || []) {

        if (!chain.main) {
            continue;
        }

        for (let k = 1; k < chain.nodes.length - 1; k++) {

            const site = [
                chain.nodes[k - 1], chain.nodes[k], chain.nodes[k + 1]
            ];

            if (turnAngle(...site.map(v => net.nodes[v])) < maxTurn) {
                sites.push(site);
            }
        }
    }

    return sites;
}


// Mean turn (degrees) over the given triples.
function meanTurnDegrees(net, sites) {

    if (!sites.length) {
        return 0;
    }

    let sum = 0;

    for (const site of sites) {
        sum += turnAngle(...site.map(v => net.nodes[v]));
    }

    return (sum / sites.length) * 180 / Math.PI;
}


// Nodes moved, so what each road crosses may have changed: redo
// the bridge / off-land labels on the current geometry.
function reclassifyCrossings(net) {

    net.bridges = new Set();
    net.offLand = new Set();

    for (const [a, b] of net.allEdges) {

        const kind =
            roadCrossingKind(net.nodes[a], net.nodes[b]);

        if (kind === "water") {
            net.bridges.add(edgeKeyOf(a, b));
        } else if (kind === "land") {
            net.offLand.add(edgeKeyOf(a, b));
        }
    }
}
