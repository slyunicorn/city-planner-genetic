// js/relaxation.js
// Fake centroid and Lloyd-style relaxation loop.
// Plain script: shares the global scope with the other js/ files,
// so load order in index.html matters.


// ============================================================
// FAKE CENTROID (flatness-weighted, then shifted toward blue)
// ============================================================
//
// Two terrain terms, applied in order:
//
//   1. FLATNESS (Sobel). Instead of averaging the cell's
//      vertices equally, each vertex is weighted by how flat
//      the ground is under it. Vertices on flat land pull the
//      centroid hard; vertices on a steep slope barely pull at
//      all. The centroid therefore drifts onto buildable ground
//      without needing a separate force.
//
//   2. ELEVATION (blueness). The flat-weighted centroid is then
//      shifted along the average blue direction, by an amount
//      proportional to how much bluer the cell's ring is than
//      the centroid's own spot, exactly as before.
//
// Formula, for a cell with vertices v1..vn:
//
//   S(p)  = normalised Sobel slope at p      (0 flat .. 1 steep)
//   t(p)  = normalised elevation at p        (0 low  .. 1 high)
//
//   wi    = (1 - S(vi))^GAMMA + EPSILON      flatness weight
//   C     = SUM(wi * vi) / SUM(wi)           flat-biased centroid
//
//   bi    = 1 - t(vi)                        blueness per vertex
//   bmean = mean(bi)
//   bC    = 1 - t(C)
//   dhat  = normalise( SUM( bi * (vi - C)/|vi - C| ) )
//   r     = mean |vi - C|                    cell radius
//
//   C'    = C + dhat * max(0, bmean - bC) * r * STRENGTH
//
// With GAMMA = 0 the weights collapse to 1 and C is the plain
// mean, i.e. the original behaviour.
// ============================================================

// How sharply flat ground is preferred. 0 = ignore slope,
// 1 = linear, higher = only the flattest vertices matter.
const FLATNESS_GAMMA = 2.0;

// Floor so an all-steep cell still has a defined centroid
// rather than dividing by zero.
const FLATNESS_EPSILON = 0.05;

// How far (in cell radii) a full 1.0 blueness difference moves
// the centroid. Higher = more aggressive elevation seeking.
const COLOR_SHIFT_STRENGTH = 1.5;

function getFakeCentroid(polygon) {

    if (!polygon || polygon.length === 0) {
        return null;
    }

    // --------------------------------------------------------
    // 1. Flatness-weighted centroid
    //    wi = (1 - S(vi))^GAMMA + EPSILON
    //    C  = SUM(wi * vi) / SUM(wi)
    // --------------------------------------------------------

    let sumX = 0;
    let sumY = 0;
    let sumW = 0;

    const useSlope =
        slopeData && FLATNESS_GAMMA > 0;

    for (const vertex of polygon) {

        const weight =
            useSlope
                ? Math.pow(
                      1 - getSlopeAt(vertex[0], vertex[1]),
                      FLATNESS_GAMMA
                  ) + FLATNESS_EPSILON
                : 1;

        sumX += vertex[0] * weight;
        sumY += vertex[1] * weight;

        sumW += weight;
    }

    if (sumW <= 0) {
        return null;
    }

    const centroid = {
        x: sumX / sumW,
        y: sumY / sumW
    };

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
        COLOR_SHIFT_STRENGTH;

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

        const polygon =
            voronoi.cellPolygon(i);

        if (!polygon || polygon.length < 3) {
            continue;
        }

        const centroid =
            getFakeCentroid(polygon);

        if (!centroid) {
            continue;
        }

        const point =
            insidePoints[i];

        point.x =
            point.x +
            (centroid.x - point.x) *
            LERP_AMOUNT;

        point.y =
            point.y +
            (centroid.y - point.y) *
            LERP_AMOUNT;

        point.x =
            Math.max(
                0,
                Math.min(WORLD_WIDTH, point.x)
            );

        point.y =
            Math.max(
                0,
                Math.min(WORLD_HEIGHT, point.y)
            );
    }

    invalidateRoadNetwork();

    drawPoints();
    drawVoronoi();
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
