// js/city-draw.js
// Core drawing: points, closed-city membership, boundary spline, Voronoi extent.
// Plain script: shares the global scope with the other js/ files,
// so load order in index.html matters.

// ============================================================
// DRAW EVERYTHING
// ============================================================

function draw() {

    drawPoints();

    drawBoundary();

    drawVoronoi();

    drawLandCoverCells();

    drawDensitySpots();

    drawUrquhart();

    drawFacilities();

}


// ============================================================
// GET POINTS INSIDE CLOSED CITY BOUNDARY
// ============================================================
//
// This samples points along the ACTUAL rendered boundary path
// (the same `d` string produced by getBoundaryPath(), which
// uses d3's centripetal Catmull-Rom, curveCatmullRomClosed
// .alpha(0.5)) via a detached <path> element's getPointAtLength.
//
// Previously this used a hand-written Catmull-Rom sampler
// (createSplinePoints) with UNIFORM parameterization (alpha 0),
// which is a different curve from the one actually drawn on
// screen. Uniform Catmull-Rom tends to overshoot/bulge outward
// more than centripetal Catmull-Rom around unevenly spaced
// vertices, so the invisible test polygon was consistently
// larger than the visible boundary curve - letting points that
// were outside the drawn curve still test as "inside". Sampling
// the real rendered path guarantees the containment test always
// matches what's drawn, exactly.
// ============================================================

// Last sampling, keyed by the path string itself, so dragging a
// vertex (or any other boundary change) misses the cache by
// construction. Relaxation and the road build ask for this many
// times per frame; building a detached <path> each time is slow.
let boundarySampleCache = null;

function getBoundaryPolygonPoints(samples = 200) {

    if (boundaryPoints.length < 3) {
        return [];
    }

    const pathData =
        getBoundaryPath();

    if (!pathData) {
        return [];
    }

    if (
        boundarySampleCache &&
        boundarySampleCache.pathData === pathData &&
        boundarySampleCache.samples === samples
    ) {
        return boundarySampleCache.points;
    }

    const tempPath =
        document.createElementNS(
            "http://www.w3.org/2000/svg",
            "path"
        );

    tempPath.setAttribute("d", pathData);

    const totalLength =
        tempPath.getTotalLength();

    const result = [];

    for (
        let i = 0;
        i < samples;
        i++
    ) {

        const distance =
            (i / samples) *
            totalLength;

        const point =
            tempPath.getPointAtLength(distance);

        result.push({
            x: point.x,
            y: point.y
        });
    }

    boundarySampleCache = { pathData, samples, points: result };

    return result;
}


// ============================================================
// CLIP A POLYGON TO A CONVEX ONE (Sutherland-Hodgman)
// ============================================================
//
// subject: any simple polygon, e.g. the (possibly concave) city
// boundary. clip: a CONVEX polygon, e.g. one Voronoi cell. Both
// are arrays of [x, y]; a repeated closing vertex is fine.
// Returns subject ∩ clip as [x, y] vertices.
//
// With a concave subject the result can contain zero-width
// "bridges" along a clip edge where the city leaves the cell and
// comes back. They add no area, and they are rare (only cells
// straddling a notch of the boundary).
// ============================================================

function clipPolygonToConvex(subject, clip) {

    const ring = clip.slice();

    if (
        ring.length > 1 &&
        ring[0][0] === ring[ring.length - 1][0] &&
        ring[0][1] === ring[ring.length - 1][1]
    ) {
        ring.pop();
    }

    if (ring.length < 3) {
        return [];
    }

    // Orientation-agnostic "inside": same side as the clip
    // polygon's own winding. d3.polygonArea's sign is the
    // NEGATIVE of the usual shoelace (it is positive for a ring
    // that is counterclockwise on a y-down screen), so a
    // positive d3 area means the interior is where the cross
    // product below is negative.
    const winding =
        d3.polygonArea(ring) >= 0 ? -1 : 1;

    let output = subject;

    for (let i = 0; i < ring.length && output.length; i++) {

        const a = ring[i];
        const b = ring[(i + 1) % ring.length];

        const side = p =>
            winding *
            ((b[0] - a[0]) * (p[1] - a[1]) -
             (b[1] - a[1]) * (p[0] - a[0]));

        const input = output;
        output = [];

        for (let j = 0; j < input.length; j++) {

            const cur = input[j];
            const prev = input[(j + input.length - 1) % input.length];

            const sCur = side(cur);
            const sPrev = side(prev);

            if (sCur >= 0) {

                if (sPrev < 0) {
                    const t = sPrev / (sPrev - sCur);
                    output.push([
                        prev[0] + (cur[0] - prev[0]) * t,
                        prev[1] + (cur[1] - prev[1]) * t
                    ]);
                }

                output.push(cur);

            } else if (sPrev >= 0) {

                const t = sPrev / (sPrev - sCur);
                output.push([
                    prev[0] + (cur[0] - prev[0]) * t,
                    prev[1] + (cur[1] - prev[1]) * t
                ]);
            }
        }
    }

    return output;
}

function getInsideCityPoints() {

    if (!cityClosed || boundaryPoints.length < 3) {
        return points;
    }

    const polygonPoints =
        getBoundaryPolygonPoints(200);

    if (!polygonPoints.length) {
        return points;
    }

    const polygon =
        polygonPoints.map(q => [q.x, q.y]);

    // A point belongs to the city only if it is inside the
    // boundary AND on land. The land test is applied every call
    // rather than once at closing time, because relaxation keeps
    // moving points and one can drift below sea level later.
    return points.filter(p =>
        d3.polygonContains(
            polygon,
            [p.x, p.y]
        ) &&
        isLand(p.x, p.y)
    );
}


// ============================================================
// GET VORONOI EXTENT
// ============================================================
//
// Using the full WORLD_WIDTH x WORLD_HEIGHT as the clip extent
// gives edge cells (once the diagram is limited to points
// inside a small city boundary) huge polygons that stretch out
// to the map's corners/edges. Averaging those far-away vertices
// pulls the "fake centroid" outward, which is why points were
// drifting away from the center instead of toward it. Clipping
// the extent to the boundary's own bounding box (plus a little
// padding) keeps cells - and therefore centroids - close to the
// actual city.
// ============================================================

function getVoronoiExtent() {

    if (cityClosed && boundaryPoints.length >= 3) {

        let minX = Infinity;
        let minY = Infinity;
        let maxX = -Infinity;
        let maxY = -Infinity;

        // The box of the DRAWN curve, not of the clicked vertices:
        // the spline bulges past its vertices (by tens of pixels
        // with only a few clicks), and any city point in a bulge
        // outside the box got no Voronoi cell - so it never
        // relaxed and no road was built around it.
        const curve =
            getBoundaryPolygonPoints(200);

        for (const p of curve.length ? curve : boundaryPoints) {

            minX = Math.min(minX, p.x);
            minY = Math.min(minY, p.y);
            maxX = Math.max(maxX, p.x);
            maxY = Math.max(maxY, p.y);
        }

        const padding = 20;

        return [
            Math.max(0, minX - padding),
            Math.max(0, minY - padding),
            Math.min(WORLD_WIDTH, maxX + padding),
            Math.min(WORLD_HEIGHT, maxY + padding)
        ];
    }

    return [
        0,
        0,
        WORLD_WIDTH,
        WORLD_HEIGHT
    ];
}


// ============================================================
// DRAW POINTS
// ============================================================

function drawPoints() {

    pointLayer.selectAll("*").remove();

    if (!points.length) {
        return;
    }

    // Once city is closed, only show points INSIDE
    // the actual curved city boundary.
    const visiblePoints =
        getInsideCityPoints();

    // Keep dots a constant size on screen.
    const radius =
        Math.max(
            1.5,
            3 / zoomScale
        );

    pointLayer
        .selectAll("circle")
        .data(visiblePoints)
        .join("circle")
        .attr("class", "sample-point")
        .attr("cx", d => d.x)
        .attr("cy", d => d.y)
        .attr("r", radius);
}


// ============================================================
// BOUNDARY PATH
// ============================================================

function getBoundaryPath() {

    if (boundaryPoints.length < 3) {
        return "";
    }


    const line =
        d3.line()
            .x(d => d.x)
            .y(d => d.y)
            .curve(
                d3.curveCatmullRomClosed
                    .alpha(0.5)
            );


    return line(boundaryPoints);
}


// ============================================================
// DRAW BOUNDARY
// ============================================================

function drawBoundary() {

    boundaryLayer.selectAll("*").remove();
    vertexLayer.selectAll("*").remove();


    if (!boundaryPoints.length) {
        cityClipPath.attr("d", "");
        return;
    }


    // --------------------------------------------------------
    // Temporary/open boundary
    // --------------------------------------------------------

    if (!cityClosed) {

        if (boundaryPoints.length >= 2) {

            const line =
                d3.line()
                    .x(d => d.x)
                    .y(d => d.y)
                    .curve(
                        d3.curveCatmullRom
                            .alpha(0.5)
                    );


            boundaryLayer
                .append("path")
                .attr(
                    "class",
                    "city-boundary"
                )
                .attr(
                    "fill",
                    "none"
                )
                .attr(
                    "d",
                    line(boundaryPoints)
                );
        }

    }

    // --------------------------------------------------------
    // Closed city
    // --------------------------------------------------------

    else {

        const path =
            getBoundaryPath();


        boundaryLayer
            .append("path")
            .attr(
                "class",
                "city-boundary"
            )
            .attr(
                "d",
                path
            );


        cityClipPath
            .attr("d", path);
    }


    // --------------------------------------------------------
    // Boundary vertices
    // --------------------------------------------------------

    const vertexRadius =
        Math.max(
            4,
            6 / zoomScale
        );


    vertexLayer
        .selectAll("circle")
        .data(boundaryPoints)
        .join("circle")

        .attr(
            "class",
            "boundary-vertex"
        )

        .attr(
            "cx",
            d => d.x
        )

        .attr(
            "cy",
            d => d.y
        )

        .attr(
            "r",
            vertexRadius
        )

        .call(
            d3.drag()
                .on(
                    "start",
                    function(event) {

                        event.sourceEvent.stopPropagation();
                    }
                )

                .on(
                    "drag",
                    function(event, d) {

                        const p =
                            screenToWorld(
                                event.sourceEvent.clientX,
                                event.sourceEvent.clientY
                            );


                        d.x =
                            Math.max(
                                0,
                                Math.min(
                                    WORLD_WIDTH,
                                    p.x
                                )
                            );


                        d.y =
                            Math.max(
                                0,
                                Math.min(
                                    WORLD_HEIGHT,
                                    p.y
                                )
                            );


                        drawBoundary();


                        if (cityClosed) {
                            drawVoronoi();
                        }
                    }
                )

                // The city changed shape: which points count, the
                // cells, the roads and the facility metric all
                // follow from it. Done once on release rather than
                // on every mouse move.
                .on(
                    "end",
                    function() {

                        if (!cityClosed) {
                            return;
                        }

                        invalidateRoadNetwork();
                        draw();

                        if (currentMetric) {
                            evaluateMetric();
                        }
                    }
                )
        );
}
