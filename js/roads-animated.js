// js/roads-animated.js
// Animated simplification with best-of-N champion selection.
// Plain script: shares the global scope with the other js/ files,
// so load order in index.html matters.

// ============================================================
// ANIMATED SIMPLIFICATION WITH CHAMPION SELECTION
// ============================================================
//
// Runs several independent attempts. Each attempt starts from
// the SAME untouched network and prunes it with fresh random
// draws, so no two attempts follow the same path. After each
// one the result is scored, and the best network so far is
// kept as the champion. A later attempt replaces it only if it
// scores higher.
//
// Because every attempt spends the same road budget, the
// scores differ almost entirely in what was KEPT - redundancy
// and side diversity - so the champion is the layout that
// preserved the most useful structure for the same spend.
//
// Work is spread across frames so the roads visibly disappear
// rather than snapping to the answer.
// ============================================================

let simplifyRun = null;


function stopSimplification() {

    if (simplifyRun) {
        simplifyRun.cancelled = true;
    }
}


function runRoadSimplification() {

    // Second press while running = stop.
    if (simplifyRun && !simplifyRun.cancelled) {
        stopSimplification();
        return;
    }

    if (!urquhartToggle.checked) {
        status.textContent =
            "Enable the Building Network layer first.";
        return;
    }

    const base = buildRoadNetwork();

    if (!base) {
        status.textContent =
            "Close a city boundary first.";
        return;
    }

    const baseEdges =
        base.allEdges.map(([a, b]) => [a, b]);

    const nodes = base.nodes;

    const reduction =
        Number(reductionSlider.value) / 100;

    const k =
        Number(simplifyKSlider.value);

    const attempts =
        Number(attemptsSlider.value);

    const speed =
        Number(speedSlider.value);

    const useJunctions =
        junctionToggle.checked;

    // Junctions are chosen once, from the untouched network, so
    // every attempt prunes at the same places.
    const scratch =
        makeRoadGraph(nodes, baseEdges);

    const picked =
        selectRoadJunctions(scratch, {
            radius: Number(junctionRadiusSlider.value)
        });

    base.junctions = picked;

    logStep(
        `Junctions: ${picked.junctions.length} selected ` +
        `(radius ${picked.radius}, none adjacent).`
    );

    simplifyBtn.textContent = "Stop";

    // Buildings belong to the FINAL network only; hide any from a
    // previous run while this one works.
    buildingsReady = false;

    const run = {
        cancelled: false,
        attempt: 0,
        graph: null,
        runner: null,
        champion: null,
        startEdges: baseEdges.length
    };

    simplifyRun = run;


    function beginAttempt() {

        run.attempt++;

        run.graph = makeRoadGraph(nodes, baseEdges);

        run.runner =
            createSimplifyRunner(run.graph, {
                k,
                reduction,
                junctions: useJunctions ? picked.junctions : null
            });
    }


    function scoreAttempt(graph) {

        return {
            quality: calculateGraphQuality(graph),
            alive: graph.edges.map(e => e.alive),
            removed: run.runner.removed,
            edges: graph.aliveEdges,
            alpha: calculateAlpha(graph),
            beta: calculateBeta(graph),
            gamma: calculateGamma(graph),
            components: countGraphComponents(graph),
            minDegree: Math.min(...graph.degree),
            totalLength: graph.totalLength,
            cost: calculateNetworkCost(graph),
            diversity: averageSideDiversity(graph)
        };
    }


    // Paint whatever the working graph currently holds.
    function paint(graph) {

        const kept =
            graph.edges
                .filter(e => e.alive)
                .map(e => [e.a, e.b]);

        const facilitySet = new Set(
            base.facilityEdges.map(([a, b]) => `${a},${b}`)
        );

        base.allEdges = kept;

        base.edges =
            kept.filter(([a, b]) => !facilitySet.has(`${a},${b}`));

        renderRoadNetwork(base);
    }


    function applyChampion() {

        const champ = run.champion;

        const kept = [];

        baseEdges.forEach(([a, b], i) => {
            if (champ.alive[i]) {
                kept.push([a, b]);
            }
        });

        const facilitySet = new Set(
            base.facilityEdges.map(([a, b]) => `${a},${b}`)
        );

        base.allEdges = kept;

        base.edges =
            kept.filter(([a, b]) => !facilitySet.has(`${a},${b}`));

        base.facilityEdges =
            kept.filter(([a, b]) => facilitySet.has(`${a},${b}`));

        base.roadIndices =
            connectivityIndices(
                base.roadNodeCount,
                base.edges.length,
                countComponents(base.roadNodeCount, base.edges)
            );

        base.fullIndices =
            connectivityIndices(
                nodes.length,
                kept.length,
                champ.components
            );

        base.totalLength = champ.totalLength;

        base.simplified = {
            removed: champ.removed,
            edges: champ.edges,
            alpha: champ.alpha,
            beta: champ.beta,
            gamma: champ.gamma,
            components: champ.components,
            minDegree: champ.minDegree,
            sideDiversity: champ.diversity,
            costBefore: 1,
            costAfter: champ.cost,
            attempt: champ.attempt,
            attempts: run.attempt
        };

        renderRoadNetwork(base);
    }


    function finishAll() {

        if (!run.champion) {

            simplifyRun = null;
            simplifyBtn.textContent = "Simplify Network";

            paint(makeRoadGraph(nodes, baseEdges));

            status.textContent =
                "Nothing could be removed — every road is either " +
                "a cell's only link or a bridge.";

            logStep("Simplification removed nothing.");

            return;
        }

        applyChampion();

        // Final relaxation: straighten the chains, animated.
        const straightenIterations =
            Number(straightenSlider.value);

        if (straightenIterations > 0) {
            beginStraightening(straightenIterations);
            return;
        }

        finalizeNetwork();
    }


    function beginStraightening(iterations) {

        const anchors =
            new Set(picked.junctions);

        const before = chainDeviation(base);

        let i = 0;

        function tick() {

            if (run.cancelled || i >= iterations) {

                logStep(
                    `Straightening: chain deviation ` +
                    `${before.toFixed(2)} → ` +
                    `${chainDeviation(base).toFixed(2)} px ` +
                    `over ${i} iterations.`
                );

                finalizeNetwork();
                return;
            }

            straightenRoadChains(base, 0.25, anchors);

            i++;

            renderRoadNetwork(base);

            status.textContent =
                `Straightening roads ${i}/${iterations}...`;

            requestAnimationFrame(tick);
        }

        requestAnimationFrame(tick);
    }


    // --------------------------------------------------------
    // Final steps, on the chosen and smoothed network:
    //   1. classify roads into main / smaller
    //   2. straighten main roads, turn by turn (animated)
    //   3. relabel bridges, then generate the buildings
    // --------------------------------------------------------

    function finalizeNetwork() {

        const share =
            Number(mainShareSlider.value) / 100;

        const maxTurnDeg =
            Number(mainTurnSlider.value);

        const chains =
            classifyRoads(base, share);

        const main =
            chains.filter(c => c.main);

        logStep(
            `Road classes: ${main.length} main roads ` +
            `(${metresLabel(d3.sum(main, c => c.length))}, ` +
            `longest ${metresLabel(main.length ? main[0].length : 0)}), ` +
            `${chains.length - main.length} smaller roads.`
        );

        if (run.cancelled || maxTurnDeg <= 0 || !main.length) {
            finishBuild();
            return;
        }

        const maxTurn = maxTurnDeg * Math.PI / 180;
        const fixed = mainRoadFixedNodes(base);
        const gentle = gentleMainRoadTurns(base, maxTurn);
        const before = meanTurnDegrees(base, gentle);

        let i = 0;
        let last = { moved: 0, kept: 0 };

        function tick() {

            if (run.cancelled || i >= MAIN_STRAIGHTEN_ITERATIONS) {

                logStep(
                    `Main roads straightened: ${gentle.length} turns ` +
                    `under ${maxTurnDeg}° went from ${before.toFixed(1)}° ` +
                    `to ${meanTurnDegrees(base, gentle).toFixed(1)}° on ` +
                    `average; ${last.kept} sharper turns left as corners.`
                );

                finishBuild();
                return;
            }

            last = straightenMainRoadsStep(base, maxTurn, fixed);

            i++;

            renderRoadNetwork(base);

            status.textContent =
                `Straightening main roads ${i}/${MAIN_STRAIGHTEN_ITERATIONS}...`;

            requestAnimationFrame(tick);
        }

        requestAnimationFrame(tick);
    }


    function finishBuild() {

        reclassifyCrossings(base);

        buildingsReady = true;

        renderRoadNetwork(base);

        logStep(`Buildings: ${shownBuildingCount} placed.`);

        report();
    }


    function report() {

        simplifyRun = null;
        simplifyBtn.textContent = "Simplify Network";

        const c = run.champion;

        const savedPct = 100 * (1 - c.cost);

        status.textContent =
            `Best of ${run.attempt}: −${c.removed} roads ` +
            `(−${savedPct.toFixed(1)}% length) · ` +
            `α ${c.alpha.toFixed(3)} · β ${c.beta.toFixed(3)} · ` +
            `γ ${c.gamma.toFixed(3)}`;

        logStep(
            `Simplification done — attempt ${c.attempt} of ` +
            `${run.attempt} won. ${run.startEdges} → ${c.edges} ` +
            `edges (−${savedPct.toFixed(1)}% length), ` +
            `α ${c.alpha.toFixed(3)}, diversity ` +
            `${c.diversity.toFixed(3)}, min degree ${c.minDegree}, ` +
            `${c.components} component${c.components === 1 ? "" : "s"}.`
        );
    }


    function frame() {

        if (run.cancelled) {
            finishAll();
            return;
        }

        // Advance the current attempt a little.
        for (let i = 0; i < speed; i++) {

            if (!run.runner.step()) {
                break;
            }
        }

        paint(run.graph);

        status.textContent =
            `Attempt ${run.attempt}/${attempts} · ` +
            `−${run.runner.removed} roads` +
            (run.champion
                ? ` · best so far ${run.champion.quality.toFixed(4)} ` +
                  `(attempt ${run.champion.attempt})`
                : "");

        if (run.runner.done) {

            const result = scoreAttempt(run.graph);

            result.attempt = run.attempt;

            // Keep it only if it beats the incumbent.
            const better =
                !run.champion ||
                result.quality > run.champion.quality;

            if (better) {

                run.champion = result;

                logStep(
                    `Attempt ${run.attempt}: quality ` +
                    `${result.quality.toFixed(4)} — new best ` +
                    `(−${result.removed} roads, α ` +
                    `${result.alpha.toFixed(3)}).`
                );

            } else {

                logStep(
                    `Attempt ${run.attempt}: quality ` +
                    `${result.quality.toFixed(4)} — kept ` +
                    `attempt ${run.champion.attempt} instead.`
                );
            }

            if (run.attempt >= attempts) {
                finishAll();
                return;
            }

            beginAttempt();
        }

        requestAnimationFrame(frame);
    }

    beginAttempt();
    requestAnimationFrame(frame);
}
