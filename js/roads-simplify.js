// js/roads-simplify.js
// Probabilistic road simplification: alpha/beta/gamma, quality Q, sigmoid removal.
// Plain script: shares the global scope with the other js/ files,
// so load order in index.html matters.

// ============================================================
// PROBABILISTIC ROAD SIMPLIFICATION
// ============================================================
//
// Removes redundant roads one at a time, probabilistically,
// while never breaking the hard rules (roads-quality.js,
// qualityCanRemove()):
//
//     the network stays in one piece
//     no facility (or OD sample node) is cut off
//     every buildable block keeps a road at one of its corners
//
// A candidate removal is scored by how much it changes the
// network quality Q (roads-quality.js: NC, RS and BB metric
// groups minus a road-cost term), converted to a probability
// through a sigmoid, and then sampled - so the algorithm prefers
// good removals without being deterministic, and two runs give
// different cities. How far it goes is the road budget.
//
// "Cell" here means a node of the road graph: a junction, or a
// facility hanging off a spur. Its degree is how many roads
// meet it, and each incident road arrives from its own side.
// ============================================================

// Reference band for alpha: RS3 scores 1 inside it. beta and
// gamma are reported against theirs but not scored (they measure
// nearly the same thing as alpha).
const SPEC_ALPHA_RANGE = [0.20, 0.45];
const SPEC_BETA_RANGE = [1.30, 1.80];
const SPEC_GAMMA_RANGE = [0.40, 0.60];


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

// Nodes that still have a road; a pruned dead end has none and
// is no longer part of the network.
function activeGraphNodes(graph) {

    let v = 0;

    for (const d of graph.degree) {
        if (d > 0) {
            v++;
        }
    }

    return v;
}


// Lowest degree among nodes that still have a road.
function minActiveDegree(graph) {

    let min = Infinity;

    for (const d of graph.degree) {
        if (d > 0 && d < min) {
            min = d;
        }
    }

    return min === Infinity ? 0 : min;
}


function calculateAlpha(graph) {

    const v = activeGraphNodes(graph);
    const e = graph.aliveEdges;
    const p = countGraphComponents(graph);

    const den = 2 * v - 5 * p;

    return den > 0
        ? Math.max(0, (e - v + p) / den)
        : 0;
}


function calculateBeta(graph) {

    const v = activeGraphNodes(graph);

    return v > 0
        ? graph.aliveEdges / v
        : 0;
}


function calculateGamma(graph) {

    const v = activeGraphNodes(graph);
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

        if (seen[start] || graph.degree[start] === 0) {
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
// Quality and hard rules (both live in roads-quality.js)
// ------------------------------------------------------------

function qualityStateOf(graph) {
    return graph.quality || attachQualityModel(graph);
}


function calculateGraphQuality(graph) {
    return qualityStateOf(graph).current.Q;
}


// Total build cost of the surviving network, 0..1 against the
// original. Every removal lowers it; removing a LONG road
// lowers it more.
function calculateNetworkCost(graph) {

    return graph.totalLength / graph.baseTotalLength;
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


// Populated by simplifyRoadNetwork so a run that removes
// nothing can say exactly which rule was binding.
let removalRejections = {
    disconnect: 0,
    required: 0,
    access: 0,
    accepted: 0
};

function isValidEdgeRemoval(graph, edgeIndex) {
    return qualityCanRemove(qualityStateOf(graph), edgeIndex);
}


// Remove a road for good, keeping the quality state in step.
function removeRoad(graph, edgeIndex) {

    if (graph.quality) {
        qualityEvaluateRemoval(graph.quality, edgeIndex, true);
    } else {
        setEdgeAlive(graph, edgeIndex, false);
    }
}


// ------------------------------------------------------------
// Removal probability
// ------------------------------------------------------------

function calculateRemovalProbability(graph, edgeIndex, k) {

    const st = qualityStateOf(graph);

    if (!qualityCanRemove(st, edgeIndex)) {
        return 0;
    }

    const dQ =
        qualityEvaluateRemoval(st, edgeIndex, false).Q - st.current.Q;

    return 1 / (1 + Math.exp(-(k ?? st.ctx.k ?? 300) * dQ));
}


// ------------------------------------------------------------
// Act on one cell
// ------------------------------------------------------------
