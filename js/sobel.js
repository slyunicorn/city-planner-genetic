// js/sobel.js
// Sobel slope filter over the elevation grid.
// Plain script: shares the global scope with the other js/ files,
// so load order in index.html matters.

// ============================================================
// SOBEL — terrain steepness
// ============================================================
//
// A 3x3 Sobel pass over the elevation grid gives the gradient
// of the ground, i.e. its slope. Run on metres (not on the
// normalised values) and divided by the pixel spacing, the
// magnitude is a real rise/run ratio:
//
//     Gx = [ -1  0  1 ]        Gy = [ -1 -2 -1 ]
//          [ -2  0  2 ] * H         [  0  0  0 ] * H
//          [ -1  0  1 ]             [  1  2  1 ]
//
//     slope = sqrt(Gx^2 + Gy^2) / (8 * metresPerPixel)
//
// The 8 is the Sobel kernel's weight sum, which turns the
// filter response back into a per-metre derivative.
//
// Low slope = flat, buildable ground. The relaxation uses this
// to pull block centroids onto flatter land.
// ============================================================

function computeSobel() {

    if (!elevationMetres) {
        slopeData = null;
        return;
    }

    const w = elevationWidth;
    const h = elevationHeight;

    const raw = new Float32Array(w * h);

    const spacing =
        8 * (metresPerPixel || 1);

    // Clamp to the edge so border pixels get a real value
    // instead of a false cliff against zero.
    const at = (x, y) =>
        elevationMetres[
            Math.min(h - 1, Math.max(0, y)) * w +
            Math.min(w - 1, Math.max(0, x))
        ];

    for (let y = 0; y < h; y++) {

        for (let x = 0; x < w; x++) {

            const tl = at(x - 1, y - 1);
            const tc = at(x,     y - 1);
            const tr = at(x + 1, y - 1);

            const ml = at(x - 1, y);
            const mr = at(x + 1, y);

            const bl = at(x - 1, y + 1);
            const bc = at(x,     y + 1);
            const br = at(x + 1, y + 1);

            const gx =
                (tr + 2 * mr + br) -
                (tl + 2 * ml + bl);

            const gy =
                (bl + 2 * bc + br) -
                (tl + 2 * tc + tr);

            raw[y * w + x] =
                Math.hypot(gx, gy) / spacing;
        }
    }


    // --------------------------------------------------------
    // Normalise against a high percentile, not the maximum: a
    // single cliff or a tile seam would otherwise compress all
    // the real terrain into the bottom of the range.
    // --------------------------------------------------------

    const sorted =
        Float32Array.from(raw).sort();

    const p99 =
        sorted[
            Math.min(
                sorted.length - 1,
                Math.floor(sorted.length * 0.99)
            )
        ] || 1;

    slopeMaxRatio = p99;

    const norm = new Float32Array(raw.length);

    for (let i = 0; i < raw.length; i++) {
        norm[i] = Math.min(1, raw[i] / p99);
    }

    slopeData = norm;
}


// Normalised steepness at a world coordinate.
// 0 = flat, 1 = as steep as anything in view.
function getSlopeAt(x, y) {

    if (!slopeData) {
        return 0;
    }

    const px =
        Math.min(
            elevationWidth - 1,
            Math.max(0, Math.round(x))
        );

    const py =
        Math.min(
            elevationHeight - 1,
            Math.max(0, Math.round(y))
        );

    return slopeData[py * elevationWidth + px];
}
