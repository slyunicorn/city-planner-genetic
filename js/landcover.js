// js/landcover.js
// Land cover: ESA WorldCover / Esri fetch, habitability mask, overlay, legend, hover, hatched cells.
// Plain script: shares the global scope with the other js/ files,
// so load order in index.html matters.

// ============================================================
// LAND COVER (ESA WorldCover) — habitability masking
// ============================================================
//
// Marks water/rivers, forest, desert/bare ground, snow & ice,
// wetland, mangroves and tundra as unbuildable, on top of the
// existing sea-level and Sobel-slope handling. Steep slope is
// recomputed here in real degrees from the already-fetched
// elevationMetres grid (no second elevation fetch needed), and
// combined with a dilated riverbank buffer and the ESA WorldCover
// 10 m land-cover classes fetched live from AWS Open Data.
//
// The mask is built directly in MAP-PIXEL space, at exactly the
// elevation grid's own resolution (elevationWidth x elevationHeight),
// by walking every pixel, converting it back to lon/lat with the
// SAME Mercator square loadTerrain() cropped from
// (terrainMercCenterX/Y/Half), and sampling the fetched WorldCover
// raster at that lon/lat. That keeps land cover pixel-aligned with
// the terrain/elevation grid without needing a second reprojection
// step anywhere else in the app.
//
// Attribution (kept visible in the legend panel):
//   (c) ESA WorldCover project 2021 / Contains modified Copernicus
//   Sentinel data (2021) processed by ESA WorldCover consortium.
// ============================================================

const CLASSES = {
    10:  { name: "Forest / tree cover",        color: "#1b7837", habitable: false },
    20:  { name: "Shrubland",                  color: "#a6a144", habitable: true  },
    30:  { name: "Grassland",                  color: "#c7e07a", habitable: true  },
    40:  { name: "Cropland",                   color: "#f0c84b", habitable: true  },
    50:  { name: "Built-up",                   color: "#c0504d", habitable: true  },
    60:  { name: "Bare / desert / wasteland",  color: "#d8c39a", habitable: false },
    70:  { name: "Snow & ice",                 color: "#e8f4fa", habitable: false },
    80:  { name: "Water / river / lake",       color: "#2166ac", habitable: false },
    90:  { name: "Wetland / marsh",            color: "#4fa3a5", habitable: false },
    95:  { name: "Mangroves",                  color: "#0d5c46", habitable: false },
    100: { name: "Moss & lichen (tundra)",     color: "#b3c9a8", habitable: false },
    0:   { name: "No land-cover data",         color: "#666666", habitable: true  },
    // generated locally:
    81:  { name: "Riverbank buffer",           color: "#6fa8dc", habitable: false },
    250: { name: "Too steep",                  color: "#7f4f24", habitable: false }
};

const WC_BASE =
    "https://esa-worldcover.s3.eu-central-1.amazonaws.com/v200/2021/map/";

// The habitability grid in map-pixel space. null until a land
// cover fetch succeeds. { cols, rows, code: Uint8Array, blocked: Uint8Array }
let habMask = null;

// The raw fetched land-cover raster in lon/lat space, kept so the
// slope/river-buffer sliders can rebuild the mask without another
// network fetch. { data, cols, rows, bbox }
let landCoverEquirectCache = null;

// Bumped by every land cover request and every terrain load. A
// fetch whose id is no longer current was superseded (new area or
// newer request) and its result is thrown away.
let landCoverRequestId = 0;


let geotiffModulePromise = null;

function loadGeotiffLib() {

    if (!geotiffModulePromise) {

        geotiffModulePromise =
            import("https://cdn.jsdelivr.net/npm/geotiff@2.1.3/+esm");
    }

    return geotiffModulePromise;
}


// Inverse of lonToMerc/latToMerc.
function mercToLatLon(x, y) {

    return {

        lon: (x / R_EARTH) * (180 / Math.PI),

        lat:
            (2 * Math.atan(Math.exp(y / R_EARTH)) - Math.PI / 2) *
            (180 / Math.PI)
    };
}


// Every map pixel, converted back to lon/lat through the SAME
// Mercator square the elevation grid was cropped from.
function pixelToLatLon(x, y) {

    const w = elevationWidth || WORLD_WIDTH;
    const h = elevationHeight || WORLD_HEIGHT;

    const mercX =
        (terrainMercCenterX - terrainMercHalf) +
        (x / Math.max(1, w - 1)) * (2 * terrainMercHalf);

    const mercY =
        (terrainMercCenterY + terrainMercHalf) -
        (y / Math.max(1, h - 1)) * (2 * terrainMercHalf);

    return mercToLatLon(mercX, mercY);
}


// Bounding box (lon/lat, with a small margin) of the Mercator
// square currently loaded, for the WorldCover fetch.
function computeLandCoverBBox() {

    const corners = [
        mercToLatLon(terrainMercCenterX - terrainMercHalf, terrainMercCenterY - terrainMercHalf),
        mercToLatLon(terrainMercCenterX - terrainMercHalf, terrainMercCenterY + terrainMercHalf),
        mercToLatLon(terrainMercCenterX + terrainMercHalf, terrainMercCenterY - terrainMercHalf),
        mercToLatLon(terrainMercCenterX + terrainMercHalf, terrainMercCenterY + terrainMercHalf)
    ];

    const lats = corners.map(c => c.lat);
    const lons = corners.map(c => c.lon);

    let south = Math.min(...lats);
    let north = Math.max(...lats);
    let west = Math.min(...lons);
    let east = Math.max(...lons);

    const latPad = (north - south) * 0.03;
    const lonPad = (east - west) * 0.03;

    return {
        south: south - latPad,
        north: north + latPad,
        west: west - lonPad,
        east: east + lonPad
    };
}


function wcTileName(latLL, lonLL) {

    const ns = latLL >= 0 ? "N" : "S";
    const ew = lonLL >= 0 ? "E" : "W";

    return (
        `${ns}${String(Math.abs(latLL)).padStart(2, "0")}` +
        `${ew}${String(Math.abs(lonLL)).padStart(3, "0")}`
    );
}


// ------------------------------------------------------------
// Read the part of one WorldCover GeoTIFF that overlaps the bbox
// into the shared equirectangular output raster. Works for both
// a remote COG (range requests) and a local file the person
// supplied, since both are just geotiff.js GeoTIFF objects.
// ------------------------------------------------------------

async function paintTiffInto(out, tiff, bbox, cols, rows) {

    const { west, south, east, north } = bbox;

    const dx = (east - west) / cols;
    const dy = (north - south) / rows;

    const image = await tiff.getImage();

    const [tx0, ty0, tx1, ty1] = image.getBoundingBox();

    const ix0 = Math.max(west, tx0);
    const ix1 = Math.min(east, tx1);
    const iy0 = Math.max(south, ty0);
    const iy1 = Math.min(north, ty1);

    if (ix1 <= ix0 || iy1 <= iy0) {
        return 0;
    }

    const c0 = Math.max(0, Math.round((ix0 - west) / dx));
    const c1 = Math.min(cols, Math.round((ix1 - west) / dx));
    const r0 = Math.max(0, Math.round((north - iy1) / dy));
    const r1 = Math.min(rows, Math.round((north - iy0) / dy));

    if (c1 <= c0 || r1 <= r0) {
        return 0;
    }

    const w = c1 - c0;
    const h = r1 - r0;

    // Keep the window inside the image after rounding.
    const sub = [
        Math.max(tx0, west + c0 * dx),
        Math.max(ty0, north - r1 * dy),
        Math.min(tx1, west + c1 * dx),
        Math.min(ty1, north - r0 * dy)
    ];

    const data = await tiff.readRasters({
        bbox: sub,
        width: w,
        height: h,
        samples: [0],
        interleave: true,
        resampleMethod: "nearest"
    });

    for (let r = 0; r < h; r++) {
        out.set(
            data.subarray(r * w, (r + 1) * w),
            (r0 + r) * cols + c0
        );
    }

    return w * h;
}


// ------------------------------------------------------------
// Fallback source: Esri's Sentinel-2 10 m Land Cover service.
// ArcGIS image services send CORS headers, so a plain browser
// fetch works where the raw WorldCover bucket may not. One
// exportImage request returns the whole bbox as a raw class
// raster, which is remapped onto the WorldCover codes used here.
// ------------------------------------------------------------

const ESRI_LC_URL =
    "https://ic.imagery1.arcgis.com/arcgis/rest/services/" +
    "Sentinel2_10m_LandCover/ImageServer/exportImage";

// Esri value -> WorldCover code (0 = no data / clouds)
const ESRI_TO_WC = {
    1: 80, 2: 10, 4: 90, 5: 40, 7: 50,
    8: 60, 9: 70, 10: 0, 11: 30
};

// fetch() that gives up after `ms` so a hung service cannot freeze
// the loader for minutes (the Esri call once sat for ~90 s).
async function fetchWithTimeout(url, options = {}, ms = 25000) {

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ms);

    try {

        return await fetch(url, { ...options, signal: controller.signal });

    } catch (err) {

        if (err.name === "AbortError") {
            throw new Error(`timed out after ${Math.round(ms / 1000)} s`);
        }

        // A bare "Failed to fetch" is what the browser reports for a
        // CORS block, an offline network or a blocked host.
        throw new Error(`${err.message} (blocked, offline or CORS)`);

    } finally {

        clearTimeout(timer);
    }
}


// Esri palette, used only if the service answers with a coloured
// image instead of raw class values.
const ESRI_PALETTE = [
    [80, [65, 155, 223]],  [10, [57, 125, 73]],   [90, [122, 135, 198]],
    [40, [228, 150, 53]],  [50, [196, 40, 27]],   [60, [165, 155, 143]],
    [70, [168, 235, 255]], [0,  [97, 97, 97]],    [30, [227, 226, 195]]
];

function nearestEsriClass(r, g, b) {

    let best = 0;
    let bestD = Infinity;

    for (const [code, [pr, pg, pb]] of ESRI_PALETTE) {

        const d =
            (r - pr) * (r - pr) +
            (g - pg) * (g - pg) +
            (b - pb) * (b - pb);

        if (d < bestD) {
            bestD = d;
            best = code;
        }
    }

    return best;
}


async function esriRequest(bbox, size, extra) {

    const { fromArrayBuffer } = await loadGeotiffLib();

    const { west, south, east, north } = bbox;

    const url =
        `${ESRI_LC_URL}?bbox=${west},${south},${east},${north}` +
        `&bboxSR=4326&imageSR=4326&size=${size},${size}` +
        `&format=tiff&interpolation=RSP_NearestNeighbor${extra}&f=image`;

    const res = await fetchWithTimeout(url);

    if (!res.ok) {
        throw new Error(`Esri service returned HTTP ${res.status}`);
    }

    const type = res.headers.get("content-type") || "";

    if (type.includes("json") || type.includes("html")) {

        const text = await res.text();

        let msg = text.slice(0, 120);

        try { msg = JSON.parse(text)?.error?.message || msg; } catch (e) { /* keep text */ }

        throw new Error(`Esri service error: ${msg}`);
    }

    const tiff = await fromArrayBuffer(await res.arrayBuffer());
    const image = await tiff.getImage();

    return {
        w: image.getWidth(),
        h: image.getHeight(),
        samples: image.getSamplesPerPixel(),
        raw: await image.readRasters({ interleave: true })
    };
}


async function fetchLandCoverEsri(bbox, cols, rows) {

    // Attempt A: raw class values. Attempt B: whatever the service
    // renders by default (usually a colour map), matched to classes.
    // A smaller request is tried too, since big exports can time out.
    const attempts = [
        [384, `&pixelType=U8&renderingRule=${encodeURIComponent('{"rasterFunction":"None"}')}`],
        [256, ""],
        [256, `&pixelType=U8&renderingRule=${encodeURIComponent('{"rasterFunction":"None"}')}`]
    ];

    const errors = [];

    for (const [size, extra] of attempts) {

        try {

            const { w, h, samples, raw } = await esriRequest(bbox, size, extra);

            const out = new Uint8Array(cols * rows);

            let known = 0;

            for (let r = 0; r < rows; r++) {

                const sr = Math.min(h - 1, Math.floor(r * h / rows));

                for (let c = 0; c < cols; c++) {

                    const sc = Math.min(w - 1, Math.floor(c * w / cols));
                    const i = sr * w + sc;

                    let code;

                    if (samples === 1) {

                        code = ESRI_TO_WC[raw[i]] || 0;

                    } else {

                        // Interleaved RGB(A); pure black/transparent = no data.
                        const R = raw[i * samples];
                        const G = raw[i * samples + 1];
                        const B = raw[i * samples + 2];
                        const A = samples > 3 ? raw[i * samples + 3] : 255;

                        code = (A === 0 || (R === 0 && G === 0 && B === 0))
                            ? 0
                            : nearestEsriClass(R, G, B);
                    }

                    if (code !== 0) known++;

                    out[r * cols + c] = code;
                }
            }

            if (known === 0) {
                throw new Error("service returned only no-data for this area");
            }

            return out;

        } catch (err) {

            errors.push(err.message);
        }
    }

    throw new Error(errors.join("; "));
}


// ------------------------------------------------------------
// Local OSM server (tools/serve.py). Builds the land cover from a
// downloaded Geofabrik extract, so it works when every live source
// is blocked. The build can take minutes (longer the first time a
// region is downloaded), so it runs as a job that is polled.
// ------------------------------------------------------------

async function fetchLandCoverServer(bbox, cols, rows, isCurrent) {

    const { fromArrayBuffer } = await loadGeotiffLib();

    const { west, south, east, north } = bbox;

    const q = new URLSearchParams({ west, south, east, north });

    // Say which page origin was asked, so a tab opened from file://
    // or from another static server is obvious from the message.
    const origin =
        location.protocol === "file:" ? "file://" : location.origin;

    if (location.protocol === "file:") {
        throw new Error(
            "page opened as file:// - open http://localhost:8000/ " +
            "(tools/serve.py) instead"
        );
    }

    let res;

    try {
        res = await fetchWithTimeout(`/api/landcover/start?${q}`, {}, 15000);
    } catch (err) {
        throw new Error(
            `no answer from ${origin}/api (${err.message}) - ` +
            "is tools/serve.py running?"
        );
    }

    if (res.status === 404 || res.status === 501) {
        throw new Error(
            `${origin} has no /api (HTTP ${res.status}) - this page is ` +
            "served by something other than tools/serve.py; open " +
            "http://localhost:8000/"
        );
    }

    const start = await res.json();

    if (!res.ok) {
        throw new Error(start.error || `HTTP ${res.status}`);
    }

    const t0 = Date.now();

    for (;;) {

        if (!isCurrent()) {
            throw new Error("superseded by a newer request");
        }

        const s = await (
            await fetchWithTimeout(`/api/landcover/status?id=${start.id}`, {}, 10000)
        ).json();

        if (s.state === "error") {
            throw new Error(s.message);
        }

        if (s.state === "done") {
            break;
        }

        landCoverNote.textContent =
            `Local OSM server: ${s.message} ` +
            `(${Math.round((Date.now() - t0) / 1000)} s)`;

        await new Promise(r => setTimeout(r, 1500));
    }

    const file =
        await fetchWithTimeout(`/api/landcover/result?id=${start.id}`, {}, 60000);

    if (!file.ok) {
        throw new Error(`result HTTP ${file.status}`);
    }

    const tiff = await fromArrayBuffer(await file.arrayBuffer());

    const out = new Uint8Array(cols * rows);

    if (!(await paintTiffInto(out, tiff, bbox, cols, rows))) {
        throw new Error("server file does not cover this area");
    }

    return out;
}


// ------------------------------------------------------------
// Third source: OpenStreetMap through the Overpass API (CORS
// enabled). Not a satellite classification: it is what mappers
// drew, so unmapped ground stays "no data". Polygons are filled
// by an even-odd scanline so lakes with islands keep their holes.
// ------------------------------------------------------------

const OVERPASS_URLS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter"
];

const OSM_NATURAL = {
    water: 80, wetland: 90, wood: 10, scrub: 20, heath: 20,
    grassland: 30, bare_rock: 60, sand: 60, scree: 60, beach: 60,
    mud: 60, glacier: 70
};

const OSM_LANDUSE = {
    forest: 10, farmland: 40, farmyard: 40, orchard: 40, vineyard: 40,
    meadow: 30, grass: 30, residential: 50, industrial: 50,
    commercial: 50, retail: 50, construction: 50, brownfield: 50,
    cemetery: 50, military: 50, quarry: 60
};

// Draw low-priority classes first so water ends up on top.
const OSM_DRAW_ORDER = [20, 30, 40, 60, 10, 50, 90, 70, 80];

function osmClassOf(tags) {

    if (!tags) return null;

    if (tags.natural && OSM_NATURAL[tags.natural]) return OSM_NATURAL[tags.natural];
    if (tags.landuse && OSM_LANDUSE[tags.landuse]) return OSM_LANDUSE[tags.landuse];
    if (tags.waterway === "riverbank") return 80;

    return null;
}

// Join a relation's member ways into closed rings by endpoints.
function osmAssembleRings(ways) {

    const key = p => `${p.lat},${p.lon}`;

    const rings = [];
    const open = [];

    for (const w of ways) {

        if (!w || w.length < 2) continue;

        if (key(w[0]) === key(w[w.length - 1])) {
            rings.push(w);
        } else {
            open.push(w.slice());
        }
    }

    while (open.length) {

        let chain = open.pop();
        let grew = true;

        while (grew && key(chain[0]) !== key(chain[chain.length - 1])) {

            grew = false;

            for (let i = 0; i < open.length; i++) {

                const w = open[i];
                const head = key(chain[0]);
                const tail = key(chain[chain.length - 1]);

                if (key(w[0]) === tail) {
                    chain = chain.concat(w.slice(1));
                } else if (key(w[w.length - 1]) === tail) {
                    chain = chain.concat(w.slice().reverse().slice(1));
                } else if (key(w[w.length - 1]) === head) {
                    chain = w.concat(chain.slice(1));
                } else if (key(w[0]) === head) {
                    chain = w.slice().reverse().concat(chain.slice(1));
                } else {
                    continue;
                }

                open.splice(i, 1);
                grew = true;
                break;
            }
        }

        // Even an unclosed chain is kept: it is closed implicitly by
        // the fill, which is right for a lake cut by the bbox edge.
        rings.push(chain);
    }

    return rings;
}

// Even-odd scanline fill of several rings (grid coordinates).
function fillRings(out, cols, rows, rings, code) {

    let minY = Infinity;
    let maxY = -Infinity;

    for (const ring of rings) {
        for (const p of ring) {
            if (p.y < minY) minY = p.y;
            if (p.y > maxY) maxY = p.y;
        }
    }

    const y0 = Math.max(0, Math.floor(minY));
    const y1 = Math.min(rows - 1, Math.ceil(maxY));

    for (let y = y0; y <= y1; y++) {

        const cy = y + 0.5;
        const xs = [];

        for (const ring of rings) {

            for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {

                const a = ring[j];
                const b = ring[i];

                if ((a.y <= cy) !== (b.y <= cy)) {
                    xs.push(a.x + (cy - a.y) * (b.x - a.x) / (b.y - a.y));
                }
            }
        }

        xs.sort((p, q) => p - q);

        for (let k = 0; k + 1 < xs.length; k += 2) {

            const x0 = Math.max(0, Math.round(xs[k]));
            const x1 = Math.min(cols - 1, Math.round(xs[k + 1]) - 1);

            for (let x = x0; x <= x1; x++) {
                out[y * cols + x] = code;
            }
        }
    }
}

function stampLine(out, cols, rows, pts, code, radius) {

    for (let i = 1; i < pts.length; i++) {

        const a = pts[i - 1];
        const b = pts[i];

        const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) * 2));

        for (let s = 0; s <= steps; s++) {

            const x = Math.round(a.x + (b.x - a.x) * s / steps);
            const y = Math.round(a.y + (b.y - a.y) * s / steps);

            for (let dy = -radius; dy <= radius; dy++) {
                for (let dx = -radius; dx <= radius; dx++) {

                    const xx = x + dx;
                    const yy = y + dy;

                    if (xx >= 0 && yy >= 0 && xx < cols && yy < rows) {
                        out[yy * cols + xx] = code;
                    }
                }
            }
        }
    }
}

async function fetchLandCoverOsm(bbox, cols, rows) {

    const { west, south, east, north } = bbox;

    const box = `${south},${west},${north},${east}`;

    const nat = Object.keys(OSM_NATURAL).join("|");
    const lu = Object.keys(OSM_LANDUSE).join("|");

    const query =
        `[out:json][timeout:25];(` +
        `way["natural"~"^(${nat})$"](${box});` +
        `way["landuse"~"^(${lu})$"](${box});` +
        `way["waterway"="riverbank"](${box});` +
        `way["waterway"~"^(river|canal|stream)$"](${box});` +
        `relation["natural"~"^(${nat})$"](${box});` +
        `relation["landuse"~"^(${lu})$"](${box});` +
        `relation["waterway"="riverbank"](${box});` +
        `);out geom;`;

    let json = null;
    const errors = [];

    for (const url of OVERPASS_URLS) {

        try {

            const res = await fetchWithTimeout(url, {
                method: "POST",
                headers: { "Content-Type": "application/x-www-form-urlencoded" },
                body: "data=" + encodeURIComponent(query)
            }, 30000);

            if (!res.ok) {
                throw new Error(`HTTP ${res.status}`);
            }

            json = await res.json();
            break;

        } catch (err) {

            errors.push(`${new URL(url).host}: ${err.message}`);
        }
    }

    if (!json) {
        throw new Error(errors.join("; "));
    }

    const dx = (east - west) / cols;
    const dy = (north - south) / rows;

    const toGrid = p => ({
        x: (p.lon - west) / dx,
        y: (north - p.lat) / dy
    });

    // class -> list of { rings } | { line }
    const byClass = new Map();

    const add = (code, item) => {
        if (!byClass.has(code)) byClass.set(code, []);
        byClass.get(code).push(item);
    };

    for (const el of json.elements || []) {

        const code = osmClassOf(el.tags);

        if (el.type === "way" && el.geometry) {

            const pts = el.geometry.map(toGrid);

            if (code) {
                add(code, { rings: [pts] });
            } else if (
                el.tags && ["river", "canal", "stream"].includes(el.tags.waterway)
            ) {
                add(80, { line: pts, radius: el.tags.waterway === "stream" ? 0 : 1 });
            }

        } else if (el.type === "relation" && code && el.members) {

            const ways =
                el.members
                    .filter(m => m.type === "way" && m.geometry)
                    .map(m => m.geometry);

            const rings = osmAssembleRings(ways).map(r => r.map(toGrid));

            if (rings.length) {
                add(code, { rings });
            }
        }
    }

    const out = new Uint8Array(cols * rows);

    let drawn = 0;

    for (const code of OSM_DRAW_ORDER) {

        for (const item of byClass.get(code) || []) {

            if (item.rings) {
                fillRings(out, cols, rows, item.rings, code);
            } else {
                stampLine(out, cols, rows, item.line, code, item.radius);
            }

            drawn++;
        }
    }

    if (drawn === 0) {
        throw new Error("no mapped land-use or water features in this area");
    }

    return out;
}


// ------------------------------------------------------------
// Fetch ESA WorldCover land cover over a lon/lat bbox, as a
// plain equirectangular raster (cols x rows).
//
// A tile that cannot be read is left as code 0 ("no data") and
// reported in `failures` with the real reason. It is NOT assumed
// to be sea: a CORS or network failure used to flood the whole
// map as water and block every point. Open ocean is already
// handled by the sea-level check on the elevation grid.
//
// `localTiffs` (optional) = GeoTIFF objects the person loaded
// from disk, used instead of the network.
// ------------------------------------------------------------

async function fetchLandCoverEquirect(bbox, cols, rows, onProgress, localTiffs = null) {

    const { fromUrl } = await loadGeotiffLib();

    const { west, south, east, north } = bbox;

    const out = new Uint8Array(cols * rows);

    const failures = [];
    let painted = 0;

    if (localTiffs) {

        for (let i = 0; i < localTiffs.length; i++) {

            painted += await paintTiffInto(out, localTiffs[i], bbox, cols, rows);

            onProgress?.((i + 1) / localTiffs.length);
        }

        return { data: out, failures, painted };
    }

    const tiles = [];

    for (let la = Math.floor(south / 3) * 3; la < north; la += 3) {
        for (let lo = Math.floor(west / 3) * 3; lo < east; lo += 3) {
            tiles.push([la, lo]);
        }
    }

    let done = 0;

    for (const [la, lo] of tiles) {

        const name = wcTileName(la, lo);

        try {

            const tiff = await fromUrl(
                `${WC_BASE}ESA_WorldCover_10m_2021_v200_${name}_Map.tif`
            );

            painted += await paintTiffInto(out, tiff, bbox, cols, rows);

        } catch (err) {

            failures.push({ name, reason: err.message || String(err) });

            logStep(`WorldCover tile ${name} failed: ${err.message || err}`);
        }

        done++;
        onProgress?.(done / tiles.length);
    }

    return { data: out, failures, painted };
}



// ------------------------------------------------------------
// Separable binary dilation (two 1D sliding-window passes), used
// for the riverbank buffer. O(w*h) regardless of radius, unlike
// a naive O(w*h*r^2) disc search.
// ------------------------------------------------------------

function dilate1D(src, w, h, r, horizontal) {

    const out = new Uint8Array(w * h);

    if (horizontal) {

        for (let y = 0; y < h; y++) {

            let count = 0;

            for (let x = -r; x <= r; x++) {
                if (x >= 0 && x < w && src[y * w + x]) count++;
            }

            for (let x = 0; x < w; x++) {

                out[y * w + x] = count > 0 ? 1 : 0;

                const addX = x + r + 1;
                const remX = x - r;

                if (addX < w && src[y * w + addX]) count++;
                if (remX >= 0 && src[y * w + remX]) count--;
            }
        }

    } else {

        for (let x = 0; x < w; x++) {

            let count = 0;

            for (let y = -r; y <= r; y++) {
                if (y >= 0 && y < h && src[y * w + x]) count++;
            }

            for (let y = 0; y < h; y++) {

                out[y * w + x] = count > 0 ? 1 : 0;

                const addY = y + r + 1;
                const remY = y - r;

                if (addY < h && src[addY * w + x]) count++;
                if (remY >= 0 && src[remY * w + x]) count--;
            }
        }
    }

    return out;
}

function dilateMask(mask, w, h, r) {

    if (r <= 0) {
        return mask;
    }

    return dilate1D(dilate1D(mask, w, h, r, true), w, h, r, false);
}


// ------------------------------------------------------------
// Build (or rebuild) habMask in map-pixel space from the cached
// WorldCover raster, the current elevationMetres grid, and the
// Max slope / River buffer control values.
// ------------------------------------------------------------

function buildHabitabilityMaskFromEquirect(equirect) {

    const w = elevationWidth;
    const h = elevationHeight;
    const n = w * h;

    const { data, cols, rows, bbox } = equirect;

    const dx = (bbox.east - bbox.west) / cols;
    const dy = (bbox.north - bbox.south) / rows;

    const code = new Uint8Array(n);

    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {

            const { lat, lon } = pixelToLatLon(x, y);

            let c = Math.floor((lon - bbox.west) / dx);
            let r = Math.floor((bbox.north - lat) / dy);

            c = Math.min(cols - 1, Math.max(0, c));
            r = Math.min(rows - 1, Math.max(0, r));

            code[y * w + x] = data[r * cols + c];
        }
    }


    // ----------------------------------------------------
    // Riverbank buffer: dilate water, stamp nearby land as 81.
    // ----------------------------------------------------

    const riverBufferM = Number(riverBufferInput.value) || 0;
    const riverBufferPx =
        metresPerPixel ? Math.round(riverBufferM / metresPerPixel) : 0;

    if (riverBufferPx > 0) {

        const isWater = new Uint8Array(n);

        for (let i = 0; i < n; i++) {
            isWater[i] = code[i] === 80 ? 1 : 0;
        }

        const buffered = dilateMask(isWater, w, h, riverBufferPx);

        for (let i = 0; i < n; i++) {

            const cls = CLASSES[code[i]];

            if (!isWater[i] && buffered[i] && cls && cls.habitable) {
                code[i] = 81;
            }
        }
    }


    // ----------------------------------------------------
    // Slope, in real degrees, from the already-decoded
    // elevationMetres grid (central differences).
    // ----------------------------------------------------

    const maxSlopeDeg = Number(maxSlopeInput.value) || 15;
    const tanMax = Math.tan(maxSlopeDeg * Math.PI / 180);
    const spacing = metresPerPixel || 1;

    const at = (xx, yy) =>
        elevationMetres[
            Math.min(h - 1, Math.max(0, yy)) * w +
            Math.min(w - 1, Math.max(0, xx))
        ];

    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {

            const i = y * w + x;
            const cls = CLASSES[code[i]];

            if (!cls || !cls.habitable) {
                continue;
            }

            const gx = (at(x + 1, y) - at(x - 1, y)) / (2 * spacing);
            const gy = (at(x, y + 1) - at(x, y - 1)) / (2 * spacing);

            if (Math.hypot(gx, gy) > tanMax) {
                code[i] = 250;
            }
        }
    }


    const blocked = new Uint8Array(n);

    for (let i = 0; i < n; i++) {
        const cls = CLASSES[code[i]];
        blocked[i] = (!cls || !cls.habitable) ? 1 : 0;
    }

    habMask = { cols: w, rows: h, code, blocked };
}


// Is this map pixel buildable, per the land-cover mask? true
// (buildable) when no mask has been loaded yet.
function habitableAt(x, y) {

    if (!habMask) {
        return true;
    }

    const w = habMask.cols;
    const h = habMask.rows;

    const px = Math.min(w - 1, Math.max(0, Math.round(x)));
    const py = Math.min(h - 1, Math.max(0, Math.round(y)));

    return !habMask.blocked[py * w + px];
}


// Land cover class code (CLASSES key) of a map pixel, or null
// when no mask is loaded.
function landCoverCodeAt(x, y) {

    if (!habMask) {
        return null;
    }

    const w = habMask.cols;
    const h = habMask.rows;

    const px = Math.min(w - 1, Math.max(0, Math.round(x)));
    const py = Math.min(h - 1, Math.max(0, Math.round(y)));

    return habMask.code[py * w + px];
}


function countBlockedHabitability() {

    if (!habMask) {
        return 0;
    }

    let n = 0;

    for (let i = 0; i < habMask.blocked.length; i++) {
        if (habMask.blocked[i]) n++;
    }

    return n;
}


// ------------------------------------------------------------
// Fetch land cover for the currently loaded terrain and build
// the mask. Non-fatal: a failed fetch (e.g. no network access to
// AWS Open Data) just leaves the sea-level-only behaviour in
// place and logs why.
// ------------------------------------------------------------

async function loadLandCoverFromControls(localTiffs = null) {

    if (!elevationMetres) {
        logStep("Load terrain before fetching land cover.");
        return;
    }

    const requestId = ++landCoverRequestId;
    const isCurrent = () => requestId === landCoverRequestId;

    loadLandCoverBtn.disabled = true;
    landCoverNote.textContent = "Loading land cover...";

    try {

        const bbox = computeLandCoverBBox();
        const cols = 384;
        const rows = 384;

        const choice =
            localTiffs ? "local" : landCoverSourceSelect.value;

        const order =
            choice === "auto" ? ["server", "esa", "esri", "osm"] : [choice];

        const LABEL = {
            local: "Local file", server: "Local OSM server",
            esa: "ESA WorldCover",
            esri: "Esri Sentinel-2", osm: "OpenStreetMap"
        };

        const failures = [];
        const result = { data: null, failures: [] };
        let source = null;

        for (const kind of order) {

            if (!isCurrent()) {
                return;
            }

            landCoverNote.textContent = `Trying ${LABEL[kind]}...`;

            try {

                if (kind === "local" || kind === "esa") {

                    const r =
                        await fetchLandCoverEquirect(bbox, cols, rows, frac => {
                            landCoverNote.textContent =
                                `Reading ${LABEL[kind]}... ${Math.round(frac * 100)}%`;
                        }, localTiffs);

                    if (r.painted === 0) {
                        throw new Error(
                            r.failures.length
                                ? r.failures[0].reason
                                : "the file does not cover this area"
                        );
                    }

                    result.data = r.data;
                    result.failures = r.failures;

                } else if (kind === "server") {

                    result.data =
                        await fetchLandCoverServer(bbox, cols, rows, isCurrent);

                } else if (kind === "esri") {

                    result.data = await fetchLandCoverEsri(bbox, cols, rows);

                } else {

                    result.data = await fetchLandCoverOsm(bbox, cols, rows);
                }

                source = LABEL[kind];
                source = kind === "esa" || kind === "local"
                    ? "ESA WorldCover 2021" : (kind === "esri"
                        ? "Esri Sentinel-2 10 m Land Cover"
                        : "OpenStreetMap");

                // tools/osm_landcover.py tags its GeoTIFF as OSM data.
                if (kind === "local") {
                    try {
                        const meta = await (await localTiffs[0].getImage()).getGDALMetadata();
                        if (meta?.SOURCE === "OpenStreetMap") {
                            source = "OpenStreetMap";
                        }
                    } catch (e) { /* plain WorldCover tile */ }
                }

                break;

            } catch (err) {

                failures.push(`${LABEL[kind]}: ${err.message}`);

                if (isCurrent()) {
                    logStep(`${LABEL[kind]} failed: ${err.message}`);
                }
            }
        }

        // Superseded while fetching: the terrain under it has changed.
        if (!isCurrent()) {
            return;
        }

        if (!result.data) {

            throw new Error(
                failures.join(" | ") +
                ` - you can also download a WorldCover tile and use "Load from file".`
            );
        }

        landCoverEquirectCache = {
            data: result.data, cols, rows, bbox
        };

        buildHabitabilityMaskFromEquirect(landCoverEquirectCache);

        document.getElementById("landCoverAttribution").textContent =
            source.startsWith("Esri")
                ? "Land cover: Esri / Impact Observatory Sentinel-2 10 m. Elevation: AWS Terrain Tiles"
                : source === "OpenStreetMap"
                    ? "Land cover: \u00a9 OpenStreetMap contributors (ODbL). Elevation: AWS Terrain Tiles"
                    : "\u00a9 ESA WorldCover project 2021 \u00b7 Elevation: AWS Terrain Tiles";

        invalidateRoadNetwork();
        renderLandCoverOverlay();
        renderLandCoverLegend();
        reapplyHabitabilityToExistingPoints();
        drawLandCoverCells();

        const pct =
            Math.round(100 * countBlockedHabitability() / habMask.blocked.length);

        landCoverNote.textContent =
            `Loaded from ${source}. ${pct}% of the view is unbuildable. ` +
            `Hover the map to see what each spot is.` +
            (result.failures.length
                ? ` ${result.failures.length} tile(s) failed - see log.`
                : "");

        logStep(
            `Land cover loaded (${pct}% unbuildable). ` +
            "Hover the map to inspect each class."
        );

    } catch (err) {

        if (!isCurrent()) {
            return;
        }

        landCoverNote.textContent = `Failed: ${err.message}`;

        logStep(`Land cover load failed: ${err.message}`);

        console.error(err);

    } finally {

        if (isCurrent()) {
            loadLandCoverBtn.disabled = false;
        }
    }
}


// Use a WorldCover .tif the person downloaded (bypasses CORS).
async function loadLandCoverFromFiles(fileList) {

    const files = Array.from(fileList || []);

    if (!files.length) {
        return;
    }

    try {

        const { fromBlob } = await loadGeotiffLib();

        const tiffs = [];

        for (const f of files) {
            tiffs.push(await fromBlob(f));
        }

        await loadLandCoverFromControls(tiffs);

    } catch (err) {

        landCoverNote.textContent = `Failed: ${err.message}`;
        logStep(`Could not read GeoTIFF: ${err.message}`);
    }
}


// Re-run the mask (slope/river-buffer changed) without refetching.
function rebuildHabitabilityMask() {

    if (!landCoverEquirectCache || !elevationMetres) {
        return;
    }

    buildHabitabilityMaskFromEquirect(landCoverEquirectCache);

    invalidateRoadNetwork();
    renderLandCoverOverlay();
    renderLandCoverLegend();
    reapplyHabitabilityToExistingPoints();
    drawLandCoverCells();

    const pct =
        Math.round(100 * countBlockedHabitability() / habMask.blocked.length);

    landCoverNote.textContent =
        `Loaded. ${pct}% of the view is unbuildable.`;
}


// Same pattern as the sea-level slider: an existing closed city's
// points and facilities are re-filtered against the new mask.
function reapplyHabitabilityToExistingPoints() {

    if (!cityClosed) {
        return;
    }

    const before = points.length;

    points = points.filter(p => isLand(p.x, p.y));

    const removed = before - points.length;

    let facRemoved = 0;

    // Blocks are judged after the points are re-filtered.
    const blocks = getBlockCells();

    for (const layer of FACILITY_LAYERS) {

        const n = layer.points.length;

        layer.points = layer.points.filter(p =>
            isLand(p.x, p.y) &&
            (!blocks || blocks.isBuildableAt(p.x, p.y))
        );

        facRemoved += n - layer.points.length;
    }

    if (removed > 0 || facRemoved > 0) {
        logStep(
            `Land cover mask: removed ${removed} points` +
            (facRemoved > 0 ? ` and ${facRemoved} facilities.` : ".")
        );
    }

    optimizeBtn.disabled =
        !FACILITY_LAYERS.some(l => l.points.length >= 2);

    draw();
    evaluateMetric();
}


// ------------------------------------------------------------
// Rendering: colour overlay canvas + legend + hatched cells
// ------------------------------------------------------------

function renderLandCoverOverlay() {

    if (!habMask || !landCoverToggle.checked) {
        landcoverCanvas.width = 0;
        landcoverCanvas.height = 0;
        return;
    }

    const showAll = landCoverAllToggle.checked;

    landcoverCanvas.width = habMask.cols;
    landcoverCanvas.height = habMask.rows;

    landcoverCanvas.style.width = `${WORLD_WIDTH}px`;
    landcoverCanvas.style.height = `${WORLD_HEIGHT}px`;

    const ctx = landcoverCanvas.getContext("2d");
    const img = ctx.createImageData(habMask.cols, habMask.rows);

    for (let i = 0; i < habMask.code.length; i++) {

        const isBlocked = habMask.blocked[i];

        if (!isBlocked && !showAll) {
            continue;
        }

        const cls = CLASSES[habMask.code[i]];

        if (!cls) {
            continue;
        }

        const hex = parseInt(cls.color.slice(1), 16);
        const p = i * 4;

        img.data[p] = (hex >> 16) & 255;
        img.data[p + 1] = (hex >> 8) & 255;
        img.data[p + 2] = hex & 255;

        // Unbuildable classes are stronger than buildable ones.
        img.data[p + 3] = Math.round((isBlocked ? 0.65 : 0.4) * 255);
    }

    ctx.putImageData(img, 0, 0);
}


function renderLandCoverLegend() {

    const panel = document.getElementById("landCoverLegend");
    const list = document.getElementById("landCoverLegendList");

    if (!habMask || !landCoverToggle.checked) {
        panel.classList.add("hidden");
        return;
    }

    const counts = new Map();

    for (let i = 0; i < habMask.code.length; i++) {
        const k = habMask.code[i];
        counts.set(k, (counts.get(k) || 0) + 1);
    }

    const total = habMask.code.length;

    const present =
        [...counts.keys()]
            .filter(k => CLASSES[k])
            .sort((a, b) => counts.get(b) - counts.get(a));

    list.innerHTML = "";

    for (const k of present) {

        const cls = CLASSES[k];
        const pct = (100 * counts.get(k) / total).toFixed(1);

        const row = document.createElement("div");
        row.className = "legend-row";

        row.innerHTML =
            `<span class="legend-swatch" style="background:${cls.color}"></span>` +
            `<span class="legend-name"></span>` +
            `<span class="legend-pct">${pct}%</span>` +
            `<span class="legend-flag">${cls.habitable ? "" : "\u2715"}</span>`;

        row.querySelector(".legend-name").textContent = cls.name;

        list.appendChild(row);
    }

    panel.classList.toggle("hidden", present.length === 0);
}


// What is under the cursor? Shown in a small floating tooltip.
function landCoverDescribeAt(x, y) {

    if (!habMask) {
        return null;
    }

    const px = Math.min(habMask.cols - 1, Math.max(0, Math.round(x)));
    const py = Math.min(habMask.rows - 1, Math.max(0, Math.round(y)));

    const i = py * habMask.cols + px;
    const cls = CLASSES[habMask.code[i]];

    if (!cls) {
        return null;
    }

    const elev = elevationMetres ? elevationMetres[i] : null;

    return (
        `${cls.name} - ` +
        (habMask.blocked[i] ? "unbuildable" : "buildable") +
        (elev !== null ? ` \u00b7 ${elev.toFixed(0)} m` : "")
    );
}

const landCoverTip = document.getElementById("landCoverTip");

viewport.addEventListener("mousemove", event => {

    if (!habMask || !landCoverToggle.checked || !WORLD_WIDTH) {
        landCoverTip.classList.add("hidden");
        return;
    }

    if (event.target.closest && event.target.closest("#controls, #logPanel, #landCoverLegend")) {
        landCoverTip.classList.add("hidden");
        return;
    }

    const w = screenToWorld(event.clientX, event.clientY);

    if (w.x < 0 || w.y < 0 || w.x >= WORLD_WIDTH || w.y >= WORLD_HEIGHT) {
        landCoverTip.classList.add("hidden");
        return;
    }

    const text = landCoverDescribeAt(w.x, w.y);

    if (!text) {
        landCoverTip.classList.add("hidden");
        return;
    }

    landCoverTip.textContent = text;
    landCoverTip.style.left = `${event.clientX + 14}px`;
    landCoverTip.style.top = `${event.clientY + 14}px`;
    landCoverTip.classList.remove("hidden");
});

viewport.addEventListener("mouseleave", () => {
    landCoverTip.classList.add("hidden");
});


function ensureHatchPattern() {

    let defs = svg.select("defs");

    if (defs.select("#no-build-hatch").empty()) {

        const p =
            defs.append("pattern")
                .attr("id", "no-build-hatch")
                .attr("width", 6)
                .attr("height", 6)
                .attr("patternUnits", "userSpaceOnUse")
                .attr("patternTransform", "rotate(45)");

        p.append("line")
            .attr("y2", 6)
            .attr("stroke", "#222")
            .attr("stroke-width", 1.2)
            .attr("opacity", 0.5);
    }
}


// Hatches the blocks that are NOT buildable: at least a quarter
// of the block's area (6x6 samples, the block clipped to the
// city) is unbuildable. Same test, from getBlockCells()
// (buildings.js), that keeps facilities and buildings out of
// these blocks, so what is hatched is exactly what they avoid.
// Blocks whose own point is unbuildable never get this far - the
// point is filtered out of `points`, like a drowned one.
function drawLandCoverCells() {

    landCoverCellLayer.selectAll("*").remove();

    if (!habMask || !landCoverToggle.checked) {
        return;
    }

    const blocks = getBlockCells();

    if (!blocks) {
        return;
    }

    ensureHatchPattern();

    const group = landCoverCellLayer.append("g");

    if (cityClosed) {
        group.attr("clip-path", "url(#cityClip)");
    }

    for (const cell of blocks.cells) {

        if (!cell || cell.buildable || cell.polygon.length < 3) {
            continue;
        }

        group
            .append("path")
            .attr("class", "no-build-cell")
            .attr(
                "d",
                "M" + cell.polygon.map(p => `${p[0]},${p[1]}`).join("L") + "Z"
            );
    }
}
