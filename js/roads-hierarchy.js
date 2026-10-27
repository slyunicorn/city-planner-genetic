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
//      deflection is <= the limit. Any other road at that node
//      ends there. With per-road weights (traffic, for main-road
//      corridors) the pair with the larger smaller weight goes
//      first, so a chain follows the busiest way through.
//   2. Follow the pairings from road to road. Each road lands in
//      exactly one chain; a chain is a path (or a loop).
//
// Facility spurs are not part of any chain.
// ============================================================

const CHAIN_MAX_DEFLECTION = 50 * Math.PI / 180;

// Automatic main roads (see MAIN ROADS below).
const MAIN_MAX_DEFLECTION = 60 * Math.PI / 180;
const MAIN_MIN_LENGTH_R = 5;
const MAIN_ROAD_SPEED_RATIO = 2;
const MAIN_SELECT_MAX_ROUNDS = 8;

// Turn-aware main-road straightening.
const MAIN_STRAIGHTEN_ITERATIONS = 30;
const MAIN_STRAIGHTEN_STRENGTH = 0.3;


function buildRoadChains(net, options) {

    const opts = options || {};

    const maxDeflection = opts.maxDeflection ?? CHAIN_MAX_DEFLECTION;
    const weight = opts.weight || null;

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

                if (deflection <= maxDeflection) {
                    pairs.push([
                        deflection,
                        list[i],
                        list[j],
                        weight ? Math.min(weight[list[i]], weight[list[j]]) : 0
                    ]);
                }
            }
        }

        pairs.sort((p, q) => (q[3] - p[3]) || (p[0] - q[0]));

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

        chains.push(roadChain(nodes, chainNodes, chainEdges));
    }

    return chains;
}


function roadChain(nodes, chainNodes, chainEdges) {

    let length = 0;

    for (let k = 1; k < chainNodes.length; k++) {
        length += Math.hypot(
            nodes[chainNodes[k]].x - nodes[chainNodes[k - 1]].x,
            nodes[chainNodes[k]].y - nodes[chainNodes[k - 1]].y
        );
    }

    return {
        nodes: chainNodes,
        edges: chainEdges,
        length,
        loop: chainNodes[0] === chainNodes[chainNodes.length - 1]
    };
}


// ============================================================
// MAIN ROADS, CHOSEN AUTOMATICALLY
// ============================================================
//
// A main road is a long, continuous route that carries much of
// the city's travel. How much of the network that should be
// depends on the city, so no share is set by hand:
//
//   1. Traffic. One trip between every pair of buildings (one
//      per buildable block), each along its quickest route. A
//      block's trips start at its corners that still have a road.
//      A road's traffic is the share of all trips that use it, so
//      roads with many buildings connected - along them, or
//      through them to the rest of the city - get more.
//   2. Corridors. Roads are traced into chains as above, but up
//      to MAIN_MAX_DEFLECTION (60 deg: a Voronoi Y-junction turns
//      by about that much) and busiest pair first, so a corridor
//      follows the traffic through junctions.
//   3. A corridor's quiet ends are trimmed off: roads with less
//      traffic per metre than the city average. What is left is
//      a main road when it is at least MAIN_MIN_LENGTH_R blocks
//      long and busier than average per metre - its share of the
//      city's travel (trip x distance) is larger than its share
//      of road length. Taking exactly those corridors maximises
//      "travel on main roads minus road length spent on them".
//   4. Main roads are faster (MAIN_ROAD_SPEED_RATIO), so trips
//      move onto them. Traffic is recomputed and corridors
//      chosen again, until the choice stops changing (usually
//      3-7 rounds). The main road share is the outcome.
// ============================================================

// Share of all building-to-building trips that use each road of
// net.edges, with trips taking the cheapest route under `cost`
// (per edge; default = length).
function buildingTripFlows(net, nodeBlocks, cost) {

    const n = net.nodes.length;
    const edges = net.edges;
    const m = edges.length;

    const length = new Float64Array(m);
    const degree = new Int32Array(n);

    edges.forEach(([a, b], i) => {
        length[i] = Math.hypot(
            net.nodes[a].x - net.nodes[b].x,
            net.nodes[a].y - net.nodes[b].y
        );
        degree[a]++;
        degree[b]++;
    });

    const c = cost || length;

    // Compact adjacency.
    const start = new Int32Array(n + 1);

    for (let v = 0; v < n; v++) {
        start[v + 1] = start[v] + degree[v];
    }

    const fill = start.slice(0, n);
    const adjNode = new Int32Array(2 * m);
    const adjEdge = new Int32Array(2 * m);

    edges.forEach(([a, b], i) => {
        adjNode[fill[a]] = b;
        adjEdge[fill[a]++] = i;
        adjNode[fill[b]] = a;
        adjEdge[fill[b]++] = i;
    });

    // Trip ends: each block's weight 1, split over its corners
    // that have a road. No blocks known: every road node is one.
    const corners = new Map();

    for (let v = 0; v < n; v++) {
        if (degree[v]) {
            for (const blk of nodeBlocks[v] || []) {
                corners.set(blk, (corners.get(blk) || 0) + 1);
            }
        }
    }

    const w = new Float64Array(n);

    for (let v = 0; v < n; v++) {
        if (degree[v]) {
            for (const blk of nodeBlocks[v] || []) {
                w[v] += 1 / corners.get(blk);
            }
        }
    }

    let total = corners.size;

    if (!total) {
        for (let v = 0; v < n; v++) {
            if (degree[v]) {
                w[v] = 1;
                total++;
            }
        }
    }

    const flow = new Float64Array(m);

    const dist = new Float64Array(n);
    const viaEdge = new Int32Array(n);
    const viaNode = new Int32Array(n);
    const done = new Uint8Array(n);
    const below = new Float64Array(n);
    const order = new Int32Array(n);

    const heapDist = new Float64Array(2 * m + n + 2);
    const heapNode = new Int32Array(2 * m + n + 2);

    for (let s = 0; s < n; s++) {

        if (!(w[s] > 0)) {
            continue;
        }

        dist.fill(Infinity);
        done.fill(0);

        let size = 0;
        let settled = 0;

        const push = (v, d) => {
            let i = size++;
            while (i > 0) {
                const p = (i - 1) >> 1;
                if (heapDist[p] <= d) {
                    break;
                }
                heapDist[i] = heapDist[p];
                heapNode[i] = heapNode[p];
                i = p;
            }
            heapDist[i] = d;
            heapNode[i] = v;
        };

        const pop = () => {
            const top = heapNode[0];
            const lastDist = heapDist[--size];
            const lastNode = heapNode[size];
            let i = 0;
            for (;;) {
                let k = 2 * i + 1;
                if (k >= size) {
                    break;
                }
                if (k + 1 < size && heapDist[k + 1] < heapDist[k]) {
                    k++;
                }
                if (heapDist[k] >= lastDist) {
                    break;
                }
                heapDist[i] = heapDist[k];
                heapNode[i] = heapNode[k];
                i = k;
            }
            heapDist[i] = lastDist;
            heapNode[i] = lastNode;
            return top;
        };

        dist[s] = 0;
        push(s, 0);

        while (size > 0) {

            const v = pop();

            if (done[v]) {
                continue;
            }

            done[v] = 1;
            order[settled++] = v;

            for (let k = start[v]; k < start[v + 1]; k++) {

                const u = adjNode[k];
                const d = dist[v] + c[adjEdge[k]];

                if (d < dist[u]) {
                    dist[u] = d;
                    viaEdge[u] = adjEdge[k];
                    viaNode[u] = v;
                    push(u, d);
                }
            }
        }

        // Farthest first: the trips from s to everything below a
        // node all run along the road that reached it.
        for (let i = settled - 1; i >= 1; i--) {

            const v = order[i];

            below[v] += w[v];
            flow[viaEdge[v]] += w[s] * below[v];
            below[viaNode[v]] += below[v];
        }

        for (let i = 0; i < settled; i++) {
            below[order[i]] = 0;
        }
    }

    for (let i = 0; i < m; i++) {
        flow[i] /= total * total;
    }

    return { flow, length };
}


// Chooses main roads one round per step(), so the choice can be
// drawn as it settles. apply() writes the current choice to net.
function createMainRoadSelector(net, nodeBlocks) {

    const m = net.edges.length;

    const length = new Float64Array(m);

    net.edges.forEach(([a, b], i) => {
        length[i] = Math.hypot(
            net.nodes[a].x - net.nodes[b].x,
            net.nodes[a].y - net.nodes[b].y
        );
    });

    let main = new Uint8Array(m);
    let round = 0;
    let done = false;
    let settled = false;
    let current = null;

    function selectOnce() {

        const cost = new Float64Array(m);

        for (let i = 0; i < m; i++) {
            cost[i] = main[i] ? length[i] / MAIN_ROAD_SPEED_RATIO : length[i];
        }

        const { flow } = buildingTripFlows(net, nodeBlocks, cost);

        // City-wide traffic per metre.
        let travel = 0;
        let total = 0;

        for (let i = 0; i < m; i++) {
            travel += flow[i] * length[i];
            total += length[i];
        }

        const average = total > 0 ? travel / total : 0;

        const corridors =
            buildRoadChains(net, {
                maxDeflection: MAIN_MAX_DEFLECTION,
                weight: flow
            });

        const next = new Uint8Array(m);
        const pieces = [];

        for (const c of corridors) {

            let i = 0;
            let j = c.edges.length;

            if (!c.loop) {
                while (i < j && flow[c.edges[i]] < average) {
                    i++;
                }
                while (j > i && flow[c.edges[j - 1]] < average) {
                    j--;
                }
            }

            let len = 0;
            let carried = 0;

            for (let k = i; k < j; k++) {
                len += length[c.edges[k]];
                carried += flow[c.edges[k]] * length[c.edges[k]];
            }

            if (len < MAIN_MIN_LENGTH_R * R || carried <= average * len) {
                continue;
            }

            for (let k = i; k < j; k++) {
                next[c.edges[k]] = 1;
            }

            pieces.push(
                i === 0 && j === c.edges.length
                    ? c
                    : roadChain(net.nodes, c.nodes.slice(i, j + 1), c.edges.slice(i, j))
            );
        }

        return { next, pieces, flow, travel, total };
    }

    return {

        get round() {
            return round;
        },

        get done() {
            return done;
        },

        // One round. Returns true while the choice still changes.
        step() {

            if (done) {
                return false;
            }

            current = selectOnce();
            round++;

            let changed = 0;

            for (let i = 0; i < m; i++) {
                if (current.next[i] !== main[i]) {
                    changed++;
                }
            }

            main = current.next;
            settled = changed === 0;
            done = settled || round >= MAIN_SELECT_MAX_ROUNDS;

            return !done;
        },

        // Sets net.chains (main roads first, then the smaller
        // roads as ordinary chains), net.mainRoads and
        // net.mainRoadInfo.
        apply() {

            const mainChains =
                current ? current.pieces.slice() : [];

            mainChains.sort((p, q) => q.length - p.length);

            const rest = [];

            for (let i = 0; i < m; i++) {
                if (!main[i]) {
                    rest.push(i);
                }
            }

            const smaller =
                buildRoadChains({
                    nodes: net.nodes,
                    edges: rest.map(i => net.edges[i])
                }).sort((p, q) => q.length - p.length);

            for (const c of smaller) {
                c.edges = c.edges.map(k => rest[k]);
                c.main = false;
            }

            for (const c of mainChains) {
                c.main = true;
            }

            net.chains = mainChains.concat(smaller);
            net.mainRoads = new Set();

            for (const c of mainChains) {
                for (const i of c.edges) {
                    net.mainRoads.add(edgeKeyOf(...net.edges[i]));
                }
            }

            // Buildings (buildable blocks) with a side on a main road.
            const facing = new Set();
            let mainLength = 0;
            let mainTravel = 0;

            for (let i = 0; i < m; i++) {

                if (!main[i]) {
                    continue;
                }

                mainLength += length[i];
                mainTravel += current.flow[i] * length[i];

                const [a, b] = net.edges[i];
                const atB = new Set(nodeBlocks[b] || []);

                for (const blk of nodeBlocks[a] || []) {
                    if (atB.has(blk)) {
                        facing.add(blk);
                    }
                }
            }

            const blocks = new Set();

            for (const [a, b] of net.edges) {
                for (const blk of nodeBlocks[a] || []) {
                    blocks.add(blk);
                }
                for (const blk of nodeBlocks[b] || []) {
                    blocks.add(blk);
                }
            }

            net.mainRoadInfo = {
                share: current && current.total ? mainLength / current.total : 0,
                travelShare: current && current.travel ? mainTravel / current.travel : 0,
                facing: facing.size,
                blocks: blocks.size,
                rounds: round,
                settled
            };

            return net.chains;
        }
    };
}


// All rounds at once (no animation). Returns net.chains.
function classifyRoads(net, nodeBlocks) {

    const selector = createMainRoadSelector(net, nodeBlocks);

    while (selector.step()) {
        // keep going until the choice settles
    }

    return selector.apply();
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
