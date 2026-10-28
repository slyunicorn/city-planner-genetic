// js/real-roads.js
// The area's real road network (OpenStreetMap), scored with the same
// quality model as the plan, for the metrics page.
// Plain script: shares the global scope with the other js/ files,
// so load order in index.html matters.

// ============================================================
// REAL ROADS VS THE PLAN
// ============================================================
//
// The metrics page asks for a comparison over the metrics channel
// ("compare-request", metrics-feed.js). This tab holds the city and
// the finished plan, so it does the work:
//
//   1. Roads. tools/serve.py cuts the area's roads out of the local
//      Geofabrik extract (/api/roads/..., tools/osm_roads.py): the
//      streets a car can use, motorway down to residential and
//      living streets (no service roads, tracks or paths).
//   2. Map space. Every node goes through the same Mercator square
//      as the terrain (latLonToPixel()), so both networks sit on the
//      same pixels.
//   3. Same area. Roads are clipped to the city boundary; where one
//      leaves the city it ends on the boundary. Those ends are the
//      clip, not real dead ends, so the NC counts skip them (the
//      `boundary` option of scoreNetwork()).
//   4. Shape points. A road's in-between nodes are thinned with
//      Douglas-Peucker (REAL_SIMPLIFY_PX), so a curve keeps its
//      bends but not every surveyed point; junctions always stay.
//   5. Crossings. Two roads that cross without a shared node (a
//      flyover, bridge or tunnel, or a mapping gap) get a node where
//      they cross: blocks (BB) need a planar network. Counted.
//   6. One network. Pieces not connected to the largest one inside
//      the city (cut off by the clip) are left out, like the plan,
//      which is one network. Their length is reported.
//   7. Scoring. Both networks - the plan's roads without facility
//      spurs, and the real roads - go through scoreNetwork() with
//      the run's weights, cost weight and references (median block
//      area, starting Shimbel distance, starting road length). Each
//      picks its own OD sources the same way (the 16 farthest-apart
//      intersections). Same rules, same yardstick.
// ============================================================

const REAL_SIMPLIFY_PX = 0.5;

// Real road classes drawn wider on the page's maps.
const REAL_MAJOR_CLASSES = new Set([
    "motorway", "trunk", "primary", "secondary",
    "motorway_link", "trunk_link", "primary_link", "secondary_link"
]);

let realRoadsBusy = false;


// Inverse of pixelToLatLon() (landcover.js): lon/lat to map pixels
// through the terrain's Mercator square.
function latLonToPixel(lat, lon) {

    const w = elevationWidth || WORLD_WIDTH;
    const h = elevationHeight || WORLD_HEIGHT;

    return {
        x: (lonToMerc(lon) - (terrainMercCenterX - terrainMercHalf)) /
            (2 * terrainMercHalf) * Math.max(1, w - 1),
        y: ((terrainMercCenterY + terrainMercHalf) - latToMerc(lat)) /
            (2 * terrainMercHalf) * Math.max(1, h - 1)
    };
}


async function fetchRealRoads(onStatus) {

    if (location.protocol === "file:") {
        throw new Error("page opened as file:// - open http://localhost:8000/ (tools/serve.py)");
    }

    const q = new URLSearchParams(computeLandCoverBBox());

    let res;

    try {
        res = await fetchWithTimeout(`/api/roads/start?${q}`, {}, 15000);
    } catch (err) {
        throw new Error(`no answer from ${location.origin}/api - is tools/serve.py running?`);
    }

    if (res.status === 404 || res.status === 501) {
        throw new Error(
            "this server has no /api/roads - restart tools/serve.py so it has the new code"
        );
    }

    const start = await res.json();

    if (!res.ok) {
        throw new Error(start.error || `HTTP ${res.status}`);
    }

    const t0 = Date.now();

    for (;;) {

        const s = await (
            await fetchWithTimeout(`/api/roads/status?id=${start.id}`, {}, 10000)
        ).json();

        if (s.state === "error") {
            throw new Error(s.message);
        }

        if (s.state === "done") {
            break;
        }

        onStatus(`Server: ${s.message} (${Math.round((Date.now() - t0) / 1000)} s)`);

        await new Promise(r => setTimeout(r, 1500));
    }

    const file = await fetchWithTimeout(`/api/roads/result?id=${start.id}`, {}, 60000);

    if (!file.ok) {
        throw new Error(`result HTTP ${file.status}`);
    }

    return file.json();
}


// ============================================================
// REAL ROADS OVERLAY
// ============================================================
//
// The "Real roads (OpenStreetMap)" layer draws the area's real
// roads over the whole terrain square, under the plan's roads, so
// the two can be seen together and switched on and off. The roads
// are fetched once per area; the comparison reuses them.

let realRoadsOsm = null;

function realRoadsKey() {
    return JSON.stringify(computeLandCoverBBox());
}

function getRealRoadsOsm(onStatus) {

    const key = realRoadsKey();

    if (!realRoadsOsm || realRoadsOsm.key !== key) {

        const entry = { key, promise: fetchRealRoads(onStatus) };

        // A failed fetch is not kept, so the next try asks again.
        entry.promise.catch(() => {
            if (realRoadsOsm === entry) {
                realRoadsOsm = null;
            }
        });

        realRoadsOsm = entry;
    }

    return realRoadsOsm.promise;
}

// A new area: its roads are different.
function resetRealRoads() {
    realRoadsOsm = null;
    realRoadLayer.selectAll("*").remove();
    realRoadsNote.hidden = true;
}

async function showRealRoads() {

    realRoadLayer.selectAll("*").remove();

    if (!realRoadsToggle.checked || !WORLD_WIDTH) {
        realRoadsNote.hidden = true;
        return;
    }

    const key = realRoadsKey();

    realRoadsNote.hidden = false;
    realRoadsNote.textContent = "Loading the real roads...";

    try {

        const osm =
            await getRealRoadsOsm(message => {
                realRoadsNote.textContent = message;
            });

        // Switched off, or a new area loaded, while it was fetched.
        if (!realRoadsToggle.checked || realRoadsKey() !== key) {
            return;
        }

        drawRealRoads(osm);

        realRoadsNote.textContent =
            `© OpenStreetMap contributors (ODbL), data of ${osm.date}`;

        logStep(
            `Real roads shown: ${osm.ways.length} OpenStreetMap road ` +
            `pieces, data of ${osm.date}. Thick: motorway to secondary.`
        );

    } catch (err) {

        realRoadsNote.textContent = `Could not load: ${err.message}`;

        logStep(`Real roads: ${err.message}`);
    }
}

// One path for the smaller roads, one for the major ones on top.
function drawRealRoads(osm) {

    const proj =
        osm.nodes.map(([lon, lat]) => latLonToPixel(lat, lon));

    let minor = "";
    let major = "";

    for (const way of osm.ways) {

        const d =
            "M" + way.n
                .map(i => `${proj[i].x.toFixed(1)},${proj[i].y.toFixed(1)}`)
                .join("L");

        if (REAL_MAJOR_CLASSES.has(way.h)) {
            major += d;
        } else {
            minor += d;
        }
    }

    realRoadLayer.selectAll("*").remove();

    // Only over the terrain; the fetched roads reach a little past it.
    d3.select("#worldClipRect")
        .attr("width", WORLD_WIDTH)
        .attr("height", WORLD_HEIGHT);

    realRoadLayer.attr("clip-path", "url(#worldClip)");

    realRoadLayer.append("path").attr("class", "real-road").attr("d", minor);
    realRoadLayer.append("path").attr("class", "real-road major").attr("d", major);
}


// Douglas-Peucker over a polyline of {x, y}; returns the kept
// indices (first and last always).
function simplifyIndices(points, tolerance) {

    const keep = new Uint8Array(points.length);

    keep[0] = 1;
    keep[points.length - 1] = 1;

    const stack = [[0, points.length - 1]];

    while (stack.length) {

        const [i, j] = stack.pop();

        const a = points[i];
        const b = points[j];
        const len = Math.hypot(b.x - a.x, b.y - a.y);

        let far = -1;
        let farD = tolerance;

        for (let k = i + 1; k < j; k++) {

            const p = points[k];

            const d = len > 1e-9
                ? Math.abs((b.x - a.x) * (a.y - p.y) - (a.x - p.x) * (b.y - a.y)) / len
                : Math.hypot(p.x - a.x, p.y - a.y);

            if (d > farD) {
                far = k;
                farD = d;
            }
        }

        if (far >= 0) {
            keep[far] = 1;
            stack.push([i, far], [far, j]);
        }
    }

    return [...keep.keys()].filter(k => keep[k]);
}


// Where segment p-q first crosses the ring, as a fraction of p-q
// from p (null if it does not).
function ringCrossing(p, q, ring) {

    let best = null;

    for (let k = 0; k < ring.length; k++) {

        const a = ring[k];
        const b = ring[(k + 1) % ring.length];

        const rx = q.x - p.x;
        const ry = q.y - p.y;
        const sx = b[0] - a[0];
        const sy = b[1] - a[1];
        const den = rx * sy - ry * sx;

        if (Math.abs(den) < 1e-12) {
            continue;
        }

        const t = ((a[0] - p.x) * sy - (a[1] - p.y) * sx) / den;
        const u = ((a[0] - p.x) * ry - (a[1] - p.y) * rx) / den;

        if (t >= 0 && t <= 1 && u >= 0 && u <= 1 && (best === null || t < best)) {
            best = t;
        }
    }

    return best;
}


// OSM JSON (tools/osm_roads.py) -> the real network inside the city:
// { nodes, edges, boundary (Uint8Array), major (Set of edge keys),
//   notes }.
function realRoadGraph(osm, ring) {

    const proj = osm.nodes.map(([lon, lat]) => latLonToPixel(lat, lon));
    const inside = proj.map(p => d3.polygonContains(ring, [p.x, p.y]));

    const nodes = [];
    const boundary = [];
    const index = new Map();

    const nodeOf = i => {
        if (!index.has(i)) {
            index.set(i, nodes.length);
            nodes.push({ x: proj[i].x, y: proj[i].y });
            boundary.push(0);
        }
        return index.get(i);
    };

    const cut = p => {
        nodes.push({ x: p.x, y: p.y });
        boundary.push(1);
        return nodes.length - 1;
    };

    // 3. Clip every segment to the city.
    const segments = [];

    for (const way of osm.ways) {

        const major = REAL_MAJOR_CLASSES.has(way.h);

        for (let k = 0; k + 1 < way.n.length; k++) {

            const i = way.n[k];
            const j = way.n[k + 1];
            const p = proj[i];
            const q = proj[j];

            if (inside[i] && inside[j]) {
                segments.push([nodeOf(i), nodeOf(j), major]);
            } else if (inside[i] || inside[j]) {

                const [from, to, a] = inside[i] ? [p, q, i] : [q, p, j];
                const t = ringCrossing(from, to, ring);

                if (t !== null && t > 1e-6) {
                    const end = cut({
                        x: from.x + (to.x - from.x) * t,
                        y: from.y + (to.y - from.y) * t
                    });
                    segments.push([nodeOf(a), end, major]);
                }
            }
        }
    }

    // Neighbour sets (duplicate segments collapse).
    const adj = nodes.map(() => new Map());

    for (const [a, b, major] of segments) {
        if (a !== b) {
            adj[a].set(b, adj[a].get(b) || major);
            adj[b].set(a, adj[b].get(a) || major);
        }
    }

    // 4. Thin shape points: walk every chain between nodes that are
    //    not plain pass-through points, simplify it.
    const anchor = v => boundary[v] || adj[v].size !== 2;
    const seen = new Set();
    const edges = [];
    const edgeKeys = new Set();
    const majorKeys = new Set();

    const walk = (start, next) => {

        const chain = [start];
        let prev = start;
        let cur = next;
        let major = adj[start].get(next);

        while (true) {
            seen.add(`${Math.min(prev, cur)},${Math.max(prev, cur)}`);
            chain.push(cur);
            if (anchor(cur) || cur === start) {
                break;
            }
            const [n1, n2] = [...adj[cur].keys()];
            const nxt = n1 === prev ? n2 : n1;
            major = major || adj[cur].get(nxt);
            prev = cur;
            cur = nxt;
        }

        const kept = simplifyIndices(chain.map(v => nodes[v]), REAL_SIMPLIFY_PX);

        for (let k = 0; k + 1 < kept.length; k++) {
            const a = chain[kept[k]];
            const b = chain[kept[k + 1]];
            const key = `${Math.min(a, b)},${Math.max(a, b)}`;
            // Two roads between the same junctions that thin down
            // to the same straight line are one road here.
            if (a !== b && !edgeKeys.has(key)) {
                edgeKeys.add(key);
                edges.push([a, b]);
                if (major) {
                    majorKeys.add(edges.length - 1);
                }
            }
        }
    };

    for (let v = 0; v < nodes.length; v++) {
        if (anchor(v)) {
            for (const w of adj[v].keys()) {
                if (!seen.has(`${Math.min(v, w)},${Math.max(v, w)}`)) {
                    walk(v, w);
                }
            }
        }
    }

    // Loops of pass-through points only (no junction on them).
    for (let v = 0; v < nodes.length; v++) {
        for (const w of adj[v].keys()) {
            if (!seen.has(`${Math.min(v, w)},${Math.max(v, w)}`)) {
                walk(v, w);
            }
        }
    }

    // 5. Planar: a node wherever two roads cross without one.
    const planar = planarizeEdges(nodes, edges, majorKeys, boundary);

    // 6. The largest connected piece.
    return largestPiece(planar);
}


function planarizeEdges(nodes, edges, majorKeys, boundary) {

    const size = Math.max(4, R);
    const buckets = new Map();

    edges.forEach(([a, b], e) => {

        const p = nodes[a];
        const q = nodes[b];

        for (let by = Math.floor(Math.min(p.y, q.y) / size); by <= Math.floor(Math.max(p.y, q.y) / size); by++) {
            for (let bx = Math.floor(Math.min(p.x, q.x) / size); bx <= Math.floor(Math.max(p.x, q.x) / size); bx++) {
                const key = by * 65536 + bx;
                if (!buckets.has(key)) {
                    buckets.set(key, []);
                }
                buckets.get(key).push(e);
            }
        }
    });

    const splits = edges.map(() => []);
    const tested = new Set();
    let crossings = 0;

    for (const list of buckets.values()) {
        for (let i = 0; i < list.length; i++) {
            for (let j = i + 1; j < list.length; j++) {

                const e = Math.min(list[i], list[j]);
                const f = Math.max(list[i], list[j]);
                const pairKey = e * edges.length + f;

                if (e === f || tested.has(pairKey)) {
                    continue;
                }

                tested.add(pairKey);

                const [a, b] = edges[e];
                const [c, d] = edges[f];

                if (a === c || a === d || b === c || b === d) {
                    continue;
                }

                const p = nodes[a], q = nodes[b], r = nodes[c], s = nodes[d];
                const rx = q.x - p.x, ry = q.y - p.y, sx = s.x - r.x, sy = s.y - r.y;
                const den = rx * sy - ry * sx;

                if (Math.abs(den) < 1e-12) {
                    continue;
                }

                const t = ((r.x - p.x) * sy - (r.y - p.y) * sx) / den;
                const u = ((r.x - p.x) * ry - (r.y - p.y) * rx) / den;

                if (t <= 1e-9 || t >= 1 - 1e-9 || u <= 1e-9 || u >= 1 - 1e-9) {
                    continue;
                }

                nodes.push({ x: p.x + rx * t, y: p.y + ry * t });
                boundary.push(0);

                const v = nodes.length - 1;

                splits[e].push([t, v]);
                splits[f].push([u, v]);
                crossings++;
            }
        }
    }

    const out = [];
    const major = new Set();

    edges.forEach(([a, b], e) => {

        const chain =
            [a].concat(splits[e].sort((x, y) => x[0] - y[0]).map(s => s[1]), [b]);

        for (let k = 0; k + 1 < chain.length; k++) {
            out.push([chain[k], chain[k + 1]]);
            if (majorKeys.has(e)) {
                major.add(out.length - 1);
            }
        }
    });

    return { nodes, edges: out, major, boundary, crossings };
}


function largestPiece(g) {

    const n = g.nodes.length;
    const parent = Int32Array.from({ length: n }, (_, i) => i);

    const find = x => {
        while (parent[x] !== x) {
            parent[x] = parent[parent[x]];
            x = parent[x];
        }
        return x;
    };

    for (const [a, b] of g.edges) {
        parent[find(a)] = find(b);
    }

    const length = e => Math.hypot(
        g.nodes[e[0]].x - g.nodes[e[1]].x,
        g.nodes[e[0]].y - g.nodes[e[1]].y
    );

    const byRoot = new Map();

    for (const e of g.edges) {
        const r = find(e[0]);
        byRoot.set(r, (byRoot.get(r) || 0) + length(e));
    }

    let root = -1;
    let best = -1;

    for (const [r, len] of byRoot) {
        if (len > best) {
            best = len;
            root = r;
        }
    }

    // Renumber the nodes of the kept piece.
    const map = new Int32Array(n).fill(-1);
    const nodes = [];
    const boundary = [];

    for (let v = 0; v < n; v++) {
        if (find(v) === root) {
            map[v] = nodes.length;
            nodes.push(g.nodes[v]);
            boundary.push(g.boundary[v]);
        }
    }

    const edges = [];
    const major = new Set();
    let droppedLength = 0;

    g.edges.forEach((e, i) => {
        if (find(e[0]) === root) {
            edges.push([map[e[0]], map[e[1]]]);
            if (g.major.has(i)) {
                major.add(edges.length - 1);
            }
        } else {
            droppedLength += length(e);
        }
    });

    return {
        nodes,
        edges,
        major,
        boundary: Uint8Array.from(boundary),
        notes: {
            crossings: g.crossings,
            droppedPieces: byRoot.size - 1,
            droppedLength
        }
    };
}


// What the page needs about one scored network.
function networkSummary(nodes, edges, score, boundary, major) {

    const degree = new Int32Array(nodes.length);
    let length = 0;

    for (const [a, b] of edges) {
        degree[a]++;
        degree[b]++;
        length += Math.hypot(nodes[a].x - nodes[b].x, nodes[a].y - nodes[b].y);
    }

    let junctions = 0;
    let deadEnds = 0;
    let cutEnds = 0;

    for (let v = 0; v < nodes.length; v++) {
        if (boundary && boundary[v]) {
            cutEnds += degree[v] ? 1 : 0;
        } else if (degree[v] >= 3) {
            junctions++;
        } else if (degree[v] === 1) {
            deadEnds++;
        }
    }

    const r1 = v => Math.round(v * 10) / 10;

    return {
        point: qualityHistoryPoint(score, null, "final"),
        stats: { length, junctions, deadEnds, cutEnds, roads: edges.length },
        // Flat [x1, y1, x2, y2, major, ...] for the page's map.
        lines: edges.flatMap(([a, b], i) => [
            r1(nodes[a].x), r1(nodes[a].y), r1(nodes[b].x), r1(nodes[b].y),
            major && major.has(i) ? 1 : 0
        ])
    };
}


async function compareWithRealRoads() {

    const status = message =>
        metricsFeed.send({ type: "compare-status", message });

    const fail = message =>
        metricsFeed.send({ type: "compare-error", message });

    if (realRoadsBusy) {
        status("Already comparing; wait for it to finish.");
        return;
    }

    const net = roadNetwork;

    if (!cityClosed || !net || !net.qualityRefs || roadNetworkDirty) {
        fail("No finished road network in the planner. Close a city and run Simplify Network first.");
        return;
    }

    realRoadsBusy = true;

    try {

        status("Asking the local server for the real roads of this area...");

        const osm = await getRealRoadsOsm(status);

        status(`Building the real network (${osm.ways.length} OSM road pieces)...`);

        const ring =
            getBoundaryPolygonPoints(200).map(q => [q.x, q.y]);

        const real = realRoadGraph(osm, ring);

        const { ctx, baseTotalLength } = net.qualityRefs;

        status("Scoring both networks...");

        const realScore =
            scoreNetwork(real.nodes, real.edges, ctx, baseTotalLength, {
                ownSources: true,
                boundary: real.boundary
            });

        const planScore =
            scoreNetwork(net.nodes, net.edges, ctx, baseTotalLength, { ownSources: true });

        const planMajor = new Set();

        net.edges.forEach(([a, b], i) => {
            if (net.mainRoads && net.mainRoads.has(edgeKeyOf(a, b))) {
                planMajor.add(i);
            }
        });

        const result = {
            id: Date.now(),
            createdAt: new Date().toISOString(),
            area: {
                lat: Number(latInput.value),
                lon: Number(lonInput.value),
                metresPerPixel,
                R,
                ring: ring.map(([x, y]) => [Math.round(x * 10) / 10, Math.round(y * 10) / 10])
            },
            source: { date: osm.date, files: osm.files, classes: osm.classes },
            weights: ctx.weights,
            costWeight: ctx.costWeight,
            scoreKeys: METRIC_SCORE_KEYS,
            rawKeys: METRIC_RAW_KEYS,
            metrics: qualityMetricDefinitions(ctx),
            real: networkSummary(real.nodes, real.edges, realScore, real.boundary, real.major),
            plan: networkSummary(net.nodes, net.edges, planScore, null, planMajor),
            notes: real.notes
        };

        metricsFeed.send({ type: "compare-result", result });

        try {
            localStorage.setItem(METRICS_COMPARE_KEY, JSON.stringify(result));
        } catch (err) {
            // Storage full or blocked: the open page still has it.
        }

        logStep(
            `Real roads (OpenStreetMap, ${osm.date}): ${qualityLabel(realScore)}; ` +
            `plan roads: ${qualityLabel(planScore)}.`
        );

    } catch (err) {

        fail(`Could not compare: ${err.message}`);

        logStep(`Real roads: ${err.message}`);

        console.error(err);

    } finally {

        realRoadsBusy = false;
    }
}
