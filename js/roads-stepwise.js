// js/roads-stepwise.js
// Stepwise (non-animated) simplification runner.
// Plain script: shares the global scope with the other js/ files,
// so load order in index.html matters.

// ============================================================
// STEPWISE SIMPLIFICATION
// ============================================================
//
// Same algorithm as simplifyRoadNetwork(), but broken into
// single steps so it can be driven one frame at a time and
// watched. simplifyRoadNetwork() stays as the synchronous
// version used for testing.
// ============================================================

// Late in a run every allowed removal may hurt Q, so the sigmoid
// says "keep" to nearly all of them and a whole pass can remove
// nothing. The road budget is a hard target, so from the first
// empty pass the run finishes greedily: each step removes the
// allowed road with the highest dQ (the least harmful), until
// the budget is met or nothing may go. SIMPLIFY_MAX_PASSES bounds
// the random phase.
const SIMPLIFY_MAX_PASSES = 40;


// Remove the allowed road (at the visited cells) whose removal
// changes Q the most for the better. Returns its index or -1.
//
// Scoring every road for every removal would cost a full sweep
// each time, so all allowed roads are scored once and the best
// GREEDY_BATCH are taken in that order (each re-checked against
// the hard rules) before scoring again.
const GREEDY_BATCH = 10;

function removeBestRoad(graph, junctionSet) {

    const st = qualityStateOf(graph);

    // Recorded on each removal from here on (metrics page).
    st.phase = "greedy";

    let queue = graph.greedyQueue;

    if (!queue || queue.taken >= GREEDY_BATCH || queue.pos >= queue.list.length) {

        const list = [];

        for (let i = 0; i < graph.edges.length; i++) {

            const e = graph.edges[i];

            if (
                !e.alive ||
                (junctionSet && !junctionSet.has(e.a) && !junctionSet.has(e.b)) ||
                !isValidEdgeRemoval(graph, i)
            ) {
                continue;
            }

            list.push([qualityEvaluateRemoval(st, i, false).Q, i]);
        }

        list.sort((x, y) => y[0] - x[0]);

        queue = graph.greedyQueue = { list, pos: 0, taken: 0 };
    }

    while (queue.pos < queue.list.length) {

        const i = queue.list[queue.pos++][1];

        if (graph.edges[i].alive && isValidEdgeRemoval(graph, i)) {
            removeRoad(graph, i);
            queue.taken++;
            return i;
        }
    }

    // Everything in this batch became invalid; rescore once.
    if (queue.taken > 0) {
        graph.greedyQueue = null;
        return removeBestRoad(graph, junctionSet);
    }

    return -1;
}


function createSimplifyRunner(graph, options) {

    const opts = options || {};

    // undefined = the k calibrated on the graph's quality state.
    const k = opts.k;
    const rng = opts.rng || Math.random;
    const maxPasses = opts.maxPasses ?? SIMPLIFY_MAX_PASSES;
    const budget = opts.reduction ?? 0.25;

    const junctionSet =
        opts.junctions ? new Set(opts.junctions) : null;

    let pass = 0;
    let order = [];
    let pointer = 0;
    let removedThisPass = 0;
    let removed = 0;
    let greedy = false;
    let greedyRemoved = 0;
    let done = false;

    function beginPass() {

        order =
            shuffleInPlace(
                graph.nodes
                    .map((_, i) => i)
                    .filter(i => graph.degree[i] >= 2),
                rng
            )
                .sort((a, b) => graph.degree[b] - graph.degree[a])
                .filter(i => !junctionSet || junctionSet.has(i));

        pointer = 0;
        removedThisPass = 0;
        pass++;
    }

    function finish() {
        removed += removedThisPass;
        removedThisPass = 0;
        done = true;
    }

    beginPass();

    return {

        get removed() {
            return removed + removedThisPass;
        },

        get pass() {
            return pass;
        },

        get done() {
            return done;
        },

        // Removals made in the greedy finish.
        get greedyRemoved() {
            return greedyRemoved;
        },

        // One unit of work. Returns true while there is more.
        step() {

            if (done) {
                return false;
            }

            if (calculateNetworkCost(graph) <= 1 - budget) {
                finish();
                return false;
            }

            if (greedy) {

                if (removeBestRoad(graph, junctionSet) < 0) {
                    finish();
                    return false;
                }

                removedThisPass++;
                greedyRemoved++;
                return true;
            }

            if (pointer >= order.length) {

                removed += removedThisPass;

                if (removedThisPass === 0 || pass >= maxPasses) {
                    removedThisPass = 0;
                    greedy = true;
                    return true;
                }

                beginPass();
                return true;
            }

            const cell = order[pointer++];

            if (selectAndRemoveRoad(graph, cell, k, rng) >= 0) {
                removedThisPass++;
            }

            return true;
        }
    };
}


function simplifyRoadNetwork(graph, options) {

    const opts = options || {};

    // undefined = the k calibrated on the graph's quality state.
    const k = opts.k;
    const rng = opts.rng || Math.random;
    const maxPasses = opts.maxPasses ?? SIMPLIFY_MAX_PASSES;

    // Stop once this much of the original road length is gone.
    const budget = opts.reduction ?? 0.25;

    // When junctionsOnly is set, roads are only pruned AT the
    // selected junctions. Everywhere else the network is left
    // alone, so simplification is concentrated where the
    // junction test said the redundancy actually is.
    const junctionSet =
        opts.junctions
            ? new Set(opts.junctions)
            : null;

    removalRejections = {
        disconnect: 0,
        required: 0,
        access: 0,
        accepted: 0
    };

    const st = qualityStateOf(graph);

    if (st.ctx.k == null) {
        calibrateRemovalK(st, opts.sharpness);
    }

    const startCost = calculateNetworkCost(graph);

    let removed = 0;
    let passes = 0;
    let greedyRemoved = 0;

    for (let pass = 0; pass < maxPasses; pass++) {

        passes++;

        // Most-connected cells first: they hold the most
        // redundancy, so that is where simplification pays.
        // Most-connected first, but shuffled within each degree
        // so the sweep order itself is not a hidden bias.
        const order =
            shuffleInPlace(
                graph.nodes
                    .map((_, i) => i)
                    .filter(i => graph.degree[i] >= 2),
                rng
            ).sort(
                (a, b) => graph.degree[b] - graph.degree[a]
            ).filter(
                i => !junctionSet || junctionSet.has(i)
            );

        let removedThisPass = 0;

        for (const cell of order) {

            // Budget spent - stop, even mid-pass.
            if (calculateNetworkCost(graph) <= 1 - budget) {
                break;
            }

            if (selectAndRemoveRoad(graph, cell, k, rng) >= 0) {
                removedThisPass++;
            }
        }

        // Bank this pass's removals BEFORE testing the budget.
        // Breaking first would discard them from the count, so a
        // run that met its budget on pass one reported "removed:
        // 0" while having actually deleted the roads.
        removed += removedThisPass;

        if (calculateNetworkCost(graph) <= 1 - budget) {
            break;
        }

        // An empty pass, or the last one: finish greedily.
        if (removedThisPass === 0 || pass === maxPasses - 1) {

            while (
                calculateNetworkCost(graph) > 1 - budget &&
                removeBestRoad(graph, junctionSet) >= 0
            ) {
                removed++;
                greedyRemoved++;
            }

            break;
        }
    }

    return {
        removed,
        passes,
        greedyRemoved,
        rejections: { ...removalRejections },
        costBefore: startCost,
        costAfter: calculateNetworkCost(graph),
        budget,
        budgetMet: calculateNetworkCost(graph) <= 1 - budget,
        alpha: calculateAlpha(graph),
        beta: calculateBeta(graph),
        gamma: calculateGamma(graph),
        components: countGraphComponents(graph),
        minDegree: minActiveDegree(graph),
        edges: graph.aliveEdges,
        nodes: graph.nodes.length,
        totalLength: graph.totalLength,
        sideDiversity: averageSideDiversity(graph)
    };
}


// ------------------------------------------------------------
// Hook into the app
// ------------------------------------------------------------
