// js/facilities.js
// Facility placement, drawing, block assignment and max-distance helpers.
// Plain script: shares the global scope with the other js/ files,
// so load order in index.html matters.

// ============================================================
// PLACE FACILITIES
// ============================================================
//
// Each of the three layers gets its own Poisson-disc pass at
// its own spacing, then the same city + land filtering the
// block layer uses.
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

    const summary = [];

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
        layer.points =
            inCity.filter(p => isLand(p.x, p.y));

        layer.drowned =
            inCity.length - layer.points.length;

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
