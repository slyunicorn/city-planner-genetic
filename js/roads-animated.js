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

    const sharpness =
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

    // One quality context for the whole run, so every attempt is
    // scored against the same blocks, OD sample and references.
    const qualityCtx =
        createQualityContext(nodes, baseEdges, {
            blocks: getBlockCells(),
            weights: {
                nc: Number(weightNcSlider.value),
                rs: Number(weightRsSlider.value),
                bb: Number(weightBbSlider.value)
            },
            costWeight: Number(costWeightSlider.value)
        });

    const startState =
        createQualityState(makeRoadGraph(nodes, baseEdges), qualityCtx);

    const calibration =
        calibrateRemovalK(startState, sharpness);

    const k = calibration.k;

    const baseTotalLength =
        startState.graph.baseTotalLength;

    logStep(
        `Start: ${qualityLabel(startState.current)}. ` +
        `k calibrated to ${k.toFixed(0)} ` +
        `(sharpness ${sharpness} ÷ typical |ΔQ| ` +
        `${calibration.typical.toExponential(1)}, ` +
        `${calibration.sampled} removals sampled).`
    );

    base.qualityStart = startState.current;

    // Counted per run, for the metrics page.
    removalRejections = { disconnect: 0, required: 0, access: 0, accepted: 0 };

    metricsFeed.startRun({
        id: Date.now(),
        startedAt: new Date().toISOString(),
        nodes: nodes.length,
        edges: baseEdges.length,
        facilities: base.linkedFacilities,
        metresPerPixel,
        R,
        budget: reduction,
        attemptsPlanned: attempts,
        weights: qualityCtx.weights,
        costWeight: qualityCtx.costWeight,
        sharpness,
        k,
        typicalDQ: calibration.typical,
        junctionsOnly: useJunctions,
        scoreKeys: METRIC_SCORE_KEYS,
        rawKeys: METRIC_RAW_KEYS,
        groupWeights: { nc: NC_WEIGHTS, rs: RS_WEIGHTS, bb: BB_WEIGHTS },
        metrics: qualityMetricDefinitions(qualityCtx),
        start: qualityHistoryPoint(startState.current, null, "start")
    });

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

        const st = createQualityState(run.graph, qualityCtx);

        // One point per removed road, for the metrics page; the
        // first point is the untouched network.
        st.history = [qualityHistoryPoint(st.current, null, "start")];
        st.phase = "random";

        metricsFeed.beginAttempt(run.attempt, st.history);

        run.runner =
            createSimplifyRunner(run.graph, {
                k,
                reduction,
                junctions: useJunctions ? picked.junctions : null
            });
    }


    function scoreAttempt(graph) {

        const score = graph.quality.current;

        return {
            quality: score.Q,
            structural: score.structural,
            score,
            // Attempts are compared at the same road budget: only
            // the structure counts, not who overshot the budget.
            budgetMet: score.cost <= 1 - reduction + 1e-9,
            alive: graph.edges.map(e => e.alive),
            removed: run.runner.removed,
            edges: graph.aliveEdges,
            alpha: calculateAlpha(graph),
            beta: calculateBeta(graph),
            gamma: calculateGamma(graph),
            components: countGraphComponents(graph),
            minDegree: minActiveDegree(graph),
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

        // Safety net for the hard rules: put back the shortest
        // removed roads that reconnect any facility or block that
        // lost its access. The removal rules should make this a
        // no-op.
        const alive = champ.alive.slice();

        const repair =
            repairRequiredAccess(qualityCtx, alive);

        base.repair = repair;

        logStep(
            `Access check: ${repair.facilities} facilities and ` +
            `${repair.blocks} blocks need a road; ` +
            (repair.restored
                ? `${repair.restored} removed roads put back to ` +
                  `reconnect ${repair.repaired}.`
                : "all reachable, nothing to repair.")
        );

        const kept = [];

        baseEdges.forEach(([a, b], i) => {
            if (alive[i]) {
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
                activeNodeCount(base.roadNodeCount, base.edges),
                base.edges.length,
                countComponents(base.roadNodeCount, base.edges)
            );

        base.fullIndices =
            connectivityIndices(
                activeNodeCount(nodes.length, kept),
                kept.length,
                countComponents(nodes.length, kept)
            );

        base.quality = champ.score;

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

            metricsFeed.endRun({ status: "empty" });

            return;
        }

        applyChampion();

        metricsFeed.endRun({
            status: run.cancelled ? "stopped" : "finishing",
            champion: run.champion.attempt,
            rejections: { ...removalRejections },
            repair: base.repair
        });

        // Positions before any straightening, to validate against.
        run.beforeStraighten =
            nodes.map(p => ({ x: p.x, y: p.y, kind: p.kind }));

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

        validateAndRescore();

        reclassifyCrossings(base);

        buildingsReady = true;

        renderRoadNetwork(base);

        logStep(`Buildings: ${shownBuildingCount} placed.`);

        report();
    }


    // Straightening moved points; a moved road may now cross
    // unbuildable ground, leave the city or cross another road.
    // Undo those moves, then score the network before and after
    // straightening on the same scale as the attempts.
    function validateAndRescore() {

        const before = run.beforeStraighten;

        if (!before) {
            return;
        }

        const check = validateStraightenedNetwork(base, before);

        const scoreBefore =
            scoreNetwork(before, base.allEdges, qualityCtx, baseTotalLength);

        const scoreAfter =
            scoreNetwork(nodes, base.allEdges, qualityCtx, baseTotalLength);

        base.quality = scoreAfter;

        metricsFeed.endRun({
            status: run.cancelled ? "stopped" : "done",
            champion: run.champion.attempt,
            beforeStraightening: qualityHistoryPoint(scoreBefore, null, "final"),
            afterStraightening: qualityHistoryPoint(scoreAfter, null, "final"),
            finalCheck: check
        });

        const parts = [];

        if (check.reasons.ground) {
            parts.push(`${check.reasons.ground} over unbuildable ground`);
        }

        if (check.reasons.city) {
            parts.push(`${check.reasons.city} outside the city`);
        }

        if (check.reasons.crossing) {
            parts.push(`${check.reasons.crossing} crossing another road`);
        }

        const components =
            countComponents(nodes.length, base.allEdges);

        logStep(
            `Final check: ` +
            (check.restored
                ? `${check.restored} straightened points put back ` +
                  `(roads ${parts.join(", ")}). `
                : "straightening broke no road. ") +
            `${components === 1 ? "Still one network" : `${components} pieces!`}. ` +
            `Before straightening ${qualityLabel(scoreBefore)}, ` +
            `after ${qualityLabel(scoreAfter)}.`
        );
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

        metricsFeed.progress(run.attempt);

        status.textContent =
            `Attempt ${run.attempt}/${attempts} · ` +
            `−${run.runner.removed} roads` +
            (run.champion
                ? ` · best so far ${run.champion.structural.toFixed(4)} ` +
                  `(attempt ${run.champion.attempt})`
                : "");

        if (run.runner.done) {

            const result = scoreAttempt(run.graph);

            result.attempt = run.attempt;

            metricsFeed.endAttempt(run.attempt, {
                structural: result.structural,
                Q: result.quality,
                nc: result.score.nc,
                rs: result.score.rs,
                bb: result.score.bb,
                cost: result.cost,
                removed: result.removed,
                greedy: run.runner.greedyRemoved,
                passes: run.runner.pass,
                budgetMet: result.budgetMet,
                alpha: result.alpha
            });

            // Keep it only if it beats the incumbent: meeting the
            // road budget first, then structural quality (the cost
            // term is left out, so a network is not preferred just
            // for being a little shorter).
            const champ = run.champion;

            const better =
                !champ ||
                (result.budgetMet && !champ.budgetMet) ||
                (result.budgetMet === champ.budgetMet &&
                    result.structural > champ.structural);

            if (better) {

                run.champion = result;

                logStep(
                    `Attempt ${run.attempt}: structure ` +
                    `${result.structural.toFixed(4)}, ` +
                    `${qualityLabel(result.score)} — new best ` +
                    `(−${result.removed} roads, α ` +
                    `${result.alpha.toFixed(3)}` +
                    `${result.budgetMet ? "" : ", budget NOT met"}).`
                );

            } else {

                logStep(
                    `Attempt ${run.attempt}: structure ` +
                    `${result.structural.toFixed(4)} — kept ` +
                    `attempt ${run.champion.attempt} instead` +
                    `${result.budgetMet ? "" : " (budget not met)"}.`
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
