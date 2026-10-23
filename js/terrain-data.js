// js/terrain-data.js
// Terrain data: AWS Terrarium tile fetch, stitching and elevation decoding.
// Plain script: shares the global scope with the other js/ files,
// so load order in index.html matters.

// ============================================================
// TERRAIN TILES (AWS Terrarium)
// ============================================================
//
// The height map is fetched live from AWS's public Terrarium
// terrain tiles rather than shipped as a picture. Each tile is
// a 256x256 PNG whose RGB encodes elevation directly:
//
//     elevation_m = (R * 256 + G + B / 256) - 32768
//
// We fetch the tiles covering the requested area, stitch them
// into one offscreen canvas, decode every pixel to metres once,
// and keep a normalised Float32Array. Everything downstream
// samples that array, so there is no colour-matching step at
// all - elevation is read exactly instead of being guessed back
// out of viridis pixels.
// ============================================================

const TILE_URL =
    "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png";

const TILE_PX = 256;
const R_EARTH = 6378137;
const MERC_ORIGIN = Math.PI * R_EARTH;   // 20037508.342789244
const MAX_ZOOM = 15;


// Normalised elevation, 0 = lowest point in view, 1 = highest.
// Same orientation as the old viridis t: 0 is blue, 1 is yellow.
let elevationData = null;

// Raw metres, kept so the Sobel pass can work in real units.
let elevationMetres = null;

// Normalised Sobel gradient magnitude, 0 = perfectly flat,
// 1 = steepest slope in view.
let slopeData = null;

// Steepest slope in view, as a real rise/run ratio, for display.
let slopeMaxRatio = 0;

// Anything strictly below this height counts as water and is
// removed from the city when the boundary closes.
let seaLevelM = 0;

let elevationWidth = 0;
let elevationHeight = 0;

// Real-world scale, so pixel distances can be reported in metres.
let metresPerPixel = 0;

let elevationMinM = 0;
let elevationMaxM = 0;

// The exact Mercator square loadTerrain() cropped the elevation
// grid from. Land cover has to be sampled against this same
// square (not recomputed from lat/lon/dist) so every map pixel
// maps to the same lon/lat loadTerrain() used for that pixel.
let terrainMercCenterX = 0;
let terrainMercCenterY = 0;
let terrainMercHalf = 0;


// ------------------------------------------------------------
// Web Mercator helpers
// ------------------------------------------------------------

function lonToMerc(lon) {
    return (lon * Math.PI / 180) * R_EARTH;
}

function latToMerc(lat) {
    return Math.log(
        Math.tan(Math.PI / 4 + (lat * Math.PI / 180) / 2)
    ) * R_EARTH;
}

function mercToPixel(x, y, z) {
    const scale =
        TILE_PX * Math.pow(2, z) / (2 * MERC_ORIGIN);

    return {
        x: (x + MERC_ORIGIN) * scale,
        y: (MERC_ORIGIN - y) * scale
    };
}

// Metres of ground per tile pixel at this latitude and zoom.
function groundResolution(lat, z) {
    return (2 * MERC_ORIGIN) /
        (TILE_PX * Math.pow(2, z)) *
        Math.cos(lat * Math.PI / 180);
}

// Finest zoom whose native resolution still covers the area
// without needing more tiles than is reasonable.
function pickZoom(lat, distM, targetPx) {
    const want = (2 * distM) / targetPx;

    const z = Math.log2(
        (2 * MERC_ORIGIN) *
        Math.cos(lat * Math.PI / 180) /
        (TILE_PX * want)
    );

    return Math.max(0, Math.min(MAX_ZOOM, Math.ceil(z)));
}


// ------------------------------------------------------------
// Fetch one tile
// ------------------------------------------------------------

function loadTile(z, x, y) {

    return new Promise(resolve => {

        const n = Math.pow(2, z);

        // Off the top or bottom of the world - nothing to fetch.
        if (y < 0 || y >= n) {
            resolve(null);
            return;
        }

        const wrappedX = ((x % n) + n) % n;

        const img = new Image();

        // Required so the stitched canvas stays readable by
        // getImageData(). Without it the canvas is tainted and
        // every pixel read throws a SecurityError.
        img.crossOrigin = "anonymous";

        img.onload = () => resolve(img);

        img.onerror = () => resolve(null);

        img.src = TILE_URL
            .replace("{z}", z)
            .replace("{x}", wrappedX)
            .replace("{y}", y);
    });
}


// ------------------------------------------------------------
// Fetch, stitch and decode an area
// ------------------------------------------------------------

async function loadTerrain(lat, lon, distM, targetPx) {

    const z = pickZoom(lat, distM, targetPx);

    const native = groundResolution(lat, z);
    const want = (2 * distM) / targetPx;

    if (native > want * 1.01) {
        logStep(
            `Note: ${want.toFixed(1)} m/px requested but zoom ${z} is the ` +
            `finest available (${native.toFixed(1)} m/px) - upsampling.`
        );
    }

    // Square in GROUND metres. Mercator stretches by 1/cos(lat),
    // so divide through or the area comes out rectangular.
    const cx = lonToMerc(lon);
    const cy = latToMerc(lat);

    const half =
        distM / Math.cos(lat * Math.PI / 180);

    terrainMercCenterX = cx;
    terrainMercCenterY = cy;
    terrainMercHalf = half;

    const topLeft =
        mercToPixel(cx - half, cy + half, z);

    const bottomRight =
        mercToPixel(cx + half, cy - half, z);

    const x0 = Math.floor(topLeft.x / TILE_PX);
    const x1 = Math.floor(bottomRight.x / TILE_PX);
    const y0 = Math.floor(topLeft.y / TILE_PX);
    const y1 = Math.floor(bottomRight.y / TILE_PX);

    const cols = x1 - x0 + 1;
    const rows = y1 - y0 + 1;
    const total = cols * rows;

    if (total > 256) {
        throw new Error(
            `${total} tiles needed - reduce the radius or resolution.`
        );
    }

    status.textContent =
        `Fetching ${total} terrain tiles (zoom ${z})...`;

    logStep(
        `Loading terrain: ${lat.toFixed(4)}, ${lon.toFixed(4)} ` +
        `±${distM} m, zoom ${z}, ${total} tiles.`
    );


    // --------------------------------------------------------
    // Stitch every tile into one offscreen canvas
    // --------------------------------------------------------

    const mosaic = document.createElement("canvas");

    mosaic.width = cols * TILE_PX;
    mosaic.height = rows * TILE_PX;

    const mctx =
        mosaic.getContext("2d", { willReadFrequently: true });

    // RGB(128,0,0) decodes to exactly 0 m, a sane fill for any
    // tile that fails to load.
    mctx.fillStyle = "rgb(128,0,0)";
    mctx.fillRect(0, 0, mosaic.width, mosaic.height);

    const jobs = [];

    for (let ty = y0; ty <= y1; ty++) {
        for (let tx = x0; tx <= x1; tx++) {
            jobs.push({ tx, ty });
        }
    }

    let loaded = 0;
    let failed = 0;

    await Promise.all(
        jobs.map(async job => {

            const img =
                await loadTile(z, job.tx, job.ty);

            loaded++;

            if (!img) {
                failed++;
            } else {
                mctx.drawImage(
                    img,
                    (job.tx - x0) * TILE_PX,
                    (job.ty - y0) * TILE_PX
                );
            }

            status.textContent =
                `Fetching terrain tiles... ${loaded}/${total}`;
        })
    );

    if (failed === total) {
        throw new Error(
            "No terrain tiles could be loaded - check the network."
        );
    }

    if (failed > 0) {
        logStep(`${failed} of ${total} tiles failed; filled with 0 m.`);
    }


    // --------------------------------------------------------
    // Crop the mosaic to the requested box
    // --------------------------------------------------------

    const cropX = topLeft.x - x0 * TILE_PX;
    const cropY = topLeft.y - y0 * TILE_PX;

    const cropW = bottomRight.x - topLeft.x;
    const cropH = bottomRight.y - topLeft.y;

    const out = document.createElement("canvas");

    out.width = targetPx;
    out.height = targetPx;

    const octx =
        out.getContext("2d", { willReadFrequently: true });

    // Nearest-neighbour: averaging neighbouring pixels would mix
    // the R/G/B channels of the terrarium encoding together and
    // produce elevations that were never actually measured.
    octx.imageSmoothingEnabled = false;

    octx.drawImage(
        mosaic,
        cropX, cropY, cropW, cropH,
        0, 0, targetPx, targetPx
    );

    let pixels;

    try {
        pixels =
            octx.getImageData(0, 0, targetPx, targetPx).data;

    } catch (err) {
        throw new Error(
            "Tile pixels could not be read (CORS). The tile server " +
            "did not send Access-Control-Allow-Origin."
        );
    }


    // --------------------------------------------------------
    // Decode terrarium RGB to metres
    // --------------------------------------------------------

    const metres =
        new Float32Array(targetPx * targetPx);

    let lo = Infinity;
    let hi = -Infinity;

    for (let i = 0; i < metres.length; i++) {

        const p = i * 4;

        const e =
            pixels[p] * 256 +
            pixels[p + 1] +
            pixels[p + 2] / 256 -
            32768;

        metres[i] = e;

        if (e < lo) { lo = e; }
        if (e > hi) { hi = e; }
    }


    // --------------------------------------------------------
    // Normalise to 0..1 for sampling
    // --------------------------------------------------------

    const span = hi > lo ? hi - lo : 1;

    const norm =
        new Float32Array(metres.length);

    for (let i = 0; i < metres.length; i++) {
        norm[i] = (metres[i] - lo) / span;
    }

    elevationData = norm;
    elevationMetres = metres;
    elevationWidth = targetPx;
    elevationHeight = targetPx;

    elevationMinM = lo;
    elevationMaxM = hi;

    metresPerPixel = (2 * distM) / targetPx;

    computeSobel();

    logStep(
        `Terrain ready: ${lo.toFixed(0)}-${hi.toFixed(0)} m over ` +
        `${targetPx}x${targetPx} px (${metresPerPixel.toFixed(1)} m/px), ` +
        `max slope ${(slopeMaxRatio * 100).toFixed(0)}%.`
    );

    return { width: targetPx, height: targetPx };
}
