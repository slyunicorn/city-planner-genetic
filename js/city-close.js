// js/city-close.js
// Closing the city boundary.
// Plain script: shares the global scope with the other js/ files,
// so load order in index.html matters.

// ============================================================
// CLOSE THE CITY
// ============================================================
//
// Called either by clicking near the first boundary vertex or
// by the Close City Boundary button.
// ============================================================

function closeCity() {

    if (cityClosed || boundaryPoints.length < 3) {
        return false;
    }

    cityClosed = true;


    // With an edge falloff the points are generated again inside
    // the city, sparse at the boundary and denser towards the
    // middle (poisson.js, getCityDensityField()).
    const density =
        Number(densityFalloffSlider.value) > 0
            ? regenerateCityPoints()
            : null;

    // Drop every base point that sits below sea level. These are
    // deleted outright, not just hidden, so they stop generating
    // Voronoi cells and stop counting as demand for the metric.
    const beforeCount = density ? density.generated : points.length;

    points =
        points.filter(p => isLand(p.x, p.y));

    const drowned =
        beforeCount - points.length;


    invalidateRoadNetwork();

    drawBoundary();
    drawPoints();
    drawVoronoi();
    drawLandCoverCells();
    drawUrquhart();

    relaxBtn.disabled = false;
    placeFacilitiesBtn.disabled = false;

    status.textContent =
        "City boundary closed. Press \"Relax Points\" to relax.";

    logStep(
        `City boundary closed (${boundaryPoints.length} vertices)` +
        (density
            ? `; ${points.length} points regenerated inside it, ` +
              densityLogText(density)
            : "") +
        (drowned > 0
            ? `; removed ${drowned} points on unbuildable ground.`
            : ".")
    );

    return true;
}


closeBtn.addEventListener(
    "click",
    () => {

        if (cityClosed) {
            status.textContent =
                "City is already closed. Use Reset City to start over.";
            return;
        }

        if (boundaryPoints.length < 3) {
            status.textContent =
                "Click at least 3 points on the map first.";
            return;
        }

        closeCity();
    }
);
