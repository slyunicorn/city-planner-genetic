// js/facilities.js
// Facility placement, drawing, block assignment and max-distance helpers.
// Plain script: shares the global scope with the other js/ files,
// so load order in index.html matters.

// ============================================================
// BLOCK DENSITY FIELD
// ============================================================
//
// "Density" at a spot = how many block points lie within
// DENSITY_RADIUS_FACTOR * R of it (R = block Poisson spacing).
// The blocks are the city's demand, and relaxation crowds them
// onto flat, low ground, so this is where the city is densest.
//
// A spot counts as high density when its count is at least
// DENSE_FACTOR times what an evenly spread city would give
// there: blocks / cityArea * pi * radius^2. (A percentile over
// the blocks would not work: it is weighted by the blocks, so
// a big sparse suburb drags it down until everything passes.)
// Layers with `denseOnly` (Emergency, Amenity) may only be
// placed or moved onto such spots.
//
// Counting uses a grid of buckets one radius wide, so a lookup
// only scans the 3 x 3 buckets around the spot.
// ============================================================

const DENSITY_RADIUS_FACTOR = 2.5;
const DENSE_FACTOR = 1.0;

function buildDensityField() {

    const blocks =
        getInsideCityPoints();

    // Too few blocks to say where the city is dense.
    if (blocks.length < 10) {
        return null;
    }

    const radius =
        Math.max(1, R * DENSITY_RADIUS_FACTOR);

    const radius2 = radius * radius;

    const cityArea =
        Math.abs(
            d3.polygonArea(
                getBoundaryPolygonPoints(200)
                    .map(q => [q.x, q.y])
            )
        );

    if (!(cityArea > 0)) {
        return null;
    }

    const bucketKey = (bx, by) => by * 65536 + bx;

    const buckets = new Map();

    for (const p of blocks) {

        const key =
            bucketKey(
                Math.floor(p.x / radius),
                Math.floor(p.y / radius)
            );

        if (!buckets.has(key)) {
            buckets.set(key, []);
        }

        buckets.get(key).push(p);
    }

    function densityAt(x, y) {

        const bx = Math.floor(x / radius);
        const by = Math.floor(y / radius);

        let count = 0;

        for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {

                const bucket =
                    buckets.get(bucketKey(bx + dx, by + dy));

                if (!bucket) {
                    continue;
                }

                for (const p of bucket) {

                    const ddx = p.x - x;
                    const ddy = p.y - y;

                    if (ddx * ddx + ddy * ddy <= radius2) {
                        count++;
                    }
                }
            }
        }

        return count;
    }

    const threshold =
        Math.ceil(
            DENSE_FACTOR *
            blocks.length / cityArea *
            Math.PI * radius2
        );

    return {
        radius,
        threshold,
        densityAt,
        isDense: (x, y) => densityAt(x, y) >= threshold
    };
}


// ============================================================
// PLACE FACILITIES
// ============================================================
//
// Each of the three layers gets its own Poisson-disc pass at
// its own spacing, then the same city + land filtering the
// block layer uses. `denseOnly` layers additionally drop sites
// outside the high-density parts of the city.
// ============================================================

function placeFacilities() {

    if (!cityClosed || boundaryPoints.length < 3) {
        return;
    }

    const extent =
        getVoronoiExtent();

    const boxWidth = extent[2] - extent[0];
    const boxHeight = extent[3] - extent[1];

    const cityPolygon =
        getBoundaryPolygonPoints(200)
            .map(q => [q.x, q.y]);

    const density =
        buildDensityField();

    const summary = [];

    let totalSparse = 0;

    for (const layer of FACILITY_LAYERS) {

        const raw =
            poissonDiscSampling(
                boxWidth,
                boxHeight,
                layer.spacing,
                K
            );

        const inCity =
            raw
                .map(p => ({
                    x: p.x + extent[0],
                    y: p.y + extent[1]
                }))
                .filter(p =>
                    d3.polygonContains(
                        cityPolygon,
                        [p.x, p.y]
                    )
                );

        // A facility can no more sit in the ocean than a block.
        const onLand =
            inCity.filter(p => isLand(p.x, p.y));

        layer.drowned =
            inCity.length - onLand.length;

        layer.points =
            layer.denseOnly && density
                ? onLand.filter(p => density.isDense(p.x, p.y))
                : onLand;

        totalSparse += onLand.length - layer.points.length;

        layer.stepScale = 1;

        summary.push(
            `${layer.label} ${layer.points.length}`
        );
    }

    invalidateRoadNetwork();

    drawFacilities();

    evaluateMetric();

    const totalDrowned =
        FACILITY_LAYERS.reduce(
            (n, l) => n + (l.drowned || 0),
            0
        );

    logStep(
        `Placed facilities — ${summary.join(", ")}` +
        (totalDrowned > 0
            ? `; rejected ${totalDrowned} below ${seaLevelM} m.`
            : ".")
    );

    if (density) {
        logStep(
            `Emergency/Amenity limited to high-density blocks ` +
            `(≥ ${density.threshold} blocks within ` +
            `${Math.round(density.radius)} px); ` +
            `rejected ${totalSparse} low-density sites.`
        );
    }

    status.textContent =
        `${totalFacilityCount()} facilities placed across ` +
        `${FACILITY_LAYERS.length} layers. Run epochs to optimize.`;

    optimizeBtn.disabled =
        !FACILITY_LAYERS.some(l => l.points.length >= 2);
}


function totalFacilityCount() {

    return FACILITY_LAYERS.reduce(
        (n, l) => n + l.points.length,
        0
    );
}


// ============================================================
// DRAW FACILITIES
// ============================================================
//
// Per layer, in its own colour:
//   - Voronoi cells   = that layer's service areas
//   - Delaunay edges  = the adjacency graph dual to those
//                       cells, i.e. which facilities are
//                       neighbours. This is the graph the
//                       load-balancing force runs along, and
//                       the natural road network for the
//                       decongestion work.
// ============================================================

function drawFacilities() {

    facilityVoronoiLayer.selectAll("*").remove();
    facilityPointLayer.selectAll("*").remove();

    for (const layer of FACILITY_LAYERS) {

        if (!layer.visible || !layer.points.length) {
            continue;
        }

        const group =
            facilityVoronoiLayer
                .append("g")
                .attr("data-layer", layer.key);

        if (cityClosed) {
            group.attr("clip-path", "url(#cityClip)");
        }

        if (layer.points.length >= 2) {

            const delaunay =
                d3.Delaunay.from(
                    layer.points,
                    d => d.x,
                    d => d.y
                );

            // ------------------------------------------------
            // Delaunay triangulation
            // ------------------------------------------------

            if (layer.showDelaunay) {

                group
                    .append("path")
                    .attr("class", "facility-delaunay")
                    .attr("stroke", layer.color)
                    .attr("d", delaunay.render());
            }

            // ------------------------------------------------
            // Voronoi service areas
            // ------------------------------------------------

            if (layer.showCells) {

                const voronoi =
                    delaunay.voronoi(
                        getVoronoiExtent()
                    );

                for (
                    let i = 0;
                    i < layer.points.length;
                    i++
                ) {

                    const cell =
                        voronoi.cellPolygon(i);

                    if (!cell) {
                        continue;
                    }

                    group
                        .append("path")
                        .attr("class", "facility-cell")
                        .attr("stroke", layer.color)
                        .attr("fill", layer.fill)
                        .attr(
                            "d",
                            "M" +
                            cell
                                .map(p => `${p[0]},${p[1]}`)
                                .join("L") +
                            "Z"
                        );
                }
            }
        }

        // ----------------------------------------------------
        // Facility markers
        // ----------------------------------------------------

        const radius =
            Math.max(3, 6 / zoomScale);

        facilityPointLayer
            .append("g")
            .attr("data-layer", layer.key)
            .selectAll("circle")
            .data(layer.points)
            .join("circle")
            .attr("class", "facility-point")
            .attr("fill", layer.color)
            .attr("cx", d => d.x)
            .attr("cy", d => d.y)
            .attr("r", radius);
    }
}


// ============================================================
// ASSIGN BLOCK POINTS TO FACILITIES
// ============================================================
//
// Every block point belongs to whichever facility of this layer
// is nearest - which is exactly the Voronoi cell it falls in.
// delaunay.find() gives that index directly, so this avoids any
// point-in-polygon work.
// ============================================================

function assignBlocksToFacilities(layerPoints) {

    const blocks =
        getInsideCityPoints();

    const buckets =
        layerPoints.map(() => []);

    if (!layerPoints.length || !blocks.length) {
        return { blocks, buckets };
    }

    const delaunay =
        d3.Delaunay.from(
            layerPoints,
            d => d.x,
            d => d.y
        );

    let hint = 0;

    for (const block of blocks) {

        hint =
            delaunay.find(
                block.x,
                block.y,
                hint
            );

        buckets[hint].push(block);
    }

    return { blocks, buckets };
}


// ============================================================
// MAX DISTANCE BETWEEN ANY TWO POINTS IN A CELL
// ============================================================
//
// The farthest-apart pair always lies on the convex hull, so
// hulling first turns a potentially huge O(n^2) scan into a
// tiny one over just the hull vertices.
// ============================================================

function maxPairwiseDistance(cellPoints) {

    if (cellPoints.length < 2) {
        return 0;
    }

    const coords =
        cellPoints.map(p => [p.x, p.y]);

    const hull =
        coords.length > 3
            ? (d3.polygonHull(coords) || coords)
            : coords;

    let best = 0;

    for (let i = 0; i < hull.length; i++) {

        for (let j = i + 1; j < hull.length; j++) {

            const dx = hull[i][0] - hull[j][0];
            const dy = hull[i][1] - hull[j][1];

            const dist = Math.hypot(dx, dy);

            if (dist > best) {
                best = dist;
            }
        }
    }

    return best;
}
