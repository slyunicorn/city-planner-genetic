// js/relaxation.js
// Density-driven relaxation of the block points.
// Plain script: shares the global scope with the other js/ files,
// so load order in index.html matters.


// ============================================================
// TARGET DENSITY
// ============================================================
//
// The block points start as plain Poisson-disc (even spacing R).
// Relaxation moves them towards a target density (points per
// area), the product of four parts:
//
//   1. Centre profile. With e = distance to the boundary / the
//      deepest point's distance (0 on the boundary, 1 at the
//      centre):
//
//          E = 1/C + (1 - 1/C) * (1 - (1 - e)^2)
//
//      C = "Centre density" slider. The centre is C times as
//      dense as the edge and density rises all the way in, so
//      blocks are always denser towards the centre.
//   2. Hotspots: sub-centres of extra density.
//
//          H = 1 + HOTSPOT_STRENGTH * SUM_k exp(-d_k^2 / (2 s^2))
//
//      d_k = distance to hotspot k, s = its radius. Hotspots
//      are picked on the flattest buildable ground, away from
//      the edge, the centre and each other (chooseHotspots()).
//   3. Flat ground (Sobel):
//
//          F = sqrt((1 - S)^GAMMA + EPSILON)
//
//      S = normalised Sobel slope (0 = flat = dark on the Sobel
//      map), GAMMA = "Flat-ground pull" (0 ignores slope).
//   4. Buildable ground only: 0 wherever isLand() is false.
//
//          target = E * H * F        (0 outside the city)
//
// Built on a grid (step TARGET_GRID_R * R) over the city and
// cached by boundary, sliders, R and the land / slope data.
// ============================================================

// Floor so an all-steep cell still has a defined centroid.
const FLATNESS_EPSILON = 0.05;

// Samples across a cell, per side (so up to ~SAMPLES^2 inside).
const CENTROID_SAMPLES = 8;

// Target grid step, in units of R.
const TARGET_GRID_R = 0.25;

// Hotspot peak: +150% (2.5x the density around it). Radius and
// spacing are shares of the deepest point's distance; a hotspot
// sits at least HOTSPOT_MIN_DEPTH of that distance in from the
// boundary.
const HOTSPOT_STRENGTH = 1.5;
const HOTSPOT_RADIUS = 0.2;
const HOTSPOT_SEPARATION = 0.6;
const HOTSPOT_MIN_DEPTH = 0.3;

// Spread step (see ONE RELAX ITERATION): point density is
// measured with a Gaussian of KDE_BANDWIDTH_R * R; a point moves
// SPREAD_RATE * h^2 * gradient, at most SPREAD_MAX_STEP_R * R.
// KDE_FLOOR (a share of the average count per cell) keeps the
// log ratio finite where the target is ~0.
const KDE_BANDWIDTH_R = 1.5;
const SPREAD_RATE = 1.0;
const SPREAD_MAX_STEP_R = 0.5;
const KDE_FLOOR = 0.05;

function flatnessGamma() {
    return Number(flatPullSlider.value);
}

function lowGroundStrength() {
    return Number(lowPullSlider.value);
}

function centreDensityRatio() {
    return Math.max(1, Number(centreDensitySlider.value));
}

function hotspotCount() {
    return Number(hotspotSlider.value);
}


// Separable Gaussian blur of a cols x rows grid (zero outside).
function blurGrid(src, cols, rows, sigma) {

    if (sigma < 0.5) {
        return Float32Array.from(src);
    }

    const r = Math.ceil(3 * sigma);
    const kernel = new Float32Array(2 * r + 1);

    let sum = 0;

    for (let k = -r; k <= r; k++) {
        kernel[k + r] = Math.exp(-(k * k) / (2 * sigma * sigma));
        sum += kernel[k + r];
    }

    for (let k = 0; k < kernel.length; k++) {
        kernel[k] /= sum;
    }

    const tmp = new Float32Array(src.length);
    const out = new Float32Array(src.length);

    for (let y = 0; y < rows; y++) {
        for (let x = 0; x < cols; x++) {
            let acc = 0;
            for (let k = Math.max(-r, -x); k <= Math.min(r, cols - 1 - x); k++) {
                acc += src[y * cols + x + k] * kernel[k + r];
            }
            tmp[y * cols + x] = acc;
        }
    }

    for (let y = 0; y < rows; y++) {
        for (let x = 0; x < cols; x++) {
            let acc = 0;
            for (let k = Math.max(-r, -y); k <= Math.min(r, rows - 1 - y); k++) {
                acc += tmp[(y + k) * cols + x] * kernel[k + r];
            }
            out[y * cols + x] = acc;
        }
    }

    return out;
}


let densityTargetCache = null;

function getDensityTarget() {

    if (!cityClosed || boundaryPoints.length < 3 || !WORLD_WIDTH) {
        return null;
    }

    const ratio = centreDensityRatio();
    const spots = hotspotCount();
    const gamma = flatnessGamma();

    const key = [
        getBoundaryPath(), ratio, spots, gamma, R, seaLevelM,
        WORLD_WIDTH, WORLD_HEIGHT
    ].join("|");

    const cached = densityTargetCache;

    if (
        cached &&
        cached.key === key &&
        cached.habMask === habMask &&
        cached.slopeData === slopeData
    ) {
        return cached;
    }

    const ring =
        getBoundaryPolygonPoints(200).map(q => [q.x, q.y]);

    if (ring.length < 3) {
        return null;
    }

    // The grid reaches past the city by the measuring kernel's
    // reach, so blurring loses nothing at the edge.
    const step = Math.max(1, TARGET_GRID_R * R);
    const h = KDE_BANDWIDTH_R * R;
    const pad = 3 * h;

    const xs = ring.map(q => q[0]);
    const ys = ring.map(q => q[1]);

    const x0 = Math.min(...xs) - pad;
    const y0 = Math.min(...ys) - pad;
    const cols = Math.max(1, Math.ceil((Math.max(...xs) + pad - x0) / step));
    const rows = Math.max(1, Math.ceil((Math.max(...ys) + pad - y0) / step));

    const cellX = c => x0 + (c + 0.5) * step;
    const cellY = r => y0 + (r + 0.5) * step;

    const depth = new Float32Array(cols * rows);

    let maxDepth = 0;
    let centre = null;

    for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {

            const x = cellX(c);
            const y = cellY(r);

            if (!d3.polygonContains(ring, [x, y])) {
                continue;
            }

            const d = distanceToRing(x, y, ring);

            depth[r * cols + c] = d;

            if (d > maxDepth) {
                maxDepth = d;
                centre = { x, y };
            }
        }
    }

    if (!centre) {
        return null;
    }

    // Centre profile x flat ground, on buildable ground.
    const useSlope = slopeData && gamma > 0;
    const base = new Float32Array(cols * rows);

    let cellsInside = 0;

    for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {

            const i = r * cols + c;

            if (depth[i] <= 0 || !isLand(cellX(c), cellY(r))) {
                continue;
            }

            const e = depth[i] / maxDepth;

            const E = 1 / ratio + (1 - 1 / ratio) * (1 - (1 - e) * (1 - e));

            const F =
                useSlope
                    ? Math.sqrt(
                        Math.pow(1 - getSlopeAt(cellX(c), cellY(r)), gamma) +
                        FLATNESS_EPSILON
                    )
                    : 1;

            base[i] = E * F;
            cellsInside++;
        }
    }

    const radius = Math.max(2 * R, HOTSPOT_RADIUS * maxDepth);

    const hotspots =
        chooseHotspots({ base, depth, cols, rows, step, cellX, cellY, maxDepth, centre, radius }, spots);

    const value = new Float32Array(cols * rows);

    for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {

            const i = r * cols + c;

            if (!base[i]) {
                continue;
            }

            let H = 1;

            for (const s of hotspots) {
                const dx = cellX(c) - s.x;
                const dy = cellY(r) - s.y;
                H += HOTSPOT_STRENGTH * Math.exp(-(dx * dx + dy * dy) / (2 * radius * radius));
            }

            value[i] = base[i] * H;
        }
    }

    densityTargetCache = {
        key,
        habMask,
        slopeData,
        x0,
        y0,
        step,
        cols,
        rows,
        value,
        cellsInside,
        maxDepth,
        centre,
        hotspots,
        hotspotRadius: radius,
        ratio,
        kdeSigma: h / step,
        // Smoothed target, scaled to a point count (spreadMoves()).
        smooth: null,
        smoothFor: 0,

        // Target at (x, y), nearest grid cell.
        at(x, y) {
            const c = Math.floor((x - x0) / step);
            const r = Math.floor((y - y0) / step);
            if (c < 0 || r < 0 || c >= cols || r >= rows) {
                return 0;
            }
            return value[r * cols + c];
        }
    };

    return densityTargetCache;
}


// Hotspots: the best spots of flat, buildable ground (the centre
// profile x flatness, smoothed over a hotspot's radius so a spot
// is an area, not one flat pixel), at least HOTSPOT_MIN_DEPTH in
// from the boundary and HOTSPOT_SEPARATION from the centre and
// from each other. Fewer than asked when the city has no room.
function chooseHotspots(g, count) {

    if (count <= 0) {
        return [];
    }

    const smooth =
        blurGrid(g.base, g.cols, g.rows, g.radius / g.step);

    const minDepth = HOTSPOT_MIN_DEPTH * g.maxDepth;
    const separation = HOTSPOT_SEPARATION * g.maxDepth;

    const taken = [g.centre];
    const spots = [];

    while (spots.length < count) {

        let best = -1;
        let bestValue = 0;

        for (let r = 0; r < g.rows; r++) {
            for (let c = 0; c < g.cols; c++) {

                const i = r * g.cols + c;

                if (g.depth[i] < minDepth || !g.base[i] || smooth[i] <= bestValue) {
                    continue;
                }

                const x = g.cellX(c);
                const y = g.cellY(r);

                if (taken.some(t => Math.hypot(t.x - x, t.y - y) < separation)) {
                    continue;
                }

                best = i;
                bestValue = smooth[i];
            }
        }

        if (best < 0) {
            break;
        }

        const spot = {
            x: g.cellX(best % g.cols),
            y: g.cellY(Math.floor(best / g.cols))
        };

        spots.push(spot);
        taken.push(spot);
    }

    return spots;
}


// Dashed circles where the hotspots are.
function drawDensitySpots() {

    densityLayer.selectAll("*").remove();

    const target = getDensityTarget();

    if (!target || !target.hotspots.length) {
        return;
    }

    densityLayer
        .selectAll("circle")
        .data(target.hotspots)
        .join("circle")
        .attr("class", "density-spot")
        .attr("cx", s => s.x)
        .attr("cy", s => s.y)
        .attr("r", target.hotspotRadius);
}


// ============================================================
// ONE RELAX ITERATION
// ============================================================
//
// Every point gets two moves, added together:
//
//   a. Spread. The current point density is measured (every
//      point smeared over a Gaussian of KDE_BANDWIDTH_R * R) and
//      compared with the target, smeared the same way and scaled
//      to the same number of points. Each point moves down the
//      gradient of log(current / target): out of spots that are
//      more crowded than their target, into spots with room.
//      This acts across the whole city at once, so the centre-
//      to-edge gradient and the hotspots form within a few dozen
//      iterations; a Lloyd step alone only trades density between
//      neighbours and took hundreds (points pushed off the edge
//      piled up just inside it).
//   b. Settle (weighted Lloyd). LERP_AMOUNT of the way to the
//      cell's centroid, every sample of the cell weighted by
//      target^2 (a weighted Lloyd settles at density ~ weight^
//      (1/2), so this agrees with the target). Keeps blocks
//      evenly spaced locally, and leans each point to the
//      flattest (darkest on the Sobel map) part of its cell.
//      The optional "Low-ground pull" then shifts the centroid
//      towards lower ground.
//
// Cells are clipped to the city first. A move that would leave
// the city or land on unbuildable ground is retried without the
// spread part, and otherwise not made.
// ============================================================

function spreadMoves(insidePoints, T) {

    const n = insidePoints.length;
    const { cols, rows, step, x0, y0 } = T;

    // Target as expected points per cell, smoothed like the
    // measurement. Only changes with the point count.
    if (!T.smooth || T.smoothFor !== n) {

        let sum = 0;

        for (const v of T.value) {
            sum += v;
        }

        const scaled = T.value.map(v => (sum > 0 ? (v * n) / sum : 0));

        T.smooth = blurGrid(scaled, cols, rows, T.kdeSigma);
        T.smoothFor = n;
    }

    const floor = KDE_FLOOR * n / Math.max(1, T.cellsInside);

    // Current density: each point split over its 4 nearest cells.
    const count = new Float32Array(cols * rows);

    for (const p of insidePoints) {

        const fx = (p.x - x0) / step - 0.5;
        const fy = (p.y - y0) / step - 0.5;
        const c = Math.floor(fx);
        const r = Math.floor(fy);
        const tx = fx - c;
        const ty = fy - r;

        for (const [dc, dr, w] of [
            [0, 0, (1 - tx) * (1 - ty)],
            [1, 0, tx * (1 - ty)],
            [0, 1, (1 - tx) * ty],
            [1, 1, tx * ty]
        ]) {
            const cc = c + dc;
            const rr = r + dr;
            if (cc >= 0 && rr >= 0 && cc < cols && rr < rows) {
                count[rr * cols + cc] += w;
            }
        }
    }

    const measured = blurGrid(count, cols, rows, T.kdeSigma);

    const L = new Float32Array(cols * rows);

    for (let i = 0; i < L.length; i++) {
        L[i] = Math.log((measured[i] + floor) / (T.smooth[i] + floor));
    }

    // Bilinear sample of L at grid coordinates (fx, fy).
    const sample = (fx, fy) => {

        const cx = Math.min(cols - 1.001, Math.max(0, fx));
        const cy = Math.min(rows - 1.001, Math.max(0, fy));
        const c = Math.floor(cx);
        const r = Math.floor(cy);
        const tx = cx - c;
        const ty = cy - r;
        const i = r * cols + c;

        return (
            L[i] * (1 - tx) * (1 - ty) +
            L[i + 1] * tx * (1 - ty) +
            L[i + cols] * (1 - tx) * ty +
            L[i + cols + 1] * tx * ty
        );
    };

    const h = T.kdeSigma * step;
    const rate = SPREAD_RATE * h * h;
    const maxStep = SPREAD_MAX_STEP_R * R;

    return insidePoints.map(p => {

        const fx = (p.x - x0) / step - 0.5;
        const fy = (p.y - y0) / step - 0.5;

        // Gradient per pixel (central difference over one cell).
        const gx = (sample(fx + 1, fy) - sample(fx - 1, fy)) / (2 * step);
        const gy = (sample(fx, fy + 1) - sample(fx, fy - 1)) / (2 * step);

        let dx = -rate * gx;
        let dy = -rate * gy;

        const len = Math.hypot(dx, dy);

        if (len > maxStep) {
            dx *= maxStep / len;
            dy *= maxStep / len;
        }

        return { dx, dy };
    });
}


// Centroid of a (clipped) cell, every interior sample weighted by
// target^2, then optionally shifted toward low ground:
//
//     bi    = 1 - t(vi)                  t = normalised height
//     dhat  = normalise( SUM( bi * (vi - C)/|vi - C| ) )
//     C'    = C + dhat * max(0, mean(bi) - (1 - t(C))) * r * STRENGTH
function getFakeCentroid(polygon, target) {

    if (!polygon || polygon.length === 0) {
        return null;
    }

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

            const t = target.at(x, y);
            const weight = t * t;

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

    // Without terrain data there's no height to steer by.
    if (shiftStrength <= 0 || !elevationData) {
        return centroid;
    }

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

    const difference =
        averageBlueness - (1 - getViridisTAt(centroid.x, centroid.y));

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


function relaxPoints() {

    if (!cityClosed || boundaryPoints.length < 3) {
        return;
    }

    const insidePoints =
        getInsideCityPoints();

    if (insidePoints.length < 2) {
        return;
    }

    const target = getDensityTarget();

    if (!target) {
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

    const spread =
        spreadMoves(insidePoints, target);

    // Every move is worked out from the same positions, then
    // applied (insidePoints holds the objects in `points`).
    const moves = [];

    for (let i = 0; i < insidePoints.length; i++) {

        const point = insidePoints[i];

        const cell =
            voronoi.cellPolygon(i);

        let settleX = 0;
        let settleY = 0;

        if (cell && cell.length >= 3) {

            const clipped =
                cityPolygon.length
                    ? clipPolygonToConvex(cityPolygon, cell)
                    : cell;

            const centroid =
                getFakeCentroid(clipped.length >= 3 ? clipped : cell, target);

            if (centroid) {
                settleX = (centroid.x - point.x) * LERP_AMOUNT;
                settleY = (centroid.y - point.y) * LERP_AMOUNT;
            }
        }

        moves.push([
            [point.x + settleX + spread[i].dx, point.y + settleY + spread[i].dy],
            [point.x + settleX, point.y + settleY]
        ]);
    }

    // A block may not relax out of the city or onto ground it
    // could not be built on.
    const allowed = ([x, y]) =>
        x >= 0 && y >= 0 && x <= WORLD_WIDTH && y <= WORLD_HEIGHT &&
        (!cityPolygon.length || d3.polygonContains(cityPolygon, [x, y])) &&
        isLand(x, y);

    moves.forEach((options, i) => {

        const next = options.find(allowed);

        if (next) {
            insidePoints[i].x = next[0];
            insidePoints[i].y = next[1];
        }
    });

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

    const target = getDensityTarget();

    if (!target) {
        return;
    }

    relaxing = true;

    relaxBtn.disabled = true;

    drawDensitySpots();

    const asked = hotspotCount();

    logStep(
        `Relaxation started (${iterations} iterations). Target: ` +
        `centre ${target.ratio}x as dense as the edge, ` +
        `${target.hotspots.length} hotspot` +
        `${target.hotspots.length === 1 ? "" : "s"}` +
        (target.hotspots.length < asked ? ` (of ${asked} asked; no room for more)` : "") +
        `, flat-ground pull ${flatnessGamma()}.`
    );

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
