// js/poisson.js
// Poisson-disc sampling and block point generation.
// Plain script: shares the global scope with the other js/ files,
// so load order in index.html matters.

// ============================================================
// POISSON DISC SAMPLING
// ============================================================
//
// Bridson's algorithm. With options.densityAt (x, y -> 0..1) the
// spacing varies: a point at density rho keeps others at least
//
//     r = radius / sqrt(rho)
//
// away (rho floored at POISSON_MIN_DENSITY, so r <= 4 * radius),
// which makes the number of points per area proportional to rho.
// Spots below POISSON_DENSITY_CUTOFF get no points at all. Two
// points must be at least the LARGER of their two radii apart.
// options.bounds [x0, y0, x1, y1] limits where points may land.
// Without options it is the plain uniform sampler.
// ============================================================

const POISSON_MIN_DENSITY = 1 / 16;
const POISSON_DENSITY_CUTOFF = 0.02;

function poissonDiscSampling(
    width,
    height,
    radius,
    k,
    options
) {

    const densityAt =
        options && options.densityAt;

    const bounds =
        (options && options.bounds) || [0, 0, width, height];

    const radiusAt = (x, y) =>
        densityAt
            ? radius / Math.sqrt(Math.max(POISSON_MIN_DENSITY, densityAt(x, y)))
            : radius;

    const maxRadius =
        densityAt ? radius / Math.sqrt(POISSON_MIN_DENSITY) : radius;

    const cellSize =
        radius / Math.sqrt(2);


    const gridWidth =
        Math.ceil(width / cellSize);

    const gridHeight =
        Math.ceil(height / cellSize);


    const grid =
        new Array(gridWidth * gridHeight)
            .fill(null);

    // Each stored point's own spacing radius, by grid cell.
    const gridRadius =
        new Float64Array(gridWidth * gridHeight);


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
            candidate.x < Math.max(0, bounds[0]) ||
            candidate.y < Math.max(0, bounds[1]) ||
            candidate.x >= Math.min(width, bounds[2]) ||
            candidate.y >= Math.min(height, bounds[3])
        ) {
            return false;
        }

        if (densityAt && densityAt(candidate.x, candidate.y) < POISSON_DENSITY_CUTOFF) {
            return false;
        }

        const gx =
            Math.floor(candidate.x / cellSize);

        const gy =
            Math.floor(candidate.y / cellSize);


        // Far enough to see any neighbour whose radius reaches
        // this candidate (2 cells for the uniform case).
        const searchRadius =
            Math.ceil(maxRadius / cellSize);


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

                const r =
                    Math.max(candidate.r, gridRadius[y * gridWidth + x]);


                if (
                    dx * dx +
                    dy * dy <
                    r * r
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

    // Somewhere it may land (with a density, a spot dense enough).
    let firstPoint = null;

    for (let tries = 0; tries < 5000 && !firstPoint; tries++) {

        const x = bounds[0] + Math.random() * (bounds[2] - bounds[0]);
        const y = bounds[1] + Math.random() * (bounds[3] - bounds[1]);

        if (!densityAt || densityAt(x, y) >= POISSON_DENSITY_CUTOFF) {
            firstPoint = { x, y };
        }
    }

    if (!firstPoint) {
        return [];
    }

    const radiusOf = new Map();

    const place = p => {

        const index = gridIndex(p.x, p.y);

        grid[index] = p;
        gridRadius[index] = p.r;

        radiusOf.set(p, p.r);
        delete p.r;

        result.push(p);
        active.push(p);
    };

    firstPoint.r = radiusAt(firstPoint.x, firstPoint.y);

    place(firstPoint);


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
                radiusOf.get(point) *
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

            candidate.r =
                radiusAt(candidate.x, candidate.y);


            if (isValid(candidate)) {

                place(candidate);

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


// Replace the block points with a fresh plain Poisson-disc set
// (spacing R) inside the closed city. Points that land on
// unbuildable ground are dropped, as at close time.
function regenerateCityPoints() {

    if (!cityClosed || boundaryPoints.length < 3) {
        return null;
    }

    R = Number(rSlider.value);
    K = Number(kSlider.value);

    const ring =
        getBoundaryPolygonPoints(200).map(q => [q.x, q.y]);

    const xs = ring.map(q => q[0]);
    const ys = ring.map(q => q[1]);

    const sampled =
        poissonDiscSampling(WORLD_WIDTH, WORLD_HEIGHT, R, K, {
            bounds: [
                Math.min(...xs), Math.min(...ys),
                Math.max(...xs), Math.max(...ys)
            ]
        }).filter(p => d3.polygonContains(ring, [p.x, p.y]));

    points = sampled.filter(p => isLand(p.x, p.y));

    invalidateRoadNetwork();

    return {
        generated: sampled.length,
        kept: points.length
    };
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


    // With a closed city, points only go inside it.
    if (cityClosed) {

        stopRelaxation();

        const info = regenerateCityPoints();

        console.timeEnd("Poisson");

        draw();

        status.textContent =
            `Generated ${info.kept} points inside the city.`;

        logStep(
            `Generated ${info.kept} points inside the city ` +
            `(R=${R}, K=${K}` +
            (info.generated > info.kept
                ? `; ${info.generated - info.kept} on unbuildable ground dropped).`
                : ").")
        );

        return;
    }

    invalidateRoadNetwork();

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
