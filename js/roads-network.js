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


// Nodes with at least one road among the first nodeCount.
function activeNodeCount(nodeCount, edges) {

    const used = new Uint8Array(nodeCount);

    for (const [a, b] of edges) {
        if (a < nodeCount) used[a] = 1;
        if (b < nodeCount) used[b] = 1;
    }

    return used.reduce((s, v) => s + v, 0);
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

        // A node with no road left (a pruned dead end) is not
        // part of the network.
        if (seen[i] || !adj[i].length) {
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
// 4. Roads over unbuildable ground -> removed, or bridges
// ------------------------------------------------------------
//
// Every road node is on buildable land, but the straight road
// between two of them can still pass over a river, a lake, a
// forest or a cliff. Each such road is either removed or kept:
//
//   - kept, by chance, with probability BRIDGE_KEEP_CHANCE
//   - kept anyway when removing it would cut the network in two
//     (the only road across the river)
//   - removed otherwise
//
// A kept road is then classified by what it crosses:
//
//   - any open water (isWaterAt: sea, river, lake)  -> BRIDGE
//   - only other unbuildable ground (forest, steep, wetland,
//     riverbank buffer, ...)                        -> "off-land"
//     road, drawn dashed; it is not a bridge
//
// The "chance" is a hash of the road's endpoints rather than
// Math.random(), so the same road gets the same answer on every
// rebuild (relaxation and zoom redraw constantly) and bridges do
// not flicker; it changes only when the road itself moves.
// ------------------------------------------------------------

const BRIDGE_KEEP_CHANCE = 0.2;

// Sampling step along a road, in map pixels (the land cover
// mask's own resolution).
const CROSSING_STEP = 0.75;


// What the road p-q passes over: "water" if any of it is open
// water, "land" if it only crosses other unbuildable ground, null
// if it stays on buildable ground the whole way.
function roadCrossingKind(p, q) {

    const length =
        Math.hypot(q.x - p.x, q.y - p.y);

    const steps =
        Math.ceil(length / CROSSING_STEP);

    let kind = null;

    // Endpoints are road nodes, already known to be on land.
    for (let s = 1; s < steps; s++) {

        const t = s / steps;

        const x = p.x + (q.x - p.x) * t;
        const y = p.y + (q.y - p.y) * t;

        if (isLand(x, y)) {
            continue;
        }

        if (isWaterAt(x, y)) {
            return "water";
        }

        kind = "land";
    }

    return kind;
}


// Stable 0..1 value per road, independent of direction.
function roadHash01(p, q) {

    const [a, b] =
        p.x < q.x || (p.x === q.x && p.y <= q.y)
            ? [p, q]
            : [q, p];

    const h =
        Math.sin(
            a.x * 12.9898 + a.y * 78.233 +
            b.x * 39.3468 + b.y * 11.1351
        ) * 43758.5453;

    return h - Math.floor(h);
}


function edgeKeyOf(a, b) {
    return a < b ? `${a},${b}` : `${b},${a}`;
}


// Distance from (x, y) to the closed ring `polygon`.
function distanceToRing(x, y, polygon) {

    let best = Infinity;

    for (let i = 0; i < polygon.length; i++) {

        const a = polygon[i];
        const b = polygon[(i + 1) % polygon.length];

        const dx = b[0] - a[0];
        const dy = b[1] - a[1];

        const t = Math.max(0, Math.min(1,
            ((x - a[0]) * dx + (y - a[1]) * dy) / (dx * dx + dy * dy || 1)
        ));

        best = Math.min(best, Math.hypot(x - a[0] - t * dx, y - a[1] - t * dy));
    }

    return best;
}


// Does the straight road p-q leave the (possibly concave) city?
// Both ends are inside, so this only happens across a notch.
// Roads along the boundary (between two boundary crossings) sit
// exactly on it, so a sample counts as outside only when it is
// more than half a pixel out.
function roadLeavesCity(p, q, polygon) {

    if (!polygon.length) {
        return false;
    }

    const steps =
        Math.max(2, Math.ceil(Math.hypot(q.x - p.x, q.y - p.y) / 2));

    for (let s = 1; s < steps; s++) {

        const t = s / steps;

        const x = p.x + (q.x - p.x) * t;
        const y = p.y + (q.y - p.y) * t;

        if (
            !d3.polygonContains(polygon, [x, y]) &&
            distanceToRing(x, y, polygon) > 0.5
        ) {
            return true;
        }
    }

    return false;
}


function removeUnbuildableCrossings(nodes, edges) {

    const crossing = [];

    // Roads that leave the city are never kept by chance - only
    // when they are the sole link.
    const city =
        cityClosed && boundaryPoints.length >= 3
            ? getBoundaryPolygonPoints(200).map(q => [q.x, q.y])
            : [];

    const outside = new Set();

    edges.forEach(([a, b], i) => {
        if (roadLeavesCity(nodes[a], nodes[b], city)) {
            outside.add(i);
            crossing.push(i);
        } else if (roadCrossingKind(nodes[a], nodes[b])) {
            crossing.push(i);
        }
    });

    const result = {
        edges,
        found: crossing.length - outside.size,
        outside: outside.size,
        outsideRemoved: 0,
        removed: 0,
        keptByChance: 0,
        keptNeeded: 0
    };

    if (!crossing.length) {
        return result;
    }

    const alive = edges.map(() => true);

    const adj = Array.from({ length: nodes.length }, () => []);

    edges.forEach(([a, b], i) => {
        adj[a].push(i);
        adj[b].push(i);
    });

    // Can b still be reached from a without edge `skip`?
    const reachableWithout = (from, to, skip) => {

        const seen = new Uint8Array(nodes.length);
        const stack = [from];
        seen[from] = 1;

        while (stack.length) {

            const v = stack.pop();

            if (v === to) {
                return true;
            }

            for (const ei of adj[v]) {

                if (ei === skip || !alive[ei]) {
                    continue;
                }

                const [x, y] = edges[ei];
                const w = x === v ? y : x;

                if (!seen[w]) {
                    seen[w] = 1;
                    stack.push(w);
                }
            }
        }

        return false;
    };

    const chance = i =>
        roadHash01(nodes[edges[i][0]], nodes[edges[i][1]]);

    // Same stable order on every rebuild.
    crossing.sort((i, j) => chance(i) - chance(j));

    for (const i of crossing) {

        if (!outside.has(i) && chance(i) < BRIDGE_KEEP_CHANCE) {
            result.keptByChance++;
            continue;
        }

        const [a, b] = edges[i];

        if (!reachableWithout(a, b, i)) {
            result.keptNeeded++;
            continue;
        }

        alive[i] = false;

        if (outside.has(i)) {
            result.outsideRemoved++;
        } else {
            result.removed++;
        }
    }

    result.edges = edges.filter((_, i) => alive[i]);

    return result;
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
    // 4. Roads over unbuildable ground (before pruning, so a
    //    dead end left behind by a removal is pruned too)
    // --------------------------------------------------------

    const crossings =
        removeUnbuildableCrossings(nodes, edges);

    edges = crossings.edges;

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

                // Spurs that stay on buildable ground first; one
                // over water is used only to make up the count,
                // and becomes a bridge.
                const facilityNode = nodes[index];

                const dry = [];
                const wet = [];

                for (const target of candidates) {
                    (roadCrossingKind(facilityNode, nodes[target])
                        ? wet
                        : dry
                    ).push(target);
                }

                dry
                    .concat(wet)
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

    // Whatever still crosses unbuildable ground after removal
    // and pruning: a bridge if it crosses water, an off-land road
    // otherwise. Keyed by node pair so the label survives
    // simplification, which only ever drops edges.
    const bridges = new Set();
    const offLand = new Set();

    for (const [a, b] of allEdges) {

        const kind = roadCrossingKind(nodes[a], nodes[b]);

        if (kind === "water") {
            bridges.add(edgeKeyOf(a, b));
        } else if (kind === "land") {
            offLand.add(edgeKeyOf(a, b));
        }
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
        roadNodeCount,
        bridges,
        offLand,
        crossings: {
            found: crossings.found,
            outside: crossings.outside,
            outsideRemoved: crossings.outsideRemoved,
            removed: crossings.removed,
            keptByChance: crossings.keptByChance,
            keptNeeded: crossings.keptNeeded
        }
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
        drawBuildings();
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
        drawBuildings();
        return;
    }

    renderRoadNetwork(net);
}


// Draw whatever edges the network currently holds. Kept apart
// from buildRoadNetwork() so simplification can redraw its
// result without regenerating the graph underneath it.
// Road nodes that still have a road (pruning may strip dead ends).
function roadNodesInUse(net) {

    const used = new Uint8Array(net.nodes.length);

    for (const [a, b] of net.allEdges) {
        used[a] = 1;
        used[b] = 1;
    }

    return net.nodes
        .slice(0, net.roadNodeCount)
        .filter((_, i) => used[i]);
}


// Many dots as ONE path (each dot is two arcs). A <circle> per
// road node made every redraw create and style thousands of
// elements, which slowed the animated simplification.
function dotsPath(points, r) {

    let d = "";

    for (const p of points) {
        d +=
            `M${p.x - r},${p.y}` +
            `a${r},${r} 0 1,0 ${2 * r},0` +
            `a${r},${r} 0 1,0 ${-2 * r},0`;
    }

    return d;
}


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

    // Bridges (over water) and off-land roads (over other
    // unbuildable ground) each get a path of their own, on top.
    let bridgePath = "";
    let offLandPath = "";

    // Once the final network is classified: main roads get their
    // own (wider) paths, and the rest are drawn as smaller roads.
    const classified = !!net.mainRoads;

    let mainPath = "";
    let mainOffLandPath = "";

    const isMain = (a, b) =>
        classified && net.mainRoads.has(edgeKeyOf(a, b));

    const isBridge = (a, b) =>
        net.bridges && net.bridges.has(edgeKeyOf(a, b));

    const isOffLand = (a, b) =>
        net.offLand && net.offLand.has(edgeKeyOf(a, b));

    const segment = (a, b) =>
        `M${net.nodes[a].x},${net.nodes[a].y}` +
        `L${net.nodes[b].x},${net.nodes[b].y}`;

    for (const [a, b] of net.edges) {

        if (isBridge(a, b)) {
            bridgePath += segment(a, b);
        } else if (isMain(a, b)) {
            if (isOffLand(a, b)) {
                mainOffLandPath += segment(a, b);
            } else {
                mainPath += segment(a, b);
            }
        } else if (isOffLand(a, b)) {
            offLandPath += segment(a, b);
        } else {
            d += segment(a, b);
        }
    }

    if (d) {
        group
            .append("path")
            .attr("class", classified ? "urquhart-edge minor" : "urquhart-edge")
            .attr("d", d);
    }

    // Facility spurs, in each facility's own colour.
    if (net.facilityEdges.length) {

        const byColor = new Map();

        for (const [a, b] of net.facilityEdges) {

            if (isBridge(a, b)) {
                bridgePath += segment(a, b);
                continue;
            }

            if (isOffLand(a, b)) {
                offLandPath += segment(a, b);
                continue;
            }

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

    if (offLandPath) {
        group
            .append("path")
            .attr("class", classified ? "road-offland minor" : "road-offland")
            .attr("d", offLandPath);
    }

    if (mainOffLandPath) {
        group
            .append("path")
            .attr("class", "road-main road-offland")
            .attr("d", mainOffLandPath);
    }

    if (mainPath) {
        group
            .append("path")
            .attr("class", "road-main")
            .attr("d", mainPath);
    }

    if (bridgePath) {
        group
            .append("path")
            .attr("class", "road-bridge")
            .attr("d", bridgePath);
    }

    // Ordinary graph nodes.
    const radius =
        Math.max(1.2, 2.5 / zoomScale);

    group
        .append("path")
        .attr("class", "building-point")
        .attr("d", dotsPath(roadNodesInUse(net), radius));

    // Selected road junctions, drawn larger and on top.
    if (net.junctions && junctionToggle.checked) {

        const jr =
            Math.max(2.6, 5 / zoomScale);

        group
            .append("path")
            .attr("class", "road-junction")
            .attr(
                "d",
                dotsPath(
                    net.junctions.junctions
                        .filter(i => i < net.nodes.length)
                        .map(i => net.nodes[i]),
                    jr
                )
            );
    }

    // Buildings are filtered against the roads just drawn; the
    // stats come after so they show this drawing's count.
    drawBuildings();

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
        (net.crossings && net.crossings.found
            ? `\nOver unbuildable ground: ${net.crossings.found} ` +
              `roads, ${net.crossings.removed} removed · ` +
              `${countKeyed(net, net.bridges)} bridges over water · ` +
              `${countKeyed(net, net.offLand)} over other ground ` +
              `(${net.crossings.keptNeeded} kept to stay connected)`
            : "") +
        (net.crossings && net.crossings.outside
            ? `\nLeaving the city: ${net.crossings.outside} roads, ` +
              `${net.crossings.outsideRemoved} removed`
            : "") +
        (net.chains
            ? `\nMain roads: ${net.chains.filter(c => c.main).length}, ` +
              `${metresLabel(d3.sum(net.chains.filter(c => c.main), c => c.length))}` +
              (net.mainRoadInfo
                  ? ` (${(100 * net.mainRoadInfo.share).toFixed(0)}% of length, ` +
                    `auto; ${(100 * net.mainRoadInfo.travelShare).toFixed(0)}% of travel)`
                  : "") +
              ` · smaller roads: ${net.chains.filter(c => !c.main).length} chains`
            : "") +
        (buildingsReady
            ? `\nBuildings: ${shownBuildingCount}`
            : "") +
        (net.quality
            ? `\n${qualityLabel(net.quality)}` +
              (net.qualityStart
                  ? `\n  at start ${qualityLabel(net.qualityStart)}`
                  : "")
            : "") +
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


// How many of the network's current edges are in `keys` (bridges
// or off-land roads; simplification may have removed some).
function countKeyed(net, keys) {

    if (!keys) {
        return 0;
    }

    let n = 0;

    for (const [a, b] of net.allEdges) {
        if (keys.has(edgeKeyOf(a, b))) {
            n++;
        }
    }

    return n;
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
