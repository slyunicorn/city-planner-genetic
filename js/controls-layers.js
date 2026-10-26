// js/controls-layers.js
// Layer toggles (network, Sobel, Voronoi) and land cover controls.
// Plain script: shares the global scope with the other js/ files,
// so load order in index.html matters.


urquhartToggle.addEventListener(
    "change",
    () => {

        drawUrquhart();

        if (!urquhartToggle.checked) {
            logStep("Building network hidden.");
            return;
        }

        const st = urquhartStats();

        logStep(
            st
                ? `Building network: ${st.buildings} cell corners, ` +
                  `${st.edges} edges, total ` +
                  `${metresLabel(st.totalLength)}.`
                : "Building network: not enough cells yet."
        );
    }
);


buildingsToggle.addEventListener(
    "change",
    () => {

        drawBuildings();

        logStep(
            !buildingsToggle.checked
                ? "Buildings hidden."
                : buildingsReady
                    ? `Buildings shown (${shownBuildingCount}).`
                    : "Buildings appear once Simplify Network has finished."
        );
    }
);


// Pure view switch: a class on the SVG hides every point layer
// (blocks, cell corners, junctions, facilities, boundary vertices)
// so only the edges of the optimised network stay visible. CSS
// does the hiding, so redraws, zoom and optimisation are unaffected.
hidePointsToggle.addEventListener(
    "change",
    () => {

        svg.classed("hide-points", hidePointsToggle.checked);

        logStep(
            hidePointsToggle.checked
                ? "All points hidden; showing the network only."
                : "Points shown."
        );
    }
);


sobelToggle.addEventListener(
    "change",
    () => {

        renderTerrain();

        logStep(
            sobelToggle.checked
                ? `Showing Sobel slope map (white = steep, ` +
                  `max ${(slopeMaxRatio * 100).toFixed(0)}% grade).`
                : "Showing elevation map."
        );
    }
);


voronoiToggle.addEventListener(
    "change",
    () => {

        drawVoronoi();

        logStep(
            voronoiToggle.checked
                ? "Voronoi diagram shown."
                : "Voronoi diagram hidden."
        );
    }
);


// ============================================================
// LAND COVER CONTROLS
// ============================================================

loadLandCoverBtn.addEventListener(
    "click",
    () => loadLandCoverFromControls()
);

maxSlopeInput.addEventListener(
    "change",
    rebuildHabitabilityMask
);

riverBufferInput.addEventListener(
    "change",
    rebuildHabitabilityMask
);

landCoverAllToggle.addEventListener(
    "change",
    () => renderLandCoverOverlay()
);

landCoverFileInput.addEventListener(
    "change",
    () => {
        loadLandCoverFromFiles(landCoverFileInput.files);
        landCoverFileInput.value = "";
    }
);

landCoverToggle.addEventListener(
    "change",
    () => {

        renderLandCoverOverlay();
        renderLandCoverLegend();
        drawLandCoverCells();

        logStep(
            landCoverToggle.checked
                ? "Land cover mask shown."
                : "Land cover mask hidden."
        );
    }
);
