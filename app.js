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
const vertexLayer = d3.select("#vertexLayer");

const cityClipPath = d3.select("#cityClipPath");

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
    // Generate points
    // --------------------------------------------------------

    generatePoints();


    status.textContent =
        "Click points around the map to create the city boundary.";
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

    pointLayer.selectAll("*").remove();

    if (!points.length) {
        return;
    }

    let visiblePoints = points;

    // Once city is closed, only show points INSIDE
    // the actual curved city boundary.
    if (cityClosed && boundaryPoints.length >= 3) {

        const splinePoints =
            createSplinePoints(
                boundaryPoints,
                25
            );

        visiblePoints =
            points.filter(p =>
                d3.polygonContains(
                    splinePoints.map(q => [q.x, q.y]),
                    [p.x, p.y]
                )
            );
    }

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
// CATMULL-ROM SPLINE
// ============================================================

function createSplinePoints(
    pts,
    samplesPerSegment = 20
) {

    if (pts.length < 3) {
        return pts.slice();
    }


    const result = [];


    for (
        let i = 0;
        i < pts.length;
        i++
    ) {

        const p0 =
            pts[
                (i - 1 + pts.length) %
                pts.length
            ];

        const p1 =
            pts[i];

        const p2 =
            pts[
                (i + 1) %
                pts.length
            ];

        const p3 =
            pts[
                (i + 2) %
                pts.length
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
                    (2 * p1.x) +

                    (-p0.x + p2.x) * t +

                    (2 * p0.x -
                        5 * p1.x +
                        4 * p2.x -
                        p3.x) * t2 +

                    (-p0.x +
                        3 * p1.x -
                        3 * p2.x +
                        p3.x) * t3
                );


            const y =
                0.5 *
                (
                    (2 * p1.y) +

                    (-p0.y + p2.y) * t +

                    (2 * p0.y -
                        5 * p1.y +
                        4 * p2.y -
                        p3.y) * t2 +

                    (-p0.y +
                        3 * p1.y -
                        3 * p2.y +
                        p3.y) * t3
                );


            result.push({ x, y });
        }
    }


    return result;
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


    if (points.length < 2) {
        return;
    }


    const delaunay =
        d3.Delaunay.from(
            points,
            d => d.x,
            d => d.y
        );


    const voronoi =
        delaunay.voronoi(
            [
                0,
                0,
                WORLD_WIDTH,
                WORLD_HEIGHT
            ]
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
        i < points.length;
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


        if (!WORLD_WIDTH) {
            return;
        }


        const p =
            screenToWorld(
                event.clientX,
                event.clientY
            );


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
                    "City boundary closed. Points outside the city are hidden.";


                drawVoronoi();


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


        draw();


        status.textContent =
            "Reset. Click points around the map to create the city boundary.";
    }
);


// ============================================================
// GENERATE BUTTON
// ============================================================

generateBtn.addEventListener(
    "click",
    () => {

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
