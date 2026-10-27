// js/terrain-load.js
// Map initialisation and Load Terrain from the lat/lon/radius controls.
// Plain script: shares the global scope with the other js/ files,
// so load order in index.html matters.

// ============================================================
// INITIALIZE
// ============================================================
//
// Called once terrain has been fetched and decoded. The world's
// pixel dimensions now come from the decoded elevation grid
// rather than an image's intrinsic size.
// ============================================================

function initialize(width, height) {

    WORLD_WIDTH = width;
    WORLD_HEIGHT = height;

    if (!WORLD_WIDTH || !WORLD_HEIGHT) {

        status.textContent =
            "Terrain has no dimensions.";

        logStep("Error: terrain grid is empty.");

        return;
    }


    // --------------------------------------------------------
    // Set world dimensions
    // --------------------------------------------------------

    world.style.width = `${WORLD_WIDTH}px`;
    world.style.height = `${WORLD_HEIGHT}px`;


    // --------------------------------------------------------
    // Size the map canvas
    // --------------------------------------------------------

    mapElement.style.width = `${WORLD_WIDTH}px`;
    mapElement.style.height = `${WORLD_HEIGHT}px`;


    // --------------------------------------------------------
    // Size SVG
    // --------------------------------------------------------

    svg
        .attr("width", WORLD_WIDTH)
        .attr("height", WORLD_HEIGHT)
        .attr(
            "viewBox",
            `0 0 ${WORLD_WIDTH} ${WORLD_HEIGHT}`
        );


    // --------------------------------------------------------
    // Center map
    // --------------------------------------------------------

    zoomScale = 1;

    centerWorld();


    // --------------------------------------------------------
    // Generate points
    // --------------------------------------------------------

    generatePoints();


    status.textContent =
        "Click points around the map to create the city boundary.";
}


// ============================================================
// LOAD TERRAIN FROM CONTROLS
// ============================================================

async function loadTerrainFromControls() {

    const lat = Number(latInput.value);
    const lon = Number(lonInput.value);
    const distM = Number(distInput.value);
    const size = Number(sizeSelect.value);

    seaLevelM = Number(seaLevelInput.value) || 0;

    if (
        !Number.isFinite(lat) || lat < -85 || lat > 85 ||
        !Number.isFinite(lon) || lon < -180 || lon > 180
    ) {
        status.textContent =
            "Enter a latitude of -85..85 and a longitude of -180..180.";
        return;
    }

    if (!Number.isFinite(distM) || distM < 100) {
        status.textContent =
            "Radius must be at least 100 m.";
        return;
    }


    loadTerrainBtn.disabled = true;

    // A new map invalidates everything built on the old one.
    stopRelaxation();
    stopOptimization();

    invalidateRoadNetwork();

    boundaryPoints = [];
    cityClosed = false;

    for (const layer of FACILITY_LAYERS) {
        layer.points = [];
        layer.metric = null;
        layer.stepScale = 1;
    }

    currentMetric = null;

    // A new area invalidates any land cover already fetched for
    // the old one, including a fetch still running in the background.
    landCoverRequestId++;
    loadLandCoverBtn.disabled = false;
    habMask = null;
    landCoverEquirectCache = null;
    landCoverNote.textContent = "Not loaded yet.";
    renderLandCoverOverlay();
    renderLandCoverLegend();

    cityClipPath.attr("d", "");
    voronoiLayer.selectAll("*").remove();
    landCoverCellLayer.selectAll("*").remove();
    densityLayer.selectAll("*").remove();
    boundaryLayer.selectAll("*").remove();
    vertexLayer.selectAll("*").remove();
    facilityVoronoiLayer.selectAll("*").remove();
    facilityPointLayer.selectAll("*").remove();

    relaxBtn.disabled = true;
    placeFacilitiesBtn.disabled = true;
    optimizeBtn.disabled = true;

    updateMetricDisplay();


    try {

        const grid =
            await loadTerrain(lat, lon, distM, size);

        renderTerrain();

        initialize(grid.width, grid.height);

        let water = 0;

        for (let i = 0; i < elevationData.length; i++) {

            const m =
                elevationMinM +
                elevationData[i] *
                (elevationMaxM - elevationMinM);

            if (m < seaLevelM) {
                water++;
            }
        }

        const waterPct =
            (100 * water / elevationData.length).toFixed(1);

        scaleNote.textContent =
            `${metresPerPixel.toFixed(1)} m/px · ` +
            `${elevationMinM.toFixed(0)}–${elevationMaxM.toFixed(0)} m · ` +
            `${waterPct}% below ${seaLevelM} m`;

        // Land cover is fetched right after terrain, in the
        // background: its sources can take minutes to time out,
        // and Load Terrain must not stay locked meanwhile.
        loadLandCoverFromControls();

    } catch (err) {

        status.textContent = err.message;

        logStep(`Terrain load failed: ${err.message}`);

        console.error(err);

    } finally {

        loadTerrainBtn.disabled = false;
    }
}


loadTerrainBtn.addEventListener(
    "click",
    loadTerrainFromControls
);

// Enter in any location field loads too, so the button does not
// have to be in view.
for (const id of ["latInput", "lonInput", "distInput"]) {

    document.getElementById(id)?.addEventListener("keydown", e => {

        if (e.key === "Enter" && !loadTerrainBtn.disabled) {
            loadTerrainFromControls();
        }
    });
}
