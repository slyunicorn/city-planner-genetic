// js/relaxation.js
// Fake centroid and Lloyd-style relaxation loop.
// Plain script: shares the global scope with the other js/ files,
// so load order in index.html matters.


// ============================================================
// FAKE CENTROID (weighted by flatness, then optionally shifted
// toward low ground)
// ============================================================
//
// 1. FLATNESS (Sobel). The cell's centroid is taken over its
//    whole interior, sampled on a small grid, with every sample
//    weighted by how flat the ground under it is:
//
//        S(p)  = normalised Sobel slope at p   (0 flat .. 1 steep;
//                black .. white on the Sobel map)
//        w(p)  = ((1 - S(p))^GAMMA + EPSILON) * rho(p)^2
//                (0 where isLand(p) is false)
//        C     = SUM(w(p) * p) / SUM(w(p))
//
//    So the centroid sits on the darkest (flattest) part of the
//    cell, and repeated relaxation (weighted Lloyd) gathers the
//    points onto flat ground. GAMMA is the "Flat-ground pull"
//    slider: 0 ignores slope, higher only the flattest ground
//    counts.
//
//    rho(p) is the city density profile (poisson.js). Plain Lloyd
//    spreads points evenly and would undo the sparse-at-the-edge
//    layout; a weighted Lloyd gives point density ~ w^(1/2) in
//    2-D, so weighting by rho^2 keeps points ~ rho per area.
//
// 2. ELEVATION (optional, "Low-ground pull" slider, default 0).
//    C is then shifted along the average direction to lower
//    ground, by how much lower the cell's ring is than C:
//
//        bi    = 1 - t(vi)                  t = normalised height
//        dhat  = normalise( SUM( bi * (vi - C)/|vi - C| ) )
//        C'    = C + dhat * max(0, mean(bi) - (1 - t(C))) * r * STRENGTH
//
//    Lower is not the same as flatter (a valley side is low and
//    steep), so this is off unless asked for.
// ============================================================

// Floor so an all-steep cell still has a defined centroid.
const FLATNESS_EPSILON = 0.05;

// Samples across a cell, per side (so up to ~SAMPLES^2 inside).
const CENTROID_SAMPLES = 8;

function flatnessGamma() {
    return Number(flatPullSlider.value);
}

function lowGroundStrength() {
    return Number(lowPullSlider.value);
}

function getFakeCentroid(polygon, density) {

    if (!polygon || polygon.length === 0) {
        return null;
    }

    // --------------------------------------------------------
    // 1. Flatness-weighted centroid over the cell's interior
    // --------------------------------------------------------

    const gamma = flatnessGamma();

    const useSlope = slopeData && gamma > 0;

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;

    for (const [x, y] of polygon) {
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
    }

    const step =
        Math.max(0.75, Math.max(maxX - minX, maxY - minY) / CENTROID_SAMPLES);

    let sumX = 0;
    let sumY = 0;
    let sumW = 0;

    for (let y = minY + step / 2; y < maxY; y += step) {
        for (let x = minX + step / 2; x < maxX; x += step) {

            // Ground the block could never use (water, forest,
            // too steep for land cover, ...) carries no weight;
            // otherwise its pull piles points up on its edge,
            // where the move into it is refused.
            if (!d3.polygonContains(polygon, [x, y]) || !isLand(x, y)) {
                continue;
            }

            const flat =
                useSlope
                    ? Math.pow(1 - getSlopeAt(x, y), gamma) + FLATNESS_EPSILON
                    : 1;

            const rho =
                density ? Math.max(POISSON_DENSITY_CUTOFF, density.at(x, y)) : 1;

            const weight = flat * rho * rho;

            sumX += x * weight;
            sumY += y * weight;
            sumW += weight;
        }
    }

    // A sliver too thin for the grid: fall back to its corners.
    if (sumW <= 0) {

        for (const [x, y] of polygon) {
            sumX += x;
            sumY += y;
            sumW += 1;
        }
    }

    const centroid = {
        x: sumX / sumW,
        y: sumY / sumW
    };

    const shiftStrength = lowGroundStrength();

    if (shiftStrength <= 0) {
        return centroid;
    }

    // Without terrain data there's no height to steer by.
    if (!elevationData) {
        return centroid;
    }

    // --------------------------------------------------------
    // 2. Average blue direction + average blueness of vertices
    // --------------------------------------------------------

    let dirX = 0;
    let dirY = 0;

    let sumBlueness = 0;
    let sumDistance = 0;

    for (const vertex of polygon) {

        // 0 = highest ground, 1 = lowest.
        const blueness =
            1 - getViridisTAt(vertex[0], vertex[1]);

        sumBlueness += blueness;

        const dx = vertex[0] - centroid.x;
        const dy = vertex[1] - centroid.y;

        const dist =
            Math.hypot(dx, dy);

        sumDistance += dist;

        if (dist < 1e-6) {
            continue;
        }

        dirX += (dx / dist) * blueness;
        dirY += (dy / dist) * blueness;
    }

    const averageBlueness =
        sumBlueness / polygon.length;

    const cellRadius =
        sumDistance / polygon.length;

    const dirMagnitude =
        Math.hypot(dirX, dirY);

    if (dirMagnitude < 1e-6 || cellRadius < 1e-6) {
        return centroid;
    }

    const centroidBlueness =
        1 - getViridisTAt(centroid.x, centroid.y);

    const difference =
        averageBlueness - centroidBlueness;

    // Already at least as low as its ring - don't drag it.
    if (difference <= 0) {
        return centroid;
    }

    const shift =
        difference *
        cellRadius *
        shiftStrength;

    return {
        x: centroid.x + (dirX / dirMagnitude) * shift,
        y: centroid.y + (dirY / dirMagnitude) * shift
    };
}


// ============================================================
// RELAX POINTS (Lloyd-style, fake centroid, points inside
// the city boundary only)
// ============================================================

function relaxPoints() {

    if (!cityClosed || boundaryPoints.length < 3) {
        return;
    }

    const insidePoints =
        getInsideCityPoints();

    if (insidePoints.length < 2) {
        return;
    }

    const delaunay =
        d3.Delaunay.from(
            insidePoints,
            d => d.x,
            d => d.y
        );

    const voronoi =
        delaunay.voronoi(
            getVoronoiExtent()
        );

    // Cells are clipped to the city before their centroid is
    // taken. Unclipped, an edge cell reaches out to the bounding
    // box (and into any notch of a concave boundary), its
    // centroid lies outside the city, and relaxation walks the
    // point out of the city, where it silently stops counting.
    const cityPolygon =
        getBoundaryPolygonPoints(200)
            .map(q => [q.x, q.y]);

    // The edge density profile, so relaxing keeps blocks sparse
    // near the boundary (null when there is no falloff).
    const field = getCityDensityField();

    const density =
        field && field.falloff > 0 ? field : null;

    // --------------------------------------------------------
    // LERP each point toward its cell's fake centroid. That
    // centroid is already colour-steered - getFakeCentroid()
    // shifts it toward the average blue direction by an amount
    // proportional to how much bluer the cell's ring is than
    // the centroid's own spot - so points in yellow areas get
    // a target pulled far toward blue and move fast, while
    // points already on blue ground get a plain geometric
    // centroid and just even out their spacing.
    // insidePoints holds references to the same objects that
    // live in `points`, so mutating them here updates `points`
    // too.
    // --------------------------------------------------------

    for (let i = 0; i < insidePoints.length; i++) {

        const cell =
            voronoi.cellPolygon(i);

        if (!cell || cell.length < 3) {
            continue;
        }

        const clipped =
            cityPolygon.length
                ? clipPolygonToConvex(cityPolygon, cell)
                : cell;

        const polygon =
            clipped.length >= 3 ? clipped : cell;

        const centroid =
            getFakeCentroid(polygon, density);

        if (!centroid) {
            continue;
        }

        const point =
            insidePoints[i];

        const nextX =
            Math.max(
                0,
                Math.min(
                    WORLD_WIDTH,
                    point.x + (centroid.x - point.x) * LERP_AMOUNT
                )
            );

        const nextY =
            Math.max(
                0,
                Math.min(
                    WORLD_HEIGHT,
                    point.y + (centroid.y - point.y) * LERP_AMOUNT
                )
            );

        // A block may not relax out of the city or onto ground
        // it could not be built on; it stays put instead.
        if (
            (cityPolygon.length &&
                !d3.polygonContains(cityPolygon, [nextX, nextY])) ||
            !isLand(nextX, nextY)
        ) {
            continue;
        }

        point.x = nextX;
        point.y = nextY;
    }

    invalidateRoadNetwork();

    drawPoints();
    drawVoronoi();
    drawLandCoverCells();
    drawUrquhart();
}


// ============================================================
// START / STOP RELAXATION LOOP
// ============================================================

function startRelaxation(iterations = 150) {

    if (relaxing) {
        return;
    }

    if (!cityClosed) {
        return;
    }

    relaxing = true;

    relaxBtn.disabled = true;

    logStep(`Relaxation started (${iterations} iterations).`);

    let iteration = 0;

    function animate() {

        if (!relaxing || iteration >= iterations) {

            relaxing = false;

            relaxBtn.disabled = false;

            status.textContent =
                "Point relaxation complete.";

            logStep(
                `Relaxation complete after ${iteration} iterations.`
            );

            return;
        }

        relaxPoints();

        iteration++;

        status.textContent =
            `Relaxing points... (${iteration}/${iterations})`;

        requestAnimationFrame(animate);
    }

    requestAnimationFrame(animate);
}


function stopRelaxation() {

    relaxing = false;
}
