// js/roads-network.js
// Road network construction, facility links and rendering.
// Plain script: shares the global scope with the other js/ files,
// so load order in index.html matters.

// ============================================================
// ROAD NETWORK
// ============================================================
//
// The Urquhart graph is the skeleton. Three knobs shape it into
// an actual road network:
//
//   1. DEAD-END PRUNING — repeatedly delete degree-1 nodes.
//      A cul-de-sac is a stretch of road that serves no through
//      traffic, so every cell along it gets "visited" by the
//      network without that visit connecting anything. Removing
//      them is what minimises redundant visits, and because a
//      leaf removal drops one node AND one edge while leaving
//      (e - v) unchanged, it RAISES alpha, beta and gamma at
//      the same time.
//
//   2. EXTRA EDGES — Urquhart throws away the longest edge of
//      every triangle. Adding the shortest of those back, in
//      increasing length order, creates circuits. Circuits are
//      exactly what alpha and gamma measure, so this is the
//      direct lever on connectivity.
//
//   3. FACILITY LINKS — spur each facility into the nearest
//      road nodes. With one link per facility that spur is a
//      dead-end; with two or more it forms a loop, so the
//      facility is reachable by more than one route.
//
// Connectivity indices (standard transport geography, planar):
//
//      v = nodes, e = edges, p = connected components
//
//      beta  = e / v                     edges per node
//      alpha = (e - v + p) / (2v - 5p)   circuits / max circuits
//      gamma = e / (3(v - 2p))           edges / max planar edges
//
// alpha and gamma are both 0..1. A tree scores alpha = 0.
// ============================================================

let roadNetwork = null;


function connectivityIndices(nodeCount, edgeCount, components) {

    const v = nodeCount;
    const e = edgeCount;
    const p = Math.max(1, components);

    if (v < 3) {
        return { v, e, p, alpha: 0, beta: 0, gamma: 0 };
    }

    const alphaDen = 2 * v - 5 * p;
    const gammaDen = 3 * (v - 2 * p);

    return {
        v,
        e,
        p,
        beta: e / v,
        alpha: alphaDen > 0
            ? Math.max(0, (e - v + p) / alphaDen)
            : 0,
        gamma: gammaDen > 0
            ? Math.max(0, e / gammaDen)
            : 0
    };
}


function countComponents(nodeCount, edges) {

    const adj = Array.from({ length: nodeCount }, () => []);

    for (const [a, b] of edges) {
        adj[a].push(b);
        adj[b].push(a);
    }

    const seen = new Array(nodeCount).fill(false);

    let components = 0;

    for (let i = 0; i < nodeCount; i++) {

        if (seen[i]) {
            continue;
        }

        components++;

        const stack = [i];
        seen[i] = true;

        while (stack.length) {

            const v = stack.pop();

            for (const w of adj[v]) {
                if (!seen[w]) {
                    seen[w] = true;
                    stack.push(w);
                }
            }
        }
    }

    return components;
}


// ------------------------------------------------------------
// 1. Dead-end pruning
// ------------------------------------------------------------
//
// Iterative, because removing one leaf can expose another: a
// chain of cul-de-sac segments unwinds one node at a time.
// Returns the surviving node indices and the rewritten edges.

function pruneDeadEnds(nodes, edges) {

    const alive = new Array(nodes.length).fill(true);

    const degree = new Array(nodes.length).fill(0);

    const live = edges.map(() => true);

    const incident =
        Array.from({ length: nodes.length }, () => []);

    edges.forEach(([a, b], i) => {
        degree[a]++;
        degree[b]++;
        incident[a].push(i);
        incident[b].push(i);
    });

    const queue = [];

    for (let i = 0; i < nodes.length; i++) {
        if (degree[i] === 1) {
            queue.push(i);
        }
    }

    let removed = 0;

    while (queue.length) {

        const v = queue.pop();

        if (!alive[v] || degree[v] !== 1) {
            continue;
        }

        alive[v] = false;
        removed++;

        for (const ei of incident[v]) {

            if (!live[ei]) {
                continue;
            }

            live[ei] = false;

            const [a, b] = edges[ei];
            const other = a === v ? b : a;

            degree[other]--;

            if (alive[other] && degree[other] === 1) {
                queue.push(other);
            }
        }
    }

    // Reindex the survivors.
    const remap = new Array(nodes.length).fill(-1);

    const outNodes = [];

    for (let i = 0; i < nodes.length; i++) {
        if (alive[i]) {
            remap[i] = outNodes.length;
            outNodes.push(nodes[i]);
        }
    }

    const outEdges = [];

    edges.forEach(([a, b], i) => {
        if (live[i] && remap[a] >= 0 && remap[b] >= 0) {
            outEdges.push([remap[a], remap[b]]);
        }
    });

    return { nodes: outNodes, edges: outEdges, removed };
}


// ------------------------------------------------------------
// Build the whole thing
// ------------------------------------------------------------

function buildRoadNetwork() {

    const corners =
        collectPolygonVertices();

    if (corners.length < 3) {
        roadNetwork = null;
        return null;
    }

    const split =
        computeUrquhartSplit(corners);

    const lengthOf = (pts, [a, b]) =>
        Math.hypot(
            pts[a].x - pts[b].x,
            pts[a].y - pts[b].y
        );

    // --------------------------------------------------------
    // 2. Add back the shortest of the removed edges
    // --------------------------------------------------------

    const extraPct =
        Number(extraEdgeSlider.value) / 100;

    const reinstated =
        split.removed
            .slice()
            .sort(
                (p, q) =>
                    lengthOf(corners, p) - lengthOf(corners, q)
            )
            .slice(
                0,
                Math.round(split.removed.length * extraPct)
            );

    let nodes = corners.map(p => ({
        x: p.x,
        y: p.y,
        kind: "junction"
    }));

    let edges =
        split.kept
            .concat(reinstated)
            .map(([a, b]) => [a, b]);

    const urquhartEdgeCount = split.kept.length;

    // --------------------------------------------------------
    // 1. Prune cul-de-sacs
    // --------------------------------------------------------

    let prunedNodes = 0;

    if (pruneToggle.checked) {

        const pruned = pruneDeadEnds(nodes, edges);

        nodes = pruned.nodes;
        edges = pruned.edges;
        prunedNodes = pruned.removed;
    }

    const roadNodeCount = nodes.length;
    const roadEdgeCount = edges.length;

    const roadIndices =
        connectivityIndices(
            roadNodeCount,
            roadEdgeCount,
            countComponents(roadNodeCount, edges)
        );

    // --------------------------------------------------------
    // 3. Link the facilities in
    // --------------------------------------------------------

    const linksEach =
        Number(facilityLinkSlider.value);

    const facilityEdges = [];

    let linkedFacilities = 0;

    if (
        linksEach > 0 &&
        roadNodeCount >= 2
    ) {

        const finder =
            d3.Delaunay.from(
                nodes,
                d => d.x,
                d => d.y
            );

        for (const layer of FACILITY_LAYERS) {

            if (!layer.visible) {
                continue;
            }

            for (const facility of layer.points) {

                const index = nodes.length;

                nodes.push({
                    x: facility.x,
                    y: facility.y,
                    kind: "facility",
                    color: layer.color
                });

                // Nearest junction, then walk its Delaunay
                // neighbours outward for the rest, so the
                // extra links fan out instead of stacking on
                // one spot.
                const seed =
                    finder.find(facility.x, facility.y);

                const candidates = [seed];

                for (const n of finder.neighbors(seed)) {
                    candidates.push(n);
                }

                candidates
                    .slice(0, linksEach)
                    .forEach(target => {
                        facilityEdges.push([index, target]);
                    });

                linkedFacilities++;
            }
        }
    }

    const allEdges =
        edges.concat(facilityEdges);

    const fullIndices =
        connectivityIndices(
            nodes.length,
            allEdges.length,
            countComponents(nodes.length, allEdges)
        );

    let totalLength = 0;

    for (const e of allEdges) {
        totalLength += lengthOf(nodes, e);
    }

    roadNetworkDirty = false;

    roadNetwork = {
        nodes,
        edges,
        facilityEdges,
        allEdges,
        roadIndices,
        fullIndices,
        totalLength,
        urquhartEdgeCount,
        reinstated: reinstated.length,
        removedAvailable: split.removed.length,
        prunedNodes,
        linkedFacilities,
        roadNodeCount
    };

    return roadNetwork;
}


// ------------------------------------------------------------
// Draw it
// ------------------------------------------------------------

function drawUrquhart() {

    urquhartLayer.selectAll("*").remove();

    if (!urquhartToggle.checked) {
        updateRoadStats();
        return;
    }

    // Nothing upstream changed - repaint what we already have,
    // simplification and all.
    if (roadNetwork && !roadNetworkDirty) {
        renderRoadNetwork(roadNetwork);
        return;
    }

    const net = buildRoadNetwork();

    if (!net) {
        updateRoadStats();
        return;
    }

    renderRoadNetwork(net);
}


// Draw whatever edges the network currently holds. Kept apart
// from buildRoadNetwork() so simplification can redraw its
// result without regenerating the graph underneath it.
function renderRoadNetwork(net) {

    urquhartLayer.selectAll("*").remove();

    const group =
        urquhartLayer.append("g");

    if (cityClosed) {
        group.attr("clip-path", "url(#cityClip)");
    }

    // One path for the road network - thousands of separate
    // <line> elements would crawl at city scale.
    let d = "";

    for (const [a, b] of net.edges) {
        d +=
            `M${net.nodes[a].x},${net.nodes[a].y}` +
            `L${net.nodes[b].x},${net.nodes[b].y}`;
    }

    if (d) {
        group
            .append("path")
            .attr("class", "urquhart-edge")
            .attr("d", d);
    }

    // Facility spurs, in each facility's own colour.
    if (net.facilityEdges.length) {

        const byColor = new Map();

        for (const [a, b] of net.facilityEdges) {

            const color =
                net.nodes[a].color ||
                net.nodes[b].color ||
                "#ffffff";

            byColor.set(
                color,
                (byColor.get(color) || "") +
                `M${net.nodes[a].x},${net.nodes[a].y}` +
                `L${net.nodes[b].x},${net.nodes[b].y}`
            );
        }

        for (const [color, path] of byColor) {
            group
                .append("path")
                .attr("class", "facility-link")
                .attr("stroke", color)
                .attr("d", path);
        }
    }

    // Ordinary graph nodes.
    const radius =
        Math.max(1.2, 2.5 / zoomScale);

    group
        .selectAll("circle.building-point")
        .data(net.nodes.slice(0, net.roadNodeCount))
        .join("circle")
        .attr("class", "building-point")
        .attr("cx", p => p.x)
        .attr("cy", p => p.y)
        .attr("r", radius);

    // Selected road junctions, drawn larger and on top.
    if (net.junctions && junctionToggle.checked) {

        const jr =
            Math.max(2.6, 5 / zoomScale);

        group
            .selectAll("circle.road-junction")
            .data(
                net.junctions.junctions
                    .filter(i => i < net.nodes.length)
                    .map(i => net.nodes[i])
            )
            .join("circle")
            .attr("class", "road-junction")
            .attr("cx", p => p.x)
            .attr("cy", p => p.y)
            .attr("r", jr);
    }

    updateRoadStats();
}


// ------------------------------------------------------------
// Stats readout
// ------------------------------------------------------------

function updateRoadStats() {

    if (!roadStats) {
        return;
    }

    if (!urquhartToggle.checked) {
        roadStats.textContent =
            "Enable the Building Network layer to measure.";
        return;
    }

    const net = roadNetwork;

    if (!net) {
        roadStats.textContent =
            "Close a city boundary first.";
        return;
    }

    const r = net.roadIndices;
    const f = net.fullIndices;

    roadStats.textContent =
        `Roads  α ${r.alpha.toFixed(3)}  ` +
        `β ${r.beta.toFixed(3)}  γ ${r.gamma.toFixed(3)}\n` +
        `${r.v} junctions · ${r.e} edges · ` +
        `${r.p} component${r.p === 1 ? "" : "s"}\n` +
        `+ facilities  α ${f.alpha.toFixed(3)}  ` +
        `β ${f.beta.toFixed(3)}  γ ${f.gamma.toFixed(3)}\n` +
        `${net.linkedFacilities} linked · ` +
        `${net.facilityEdges.length} spurs\n` +
        `Urquhart ${net.urquhartEdgeCount} + ` +
        `${net.reinstated} reinstated of ` +
        `${net.removedAvailable}\n` +
        `${net.prunedNodes} cul-de-sac nodes pruned · ` +
        `total ${metresLabel(net.totalLength)}` +
        (net.simplified
            ? (net.junctions
                ? `\n${net.junctions.junctions.length} junctions ` +
                  `(r ${net.junctions.radius}, independent)`
                : "") +
              `\nSimplified −${net.simplified.removed} roads` +
              (net.simplified.attempts
                  ? ` (attempt ${net.simplified.attempt}/` +
                    `${net.simplified.attempts})`
                  : "") + ` · ` +
              `−${(100 * (1 - net.simplified.costAfter /
                   net.simplified.costBefore)).toFixed(1)}% length · ` +
              `min degree ${net.simplified.minDegree}`
            : "");
}


// Network size, in metres when scale is known.
function urquhartStats() {

    const net =
        roadNetwork || buildRoadNetwork();

    if (!net) {
        return null;
    }

    return {
        buildings: net.roadNodeCount,
        edges: net.edges.length,
        totalLength: net.totalLength,
        alpha: net.roadIndices.alpha,
        beta: net.roadIndices.beta,
        gamma: net.roadIndices.gamma
    };
}
