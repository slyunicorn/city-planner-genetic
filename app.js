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

const latInput = document.getElementById("latInput");
const lonInput = document.getElementById("lonInput");
const distInput = document.getElementById("distInput");
const sizeSelect = document.getElementById("sizeSelect");
const loadTerrainBtn = document.getElementById("loadTerrainBtn");
const scaleNote = document.getElementById("scaleNote");

const facilityRSlider = document.getElementById("facilityRSlider");
const facilityRValue = document.getElementById("facilityRValue");
const placeFacilitiesBtn = document.getElementById("placeFacilitiesBtn");

const epochsSlider = document.getElementById("epochsSlider");
const epochsValue = document.getElementById("epochsValue");
const optimizeBtn = document.getElementById("optimizeBtn");

const seaLevelInput = document.getElementById("seaLevelInput");
const sobelToggle = document.getElementById("sobelToggle");
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


// Is this point above the configured sea level?
function isLand(x, y) {

    if (!elevationData) {
        return true;
    }

    return getElevationAt(x, y) >= seaLevelM;
}


// ============================================================
// INITIALIZE
// ============================================================
//
// Called once terrain has been fetched and decoded. The world's
// pixel dimensions now come from the decoded elevation grid
// rather than an image's intrinsic size.
// ============================================================

function initialize(width, height) {

    WORLD_WIDTH = width;
    WORLD_HEIGHT = height;

    if (!WORLD_WIDTH || !WORLD_HEIGHT) {

        status.textContent =
            "Terrain has no dimensions.";

        logStep("Error: terrain grid is empty.");

        return;
    }


    // --------------------------------------------------------
    // Set world dimensions
    // --------------------------------------------------------

    world.style.width = `${WORLD_WIDTH}px`;
    world.style.height = `${WORLD_HEIGHT}px`;


    // --------------------------------------------------------
    // Size the map canvas
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

    zoomScale = 1;

    centerWorld();


    // --------------------------------------------------------
    // Generate points
    // --------------------------------------------------------

    generatePoints();


    status.textContent =
        "Click points around the map to create the city boundary.";
}


// ============================================================
// LOAD TERRAIN FROM CONTROLS
// ============================================================

async function loadTerrainFromControls() {

    const lat = Number(latInput.value);
    const lon = Number(lonInput.value);
    const distM = Number(distInput.value);
    const size = Number(sizeSelect.value);

    seaLevelM = Number(seaLevelInput.value) || 0;

    if (
        !Number.isFinite(lat) || lat < -85 || lat > 85 ||
        !Number.isFinite(lon) || lon < -180 || lon > 180
    ) {
        status.textContent =
            "Enter a latitude of -85..85 and a longitude of -180..180.";
        return;
    }

    if (!Number.isFinite(distM) || distM < 100) {
        status.textContent =
            "Radius must be at least 100 m.";
        return;
    }


    loadTerrainBtn.disabled = true;

    // A new map invalidates everything built on the old one.
    stopRelaxation();
    stopOptimization();

    boundaryPoints = [];
    cityClosed = false;
    facilityPoints = [];
    currentMetric = null;

    cityClipPath.attr("d", "");
    voronoiLayer.selectAll("*").remove();
    boundaryLayer.selectAll("*").remove();
    vertexLayer.selectAll("*").remove();
    facilityVoronoiLayer.selectAll("*").remove();
    facilityPointLayer.selectAll("*").remove();

    relaxBtn.disabled = true;
    placeFacilitiesBtn.disabled = true;
    optimizeBtn.disabled = true;

    updateMetricDisplay();


    try {

        const grid =
            await loadTerrain(lat, lon, distM, size);

        renderTerrain();

        initialize(grid.width, grid.height);

        let water = 0;

        for (let i = 0; i < elevationData.length; i++) {

            const m =
                elevationMinM +
                elevationData[i] *
                (elevationMaxM - elevationMinM);

            if (m < seaLevelM) {
                water++;
            }
        }

        const waterPct =
            (100 * water / elevationData.length).toFixed(1);

        scaleNote.textContent =
            `${metresPerPixel.toFixed(1)} m/px · ` +
            `${elevationMinM.toFixed(0)}–${elevationMaxM.toFixed(0)} m · ` +
            `${waterPct}% below ${seaLevelM} m`;

    } catch (err) {

        status.textContent = err.message;

        logStep(`Terrain load failed: ${err.message}`);

        console.error(err);

    } finally {

        loadTerrainBtn.disabled = false;
    }
}


loadTerrainBtn.addEventListener(
    "click",
    loadTerrainFromControls
);


// Load the default view on startup.
loadTerrainFromControls();


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

    // A point belongs to the city only if it is inside the
    // boundary AND on land. The land test is applied every call
    // rather than once at closing time, because relaxation keeps
    // moving points and one can drift below sea level later.
    return points.filter(p =>
        d3.polygonContains(
            polygon,
            [p.x, p.y]
        ) &&
        isLand(p.x, p.y)
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
// FAKE CENTROID (flatness-weighted, then shifted toward blue)
// ============================================================
//
// Two terrain terms, applied in order:
//
//   1. FLATNESS (Sobel). Instead of averaging the cell's
//      vertices equally, each vertex is weighted by how flat
//      the ground is under it. Vertices on flat land pull the
//      centroid hard; vertices on a steep slope barely pull at
//      all. The centroid therefore drifts onto buildable ground
//      without needing a separate force.
//
//   2. ELEVATION (blueness). The flat-weighted centroid is then
//      shifted along the average blue direction, by an amount
//      proportional to how much bluer the cell's ring is than
//      the centroid's own spot, exactly as before.
//
// Formula, for a cell with vertices v1..vn:
//
//   S(p)  = normalised Sobel slope at p      (0 flat .. 1 steep)
//   t(p)  = normalised elevation at p        (0 low  .. 1 high)
//
//   wi    = (1 - S(vi))^GAMMA + EPSILON      flatness weight
//   C     = SUM(wi * vi) / SUM(wi)           flat-biased centroid
//
//   bi    = 1 - t(vi)                        blueness per vertex
//   bmean = mean(bi)
//   bC    = 1 - t(C)
//   dhat  = normalise( SUM( bi * (vi - C)/|vi - C| ) )
//   r     = mean |vi - C|                    cell radius
//
//   C'    = C + dhat * max(0, bmean - bC) * r * STRENGTH
//
// With GAMMA = 0 the weights collapse to 1 and C is the plain
// mean, i.e. the original behaviour.
// ============================================================

// How sharply flat ground is preferred. 0 = ignore slope,
// 1 = linear, higher = only the flattest vertices matter.
const FLATNESS_GAMMA = 2.0;

// Floor so an all-steep cell still has a defined centroid
// rather than dividing by zero.
const FLATNESS_EPSILON = 0.05;

// How far (in cell radii) a full 1.0 blueness difference moves
// the centroid. Higher = more aggressive elevation seeking.
const COLOR_SHIFT_STRENGTH = 1.5;

function getFakeCentroid(polygon) {

    if (!polygon || polygon.length === 0) {
        return null;
    }

    // --------------------------------------------------------
    // 1. Flatness-weighted centroid
    //    wi = (1 - S(vi))^GAMMA + EPSILON
    //    C  = SUM(wi * vi) / SUM(wi)
    // --------------------------------------------------------

    let sumX = 0;
    let sumY = 0;
    let sumW = 0;

    const useSlope =
        slopeData && FLATNESS_GAMMA > 0;

    for (const vertex of polygon) {

        const weight =
            useSlope
                ? Math.pow(
                      1 - getSlopeAt(vertex[0], vertex[1]),
                      FLATNESS_GAMMA
                  ) + FLATNESS_EPSILON
                : 1;

        sumX += vertex[0] * weight;
        sumY += vertex[1] * weight;

        sumW += weight;
    }

    if (sumW <= 0) {
        return null;
    }

    const centroid = {
        x: sumX / sumW,
        y: sumY / sumW
    };

    // Without terrain data there's no height to steer by.
    if (!elevationData) {
        return centroid;
    }

    // --------------------------------------------------------
    // 2. Average blue direction + average blueness of vertices
    // --------------------------------------------------------

    let dirX = 0;
    let dirY = 0;

    let sumBlueness = 0;
    let sumDistance = 0;

    for (const vertex of polygon) {

        // 0 = highest ground, 1 = lowest.
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

        dirX += (dx / dist) * blueness;
        dirY += (dy / dist) * blueness;
    }

    const averageBlueness =
        sumBlueness / polygon.length;

    const cellRadius =
        sumDistance / polygon.length;

    const dirMagnitude =
        Math.hypot(dirX, dirY);

    if (dirMagnitude < 1e-6 || cellRadius < 1e-6) {
        return centroid;
    }

    const centroidBlueness =
        1 - getViridisTAt(centroid.x, centroid.y);

    const difference =
        averageBlueness - centroidBlueness;

    // Already at least as low as its ring - don't drag it.
    if (difference <= 0) {
        return centroid;
    }

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
    // LERP each point toward its cell's fake centroid. That
    // centroid is already colour-steered - getFakeCentroid()
    // shifts it toward the average blue direction by an amount
    // proportional to how much bluer the cell's ring is than
    // the centroid's own spot - so points in yellow areas get
    // a target pulled far toward blue and move fast, while
    // points already on blue ground get a plain geometric
    // centroid and just even out their spacing.
    // insidePoints holds references to the same objects that
    // live in `points`, so mutating them here updates `points`
    // too.
    // --------------------------------------------------------

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

        point.x =
            point.x +
            (centroid.x - point.x) *
            LERP_AMOUNT;

        point.y =
            point.y +
            (centroid.y - point.y) *
            LERP_AMOUNT;

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

    const candidates =
        raw.map(p => ({
            x: p.x + extent[0],
            y: p.y + extent[1]
        }));

    const inCity =
        candidates.filter(p =>
            d3.polygonContains(
                cityPolygon,
                [p.x, p.y]
            )
        );

    // A facility can no more sit in the ocean than a block can.
    facilityPoints =
        inCity.filter(p => isLand(p.x, p.y));

    const drowned =
        inCity.length - facilityPoints.length;

    facilityStepScale = 1;

    drawFacilities();

    evaluateMetric();

    logStep(
        `Placed ${facilityPoints.length} facilities ` +
        `(spacing ${facilityR})` +
        (drowned > 0
            ? `; rejected ${drowned} below ${seaLevelM} m.`
            : ".")
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

        // Facilities must stay inside the city AND on land -
        // the load-balancing force will happily walk one out
        // over a bay otherwise.
        const insideCity =
            !cityPolygon.length ||
            d3.polygonContains(
                cityPolygon,
                [nextX, nextY]
            );

        if (insideCity && isLand(nextX, nextY)) {
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
// CLOSE THE CITY
// ============================================================
//
// Called either by clicking near the first boundary vertex or
// by the Close City Boundary button.
// ============================================================

function closeCity() {

    if (cityClosed || boundaryPoints.length < 3) {
        return false;
    }

    cityClosed = true;


    // Drop every base point that sits below sea level. These are
    // deleted outright, not just hidden, so they stop generating
    // Voronoi cells and stop counting as demand for the metric.
    const beforeCount = points.length;

    points =
        points.filter(p => isLand(p.x, p.y));

    const drowned =
        beforeCount - points.length;


    drawBoundary();
    drawPoints();
    drawVoronoi();

    relaxBtn.disabled = false;
    placeFacilitiesBtn.disabled = false;

    status.textContent =
        "City boundary closed. Press \"Relax Points\" to relax.";

    logStep(
        `City boundary closed (${boundaryPoints.length} vertices)` +
        (drowned > 0
            ? `; removed ${drowned} points below ${seaLevelM} m.`
            : ".")
    );

    return true;
}


closeBtn.addEventListener(
    "click",
    () => {

        if (cityClosed) {
            status.textContent =
                "City is already closed. Use Reset City to start over.";
            return;
        }

        if (boundaryPoints.length < 3) {
            status.textContent =
                "Click at least 3 points on the map first.";
            return;
        }

        closeCity();
    }
);


// ============================================================
// MAP CLICK
// ============================================================

// ============================================================
// PAN + MAP CLICK
// ============================================================
//
// Left-drag pans the world. A left press that moves less than
// CLICK_SLOP pixels is treated as a click instead, so dropping
// boundary points still works exactly as before - you only pan
// when you actually drag.
//
// Middle-drag always pans regardless of distance, which is
// handy once the city is closed and clicks do nothing anyway.
// ============================================================

const CLICK_SLOP = 4;

let panning = false;
let panButton = -1;

let panStartClientX = 0;
let panStartClientY = 0;

let panStartCameraX = 0;
let panStartCameraY = 0;

let panMoved = 0;


function isPanExempt(target) {

    // Never pan when the press started on the panels or on a
    // draggable boundary vertex.
    return (
        target &&
        target.closest &&
        (
            target.closest("#controls") ||
            target.closest("#logPanel") ||
            target.closest(".boundary-vertex")
        )
    );
}


viewport.addEventListener(
    "pointerdown",
    event => {

        if (isPanExempt(event.target)) {
            return;
        }

        if (!WORLD_WIDTH || !WORLD_HEIGHT) {
            return;
        }

        // Left or middle button only.
        if (event.button !== 0 && event.button !== 1) {
            return;
        }

        panning = true;
        panButton = event.button;
        panMoved = 0;

        panStartClientX = event.clientX;
        panStartClientY = event.clientY;

        panStartCameraX = cameraX;
        panStartCameraY = cameraY;

        viewport.setPointerCapture(event.pointerId);

        // Middle-click autoscroll would otherwise hijack this.
        if (event.button === 1) {
            event.preventDefault();
        }
    }
);


viewport.addEventListener(
    "pointermove",
    event => {

        if (!panning) {
            return;
        }

        const dx = event.clientX - panStartClientX;
        const dy = event.clientY - panStartClientY;

        panMoved =
            Math.max(
                panMoved,
                Math.hypot(dx, dy)
            );

        // A left press only becomes a pan once it clears the
        // slop, so small hand tremors don't eat a click.
        if (
            panButton === 0 &&
            panMoved < CLICK_SLOP
        ) {
            return;
        }

        viewport.classList.add("panning");

        cameraX = panStartCameraX + dx;
        cameraY = panStartCameraY + dy;

        updateCamera();
    }
);


function endPan(event) {

    if (!panning) {
        return false;
    }

    panning = false;

    viewport.classList.remove("panning");

    if (viewport.hasPointerCapture(event.pointerId)) {
        viewport.releasePointerCapture(event.pointerId);
    }

    // Did this gesture count as a pan, or as a click?
    return panButton === 0 && panMoved < CLICK_SLOP;
}


viewport.addEventListener(
    "pointerup",
    event => {

        const wasClick = endPan(event);

        if (!wasClick) {
            return;
        }

        handleMapClick(event.clientX, event.clientY);
    }
);


viewport.addEventListener(
    "pointercancel",
    event => {
        endPan(event);
    }
);


// ------------------------------------------------------------
// Dropping / closing boundary points
// ------------------------------------------------------------

function handleMapClick(clientX, clientY) {

    if (!WORLD_WIDTH || !WORLD_HEIGHT) {
        return;
    }


    const p =
        screenToWorld(clientX, clientY);


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

            closeCity();

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


// ------------------------------------------------------------
// Keyboard panning
// ------------------------------------------------------------

window.addEventListener(
    "keydown",
    event => {

        // Don't steal arrow keys from the number inputs and
        // sliders in the control panel.
        const t = event.target;

        if (
            t &&
            (
                t.tagName === "INPUT" ||
                t.tagName === "SELECT" ||
                t.tagName === "TEXTAREA" ||
                t.isContentEditable
            )
        ) {
            return;
        }

        if (!WORLD_WIDTH) {
            return;
        }

        const step = event.shiftKey ? 200 : 60;

        let dx = 0;
        let dy = 0;

        switch (event.key) {
            case "ArrowLeft":  dx = step;  break;
            case "ArrowRight": dx = -step; break;
            case "ArrowUp":    dy = step;  break;
            case "ArrowDown":  dy = -step; break;

            // Re-centre if you lose the map entirely.
            case "0":
            case "Home":
                zoomScale = 1;
                centerWorld();
                drawPoints();
                drawBoundary();
                drawVoronoi();
                drawFacilities();
                event.preventDefault();
                return;

            default:
                return;
        }

        cameraX += dx;
        cameraY += dy;

        updateCamera();

        event.preventDefault();
    }
);


// Middle-click paste/autoscroll on Linux would fight the pan.
viewport.addEventListener(
    "auxclick",
    event => {
        if (event.button === 1) {
            event.preventDefault();
        }
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

seaLevelInput.addEventListener(
    "change",
    () => {

        seaLevelM = Number(seaLevelInput.value) || 0;

        renderTerrain();

        if (cityClosed) {

            const before = points.length;

            points =
                points.filter(p => isLand(p.x, p.y));

            const drowned = before - points.length;

            const facBefore = facilityPoints.length;

            facilityPoints =
                facilityPoints.filter(p => isLand(p.x, p.y));

            const facDrowned =
                facBefore - facilityPoints.length;

            if (drowned > 0 || facDrowned > 0) {
                logStep(
                    `Sea level ${seaLevelM} m: removed ${drowned} points` +
                    (facDrowned > 0
                        ? ` and ${facDrowned} facilities.`
                        : ".")
                );
            }

            optimizeBtn.disabled =
                facilityPoints.length < 2;

            draw();
            evaluateMetric();

        } else {

            logStep(`Sea level set to ${seaLevelM} m.`);
        }
    }
);


sobelToggle.addEventListener(
    "change",
    () => {

        renderTerrain();

        logStep(
            sobelToggle.checked
                ? `Showing Sobel slope map (white = steep, ` +
                  `max ${(slopeMaxRatio * 100).toFixed(0)}% grade).`
                : "Showing elevation map."
        );
    }
);


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
// TABS
// ============================================================

const tabButtons =
    document.querySelectorAll("#tabBar .tab");

const tabPanels =
    document.querySelectorAll("#tabBody .tab-panel");

function showTab(name) {

    tabButtons.forEach(b =>
        b.classList.toggle(
            "active",
            b.dataset.tab === name
        )
    );

    tabPanels.forEach(p =>
        p.classList.toggle(
            "active",
            p.dataset.panel === name
        )
    );
}

tabButtons.forEach(b =>
    b.addEventListener(
        "click",
        () => showTab(b.dataset.tab)
    )
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
