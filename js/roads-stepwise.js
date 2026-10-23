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

function createSimplifyRunner(graph, options) {

    const opts = options || {};

    const k = opts.k ?? DEFAULT_SIGMOID_K;
    const rng = opts.rng || Math.random;
    const maxPasses = opts.maxPasses ?? 12;
    const budget = opts.reduction ?? 0.25;

    const junctionSet =
        opts.junctions ? new Set(opts.junctions) : null;

    let pass = 0;
    let order = [];
    let pointer = 0;
    let removedThisPass = 0;
    let removed = 0;
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

        // One unit of work. Returns true while there is more.
        step() {

            if (done) {
                return false;
            }

            if (calculateNetworkCost(graph) <= 1 - budget) {
                finish();
                return false;
            }

            if (pointer >= order.length) {

                removed += removedThisPass;

                const stalled = removedThisPass === 0;

                if (stalled || pass >= maxPasses) {
                    removedThisPass = 0;
                    done = true;
                    return false;
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

    const k = opts.k ?? DEFAULT_SIGMOID_K;
    const rng = opts.rng || Math.random;
    const maxPasses = opts.maxPasses ?? 12;

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
        degree: 0,
        disconnect: 0,
        accepted: 0
    };

    const startCost = calculateNetworkCost(graph);

    let removed = 0;
    let passes = 0;

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

        // Nothing left that is both safe and worth doing.
        if (removedThisPass === 0) {
            break;
        }
    }

    return {
        removed,
        passes,
        rejections: { ...removalRejections },
        costBefore: startCost,
        costAfter: calculateNetworkCost(graph),
        budget,
        budgetMet: calculateNetworkCost(graph) <= 1 - budget,
        alpha: calculateAlpha(graph),
        beta: calculateBeta(graph),
        gamma: calculateGamma(graph),
        components: countGraphComponents(graph),
        minDegree: Math.min(...graph.degree),
        edges: graph.aliveEdges,
        nodes: graph.nodes.length,
        totalLength: graph.totalLength,
        sideDiversity: averageSideDiversity(graph)
    };
}


// ------------------------------------------------------------
// Hook into the app
// ------------------------------------------------------------
