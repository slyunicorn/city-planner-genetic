// ============================================================
// AI CITY PLANNER
// ============================================================
//
// NOTE on map pixel access (buildMapImageData / viridisLookup):
// This project reads pixel data off the altitude-map <img> via
// canvas.getImageData(). That call throws a SecurityError if
// the image is considered "tainted" by CORS - which happens if
// you open index.html directly via a file:// URL, or serve it
// from a host that doesn't send appropriate CORS headers for
// the image. If that happens, relaxation silently falls back
// to being elevation-unaware (flat 0.5 blueness everywhere).
//
// To avoid this: serve the project over http(s) (e.g. a local
// dev server like `npx serve` or `python -m http.server`)
// rather than opening the HTML file directly.
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

const voronoiToggle = document.getElementById("voronoiToggle");

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
// MAP PIXEL SAMPLING (for viridis-weighted relaxation)
// ============================================================
//
// The altitude map is assumed to be colored with a viridis
// colormap (dark blue/purple = low values, yellow = high
// values). To weight relaxation toward blue and away from
// yellow, we read the map's pixels into an offscreen canvas
// once, then precompute a per-pixel lookup of where each
// pixel's color sits along the viridis gradient (0 = blue/
// purple end, 1 = yellow end).
//
// This lookup used to be computed on-demand (nearest-neighbor
// scan over a 256-entry table, per pixel, per call) inside
// getViridisTAt, which was called for every vertex of every
// Voronoi cell on every relaxation iteration - a lot of
// redundant scanning of the same handful of pixels. Now it's
// computed once per map load (buildViridisLookup) and reads
// are a plain O(1) array index.
// ============================================================

let mapImageData = null;
let viridisLookup = null; // Float32Array, one t-value per pixel

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

        // Precompute viridis-t for every pixel ONCE, so
        // relaxation just does an O(1) array lookup instead
        // of a 256-entry nearest-neighbor scan per call.
        buildViridisLookup();

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

        // Surface this in the UI too, not just the log panel -
        // it silently changes relaxation behavior and is easy
        // to miss if you're not watching the log.
        status.textContent =
            "Warning: map pixels unreadable (CORS?). " +
            "Relaxation will ignore elevation.";

        mapImageData = null;
        viridisLookup = null;
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

// Builds a WORLD_WIDTH x WORLD_HEIGHT lookup of viridis-t
// values, computed once per map load. This is the expensive
// O(pixels * 256) pass, but it only runs once instead of
// once per vertex per cell per relaxation iteration.
function buildViridisLookup() {

    if (!viridisTable) {
        buildViridisTable();
    }

    const pixelCount =
        WORLD_WIDTH * WORLD_HEIGHT;

    viridisLookup =
        new Float32Array(pixelCount);

    const data =
        mapImageData.data;

    for (
        let i = 0;
        i < pixelCount;
        i++
    ) {

        const offset = i * 4;

        viridisLookup[i] =
            nearestViridisT(
                data[offset],
                data[offset + 1],
                data[offset + 2]
            );
    }

    logStep(
        `Precomputed viridis lookup for ${pixelCount} pixels.`
    );
}

// Returns the viridis position (0 = blue, 1 = yellow) of the
// map pixel under the given world coordinate. Falls back to a
// neutral 0.5 if pixel data isn't available.
function getViridisTAt(x, y) {

    if (!viridisLookup) {
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

    return viridisLookup[py * WORLD_WIDTH + px];
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
// FAKE CENTROID (plain average of Voronoi cell vertices)
// ============================================================
//
// Color-seeking is handled separately (see findBluestDirection
// below) and blended in per-point in relaxPoints(), so this
// stays a plain geometric centroid - the thing that keeps
// points evenly spaced.
// ============================================================

function getFakeCentroid(polygon) {

    if (!polygon || polygon.length === 0) {
        return null;
    }

    let sumX = 0;
    let sumY = 0;

    for (const vertex of polygon) {

        sumX += vertex[0];
        sumY += vertex[1];
    }

    return {
        x: sumX / polygon.length,
        y: sumY / polygon.length
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

        relaxBtn.disabled = true;


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
