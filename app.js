// ============================================================
// D3 CITY PLANNER
// ============================================================


// ============================================================
// DOM
// ============================================================

const map =
    document.getElementById("map");

const svg =
    d3.select("#viz");


// ============================================================
// STATE
// ============================================================

// These are determined from the image itself.

let WORLD_WIDTH = 0;
let WORLD_HEIGHT = 0;


// Original Poisson distribution.
// NEVER delete these.

let allPoints = [];


// Points currently inside the city.

let cityPoints = [];


// User-selected city boundary.

let boundary = [];


// Has the city been closed?

let cityClosed = false;


// Is Voronoi currently visible?

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
// GET PARAMETERS
// ============================================================

function getR() {

    return Number(
        document
            .getElementById("rSlider")
            .value
    );
}


function getK() {

    return Number(
        document
            .getElementById("kSlider")
            .value
    );
}


// ============================================================
// UPDATE SLIDER LABELS
// ============================================================

function updateSliderLabels() {

    document
        .getElementById("rValue")
        .textContent = getR();


    document
        .getElementById("kValue")
        .textContent = getK();
}


// ============================================================
// FAST POISSON DISC SAMPLING
// ============================================================

function poissonDiscSampling(
    width,
    height,
    radius,
    k
) {

    /*
        Cell size guarantees that each grid cell
        can contain at most one point.
    */

    const cellSize =
        radius / Math.sqrt(2);


    const gridWidth =
        Math.ceil(
            width / cellSize
        );


    const gridHeight =
        Math.ceil(
            height / cellSize
        );


    const grid =
        new Array(
            gridWidth *
            gridHeight
        ).fill(null);


    const points = [];

    const active = [];


    // --------------------------------------------------------
    // Grid index
    // --------------------------------------------------------

    function gridIndex(x, y) {

        const gx =
            Math.floor(
                x / cellSize
            );


        const gy =
            Math.floor(
                y / cellSize
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


    // --------------------------------------------------------
    // Check candidate
    // --------------------------------------------------------

    function isValid(point) {

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
                point.x / cellSize
            );


        const gy =
            Math.floor(
                point.y / cellSize
            );


        /*
            Only inspect nearby cells.

            This is what makes the algorithm fast.
        */

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


                const distanceSquared =
                    dx * dx +
                    dy * dy;


                if (
                    distanceSquared <
                    radius * radius
                ) {

                    return false;
                }
            }
        }


        return true;
    }


    // --------------------------------------------------------
    // Add point
    // --------------------------------------------------------

    function addPoint(point) {

        points.push(point);

        active.push(point);


        const index =
            gridIndex(
                point.x,
                point.y
            );


        if (index !== -1) {

            grid[index] = point;
        }
    }


    // --------------------------------------------------------
    // Initial random point
    // --------------------------------------------------------

    addPoint({

        x:
            Math.random() *
            width,

        y:
            Math.random() *
            height

    });


    // --------------------------------------------------------
    // Bridson algorithm
    // --------------------------------------------------------

    while (
        active.length > 0
    ) {

        const activeIndex =
            Math.floor(
                Math.random() *
                active.length
            );


        const current =
            active[activeIndex];


        let found =
            false;


        // K attempts

        for (
            let attempt = 0;
            attempt < k;
            attempt++
        ) {

            const angle =
                Math.random() *
                Math.PI *
                2;


            /*
                Generate point between:

                    R

                and

                    2R
            */

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
                isValid(candidate)
            ) {

                addPoint(
                    candidate
                );

                found = true;

                break;
            }
        }


        // ----------------------------------------------------
        // No valid point found
        // ----------------------------------------------------

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
// GENERATE POINTS
// ============================================================

function generatePoints() {

    const R = getR();

    const K = getK();


    updateSliderLabels();


    /*
        Generate using the ACTUAL IMAGE dimensions.
    */

    allPoints =
        poissonDiscSampling(
            WORLD_WIDTH,
            WORLD_HEIGHT,
            R,
            K
        );


    updateCityPoints();

    draw();

    updateStatus();
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


        if (intersects) {

            inside = !inside;
        }
    }


    return inside;
}


// ============================================================
// FILTER CITY POINTS
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

            .x(d => d.x)

            .y(d => d.y)

            .curve(

                cityClosed

                    ?

                d3.curveCatmullRomClosed
                    .alpha(0.5)

                    :

                d3.curveCatmullRom
                    .alpha(0.5)
            );


    return line(boundary);
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


    // --------------------------------------------------------
    // Vertices
    // --------------------------------------------------------

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
                    ? 8
                    : 6
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
    // Drag
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


    /*
        Before city is closed:

            show all points

        After city is closed:

            show only city points
    */

    const pointsToDraw =
        cityClosed
            ? cityPoints
            : allPoints;


    pointLayer
        .selectAll("circle")
        .data(pointsToDraw)
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

        .attr(
            "r",
            cityClosed
                ? 3
                : 2.5
        );
}


// ============================================================
// DRAW VORONOI
// ============================================================

function drawVoronoi() {

    voronoiLayer
        .selectAll("*")
        .remove();


    // Remove old clipping

    voronoiLayer
        .attr(
            "clip-path",
            null
        );


    if (!showVoronoi) {

        return;
    }


    /*
        Before closing city:
            Voronoi of ALL points.

        After closing city:
            Voronoi of CITY points.
    */

    const points =
        cityClosed
            ? cityPoints
            : allPoints;


    if (
        points.length < 2
    ) {

        return;
    }


    // --------------------------------------------------------
    // Delaunay
    // --------------------------------------------------------

    const delaunay =
        d3.Delaunay.from(
            points,

            d => d.x,

            d => d.y
        );


    // --------------------------------------------------------
    // Voronoi
    // --------------------------------------------------------

    const voronoi =
        delaunay.voronoi([

            0,
            0,

            WORLD_WIDTH,
            WORLD_HEIGHT

        ]);


    // ========================================================
    // CITY CLIPPING
    // ========================================================

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
                svg.append("defs");
        }


        // Remove old clip

        defs
            .select("#cityClip")
            .remove();


        const clip =
            defs
                .append("clipPath")
                .attr(
                    "id",
                    "cityClip"
                );


        clip
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
    // Render cells
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
// SVG CLICK
// ============================================================

svg.on(
    "click",
    function (event) {

        if (cityClosed) {

            return;
        }


        /*
            Don't create a new vertex if the user
            clicked an existing vertex.
        */

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
        // Close by clicking first point
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


        // ----------------------------------------------------
        // Add boundary point
        // ----------------------------------------------------

        boundary.push({

            x,
            y

        });


        drawBoundary();

        updateStatus();
    }
);


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


    generatePoints();
}


// ============================================================
// STATUS
// ============================================================

function updateStatus() {

    let text =
        `R=${getR()} · ` +
        `K=${getK()} · ` +
        `${allPoints.length} Poisson points`;


    if (cityClosed) {

        text +=
            ` · ${cityPoints.length} inside city`;
    }


    if (showVoronoi) {

        text +=
            ` · Voronoi ON`;
    }


    document
        .getElementById(
            "status"
        )
        .textContent = text;
}


// ============================================================
// SLIDER EVENTS
// ============================================================

document
    .getElementById("rSlider")
    .addEventListener(
        "input",
        function () {

            updateSliderLabels();

            generatePoints();
        }
    );


document
    .getElementById("kSlider")
    .addEventListener(
        "input",
        function () {

            updateSliderLabels();

            generatePoints();
        }
    );


// ============================================================
// BUTTON EVENTS
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
// KEYBOARD RESET
// ============================================================

window.addEventListener(
    "keydown",
    event => {

        if (
            event.key.toLowerCase() === "r"
        ) {

            reset();
        }
    }
);


// ============================================================
// IMAGE INITIALIZATION
// ============================================================

function initializeFromImage() {

    /*
        Get the REAL pixel dimensions of
        altitude-map.png.
    */

    WORLD_WIDTH =
        map.naturalWidth;


    WORLD_HEIGHT =
        map.naturalHeight;


    if (
        WORLD_WIDTH <= 0 ||
        WORLD_HEIGHT <= 0
    ) {

        console.error(
            "Could not determine image dimensions."
        );

        return;
    }


    // --------------------------------------------------------
    // SVG uses exactly the same coordinate system
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
    // Image uses EXACT pixel dimensions
    // --------------------------------------------------------

    map.style.width =
        `${WORLD_WIDTH}px`;

    map.style.height =
        `${WORLD_HEIGHT}px`;


    // --------------------------------------------------------
    // Generate points
    // --------------------------------------------------------

    generatePoints();
}


// ============================================================
// WAIT FOR IMAGE
// ============================================================

if (map.complete) {

    initializeFromImage();

} else {

    map.addEventListener(
        "load",
        initializeFromImage
    );
}
