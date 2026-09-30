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
const urquhartLayer = d3.select("#urquhartLayer");
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

const placeFacilitiesBtn = document.getElementById("placeFacilitiesBtn");

const epochsSlider = document.getElementById("epochsSlider");
const epochsValue = document.getElementById("epochsValue");
const optimizeBtn = document.getElementById("optimizeBtn");

const seaLevelInput = document.getElementById("seaLevelInput");
const sobelToggle = document.getElementById("sobelToggle");
const voronoiToggle = document.getElementById("voronoiToggle");
const urquhartToggle = document.getElementById("urquhartToggle");
const extraEdgeSlider = document.getElementById("extraEdgeSlider");
const extraEdgeValue = document.getElementById("extraEdgeValue");
const pruneToggle = document.getElementById("pruneToggle");
const facilityLinkSlider = document.getElementById("facilityLinkSlider");
const facilityLinkValue = document.getElementById("facilityLinkValue");
const roadStats = document.getElementById("roadStats");
const straightenSlider = document.getElementById("straightenSlider");
const straightenValue = document.getElementById("straightenValue");
const attemptsSlider = document.getElementById("attemptsSlider");
const attemptsValue = document.getElementById("attemptsValue");
const speedSlider = document.getElementById("speedSlider");
const speedValue = document.getElementById("speedValue");
const junctionToggle = document.getElementById("junctionToggle");
const junctionRadiusSlider = document.getElementById("junctionRadiusSlider");
const junctionRadiusValue = document.getElementById("junctionRadiusValue");
const reductionSlider = document.getElementById("reductionSlider");
const reductionValue = document.getElementById("reductionValue");
const simplifyKSlider = document.getElementById("simplifyKSlider");
const simplifyKValue = document.getElementById("simplifyKValue");
const simplifyBtn = document.getElementById("simplifyBtn");

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

// Set whenever something the road network is DERIVED from
// changes: the blocks moved, the boundary changed, facilities
// moved, or a Roads parameter was touched. Zoom and pan do NOT
// set it, so redrawing at a new zoom re-renders the network you
// already have instead of regenerating it - which used to throw
// away every simplification the moment you scrolled.
//
// Declared up here with the other state: loadTerrainFromControls()
// runs at startup and reaches invalidateRoadNetwork(), so a `let`
// further down the file would still be in its temporal dead zone
// and throw.
let roadNetworkDirty = true;


function invalidateRoadNetwork() {
    roadNetworkDirty = true;
}


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

// ============================================================
// FACILITY LAYERS
// ============================================================
//
// Three layers taken from the OpenStreetMap Map Features
// taxonomy, each rendered in its own colour with its own
// Voronoi service areas and Delaunay adjacency graph.
//
// `groups` lists the OSM sub-categories that belong to each
// layer. They are descriptive for now - the generator places
// abstract sites, not tagged OSM objects - but they fix what
// each layer means and are what a future OSM import would
// query against.
//
// Spacing defaults reflect how far apart each kind of thing
// actually sits: emergency services are sparse and strategic,
// amenities mid-density, shops dense.
// ============================================================

const FACILITY_LAYERS = [
    {
        key: "emergency",
        label: "Emergency",
        osmKey: "emergency",
        color: "#FF3B3B",
        fill: "rgba(255, 60, 60, 0.06)",
        spacing: 140,
        groups: [
            "Medical rescue",
            "Firefighters",
            "Lifeguards",
            "Assembly point",
            "Other structure"
        ],
        points: [],
        metric: null,
        stepScale: 1,
        drowned: 0,
        visible: true,
        showCells: true,
        showDelaunay: false
    },
    {
        key: "amenity",
        label: "Amenity",
        osmKey: "amenity",
        color: "#FFC93C",
        fill: "rgba(255, 201, 60, 0.06)",
        spacing: 90,
        groups: [
            "Sustenance",
            "Education",
            "Transportation",
            "Financial",
            "Healthcare",
            "Entertainment, Arts & Culture",
            "Public Service",
            "Facilities",
            "Waste Management"
        ],
        points: [],
        metric: null,
        stepScale: 1,
        drowned: 0,
        visible: true,
        showCells: true,
        showDelaunay: false
    },
    {
        key: "shop",
        label: "Shop",
        osmKey: "shop",
        color: "#B36BFF",
        fill: "rgba(179, 107, 255, 0.06)",
        spacing: 55,
        groups: [
            "Food, beverages",
            "General store, department store, mall",
            "Clothing, shoes, accessories",
            "Discount store, charity",
            "Health and beauty",
            "Do-it-yourself, household, building materials, gardening",
            "Furniture and interior",
            "Electronics",
            "Outdoors and sport, vehicles",
            "Art, music, hobbies",
            "Stationery, gifts, books, newspapers",
            "Others"
        ],
        points: [],
        metric: null,
        stepScale: 1,
        drowned: 0,
        visible: true,
        showCells: true,
        showDelaunay: false
    }
];


function layerByKey(key) {
    return FACILITY_LAYERS.find(l => l.key === key);
}

let optimizing = false;

// Latest evaluated metric, kept so the UI and the optimizer
// can both read it without recomputing.
let currentMetric = null;

// Adaptive move size is tracked per layer (layer.stepScale).


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

    invalidateRoadNetwork();

    boundaryPoints = [];
    cityClosed = false;

    for (const layer of FACILITY_LAYERS) {
        layer.points = [];
        layer.metric = null;
        layer.stepScale = 1;
    }

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


// ============================================================
// DRAW EVERYTHING
// ============================================================

function draw() {

    drawPoints();

    drawBoundary();

    drawVoronoi();

    drawUrquhart();

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
// URQUHART GRAPH — the building network
// ============================================================
//
// Each base point is a building. The Urquhart graph connects
// them into a street-like network:
//
//   1. Triangulate the buildings (Delaunay).
//   2. From every triangle, delete its LONGEST edge.
//   3. Whatever survives is the network.
//
// An edge shared by two triangles is deleted if it is longest
// in either of them.
//
// Why this graph and not the raw Delaunay: Delaunay connects
// far more pairs than a real street layout does, including
// long thin slivers along the boundary. Urquhart strips those
// while provably keeping the network connected - by the MST
// cycle property the longest edge of a triangle can never be
// in the Euclidean minimum spanning tree, so deleting it never
// disconnects anything. EMST is a subgraph of Urquhart, which
// is a subgraph of Delaunay.
//
// (Urquhart proposed it as a cheap approximation of the
// relative neighbourhood graph. The two are not always equal -
// Toussaint later found counterexamples - but it stays a good
// approximation and is far cheaper to build.)
// ============================================================

function computeUrquhartSplit(pts) {

    if (pts.length < 3) {
        return { kept: [], removed: [] };
    }

    const delaunay =
        d3.Delaunay.from(
            pts,
            d => d.x,
            d => d.y
        );

    const triangles = delaunay.triangles;

    const edgeKey = (a, b) =>
        a < b ? `${a},${b}` : `${b},${a}`;

    const lengthSq = (a, b) => {
        const dx = pts[a].x - pts[b].x;
        const dy = pts[a].y - pts[b].y;
        return dx * dx + dy * dy;
    };

    const allEdges = new Map();
    const dropped = new Set();

    for (
        let t = 0;
        t < triangles.length;
        t += 3
    ) {

        const a = triangles[t];
        const b = triangles[t + 1];
        const c = triangles[t + 2];

        const edges = [
            [a, b],
            [b, c],
            [c, a]
        ];

        let longest = -1;
        let longestIndex = 0;

        for (let i = 0; i < 3; i++) {

            const key =
                edgeKey(edges[i][0], edges[i][1]);

            allEdges.set(key, edges[i]);

            const len =
                lengthSq(edges[i][0], edges[i][1]);

            if (len > longest) {
                longest = len;
                longestIndex = i;
            }
        }

        dropped.add(
            edgeKey(
                edges[longestIndex][0],
                edges[longestIndex][1]
            )
        );
    }

    const kept = [];
    const removed = [];

    for (const [key, edge] of allEdges) {

        if (dropped.has(key)) {
            removed.push(edge);
        } else {
            kept.push(edge);
        }
    }

    return { kept, removed };
}


// Convenience wrapper: just the surviving edges.
function computeUrquhartEdges(pts) {
    return computeUrquhartSplit(pts).kept;
}


// ------------------------------------------------------------
// Collect the polygon vertices
// ------------------------------------------------------------
//
// The buildings are the CORNERS of the base Voronoi cells, not
// the generator points. Every corner is a circumcentre where
// three cells meet, so adjacent cells report the same corner
// and the raw sweep contains each one roughly three times -
// hence the dedupe.
//
// cellPolygon() returns a closed ring with the first point
// repeated at the end, so the last entry is skipped.
// ------------------------------------------------------------

// Snap tolerance for treating two corners as the same point.
// Shared circumcentres come back bit-identical, but cells
// clipped against the extent can land a hair apart.
const VERTEX_SNAP = 100;   // 1/100 px

let buildingPoints = [];

function collectPolygonVertices() {

    buildingPoints = [];

    const generators =
        getInsideCityPoints();

    if (generators.length < 3) {
        return buildingPoints;
    }

    const delaunay =
        d3.Delaunay.from(
            generators,
            d => d.x,
            d => d.y
        );

    const voronoi =
        delaunay.voronoi(
            getVoronoiExtent()
        );

    const seen = new Map();

    for (
        let i = 0;
        i < generators.length;
        i++
    ) {

        const cell =
            voronoi.cellPolygon(i);

        if (!cell) {
            continue;
        }

        // Skip the repeated closing vertex.
        for (
            let k = 0;
            k < cell.length - 1;
            k++
        ) {

            const x = cell[k][0];
            const y = cell[k][1];

            const key =
                `${Math.round(x * VERTEX_SNAP)},` +
                `${Math.round(y * VERTEX_SNAP)}`;

            if (!seen.has(key)) {
                seen.set(key, { x, y });
            }
        }
    }

    let corners = [...seen.values()];

    // Same city + land rules the generators obey.
    if (cityClosed && boundaryPoints.length >= 3) {

        const polygon =
            getBoundaryPolygonPoints(200)
                .map(q => [q.x, q.y]);

        if (polygon.length) {

            corners =
                corners.filter(p =>
                    d3.polygonContains(
                        polygon,
                        [p.x, p.y]
                    )
                );
        }
    }

    buildingPoints =
        corners.filter(p => isLand(p.x, p.y));

    return buildingPoints;
}


// ============================================================
// ROAD NETWORK
// ============================================================
//
// The Urquhart graph is the skeleton. Three knobs shape it into
// an actual road network:
//
//   1. DEAD-END PRUNING — repeatedly delete degree-1 nodes.
//      A cul-de-sac is a stretch of road that serves no through
//      traffic, so every cell along it gets "visited" by the
//      network without that visit connecting anything. Removing
//      them is what minimises redundant visits, and because a
//      leaf removal drops one node AND one edge while leaving
//      (e - v) unchanged, it RAISES alpha, beta and gamma at
//      the same time.
//
//   2. EXTRA EDGES — Urquhart throws away the longest edge of
//      every triangle. Adding the shortest of those back, in
//      increasing length order, creates circuits. Circuits are
//      exactly what alpha and gamma measure, so this is the
//      direct lever on connectivity.
//
//   3. FACILITY LINKS — spur each facility into the nearest
//      road nodes. With one link per facility that spur is a
//      dead-end; with two or more it forms a loop, so the
//      facility is reachable by more than one route.
//
// Connectivity indices (standard transport geography, planar):
//
//      v = nodes, e = edges, p = connected components
//
//      beta  = e / v                     edges per node
//      alpha = (e - v + p) / (2v - 5p)   circuits / max circuits
//      gamma = e / (3(v - 2p))           edges / max planar edges
//
// alpha and gamma are both 0..1. A tree scores alpha = 0.
// ============================================================

let roadNetwork = null;


function connectivityIndices(nodeCount, edgeCount, components) {

    const v = nodeCount;
    const e = edgeCount;
    const p = Math.max(1, components);

    if (v < 3) {
        return { v, e, p, alpha: 0, beta: 0, gamma: 0 };
    }

    const alphaDen = 2 * v - 5 * p;
    const gammaDen = 3 * (v - 2 * p);

    return {
        v,
        e,
        p,
        beta: e / v,
        alpha: alphaDen > 0
            ? Math.max(0, (e - v + p) / alphaDen)
            : 0,
        gamma: gammaDen > 0
            ? Math.max(0, e / gammaDen)
            : 0
    };
}


function countComponents(nodeCount, edges) {

    const adj = Array.from({ length: nodeCount }, () => []);

    for (const [a, b] of edges) {
        adj[a].push(b);
        adj[b].push(a);
    }

    const seen = new Array(nodeCount).fill(false);

    let components = 0;

    for (let i = 0; i < nodeCount; i++) {

        if (seen[i]) {
            continue;
        }

        components++;

        const stack = [i];
        seen[i] = true;

        while (stack.length) {

            const v = stack.pop();

            for (const w of adj[v]) {
                if (!seen[w]) {
                    seen[w] = true;
                    stack.push(w);
                }
            }
        }
    }

    return components;
}


// ------------------------------------------------------------
// 1. Dead-end pruning
// ------------------------------------------------------------
//
// Iterative, because removing one leaf can expose another: a
// chain of cul-de-sac segments unwinds one node at a time.
// Returns the surviving node indices and the rewritten edges.

function pruneDeadEnds(nodes, edges) {

    const alive = new Array(nodes.length).fill(true);

    const degree = new Array(nodes.length).fill(0);

    const live = edges.map(() => true);

    const incident =
        Array.from({ length: nodes.length }, () => []);

    edges.forEach(([a, b], i) => {
        degree[a]++;
        degree[b]++;
        incident[a].push(i);
        incident[b].push(i);
    });

    const queue = [];

    for (let i = 0; i < nodes.length; i++) {
        if (degree[i] === 1) {
            queue.push(i);
        }
    }

    let removed = 0;

    while (queue.length) {

        const v = queue.pop();

        if (!alive[v] || degree[v] !== 1) {
            continue;
        }

        alive[v] = false;
        removed++;

        for (const ei of incident[v]) {

            if (!live[ei]) {
                continue;
            }

            live[ei] = false;

            const [a, b] = edges[ei];
            const other = a === v ? b : a;

            degree[other]--;

            if (alive[other] && degree[other] === 1) {
                queue.push(other);
            }
        }
    }

    // Reindex the survivors.
    const remap = new Array(nodes.length).fill(-1);

    const outNodes = [];

    for (let i = 0; i < nodes.length; i++) {
        if (alive[i]) {
            remap[i] = outNodes.length;
            outNodes.push(nodes[i]);
        }
    }

    const outEdges = [];

    edges.forEach(([a, b], i) => {
        if (live[i] && remap[a] >= 0 && remap[b] >= 0) {
            outEdges.push([remap[a], remap[b]]);
        }
    });

    return { nodes: outNodes, edges: outEdges, removed };
}


// ------------------------------------------------------------
// Build the whole thing
// ------------------------------------------------------------

function buildRoadNetwork() {

    const corners =
        collectPolygonVertices();

    if (corners.length < 3) {
        roadNetwork = null;
        return null;
    }

    const split =
        computeUrquhartSplit(corners);

    const lengthOf = (pts, [a, b]) =>
        Math.hypot(
            pts[a].x - pts[b].x,
            pts[a].y - pts[b].y
        );

    // --------------------------------------------------------
    // 2. Add back the shortest of the removed edges
    // --------------------------------------------------------

    const extraPct =
        Number(extraEdgeSlider.value) / 100;

    const reinstated =
        split.removed
            .slice()
            .sort(
                (p, q) =>
                    lengthOf(corners, p) - lengthOf(corners, q)
            )
            .slice(
                0,
                Math.round(split.removed.length * extraPct)
            );

    let nodes = corners.map(p => ({
        x: p.x,
        y: p.y,
        kind: "junction"
    }));

    let edges =
        split.kept
            .concat(reinstated)
            .map(([a, b]) => [a, b]);

    const urquhartEdgeCount = split.kept.length;

    // --------------------------------------------------------
    // 1. Prune cul-de-sacs
    // --------------------------------------------------------

    let prunedNodes = 0;

    if (pruneToggle.checked) {

        const pruned = pruneDeadEnds(nodes, edges);

        nodes = pruned.nodes;
        edges = pruned.edges;
        prunedNodes = pruned.removed;
    }

    const roadNodeCount = nodes.length;
    const roadEdgeCount = edges.length;

    const roadIndices =
        connectivityIndices(
            roadNodeCount,
            roadEdgeCount,
            countComponents(roadNodeCount, edges)
        );

    // --------------------------------------------------------
    // 3. Link the facilities in
    // --------------------------------------------------------

    const linksEach =
        Number(facilityLinkSlider.value);

    const facilityEdges = [];

    let linkedFacilities = 0;

    if (
        linksEach > 0 &&
        roadNodeCount >= 2
    ) {

        const finder =
            d3.Delaunay.from(
                nodes,
                d => d.x,
                d => d.y
            );

        for (const layer of FACILITY_LAYERS) {

            if (!layer.visible) {
                continue;
            }

            for (const facility of layer.points) {

                const index = nodes.length;

                nodes.push({
                    x: facility.x,
                    y: facility.y,
                    kind: "facility",
                    color: layer.color
                });

                // Nearest junction, then walk its Delaunay
                // neighbours outward for the rest, so the
                // extra links fan out instead of stacking on
                // one spot.
                const seed =
                    finder.find(facility.x, facility.y);

                const candidates = [seed];

                for (const n of finder.neighbors(seed)) {
                    candidates.push(n);
                }

                candidates
                    .slice(0, linksEach)
                    .forEach(target => {
                        facilityEdges.push([index, target]);
                    });

                linkedFacilities++;
            }
        }
    }

    const allEdges =
        edges.concat(facilityEdges);

    const fullIndices =
        connectivityIndices(
            nodes.length,
            allEdges.length,
            countComponents(nodes.length, allEdges)
        );

    let totalLength = 0;

    for (const e of allEdges) {
        totalLength += lengthOf(nodes, e);
    }

    roadNetworkDirty = false;

    roadNetwork = {
        nodes,
        edges,
        facilityEdges,
        allEdges,
        roadIndices,
        fullIndices,
        totalLength,
        urquhartEdgeCount,
        reinstated: reinstated.length,
        removedAvailable: split.removed.length,
        prunedNodes,
        linkedFacilities,
        roadNodeCount
    };

    return roadNetwork;
}


// ------------------------------------------------------------
// Draw it
// ------------------------------------------------------------

function drawUrquhart() {

    urquhartLayer.selectAll("*").remove();

    if (!urquhartToggle.checked) {
        updateRoadStats();
        return;
    }

    // Nothing upstream changed - repaint what we already have,
    // simplification and all.
    if (roadNetwork && !roadNetworkDirty) {
        renderRoadNetwork(roadNetwork);
        return;
    }

    const net = buildRoadNetwork();

    if (!net) {
        updateRoadStats();
        return;
    }

    renderRoadNetwork(net);
}


// Draw whatever edges the network currently holds. Kept apart
// from buildRoadNetwork() so simplification can redraw its
// result without regenerating the graph underneath it.
function renderRoadNetwork(net) {

    urquhartLayer.selectAll("*").remove();

    const group =
        urquhartLayer.append("g");

    if (cityClosed) {
        group.attr("clip-path", "url(#cityClip)");
    }

    // One path for the road network - thousands of separate
    // <line> elements would crawl at city scale.
    let d = "";

    for (const [a, b] of net.edges) {
        d +=
            `M${net.nodes[a].x},${net.nodes[a].y}` +
            `L${net.nodes[b].x},${net.nodes[b].y}`;
    }

    if (d) {
        group
            .append("path")
            .attr("class", "urquhart-edge")
            .attr("d", d);
    }

    // Facility spurs, in each facility's own colour.
    if (net.facilityEdges.length) {

        const byColor = new Map();

        for (const [a, b] of net.facilityEdges) {

            const color =
                net.nodes[a].color ||
                net.nodes[b].color ||
                "#ffffff";

            byColor.set(
                color,
                (byColor.get(color) || "") +
                `M${net.nodes[a].x},${net.nodes[a].y}` +
                `L${net.nodes[b].x},${net.nodes[b].y}`
            );
        }

        for (const [color, path] of byColor) {
            group
                .append("path")
                .attr("class", "facility-link")
                .attr("stroke", color)
                .attr("d", path);
        }
    }

    // Ordinary graph nodes.
    const radius =
        Math.max(1.2, 2.5 / zoomScale);

    group
        .selectAll("circle.building-point")
        .data(net.nodes.slice(0, net.roadNodeCount))
        .join("circle")
        .attr("class", "building-point")
        .attr("cx", p => p.x)
        .attr("cy", p => p.y)
        .attr("r", radius);

    // Selected road junctions, drawn larger and on top.
    if (net.junctions && junctionToggle.checked) {

        const jr =
            Math.max(2.6, 5 / zoomScale);

        group
            .selectAll("circle.road-junction")
            .data(
                net.junctions.junctions
                    .filter(i => i < net.nodes.length)
                    .map(i => net.nodes[i])
            )
            .join("circle")
            .attr("class", "road-junction")
            .attr("cx", p => p.x)
            .attr("cy", p => p.y)
            .attr("r", jr);
    }

    updateRoadStats();
}


// ------------------------------------------------------------
// Stats readout
// ------------------------------------------------------------

function updateRoadStats() {

    if (!roadStats) {
        return;
    }

    if (!urquhartToggle.checked) {
        roadStats.textContent =
            "Enable the Building Network layer to measure.";
        return;
    }

    const net = roadNetwork;

    if (!net) {
        roadStats.textContent =
            "Close a city boundary first.";
        return;
    }

    const r = net.roadIndices;
    const f = net.fullIndices;

    roadStats.textContent =
        `Roads  α ${r.alpha.toFixed(3)}  ` +
        `β ${r.beta.toFixed(3)}  γ ${r.gamma.toFixed(3)}\n` +
        `${r.v} junctions · ${r.e} edges · ` +
        `${r.p} component${r.p === 1 ? "" : "s"}\n` +
        `+ facilities  α ${f.alpha.toFixed(3)}  ` +
        `β ${f.beta.toFixed(3)}  γ ${f.gamma.toFixed(3)}\n` +
        `${net.linkedFacilities} linked · ` +
        `${net.facilityEdges.length} spurs\n` +
        `Urquhart ${net.urquhartEdgeCount} + ` +
        `${net.reinstated} reinstated of ` +
        `${net.removedAvailable}\n` +
        `${net.prunedNodes} cul-de-sac nodes pruned · ` +
        `total ${metresLabel(net.totalLength)}` +
        (net.simplified
            ? (net.junctions
                ? `\n${net.junctions.junctions.length} junctions ` +
                  `(r ${net.junctions.radius}, independent)`
                : "") +
              `\nSimplified −${net.simplified.removed} roads` +
              (net.simplified.attempts
                  ? ` (attempt ${net.simplified.attempt}/` +
                    `${net.simplified.attempts})`
                  : "") + ` · ` +
              `−${(100 * (1 - net.simplified.costAfter /
                   net.simplified.costBefore)).toFixed(1)}% length · ` +
              `min degree ${net.simplified.minDegree}`
            : "");
}


// Network size, in metres when scale is known.
function urquhartStats() {

    const net =
        roadNetwork || buildRoadNetwork();

    if (!net) {
        return null;
    }

    return {
        buildings: net.roadNodeCount,
        edges: net.edges.length,
        totalLength: net.totalLength,
        alpha: net.roadIndices.alpha,
        beta: net.roadIndices.beta,
        gamma: net.roadIndices.gamma
    };
}


// ============================================================
// PROBABILISTIC ROAD SIMPLIFICATION
// ============================================================
//
// Removes redundant roads one at a time, probabilistically,
// while never breaking three hard invariants:
//
//     for every cell c:  degree(c) >= 1
//     components(graph) == 1
//     alpha/beta/gamma stay inside their target ranges
//
// A candidate removal is scored by how much it improves the
// graph (dQ), converted to a probability through a sigmoid, and
// then sampled - so the algorithm prefers good removals without
// being deterministic, and two runs give different cities.
//
// "Cell" here means a node of the road graph: a junction, or a
// facility hanging off a spur. Its degree is how many roads
// meet it, and each incident road arrives from its own side.
// ============================================================

// Target ranges. A removal that pushes a metric outside its
// range is rejected outright, which is what stops the process
// from stripping the network down to a tree.
// alpha/beta/gamma are no longer constraints. They are computed
// and reported, but nothing is ever rejected for leaving a
// range. The only hard rules left are structural:
//
//     every cell keeps degree >= 1
//     the graph stays a single component
//
// What decides how far simplification goes is now a direct road
// budget: keep removing until the requested share of total road
// length is gone, or nothing else can safely come out.
//
// Kept only as the reference band the readout compares against.
const SPEC_ALPHA_RANGE = [0.20, 0.45];
const SPEC_BETA_RANGE = [1.30, 1.80];
const SPEC_GAMMA_RANGE = [0.40, 0.60];

// Redundancy that the quality function SOFTLY prefers to keep.
// A soft preference, not a floor: it makes removals that gut
// the network's redundancy less likely, without ever forbidding
// one. Without some term like this the sigmoid saturates at
// P = 1 and the process stops being probabilistic at all.
const ALPHA_REFERENCE = 0.35;


// Weight on total road cost. This is the term that drives
// simplification: every road removed cuts total build length,
// so Q rises. It has to outweigh the residual centre pull in
// rangeScore(), or removals score negative and never fire.
const COST_WEIGHT = 3.0;

// Weight on the road-length penalty in the quality function.
const LENGTH_LAMBDA = 0.35;

// Weight on the side-diversity reward.
const DIVERSITY_WEIGHT = 0.15;

// Sigmoid sharpness. With the cost term in place a single
// removal shifts Q by ~4e-3, so k on the order of 1/|dQ| (a few
// hundred) is what puts probabilities in a useful spread rather
// than pinning them all at 0 or 1.
const DEFAULT_SIGMOID_K = 300;


// ------------------------------------------------------------
// Graph structure
// ------------------------------------------------------------

function makeRoadGraph(nodes, edgeList) {

    const edges =
        edgeList.map(([a, b]) => ({
            a,
            b,
            length: Math.hypot(
                nodes[a].x - nodes[b].x,
                nodes[a].y - nodes[b].y
            ),
            alive: true
        }));

    const graph = {
        nodes,
        edges,
        adj: Array.from({ length: nodes.length }, () => []),
        degree: new Array(nodes.length).fill(0),
        aliveEdges: edges.length,
        maxLength: 0,
        totalLength: 0
    };

    edges.forEach((e, i) => {
        graph.adj[e.a].push(i);
        graph.adj[e.b].push(i);
        graph.degree[e.a]++;
        graph.degree[e.b]++;
        graph.maxLength = Math.max(graph.maxLength, e.length);
        graph.totalLength += e.length;
    });

    if (graph.maxLength === 0) {
        graph.maxLength = 1;
    }

    // Frozen at construction so the cost term measures spend
    // against the ORIGINAL network, not against itself.
    graph.baseTotalLength = graph.totalLength || 1;

    return graph;
}


function setEdgeAlive(graph, index, alive) {

    const e = graph.edges[index];

    if (e.alive === alive) {
        return;
    }

    e.alive = alive;

    const delta = alive ? 1 : -1;

    graph.degree[e.a] += delta;
    graph.degree[e.b] += delta;

    graph.aliveEdges += delta;
    graph.totalLength += delta * e.length;
}


function aliveEdgeList(graph) {

    return graph.edges
        .filter(e => e.alive)
        .map(e => [e.a, e.b]);
}


// ------------------------------------------------------------
// Metrics
// ------------------------------------------------------------

function calculateAlpha(graph) {

    const v = graph.nodes.length;
    const e = graph.aliveEdges;
    const p = countGraphComponents(graph);

    const den = 2 * v - 5 * p;

    return den > 0
        ? Math.max(0, (e - v + p) / den)
        : 0;
}


function calculateBeta(graph) {

    return graph.nodes.length > 0
        ? graph.aliveEdges / graph.nodes.length
        : 0;
}


function calculateGamma(graph) {

    const v = graph.nodes.length;
    const p = countGraphComponents(graph);

    const den = 3 * (v - 2 * p);

    return den > 0
        ? Math.max(0, graph.aliveEdges / den)
        : 0;
}


// ------------------------------------------------------------
// Cell queries
// ------------------------------------------------------------

function getCellDegree(graph, cell) {
    return graph.degree[cell];
}


function isCellConnected(graph, cell) {
    return graph.degree[cell] >= 1;
}


function countGraphComponents(graph) {

    const n = graph.nodes.length;

    if (n === 0) {
        return 0;
    }

    const seen = new Uint8Array(n);

    let components = 0;

    for (let start = 0; start < n; start++) {

        if (seen[start]) {
            continue;
        }

        components++;

        const stack = [start];
        seen[start] = 1;

        while (stack.length) {

            const v = stack.pop();

            for (const ei of graph.adj[v]) {

                const e = graph.edges[ei];

                if (!e.alive) {
                    continue;
                }

                const w = e.a === v ? e.b : e.a;

                if (!seen[w]) {
                    seen[w] = 1;
                    stack.push(w);
                }
            }
        }
    }

    return components;
}


function isGraphConnected(graph) {
    return countGraphComponents(graph) === 1;
}


// ------------------------------------------------------------
// Side awareness
// ------------------------------------------------------------
//
// Each road arrives at a cell from some bearing. Two roads
// leaving the same side are near-duplicates; roads spread
// around the cell give real route diversity.
//
// Diversity = 1 - |mean unit vector of the incident bearings|.
// Evenly spread roads cancel out (diversity -> 1); roads all
// pointing the same way reinforce (diversity -> 0).

function sideOfAngle(angle) {

    const deg = (angle * 180 / Math.PI + 360) % 360;

    if (deg >= 45 && deg < 135) {
        return "SOUTH";
    }

    if (deg >= 135 && deg < 225) {
        return "WEST";
    }

    if (deg >= 225 && deg < 315) {
        return "NORTH";
    }

    return "EAST";
}


function cellConnections(graph, cell) {

    const out = [];

    for (const ei of graph.adj[cell]) {

        const e = graph.edges[ei];

        if (!e.alive) {
            continue;
        }

        const other = e.a === cell ? e.b : e.a;

        const angle =
            Math.atan2(
                graph.nodes[other].y - graph.nodes[cell].y,
                graph.nodes[other].x - graph.nodes[cell].x
            );

        out.push({
            edge: ei,
            other,
            angle,
            side: sideOfAngle(angle),
            length: e.length
        });
    }

    return out;
}


function calculateSideDiversity(graph, cell) {

    const conns = cellConnections(graph, cell);

    if (conns.length < 2) {
        return 0;
    }

    let sx = 0;
    let sy = 0;

    for (const c of conns) {
        sx += Math.cos(c.angle);
        sy += Math.sin(c.angle);
    }

    const resultant =
        Math.hypot(sx, sy) / conns.length;

    return 1 - resultant;
}


// ------------------------------------------------------------
// Quality
// ------------------------------------------------------------
//
// Soft redundancy preference: 1.0 at or above the reference
// alpha, tapering to 0 as the network approaches a tree. No
// hard edges, so it can never veto a removal - it only makes
// removals that strip redundancy score a little worse.
function calculateConnectivityScore(graph) {

    return Math.min(
        1,
        calculateAlpha(graph) / ALPHA_REFERENCE
    );
}


function calculateRoadLengthPenalty(graph, edgeIndex) {

    return graph.edges[edgeIndex].length / graph.maxLength;
}


// Mean normalised road length across the surviving network.
// Dropping a long road lowers this, which raises quality.
function meanLengthPenalty(graph) {

    if (graph.aliveEdges === 0) {
        return 0;
    }

    return (graph.totalLength / graph.aliveEdges) /
        graph.maxLength;
}


function averageSideDiversity(graph) {

    let sum = 0;
    let counted = 0;

    for (let i = 0; i < graph.nodes.length; i++) {

        if (graph.degree[i] >= 2) {
            sum += calculateSideDiversity(graph, i);
            counted++;
        }
    }

    return counted > 0 ? sum / counted : 0;
}


// Total build cost of the surviving network, 0..1 against the
// original. Every removal lowers it; removing a LONG road
// lowers it more.
function calculateNetworkCost(graph) {

    return graph.totalLength / graph.baseTotalLength;
}


function calculateGraphQuality(graph) {

    return calculateConnectivityScore(graph) +
        DIVERSITY_WEIGHT * averageSideDiversity(graph) -
        LENGTH_LAMBDA * meanLengthPenalty(graph) -
        COST_WEIGHT * calculateNetworkCost(graph);
}


// ------------------------------------------------------------
// Hard constraints
// ------------------------------------------------------------

// Populated by simplifyRoadNetwork so a run that removes
// nothing can say exactly which constraint was binding.
let removalRejections = {
    degree: 0,
    disconnect: 0,
    accepted: 0
};

function isValidEdgeRemoval(graph, edgeIndex) {

    const e = graph.edges[edgeIndex];

    if (!e.alive) {
        return false;
    }

    // Never strand a cell: its last road is untouchable.
    if (
        getCellDegree(graph, e.a) <= 1 ||
        getCellDegree(graph, e.b) <= 1
    ) {
        removalRejections.degree++;
        return false;
    }

    // Try it and check the whole graph.
    setEdgeAlive(graph, edgeIndex, false);

    let valid = true;

    // Every cell still has a road.
    for (let i = 0; i < graph.nodes.length; i++) {
        if (!isCellConnected(graph, i)) {
            valid = false;
            break;
        }
    }

    // Still one piece.
    if (valid && !isGraphConnected(graph)) {
        valid = false;
        removalRejections.disconnect++;
    }

    // No alpha/beta/gamma gate. The structural rules above are
    // the only hard constraints; how far the network is allowed
    // to shrink is decided by the road budget in
    // simplifyRoadNetwork(), not by a metric range.

    setEdgeAlive(graph, edgeIndex, true);

    if (valid) {
        removalRejections.accepted++;
    }

    return valid;
}


// ------------------------------------------------------------
// Removal probability
// ------------------------------------------------------------

function calculateRemovalProbability(graph, edgeIndex, k) {

    if (!isValidEdgeRemoval(graph, edgeIndex)) {
        return 0;
    }

    const before = calculateGraphQuality(graph);

    setEdgeAlive(graph, edgeIndex, false);
    const after = calculateGraphQuality(graph);
    setEdgeAlive(graph, edgeIndex, true);

    const dQ = after - before;

    return 1 / (1 + Math.exp(-(k ?? DEFAULT_SIGMOID_K) * dQ));
}


// ------------------------------------------------------------
// Act on one cell
// ------------------------------------------------------------

// ============================================================
// ROAD JUNCTIONS
// ============================================================
//
// Not every node of the Urquhart graph should be a junction.
// A junction wants to sit in an OPEN spot that is RINGED by
// dense building clusters - the corner of a plaza, not a point
// buried inside a tight block. So each node is scored on two
// densities:
//
//   ownDensity(i)        nodes within `radius` of i
//   ringDensity(i)       mean ownDensity of i's graph neighbours
//
//   score(i) = ringDensity(i) - ownDensity(i)
//
// High score = neighbours are crowded, i itself is not. That is
// exactly "surrounds the dense points while sitting in a
// sparser area".
//
// Selection is then greedy by score with one hard rule: a
// junction may never be adjacent to another junction. That
// makes the chosen set independent in the graph, so junctions
// are always separated by at least one ordinary node and never
// clump into a chain.
// ============================================================

function computeLocalDensities(graph, radius) {

    const n = graph.nodes.length;
    const density = new Float64Array(n);
    const r2 = radius * radius;

    // Bucket into a grid so this stays linear-ish instead of
    // comparing every node against every other one.
    const cell = radius || 1;
    const buckets = new Map();

    const keyOf = (x, y) =>
        `${Math.floor(x / cell)},${Math.floor(y / cell)}`;

    graph.nodes.forEach((p, i) => {

        const key = keyOf(p.x, p.y);

        if (!buckets.has(key)) {
            buckets.set(key, []);
        }

        buckets.get(key).push(i);
    });

    for (let i = 0; i < n; i++) {

        const p = graph.nodes[i];

        const gx = Math.floor(p.x / cell);
        const gy = Math.floor(p.y / cell);

        let count = 0;

        for (let dx = -1; dx <= 1; dx++) {

            for (let dy = -1; dy <= 1; dy++) {

                const list =
                    buckets.get(`${gx + dx},${gy + dy}`);

                if (!list) {
                    continue;
                }

                for (const j of list) {

                    if (j === i) {
                        continue;
                    }

                    const q = graph.nodes[j];
                    const ddx = q.x - p.x;
                    const ddy = q.y - p.y;

                    if (ddx * ddx + ddy * ddy <= r2) {
                        count++;
                    }
                }
            }
        }

        density[i] = count;
    }

    return density;
}


function graphNeighbours(graph, cell) {

    const out = [];

    for (const ei of graph.adj[cell]) {

        const e = graph.edges[ei];

        if (!e.alive) {
            continue;
        }

        out.push(e.a === cell ? e.b : e.a);
    }

    return out;
}


function selectRoadJunctions(graph, options) {

    const opts = options || {};

    const radius = opts.radius ?? 40;
    const minDegree = opts.minDegree ?? 2;

    const density =
        computeLocalDensities(graph, radius);

    const scored = [];

    for (let i = 0; i < graph.nodes.length; i++) {

        if (graph.degree[i] < minDegree) {
            continue;
        }

        const nbrs = graphNeighbours(graph, i);

        if (!nbrs.length) {
            continue;
        }

        let ring = 0;

        for (const j of nbrs) {
            ring += density[j];
        }

        ring /= nbrs.length;

        scored.push({
            node: i,
            score: ring - density[i],
            own: density[i],
            ring
        });
    }

    scored.sort((a, b) => b.score - a.score);

    const isJunction =
        new Uint8Array(graph.nodes.length);

    const blocked =
        new Uint8Array(graph.nodes.length);

    const chosen = [];

    for (const candidate of scored) {

        // Hard rule: never adjacent to an existing junction.
        if (blocked[candidate.node]) {
            continue;
        }

        isJunction[candidate.node] = 1;
        chosen.push(candidate);

        for (const j of graphNeighbours(graph, candidate.node)) {
            blocked[j] = 1;
        }
    }

    return {
        junctions: chosen.map(c => c.node),
        isJunction,
        detail: chosen,
        density,
        radius
    };
}


function shuffleInPlace(array, random) {

    for (let i = array.length - 1; i > 0; i--) {

        const j = Math.floor(random() * (i + 1));

        const t = array[i];
        array[i] = array[j];
        array[j] = t;
    }

    return array;
}


function selectAndRemoveRoad(graph, cell, k, rng) {

    const random = rng || Math.random;

    if (getCellDegree(graph, cell) <= 1) {
        return -1;
    }

    // Shuffled, not sorted by length: the length preference is
    // already inside Q via the road-length penalty, so sorting
    // here would apply it twice AND make the walk deterministic.
    // Randomising the order is what makes two runs produce
    // genuinely different cities.
    const candidates =
        shuffleInPlace(cellConnections(graph, cell), random);

    for (const candidate of candidates) {

        const p =
            calculateRemovalProbability(
                graph,
                candidate.edge,
                k
            );

        if (p <= 0) {
            continue;
        }

        if (random() < p) {
            setEdgeAlive(graph, candidate.edge, false);
            return candidate.edge;
        }
    }

    return -1;
}


// ------------------------------------------------------------
// Main loop
// ------------------------------------------------------------

// ============================================================
// STEPWISE SIMPLIFICATION
// ============================================================
//
// Same algorithm as simplifyRoadNetwork(), but broken into
// single steps so it can be driven one frame at a time and
// watched. simplifyRoadNetwork() stays as the synchronous
// version used for testing.
// ============================================================

function createSimplifyRunner(graph, options) {

    const opts = options || {};

    const k = opts.k ?? DEFAULT_SIGMOID_K;
    const rng = opts.rng || Math.random;
    const maxPasses = opts.maxPasses ?? 12;
    const budget = opts.reduction ?? 0.25;

    const junctionSet =
        opts.junctions ? new Set(opts.junctions) : null;

    let pass = 0;
    let order = [];
    let pointer = 0;
    let removedThisPass = 0;
    let removed = 0;
    let done = false;

    function beginPass() {

        order =
            shuffleInPlace(
                graph.nodes
                    .map((_, i) => i)
                    .filter(i => graph.degree[i] >= 2),
                rng
            )
                .sort((a, b) => graph.degree[b] - graph.degree[a])
                .filter(i => !junctionSet || junctionSet.has(i));

        pointer = 0;
        removedThisPass = 0;
        pass++;
    }

    function finish() {
        removed += removedThisPass;
        removedThisPass = 0;
        done = true;
    }

    beginPass();

    return {

        get removed() {
            return removed + removedThisPass;
        },

        get pass() {
            return pass;
        },

        get done() {
            return done;
        },

        // One unit of work. Returns true while there is more.
        step() {

            if (done) {
                return false;
            }

            if (calculateNetworkCost(graph) <= 1 - budget) {
                finish();
                return false;
            }

            if (pointer >= order.length) {

                removed += removedThisPass;

                const stalled = removedThisPass === 0;

                if (stalled || pass >= maxPasses) {
                    removedThisPass = 0;
                    done = true;
                    return false;
                }

                beginPass();
                return true;
            }

            const cell = order[pointer++];

            if (selectAndRemoveRoad(graph, cell, k, rng) >= 0) {
                removedThisPass++;
            }

            return true;
        }
    };
}


function simplifyRoadNetwork(graph, options) {

    const opts = options || {};

    const k = opts.k ?? DEFAULT_SIGMOID_K;
    const rng = opts.rng || Math.random;
    const maxPasses = opts.maxPasses ?? 12;

    // Stop once this much of the original road length is gone.
    const budget = opts.reduction ?? 0.25;

    // When junctionsOnly is set, roads are only pruned AT the
    // selected junctions. Everywhere else the network is left
    // alone, so simplification is concentrated where the
    // junction test said the redundancy actually is.
    const junctionSet =
        opts.junctions
            ? new Set(opts.junctions)
            : null;

    removalRejections = {
        degree: 0,
        disconnect: 0,
        accepted: 0
    };

    const startCost = calculateNetworkCost(graph);

    let removed = 0;
    let passes = 0;

    for (let pass = 0; pass < maxPasses; pass++) {

        passes++;

        // Most-connected cells first: they hold the most
        // redundancy, so that is where simplification pays.
        // Most-connected first, but shuffled within each degree
        // so the sweep order itself is not a hidden bias.
        const order =
            shuffleInPlace(
                graph.nodes
                    .map((_, i) => i)
                    .filter(i => graph.degree[i] >= 2),
                rng
            ).sort(
                (a, b) => graph.degree[b] - graph.degree[a]
            ).filter(
                i => !junctionSet || junctionSet.has(i)
            );

        let removedThisPass = 0;

        for (const cell of order) {

            // Budget spent - stop, even mid-pass.
            if (calculateNetworkCost(graph) <= 1 - budget) {
                break;
            }

            if (selectAndRemoveRoad(graph, cell, k, rng) >= 0) {
                removedThisPass++;
            }
        }

        // Bank this pass's removals BEFORE testing the budget.
        // Breaking first would discard them from the count, so a
        // run that met its budget on pass one reported "removed:
        // 0" while having actually deleted the roads.
        removed += removedThisPass;

        if (calculateNetworkCost(graph) <= 1 - budget) {
            break;
        }

        // Nothing left that is both safe and worth doing.
        if (removedThisPass === 0) {
            break;
        }
    }

    return {
        removed,
        passes,
        rejections: { ...removalRejections },
        costBefore: startCost,
        costAfter: calculateNetworkCost(graph),
        budget,
        budgetMet: calculateNetworkCost(graph) <= 1 - budget,
        alpha: calculateAlpha(graph),
        beta: calculateBeta(graph),
        gamma: calculateGamma(graph),
        components: countGraphComponents(graph),
        minDegree: Math.min(...graph.degree),
        edges: graph.aliveEdges,
        nodes: graph.nodes.length,
        totalLength: graph.totalLength,
        sideDiversity: averageSideDiversity(graph)
    };
}


// ------------------------------------------------------------
// Hook into the app
// ------------------------------------------------------------

// ============================================================
// ROAD STRAIGHTENING
// ============================================================
//
// A final relaxation over the finished network. Nodes where
// exactly two roads meet are mid-chain: they are not junctions,
// just kinks left over from the Voronoi corners the network was
// built from. Each one is nudged toward the midpoint of its two
// neighbours.
//
// Repeated gently, this makes every chain converge on the
// straight line between the junctions that anchor its ends -
// so the segments along a chain drift toward a shared slope
// instead of zig-zagging. Junctions themselves never move, so
// the network's topology, its degrees and its connectivity are
// all untouched; only the geometry relaxes.
//
// The pull is a fraction per iteration, so the change is
// gradual rather than snapping straight.
// ============================================================

function straightenRoadChains(net, strength, anchors) {

    if (!net || !net.edges.length) {
        return 0;
    }

    const nodes = net.nodes;

    // Adjacency over ROAD edges only. Facility spurs are
    // excluded so a spur doesn't drag a chain sideways.
    const neighbours =
        Array.from({ length: nodes.length }, () => []);

    for (const [a, b] of net.edges) {
        neighbours[a].push(b);
        neighbours[b].push(a);
    }

    const fixed = anchors || new Set();

    let moved = 0;

    // Read from a snapshot so every node in this iteration sees
    // the same geometry - otherwise the sweep order biases which
    // way the chain drifts.
    const snapshot =
        nodes.map(p => ({ x: p.x, y: p.y }));

    for (let i = 0; i < nodes.length; i++) {

        // Only mid-chain nodes. Degree 1 is a dead end, degree
        // 3+ is a real junction: both stay put.
        if (neighbours[i].length !== 2) {
            continue;
        }

        if (fixed.has(i)) {
            continue;
        }

        const a = snapshot[neighbours[i][0]];
        const b = snapshot[neighbours[i][1]];

        const targetX = (a.x + b.x) / 2;
        const targetY = (a.y + b.y) / 2;

        const nextX =
            snapshot[i].x + (targetX - snapshot[i].x) * strength;

        const nextY =
            snapshot[i].y + (targetY - snapshot[i].y) * strength;

        // Roads may not wander into the sea.
        if (!isLand(nextX, nextY)) {
            continue;
        }

        nodes[i].x = nextX;
        nodes[i].y = nextY;

        moved++;
    }

    return moved;
}


// How far a chain still deviates from straight: mean distance
// from each mid-chain node to the line through its neighbours.
// Falls toward zero as the chains align.
function chainDeviation(net) {

    if (!net || !net.edges.length) {
        return 0;
    }

    const nodes = net.nodes;

    const neighbours =
        Array.from({ length: nodes.length }, () => []);

    for (const [a, b] of net.edges) {
        neighbours[a].push(b);
        neighbours[b].push(a);
    }

    let sum = 0;
    let count = 0;

    for (let i = 0; i < nodes.length; i++) {

        if (neighbours[i].length !== 2) {
            continue;
        }

        const p = nodes[i];
        const a = nodes[neighbours[i][0]];
        const b = nodes[neighbours[i][1]];

        sum += Math.hypot(
            p.x - (a.x + b.x) / 2,
            p.y - (a.y + b.y) / 2
        );

        count++;
    }

    return count ? sum / count : 0;
}


// ============================================================
// ANIMATED SIMPLIFICATION WITH CHAMPION SELECTION
// ============================================================
//
// Runs several independent attempts. Each attempt starts from
// the SAME untouched network and prunes it with fresh random
// draws, so no two attempts follow the same path. After each
// one the result is scored, and the best network so far is
// kept as the champion. A later attempt replaces it only if it
// scores higher.
//
// Because every attempt spends the same road budget, the
// scores differ almost entirely in what was KEPT - redundancy
// and side diversity - so the champion is the layout that
// preserved the most useful structure for the same spend.
//
// Work is spread across frames so the roads visibly disappear
// rather than snapping to the answer.
// ============================================================

let simplifyRun = null;


function stopSimplification() {

    if (simplifyRun) {
        simplifyRun.cancelled = true;
    }
}


function runRoadSimplification() {

    // Second press while running = stop.
    if (simplifyRun && !simplifyRun.cancelled) {
        stopSimplification();
        return;
    }

    if (!urquhartToggle.checked) {
        status.textContent =
            "Enable the Building Network layer first.";
        return;
    }

    const base = buildRoadNetwork();

    if (!base) {
        status.textContent =
            "Close a city boundary first.";
        return;
    }

    const baseEdges =
        base.allEdges.map(([a, b]) => [a, b]);

    const nodes = base.nodes;

    const reduction =
        Number(reductionSlider.value) / 100;

    const k =
        Number(simplifyKSlider.value);

    const attempts =
        Number(attemptsSlider.value);

    const speed =
        Number(speedSlider.value);

    const useJunctions =
        junctionToggle.checked;

    // Junctions are chosen once, from the untouched network, so
    // every attempt prunes at the same places.
    const scratch =
        makeRoadGraph(nodes, baseEdges);

    const picked =
        selectRoadJunctions(scratch, {
            radius: Number(junctionRadiusSlider.value)
        });

    base.junctions = picked;

    logStep(
        `Junctions: ${picked.junctions.length} selected ` +
        `(radius ${picked.radius}, none adjacent).`
    );

    simplifyBtn.textContent = "Stop";

    const run = {
        cancelled: false,
        attempt: 0,
        graph: null,
        runner: null,
        champion: null,
        startEdges: baseEdges.length
    };

    simplifyRun = run;


    function beginAttempt() {

        run.attempt++;

        run.graph = makeRoadGraph(nodes, baseEdges);

        run.runner =
            createSimplifyRunner(run.graph, {
                k,
                reduction,
                junctions: useJunctions ? picked.junctions : null
            });
    }


    function scoreAttempt(graph) {

        return {
            quality: calculateGraphQuality(graph),
            alive: graph.edges.map(e => e.alive),
            removed: run.runner.removed,
            edges: graph.aliveEdges,
            alpha: calculateAlpha(graph),
            beta: calculateBeta(graph),
            gamma: calculateGamma(graph),
            components: countGraphComponents(graph),
            minDegree: Math.min(...graph.degree),
            totalLength: graph.totalLength,
            cost: calculateNetworkCost(graph),
            diversity: averageSideDiversity(graph)
        };
    }


    // Paint whatever the working graph currently holds.
    function paint(graph) {

        const kept =
            graph.edges
                .filter(e => e.alive)
                .map(e => [e.a, e.b]);

        const facilitySet = new Set(
            base.facilityEdges.map(([a, b]) => `${a},${b}`)
        );

        base.allEdges = kept;

        base.edges =
            kept.filter(([a, b]) => !facilitySet.has(`${a},${b}`));

        renderRoadNetwork(base);
    }


    function applyChampion() {

        const champ = run.champion;

        const kept = [];

        baseEdges.forEach(([a, b], i) => {
            if (champ.alive[i]) {
                kept.push([a, b]);
            }
        });

        const facilitySet = new Set(
            base.facilityEdges.map(([a, b]) => `${a},${b}`)
        );

        base.allEdges = kept;

        base.edges =
            kept.filter(([a, b]) => !facilitySet.has(`${a},${b}`));

        base.facilityEdges =
            kept.filter(([a, b]) => facilitySet.has(`${a},${b}`));

        base.roadIndices =
            connectivityIndices(
                base.roadNodeCount,
                base.edges.length,
                countComponents(base.roadNodeCount, base.edges)
            );

        base.fullIndices =
            connectivityIndices(
                nodes.length,
                kept.length,
                champ.components
            );

        base.totalLength = champ.totalLength;

        base.simplified = {
            removed: champ.removed,
            edges: champ.edges,
            alpha: champ.alpha,
            beta: champ.beta,
            gamma: champ.gamma,
            components: champ.components,
            minDegree: champ.minDegree,
            sideDiversity: champ.diversity,
            costBefore: 1,
            costAfter: champ.cost,
            attempt: champ.attempt,
            attempts: run.attempt
        };

        renderRoadNetwork(base);
    }


    function finishAll() {

        if (!run.champion) {

            simplifyRun = null;
            simplifyBtn.textContent = "Simplify Network";

            paint(makeRoadGraph(nodes, baseEdges));

            status.textContent =
                "Nothing could be removed — every road is either " +
                "a cell's only link or a bridge.";

            logStep("Simplification removed nothing.");

            return;
        }

        applyChampion();

        // Final relaxation: straighten the chains, animated.
        const straightenIterations =
            Number(straightenSlider.value);

        if (straightenIterations > 0) {
            beginStraightening(straightenIterations);
            return;
        }

        report();
    }


    function beginStraightening(iterations) {

        const anchors =
            new Set(picked.junctions);

        const before = chainDeviation(base);

        let i = 0;

        function tick() {

            if (run.cancelled || i >= iterations) {

                logStep(
                    `Straightening: chain deviation ` +
                    `${before.toFixed(2)} → ` +
                    `${chainDeviation(base).toFixed(2)} px ` +
                    `over ${i} iterations.`
                );

                report();
                return;
            }

            straightenRoadChains(base, 0.25, anchors);

            i++;

            renderRoadNetwork(base);

            status.textContent =
                `Straightening roads ${i}/${iterations}...`;

            requestAnimationFrame(tick);
        }

        requestAnimationFrame(tick);
    }


    function report() {

        simplifyRun = null;
        simplifyBtn.textContent = "Simplify Network";

        const c = run.champion;

        const savedPct = 100 * (1 - c.cost);

        status.textContent =
            `Best of ${run.attempt}: −${c.removed} roads ` +
            `(−${savedPct.toFixed(1)}% length) · ` +
            `α ${c.alpha.toFixed(3)} · β ${c.beta.toFixed(3)} · ` +
            `γ ${c.gamma.toFixed(3)}`;

        logStep(
            `Simplification done — attempt ${c.attempt} of ` +
            `${run.attempt} won. ${run.startEdges} → ${c.edges} ` +
            `edges (−${savedPct.toFixed(1)}% length), ` +
            `α ${c.alpha.toFixed(3)}, diversity ` +
            `${c.diversity.toFixed(3)}, min degree ${c.minDegree}, ` +
            `${c.components} component${c.components === 1 ? "" : "s"}.`
        );
    }


    function frame() {

        if (run.cancelled) {
            finishAll();
            return;
        }

        // Advance the current attempt a little.
        for (let i = 0; i < speed; i++) {

            if (!run.runner.step()) {
                break;
            }
        }

        paint(run.graph);

        status.textContent =
            `Attempt ${run.attempt}/${attempts} · ` +
            `−${run.runner.removed} roads` +
            (run.champion
                ? ` · best so far ${run.champion.quality.toFixed(4)} ` +
                  `(attempt ${run.champion.attempt})`
                : "");

        if (run.runner.done) {

            const result = scoreAttempt(run.graph);

            result.attempt = run.attempt;

            // Keep it only if it beats the incumbent.
            const better =
                !run.champion ||
                result.quality > run.champion.quality;

            if (better) {

                run.champion = result;

                logStep(
                    `Attempt ${run.attempt}: quality ` +
                    `${result.quality.toFixed(4)} — new best ` +
                    `(−${result.removed} roads, α ` +
                    `${result.alpha.toFixed(3)}).`
                );

            } else {

                logStep(
                    `Attempt ${run.attempt}: quality ` +
                    `${result.quality.toFixed(4)} — kept ` +
                    `attempt ${run.champion.attempt} instead.`
                );
            }

            if (run.attempt >= attempts) {
                finishAll();
                return;
            }

            beginAttempt();
        }

        requestAnimationFrame(frame);
    }

    beginAttempt();
    requestAnimationFrame(frame);
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

    invalidateRoadNetwork();

    drawPoints();
    drawVoronoi();
    drawUrquhart();
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
// Each of the three layers gets its own Poisson-disc pass at
// its own spacing, then the same city + land filtering the
// block layer uses.
// ============================================================

function placeFacilities() {

    if (!cityClosed || boundaryPoints.length < 3) {
        return;
    }

    const extent =
        getVoronoiExtent();

    const boxWidth = extent[2] - extent[0];
    const boxHeight = extent[3] - extent[1];

    const cityPolygon =
        getBoundaryPolygonPoints(200)
            .map(q => [q.x, q.y]);

    const summary = [];

    for (const layer of FACILITY_LAYERS) {

        const raw =
            poissonDiscSampling(
                boxWidth,
                boxHeight,
                layer.spacing,
                K
            );

        const inCity =
            raw
                .map(p => ({
                    x: p.x + extent[0],
                    y: p.y + extent[1]
                }))
                .filter(p =>
                    d3.polygonContains(
                        cityPolygon,
                        [p.x, p.y]
                    )
                );

        // A facility can no more sit in the ocean than a block.
        layer.points =
            inCity.filter(p => isLand(p.x, p.y));

        layer.drowned =
            inCity.length - layer.points.length;

        layer.stepScale = 1;

        summary.push(
            `${layer.label} ${layer.points.length}`
        );
    }

    invalidateRoadNetwork();

    drawFacilities();

    evaluateMetric();

    const totalDrowned =
        FACILITY_LAYERS.reduce(
            (n, l) => n + (l.drowned || 0),
            0
        );

    logStep(
        `Placed facilities — ${summary.join(", ")}` +
        (totalDrowned > 0
            ? `; rejected ${totalDrowned} below ${seaLevelM} m.`
            : ".")
    );

    status.textContent =
        `${totalFacilityCount()} facilities placed across ` +
        `${FACILITY_LAYERS.length} layers. Run epochs to optimize.`;

    optimizeBtn.disabled =
        !FACILITY_LAYERS.some(l => l.points.length >= 2);
}


function totalFacilityCount() {

    return FACILITY_LAYERS.reduce(
        (n, l) => n + l.points.length,
        0
    );
}


// ============================================================
// DRAW FACILITIES
// ============================================================
//
// Per layer, in its own colour:
//   - Voronoi cells   = that layer's service areas
//   - Delaunay edges  = the adjacency graph dual to those
//                       cells, i.e. which facilities are
//                       neighbours. This is the graph the
//                       load-balancing force runs along, and
//                       the natural road network for the
//                       decongestion work.
// ============================================================

function drawFacilities() {

    facilityVoronoiLayer.selectAll("*").remove();
    facilityPointLayer.selectAll("*").remove();

    for (const layer of FACILITY_LAYERS) {

        if (!layer.visible || !layer.points.length) {
            continue;
        }

        const group =
            facilityVoronoiLayer
                .append("g")
                .attr("data-layer", layer.key);

        if (cityClosed) {
            group.attr("clip-path", "url(#cityClip)");
        }

        if (layer.points.length >= 2) {

            const delaunay =
                d3.Delaunay.from(
                    layer.points,
                    d => d.x,
                    d => d.y
                );

            // ------------------------------------------------
            // Delaunay triangulation
            // ------------------------------------------------

            if (layer.showDelaunay) {

                group
                    .append("path")
                    .attr("class", "facility-delaunay")
                    .attr("stroke", layer.color)
                    .attr("d", delaunay.render());
            }

            // ------------------------------------------------
            // Voronoi service areas
            // ------------------------------------------------

            if (layer.showCells) {

                const voronoi =
                    delaunay.voronoi(
                        getVoronoiExtent()
                    );

                for (
                    let i = 0;
                    i < layer.points.length;
                    i++
                ) {

                    const cell =
                        voronoi.cellPolygon(i);

                    if (!cell) {
                        continue;
                    }

                    group
                        .append("path")
                        .attr("class", "facility-cell")
                        .attr("stroke", layer.color)
                        .attr("fill", layer.fill)
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
        }

        // ----------------------------------------------------
        // Facility markers
        // ----------------------------------------------------

        const radius =
            Math.max(3, 6 / zoomScale);

        facilityPointLayer
            .append("g")
            .attr("data-layer", layer.key)
            .selectAll("circle")
            .data(layer.points)
            .join("circle")
            .attr("class", "facility-point")
            .attr("fill", layer.color)
            .attr("cx", d => d.x)
            .attr("cy", d => d.y)
            .attr("r", radius);
    }
}


// ============================================================
// ASSIGN BLOCK POINTS TO FACILITIES
// ============================================================
//
// Every block point belongs to whichever facility of this layer
// is nearest - which is exactly the Voronoi cell it falls in.
// delaunay.find() gives that index directly, so this avoids any
// point-in-polygon work.
// ============================================================

function assignBlocksToFacilities(layerPoints) {

    const blocks =
        getInsideCityPoints();

    const buckets =
        layerPoints.map(() => []);

    if (!layerPoints.length || !blocks.length) {
        return { blocks, buckets };
    }

    const delaunay =
        d3.Delaunay.from(
            layerPoints,
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

            const dist = Math.hypot(dx, dy);

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
// Measured per facility cell, per layer:
//
//   load   - how many block points fall inside this facility's
//            service area
//   spread - the max distance between any two of those points
//
// A good plan wants loads even across facilities and spreads
// small. Each becomes a 0..1 sub-score:
//
//   loadScore   = 1 / (1 + CV(loads))
//   spreadScore = 1 / (1 + meanSpread / cityDiagonal)
//   score       = 100 * (0.5*loadScore + 0.5*spreadScore)
//
// Each layer is scored independently, because a dense shop
// network and a sparse emergency network should not be forced
// to agree. The headline number is the mean across layers that
// have enough facilities to score.
// ============================================================

const LOAD_WEIGHT = 0.5;
const SPREAD_WEIGHT = 0.5;

function computeLayerMetric(layerPoints) {

    if (layerPoints.length < 2) {
        return null;
    }

    const { blocks, buckets } =
        assignBlocksToFacilities(layerPoints);

    if (!blocks.length) {
        return null;
    }

    const loads = buckets.map(b => b.length);
    const spreads = buckets.map(b => maxPairwiseDistance(b));

    const meanLoad = d3.mean(loads) || 0;

    const loadDeviation =
        meanLoad > 0
            ? (d3.deviation(loads) || 0) / meanLoad
            : 0;

    const loadScore = 1 / (1 + loadDeviation);

    const extent = getVoronoiExtent();

    const cityDiagonal =
        Math.hypot(
            extent[2] - extent[0],
            extent[3] - extent[1]
        ) || 1;

    const meanSpread = d3.mean(spreads) || 0;
    const worstSpread = d3.max(spreads) || 0;

    const spreadScore =
        1 / (1 + (meanSpread / cityDiagonal));

    const score =
        100 * (
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

    let sum = 0;
    let scored = 0;

    for (const layer of FACILITY_LAYERS) {

        layer.metric =
            computeLayerMetric(layer.points);

        if (layer.metric) {
            sum += layer.metric.score;
            scored++;
        }
    }

    currentMetric =
        scored > 0
            ? { score: sum / scored, layers: scored }
            : null;

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

    const lines = [];

    for (const layer of FACILITY_LAYERS) {

        if (!layer.metric) {

            lines.push(
                `${layer.label}: ${layer.points.length} ` +
                `(need 2+ to score)`
            );

            continue;
        }

        const m = layer.metric;

        lines.push(
            `${layer.label}: ${m.score.toFixed(1)} · ` +
            `${layer.points.length} sites · ` +
            `load ${d3.min(m.loads)}-${d3.max(m.loads)} · ` +
            `spread ${metresLabel(m.meanSpread)}`
        );
    }

    const blocks =
        FACILITY_LAYERS.find(l => l.metric);

    if (blocks) {
        lines.push(`${blocks.metric.totalBlocks} blocks served`);
    }

    metricDetail.textContent = lines.join("\n");
}


// Pixels, or real metres once terrain scale is known.
function metresLabel(px) {

    return metresPerPixel
        ? `${Math.round(px * metresPerPixel)} m`
        : `${Math.round(px)} px`;
}


// ============================================================
// ONE OPTIMIZATION EPOCH
// ============================================================
//
// Moves ONLY facility points. Two forces per facility:
//
//   1. Pull toward the centroid of the blocks it serves, which
//      directly shrinks that cell's spread.
//   2. Push along each Delaunay neighbour by the load
//      difference. An overloaded facility drifts toward its
//      lighter neighbours, shrinking its own territory and
//      growing theirs.
//
// Each layer is accepted or rolled back on its OWN score, so a
// layer that has converged stops moving without freezing the
// others.
// ============================================================

const CENTROID_PULL = 0.5;
const BALANCE_PULL = 0.35;

function runLayerEpoch(layer, cityPolygon) {

    if (layer.points.length < 2) {
        return false;
    }

    const before =
        layer.metric || computeLayerMetric(layer.points);

    if (!before) {
        return false;
    }

    const snapshot =
        layer.points.map(p => ({ x: p.x, y: p.y }));

    const delaunay =
        d3.Delaunay.from(
            layer.points,
            d => d.x,
            d => d.y
        );

    const meanLoad = before.meanLoad || 1;

    for (let i = 0; i < layer.points.length; i++) {

        const facility = layer.points[i];
        const served = before.buckets[i];

        let moveX = 0;
        let moveY = 0;

        // ----------------------------------------------------
        // 1. Pull toward the centroid of served blocks
        // ----------------------------------------------------

        if (served.length) {

            moveX +=
                (d3.mean(served, p => p.x) - facility.x) *
                CENTROID_PULL;

            moveY +=
                (d3.mean(served, p => p.y) - facility.y) *
                CENTROID_PULL;
        }

        // ----------------------------------------------------
        // 2. Load balancing against Delaunay neighbours
        // ----------------------------------------------------

        const myLoad = before.loads[i];

        for (const j of delaunay.neighbors(i)) {

            const neighbor = layer.points[j];

            const loadGap =
                (myLoad - before.loads[j]) / meanLoad;

            if (loadGap === 0) {
                continue;
            }

            const dx = neighbor.x - facility.x;
            const dy = neighbor.y - facility.y;

            const dist = Math.hypot(dx, dy);

            if (dist < 1e-6) {
                continue;
            }

            moveX +=
                (dx / dist) * loadGap * BALANCE_PULL * dist * 0.1;

            moveY +=
                (dy / dist) * loadGap * BALANCE_PULL * dist * 0.1;
        }

        const nextX =
            facility.x + moveX * layer.stepScale;

        const nextY =
            facility.y + moveY * layer.stepScale;

        // Facilities must stay inside the city AND on land.
        const insideCity =
            !cityPolygon.length ||
            d3.polygonContains(cityPolygon, [nextX, nextY]);

        if (insideCity && isLand(nextX, nextY)) {
            facility.x = nextX;
            facility.y = nextY;
        }
    }

    const after =
        computeLayerMetric(layer.points);

    if (!after || after.score < before.score) {

        for (let i = 0; i < layer.points.length; i++) {
            layer.points[i].x = snapshot[i].x;
            layer.points[i].y = snapshot[i].y;
        }

        layer.stepScale *= 0.5;

        return false;
    }

    layer.metric = after;

    layer.stepScale =
        Math.min(2, layer.stepScale * 1.05);

    return true;
}


function runEpoch() {

    const cityPolygon =
        getBoundaryPolygonPoints(200)
            .map(q => [q.x, q.y]);

    let improvedAny = false;

    for (const layer of FACILITY_LAYERS) {

        if (runLayerEpoch(layer, cityPolygon)) {
            improvedAny = true;
        }
    }

    // Refresh the aggregate from the per-layer metrics.
    let sum = 0;
    let scored = 0;

    for (const layer of FACILITY_LAYERS) {
        if (layer.metric) {
            sum += layer.metric.score;
            scored++;
        }
    }

    currentMetric =
        scored > 0
            ? { score: sum / scored, layers: scored }
            : null;

    updateMetricDisplay();

    return improvedAny;
}


// ============================================================
// RUN OPTIMIZATION OVER EPOCHS
// ============================================================

function startOptimization(epochs) {

    if (optimizing) {
        return;
    }

    if (!FACILITY_LAYERS.some(l => l.points.length >= 2)) {
        return;
    }

    optimizing = true;

    optimizeBtn.disabled = true;

    for (const layer of FACILITY_LAYERS) {
        layer.stepScale = 1;
    }

    const start =
        (currentMetric || evaluateMetric());

    const startScore = start ? start.score : 0;

    logStep(
        `Optimization started (${epochs} epochs, ` +
        `score ${startScore.toFixed(2)}).`
    );

    let epoch = 0;

    function step() {

        if (!optimizing || epoch >= epochs) {

            finish();
            return;
        }

        const improved = runEpoch();

        epoch++;

        invalidateRoadNetwork();

        drawFacilities();

        status.textContent =
            `Epoch ${epoch}/${epochs} · ` +
            `score ${currentMetric.score.toFixed(2)}`;

        if (
            epoch === 1 ||
            epoch % 10 === 0 ||
            epoch === epochs
        ) {
            logStep(
                `Epoch ${epoch}: ` +
                FACILITY_LAYERS
                    .filter(l => l.metric)
                    .map(l =>
                        `${l.label} ${l.metric.score.toFixed(1)}`
                    )
                    .join(", ")
            );
        }

        // Every layer's step size has collapsed - converged.
        const allStalled =
            !improved &&
            FACILITY_LAYERS.every(
                l => l.points.length < 2 || l.stepScale < 0.01
            );

        if (allStalled) {
            finish(true, epoch);
            return;
        }

        requestAnimationFrame(step);
    }

    function finish(converged, atEpoch) {

        optimizing = false;

        optimizeBtn.disabled = false;

        const endScore =
            currentMetric ? currentMetric.score : startScore;

        if (converged) {

            status.textContent =
                `Converged at epoch ${atEpoch} · ` +
                `score ${endScore.toFixed(2)}`;

            logStep(
                `Converged early at epoch ${atEpoch} ` +
                `(score ${endScore.toFixed(2)}).`
            );

        } else {

            status.textContent =
                `Optimization complete. Score ${endScore.toFixed(2)}.`;

            logStep(
                `Optimization finished after ${epoch} epochs: ` +
                `${startScore.toFixed(2)} -> ${endScore.toFixed(2)} ` +
                `(${endScore - startScore >= 0 ? "+" : ""}` +
                `${(endScore - startScore).toFixed(2)}).`
            );
        }
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


    invalidateRoadNetwork();

    drawBoundary();
    drawPoints();
    drawVoronoi();
    drawUrquhart();

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

        drawUrquhart();

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


        for (const layer of FACILITY_LAYERS) {
            layer.points = [];
            layer.metric = null;
            layer.stepScale = 1;
        }

        currentMetric = null;

        updateMetricDisplay();

        facilityVoronoiLayer.selectAll("*").remove();
        facilityPointLayer.selectAll("*").remove();


        invalidateRoadNetwork();

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

        invalidateRoadNetwork();

        renderTerrain();

        if (cityClosed) {

            const before = points.length;

            points =
                points.filter(p => isLand(p.x, p.y));

            const drowned = before - points.length;

            let facDrowned = 0;

            for (const layer of FACILITY_LAYERS) {

                const n = layer.points.length;

                layer.points =
                    layer.points.filter(p => isLand(p.x, p.y));

                facDrowned += n - layer.points.length;
            }

            if (drowned > 0 || facDrowned > 0) {
                logStep(
                    `Sea level ${seaLevelM} m: removed ${drowned} points` +
                    (facDrowned > 0
                        ? ` and ${facDrowned} facilities.`
                        : ".")
                );
            }

            optimizeBtn.disabled =
                !FACILITY_LAYERS.some(l => l.points.length >= 2);

            draw();
            evaluateMetric();

        } else {

            logStep(`Sea level set to ${seaLevelM} m.`);
        }
    }
);


straightenSlider.addEventListener(
    "input",
    () => {

        straightenValue.textContent =
            straightenSlider.value;
    }
);


attemptsSlider.addEventListener(
    "input",
    () => {

        attemptsValue.textContent =
            attemptsSlider.value;
    }
);


speedSlider.addEventListener(
    "input",
    () => {

        speedValue.textContent =
            speedSlider.value;
    }
);


junctionRadiusSlider.addEventListener(
    "input",
    () => {

        junctionRadiusValue.textContent =
            junctionRadiusSlider.value;
    }
);


junctionToggle.addEventListener(
    "change",
    () => {

        drawUrquhart();
    }
);


reductionSlider.addEventListener(
    "input",
    () => {

        reductionValue.textContent =
            `${reductionSlider.value}%`;
    }
);


simplifyKSlider.addEventListener(
    "input",
    () => {

        simplifyKValue.textContent =
            simplifyKSlider.value;
    }
);


simplifyBtn.addEventListener(
    "click",
    runRoadSimplification
);


extraEdgeSlider.addEventListener(
    "input",
    () => {

        invalidateRoadNetwork();

        extraEdgeValue.textContent =
            `${extraEdgeSlider.value}%`;

        drawUrquhart();
    }
);


pruneToggle.addEventListener(
    "change",
    () => {

        invalidateRoadNetwork();

        drawUrquhart();

        if (roadNetwork) {
            logStep(
                pruneToggle.checked
                    ? `Pruned ${roadNetwork.prunedNodes} cul-de-sac ` +
                      `nodes; α now ` +
                      `${roadNetwork.roadIndices.alpha.toFixed(3)}.`
                    : "Cul-de-sacs restored."
            );
        }
    }
);


facilityLinkSlider.addEventListener(
    "input",
    () => {

        invalidateRoadNetwork();

        facilityLinkValue.textContent =
            facilityLinkSlider.value;

        drawUrquhart();
    }
);


urquhartToggle.addEventListener(
    "change",
    () => {

        drawUrquhart();

        if (!urquhartToggle.checked) {
            logStep("Building network hidden.");
            return;
        }

        const st = urquhartStats();

        logStep(
            st
                ? `Building network: ${st.buildings} cell corners, ` +
                  `${st.edges} edges, total ` +
                  `${metresLabel(st.totalLength)}.`
                : "Building network: not enough cells yet."
        );
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

// ------------------------------------------------------------
// Per-layer spacing sliders (Facilities tab)
// ------------------------------------------------------------

function buildLayerControls() {

    const host =
        document.getElementById("layerControls");

    host.innerHTML = "";

    for (const layer of FACILITY_LAYERS) {

        const wrap = document.createElement("div");
        wrap.className = "layer-control";

        const head = document.createElement("label");

        head.innerHTML =
            `<span><i class="swatch" style="background:${layer.color}"></i>` +
            `${layer.label} spacing</span>` +
            `<span id="sp-${layer.key}">${layer.spacing}</span>`;

        const slider = document.createElement("input");
        slider.type = "range";
        slider.min = "20";
        slider.max = "300";
        slider.value = layer.spacing;

        slider.addEventListener("input", () => {
            layer.spacing = Number(slider.value);
            document.getElementById(`sp-${layer.key}`)
                .textContent = layer.spacing;
        });

        const groups = document.createElement("div");
        groups.className = "layer-groups";
        groups.textContent =
            `${layer.groups.length} OSM groups: ` +
            layer.groups.slice(0, 3).join(", ") +
            (layer.groups.length > 3 ? "…" : "");
        groups.title = layer.groups.join("\n");

        wrap.appendChild(head);
        wrap.appendChild(slider);
        wrap.appendChild(groups);

        host.appendChild(wrap);
    }
}


// ------------------------------------------------------------
// Per-layer visibility toggles (always-visible Layers bar)
// ------------------------------------------------------------

function buildLayerToggles() {

    const host =
        document.getElementById("facilityToggles");

    host.innerHTML = "";

    const header = document.createElement("div");
    header.className = "toggle-grid-head";
    header.innerHTML =
        "<span></span><span>Cells</span><span>Delaunay</span>";
    host.appendChild(header);

    for (const layer of FACILITY_LAYERS) {

        const row = document.createElement("div");
        row.className = "toggle-grid-row";

        const name = document.createElement("label");
        name.className = "layer-name";
        name.innerHTML =
            `<input type="checkbox" ${layer.visible ? "checked" : ""}>` +
            `<i class="swatch" style="background:${layer.color}"></i>` +
            `${layer.label}`;

        name.querySelector("input")
            .addEventListener("change", e => {
                layer.visible = e.target.checked;
                invalidateRoadNetwork();
                drawFacilities();
                // Facility spurs only exist for visible layers,
                // so the road network has to be redrawn too.
                drawUrquhart();
                logStep(
                    `${layer.label} layer ` +
                    (layer.visible ? "shown." : "hidden.")
                );
            });

        const cells = document.createElement("input");
        cells.type = "checkbox";
        cells.checked = layer.showCells;
        cells.title = `${layer.label} Voronoi service areas`;
        cells.addEventListener("change", () => {
            layer.showCells = cells.checked;
            drawFacilities();
        });

        const tri = document.createElement("input");
        tri.type = "checkbox";
        tri.checked = layer.showDelaunay;
        tri.title = `${layer.label} Delaunay triangulation`;
        tri.addEventListener("change", () => {
            layer.showDelaunay = tri.checked;
            drawFacilities();
            logStep(
                `${layer.label} Delaunay ` +
                (layer.showDelaunay ? "shown." : "hidden.")
            );
        });

        row.appendChild(name);
        row.appendChild(cells);
        row.appendChild(tri);

        host.appendChild(row);
    }
}


buildLayerControls();
buildLayerToggles();



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
