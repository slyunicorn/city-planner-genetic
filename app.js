// ============================================================
// D3 CITY PLANNER
// ============================================================


// ============================================================
// DOM
// ============================================================

const map =
    document.getElementById("map");

const viewport =
    document.getElementById("viewport");

const world =
    document.getElementById("world");

const svg =
    d3.select("#viz");


// ============================================================
// WORLD DIMENSIONS
// ============================================================

let WORLD_WIDTH = 0;

let WORLD_HEIGHT = 0;


// ============================================================
// CAMERA
// ============================================================

let zoomScale = 1;

let cameraX = 0;

let cameraY = 0;


// ============================================================
// POINT PARAMETERS
// ============================================================

const DEFAULT_R = 18;

const DEFAULT_K = 30;


// ============================================================
// STATE
// ============================================================

let allPoints = [];

let cityPoints = [];

let boundary = [];

let cityClosed = false;

let showVoronoi = false;


// ============================================================
// D3 LAYERS
// ============================================================

const voronoiLayer =
    svg
        .append("g")
        .attr(
            "class",
            "voronoi-layer"
        );


const pointLayer =
    svg
        .append("g")
        .attr(
            "class",
            "point-layer"
        );


const boundaryLayer =
    svg
        .append("g")
        .attr(
            "class",
            "boundary-layer"
        );


const vertexLayer =
    svg
        .append("g")
        .attr(
            "class",
            "vertex-layer"
        );


// ============================================================
// R / K
// ============================================================

function getR() {

    return Number(
        document
            .getElementById(
                "rSlider"
            )
            .value
    );
}


function getK() {

    return Number(
        document
            .getElementById(
                "kSlider"
            )
            .value
    );
}


function updateSliderLabels() {

    document
        .getElementById(
            "rValue"
        )
        .textContent = getR();


    document
        .getElementById(
            "kValue"
        )
        .textContent = getK();
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
        radius /
        Math.sqrt(2);


    const gridWidth =
        Math.ceil(
            width /
            cellSize
        );


    const gridHeight =
        Math.ceil(
            height /
            cellSize
        );


    const grid =
        new Array(
            gridWidth *
            gridHeight
        ).fill(null);


    const points = [];

    const active = [];


    function gridIndex(
        x,
        y
    ) {

        const gx =
            Math.floor(
                x /
                cellSize
            );


        const gy =
            Math.floor(
                y /
                cellSize
            );


        if (
            gx < 0 ||
            gy < 0 ||
            gx >= gridWidth ||
            gy >= gridHeight
        ) {

            return -1;
        }


        return (
            gy *
            gridWidth +
            gx
        );
    }


    function isValid(
        point
    ) {

        if (
            point.x < 0 ||
            point.x >= width ||
            point.y < 0 ||
            point.y >= height
        ) {

            return false;
        }


        const gx =
            Math.floor(
                point.x /
                cellSize
            );


        const gy =
            Math.floor(
                point.y /
                cellSize
            );


        for (
            let yy = gy - 2;
            yy <= gy + 2;
            yy++
        ) {

            for (
                let xx = gx - 2;
                xx <= gx + 2;
                xx++
            ) {

                if (
                    xx < 0 ||
                    yy < 0 ||
                    xx >= gridWidth ||
                    yy >= gridHeight
                ) {

                    continue;
                }


                const neighbor =
                    grid[
                        yy *
                        gridWidth +
                        xx
                    ];


                if (!neighbor) {

                    continue;
                }


                const dx =
                    point.x -
                    neighbor.x;


                const dy =
                    point.y -
                    neighbor.y;


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


    function addPoint(
        point
    ) {

        points.push(point);

        active.push(point);


        const index =
            gridIndex(
                point.x,
                point.y
            );


        if (
            index !== -1
        ) {

            grid[index] =
                point;
        }
    }


    // Initial point

    addPoint({

        x:
            Math.random() *
            width,

        y:
            Math.random() *
            height

    });


    // Bridson algorithm

    while (
        active.length
    ) {

        const activeIndex =
            Math.floor(
                Math.random() *
                active.length
            );


        const current =
            active[
                activeIndex
            ];


        let found =
            false;


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
                (
                    1 +
                    Math.random()
                );


            const candidate = {

                x:
                    current.x +
                    Math.cos(angle) *
                    distance,

                y:
                    current.y +
                    Math.sin(angle) *
                    distance

            };


            if (
                isValid(
                    candidate
                )
            ) {

                addPoint(
                    candidate
                );

                found = true;

                break;
            }
        }


        if (!found) {

            active.splice(
                activeIndex,
                1
            );
        }
    }


    return points;
}


// ============================================================
// POINT IN POLYGON
// ============================================================

function pointInsidePolygon(
    point,
    polygon
) {

    let inside = false;


    for (
        let i = 0,
            j = polygon.length - 1;

        i < polygon.length;

        j = i++
    ) {

        const a =
            polygon[i];


        const b =
            polygon[j];


        const intersects =

            (
                (a.y > point.y) !==
                (b.y > point.y)
            )

            &&

            (
                point.x <
                (
                    (b.x - a.x) *
                    (point.y - a.y)
                )
                /
                (b.y - a.y)
                +
                a.x
            );


        if (
            intersects
        ) {

            inside = !inside;
        }
    }


    return inside;
}


// ============================================================
// UPDATE CITY POINTS
// ============================================================

function updateCityPoints() {

    if (
        !cityClosed ||
        boundary.length < 3
    ) {

        cityPoints = [];

        return;
    }


    cityPoints =
        allPoints.filter(
            point =>
                pointInsidePolygon(
                    point,
                    boundary
                )
        );
}


// ============================================================
// CITY SPLINE
// ============================================================

function createBoundaryPath() {

    if (
        boundary.length === 0
    ) {

        return null;
    }


    const line =
        d3.line()

            .x(
                d => d.x
            )

            .y(
                d => d.y
            )

            .curve(

                cityClosed

                    ?

                d3.curveCatmullRomClosed
                    .alpha(0.5)

                    :

                d3.curveCatmullRom
                    .alpha(0.5)
            );


    return line(
        boundary
    );
}


// ============================================================
// DRAW BOUNDARY
// ============================================================

function drawBoundary() {

    boundaryLayer
        .selectAll("*")
        .remove();


    vertexLayer
        .selectAll("*")
        .remove();


    if (
        boundary.length === 0
    ) {

        return;
    }


    const path =
        createBoundaryPath();


    if (path) {

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
    }


    const vertices =
        vertexLayer
            .selectAll("circle")
            .data(boundary)
            .enter()
            .append("circle");


    vertices

        .attr(
            "class",
            "boundary-vertex"
        )

        .attr(
            "r",
            (d, i) =>
                i === 0
                    ? 7
                    : 5
        )

        .attr(
            "cx",
            d => d.x
        )

        .attr(
            "cy",
            d => d.y
        );


    // --------------------------------------------------------
    // Drag boundary vertices
    // --------------------------------------------------------

    if (!cityClosed) {

        vertices.call(

            d3.drag()

                .on(
                    "start",
                    function () {

                        d3
                            .select(this)
                            .raise();
                    }
                )

                .on(
                    "drag",
                    function (
                        event,
                        point
                    ) {

                        point.x =
                            Math.max(
                                0,
                                Math.min(
                                    WORLD_WIDTH,
                                    event.x
                                )
                            );


                        point.y =
                            Math.max(
                                0,
                                Math.min(
                                    WORLD_HEIGHT,
                                    event.y
                                )
                            );


                        d3
                            .select(this)
                            .attr(
                                "cx",
                                point.x
                            )
                            .attr(
                                "cy",
                                point.y
                            );


                        drawBoundary();
                    }
                )

                .on(
                    "end",
                    function () {

                        updateCityPoints();

                        draw();

                    }
                )
        );
    }
}


// ============================================================
// DRAW POINTS
// ============================================================

function drawPoints() {

    pointLayer
        .selectAll("*")
        .remove();


    const pointsToDraw =
        cityClosed
            ? cityPoints
            : allPoints;


    pointLayer
        .selectAll("circle")
        .data(
            pointsToDraw
        )
        .enter()
        .append("circle")

        .attr(
            "class",
            cityClosed
                ? "city-point"
                : "sample-point"
        )

        .attr(
            "cx",
            d => d.x
        )

        .attr(
            "cy",
            d => d.y
        )

        /*
            IMPORTANT:

            Radius is expressed in SCREEN pixels.

            Since the entire world scales when zooming,
            we compensate by dividing by zoomScale.

            So:

                zoom in 2x
                    radius = original / 2

                zoom in 4x
                    radius = original / 4
        */

        .attr(
            "r",
            cityClosed
                ? 2.5 / zoomScale
                : 2 / zoomScale
        );
}


// ============================================================
// DRAW VORONOI
// ============================================================

function drawVoronoi() {

    voronoiLayer
        .selectAll("*")
        .remove();


    voronoiLayer
        .attr(
            "clip-path",
            null
        );


    if (!showVoronoi) {

        return;
    }


    const points =
        cityClosed
            ? cityPoints
            : allPoints;


    if (
        points.length < 2
    ) {

        return;
    }


    const delaunay =
        d3.Delaunay.from(
            points,

            d => d.x,

            d => d.y
        );


    const voronoi =
        delaunay.voronoi([

            0,
            0,

            WORLD_WIDTH,
            WORLD_HEIGHT

        ]);


    // --------------------------------------------------------
    // Clip to city
    // --------------------------------------------------------

    if (
        cityClosed &&
        boundary.length >= 3
    ) {

        let defs =
            svg.select("defs");


        if (
            defs.empty()
        ) {

            defs =
                svg.append(
                    "defs"
                );
        }


        defs
            .select("#cityClip")
            .remove();


        defs
            .append("clipPath")
            .attr(
                "id",
                "cityClip"
            )

            .append("path")
            .attr(
                "d",
                createBoundaryPath()
            );


        voronoiLayer
            .attr(
                "clip-path",
                "url(#cityClip)"
            );
    }


    // --------------------------------------------------------
    // Draw cells
    // --------------------------------------------------------

    voronoiLayer
        .selectAll("path")
        .data(points)
        .enter()
        .append("path")

        .attr(
            "class",
            "voronoi-cell"
        )

        .attr(
            "d",
            (d, i) =>
                voronoi.renderCell(i)
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
// CENTER WORLD
// ============================================================

function centerWorld() {

    const viewportWidth =
        viewport.clientWidth;


    const viewportHeight =
        viewport.clientHeight;


    /*
        Put the CENTER of the image at
        the CENTER of the screen.
    */

    cameraX =
        (
            viewportWidth -
            WORLD_WIDTH * zoomScale
        ) / 2;


    cameraY =
        (
            viewportHeight -
            WORLD_HEIGHT * zoomScale
        ) / 2;


    updateCamera();
}


// ============================================================
// APPLY CAMERA
// ============================================================

function updateCamera() {

    world.style.transform =

        `translate(
            ${cameraX}px,
            ${cameraY}px
        )
        scale(
            ${zoomScale}
        )`;


    /*
        Point radii and other screen-space
        properties depend on zoom.
    */

    drawPoints();
}


// ============================================================
// ZOOM
// ============================================================

function zoomAt(
    mouseX,
    mouseY,
    factor
) {

    const oldScale =
        zoomScale;


    const newScale =
        Math.max(
            0.1,
            Math.min(
                20,
                zoomScale *
                factor
            )
        );


    if (
        newScale === oldScale
    ) {

        return;
    }


    /*
        World coordinate underneath
        mouse cursor before zoom.
    */

    const worldX =
        (
            mouseX -
            cameraX
        )
        /
        oldScale;


    const worldY =
        (
            mouseY -
            cameraY
        )
        /
        oldScale;


    zoomScale =
        newScale;


    /*
        Keep the same world coordinate
        underneath the cursor.
    */

    cameraX =
        mouseX -
        worldX *
        zoomScale;


    cameraY =
        mouseY -
        worldY *
        zoomScale;


    updateCamera();

    drawVoronoi();

    drawBoundary();
}


// ============================================================
// MOUSE WHEEL ZOOM
// ============================================================

viewport.addEventListener(
    "wheel",
    event => {

        event.preventDefault();


        const rect =
            viewport.getBoundingClientRect();


        const mouseX =
            event.clientX -
            rect.left;


        const mouseY =
            event.clientY -
            rect.top;


        const factor =
            event.deltaY < 0
                ? 1.15
                : 1 / 1.15;


        zoomAt(
            mouseX,
            mouseY,
            factor
        );
    },
    {
        passive: false
    }
);


// ============================================================
// GENERATE POINTS
// ============================================================

function generatePoints() {

    updateSliderLabels();


    allPoints =
        poissonDiscSampling(

            WORLD_WIDTH,

            WORLD_HEIGHT,

            getR(),

            getK()

        );


    updateCityPoints();

    draw();

    updateStatus();
}


// ============================================================
// CLOSE CITY
// ============================================================

function closeCity() {

    if (
        boundary.length < 3
    ) {

        alert(
            "Select at least 3 boundary points."
        );

        return;
    }


    cityClosed = true;


    updateCityPoints();

    draw();

    updateStatus();
}


// ============================================================
// RESET
// ============================================================

function reset() {

    boundary = [];

    cityPoints = [];

    cityClosed = false;

    showVoronoi = false;


    document
        .getElementById(
            "voronoiToggle"
        )
        .checked = false;


    zoomScale = 1;


    centerWorld();

    generatePoints();
}


// ============================================================
// SVG CLICK
// ============================================================

svg.on(
    "click",
    function (event) {

        if (cityClosed) {

            return;
        }


        if (
            event.target.tagName ===
            "circle"
        ) {

            return;
        }


        const [
            x,
            y
        ] =
            d3.pointer(
                event,
                this
            );


        // ----------------------------------------------------
        // Close by clicking first vertex
        // ----------------------------------------------------

        if (
            boundary.length >= 3
        ) {

            const first =
                boundary[0];


            const distance =
                Math.hypot(
                    x - first.x,
                    y - first.y
                );


            if (
                distance < 18
            ) {

                closeCity();

                return;
            }
        }


        boundary.push({

            x,
            y

        });


        drawBoundary();

        updateStatus();
    }
);


// ============================================================
// SLIDERS
// ============================================================

document
    .getElementById(
        "rSlider"
    )
    .addEventListener(
        "input",
        () => {

            generatePoints();
        }
    );


document
    .getElementById(
        "kSlider"
    )
    .addEventListener(
        "input",
        () => {

            generatePoints();
        }
    );


// ============================================================
// BUTTONS
// ============================================================

document
    .getElementById(
        "generatePoints"
    )
    .addEventListener(
        "click",
        generatePoints
    );


document
    .getElementById(
        "closeCity"
    )
    .addEventListener(
        "click",
        closeCity
    );


document
    .getElementById(
        "reset"
    )
    .addEventListener(
        "click",
        reset
    );


// ============================================================
// VORONOI TOGGLE
// ============================================================

document
    .getElementById(
        "voronoiToggle"
    )
    .addEventListener(
        "change",
        function () {

            showVoronoi =
                this.checked;


            drawVoronoi();

            updateStatus();
        }
    );


// ============================================================
// STATUS
// ============================================================

function updateStatus() {

    let text =

        `R=${getR()} · ` +
        `K=${getK()} · ` +
        `${allPoints.length} points`;


    if (cityClosed) {

        text +=
            ` · ${cityPoints.length} inside city`;
    }


    if (showVoronoi) {

        text +=
            ` · Voronoi ON`;
    }


    text +=
        ` · Zoom ${zoomScale.toFixed(2)}×`;


    document
        .getElementById(
            "status"
        )
        .textContent = text;
}


// ============================================================
// DRAGGABLE CONTROL WINDOW
// ============================================================

const controls =
    document.getElementById(
        "controls"
    );


const header =
    document.getElementById(
        "controls-header"
    );


let draggingControls =
    false;


let dragOffsetX = 0;

let dragOffsetY = 0;


header.addEventListener(
    "pointerdown",
    event => {

        /*
            Don't start dragging if the user
            somehow starts on a button/input.
        */

        if (
            event.target.closest(
                "button, input, label"
            )
        ) {

            return;
        }


        draggingControls =
            true;


        const rect =
            controls.getBoundingClientRect();


        dragOffsetX =
            event.clientX -
            rect.left;


        dragOffsetY =
            event.clientY -
            rect.top;


        header.setPointerCapture(
            event.pointerId
        );
    }
);


header.addEventListener(
    "pointermove",
    event => {

        if (!draggingControls) {

            return;
        }


        let x =
            event.clientX -
            dragOffsetX;


        let y =
            event.clientY -
            dragOffsetY;


        /*
            Keep the panel on screen.
        */

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


header.addEventListener(
    "pointerup",
    event => {

        draggingControls =
            false;


        try {

            header.releasePointerCapture(
                event.pointerId
            );

        } catch (_) {}
    }
);


// ============================================================
// WINDOW RESIZE
// ============================================================

window.addEventListener(
    "resize",
    () => {

        /*
            Re-center only if the user hasn't
            meaningfully zoomed/panned.
        */

        if (
            zoomScale === 1
        ) {

            centerWorld();
        }
    }
);


// ============================================================
// IMAGE INITIALIZATION
// ============================================================

function initializeFromImage() {

    WORLD_WIDTH =
        map.naturalWidth;


    WORLD_HEIGHT =
        map.naturalHeight;


    if (
        WORLD_WIDTH <= 0 ||
        WORLD_HEIGHT <= 0
    ) {

        console.error(
            "Invalid altitude map dimensions."
        );

        return;
    }


    // --------------------------------------------------------
    // Set actual image dimensions
    // --------------------------------------------------------

    map.style.width =
        `${WORLD_WIDTH}px`;


    map.style.height =
        `${WORLD_HEIGHT}px`;


    // --------------------------------------------------------
    // Set SVG dimensions
    // --------------------------------------------------------

    svg
        .attr(
            "width",
            WORLD_WIDTH
        )

        .attr(
            "height",
            WORLD_HEIGHT
        )

        .attr(
            "viewBox",
            `0 0 ${WORLD_WIDTH} ${WORLD_HEIGHT}`
        );


    // --------------------------------------------------------
    // Center everything
    // --------------------------------------------------------

    centerWorld();


    // --------------------------------------------------------
    // Generate
    // --------------------------------------------------------

    generatePoints();
}


// ============================================================
// WAIT FOR MAP
// ============================================================

if (
    map.complete
) {

    initializeFromImage();

} else {

    map.addEventListener(
        "load",
        initializeFromImage
    );
}
