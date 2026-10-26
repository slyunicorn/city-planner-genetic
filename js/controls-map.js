// js/controls-map.js
// Reset, generate, R/K sliders and sea-level control.
// Plain script: shares the global scope with the other js/ files,
// so load order in index.html matters.

// ============================================================
// RESET
// ============================================================

resetBtn.addEventListener(
    "click",
    () => {

        stopRelaxation();
        stopOptimization();

        relaxBtn.disabled = true;
        placeFacilitiesBtn.disabled = true;
        optimizeBtn.disabled = true;


        for (const layer of FACILITY_LAYERS) {
            layer.points = [];
            layer.metric = null;
            layer.stepScale = 1;
        }

        currentMetric = null;

        updateMetricDisplay();

        facilityVoronoiLayer.selectAll("*").remove();
        facilityPointLayer.selectAll("*").remove();


        invalidateRoadNetwork();

        boundaryPoints = [];

        cityClosed = false;


        cityClipPath.attr(
            "d",
            ""
        );


        voronoiLayer
            .selectAll("*")
            .remove();


        vertexLayer
            .selectAll("*")
            .remove();


        boundaryLayer
            .selectAll("*")
            .remove();


        zoomScale = 1;

        centerWorld();


        logStep("Reset — boundary cleared, regenerating points.");


        // Regenerate a fresh set of Poisson points rather than
        // reusing the (possibly relaxed/moved) `points` array,
        // so Reset actually restores the original point map.

        generatePoints();
    }
);


// ============================================================
// GENERATE BUTTON
// ============================================================

generateBtn.addEventListener(
    "click",
    () => {

        stopRelaxation();

        generatePoints();
    }
);


// ============================================================
// R SLIDER
// ============================================================

rSlider.addEventListener(
    "input",
    () => {

        R = Number(rSlider.value);

        rValue.textContent = R;
    }
);


// ============================================================
// K SLIDER
// ============================================================

kSlider.addEventListener(
    "input",
    () => {

        K = Number(kSlider.value);

        kValue.textContent = K;
    }
);


// ============================================================
// SEA LEVEL
// ============================================================

seaLevelInput.addEventListener(
    "change",
    () => {

        seaLevelM = Number(seaLevelInput.value) || 0;

        invalidateRoadNetwork();

        renderTerrain();

        if (cityClosed) {

            const before = points.length;

            points =
                points.filter(p => isLand(p.x, p.y));

            const drowned = before - points.length;

            let facDrowned = 0;

            // Blocks are judged after the points are re-filtered.
            const blocks = getBlockCells();

            for (const layer of FACILITY_LAYERS) {

                const n = layer.points.length;

                layer.points =
                    layer.points.filter(p =>
                        isLand(p.x, p.y) &&
                        (!blocks || blocks.isBuildableAt(p.x, p.y))
                    );

                facDrowned += n - layer.points.length;
            }

            if (drowned > 0 || facDrowned > 0) {
                logStep(
                    `Sea level ${seaLevelM} m: removed ${drowned} points` +
                    (facDrowned > 0
                        ? ` and ${facDrowned} facilities.`
                        : ".")
                );
            }

            optimizeBtn.disabled =
                !FACILITY_LAYERS.some(l => l.points.length >= 2);

            draw();
            evaluateMetric();

        } else {

            logStep(`Sea level set to ${seaLevelM} m.`);
        }
    }
);
