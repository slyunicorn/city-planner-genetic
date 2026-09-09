// ============================================================
// AI CITY PLANNER
// ============================================================

// ------------------------------------------------------------
// DOM
// ------------------------------------------------------------

const viewport = document.getElementById("viewport");
const world = document.getElementById("world");
const mapElement = document.getElementById("map");
const svg = d3.select("#viz");

const voronoiLayer = d3.select("#voronoiLayer");
const boundaryLayer = d3.select("#boundaryLayer");
const pointLayer = d3.select("#pointLayer");
const facilityVoronoiLayer = d3.select("#facilityVoronoiLayer");
const facilityPointLayer = d3.select("#facilityPointLayer");
const vertexLayer = d3.select("#vertexLayer");

const cityClipPath = d3.select("#cityClipPath");

const rSlider = document.getElementById("rSlider");
const kSlider = document.getElementById("kSlider");

const rValue = document.getElementById("rValue");
const kValue = document.getElementById("kValue");

const generateBtn = document.getElementById("generateBtn");
const closeBtn = document.getElementById("closeBtn");
const resetBtn = document.getElementById("resetBtn");

const relaxIterationsSlider = document.getElementById("relaxIterationsSlider");
const relaxIterationsValue = document.getElementById("relaxIterationsValue");
const relaxBtn = document.getElementById("relaxBtn");

const facilityRSlider = document.getElementById("facilityRSlider");
const facilityRValue = document.getElementById("facilityRValue");
const placeFacilitiesBtn = document.getElementById("placeFacilitiesBtn");

const epochsSlider = document.getElementById("epochsSlider");
const epochsValue = document.getElementById("epochsValue");
const optimizeBtn = document.getElementById("optimizeBtn");

const voronoiToggle = document.getElementById("voronoiToggle");
const facilityToggle = document.getElementById("facilityToggle");

const metricScore = document.getElementById("metricScore");
const metricDetail = document.getElementById("metricDetail");

const status = document.getElementById("status");

const logList = document.getElementById("logList");


// ============================================================
// LOG PANEL
// ============================================================

function logStep(message) {

    const time =
        new Date().toLocaleTimeString(
            [],
            {
                hour: "2-digit",
                minute: "2-digit",
                second: "2-digit"
            }
        );

    const entry =
        document.createElement("div");

    entry.className = "log-entry";

    const timeSpan =
        document.createElement("span");

    timeSpan.className = "log-time";
    timeSpan.textContent = time;

    entry.appendChild(timeSpan);
    entry.appendChild(
        document.createTextNode(message)
    );

    logList.appendChild(entry);

    logList.scrollTop =
        logList.scrollHeight;
}


// ============================================================
// WORLD VARIABLES
// ============================================================

let WORLD_WIDTH = 0;
let WORLD_HEIGHT = 0;

let points = [];

let boundaryPoints = [];

let cityClosed = false;


// ============================================================
// CAMERA
// ============================================================

let zoomScale = 1;

let cameraX = 0;
let cameraY = 0;


// ============================================================
// SETTINGS
// ============================================================

let R = Number(rSlider.value);
let K = Number(kSlider.value);


// ============================================================
// RELAXATION STATE
// ============================================================

let relaxing = false;

const LERP_AMOUNT = 0.2;


// ============================================================
// FACILITY LAYER STATE
// ============================================================
//
// A second, much sparser Poisson-disc point set laid over the
// city. Each of these points is an essential facility (fire
// station, hospital, ...) and gets its own Voronoi cell - the
// area that facility serves. These are the ONLY points moved
// during optimization; the fine-grained block points stay put
// and act as the "demand" the metric is measured against.
// ============================================================

let facilityPoints = [];

let optimizing = false;

// Latest evaluated metric, kept so the UI and the optimizer
// can both read it without recomputing.
let currentMetric = null;

// Adaptive move size for the optimizer. Grows while the score
// keeps improving, shrinks when an epoch makes things worse.
let facilityStepScale = 1;


// ============================================================
// MAP PIXEL SAMPLING (for viridis-weighted relaxation)
// ============================================================
//
// The altitude map is assumed to be colored with a viridis
// colormap (dark blue/purple = low values, yellow = high
// values). To weight relaxation toward blue and away from
// yellow, we read the map's pixels into an offscreen canvas
// once, then for any world (x, y) can look up its color and
// match it against a precomputed viridis lookup table to
// estimate where along the 0-1 viridis gradient that pixel
// sits.
// ============================================================

let mapImageData = null;

const VIRIDIS_STEPS = 256;
let viridisTable = null;

function buildMapImageData() {

    try {

        const canvas =
            document.createElement("canvas");

        canvas.width = WORLD_WIDTH;
        canvas.height = WORLD_HEIGHT;

        const ctx =
            canvas.getContext("2d");

        ctx.drawImage(
            mapElement,
            0,
            0,
            WORLD_WIDTH,
            WORLD_HEIGHT
        );

        mapImageData =
            ctx.getImageData(
                0,
                0,
                WORLD_WIDTH,
                WORLD_HEIGHT
            );

    } catch (err) {

        console.error(
            "Could not read map pixel data " +
            "(likely blocked by CORS):",
            err
        );

        logStep(
            "Warning: couldn't read map pixels for viridis " +
            "weighting (relaxation will be unweighted)."
        );

        mapImageData = null;
    }
}

function buildViridisTable() {

    viridisTable = [];

    for (
        let i = 0;
        i < VIRIDIS_STEPS;
        i++
    ) {

        const t =
            i / (VIRIDIS_STEPS - 1);

        const color =
            d3.rgb(
                d3.interpolateViridis(t)
            );

        viridisTable.push({
            t,
            r: color.r,
            g: color.g,
            b: color.b
        });
    }
}

// Given an RGB color, find the closest match in the viridis
// gradient and return its position (0 = blue/purple end,
// 1 = yellow end).
function nearestViridisT(r, g, b) {

    if (!viridisTable) {
        buildViridisTable();
    }

    let bestT = 0.5;
    let bestDist = Infinity;

    for (const entry of viridisTable) {

        const dr = entry.r - r;
        const dg = entry.g - g;
        const db = entry.b - b;

        const dist =
            dr * dr +
            dg * dg +
            db * db;

        if (dist < bestDist) {
            bestDist = dist;
            bestT = entry.t;
        }
    }

    return bestT;
}

// Returns the viridis position (0 = blue, 1 = yellow) of the
// map pixel under the given world coordinate. Falls back to a
// neutral 0.5 if pixel data isn't available.
function getViridisTAt(x, y) {

    if (!mapImageData) {
        return 0.5;
    }

    const px =
        Math.min(
            WORLD_WIDTH - 1,
            Math.max(0, Math.round(x))
        );

    const py =
        Math.min(
            WORLD_HEIGHT - 1,
            Math.max(0, Math.round(y))
        );

    const index =
        (py * WORLD_WIDTH + px) * 4;

    const data =
        mapImageData.data;

    return nearestViridisT(
        data[index],
        data[index + 1],
        data[index + 2]
    );
}


// ============================================================
// INITIALIZE
// ============================================================

function initialize() {

    // IMPORTANT:
    // This is an HTML <img>, so naturalWidth is reliable.

    WORLD_WIDTH = mapElement.naturalWidth;
    WORLD_HEIGHT = mapElement.naturalHeight;

    if (!WORLD_WIDTH || !WORLD_HEIGHT) {

        status.textContent =
            "Could not determine map dimensions.";

        logStep("Error: could not determine map dimensions.");

        console.error(
            "Map dimensions are invalid:",
            WORLD_WIDTH,
            WORLD_HEIGHT
        );

        return;
    }


    console.log(
        "Map loaded:",
        WORLD_WIDTH,
        "x",
        WORLD_HEIGHT
    );


    // --------------------------------------------------------
    // Set world dimensions
    // --------------------------------------------------------

    world.style.width = `${WORLD_WIDTH}px`;
    world.style.height = `${WORLD_HEIGHT}px`;


    // --------------------------------------------------------
    // Size map
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

    centerWorld();


    // --------------------------------------------------------
    // Read map pixels (for viridis-weighted relaxation)
    // --------------------------------------------------------

    buildMapImageData();


    // --------------------------------------------------------
    // Generate points
    // --------------------------------------------------------

    generatePoints();


    status.textContent =
        "Click points around the map to create the city boundary.";

    logStep(
        `Map loaded (${WORLD_WIDTH}x${WORLD_HEIGHT}).`
    );
}


// ============================================================
// IMAGE LOADING
// ============================================================

if (mapElement.complete) {

    if (mapElement.naturalWidth > 0) {
        initialize();
    } else {
        status.textContent =
            "Map image could not be read.";

        logStep("Error: map image could not be read.");

        console.error(
            "Image element is complete but naturalWidth is 0."
        );
    }

} else {

    mapElement.addEventListener(
        "load",
        initialize,
        { once: true }
    );

    mapElement.addEventListener(
        "error",
        () => {

            status.textContent =
                "Map image failed to load.";

            logStep("Error: map image failed to load.");

            console.error(
                "altitude-map.png failed to load."
            );

        },
        { once: true }
    );
}


// ============================================================
// CAMERA TRANSFORM
// ============================================================

function updateCamera() {

    world.style.transform =
        `matrix(${zoomScale}, 0, 0, ${zoomScale}, ${cameraX}, ${cameraY})`;

}


// ============================================================
// CENTER WORLD
// ============================================================

function centerWorld() {

    const viewportWidth =
        viewport.clientWidth;

    const viewportHeight =
        viewport.clientHeight;


    cameraX =
        (viewportWidth -
            WORLD_WIDTH * zoomScale) / 2;


    cameraY =
        (viewportHeight -
            WORLD_HEIGHT * zoomScale) / 2;


    updateCamera();

}


// ============================================================
// SCREEN -> WORLD
// ============================================================

function screenToWorld(clientX, clientY) {

    const rect =
        viewport.getBoundingClientRect();


    const screenX =
        clientX - rect.left;

    const screenY =
        clientY - rect.top;


    return {

        x:
            (screenX - cameraX) /
            zoomScale,

        y:
            (screenY - cameraY) /
            zoomScale
    };
}


// ============================================================
// WORLD -> SCREEN
// ============================================================

function worldToScreen(x, y) {

    return {

        x: x * zoomScale + cameraX,

        y: y * zoomScale + cameraY
    };
}


// ============================================================
// POISSON DISC SAMPLING
// ============================================================

function poissonDiscSampling(
    width,
    height,
    radius,
    k
) {

    const cellSize =
        radius / Math.sqrt(2);


    const gridWidth =
        Math.ceil(width / cellSize);

    const gridHeight =
        Math.ceil(height / cellSize);


    const grid =
        new Array(gridWidth * gridHeight)
            .fill(null);


    const result = [];
    const active = [];


    function gridIndex(x, y) {

        const gx =
            Math.floor(x / cellSize);

        const gy =
            Math.floor(y / cellSize);


        if (
            gx < 0 ||
            gy < 0 ||
            gx >= gridWidth ||
            gy >= gridHeight
        ) {
            return -1;
        }


        return gy * gridWidth + gx;
    }


    function isValid(candidate) {

        if (
            candidate.x < 0 ||
            candidate.y < 0 ||
            candidate.x >= width ||
            candidate.y >= height
        ) {
            return false;
        }


        const gx =
            Math.floor(candidate.x / cellSize);

        const gy =
            Math.floor(candidate.y / cellSize);


        const searchRadius = 2;


        for (
            let y = gy - searchRadius;
            y <= gy + searchRadius;
            y++
        ) {

            for (
                let x = gx - searchRadius;
                x <= gx + searchRadius;
                x++
            ) {

                if (
                    x < 0 ||
                    y < 0 ||
                    x >= gridWidth ||
                    y >= gridHeight
                ) {
                    continue;
                }


                const neighbor =
                    grid[y * gridWidth + x];


                if (!neighbor) {
                    continue;
                }


                const dx =
                    neighbor.x - candidate.x;

                const dy =
                    neighbor.y - candidate.y;


                if (
                    dx * dx +
                    dy * dy <
                    radius * radius
                ) {

                    return false;
                }
            }
        }


        return true;
    }


    // --------------------------------------------------------
    // First point
    // --------------------------------------------------------

    const firstPoint = {

        x: Math.random() * width,

        y: Math.random() * height
    };


    result.push(firstPoint);
    active.push(firstPoint);


    grid[gridIndex(
        firstPoint.x,
        firstPoint.y
    )] = firstPoint;


    // --------------------------------------------------------
    // Main algorithm
    // --------------------------------------------------------

    while (active.length > 0) {

        const randomIndex =
            Math.floor(
                Math.random() *
                active.length
            );


        const point =
            active[randomIndex];


        let found = false;


        for (
            let attempt = 0;
            attempt < k;
            attempt++
        ) {

            const angle =
                Math.random() *
                Math.PI *
                2;


            const distance =
                radius *
                (1 + Math.random());


            const candidate = {

                x:
                    point.x +
                    Math.cos(angle) *
                    distance,

                y:
                    point.y +
                    Math.sin(angle) *
                    distance
            };


            if (isValid(candidate)) {

                result.push(candidate);
                active.push(candidate);


                grid[gridIndex(
                    candidate.x,
                    candidate.y
                )] = candidate;


                found = true;

                break;
            }
        }


        if (!found) {

            active.splice(
                randomIndex,
                1
            );
        }
    }


    return result;
}


// ============================================================
// GENERATE POINTS
// ============================================================

function generatePoints() {

    if (!WORLD_WIDTH || !WORLD_HEIGHT) {

        console.error(
            "Cannot generate points: world has no dimensions."
        );

        return;
    }


    R = Number(rSlider.value);
    K = Number(kSlider.value);


    rValue.textContent = R;
    kValue.textContent = K;


    status.textContent =
        "Generating points...";


    console.time("Poisson");


    points =
        poissonDiscSampling(
            WORLD_WIDTH,
            WORLD_HEIGHT,
            R,
            K
        );


    console.timeEnd("Poisson");


    console.log(
        `Generated ${points.length} Poisson points`
    );


    draw();


    status.textContent =
        `Generated ${points.length} points. ` +
        `Click around the map to create the city boundary.`;

    logStep(
        `Generated ${points.length} points (R=${R}, K=${K}).`
    );
}


// ============================================================
// DRAW EVERYTHING
// ============================================================

function draw() {

    drawPoints();

    drawBoundary();

    drawVoronoi();

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

function getBoundaryPolygonPoints(samples = 200) {

    if (boundaryPoints.length < 3) {
        return [];
    }

    const pathData =
        getBoundaryPath();

    if (!pathData) {
        return [];
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

    return result;
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

    return points.filter(p =>
        d3.polygonContains(
            polygon,
            [p.x, p.y]
        )
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

        for (const p of boundaryPoints) {

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
        );
}


// ============================================================
// DRAW VORONOI
// ============================================================

function drawVoronoi() {

    voronoiLayer.selectAll("*").remove();


    if (!voronoiToggle.checked) {
        return;
    }


    // --------------------------------------------------------
    // Once the city is closed, the Voronoi diagram is built
    // only from points inside the boundary, so points outside
    // the city no longer influence the cells.
    // --------------------------------------------------------

    const activePoints =
        getInsideCityPoints();


    if (activePoints.length < 2) {
        return;
    }


    const delaunay =
        d3.Delaunay.from(
            activePoints,
            d => d.x,
            d => d.y
        );


    const voronoi =
        delaunay.voronoi(
            getVoronoiExtent()
        );


    const group =
        voronoiLayer
            .append("g");


    if (cityClosed) {

        group.attr(
            "clip-path",
            "url(#cityClip)"
        );
    }


    for (
        let i = 0;
        i < activePoints.length;
        i++
    ) {

        const cell =
            voronoi.cellPolygon(i);


        if (!cell) {
            continue;
        }


        group
            .append("path")
            .attr(
                "class",
                "voronoi-cell"
            )
            .attr(
                "d",
                "M" +
                cell
                    .map(
                        p =>
                            `${p[0]},${p[1]}`
                    )
                    .join("L") +
                "Z"
            );
    }
}


// ============================================================
// FAKE CENTROID (geometric average, then shifted toward blue)
// ============================================================
//
// Starts as the plain average of the cell's vertices, then
// steers that centroid toward color:
//
//   1. Loop the vertices and build an average "blue direction"
//      - each vertex's direction away from the centroid,
//      weighted by how blue that vertex is. Vertices sitting on
//      blue ground pull hard, yellow ones barely pull at all,
//      so the summed direction points wherever the blue is.
//   2. Compare the vertices' average blueness against the
//      blueness at the centroid itself.
//   3. Shift the centroid along the blue direction by an amount
//      proportional to that difference. A centroid stranded in
//      a very yellow spot with blue vertices around it gets a
//      big shift and moves fast; a centroid already as blue as
//      its surroundings gets no shift at all and the plain
//      geometric centroid is returned unchanged.
//
// The shift is measured in units of the cell's own radius, so
// it self-scales with point density instead of needing R.
// ============================================================

// How far (in cell radii) a full 1.0 blueness difference moves
// the centroid. Higher = more aggressive colour seeking.
const COLOR_SHIFT_STRENGTH = 1.5;

function getFakeCentroid(polygon) {

    if (!polygon || polygon.length === 0) {
        return null;
    }

    // --------------------------------------------------------
    // Plain geometric centroid
    // --------------------------------------------------------

    let sumX = 0;
    let sumY = 0;

    for (const vertex of polygon) {

        sumX += vertex[0];
        sumY += vertex[1];
    }

    const centroid = {
        x: sumX / polygon.length,
        y: sumY / polygon.length
    };

    // Without pixel data there's no colour to steer by.
    if (!mapImageData) {
        return centroid;
    }

    // --------------------------------------------------------
    // Average blue direction + average blueness of vertices
    // --------------------------------------------------------

    let dirX = 0;
    let dirY = 0;

    let sumBlueness = 0;
    let sumDistance = 0;

    for (const vertex of polygon) {

        // 0 = fully yellow, 1 = fully blue.
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

        // Direction toward this vertex, weighted by its blue.
        dirX += (dx / dist) * blueness;
        dirY += (dy / dist) * blueness;
    }

    const averageBlueness =
        sumBlueness / polygon.length;

    const cellRadius =
        sumDistance / polygon.length;

    const dirMagnitude =
        Math.hypot(dirX, dirY);

    // Blue spread evenly all around -> no direction to prefer.
    if (dirMagnitude < 1e-6 || cellRadius < 1e-6) {
        return centroid;
    }

    // --------------------------------------------------------
    // How much bluer is the surrounding ring than right here?
    // --------------------------------------------------------

    const centroidBlueness =
        1 - getViridisTAt(centroid.x, centroid.y);

    const difference =
        averageBlueness - centroidBlueness;

    // Centroid is already at least as blue as its ring - the
    // colour shouldn't drag it anywhere.
    if (difference <= 0) {
        return centroid;
    }

    // --------------------------------------------------------
    // Shift proportional to the difference: big difference
    // (centroid stuck in yellow) moves it a lot, small
    // difference nudges it gently.
    // --------------------------------------------------------

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
    // For each point: the fake centroid of its Voronoi cell
    // still applies as the baseline pull (keeps points evenly
    // spaced). On top of that, compare the point's own current
    // color to each of its cell's vertex colors:
    //   - vertex bluer than the point  -> diff positive -> pull
    //     the point toward that vertex
    //   - vertex more yellow than the point -> diff negative ->
    //     push the point away from that vertex
    //   - equal color -> diff is 0 -> that vertex contributes
    //     no color-driven movement at all
    // The size of the step from each vertex scales with how big
    // the color difference is, so a stark blue/yellow contrast
    // moves the point a lot in one iteration, while a subtle
    // difference barely moves it.
    // insidePoints holds references to the same objects that
    // live in `points`, so mutating them here updates `points`
    // too.
    // --------------------------------------------------------

    // Pixels moved per unit of color difference (diff maxes out
    // around +-1, since blueness is 0..1). Tied to point spacing
    // (R) so bigger/sparser point sets get proportionally bigger
    // steps.
    const COLOR_STEP_SCALE =
        Math.max(3, R);

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

        // Blueness (0..1, higher = bluer) of the point's
        // current position, used as the comparison baseline
        // for every vertex in its cell.
        const centerBlueness =
            1 - getViridisTAt(point.x, point.y);

        let colorStepX = 0;
        let colorStepY = 0;

        for (const vertex of polygon) {

            const vertexBlueness =
                1 - getViridisTAt(vertex[0], vertex[1]);

            // Positive: vertex is bluer than the point (pull
            // toward it). Negative: vertex is more yellow
            // (push away from it). Zero: no color influence.
            const diff =
                vertexBlueness - centerBlueness;

            if (diff === 0) {
                continue;
            }

            const dx = vertex[0] - point.x;
            const dy = vertex[1] - point.y;

            const dist =
                Math.hypot(dx, dy);

            if (dist < 1e-6) {
                continue;
            }

            const unitX = dx / dist;
            const unitY = dy / dist;

            colorStepX +=
                diff * COLOR_STEP_SCALE * unitX;

            colorStepY +=
                diff * COLOR_STEP_SCALE * unitY;
        }

        colorStepX /= polygon.length;
        colorStepY /= polygon.length;

        point.x =
            point.x +
            (centroid.x - point.x) *
            LERP_AMOUNT +
            colorStepX;

        point.y =
            point.y +
            (centroid.y - point.y) *
            LERP_AMOUNT +
            colorStepY;

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

    drawPoints();
    drawVoronoi();
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


// ============================================================
// PLACE FACILITIES
// ============================================================
//
// Runs Poisson-disc sampling a second time with a much larger
// radius, restricted to the city's bounding box, then keeps
// only the samples that land inside the city boundary. Each
// surviving sample becomes one essential facility.
// ============================================================

function placeFacilities() {

    if (!cityClosed || boundaryPoints.length < 3) {
        return;
    }

    const extent =
        getVoronoiExtent();

    const boxWidth =
        extent[2] - extent[0];

    const boxHeight =
        extent[3] - extent[1];

    const facilityR =
        Number(facilityRSlider.value);

    // Sample within the city's bounding box, then shift the
    // results back into world coordinates.
    const raw =
        poissonDiscSampling(
            boxWidth,
            boxHeight,
            facilityR,
            K
        );

    const cityPolygon =
        getBoundaryPolygonPoints(200)
            .map(q => [q.x, q.y]);

    facilityPoints =
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

    facilityStepScale = 1;

    drawFacilities();

    evaluateMetric();

    logStep(
        `Placed ${facilityPoints.length} facilities ` +
        `(spacing ${facilityR}).`
    );

    status.textContent =
        `${facilityPoints.length} facilities placed. ` +
        `Run epochs to optimize their positions.`;

    optimizeBtn.disabled =
        facilityPoints.length < 2;
}


// ============================================================
// DRAW FACILITIES
// ============================================================

function drawFacilities() {

    facilityVoronoiLayer.selectAll("*").remove();
    facilityPointLayer.selectAll("*").remove();

    if (!facilityToggle.checked) {
        return;
    }

    if (!facilityPoints.length) {
        return;
    }

    // --------------------------------------------------------
    // Facility service areas (the "bigger" Voronoi diagram),
    // drawn in red and overlaid on the block-level diagram.
    // --------------------------------------------------------

    if (facilityPoints.length >= 2) {

        const delaunay =
            d3.Delaunay.from(
                facilityPoints,
                d => d.x,
                d => d.y
            );

        const voronoi =
            delaunay.voronoi(
                getVoronoiExtent()
            );

        const group =
            facilityVoronoiLayer
                .append("g");

        if (cityClosed) {

            group.attr(
                "clip-path",
                "url(#cityClip)"
            );
        }

        for (
            let i = 0;
            i < facilityPoints.length;
            i++
        ) {

            const cell =
                voronoi.cellPolygon(i);

            if (!cell) {
                continue;
            }

            group
                .append("path")
                .attr(
                    "class",
                    "facility-cell"
                )
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

    // --------------------------------------------------------
    // Facility markers
    // --------------------------------------------------------

    const radius =
        Math.max(3, 6 / zoomScale);

    facilityPointLayer
        .selectAll("circle")
        .data(facilityPoints)
        .join("circle")
        .attr("class", "facility-point")
        .attr("cx", d => d.x)
        .attr("cy", d => d.y)
        .attr("r", radius);
}


// ============================================================
// ASSIGN BLOCK POINTS TO FACILITIES
// ============================================================
//
// Every block point belongs to whichever facility is nearest -
// which is exactly the facility Voronoi cell it falls inside.
// delaunay.find() gives that nearest index directly, so this
// avoids any point-in-polygon work.
// ============================================================

function assignBlocksToFacilities() {

    const blocks =
        getInsideCityPoints();

    const buckets =
        facilityPoints.map(() => []);

    if (!facilityPoints.length || !blocks.length) {
        return { blocks, buckets };
    }

    const delaunay =
        d3.Delaunay.from(
            facilityPoints,
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

            const dist =
                Math.hypot(dx, dy);

            if (dist > best) {
                best = dist;
            }
        }
    }

    return best;
}


// ============================================================
// METRIC
// ============================================================
//
// Two things are measured per facility cell:
//
//   load   - how many block points (smaller polygons) fall
//            inside this facility's larger polygon
//   spread - the max distance between any two of those points,
//            i.e. how far apart the extremes of the service
//            area are
//
// A good city plan wants BOTH:
//   - loads even across facilities, so no single hospital is
//     serving triple the blocks of its neighbour
//   - spreads small, so nowhere in a service area is far from
//     its facility
//
// Each is turned into a 0..1 sub-score and blended into one
// number that goes up as the plan gets better.
// ============================================================

const LOAD_WEIGHT = 0.5;
const SPREAD_WEIGHT = 0.5;

function computeMetric() {

    if (facilityPoints.length < 2) {
        return null;
    }

    const { blocks, buckets } =
        assignBlocksToFacilities();

    if (!blocks.length) {
        return null;
    }

    const loads =
        buckets.map(b => b.length);

    const spreads =
        buckets.map(b => maxPairwiseDistance(b));

    // --------------------------------------------------------
    // Load balance -> coefficient of variation
    // --------------------------------------------------------

    const meanLoad =
        d3.mean(loads) || 0;

    const loadDeviation =
        meanLoad > 0
            ? (d3.deviation(loads) || 0) / meanLoad
            : 0;

    const loadScore =
        1 / (1 + loadDeviation);

    // --------------------------------------------------------
    // Spread, normalized against the city's own diagonal so
    // the score means the same thing on any map size.
    // --------------------------------------------------------

    const extent =
        getVoronoiExtent();

    const cityDiagonal =
        Math.hypot(
            extent[2] - extent[0],
            extent[3] - extent[1]
        ) || 1;

    const meanSpread =
        d3.mean(spreads) || 0;

    const worstSpread =
        d3.max(spreads) || 0;

    const spreadScore =
        1 / (1 + (meanSpread / cityDiagonal));

    // --------------------------------------------------------
    // Combined score (higher is better)
    // --------------------------------------------------------

    const score =
        100 *
        (
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

    currentMetric = computeMetric();

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

    const minLoad =
        d3.min(currentMetric.loads);

    const maxLoad =
        d3.max(currentMetric.loads);

    metricDetail.textContent =
        `${currentMetric.buckets.length} facilities · ` +
        `${currentMetric.totalBlocks} blocks\n` +
        `load ${minLoad}-${maxLoad} ` +
        `(avg ${currentMetric.meanLoad.toFixed(1)})\n` +
        `spread avg ${currentMetric.meanSpread.toFixed(0)}px · ` +
        `worst ${currentMetric.worstSpread.toFixed(0)}px`;
}


// ============================================================
// ONE OPTIMIZATION EPOCH
// ============================================================
//
// Moves ONLY the facility points. Two forces per facility:
//
//   1. Pull toward the centroid of the blocks it serves.
//      This directly shrinks that cell's spread.
//   2. Push/pull along each Delaunay neighbour based on the
//      load difference. An overloaded facility drifts toward
//      its lighter neighbours, which shrinks its own territory
//      and grows theirs - evening the loads out.
//
// The epoch is then accepted only if the metric actually
// improved. If it got worse the move is rolled back and the
// step size is halved, so the score is monotonically
// non-decreasing over epochs.
// ============================================================

const CENTROID_PULL = 0.5;
const BALANCE_PULL = 0.35;

function runEpoch() {

    if (facilityPoints.length < 2) {
        return false;
    }

    const before =
        currentMetric || evaluateMetric();

    if (!before) {
        return false;
    }

    // Snapshot so a bad epoch can be rolled back.
    const snapshot =
        facilityPoints.map(p => ({
            x: p.x,
            y: p.y
        }));

    const delaunay =
        d3.Delaunay.from(
            facilityPoints,
            d => d.x,
            d => d.y
        );

    const cityPolygon =
        getBoundaryPolygonPoints(200)
            .map(q => [q.x, q.y]);

    const meanLoad =
        before.meanLoad || 1;

    for (
        let i = 0;
        i < facilityPoints.length;
        i++
    ) {

        const facility =
            facilityPoints[i];

        const served =
            before.buckets[i];

        let moveX = 0;
        let moveY = 0;

        // ----------------------------------------------------
        // 1. Pull toward the centroid of served blocks
        // ----------------------------------------------------

        if (served.length) {

            const centroidX =
                d3.mean(served, p => p.x);

            const centroidY =
                d3.mean(served, p => p.y);

            moveX +=
                (centroidX - facility.x) *
                CENTROID_PULL;

            moveY +=
                (centroidY - facility.y) *
                CENTROID_PULL;
        }

        // ----------------------------------------------------
        // 2. Load balancing against Delaunay neighbours
        // ----------------------------------------------------

        const myLoad =
            before.loads[i];

        for (const j of delaunay.neighbors(i)) {

            const neighbor =
                facilityPoints[j];

            const loadGap =
                (myLoad - before.loads[j]) /
                meanLoad;

            if (loadGap === 0) {
                continue;
            }

            const dx =
                neighbor.x - facility.x;

            const dy =
                neighbor.y - facility.y;

            const dist =
                Math.hypot(dx, dy);

            if (dist < 1e-6) {
                continue;
            }

            // Overloaded (loadGap > 0) -> drift toward the
            // lighter neighbour, shedding territory to it.
            moveX +=
                (dx / dist) *
                loadGap *
                BALANCE_PULL *
                dist *
                0.1;

            moveY +=
                (dy / dist) *
                loadGap *
                BALANCE_PULL *
                dist *
                0.1;
        }

        const nextX =
            facility.x + moveX * facilityStepScale;

        const nextY =
            facility.y + moveY * facilityStepScale;

        // Facilities must stay inside the city.
        if (
            !cityPolygon.length ||
            d3.polygonContains(
                cityPolygon,
                [nextX, nextY]
            )
        ) {
            facility.x = nextX;
            facility.y = nextY;
        }
    }

    const after =
        computeMetric();

    if (!after || after.score < before.score) {

        // Roll back and take smaller steps next time.
        for (
            let i = 0;
            i < facilityPoints.length;
            i++
        ) {
            facilityPoints[i].x = snapshot[i].x;
            facilityPoints[i].y = snapshot[i].y;
        }

        facilityStepScale *= 0.5;

        return false;
    }

    currentMetric = after;

    facilityStepScale =
        Math.min(2, facilityStepScale * 1.05);

    updateMetricDisplay();

    return true;
}


// ============================================================
// RUN OPTIMIZATION OVER EPOCHS
// ============================================================

function startOptimization(epochs) {

    if (optimizing) {
        return;
    }

    if (facilityPoints.length < 2) {
        return;
    }

    optimizing = true;

    optimizeBtn.disabled = true;

    facilityStepScale = 1;

    const startScore =
        (currentMetric || evaluateMetric()).score;

    logStep(
        `Optimization started (${epochs} epochs, ` +
        `score ${startScore.toFixed(2)}).`
    );

    let epoch = 0;

    function step() {

        if (!optimizing || epoch >= epochs) {

            optimizing = false;

            optimizeBtn.disabled = false;

            const endScore =
                currentMetric
                    ? currentMetric.score
                    : startScore;

            status.textContent =
                `Optimization complete. ` +
                `Score ${endScore.toFixed(2)}.`;

            logStep(
                `Optimization finished after ${epoch} epochs: ` +
                `${startScore.toFixed(2)} -> ${endScore.toFixed(2)} ` +
                `(${(endScore - startScore >= 0 ? "+" : "")}` +
                `${(endScore - startScore).toFixed(2)}).`
            );

            return;
        }

        const improved =
            runEpoch();

        epoch++;

        drawFacilities();

        status.textContent =
            `Epoch ${epoch}/${epochs} · ` +
            `score ${currentMetric.score.toFixed(2)}`;

        // Log periodically rather than every epoch, so the
        // panel stays readable on long runs.
        if (
            epoch === 1 ||
            epoch % 10 === 0 ||
            epoch === epochs
        ) {
            logStep(
                `Epoch ${epoch}: score ` +
                `${currentMetric.score.toFixed(2)} ` +
                `(load ${currentMetric.loadScore.toFixed(3)}, ` +
                `spread ${currentMetric.spreadScore.toFixed(3)})`
            );
        }

        // Steps have collapsed to nothing - we've converged.
        if (!improved && facilityStepScale < 0.01) {

            optimizing = false;

            optimizeBtn.disabled = false;

            status.textContent =
                `Converged at epoch ${epoch} · ` +
                `score ${currentMetric.score.toFixed(2)}`;

            logStep(
                `Converged early at epoch ${epoch} ` +
                `(score ${currentMetric.score.toFixed(2)}).`
            );

            return;
        }

        requestAnimationFrame(step);
    }

    requestAnimationFrame(step);
}


function stopOptimization() {

    optimizing = false;
}


// ============================================================
// MAP CLICK
// ============================================================

viewport.addEventListener(
    "click",
    event => {

        // Don't create boundary points when
        // clicking the controls.

        if (
            event.target.closest &&
            event.target.closest("#controls")
        ) {
            return;
        }


        if (!WORLD_WIDTH || !WORLD_HEIGHT) {
            return;
        }


        const p =
            screenToWorld(
                event.clientX,
                event.clientY
            );


        // ----------------------------------------------------
        // Do not allow boundary points outside the map
        // ----------------------------------------------------

        if (
            p.x < 0 ||
            p.x > WORLD_WIDTH ||
            p.y < 0 ||
            p.y > WORLD_HEIGHT
        ) {
            return;
        }


        // ----------------------------------------------------
        // If already closed, don't add points
        // ----------------------------------------------------

        if (cityClosed) {
            return;
        }


        // ----------------------------------------------------
        // Close if clicking near first point
        // ----------------------------------------------------

        if (
            boundaryPoints.length >= 3
        ) {

            const first =
                boundaryPoints[0];


            const distance =
                Math.hypot(
                    p.x - first.x,
                    p.y - first.y
                );


            if (distance <
                15 / zoomScale
            ) {

                cityClosed = true;


                drawBoundary();
		drawPoints();

                status.textContent =
                    "City boundary closed. Press \"Relax Points\" to relax.";


                drawVoronoi();


                relaxBtn.disabled = false;
                placeFacilitiesBtn.disabled = false;


                logStep(
                    `City boundary closed (${boundaryPoints.length} vertices).`
                );


                return;
            }
        }


        // ----------------------------------------------------
        // Add point
        // ----------------------------------------------------

        boundaryPoints.push({
            x: p.x,
            y: p.y
        });


        drawBoundary();


        status.textContent =
            `Boundary points: ${boundaryPoints.length}. ` +
            `Click near the first point to close.`;

        logStep(
            `Boundary point ${boundaryPoints.length} added.`
        );
    }
);


// ============================================================
// ZOOM
// ============================================================

viewport.addEventListener(
    "wheel",
    event => {

        event.preventDefault();


        if (!WORLD_WIDTH) {
            return;
        }


        // Position of mouse in viewport
        const rect =
            viewport.getBoundingClientRect();


        const mouseX =
            event.clientX - rect.left;

        const mouseY =
            event.clientY - rect.top;


        // World position under cursor
        const worldX =
            (mouseX - cameraX) /
            zoomScale;

        const worldY =
            (mouseY - cameraY) /
            zoomScale;


        // Zoom amount
        const zoomFactor =
            event.deltaY < 0
                ? 1.15
                : 1 / 1.15;


        const oldZoom =
            zoomScale;


        zoomScale *= zoomFactor;


        zoomScale =
            Math.max(
                0.1,
                Math.min(
                    20,
                    zoomScale
                )
            );


        // Keep the same world point
        // underneath the cursor.

        cameraX =
            mouseX -
            worldX * zoomScale;

        cameraY =
            mouseY -
            worldY * zoomScale;


        updateCamera();


        // Redraw points so their radius
        // remains constant on screen.

        drawPoints();

        drawBoundary();

        drawVoronoi();

        drawFacilities();

    },
    { passive: false }
);


// ============================================================
// RESET
// ============================================================

resetBtn.addEventListener(
    "click",
    () => {

        stopRelaxation();
        stopOptimization();

        relaxBtn.disabled = true;
        placeFacilitiesBtn.disabled = true;
        optimizeBtn.disabled = true;


        facilityPoints = [];

        currentMetric = null;

        updateMetricDisplay();

        facilityVoronoiLayer.selectAll("*").remove();
        facilityPointLayer.selectAll("*").remove();


        boundaryPoints = [];

        cityClosed = false;


        cityClipPath.attr(
            "d",
            ""
        );


        voronoiLayer
            .selectAll("*")
            .remove();


        vertexLayer
            .selectAll("*")
            .remove();


        boundaryLayer
            .selectAll("*")
            .remove();


        zoomScale = 1;

        centerWorld();


        logStep("Reset — boundary cleared, regenerating points.");


        // Regenerate a fresh set of Poisson points rather than
        // reusing the (possibly relaxed/moved) `points` array,
        // so Reset actually restores the original point map.

        generatePoints();
    }
);


// ============================================================
// GENERATE BUTTON
// ============================================================

generateBtn.addEventListener(
    "click",
    () => {

        stopRelaxation();

        generatePoints();
    }
);


// ============================================================
// R SLIDER
// ============================================================

rSlider.addEventListener(
    "input",
    () => {

        R = Number(rSlider.value);

        rValue.textContent = R;
    }
);


// ============================================================
// K SLIDER
// ============================================================

kSlider.addEventListener(
    "input",
    () => {

        K = Number(kSlider.value);

        kValue.textContent = K;
    }
);


// ============================================================
// VORONOI TOGGLE
// ============================================================

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
// RELAXATION CONTROLS
// ============================================================

relaxIterationsSlider.addEventListener(
    "input",
    () => {

        relaxIterationsValue.textContent =
            relaxIterationsSlider.value;
    }
);

relaxBtn.addEventListener(
    "click",
    () => {

        if (!cityClosed) {
            return;
        }

        const iterations =
            Math.max(
                1,
                Number(relaxIterationsSlider.value) || 1
            );

        startRelaxation(iterations);
    }
);


// ============================================================
// FACILITY CONTROLS
// ============================================================

facilityRSlider.addEventListener(
    "input",
    () => {

        facilityRValue.textContent =
            facilityRSlider.value;
    }
);

epochsSlider.addEventListener(
    "input",
    () => {

        epochsValue.textContent =
            epochsSlider.value;
    }
);

placeFacilitiesBtn.addEventListener(
    "click",
    () => {

        stopOptimization();

        placeFacilities();
    }
);

optimizeBtn.addEventListener(
    "click",
    () => {

        const epochs =
            Math.max(
                1,
                Number(epochsSlider.value) || 1
            );

        startOptimization(epochs);
    }
);

facilityToggle.addEventListener(
    "change",
    () => {

        drawFacilities();

        logStep(
            facilityToggle.checked
                ? "Facility layer shown."
                : "Facility layer hidden."
        );
    }
);


// ============================================================
// DRAGGABLE CONTROLS
// ============================================================

const controls =
    document.getElementById("controls");

const controlsHeader =
    document.getElementById("controls-header");


let draggingControls = false;

let controlsOffsetX = 0;
let controlsOffsetY = 0;


controlsHeader.addEventListener(
    "pointerdown",
    event => {

        draggingControls = true;


        const rect =
            controls.getBoundingClientRect();


        controlsOffsetX =
            event.clientX - rect.left;

        controlsOffsetY =
            event.clientY - rect.top;


        controlsHeader.setPointerCapture(
            event.pointerId
        );
    }
);


controlsHeader.addEventListener(
    "pointermove",
    event => {

        if (!draggingControls) {
            return;
        }


        controls.style.left =
            `${event.clientX - controlsOffsetX}px`;


        controls.style.top =
            `${event.clientY - controlsOffsetY}px`;
    }
);


controlsHeader.addEventListener(
    "pointerup",
    () => {

        draggingControls = false;
    }
);


// ============================================================
// WINDOW RESIZE
// ============================================================

window.addEventListener(
    "resize",
    () => {

        if (!WORLD_WIDTH) {
            return;
        }


        // Keep current zoom but recenter
        // the world in the viewport.

        centerWorld();

        draw();
    }
);
