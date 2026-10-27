// js/roads-quality.js
// Network quality model for road pruning: NC / RS / BB metric
// groups, the hard removal rules, and an incremental ΔQ.
// Plain script: shares the global scope with the other js/ files,
// so load order in index.html matters.

// ============================================================
// NETWORK QUALITY MODEL
// ============================================================
//
// Every raw metric becomes a score in 0..1 (1 = desirable),
// scores are averaged into three groups, and the groups into Q:
//
//   NC  Nodal connections   junction spacing, mean degree,
//                           intersection angles, dead ends,
//                           side diversity
//   RS  Road segments       Shimbel distance, circuity, alpha,
//                           tortuosity
//   BB  Barrier blocks      block area, junctions per block,
//                           block compactness
//
//   structural = wNC*S_NC + wRS*S_RS + wBB*S_BB   (w sum to 1)
//   Q          = structural - lambda * cost
//
// Traffic flow (TF) and directional patterns (D) are not part of
// Q: they need a travel-demand model the app does not have.
//
// Hard rules are NOT part of Q. A road whose removal would cut
// the network in two, isolate a facility or leave a buildable
// block with no road at its edge can never be removed, however
// much Q would gain.
//
// Pruning asks "what would Q be without this road?" thousands of
// times, so a state object keeps running totals and a removal is
// scored by updating only what it touches: its two end nodes,
// the road chains through them, the two blocks on either side,
// and the shortest-path trees that used it.
// ============================================================

// Group weights (the Roads tab sliders override these).
const QUALITY_GROUP_WEIGHTS = { nc: 0.3, rs: 0.4, bb: 0.3 };

// lambda: weight of total road length (0..1 of the original).
const QUALITY_COST_WEIGHT = 1.0;

// Weights inside each group; each set sums to 1.
const NC_WEIGHTS = { spacing: 0.25, degree: 0.25, angle: 0.2, deadEnds: 0.2, sides: 0.1 };
const RS_WEIGHTS = { shimbel: 0.15, circuity: 0.3, alpha: 0.3, tortuosity: 0.25 };
const BB_WEIGHTS = { area: 0.5, nodesPerBlock: 0.2, compactness: 0.3 };

// NC1: target road length per intersection, in Poisson radii R,
// and how fast the score falls off (relative error).
const NC_JUNCTION_SPACING_R = 1.5;
const NC_SPACING_SIGMA = 0.5;

// NC2: target mean degree of intersections and dead ends.
const NC_TARGET_DEGREE = 3.0;
const NC_DEGREE_SIGMA = 0.5;

// NC4: dead-end share at which the score reaches 0.
const NC_DEAD_END_LIMIT = 0.15;

// RS1: Shimbel distance, relative to the starting network, at
// which the score reaches 0 (1.5 = paths 50% longer).
const RS_SHIMBEL_SPAN = 0.5;

// RS2: circuity at which the score reaches 0.
const RS_CIRCUITY_LIMIT = 1.8;

// RS4: tortuosity span (1.5 = chains 50% longer than straight).
const RS_TORTUOSITY_SPAN = 0.5;

// BB1: acceptable block area, as a multiple of the starting
// network's median block. BB compactness: 4*pi*A/P^2 below this
// starts to cost. BB2: acceptable intersections per block.
const BB_AREA_RANGE = [0.4, 3.0];
const BB_COMPACTNESS_MIN = 0.45;
const BB_NODES_PER_BLOCK_RANGE = [1.5, 2.5];

// Origin-destination sample for RS1/RS2: spread-out road nodes
// plus facilities. At most 30 in total (one bit each).
const OD_ROAD_SOURCES = 16;
const OD_FACILITY_SOURCES = 8;

// Default removal sharpness: k = sharpness / typical |dQ|.
const DEFAULT_REMOVAL_SHARPNESS = 2.0;


// ------------------------------------------------------------
// Score shapes
// ------------------------------------------------------------

const clip01 = v => Math.max(0, Math.min(1, v));

// Lower is better: 1 at `best`, 0 at best + span.
function scoreLower(x, best, span) {
    return 1 - clip01((x - best) / span);
}

// Best near a target: exp(-|x - target| / sigma).
function scoreTarget(x, target, sigma) {
    return Math.exp(-Math.abs(x - target) / sigma);
}

// Best within [lo, hi]: 1 inside, falling off proportionally.
function scoreRange(x, lo, hi) {

    if (x < lo) {
        return lo > 0 ? clip01(x / lo) : 1;
    }

    if (x > hi) {
        return clip01(hi / x);
    }

    return 1;
}

function weightedScore(weights, scores) {

    let sum = 0;

    for (const key in weights) {
        sum += weights[key] * scores[key];
    }

    return sum;
}


// ------------------------------------------------------------
// Context: everything fixed for one Simplify run
// ------------------------------------------------------------
//
// nodes / edgeList: the starting network (all edges present).
// options: { weights, costWeight, blocks, R, sources }

function createQualityContext(nodes, edgeList, options) {

    const opts = options || {};

    const n = nodes.length;
    const m = edgeList.length;

    const isFacility = new Uint8Array(n);

    nodes.forEach((p, i) => {
        if (p.kind === "facility") {
            isFacility[i] = 1;
        }
    });

    const length = new Float64Array(m);
    const roadEdge = new Uint8Array(m);

    edgeList.forEach(([a, b], i) => {
        length[i] = Math.hypot(
            nodes[a].x - nodes[b].x,
            nodes[a].y - nodes[b].y
        );
        roadEdge[i] = !isFacility[a] && !isFacility[b] ? 1 : 0;
    });

    const ctx = {
        nodes,
        edgeList,
        n,
        m,
        isFacility,
        length,
        roadEdge,
        costWeight: opts.costWeight ?? QUALITY_COST_WEIGHT,
        spacingTarget: NC_JUNCTION_SPACING_R * (opts.R ?? R),
        k: null,
        // Reference values, taken from the first (untouched)
        // state built on this context unless passed in.
        baseShimbel: opts.references ? opts.references.baseShimbel : null,
        blockRequired: null
    };

    buildQualityFaces(ctx);

    if (opts.references) {
        ctx.blockAreaMedian = opts.references.blockAreaMedian;
        ctx.blockAreaTotal = opts.references.blockAreaTotal;
    }

    // Without enclosed blocks the BB group cannot be computed and
    // is left out (its weight goes to the other groups).
    const w = { ...QUALITY_GROUP_WEIGHTS, ...(opts.weights || {}) };

    if (!ctx.blockAreaTotal) {
        w.bb = 0;
    }

    const wSum = w.nc + w.rs + w.bb;

    ctx.weights =
        wSum > 0
            ? { nc: w.nc / wSum, rs: w.rs / wSum, bb: w.bb / wSum }
            : { nc: 1 / 3, rs: 1 / 3, bb: 1 / 3 };

    buildQualityBlocks(ctx, opts.blocks);

    chooseOdSources(ctx, opts.sources);

    // Facilities and OD sources may never be cut off.
    ctx.required = new Uint8Array(n);

    for (let i = 0; i < n; i++) {
        if (isFacility[i]) {
            ctx.required[i] = 1;
        }
    }

    for (const s of ctx.sources) {
        ctx.required[s] = 1;
    }

    return ctx;
}


// Values a later score needs to be comparable with this run.
function qualityReferences(ctx) {

    return {
        baseShimbel: ctx.baseShimbel,
        blockAreaMedian: ctx.blockAreaMedian,
        blockAreaTotal: ctx.blockAreaTotal,
        sources: ctx.sources
    };
}


// ------------------------------------------------------------
// Blocks: which buildable block cells each road node borders
// ------------------------------------------------------------
//
// Road nodes ARE block cell corners (urquhart.js), so a block
// has road access while at least one of its corners still has a
// road. Corners are matched by position (within 0.5 px).

function buildQualityBlocks(ctx, blocks) {

    ctx.nodeBlocks =
        Array.from({ length: ctx.n }, () => []);

    ctx.blockCount = 0;

    if (!blocks || !blocks.cells) {
        return;
    }

    const grid = new Map();
    const keyOf = (gx, gy) => `${gx},${gy}`;

    ctx.nodes.forEach((p, i) => {

        if (ctx.isFacility[i]) {
            return;
        }

        const key = keyOf(Math.floor(p.x), Math.floor(p.y));

        if (!grid.has(key)) {
            grid.set(key, []);
        }

        grid.get(key).push(i);
    });

    let id = 0;

    for (const cell of blocks.cells) {

        if (!cell || !cell.buildable || cell.polygon.length < 3) {
            continue;
        }

        const block = id++;

        for (const [x, y] of cell.polygon) {

            const gx = Math.floor(x);
            const gy = Math.floor(y);

            for (let dx = -1; dx <= 1; dx++) {
                for (let dy = -1; dy <= 1; dy++) {

                    const list = grid.get(keyOf(gx + dx, gy + dy));

                    if (!list) {
                        continue;
                    }

                    for (const i of list) {

                        const p = ctx.nodes[i];
                        const own = ctx.nodeBlocks[i];

                        if (
                            Math.hypot(p.x - x, p.y - y) < 0.5 &&
                            own[own.length - 1] !== block
                        ) {
                            own.push(block);
                        }
                    }
                }
            }
        }
    }

    ctx.blockCount = id;
}


// ------------------------------------------------------------
// Faces: the blocks the ROADS enclose
// ------------------------------------------------------------
//
// The road graph (Urquhart on cell corners, a subgraph of a
// Delaunay triangulation) is planar, so its faces are found with
// the usual half-edge walk: arriving at v along u->v, leave along
// the next road clockwise from v->u. Edge i owns half-edges 2i
// (a->b) and 2i+1 (b->a). Facility spurs are left out: they are
// access links that may cross a road, which would break the walk.
//
// The face with the largest |area| is the outside of the city;
// it and any face wound the same way do not count as blocks.
// Removing a road merges the faces on its two sides (or changes
// nothing when both sides are the same face, i.e. a dead end).

function buildQualityFaces(ctx) {

    const { n, m, nodes, edgeList, roadEdge, length } = ctx;

    const H = 2 * m;

    const origin = h =>
        h & 1 ? edgeList[h >> 1][1] : edgeList[h >> 1][0];

    const out = Array.from({ length: n }, () => []);
    const angle = new Float64Array(H);

    for (let i = 0; i < m; i++) {

        if (!roadEdge[i]) {
            continue;
        }

        out[edgeList[i][0]].push(2 * i);
        out[edgeList[i][1]].push(2 * i + 1);
    }

    const pos = new Int32Array(H);

    for (let v = 0; v < n; v++) {

        for (const h of out[v]) {
            const q = nodes[origin(h ^ 1)];
            angle[h] = Math.atan2(q.y - nodes[v].y, q.x - nodes[v].x);
        }

        out[v].sort((h, g) => angle[h] - angle[g]);
        out[v].forEach((h, k) => { pos[h] = k; });
    }

    const next = new Int32Array(H).fill(-1);

    for (let h = 0; h < H; h++) {

        if (!roadEdge[h >> 1]) {
            continue;
        }

        const t = h ^ 1;
        const list = out[origin(t)];

        next[h] = list[(pos[t] - 1 + list.length) % list.length];
    }

    const faceOf = new Int32Array(H).fill(-1);
    const areas = [];
    const lists = [];

    for (let h = 0; h < H; h++) {

        if (!roadEdge[h >> 1] || faceOf[h] >= 0) {
            continue;
        }

        const f = areas.length;
        const list = [];

        let area = 0;
        let g = h;
        let guard = H + 1;

        do {
            faceOf[g] = f;
            list.push(g);

            const p = nodes[origin(g)];
            const q = nodes[origin(g ^ 1)];

            area += p.x * q.y - q.x * p.y;

            g = next[g];
        } while (g !== h && g >= 0 && --guard > 0);

        areas.push(area / 2);
        lists.push(list);
    }

    const F = areas.length;

    let outerFace = -1;

    for (let f = 0; f < F; f++) {
        if (outerFace < 0 || Math.abs(areas[f]) > Math.abs(areas[outerFace])) {
            outerFace = f;
        }
    }

    const outerSign = outerFace >= 0 ? Math.sign(areas[outerFace]) : 1;

    const faceArea = new Float64Array(F);
    const facePerim = new Float64Array(F);
    const faceOuter = new Uint8Array(F);

    const bounded = [];

    for (let f = 0; f < F; f++) {

        faceOuter[f] =
            Math.sign(areas[f]) === outerSign || areas[f] === 0 ? 1 : 0;

        faceArea[f] = Math.abs(areas[f]);

        let perim = 0;

        for (const h of lists[f]) {
            if (faceOf[h ^ 1] !== f) {
                perim += length[h >> 1];
            }
        }

        facePerim[f] = perim;

        if (!faceOuter[f]) {
            bounded.push(faceArea[f]);
        }
    }

    bounded.sort((a, b) => a - b);

    ctx.faces = { faceOf, faceArea, facePerim, faceOuter, lists };

    ctx.blockAreaMedian =
        bounded.length ? bounded[bounded.length >> 1] : 0;

    ctx.blockAreaTotal =
        bounded.reduce((s, a) => s + a, 0);
}


// One block's share of the BB sums.
function blockContribution(ctx, area, perim) {

    const ratio =
        ctx.blockAreaMedian > 0 ? area / ctx.blockAreaMedian : 1;

    const compact =
        perim > 0 ? (4 * Math.PI * area) / (perim * perim) : 0;

    return {
        area,
        areaScore: area * scoreRange(ratio, BB_AREA_RANGE[0], BB_AREA_RANGE[1]),
        compactScore: area * scoreRange(compact, BB_COMPACTNESS_MIN, 1),
        compactRaw: area * compact
    };
}


// ------------------------------------------------------------
// Origin-destination sources
// ------------------------------------------------------------
//
// Farthest-point sampling over intersections, so the sources
// cover the whole city, plus up to OD_FACILITY_SOURCES
// facilities. Every alive node is a destination.

function chooseOdSources(ctx, given) {

    const { n, nodes, edgeList, isFacility } = ctx;

    let sources;

    if (given) {
        sources = given.slice();
    } else {

        const degree = new Int32Array(n);

        for (const [a, b] of edgeList) {
            degree[a]++;
            degree[b]++;
        }

        const spread = (pool, count) => {

            if (pool.length <= count) {
                return pool.slice();
            }

            let cx = 0;
            let cy = 0;

            for (const i of pool) {
                cx += nodes[i].x;
                cy += nodes[i].y;
            }

            cx /= pool.length;
            cy /= pool.length;

            // Start at the node nearest the centre.
            let best = 0;
            let bestD = Infinity;

            pool.forEach((i, k) => {
                const d = Math.hypot(nodes[i].x - cx, nodes[i].y - cy);
                if (d < bestD) {
                    bestD = d;
                    best = k;
                }
            });

            const nearest = new Float64Array(pool.length).fill(Infinity);
            const picked = [];

            while (picked.length < count) {

                const s = pool[best];
                picked.push(s);

                let far = -1;

                pool.forEach((i, k) => {
                    nearest[k] = Math.min(
                        nearest[k],
                        Math.hypot(nodes[i].x - nodes[s].x, nodes[i].y - nodes[s].y)
                    );
                    if (far < 0 || nearest[k] > nearest[far]) {
                        far = k;
                    }
                });

                best = far;
            }

            return picked;
        };

        const roads = [];
        const facilities = [];

        for (let i = 0; i < n; i++) {
            if (isFacility[i]) {
                if (degree[i] > 0) {
                    facilities.push(i);
                }
            } else if (degree[i] >= 3) {
                roads.push(i);
            }
        }

        sources =
            spread(roads, OD_ROAD_SOURCES)
                .concat(spread(facilities, OD_FACILITY_SOURCES));
    }

    ctx.sources = sources;

    ctx.sourceEuclid = sources.map(s => {

        const d = new Float64Array(n);

        for (let i = 0; i < n; i++) {
            d[i] = Math.hypot(
                nodes[i].x - nodes[s].x,
                nodes[i].y - nodes[s].y
            );
        }

        return d;
    });
}


// Dijkstra from `src` over alive edges. Returns the tree and the
// sums RS1/RS2 need: total network distance, total straight-line
// distance and number of destinations reached.
function qualityShortestPaths(graph, src, euclid) {

    const n = graph.nodes.length;

    const dist = new Float64Array(n).fill(Infinity);
    const parent = new Int32Array(n).fill(-1);
    const done = new Uint8Array(n);

    // Binary heap with lazy deletion.
    const cap = 2 * graph.edges.length + 2;
    const heapNode = new Int32Array(cap);
    const heapDist = new Float64Array(cap);

    let size = 0;

    const push = (v, d) => {
        let i = size++;
        while (i > 0) {
            const p = (i - 1) >> 1;
            if (heapDist[p] <= d) {
                break;
            }
            heapNode[i] = heapNode[p];
            heapDist[i] = heapDist[p];
            i = p;
        }
        heapNode[i] = v;
        heapDist[i] = d;
    };

    const pop = () => {
        const top = heapNode[0];
        const lastNode = heapNode[--size];
        const lastDist = heapDist[size];
        let i = 0;
        while (true) {
            let c = 2 * i + 1;
            if (c >= size) {
                break;
            }
            if (c + 1 < size && heapDist[c + 1] < heapDist[c]) {
                c++;
            }
            if (heapDist[c] >= lastDist) {
                break;
            }
            heapNode[i] = heapNode[c];
            heapDist[i] = heapDist[c];
            i = c;
        }
        heapNode[i] = lastNode;
        heapDist[i] = lastDist;
        return top;
    };

    dist[src] = 0;
    push(src, 0);

    let sumG = 0;
    let sumE = 0;
    let count = 0;

    while (size > 0) {

        const v = pop();

        if (done[v]) {
            continue;
        }

        done[v] = 1;

        if (v !== src) {
            sumG += dist[v];
            sumE += euclid[v];
            count++;
        }

        for (const ei of graph.adj[v]) {

            const e = graph.edges[ei];

            if (!e.alive) {
                continue;
            }

            const w = e.a === v ? e.b : e.a;
            const d = dist[v] + e.length;

            if (d < dist[w]) {
                dist[w] = d;
                parent[w] = ei;
                push(w, d);
            }
        }
    }

    return { dist, parent, sumG, sumE, count };
}


// The same tree after edge `cut` (already dead) is removed.
// Only the subtree that hung below `cut` can change: its nodes
// are reattached through their best neighbour outside the
// subtree, then Dijkstra runs inside it. Much cheaper than a
// fresh tree, since most subtrees are small.
//
// Most calls only score a candidate removal, so by default only
// the sums are returned and nothing the size of the whole graph
// is copied or allocated: the subtree's new distances live in
// shared scratch buffers. `full` (a committed removal) also
// returns the complete dist / parent arrays of the new tree.
let repairScratch = null;

function repairScratchFor(n, m) {

    const cap = n + 2 * m + 2;

    if (!repairScratch || repairScratch.n < n || repairScratch.cap < cap) {
        repairScratch = {
            n,
            cap,
            stamp: 0,
            subMark: new Int32Array(n),
            doneMark: new Int32Array(n),
            sub: new Int32Array(n),
            dist: new Float64Array(n),
            parent: new Int32Array(n),
            heapDist: new Float64Array(cap),
            heapNode: new Int32Array(cap)
        };
    }

    const s = repairScratch;

    // Marks compare against a per-call stamp instead of being
    // cleared; start over before the stamp would overflow.
    if (s.stamp >= 0x7ffffff0) {
        s.stamp = 0;
        s.subMark.fill(0);
        s.doneMark.fill(0);
    }

    s.stamp++;

    return s;
}

function repairShortestPaths(graph, tree, cut, euclid, full) {

    const e = graph.edges[cut];

    const child =
        tree.parent[e.a] === cut ? e.a
            : tree.parent[e.b] === cut ? e.b
                : -1;

    if (child < 0) {
        return tree;
    }

    const s = repairScratchFor(graph.nodes.length, graph.edges.length);
    const stamp = s.stamp;
    const { subMark, doneMark, sub, dist, parent, heapDist, heapNode } = s;

    // The subtree: nodes whose tree path runs through `child`.
    let subLen = 0;

    sub[subLen++] = child;
    subMark[child] = stamp;

    let sumG = tree.sumG;
    let sumE = tree.sumE;
    let count = tree.count;

    for (let i = 0; i < subLen; i++) {

        const x = sub[i];

        sumG -= tree.dist[x];
        sumE -= euclid[x];
        count--;

        for (const ei of graph.adj[x]) {

            const f = graph.edges[ei];
            const w = f.a === x ? f.b : f.a;

            if (subMark[w] !== stamp && tree.parent[w] === ei && f.alive) {
                subMark[w] = stamp;
                sub[subLen++] = w;
            }
        }
    }

    // Reattach from outside (whose distances do not change), then
    // settle inside the subtree. The heap keeps the exact order of
    // operations of the earlier array-of-pairs heap, so the sums
    // add up in the same order and results are bit-identical.
    let size = 0;

    for (let i = 0; i < subLen; i++) {

        const x = sub[i];

        dist[x] = Infinity;
        parent[x] = -1;

        for (const ei of graph.adj[x]) {

            const f = graph.edges[ei];

            if (!f.alive) {
                continue;
            }

            const w = f.a === x ? f.b : f.a;

            if (subMark[w] !== stamp && tree.dist[w] + f.length < dist[x]) {
                dist[x] = tree.dist[w] + f.length;
                parent[x] = ei;
            }
        }

        if (dist[x] < Infinity) {
            heapDist[size] = dist[x];
            heapNode[size] = x;
            size++;
        }
    }

    const swap = (i, j) => {
        const d = heapDist[i];
        const v = heapNode[i];
        heapDist[i] = heapDist[j];
        heapNode[i] = heapNode[j];
        heapDist[j] = d;
        heapNode[j] = v;
    };

    const up = i => {
        while (i > 0) {
            const p = (i - 1) >> 1;
            if (!(heapDist[i] < heapDist[p])) {
                break;
            }
            swap(i, p);
            i = p;
        }
    };

    const down = i => {
        while (true) {
            let c = 2 * i + 1;
            if (c >= size) {
                break;
            }
            if (c + 1 < size && heapDist[c + 1] < heapDist[c]) {
                c++;
            }
            if (!(heapDist[c] < heapDist[i])) {
                break;
            }
            swap(c, i);
            i = c;
        }
    };

    for (let i = (size >> 1) - 1; i >= 0; i--) {
        down(i);
    }

    while (size > 0) {

        const d = heapDist[0];
        const x = heapNode[0];

        size--;

        if (size > 0) {
            heapDist[0] = heapDist[size];
            heapNode[0] = heapNode[size];
            down(0);
        }

        if (doneMark[x] === stamp || d > dist[x]) {
            continue;
        }

        doneMark[x] = stamp;

        sumG += d;
        sumE += euclid[x];
        count++;

        for (const ei of graph.adj[x]) {

            const f = graph.edges[ei];

            if (!f.alive) {
                continue;
            }

            const w = f.a === x ? f.b : f.a;

            if (
                subMark[w] === stamp &&
                doneMark[w] !== stamp &&
                d + f.length < dist[w]
            ) {
                dist[w] = d + f.length;
                parent[w] = ei;
                heapDist[size] = dist[w];
                heapNode[size] = w;
                size++;
                up(size - 1);
            }
        }
    }

    if (!full) {
        return { sumG, sumE, count };
    }

    const fullDist = tree.dist.slice();
    const fullParent = tree.parent.slice();

    for (let i = 0; i < subLen; i++) {
        fullDist[sub[i]] = dist[sub[i]];
        fullParent[sub[i]] = parent[sub[i]];
    }

    return { dist: fullDist, parent: fullParent, sumG, sumE, count };
}


// ------------------------------------------------------------
// Bridges (Tarjan, iterative)
// ------------------------------------------------------------
//
// A bridge is an edge whose removal splits the graph. Recomputed
// after every committed removal, so the "would this disconnect?"
// check is a lookup instead of a graph search per candidate.

function findGraphBridges(graph) {

    const n = graph.nodes.length;

    const disc = new Int32Array(n).fill(-1);
    const low = new Int32Array(n);
    const bridge = new Uint8Array(graph.edges.length);

    const stackV = new Int32Array(n);
    const stackE = new Int32Array(n);
    const stackI = new Int32Array(n);

    let time = 0;

    for (let s = 0; s < n; s++) {

        if (disc[s] >= 0 || graph.degree[s] === 0) {
            continue;
        }

        let top = 0;

        stackV[0] = s;
        stackE[0] = -1;
        stackI[0] = 0;
        disc[s] = low[s] = time++;

        while (top >= 0) {

            const v = stackV[top];
            const adj = graph.adj[v];

            if (stackI[top] < adj.length) {

                const ei = adj[stackI[top]++];
                const e = graph.edges[ei];

                if (!e.alive || ei === stackE[top]) {
                    continue;
                }

                const w = e.a === v ? e.b : e.a;

                if (disc[w] < 0) {
                    disc[w] = low[w] = time++;
                    top++;
                    stackV[top] = w;
                    stackE[top] = ei;
                    stackI[top] = 0;
                } else {
                    low[v] = Math.min(low[v], disc[w]);
                }

            } else {

                top--;

                if (top >= 0) {

                    const p = stackV[top];

                    low[p] = Math.min(low[p], low[v]);

                    if (low[v] > disc[p]) {
                        bridge[stackE[top + 1]] = 1;
                    }
                }
            }
        }
    }

    return bridge;
}


// ------------------------------------------------------------
// Per-node terms
// ------------------------------------------------------------

// NC3 at one intersection: for each road, the angle to its
// nearest neighbouring road, scored 1 at 90 deg and 0 at 0 or
// 180. A T-junction scores 1 (its through-road is one road in
// two halves, each 90 deg from the stem).
function junctionAngleQuality(graph, x) {

    const conns = cellConnections(graph, x);

    if (conns.length < 3) {
        return 0;
    }

    let sum = 0;

    for (let i = 0; i < conns.length; i++) {

        let nearest = Math.PI;

        for (let j = 0; j < conns.length; j++) {

            if (i === j) {
                continue;
            }

            let d = Math.abs(conns[i].angle - conns[j].angle);

            if (d > Math.PI) {
                d = 2 * Math.PI - d;
            }

            nearest = Math.min(nearest, d);
        }

        sum += 1 - Math.min(Math.abs(nearest - Math.PI / 2) / (Math.PI / 2), 1);
    }

    return sum / conns.length;
}


const NODE_FIELDS = ["alive", "inter", "dead", "nc", "degNC", "angle", "side", "sideN"];

// What one node adds to the NC sums. Facility nodes count only
// towards "alive" (graph size); they are destinations, not
// junctions, and their spurs are dead ends on purpose.
function nodeRecord(st, x) {

    const g = st.graph;
    const d = g.degree[x];
    const road = !st.ctx.isFacility[x];

    const nc = road && d >= 1 && d !== 2;

    return {
        alive: d >= 1 ? 1 : 0,
        inter: road && d >= 3 ? 1 : 0,
        dead: road && d === 1 ? 1 : 0,
        nc: nc ? 1 : 0,
        degNC: nc ? d : 0,
        angle: road && d >= 3 ? junctionAngleQuality(g, x) : 0,
        side: road && d >= 2 ? calculateSideDiversity(g, x) : 0,
        sideN: road && d >= 2 ? 1 : 0
    };
}

function addRecord(totals, rec, sign) {
    for (const f of NODE_FIELDS) {
        totals[f] += sign * rec[f];
    }
}


// ------------------------------------------------------------
// Road chains (RS4 tortuosity)
// ------------------------------------------------------------
//
// A chain runs between two nodes whose ROAD degree is not 2
// (facility spurs ignored). Tortuosity = total road length /
// total straight-line length of all chains. Only chains through
// the two ends of a removed road change, so only those are
// re-walked.

function walkChain(st, from, edgeIndex) {

    const g = st.graph;
    const roadDeg = st.roadDeg;
    const roadEdge = st.ctx.roadEdge;

    let prev = from;
    let ei = edgeIndex;
    let length = 0;
    let guard = g.nodes.length + 1;

    while (true) {

        const e = g.edges[ei];

        length += e.length;

        const v = e.a === prev ? e.b : e.a;

        if (roadDeg[v] !== 2 || v === from || --guard <= 0) {
            return { end: v, length, last: ei };
        }

        let nextEdge = -1;

        for (const k of g.adj[v]) {
            if (k !== ei && roadEdge[k] && g.edges[k].alive) {
                nextEdge = k;
                break;
            }
        }

        prev = v;
        ei = nextEdge;
    }
}

// Chains touching node x, added to `out` (key -> straight length).
function chainsTouching(st, x, out) {

    const g = st.graph;
    const nodes = g.nodes;

    const roads = g.adj[x].filter(
        k => st.ctx.roadEdge[k] && g.edges[k].alive
    );

    if (!roads.length) {
        return;
    }

    const span = (p, q) =>
        Math.hypot(nodes[p].x - nodes[q].x, nodes[p].y - nodes[q].y);

    if (roads.length === 2) {

        const w1 = walkChain(st, x, roads[0]);

        if (w1.end === x) {
            // A closed ring of degree-2 nodes.
            out.set(`ring${Math.min(roads[0], w1.last)}`, 0);
            return;
        }

        const w2 = walkChain(st, x, roads[1]);

        out.set(
            `${Math.min(w1.last, w2.last)},${Math.max(w1.last, w2.last)}`,
            span(w1.end, w2.end)
        );

        return;
    }

    for (const k of roads) {

        const w = walkChain(st, x, k);

        out.set(
            `${Math.min(k, w.last)},${Math.max(k, w.last)}`,
            span(x, w.end)
        );
    }
}

function chainSpanAround(st, a, b) {

    const out = new Map();

    chainsTouching(st, a, out);
    chainsTouching(st, b, out);

    let sum = 0;

    for (const v of out.values()) {
        sum += v;
    }

    return sum;
}


// ------------------------------------------------------------
// State: one working graph
// ------------------------------------------------------------
//
// `graph` must be untouched (every edge alive) and built from
// ctx.edgeList with the same indices.

function createQualityState(graph, ctx) {

    const { n, m, roadEdge } = ctx;

    const st = {
        graph,
        ctx,
        roadDeg: new Int32Array(n)
    };

    st.roadLength = 0;

    for (let i = 0; i < m; i++) {
        if (roadEdge[i]) {
            const [a, b] = ctx.edgeList[i];
            st.roadDeg[a]++;
            st.roadDeg[b]++;
            st.roadLength += ctx.length[i];
        }
    }

    // NC sums.
    st.totals = {};

    for (const f of NODE_FIELDS) {
        st.totals[f] = 0;
    }

    for (let x = 0; x < n; x++) {
        addRecord(st.totals, nodeRecord(st, x), 1);
    }

    // RS4: every chain once.
    const chains = new Map();

    for (let x = 0; x < n; x++) {
        if (st.roadDeg[x] !== 2) {
            chainsTouching(st, x, chains);
        }
    }

    st.chainSpan = 0;

    for (const v of chains.values()) {
        st.chainSpan += v;
    }

    // BB: faces, copied so attempts do not share them.
    const F = ctx.faces;

    st.faceOf = F.faceOf.slice();
    st.faceArea = F.faceArea.slice();
    st.facePerim = F.facePerim.slice();
    st.faceOuter = F.faceOuter.slice();
    st.faceLists = F.lists.map(l => l.slice());

    st.blocks = { count: 0, area: 0, areaScore: 0, compactScore: 0, compactRaw: 0 };

    for (let f = 0; f < st.faceArea.length; f++) {
        if (!st.faceOuter[f]) {
            const c = blockContribution(ctx, st.faceArea[f], st.facePerim[f]);
            st.blocks.count++;
            st.blocks.area += c.area;
            st.blocks.areaScore += c.areaScore;
            st.blocks.compactScore += c.compactScore;
            st.blocks.compactRaw += c.compactRaw;
        }
    }

    // RS1/RS2: one shortest-path tree per source. treeMask[e] has
    // bit s set when source s's tree uses edge e - only those
    // trees can change when e is removed.
    st.treeMask = new Int32Array(m);
    st.paths = ctx.sources.map((s, k) => {
        const t = qualityShortestPaths(graph, s, ctx.sourceEuclid[k]);
        markTree(st, k, t.parent);
        return t;
    });

    st.isBridge = findGraphBridges(graph);

    st.blockLive = new Int32Array(ctx.blockCount);

    for (let x = 0; x < n; x++) {
        if (graph.degree[x] >= 1) {
            for (const b of ctx.nodeBlocks[x]) {
                st.blockLive[b]++;
            }
        }
    }

    if (!ctx.blockRequired) {
        ctx.blockRequired = st.blockLive.map(v => (v > 0 ? 1 : 0));
    }

    const sp = pathSums(st.paths);

    if (ctx.baseShimbel == null) {
        ctx.baseShimbel = sp.count ? sp.sumG / sp.count : 0;
    }

    st.current = scoreQuality(st, {
        totals: st.totals,
        roadLength: st.roadLength,
        chainSpan: st.chainSpan,
        blocks: st.blocks,
        sp
    });

    graph.quality = st;

    return st;
}


function markTree(st, k, parent) {

    const bit = 1 << k;

    for (let v = 0; v < parent.length; v++) {
        if (parent[v] >= 0) {
            st.treeMask[parent[v]] |= bit;
        }
    }
}

function pathSums(paths) {

    let sumG = 0;
    let sumE = 0;
    let count = 0;

    for (const t of paths) {
        sumG += t.sumG;
        sumE += t.sumE;
        count += t.count;
    }

    return { sumG, sumE, count };
}


// ------------------------------------------------------------
// Q from the running sums
// ------------------------------------------------------------

function scoreQuality(st, s) {

    const ctx = st.ctx;
    const t = s.totals;
    const g = st.graph;

    const V = t.alive;
    const E = g.aliveEdges;

    const raw = {
        junctionsPerLength: s.roadLength > 0 ? t.inter / s.roadLength : 0,
        meanDegree: t.nc ? t.degNC / t.nc : 0,
        angle: t.inter ? t.angle / t.inter : 0,
        deadEnds: t.nc ? t.dead / t.nc : 0,
        sides: t.sideN ? t.side / t.sideN : 0,
        shimbel: s.sp.count ? s.sp.sumG / s.sp.count : 0,
        circuity: s.sp.sumE > 0 ? s.sp.sumG / s.sp.sumE : 1,
        alpha: 2 * V - 5 > 0 ? Math.max(0, (E - V + 1) / (2 * V - 5)) : 0,
        tortuosity: s.chainSpan > 0 ? s.roadLength / s.chainSpan : 1,
        blocks: s.blocks.count,
        meanBlockArea: s.blocks.count ? s.blocks.area / s.blocks.count : 0,
        nodesPerBlock: s.blocks.count ? t.inter / s.blocks.count : 0,
        // By count, not area: with no blocks left the running area
        // sums hold floating-point residue, not zero.
        compactness: s.blocks.count > 0 ? s.blocks.compactRaw / s.blocks.area : 0,
        cost: g.totalLength / g.baseTotalLength
    };

    const scores = {
        spacing: scoreTarget(raw.junctionsPerLength * ctx.spacingTarget, 1, NC_SPACING_SIGMA),
        degree: scoreTarget(raw.meanDegree, NC_TARGET_DEGREE, NC_DEGREE_SIGMA),
        angle: raw.angle,
        deadEnds: scoreLower(raw.deadEnds, 0, NC_DEAD_END_LIMIT),
        sides: raw.sides,
        shimbel: ctx.baseShimbel
            ? scoreLower(raw.shimbel / ctx.baseShimbel, 1, RS_SHIMBEL_SPAN)
            : 1,
        circuity: scoreLower(raw.circuity, 1, RS_CIRCUITY_LIMIT - 1),
        alpha: scoreRange(raw.alpha, SPEC_ALPHA_RANGE[0], SPEC_ALPHA_RANGE[1]),
        tortuosity: scoreLower(raw.tortuosity, 1, RS_TORTUOSITY_SPAN),
        area: ctx.blockAreaTotal && s.blocks.count > 0 ? s.blocks.areaScore / ctx.blockAreaTotal : 0,
        nodesPerBlock: scoreRange(
            raw.nodesPerBlock,
            BB_NODES_PER_BLOCK_RANGE[0],
            BB_NODES_PER_BLOCK_RANGE[1]
        ),
        compactness: s.blocks.count > 0 ? s.blocks.compactScore / s.blocks.area : 0
    };

    const nc = weightedScore(NC_WEIGHTS, scores);
    const rs = weightedScore(RS_WEIGHTS, scores);
    const bb = weightedScore(BB_WEIGHTS, scores);

    const w = ctx.weights;

    const structural = w.nc * nc + w.rs * rs + w.bb * bb;

    return {
        Q: structural - ctx.costWeight * raw.cost,
        structural,
        nc,
        rs,
        bb,
        cost: raw.cost,
        scores,
        raw
    };
}


// ------------------------------------------------------------
// Hard rules
// ------------------------------------------------------------
//
// A road may go when it is not a bridge (the network stays in
// one piece), or when it is a dead end whose tip is not needed:
// not a facility or OD source, and every buildable block that
// corner borders still has another corner with a road.

function qualityCanRemove(st, e) {

    const g = st.graph;
    const edge = g.edges[e];

    if (!edge.alive) {
        return false;
    }

    if (!st.isBridge[e]) {
        removalRejections.accepted++;
        return true;
    }

    const tip =
        g.degree[edge.a] === 1 ? edge.a
            : g.degree[edge.b] === 1 ? edge.b
                : -1;

    if (tip < 0) {
        removalRejections.disconnect++;
        return false;
    }

    if (st.ctx.required[tip]) {
        removalRejections.required++;
        return false;
    }

    for (const b of st.ctx.nodeBlocks[tip]) {
        if (st.ctx.blockRequired[b] && st.blockLive[b] <= 1) {
            removalRejections.access++;
            return false;
        }
    }

    removalRejections.accepted++;
    return true;
}


// ------------------------------------------------------------
// Score a removal (and optionally keep it)
// ------------------------------------------------------------

function qualityEvaluateRemoval(st, e, commit) {

    const g = st.graph;
    const ctx = st.ctx;
    const edge = g.edges[e];
    const { a, b } = edge;
    const isRoad = ctx.roadEdge[e] === 1;

    // ---- before
    const recA0 = nodeRecord(st, a);
    const recB0 = nodeRecord(st, b);

    const span0 = isRoad ? chainSpanAround(st, a, b) : 0;

    // Faces on either side; merged if they differ.
    let merge = null;

    if (isRoad) {

        const f1 = st.faceOf[2 * e];
        const f2 = st.faceOf[2 * e + 1];

        if (f1 >= 0 && f2 >= 0 && f1 !== f2) {

            const small =
                st.faceLists[f1].length <= st.faceLists[f2].length ? f1 : f2;
            const other = small === f1 ? f2 : f1;

            let shared = 0;

            for (const h of st.faceLists[small]) {
                if (g.edges[h >> 1].alive && st.faceOf[h ^ 1] === other) {
                    shared += ctx.length[h >> 1];
                }
            }

            merge = {
                small,
                other,
                area: st.faceArea[f1] + st.faceArea[f2],
                perim: st.facePerim[f1] + st.facePerim[f2] - 2 * shared,
                outer: st.faceOuter[f1] || st.faceOuter[f2]
            };
        }
    }

    // ---- remove
    setEdgeAlive(g, e, false);

    if (isRoad) {
        st.roadDeg[a]--;
        st.roadDeg[b]--;
    }

    const recA1 = nodeRecord(st, a);
    const recB1 = nodeRecord(st, b);

    const span1 = isRoad ? chainSpanAround(st, a, b) : 0;

    const totals = { ...st.totals };

    addRecord(totals, recA0, -1);
    addRecord(totals, recB0, -1);
    addRecord(totals, recA1, 1);
    addRecord(totals, recB1, 1);

    const roadLength = st.roadLength - (isRoad ? ctx.length[e] : 0);
    const chainSpan = st.chainSpan - span0 + span1;

    let blocks = st.blocks;

    if (merge) {

        blocks = { ...st.blocks };

        for (const f of [merge.small, merge.other]) {
            if (!st.faceOuter[f]) {
                const c = blockContribution(ctx, st.faceArea[f], st.facePerim[f]);
                blocks.count--;
                blocks.area -= c.area;
                blocks.areaScore -= c.areaScore;
                blocks.compactScore -= c.compactScore;
                blocks.compactRaw -= c.compactRaw;
            }
        }

        if (!merge.outer) {
            const c = blockContribution(ctx, merge.area, merge.perim);
            blocks.count++;
            blocks.area += c.area;
            blocks.areaScore += c.areaScore;
            blocks.compactScore += c.compactScore;
            blocks.compactRaw += c.compactRaw;
        }
    }

    // Only the trees that used this road can change.
    const changed = [];
    const mask = st.treeMask[e];

    for (let k = 0; k < ctx.sources.length; k++) {
        if (mask & (1 << k)) {
            changed.push([
                k,
                repairShortestPaths(g, st.paths[k], e, ctx.sourceEuclid[k], commit)
            ]);
        }
    }

    const sp = pathSums(st.paths);

    for (const [k, t] of changed) {
        sp.sumG += t.sumG - st.paths[k].sumG;
        sp.sumE += t.sumE - st.paths[k].sumE;
        sp.count += t.count - st.paths[k].count;
    }

    const score = scoreQuality(st, { totals, roadLength, chainSpan, blocks, sp });

    if (!commit) {

        setEdgeAlive(g, e, true);

        if (isRoad) {
            st.roadDeg[a]++;
            st.roadDeg[b]++;
        }

        return score;
    }

    // ---- keep it
    st.totals = totals;
    st.roadLength = roadLength;
    st.chainSpan = chainSpan;
    st.blocks = blocks;

    if (merge) {

        const { small, other } = merge;

        for (const h of st.faceLists[small]) {
            st.faceOf[h] = other;
            st.faceLists[other].push(h);
        }

        st.faceLists[small] = [];
        st.faceArea[other] = merge.area;
        st.facePerim[other] = merge.perim;
        st.faceOuter[other] = merge.outer;
    }

    for (const [k, t] of changed) {

        const keep = ~(1 << k);

        for (let i = 0; i < st.treeMask.length; i++) {
            st.treeMask[i] &= keep;
        }

        markTree(st, k, t.parent);
        st.paths[k] = t;
    }

    for (const x of [a, b]) {
        if (g.degree[x] === 0) {
            for (const blk of ctx.nodeBlocks[x]) {
                st.blockLive[blk]--;
            }
        }
    }

    st.isBridge = findGraphBridges(g);

    if (st.history) {
        st.history.push(qualityHistoryPoint(score, score.Q - st.current.Q, st.phase));
    }

    st.current = score;

    return score;
}


// ------------------------------------------------------------
// Entry points used by the pruning code
// ------------------------------------------------------------

// Build a context + state for a graph that has none yet (the
// synchronous simplifyRoadNetwork() path).
function attachQualityModel(graph, options) {

    const edgeList = graph.edges.map(e => [e.a, e.b]);

    const ctx =
        createQualityContext(graph.nodes, edgeList, {
            blocks: getBlockCells(),
            ...(options || {})
        });

    return createQualityState(graph, ctx);
}


// Pick k so a typical removal gives a useful spread of
// probabilities: k = sharpness / median |dQ| over a sample of
// allowed removals. Each change of weights changes the scale of
// dQ, so a fixed k (the old 300) would not fit.
function calibrateRemovalK(st, sharpness) {

    const m = st.graph.edges.length;
    const step = Math.max(1, Math.floor(m / 150));

    const saved = { ...removalRejections };
    const deltas = [];

    for (let e = 0; e < m; e += step) {

        if (!qualityCanRemove(st, e)) {
            continue;
        }

        const after = qualityEvaluateRemoval(st, e, false);

        // Many removals change nothing (e.g. with only the BB
        // weight on, merging two in-range blocks); they say nothing
        // about the scale of dQ.
        const d = Math.abs(after.Q - st.current.Q);

        if (d > 1e-12) {
            deltas.push(d);
        }
    }

    removalRejections = saved;

    deltas.sort((a, b) => a - b);

    const typical =
        deltas.length ? deltas[deltas.length >> 1] : 0;

    // No removal changes Q at all: k does not matter.
    const k =
        typical > 0 ? (sharpness ?? DEFAULT_REMOVAL_SHARPNESS) / typical : 1;

    st.ctx.k = k;

    return { k, typical, sampled: deltas.length };
}


// Score a finished network (e.g. before and after straightening)
// against the references of the run that produced it.
function scoreNetwork(nodes, edgeList, refCtx, baseTotalLength) {

    const ctx =
        createQualityContext(nodes, edgeList, {
            weights: refCtx.weights,
            costWeight: refCtx.costWeight,
            references: qualityReferences(refCtx),
            sources: refCtx.sources
        });

    // Keep the run's weights as they were (BB is not dropped
    // just because this network's blocks are counted again).
    ctx.weights = refCtx.weights;

    const graph = makeRoadGraph(nodes, edgeList);

    graph.baseTotalLength = baseTotalLength || graph.baseTotalLength;

    return createQualityState(graph, ctx).current;
}


// ------------------------------------------------------------
// Metric history (for the metrics page, metrics.html)
// ------------------------------------------------------------
//
// One compact point per committed removal: the headline scores,
// every metric's score and raw value (in the key order below),
// the removal's dQ and whether it was a random or greedy pick.

const METRIC_SCORE_KEYS = [
    "spacing", "degree", "angle", "deadEnds", "sides",
    "shimbel", "circuity", "alpha", "tortuosity",
    "area", "nodesPerBlock", "compactness"
];

const METRIC_RAW_KEYS = [
    "junctionsPerLength", "meanDegree", "angle", "deadEnds", "sides",
    "shimbel", "circuity", "alpha", "tortuosity",
    "meanBlockArea", "nodesPerBlock", "compactness",
    "blocks", "cost"
];

const round6 = v => (Number.isFinite(v) ? +v.toPrecision(6) : null);

function qualityHistoryPoint(score, dQ, phase) {

    return {
        dQ: dQ == null ? null : round6(dQ),
        phase: phase || "start",
        Q: round6(score.Q),
        structural: round6(score.structural),
        nc: round6(score.nc),
        rs: round6(score.rs),
        bb: round6(score.bb),
        cost: round6(score.cost),
        scores: METRIC_SCORE_KEYS.map(k => round6(score.scores[k])),
        raw: METRIC_RAW_KEYS.map(k => round6(score.raw[k]))
    };
}


// What each metric is and how it is scored, in METRIC_SCORE_KEYS
// order, for the metrics page. `raw` names the raw value shown
// next to the score; `unit` tells the page how to format it.
function qualityMetricDefinitions(ctx) {

    const pct = v => `${Math.round(v * 100)}%`;

    return [
        { key: "spacing", group: "nc", label: "NC1 junction spacing", raw: "junctionsPerLength", unit: "perKm",
          rule: `target one intersection per ${NC_JUNCTION_SPACING_R} R of road (${(ctx.spacingTarget).toFixed(0)} px)`, weight: NC_WEIGHTS.spacing },
        { key: "degree", group: "nc", label: "NC2 mean degree", raw: "meanDegree", unit: "number",
          rule: `target ${NC_TARGET_DEGREE}, σ ${NC_DEGREE_SIGMA}`, weight: NC_WEIGHTS.degree },
        { key: "angle", group: "nc", label: "NC3 intersection angles", raw: "angle", unit: "score",
          rule: "nearest-road angle vs 90°, averaged", weight: NC_WEIGHTS.angle },
        { key: "deadEnds", group: "nc", label: "NC4 dead ends", raw: "deadEnds", unit: "percent",
          rule: `share of nodes; 0 at ${pct(NC_DEAD_END_LIMIT)}`, weight: NC_WEIGHTS.deadEnds },
        { key: "sides", group: "nc", label: "Side diversity", raw: "sides", unit: "score",
          rule: "roads spread around each node", weight: NC_WEIGHTS.sides },
        { key: "shimbel", group: "rs", label: "RS1 Shimbel distance", raw: "shimbel", unit: "metres",
          rule: `mean OD path; 0 at ${pct(1 + RS_SHIMBEL_SPAN)} of start`, weight: RS_WEIGHTS.shimbel },
        { key: "circuity", group: "rs", label: "RS2 circuity", raw: "circuity", unit: "ratio",
          rule: `network ÷ straight distance; 0 at ${RS_CIRCUITY_LIMIT}`, weight: RS_WEIGHTS.circuity },
        { key: "alpha", group: "rs", label: "RS3 alpha (loops)", raw: "alpha", unit: "number",
          rule: `1 inside ${SPEC_ALPHA_RANGE[0]}–${SPEC_ALPHA_RANGE[1]}`, weight: RS_WEIGHTS.alpha },
        { key: "tortuosity", group: "rs", label: "RS4 tortuosity", raw: "tortuosity", unit: "ratio",
          rule: `chain ÷ straight length; 0 at ${1 + RS_TORTUOSITY_SPAN}`, weight: RS_WEIGHTS.tortuosity },
        { key: "area", group: "bb", label: "BB1 block area", raw: "meanBlockArea", unit: "hectares",
          rule: `in ${BB_AREA_RANGE[0]}–${BB_AREA_RANGE[1]}× the median starting block; lost blocks count`, weight: BB_WEIGHTS.area },
        { key: "nodesPerBlock", group: "bb", label: "BB2 intersections per block", raw: "nodesPerBlock", unit: "number",
          rule: `1 inside ${BB_NODES_PER_BLOCK_RANGE[0]}–${BB_NODES_PER_BLOCK_RANGE[1]}`, weight: BB_WEIGHTS.nodesPerBlock },
        { key: "compactness", group: "bb", label: "Block compactness", raw: "compactness", unit: "score",
          rule: `4πA/P², 1 at ${BB_COMPACTNESS_MIN} or above`, weight: BB_WEIGHTS.compactness }
    ];
}


// "NC 0.61 · RS 0.74 · BB 0.58 · cost 0.75" for logs and stats.
function qualityLabel(score) {

    return `Q ${score.Q.toFixed(3)} (NC ${score.nc.toFixed(2)} · ` +
        `RS ${score.rs.toFixed(2)} · BB ${score.bb.toFixed(2)} · ` +
        `cost ${score.cost.toFixed(2)})`;
}


// ------------------------------------------------------------
// Repair required access (after pruning)
// ------------------------------------------------------------
//
// `alive` is one flag per ctx.edgeList road. Every facility, and
// every buildable block that had a road at a corner to begin
// with, must be reachable from the main network. For any that
// is not, the cheapest way back is found (Dijkstra where kept
// roads cost 0 and removed roads cost their length) and those
// removed roads are put back. Mutates `alive`.

function repairRequiredAccess(ctx, alive) {

    const { n, edgeList, length } = ctx;

    const adj = Array.from({ length: n }, () => []);

    edgeList.forEach(([a, b], i) => {
        adj[a].push(i);
        adj[b].push(i);
    });

    // Label components over kept roads.
    const comp = new Int32Array(n).fill(-1);
    const sizes = [];

    const flood = (start, label) => {

        const stack = [start];
        comp[start] = label;

        let size = 0;

        while (stack.length) {

            const v = stack.pop();
            size++;

            for (const ei of adj[v]) {

                if (!alive[ei]) {
                    continue;
                }

                const [a, b] = edgeList[ei];
                const w = a === v ? b : a;

                if (comp[w] !== label) {
                    comp[w] = label;
                    stack.push(w);
                }
            }
        }

        return size;
    };

    for (let v = 0; v < n; v++) {
        if (comp[v] < 0 && adj[v].some(ei => alive[ei])) {
            sizes.push(flood(v, sizes.length));
        }
    }

    let main = 0;

    sizes.forEach((size, c) => {
        if (size > sizes[main]) {
            main = c;
        }
    });

    // What has to be reachable: facilities, and one corner of each
    // block that started with road access.
    const targets = [];

    let facilities = 0;

    for (let v = 0; v < n; v++) {
        if (ctx.isFacility[v] && adj[v].length) {
            facilities++;
            targets.push([v]);
        }
    }

    const blockCorners =
        Array.from({ length: ctx.blockCount }, () => []);

    ctx.nodeBlocks.forEach((list, v) => {
        for (const b of list) {
            if (adj[v].length) {
                blockCorners[b].push(v);
            }
        }
    });

    let blocks = 0;

    blockCorners.forEach((corners, b) => {
        if (ctx.blockRequired && ctx.blockRequired[b] && corners.length) {
            blocks++;
            targets.push(corners);
        }
    });

    let restored = 0;
    let repaired = 0;

    for (const corners of targets) {

        if (corners.some(v => comp[v] === main)) {
            continue;
        }

        // Cheapest path from any corner to the main network.
        const dist = new Float64Array(n).fill(Infinity);
        const via = new Int32Array(n).fill(-1);
        const done = new Uint8Array(n);

        for (const v of corners) {
            dist[v] = 0;
        }

        let reached = -1;

        while (true) {

            let v = -1;

            for (let i = 0; i < n; i++) {
                if (!done[i] && dist[i] < Infinity && (v < 0 || dist[i] < dist[v])) {
                    v = i;
                }
            }

            if (v < 0) {
                break;
            }

            if (comp[v] === main) {
                reached = v;
                break;
            }

            done[v] = 1;

            for (const ei of adj[v]) {

                const [a, b] = edgeList[ei];
                const w = a === v ? b : a;
                const d = dist[v] + (alive[ei] ? 0 : length[ei]);

                if (d < dist[w]) {
                    dist[w] = d;
                    via[w] = ei;
                }
            }
        }

        if (reached < 0) {
            continue;
        }

        // Walk back, restoring removed roads on the way.
        let v = reached;

        while (via[v] >= 0) {

            const ei = via[v];

            if (!alive[ei]) {
                alive[ei] = true;
                restored++;
            }

            const [a, b] = edgeList[ei];
            v = a === v ? b : a;
        }

        repaired++;

        // Everything now joined to the main network.
        for (const c of corners) {
            flood(c, main);
        }
    }

    return { facilities, blocks, restored, repaired };
}
