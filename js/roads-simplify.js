// js/roads-simplify.js
// Probabilistic road simplification: alpha/beta/gamma, quality Q, sigmoid removal.
// Plain script: shares the global scope with the other js/ files,
// so load order in index.html matters.

// ============================================================
// PROBABILISTIC ROAD SIMPLIFICATION
// ============================================================
//
// Removes redundant roads one at a time, probabilistically,
// while never breaking three hard invariants:
//
//     for every cell c:  degree(c) >= 1
//     components(graph) == 1
//     alpha/beta/gamma stay inside their target ranges
//
// A candidate removal is scored by how much it improves the
// graph (dQ), converted to a probability through a sigmoid, and
// then sampled - so the algorithm prefers good removals without
// being deterministic, and two runs give different cities.
//
// "Cell" here means a node of the road graph: a junction, or a
// facility hanging off a spur. Its degree is how many roads
// meet it, and each incident road arrives from its own side.
// ============================================================

// Target ranges. A removal that pushes a metric outside its
// range is rejected outright, which is what stops the process
// from stripping the network down to a tree.
// alpha/beta/gamma are no longer constraints. They are computed
// and reported, but nothing is ever rejected for leaving a
// range. The only hard rules left are structural:
//
//     every cell keeps degree >= 1
//     the graph stays a single component
//
// What decides how far simplification goes is now a direct road
// budget: keep removing until the requested share of total road
// length is gone, or nothing else can safely come out.
//
// Kept only as the reference band the readout compares against.
const SPEC_ALPHA_RANGE = [0.20, 0.45];
const SPEC_BETA_RANGE = [1.30, 1.80];
const SPEC_GAMMA_RANGE = [0.40, 0.60];

// Redundancy that the quality function SOFTLY prefers to keep.
// A soft preference, not a floor: it makes removals that gut
// the network's redundancy less likely, without ever forbidding
// one. Without some term like this the sigmoid saturates at
// P = 1 and the process stops being probabilistic at all.
const ALPHA_REFERENCE = 0.35;


// Weight on total road cost. This is the term that drives
// simplification: every road removed cuts total build length,
// so Q rises. It has to outweigh the residual centre pull in
// rangeScore(), or removals score negative and never fire.
const COST_WEIGHT = 3.0;

// Weight on the road-length penalty in the quality function.
const LENGTH_LAMBDA = 0.35;

// Weight on the side-diversity reward.
const DIVERSITY_WEIGHT = 0.15;

// Sigmoid sharpness. With the cost term in place a single
// removal shifts Q by ~4e-3, so k on the order of 1/|dQ| (a few
// hundred) is what puts probabilities in a useful spread rather
// than pinning them all at 0 or 1.
const DEFAULT_SIGMOID_K = 300;


// ------------------------------------------------------------
// Graph structure
// ------------------------------------------------------------

function makeRoadGraph(nodes, edgeList) {

    const edges =
        edgeList.map(([a, b]) => ({
            a,
            b,
            length: Math.hypot(
                nodes[a].x - nodes[b].x,
                nodes[a].y - nodes[b].y
            ),
            alive: true
        }));

    const graph = {
        nodes,
        edges,
        adj: Array.from({ length: nodes.length }, () => []),
        degree: new Array(nodes.length).fill(0),
        aliveEdges: edges.length,
        maxLength: 0,
        totalLength: 0
    };

    edges.forEach((e, i) => {
        graph.adj[e.a].push(i);
        graph.adj[e.b].push(i);
        graph.degree[e.a]++;
        graph.degree[e.b]++;
        graph.maxLength = Math.max(graph.maxLength, e.length);
        graph.totalLength += e.length;
    });

    if (graph.maxLength === 0) {
        graph.maxLength = 1;
    }

    // Frozen at construction so the cost term measures spend
    // against the ORIGINAL network, not against itself.
    graph.baseTotalLength = graph.totalLength || 1;

    return graph;
}


function setEdgeAlive(graph, index, alive) {

    const e = graph.edges[index];

    if (e.alive === alive) {
        return;
    }

    e.alive = alive;

    const delta = alive ? 1 : -1;

    graph.degree[e.a] += delta;
    graph.degree[e.b] += delta;

    graph.aliveEdges += delta;
    graph.totalLength += delta * e.length;
}


function aliveEdgeList(graph) {

    return graph.edges
        .filter(e => e.alive)
        .map(e => [e.a, e.b]);
}


// ------------------------------------------------------------
// Metrics
// ------------------------------------------------------------

function calculateAlpha(graph) {

    const v = graph.nodes.length;
    const e = graph.aliveEdges;
    const p = countGraphComponents(graph);

    const den = 2 * v - 5 * p;

    return den > 0
        ? Math.max(0, (e - v + p) / den)
        : 0;
}


function calculateBeta(graph) {

    return graph.nodes.length > 0
        ? graph.aliveEdges / graph.nodes.length
        : 0;
}


function calculateGamma(graph) {

    const v = graph.nodes.length;
    const p = countGraphComponents(graph);

    const den = 3 * (v - 2 * p);

    return den > 0
        ? Math.max(0, graph.aliveEdges / den)
        : 0;
}


// ------------------------------------------------------------
// Cell queries
// ------------------------------------------------------------

function getCellDegree(graph, cell) {
    return graph.degree[cell];
}


function isCellConnected(graph, cell) {
    return graph.degree[cell] >= 1;
}


function countGraphComponents(graph) {

    const n = graph.nodes.length;

    if (n === 0) {
        return 0;
    }

    const seen = new Uint8Array(n);

    let components = 0;

    for (let start = 0; start < n; start++) {

        if (seen[start]) {
            continue;
        }

        components++;

        const stack = [start];
        seen[start] = 1;

        while (stack.length) {

            const v = stack.pop();

            for (const ei of graph.adj[v]) {

                const e = graph.edges[ei];

                if (!e.alive) {
                    continue;
                }

                const w = e.a === v ? e.b : e.a;

                if (!seen[w]) {
                    seen[w] = 1;
                    stack.push(w);
                }
            }
        }
    }

    return components;
}


function isGraphConnected(graph) {
    return countGraphComponents(graph) === 1;
}


// ------------------------------------------------------------
// Side awareness
// ------------------------------------------------------------
//
// Each road arrives at a cell from some bearing. Two roads
// leaving the same side are near-duplicates; roads spread
// around the cell give real route diversity.
//
// Diversity = 1 - |mean unit vector of the incident bearings|.
// Evenly spread roads cancel out (diversity -> 1); roads all
// pointing the same way reinforce (diversity -> 0).

function sideOfAngle(angle) {

    const deg = (angle * 180 / Math.PI + 360) % 360;

    if (deg >= 45 && deg < 135) {
        return "SOUTH";
    }

    if (deg >= 135 && deg < 225) {
        return "WEST";
    }

    if (deg >= 225 && deg < 315) {
        return "NORTH";
    }

    return "EAST";
}


function cellConnections(graph, cell) {

    const out = [];

    for (const ei of graph.adj[cell]) {

        const e = graph.edges[ei];

        if (!e.alive) {
            continue;
        }

        const other = e.a === cell ? e.b : e.a;

        const angle =
            Math.atan2(
                graph.nodes[other].y - graph.nodes[cell].y,
                graph.nodes[other].x - graph.nodes[cell].x
            );

        out.push({
            edge: ei,
            other,
            angle,
            side: sideOfAngle(angle),
            length: e.length
        });
    }

    return out;
}


function calculateSideDiversity(graph, cell) {

    const conns = cellConnections(graph, cell);

    if (conns.length < 2) {
        return 0;
    }

    let sx = 0;
    let sy = 0;

    for (const c of conns) {
        sx += Math.cos(c.angle);
        sy += Math.sin(c.angle);
    }

    const resultant =
        Math.hypot(sx, sy) / conns.length;

    return 1 - resultant;
}


// ------------------------------------------------------------
// Quality
// ------------------------------------------------------------
//
// Soft redundancy preference: 1.0 at or above the reference
// alpha, tapering to 0 as the network approaches a tree. No
// hard edges, so it can never veto a removal - it only makes
// removals that strip redundancy score a little worse.
function calculateConnectivityScore(graph) {

    return Math.min(
        1,
        calculateAlpha(graph) / ALPHA_REFERENCE
    );
}


function calculateRoadLengthPenalty(graph, edgeIndex) {

    return graph.edges[edgeIndex].length / graph.maxLength;
}


// Mean normalised road length across the surviving network.
// Dropping a long road lowers this, which raises quality.
function meanLengthPenalty(graph) {

    if (graph.aliveEdges === 0) {
        return 0;
    }

    return (graph.totalLength / graph.aliveEdges) /
        graph.maxLength;
}


function averageSideDiversity(graph) {

    let sum = 0;
    let counted = 0;

    for (let i = 0; i < graph.nodes.length; i++) {

        if (graph.degree[i] >= 2) {
            sum += calculateSideDiversity(graph, i);
            counted++;
        }
    }

    return counted > 0 ? sum / counted : 0;
}


// Total build cost of the surviving network, 0..1 against the
// original. Every removal lowers it; removing a LONG road
// lowers it more.
function calculateNetworkCost(graph) {

    return graph.totalLength / graph.baseTotalLength;
}


function calculateGraphQuality(graph) {

    return calculateConnectivityScore(graph) +
        DIVERSITY_WEIGHT * averageSideDiversity(graph) -
        LENGTH_LAMBDA * meanLengthPenalty(graph) -
        COST_WEIGHT * calculateNetworkCost(graph);
}


// ------------------------------------------------------------
// Hard constraints
// ------------------------------------------------------------

// Populated by simplifyRoadNetwork so a run that removes
// nothing can say exactly which constraint was binding.
let removalRejections = {
    degree: 0,
    disconnect: 0,
    accepted: 0
};

function isValidEdgeRemoval(graph, edgeIndex) {

    const e = graph.edges[edgeIndex];

    if (!e.alive) {
        return false;
    }

    // Never strand a cell: its last road is untouchable.
    if (
        getCellDegree(graph, e.a) <= 1 ||
        getCellDegree(graph, e.b) <= 1
    ) {
        removalRejections.degree++;
        return false;
    }

    // Try it and check the whole graph.
    setEdgeAlive(graph, edgeIndex, false);

    let valid = true;

    // Every cell still has a road.
    for (let i = 0; i < graph.nodes.length; i++) {
        if (!isCellConnected(graph, i)) {
            valid = false;
            break;
        }
    }

    // Still one piece.
    if (valid && !isGraphConnected(graph)) {
        valid = false;
        removalRejections.disconnect++;
    }

    // No alpha/beta/gamma gate. The structural rules above are
    // the only hard constraints; how far the network is allowed
    // to shrink is decided by the road budget in
    // simplifyRoadNetwork(), not by a metric range.

    setEdgeAlive(graph, edgeIndex, true);

    if (valid) {
        removalRejections.accepted++;
    }

    return valid;
}


// ------------------------------------------------------------
// Removal probability
// ------------------------------------------------------------

function calculateRemovalProbability(graph, edgeIndex, k) {

    if (!isValidEdgeRemoval(graph, edgeIndex)) {
        return 0;
    }

    const before = calculateGraphQuality(graph);

    setEdgeAlive(graph, edgeIndex, false);
    const after = calculateGraphQuality(graph);
    setEdgeAlive(graph, edgeIndex, true);

    const dQ = after - before;

    return 1 / (1 + Math.exp(-(k ?? DEFAULT_SIGMOID_K) * dQ));
}


// ------------------------------------------------------------
// Act on one cell
// ------------------------------------------------------------
