// js/terrain-render.js
// Viridis ramp, terrain canvas painting, elevation sampling, isLand().
// Plain script: shares the global scope with the other js/ files,
// so load order in index.html matters.

// ------------------------------------------------------------
// Viridis colour ramp (display only)
// ------------------------------------------------------------
//
// Elevation is sampled from elevationData directly, so this ramp
// is only used to paint the visible map.

const VIRIDIS_STOPS = [
    [ 68,   1,  84], [ 72,  40, 120], [ 62,  74, 137],
    [ 49, 104, 142], [ 38, 130, 142], [ 31, 158, 137],
    [ 53, 183, 121], [ 109, 205, 89], [ 180, 222, 44],
    [ 253, 231,  37]
];

function viridisColor(t) {

    const clamped =
        Math.max(0, Math.min(1, t));

    const scaled =
        clamped * (VIRIDIS_STOPS.length - 1);

    const i =
        Math.min(
            VIRIDIS_STOPS.length - 2,
            Math.floor(scaled)
        );

    const f = scaled - i;

    const a = VIRIDIS_STOPS[i];
    const b = VIRIDIS_STOPS[i + 1];

    return [
        a[0] + (b[0] - a[0]) * f,
        a[1] + (b[1] - a[1]) * f,
        a[2] + (b[2] - a[2]) * f
    ];
}


// ------------------------------------------------------------
// Paint the height map onto the visible canvas
// ------------------------------------------------------------

function renderTerrain() {

    if (!elevationData) {
        return;
    }

    mapElement.width = elevationWidth;
    mapElement.height = elevationHeight;

    const ctx =
        mapElement.getContext("2d");

    const img =
        ctx.createImageData(elevationWidth, elevationHeight);

    const showSlope =
        sobelToggle.checked && slopeData;

    for (let i = 0; i < elevationData.length; i++) {

        const p = i * 4;

        if (showSlope) {

            // Steepness as greyscale: black = flat (where the
            // relaxation wants to put blocks), white = steep.
            const v =
                Math.round(slopeData[i] * 255);

            img.data[p] = v;
            img.data[p + 1] = v;
            img.data[p + 2] = v;

        } else if (
            elevationData &&
            elevationMinM +
                elevationData[i] *
                (elevationMaxM - elevationMinM) < seaLevelM
        ) {

            // Below sea level: shade as water so it is obvious
            // which ground the city cannot use. Viridis is blue
            // at its low end too, so without this the drowned
            // area is indistinguishable from merely low land.
            img.data[p] = 12;
            img.data[p + 1] = 38;
            img.data[p + 2] = 74;

        } else {

            const c =
                viridisColor(elevationData[i]);

            img.data[p] = c[0];
            img.data[p + 1] = c[1];
            img.data[p + 2] = c[2];
        }

        img.data[p + 3] = 255;
    }

    ctx.putImageData(img, 0, 0);
}


// ============================================================
// ELEVATION SAMPLING
// ============================================================
//
// The lowest and highest elevations found in the fetched tiles
// (elevationMinM / elevationMaxM) are what the colour ramp's
// blue and yellow ends are pinned to, so the visible gradient
// always spans the full relief of whatever area was loaded.
//
// Height at an arbitrary point is read from the decoded metre
// values directly, NOT by inspecting the rendered pixel colour.
// Same anchors, same gradient - but going back through the
// colour would quantise every height to one of 256 ramp steps
// and then guess which step it was. Reading the array is exact
// and cheaper.
//
// Sampling is bilinear, so a point between grid cells gets an
// interpolated height rather than snapping to whichever pixel
// centre happens to be nearest.
// ============================================================

// Normalised height, 0 = lowest ground in view, 1 = highest.
function getViridisTAt(x, y) {

    if (!elevationData) {
        return 0.5;
    }

    const fx =
        Math.min(elevationWidth - 1, Math.max(0, x));

    const fy =
        Math.min(elevationHeight - 1, Math.max(0, y));

    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);

    const x1 = Math.min(elevationWidth - 1, x0 + 1);
    const y1 = Math.min(elevationHeight - 1, y0 + 1);

    const tx = fx - x0;
    const ty = fy - y0;

    const a = elevationData[y0 * elevationWidth + x0];
    const b = elevationData[y0 * elevationWidth + x1];
    const c = elevationData[y1 * elevationWidth + x0];
    const d = elevationData[y1 * elevationWidth + x1];

    return (
        a * (1 - tx) * (1 - ty) +
        b * tx * (1 - ty) +
        c * (1 - tx) * ty +
        d * tx * ty
    );
}


// ------------------------------------------------------------
// Height of any point, in real metres above sea level
// ------------------------------------------------------------
//
//   height(p) = minM + t(p) * (maxM - minM)
//
// where t is the normalised position along the blue->yellow
// ramp and minM / maxM are the tile extremes from S3.

function getElevationAt(x, y) {

    if (!elevationData) {
        return 0;
    }

    return elevationMinM +
        getViridisTAt(x, y) *
        (elevationMaxM - elevationMinM);
}


// Is this point buildable? Below sea level, or marked
// unbuildable by the land-cover mask (water, forest, desert,
// wetland, mangrove, snow/tundra, riverbank buffer, or steeper
// than the Max slope control), both exclude it.
function isLand(x, y) {

    if (elevationData && getElevationAt(x, y) < seaLevelM) {
        return false;
    }

    if (habMask && !habitableAt(x, y)) {
        return false;
    }

    return true;
}
