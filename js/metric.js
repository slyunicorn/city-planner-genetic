// js/metric.js
// Facility score metric, optimization epochs and run loop.
// Plain script: shares the global scope with the other js/ files,
// so load order in index.html matters.

// ============================================================
// METRIC
// ============================================================
//
// Measured per facility cell, per layer:
//
//   load   - how many block points fall inside this facility's
//            service area
//   spread - the max distance between any two of those points
//
// A good plan wants loads even across facilities and spreads
// small. Each becomes a 0..1 sub-score:
//
//   loadScore   = 1 / (1 + CV(loads))
//   spreadScore = 1 / (1 + meanSpread / cityDiagonal)
//   score       = 100 * (0.5*loadScore + 0.5*spreadScore)
//
// Each layer is scored independently, because a dense shop
// network and a sparse emergency network should not be forced
// to agree. The headline number is the mean across layers that
// have enough facilities to score.
// ============================================================

const LOAD_WEIGHT = 0.5;
const SPREAD_WEIGHT = 0.5;

function computeLayerMetric(layerPoints) {

    if (layerPoints.length < 2) {
        return null;
    }

    const { blocks, buckets } =
        assignBlocksToFacilities(layerPoints);

    if (!blocks.length) {
        return null;
    }

    const loads = buckets.map(b => b.length);
    const spreads = buckets.map(b => maxPairwiseDistance(b));

    const meanLoad = d3.mean(loads) || 0;

    const loadDeviation =
        meanLoad > 0
            ? (d3.deviation(loads) || 0) / meanLoad
            : 0;

    const loadScore = 1 / (1 + loadDeviation);

    const extent = getVoronoiExtent();

    const cityDiagonal =
        Math.hypot(
            extent[2] - extent[0],
            extent[3] - extent[1]
        ) || 1;

    const meanSpread = d3.mean(spreads) || 0;
    const worstSpread = d3.max(spreads) || 0;

    const spreadScore =
        1 / (1 + (meanSpread / cityDiagonal));

    const score =
        100 * (
            LOAD_WEIGHT * loadScore +
            SPREAD_WEIGHT * spreadScore
        );

    return {
        score,
        loadScore,
        spreadScore,
        loads,
        spreads,
        meanLoad,
        loadDeviation,
        meanSpread,
        worstSpread,
        buckets,
        totalBlocks: blocks.length
    };
}


function evaluateMetric() {

    let sum = 0;
    let scored = 0;

    for (const layer of FACILITY_LAYERS) {

        layer.metric =
            computeLayerMetric(layer.points);

        if (layer.metric) {
            sum += layer.metric.score;
            scored++;
        }
    }

    currentMetric =
        scored > 0
            ? { score: sum / scored, layers: scored }
            : null;

    updateMetricDisplay();

    return currentMetric;
}


function updateMetricDisplay() {

    if (!currentMetric) {

        metricScore.textContent = "--";

        metricDetail.textContent =
            "Place facilities to measure.";

        return;
    }

    metricScore.textContent =
        currentMetric.score.toFixed(2);

    const lines = [];

    for (const layer of FACILITY_LAYERS) {

        if (!layer.metric) {

            lines.push(
                `${layer.label}: ${layer.points.length} ` +
                `(need 2+ to score)`
            );

            continue;
        }

        const m = layer.metric;

        lines.push(
            `${layer.label}: ${m.score.toFixed(1)} · ` +
            `${layer.points.length} sites · ` +
            `load ${d3.min(m.loads)}-${d3.max(m.loads)} · ` +
            `spread ${metresLabel(m.meanSpread)}`
        );
    }

    const blocks =
        FACILITY_LAYERS.find(l => l.metric);

    if (blocks) {
        lines.push(`${blocks.metric.totalBlocks} blocks served`);
    }

    metricDetail.textContent = lines.join("\n");
}


// Pixels, or real metres once terrain scale is known.
function metresLabel(px) {

    return metresPerPixel
        ? `${Math.round(px * metresPerPixel)} m`
        : `${Math.round(px)} px`;
}


// ============================================================
// ONE OPTIMIZATION EPOCH
// ============================================================
//
// Moves ONLY facility points. Two forces per facility:
//
//   1. Pull toward the centroid of the blocks it serves, which
//      directly shrinks that cell's spread.
//   2. Push along each Delaunay neighbour by the load
//      difference. An overloaded facility drifts toward its
//      lighter neighbours, shrinking its own territory and
//      growing theirs.
//
// Each layer is accepted or rolled back on its OWN score, so a
// layer that has converged stops moving without freezing the
// others.
// ============================================================

const CENTROID_PULL = 0.5;
const BALANCE_PULL = 0.35;

function runLayerEpoch(layer, cityPolygon, density, blocks) {

    if (layer.points.length < 2) {
        return false;
    }

    const before =
        layer.metric || computeLayerMetric(layer.points);

    if (!before) {
        return false;
    }

    const snapshot =
        layer.points.map(p => ({ x: p.x, y: p.y }));

    const delaunay =
        d3.Delaunay.from(
            layer.points,
            d => d.x,
            d => d.y
        );

    const meanLoad = before.meanLoad || 1;

    for (let i = 0; i < layer.points.length; i++) {

        const facility = layer.points[i];
        const served = before.buckets[i];

        let moveX = 0;
        let moveY = 0;

        // ----------------------------------------------------
        // 1. Pull toward the centroid of served blocks
        // ----------------------------------------------------

        if (served.length) {

            moveX +=
                (d3.mean(served, p => p.x) - facility.x) *
                CENTROID_PULL;

            moveY +=
                (d3.mean(served, p => p.y) - facility.y) *
                CENTROID_PULL;
        }

        // ----------------------------------------------------
        // 2. Load balancing against Delaunay neighbours
        // ----------------------------------------------------

        const myLoad = before.loads[i];

        for (const j of delaunay.neighbors(i)) {

            const neighbor = layer.points[j];

            const loadGap =
                (myLoad - before.loads[j]) / meanLoad;

            if (loadGap === 0) {
                continue;
            }

            const dx = neighbor.x - facility.x;
            const dy = neighbor.y - facility.y;

            const dist = Math.hypot(dx, dy);

            if (dist < 1e-6) {
                continue;
            }

            moveX +=
                (dx / dist) * loadGap * BALANCE_PULL * dist * 0.1;

            moveY +=
                (dy / dist) * loadGap * BALANCE_PULL * dist * 0.1;
        }

        const nextX =
            facility.x + moveX * layer.stepScale;

        const nextY =
            facility.y + moveY * layer.stepScale;

        // Facilities must stay inside the city, on land, inside
        // a buildable block, and (denseOnly layers) inside the
        // high-density parts.
        const insideCity =
            !cityPolygon.length ||
            d3.polygonContains(cityPolygon, [nextX, nextY]);

        const goodBlock =
            !blocks ||
            blocks.isBuildableAt(nextX, nextY);

        const denseEnough =
            !layer.denseOnly ||
            !density ||
            density.isDense(nextX, nextY);

        if (
            insideCity &&
            goodBlock &&
            denseEnough &&
            isLand(nextX, nextY)
        ) {
            facility.x = nextX;
            facility.y = nextY;
        }
    }

    const after =
        computeLayerMetric(layer.points);

    if (!after || after.score < before.score) {

        for (let i = 0; i < layer.points.length; i++) {
            layer.points[i].x = snapshot[i].x;
            layer.points[i].y = snapshot[i].y;
        }

        layer.stepScale *= 0.5;

        return false;
    }

    layer.metric = after;

    layer.stepScale =
        Math.min(2, layer.stepScale * 1.05);

    return true;
}


function runEpoch() {

    const cityPolygon =
        getBoundaryPolygonPoints(200)
            .map(q => [q.x, q.y]);

    // Blocks don't move while optimising, but rebuilding per
    // epoch keeps it right if relaxation ran in between.
    const density =
        buildDensityField();

    const blocks =
        getBlockCells();

    let improvedAny = false;

    for (const layer of FACILITY_LAYERS) {

        if (runLayerEpoch(layer, cityPolygon, density, blocks)) {
            improvedAny = true;
        }
    }

    // Refresh the aggregate from the per-layer metrics.
    let sum = 0;
    let scored = 0;

    for (const layer of FACILITY_LAYERS) {
        if (layer.metric) {
            sum += layer.metric.score;
            scored++;
        }
    }

    currentMetric =
        scored > 0
            ? { score: sum / scored, layers: scored }
            : null;

    updateMetricDisplay();

    return improvedAny;
}


// ============================================================
// RUN OPTIMIZATION OVER EPOCHS
// ============================================================

function startOptimization(epochs) {

    if (optimizing) {
        return;
    }

    if (!FACILITY_LAYERS.some(l => l.points.length >= 2)) {
        return;
    }

    optimizing = true;

    optimizeBtn.disabled = true;

    for (const layer of FACILITY_LAYERS) {
        layer.stepScale = 1;
    }

    const start =
        (currentMetric || evaluateMetric());

    const startScore = start ? start.score : 0;

    logStep(
        `Optimization started (${epochs} epochs, ` +
        `score ${startScore.toFixed(2)}).`
    );

    let epoch = 0;

    function step() {

        if (!optimizing || epoch >= epochs) {

            finish();
            return;
        }

        const improved = runEpoch();

        epoch++;

        invalidateRoadNetwork();

        drawFacilities();

        status.textContent =
            `Epoch ${epoch}/${epochs} · ` +
            `score ${currentMetric.score.toFixed(2)}`;

        if (
            epoch === 1 ||
            epoch % 10 === 0 ||
            epoch === epochs
        ) {
            logStep(
                `Epoch ${epoch}: ` +
                FACILITY_LAYERS
                    .filter(l => l.metric)
                    .map(l =>
                        `${l.label} ${l.metric.score.toFixed(1)}`
                    )
                    .join(", ")
            );
        }

        // Every layer's step size has collapsed - converged.
        const allStalled =
            !improved &&
            FACILITY_LAYERS.every(
                l => l.points.length < 2 || l.stepScale < 0.01
            );

        if (allStalled) {
            finish(true, epoch);
            return;
        }

        requestAnimationFrame(step);
    }

    function finish(converged, atEpoch) {

        optimizing = false;

        optimizeBtn.disabled = false;

        const endScore =
            currentMetric ? currentMetric.score : startScore;

        if (converged) {

            status.textContent =
                `Converged at epoch ${atEpoch} · ` +
                `score ${endScore.toFixed(2)}`;

            logStep(
                `Converged early at epoch ${atEpoch} ` +
                `(score ${endScore.toFixed(2)}).`
            );

        } else {

            status.textContent =
                `Optimization complete. Score ${endScore.toFixed(2)}.`;

            logStep(
                `Optimization finished after ${epoch} epochs: ` +
                `${startScore.toFixed(2)} -> ${endScore.toFixed(2)} ` +
                `(${endScore - startScore >= 0 ? "+" : ""}` +
                `${(endScore - startScore).toFixed(2)}).`
            );
        }
    }

    requestAnimationFrame(step);
}


function stopOptimization() {

    optimizing = false;
}
