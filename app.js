// ============================================================
// AI CITY PLANNER
// app.js
// ============================================================
//
// Features:
// - Uses altitude-map.png at its exact natural dimensions
// - Fast Poisson-disc sampling
// - Adjustable R and K
// - Click points to create a city boundary
// - Smooth Catmull-Rom closed spline
// - Removes points outside the city
// - Voronoi diagram
// - Voronoi clipped to city boundary
// - Zoom centered around mouse
// - Map always stays centered correctly
// - Points stay constant size on screen
// - Voronoi lines stay constant size on screen
// - Draggable control panel
//
// ============================================================


// ============================================================
// DOM
// ============================================================

const viewport = document.getElementById("viewport");
const svgElement = document.getElementById("viz");
const mapElement = document.getElementById("map");

const svg = d3.select(svgElement);

const map = d3.select(mapElement);

const pointLayer = d3.select("#pointLayer");
const voronoiLayer = d3.select("#voronoiLayer");
const boundaryLayer = d3.select("#boundaryLayer");
const vertexLayer = d3.select("#vertexLayer");

const cityClipPath = d3.select("#cityClipPath");


// ============================================================
// CONTROLS
// ============================================================

const rSlider = document.getElementById("rSlider");
const kSlider = document.getElementById("kSlider");

const rValue = document.getElementById("rValue");
const kValue = document.getElementById("kValue");

const generateBtn = document.getElementById("generateBtn");
const closeBtn = document.getElementById("closeBtn");
const resetBtn = document.getElementById("resetBtn");

const voronoiToggle = document.getElementById("voronoiToggle");

const status = document.getElementById("status");


// ============================================================
// WORLD / CAMERA
// ============================================================

let WORLD_WIDTH = 0;
let WORLD_HEIGHT = 0;

let zoomScale = 1;

let cameraX = 0;
let cameraY = 0;


// ============================================================
// CITY DATA
// ============================================================

let allPoints = [];

let cityPoints = [];

let boundary = [];

let cityClosed = false;

let showVoronoi = false;


// ============================================================
// SETTINGS
// ============================================================

let R = Number(rSlider.value);
let K = Number(kSlider.value);


// ============================================================
// UPDATE SLIDER LABELS
// ============================================================

function updateSliderLabels() {

    R = Number(rSlider.value);
    K = Number(kSlider.value);

    rValue.textContent = R;
    kValue.textContent = K;
}

rSlider.addEventListener("input", updateSliderLabels);
kSlider.addEventListener("input", updateSliderLabels);

updateSliderLabels();


// ============================================================
// INITIALIZE MAP
// ============================================================

function initializeMap() {

    WORLD_WIDTH = mapElement.naturalWidth;
    WORLD_HEIGHT = mapElement.naturalHeight;

    if (!WORLD_WIDTH || !WORLD_HEIGHT) {

        console.error(
            "Could not determine altitude-map.png dimensions."
        );

        status.textContent =
            "Error: altitude-map.png could not be loaded.";

        return;
    }


    console.log(
        `Map dimensions: ${WORLD_WIDTH} × ${WORLD_HEIGHT}`
    );


    // SVG uses the exact image dimensions
    svg
        .attr("width", WORLD_WIDTH)
        .attr("height", WORLD_HEIGHT)
        .attr(
            "viewBox",
            `0 0 ${WORLD_WIDTH} ${WORLD_HEIGHT}`
        );


    // Image occupies the entire SVG
    map
        .attr("x", 0)
        .attr("y", 0)
        .attr("width", WORLD_WIDTH)
        .attr("height", WORLD_HEIGHT);


    centerWorld();

    generatePoints();
}


// ============================================================
// CENTER WORLD
// ============================================================
//
// screen = world * zoom + camera
//
// This guarantees that the image is centered regardless
// of its size and current zoom level.
// ============================================================

function centerWorld() {

    const screenWidth =
        viewport.clientWidth;

    const screenHeight =
        viewport.clientHeight;


    cameraX =
        (screenWidth -
            WORLD_WIDTH * zoomScale) / 2;

    cameraY =
        (screenHeight -
            WORLD_HEIGHT * zoomScale) / 2;


    updateCamera();
}


// ============================================================
// APPLY CAMERA
// ============================================================
//
// matrix() explicitly means:
//
// x_screen = x_world * zoom + cameraX
// y_screen = y_world * zoom + cameraY
//
// This avoids transform-order problems.
// ============================================================

function updateCamera() {

    svgElement.style.transform =
        `matrix(
            ${zoomScale},
            0,
            0,
            ${zoomScale},
            ${cameraX},
            ${cameraY}
        )`;


    draw();
}


// ============================================================
// SCREEN → WORLD COORDINATES
// ============================================================

function screenToWorld(event) {

    const rect =
        viewport.getBoundingClientRect();


    const screenX =
        event.clientX - rect.left;

    const screenY =
        event.clientY - rect.top;


    const worldX =
        (screenX - cameraX) / zoomScale;

    const worldY =
        (screenY - cameraY) / zoomScale;


    return [worldX, worldY];
}


// ============================================================
// WORLD → SCREEN COORDINATES
// ============================================================

function worldToScreen(point) {

    return [
        point[0] * zoomScale + cameraX,
        point[1] * zoomScale + cameraY
    ];
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

    const points = [];


    // Grid cell size
    const cellSize =
        radius / Math.sqrt(2);


    const cols =
        Math.ceil(width / cellSize);

    const rows =
        Math.ceil(height / cellSize);


    const grid =
        new Array(cols * rows).fill(null);


    function gridIndex(x, y) {

        const col =
            Math.floor(x / cellSize);

        const row =
            Math.floor(y / cellSize);

        if (
            col < 0 ||
            col >= cols ||
            row < 0 ||
            row >= rows
        ) {
            return -1;
        }

        return row * cols + col;
    }


    function isValid(point) {

        const gx =
            Math.floor(point[0] / cellSize);

        const gy =
            Math.floor(point[1] / cellSize);


        // Check neighboring cells
        for (
            let y = gy - 2;
            y <= gy + 2;
            y++
        ) {

            for (
                let x = gx - 2;
                x <= gx + 2;
                x++
            ) {

                if (
                    x < 0 ||
                    x >= cols ||
                    y < 0 ||
                    y >= rows
                ) {
                    continue;
                }


                const existing =
                    grid[y * cols + x];


                if (!existing) {
                    continue;
                }


                const dx =
                    existing[0] - point[0];

                const dy =
                    existing[1] - point[1];


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


    // Random starting point
    const firstPoint = [
        Math.random() * width,
        Math.random() * height
    ];


    points.push(firstPoint);

    const firstIndex =
        gridIndex(
            firstPoint[0],
            firstPoint[1]
        );

    grid[firstIndex] = firstPoint;


    const active = [firstPoint];


    while (active.length > 0) {

        const randomIndex =
            Math.floor(
                Math.random() * active.length
            );


        const current =
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


            // Generate between R and 2R
            const distance =
                radius *
                (1 + Math.random());


            const candidate = [

                current[0] +
                    Math.cos(angle) *
                    distance,

                current[1] +
                    Math.sin(angle) *
                    distance
            ];


            if (
                candidate[0] < 0 ||
                candidate[0] >= width ||
                candidate[1] < 0 ||
                candidate[1] >= height
            ) {
                continue;
            }


            if (!isValid(candidate)) {
                continue;
            }


            points.push(candidate);


            const index =
                gridIndex(
                    candidate[0],
                    candidate[1]
                );


            grid[index] = candidate;

            active.push(candidate);

            found = true;

            break;
        }


        if (!found) {

            active.splice(
                randomIndex,
                1
            );
        }
    }


    return points;
}


// ============================================================
// GENERATE POINTS
// ============================================================

function generatePoints() {

    if (!WORLD_WIDTH || !WORLD_HEIGHT) {
        return;
    }


    status.textContent =
        "Generating points...";


    // Small timeout lets the browser update the UI
    // before doing potentially expensive work.
    setTimeout(() => {

        allPoints =
            poissonDiscSampling(
                WORLD_WIDTH,
                WORLD_HEIGHT,
                R,
                K
            );


        cityPoints = [];

        boundary = [];

        cityClosed = false;


        draw();


        status.textContent =
            `${allPoints.length} points generated. ` +
            `Click around the map to create the city boundary.`;

    }, 20);
}


// ============================================================
// CATMULL-ROM CLOSED SPLINE
// ============================================================
//
// We create a dense approximation of the spline.
//
// This is important because the SAME geometry is used for:
//
// 1. Visual boundary
// 2. Point filtering
// 3. Voronoi clipping
//
// Therefore points cannot disagree with the visible wall.
// ============================================================

function createSplinePoints(
    points,
    samplesPerSegment = 20
) {

    if (points.length < 2) {
        return points.slice();
    }


    const result = [];


    const n = points.length;


    for (
        let i = 0;
        i < n;
        i++
    ) {

        const p0 =
            points[
                (i - 1 + n) % n
            ];

        const p1 =
            points[i];

        const p2 =
            points[
                (i + 1) % n
            ];

        const p3 =
            points[
                (i + 2) % n
            ];


        for (
            let j = 0;
            j < samplesPerSegment;
            j++
        ) {

            const t =
                j / samplesPerSegment;

            const t2 = t * t;
            const t3 = t2 * t;


            const x =
                0.5 *
                (
                    (2 * p1[0]) +

                    (-p0[0] + p2[0]) * t +

                    (
                        2 * p0[0] -
                        5 * p1[0] +
                        4 * p2[0] -
                        p3[0]
                    ) * t2 +

                    (
                        -p0[0] +
                        3 * p1[0] -
                        3 * p2[0] +
                        p3[0]
                    ) * t3
                );


            const y =
                0.5 *
                (
                    (2 * p1[1]) +

                    (-p0[1] + p2[1]) * t +

                    (
                        2 * p0[1] -
                        5 * p1[1] +
                        4 * p2[1] -
                        p3[1]
                    ) * t2 +

                    (
                        -p0[1] +
                        3 * p1[1] -
                        3 * p2[1] +
                        p3[1]
                    ) * t3
                );


            result.push([x, y]);
        }
    }


    return result;
}


// ============================================================
// SPLINE PATH
// ============================================================

function createBoundaryPath() {

    if (boundary.length < 2) {
        return "";
    }


    const line =
        d3.line()
            .x(d => d[0])
            .y(d => d[1])
            .curve(
                d3.curveCatmullRomClosed
                    .alpha(0.5)
            );


    return line(boundary);
}


// ============================================================
// POINT INSIDE POLYGON
// ============================================================

function pointInsidePolygon(
    point,
    polygon
) {

    return d3.polygonContains(
        polygon,
        point
    );
}


// ============================================================
// UPDATE CITY POINTS
// ============================================================

function updateCityPoints() {

    if (!cityClosed) {

        cityPoints =
            allPoints.slice();

        return;
    }


    const spline =
        createSplinePoints(
            boundary,
            20
        );


    cityPoints =
        allPoints.filter(
            point =>
                pointInsidePolygon(
                    point,
                    spline
                )
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
// DRAW POINTS
// ============================================================

function drawPoints() {

    const points =
        cityClosed
            ? cityPoints
            : allPoints;


    const circles =
        pointLayer
            .selectAll("circle")
            .data(
                points,
                d => `${d[0]}-${d[1]}`
            );


    circles
        .join("circle")
        .attr(
            "class",
            cityClosed
                ? "city-point"
                : "sample-point"
        )
        .attr(
            "cx",
            d => d[0]
        )
        .attr(
            "cy",
            d => d[1]
        )
        .attr(
            "r",
            cityClosed
                ? 2.5 / zoomScale
                : 2 / zoomScale
        );
}


// ============================================================
// DRAW CITY BOUNDARY
// ============================================================

function drawBoundary() {

    boundaryLayer
        .selectAll("*")
        .remove();


    vertexLayer
        .selectAll("*")
        .remove();


    if (boundary.length === 0) {
        return;
    }


    // --------------------------------------------
    // Boundary line
    // --------------------------------------------

    if (boundary.length >= 2) {

        const path =
            boundaryLayer
                .append("path")
                .attr(
                    "class",
                    "city-boundary"
                )
                .attr(
                    "d",
                    cityClosed
                        ? createBoundaryPath()
                        : d3.line()
                            .x(d => d[0])
                            .y(d => d[1])
                            .curve(
                                d3.curveCatmullRom
                                    .alpha(0.5)
                            )(boundary)
                );


        if (cityClosed) {

            path.attr(
                "clip-path",
                "none"
            );
        }
    }


    // --------------------------------------------
    // Editing vertices
    // --------------------------------------------

    if (!cityClosed) {

        vertexLayer
            .selectAll("circle")
            .data(boundary)
            .join("circle")
            .attr(
                "class",
                "boundary-vertex"
            )
            .attr(
                "cx",
                d => d[0]
            )
            .attr(
                "cy",
                d => d[1]
            )
            .attr(
                "r",
                5 / zoomScale
            )
            .call(
                d3.drag()
                    .on(
                        "start",
                        function(event) {

                            d3.select(this)
                                .raise();
                        }
                    )
                    .on(
                        "drag",
                        function(
                            event,
                            d
                        ) {

                            /*
                                event.clientX/Y gives actual
                                screen position.

                                Convert that back into world
                                coordinates so dragging works
                                correctly even when zoomed.
                            */

                            const rect =
                                viewport
                                    .getBoundingClientRect();


                            const screenX =
                                event.sourceEvent.clientX -
                                rect.left;

                            const screenY =
                                event.sourceEvent.clientY -
                                rect.top;


                            d[0] =
                                (
                                    screenX -
                                    cameraX
                                ) / zoomScale;


                            d[1] =
                                (
                                    screenY -
                                    cameraY
                                ) / zoomScale;


                            drawBoundary();

                            drawVoronoi();
                        }
                    )
            );
    }
}


// ============================================================
// DRAW VORONOI
// ============================================================

function drawVoronoi() {

    voronoiLayer
        .selectAll("*")
        .remove();


    if (!showVoronoi) {
        return;
    }


    const points =
        cityClosed
            ? cityPoints
            : allPoints;


    if (points.length < 2) {
        return;
    }


    const delaunay =
        d3.Delaunay.from(
            points,
            d => d[0],
            d => d[1]
        );


    const voronoi =
        delaunay.voronoi([
            0,
            0,
            WORLD_WIDTH,
            WORLD_HEIGHT
        ]);


    // --------------------------------------------
    // Clip Voronoi to city boundary
    // --------------------------------------------

    if (
        cityClosed &&
        boundary.length >= 3
    ) {

        cityClipPath
            .attr(
                "d",
                createBoundaryPath()
            );


        voronoiLayer
            .attr(
                "clip-path",
                "url(#cityClip)"
            );

    } else {

        voronoiLayer
            .attr(
                "clip-path",
                null
            );
    }


    // --------------------------------------------
    // Draw cells
    // --------------------------------------------

    voronoiLayer
        .selectAll("path")
        .data(points)
        .join("path")
        .attr(
            "class",
            "voronoi-cell"
        )
        .attr(
            "d",
            (_, i) =>
                voronoi.renderCell(i)
        );
}


// ============================================================
// ADD BOUNDARY POINT
// ============================================================

svg.on(
    "click",
    function(event) {

        if (cityClosed) {
            return;
        }


        // Ignore clicking directly on a vertex
        if (
            event.target.classList &&
            event.target.classList.contains(
                "boundary-vertex"
            )
        ) {
            return;
        }


        const [x, y] =
            screenToWorld(event);


        // --------------------------------------------
        // Keep points inside image
        // --------------------------------------------

        if (
            x < 0 ||
            x > WORLD_WIDTH ||
            y < 0 ||
            y > WORLD_HEIGHT
        ) {
            return;
        }


        // --------------------------------------------
        // Close if clicking near first point
        // --------------------------------------------

        if (
            boundary.length >= 3
        ) {

            const first =
                boundary[0];


            const dx =
                first[0] - x;

            const dy =
                first[1] - y;


            const distance =
                Math.sqrt(
                    dx * dx +
                    dy * dy
                );


            // Screen-space threshold
            const closeDistance =
                15 / zoomScale;


            if (
                distance <
                closeDistance
            ) {

                closeCity();

                return;
            }
        }


        boundary.push([x, y]);

        drawBoundary();

        status.textContent =
            `${boundary.length} boundary points. ` +
            `Click near the first point to close the city.`;
    }
);


// ============================================================
// CLOSE CITY
// ============================================================

function closeCity() {

    if (boundary.length < 3) {

        status.textContent =
            "You need at least 3 boundary points.";

        return;
    }


    cityClosed = true;


    updateCityPoints();


    draw();


    status.textContent =
        `City closed. ${cityPoints.length} ` +
        `of ${allPoints.length} points are inside the city.`;
}


closeBtn.addEventListener(
    "click",
    closeCity
);


// ============================================================
// GENERATE BUTTON
// ============================================================

generateBtn.addEventListener(
    "click",
    generatePoints
);


// ============================================================
// VORONOI TOGGLE
// ============================================================

voronoiToggle.addEventListener(
    "change",
    function() {

        showVoronoi =
            this.checked;

        drawVoronoi();
    }
);


// ============================================================
// RESET
// ============================================================

resetBtn.addEventListener(
    "click",
    function() {

        boundary = [];

        cityPoints = [];

        cityClosed = false;

        showVoronoi = false;

        voronoiToggle.checked = false;


        zoomScale = 1;


        centerWorld();

        generatePoints();


        status.textContent =
            "Reset.";
    }
);


// ============================================================
// ZOOM
// ============================================================

viewport.addEventListener(
    "wheel",
    function(event) {

        event.preventDefault();


        const rect =
            viewport.getBoundingClientRect();


        const mouseX =
            event.clientX -
            rect.left;

        const mouseY =
            event.clientY -
            rect.top;


        // --------------------------------------------
        // Find world coordinate under mouse
        // --------------------------------------------

        const worldX =
            (
                mouseX -
                cameraX
            ) / zoomScale;


        const worldY =
            (
                mouseY -
                cameraY
            ) / zoomScale;


        // --------------------------------------------
        // Zoom
        // --------------------------------------------

        if (event.deltaY < 0) {

            zoomScale *= 1.15;

        } else {

            zoomScale /= 1.15;
        }


        zoomScale =
            Math.max(
                0.1,
                Math.min(
                    20,
                    zoomScale
                )
            );


        // --------------------------------------------
        // Keep mouse position fixed
        // --------------------------------------------

        cameraX =
            mouseX -
            worldX * zoomScale;

        cameraY =
            mouseY -
            worldY * zoomScale;


        updateCamera();

    },
    {
        passive: false
    }
);


// ============================================================
// WINDOW RESIZE
// ============================================================

window.addEventListener(
    "resize",
    function() {

        // Keep the world centered when
        // the window changes size.

        centerWorld();
    }
);


// ============================================================
// DRAGGABLE CONTROL PANEL
// ============================================================

const controls =
    document.getElementById("controls");

const controlsHeader =
    document.getElementById("controls-header");


let draggingControls = false;

let dragOffsetX = 0;
let dragOffsetY = 0;


controlsHeader.addEventListener(
    "pointerdown",
    function(event) {

        draggingControls = true;


        const rect =
            controls.getBoundingClientRect();


        dragOffsetX =
            event.clientX -
            rect.left;

        dragOffsetY =
            event.clientY -
            rect.top;


        controlsHeader.setPointerCapture(
            event.pointerId
        );
    }
);


controlsHeader.addEventListener(
    "pointermove",
    function(event) {

        if (!draggingControls) {
            return;
        }


        let x =
            event.clientX -
            dragOffsetX;

        let y =
            event.clientY -
            dragOffsetY;


        // --------------------------------------------
        // Keep panel inside browser window
        // --------------------------------------------

        const maxX =
            window.innerWidth -
            controls.offsetWidth;

        const maxY =
            window.innerHeight -
            controls.offsetHeight;


        x =
            Math.max(
                0,
                Math.min(
                    maxX,
                    x
                )
            );


        y =
            Math.max(
                0,
                Math.min(
                    maxY,
                    y
                )
            );


        controls.style.left =
            `${x}px`;

        controls.style.top =
            `${y}px`;
    }
);


controlsHeader.addEventListener(
    "pointerup",
    function(event) {

        draggingControls = false;

        controlsHeader.releasePointerCapture(
            event.pointerId
        );
    }
);


// ============================================================
// IMAGE LOADING
// ============================================================

if (mapElement.complete) {

    initializeMap();

} else {

    mapElement.addEventListener(
        "load",
        initializeMap
    );
}
