// js/metrics-page.js
// The metrics page (metrics.html): charts and tables of the road
// quality metrics, fed live by js/metrics-feed.js in the app.
// Plain script, loaded only by metrics.html (not by index.html).

const CHANNEL_NAME = "ai-city-road-metrics";
const STORAGE_KEY = "aiCity.roadMetrics.lastRun";
const COMPARE_KEY = "aiCity.roadMetrics.lastCompare";

// Real roads vs plan: categorical slots 1 and 2 (validated pair).
const COMPARE_SERIES = [
    { key: "real", label: "Real roads", color: "var(--series-1)" },
    { key: "plan", label: "Plan", color: "var(--series-2)" }
];

// Group series, in categorical slot order (validated as a set).
const GROUP_SERIES = [
    { key: "structural", label: "Structure", color: "var(--series-1)" },
    { key: "nc", label: "NC junctions", color: "var(--series-2)" },
    { key: "rs", label: "RS routes", color: "var(--series-3)" },
    { key: "bb", label: "BB blocks", color: "var(--series-4)" }
];

const GROUP_NAMES = { nc: "NC · nodal connections", rs: "RS · road segments", bb: "BB · barrier blocks" };

const state = {
    run: null,
    selected: null,     // attempt number the user picked
    follow: true,       // follow the live attempt / the winner
    step: null,         // inspected removal index; null = latest
    xMode: "removed",
    view: location.hash === "#compare" ? "compare" : "run",
    compare: null,      // last real-roads comparison
    mapMode: "overlay", // or "split" (side by side)
    mapShow: { real: true, plan: true },
    compareStatus: "",
    compareBusy: false
};


// ------------------------------------------------------------
// Data in: saved run, then the live feed
// ------------------------------------------------------------

try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
        state.run = JSON.parse(saved);
    }
} catch (err) {
    // No saved run (or storage blocked): wait for the live feed.
}

try {
    const saved = localStorage.getItem(COMPARE_KEY);
    if (saved) {
        state.compare = JSON.parse(saved);
    }
} catch (err) {
    // No saved comparison.
}

let channel = null;

try {
    channel = new BroadcastChannel(CHANNEL_NAME);
} catch (err) {
    channel = null;
}

const askForRun = () => {
    if (channel) {
        channel.postMessage({ type: "hello" });
    }
};

if (channel) {
    channel.onmessage = event => handleMessage(event.data);
    askForRun();
}

function findAttempt(n) {
    return state.run && state.run.attempts.find(a => a.attempt === n);
}

function handleMessage(msg) {

    if (!msg || !msg.type) {
        return;
    }

    if (msg.type.startsWith("compare-")) {
        handleCompareMessage(msg);
        scheduleRender();
        return;
    }

    if (msg.type === "run") {

        if (!state.run || state.run.id !== msg.run.id) {
            state.follow = true;
            state.step = null;
        }

        state.run = msg.run;

    } else if (!state.run) {

        askForRun();
        return;

    } else if (msg.type === "attempt") {

        state.run.attempts =
            state.run.attempts.filter(a => a.attempt !== msg.attempt);

        state.run.attempts.push({ attempt: msg.attempt, points: msg.points, summary: null });

        if (state.follow) {
            state.step = null;
        }

    } else if (msg.type === "points") {

        const a = findAttempt(msg.attempt);

        if (!a || a.points.length < msg.from) {
            askForRun();
            return;
        }

        a.points.length = msg.from;
        a.points.push(...msg.points);

    } else if (msg.type === "attempt-end") {

        const a = findAttempt(msg.attempt);

        if (a) {
            a.summary = msg.summary;
        }
    }

    scheduleRender();
}


// Redraw at most ~5 times a second while a run streams in.
let renderQueued = false;
let lastRender = 0;

function scheduleRender() {

    if (renderQueued) {
        return;
    }

    renderQueued = true;

    const wait = Math.max(0, 200 - (performance.now() - lastRender));

    setTimeout(() => requestAnimationFrame(() => {
        renderQueued = false;
        lastRender = performance.now();
        render();
    }), wait);
}

window.addEventListener("resize", scheduleRender);


// ------------------------------------------------------------
// Formatting
// ------------------------------------------------------------

const fmt2 = d3.format(".2f");
const fmt3 = d3.format(".3f");
const fmtPct = d3.format(".1%");
const fmtSigned = d3.format("+.3f");

function rawValue(point, key) {
    const i = state.run.rawKeys.indexOf(key);
    return i >= 0 ? point.raw[i] : null;
}

function scoreValue(point, key) {
    const i = state.run.scoreKeys.indexOf(key);
    return i >= 0 ? point.scores[i] : null;
}

function formatRaw(unit, v, metresPerPixel) {

    if (v == null) {
        return "–";
    }

    const mpp = metresPerPixel || (state.run && state.run.metresPerPixel) || 1;

    switch (unit) {
        case "perKm":
            return `${fmt2(v / mpp * 1000)} per km`;
        case "percent":
            return fmtPct(v);
        case "metres":
            return v * mpp >= 1000
                ? `${d3.format(".2f")(v * mpp / 1000)} km`
                : `${Math.round(v * mpp)} m`;
        case "hectares":
            return `${d3.format(".1f")(v * mpp * mpp / 10000)} ha`;
        case "ratio":
            return fmt3(v);
        default:
            return fmt2(v);
    }
}

const xOf = (point, index) =>
    state.xMode === "removed" ? (1 - point.cost) * 100 : index;

const xLabel = () =>
    state.xMode === "removed" ? "Road length removed (%)" : "Removal number";

const xTitle = (point, index) =>
    `Removal ${index} · ${fmtPct(1 - point.cost)} of road length removed`;


// ------------------------------------------------------------
// Tooltip
// ------------------------------------------------------------

const tooltip = document.getElementById("tooltip");

function showTooltip(event, title, rows) {

    tooltip.textContent = "";

    const head = document.createElement("div");
    head.className = "tt-title";
    head.textContent = title;
    tooltip.appendChild(head);

    for (const row of rows) {

        const line = document.createElement("div");
        line.className = "tt-row";

        if (row.color) {
            const key = document.createElement("span");
            key.className = "tt-key";
            key.style.background = row.color;
            line.appendChild(key);
        }

        const value = document.createElement("strong");
        value.textContent = row.value;
        line.appendChild(value);

        const label = document.createElement("span");
        label.className = "lbl";
        label.textContent = row.label;
        line.appendChild(label);

        tooltip.appendChild(line);
    }

    tooltip.hidden = false;

    const pad = 14;
    const box = tooltip.getBoundingClientRect();

    let left = event.clientX + pad;
    let top = event.clientY + pad;

    if (left + box.width > window.innerWidth - 8) {
        left = event.clientX - box.width - pad;
    }

    if (top + box.height > window.innerHeight - 8) {
        top = event.clientY - box.height - pad;
    }

    tooltip.style.left = `${Math.max(8, left)}px`;
    tooltip.style.top = `${Math.max(8, top)}px`;
}

function hideTooltip() {
    tooltip.hidden = true;
}


// ------------------------------------------------------------
// One line / dot chart
// ------------------------------------------------------------
//
// series: [{ label, color, width, opacity, values: [{x, y}] }]
// hover(xValue) -> { x, title, rows } | null
// One y-axis only; the caller picks the domain.

function lineChart(el, o) {

    el.textContent = "";

    const width = Math.max(240, el.clientWidth);
    const height = o.height || 260;

    const m = {
        top: 10,
        right: o.endLabels ? 92 : 14,
        bottom: o.xLabel ? 34 : 22,
        left: o.leftMargin || 40
    };

    const all = o.series.flatMap(s => s.values).filter(d => d.y != null);

    const svg = d3.select(el)
        .append("svg")
        .attr("width", width)
        .attr("height", height)
        .attr("role", "img")
        .attr("aria-label", o.ariaLabel || "");

    if (!all.length) {
        return null;
    }

    let [x0, x1] = o.xDomain || d3.extent(all, d => d.x);

    if (x0 === x1) {
        x1 = x0 + 1;
    }

    const x = d3.scaleLinear()
        .domain([x0, x1])
        .range([m.left, width - m.right]);

    let yDomain = o.yDomain;

    if (!yDomain) {
        const [lo, hi] = d3.extent(all, d => d.y);
        const pad = (hi - lo) * 0.08 || Math.abs(hi) * 0.1 || 1;
        yDomain = [lo - pad, hi + pad];
    }

    const y = d3.scaleLinear()
        .domain(yDomain)
        .nice(o.yTicks || 4)
        .range([height - m.bottom, m.top]);

    svg.append("g")
        .attr("class", "grid")
        .selectAll("line")
        .data(y.ticks(o.yTicks || 4))
        .join("line")
        .attr("x1", m.left)
        .attr("x2", width - m.right)
        .attr("y1", d => y(d))
        .attr("y2", d => y(d));

    svg.append("g")
        .attr("class", "axis")
        .attr("transform", `translate(0,${height - m.bottom})`)
        .call(
            d3.axisBottom(x)
                .ticks(Math.max(2, Math.floor((width - m.left - m.right) / 70)))
                .tickSizeOuter(0)
                .tickFormat(d3.format("~g"))
        );

    svg.append("g")
        .attr("class", "axis")
        .attr("transform", `translate(${m.left},0)`)
        .call(
            d3.axisLeft(y)
                .ticks(o.yTicks || 4)
                .tickSize(0)
                .tickPadding(6)
                .tickFormat(o.yFormat || d3.format("~g"))
        )
        .call(g => g.select(".domain").remove());

    if (o.xLabel) {
        svg.append("text")
            .attr("class", "axis-label")
            .attr("x", width - m.right)
            .attr("y", height - 3)
            .attr("text-anchor", "end")
            .text(o.xLabel);
    }

    if (o.zeroLine && y.domain()[0] < 0 && y.domain()[1] > 0) {
        svg.append("line")
            .attr("class", "baseline")
            .attr("x1", m.left)
            .attr("x2", width - m.right)
            .attr("y1", y(0))
            .attr("y2", y(0));
    }

    if (o.markerX != null) {
        svg.append("line")
            .attr("class", "marker")
            .attr("x1", x(o.markerX))
            .attr("x2", x(o.markerX))
            .attr("y1", m.top)
            .attr("y2", height - m.bottom);
    }

    const line = d3.line()
        .defined(d => d.y != null)
        .x(d => x(d.x))
        .y(d => y(d.y));

    for (const s of o.series) {

        if (o.dots) {
            svg.append("g")
                .selectAll("circle")
                .data(s.values)
                .join("circle")
                .attr("class", "dot")
                .attr("cx", d => x(d.x))
                .attr("cy", d => y(d.y))
                .attr("r", 4)
                .style("fill", s.color);
        } else {
            svg.append("path")
                .attr("class", "series-line")
                .attr("d", line(s.values))
                .style("stroke", s.color)
                .style("stroke-width", s.width || 2)
                .style("opacity", s.opacity ?? 1);
        }
    }

    // End labels for the series that ask for one, skipped where they
    // would collide (the legend and tooltip carry those instead).
    if (o.endLabels) {

        const placed = [];

        for (const s of o.series) {

            const last = s.values[s.values.length - 1];

            if (!s.endLabel || !last || last.y == null) {
                continue;
            }

            const ly = y(last.y);

            if (placed.some(p => Math.abs(p - ly) < 12)) {
                continue;
            }

            placed.push(ly);

            svg.append("text")
                .attr("class", "end-label")
                .attr("x", x(last.x) + 6)
                .attr("y", ly + 4)
                .text(s.endLabel);
        }
    }

    if (o.hover) {

        const cross = svg.append("line")
            .attr("class", "crosshair")
            .attr("y1", m.top)
            .attr("y2", height - m.bottom)
            .style("display", "none");

        svg.append("rect")
            .attr("x", m.left)
            .attr("y", m.top)
            .attr("width", width - m.left - m.right)
            .attr("height", height - m.top - m.bottom)
            .style("fill", "transparent")
            .on("pointermove", event => {

                const [px] = d3.pointer(event);
                const info = o.hover(x.invert(px));

                if (!info) {
                    cross.style("display", "none");
                    hideTooltip();
                    return;
                }

                cross
                    .style("display", null)
                    .attr("x1", x(info.x))
                    .attr("x2", x(info.x));

                showTooltip(event, info.title, info.rows);
            })
            .on("pointerleave", () => {
                cross.style("display", "none");
                hideTooltip();
            })
            .on("click", event => {
                if (o.onPick) {
                    const [px] = d3.pointer(event);
                    o.onPick(x.invert(px));
                }
            });
    }

    return { x, y };
}


// Index of the point whose x is nearest `xv` (xs ascending).
function nearestIndex(xs, xv) {

    const i = d3.bisectLeft(xs, xv);

    if (i <= 0) {
        return 0;
    }

    if (i >= xs.length) {
        return xs.length - 1;
    }

    return xv - xs[i - 1] <= xs[i] - xv ? i - 1 : i;
}

function legend(el, items) {

    el.textContent = "";

    for (const item of items) {

        const span = document.createElement("span");
        const key = document.createElement("span");

        key.className = item.dot ? "key dot" : "key";
        key.style.background = item.color;

        span.appendChild(key);
        span.appendChild(document.createTextNode(item.label));
        el.appendChild(span);
    }
}


// ------------------------------------------------------------
// Render
// ------------------------------------------------------------

function selectedAttempt() {

    const run = state.run;

    if (!run || !run.attempts.length) {
        return null;
    }

    if (!state.follow && findAttempt(state.selected)) {
        return findAttempt(state.selected);
    }

    if (run.status !== "running" && run.champion) {
        return findAttempt(run.champion) || run.attempts[run.attempts.length - 1];
    }

    return run.attempts[run.attempts.length - 1];
}

function inspectedIndex(attempt) {

    const last = attempt.points.length - 1;

    return state.step == null ? last : Math.min(state.step, last);
}

function render() {

    const run = state.run;

    for (const tab of document.querySelectorAll(".tabs button")) {
        tab.setAttribute("aria-selected", String(tab.dataset.view === state.view));
    }

    document.getElementById("runView").hidden = state.view !== "run";
    document.getElementById("compareView").hidden = state.view !== "compare";

    document.getElementById("emptyState").hidden = !!run;
    document.getElementById("content").hidden = !run;

    renderHeader();

    if (state.view === "compare") {
        renderCompare();
        return;
    }

    if (!run) {
        return;
    }

    const attempt = selectedAttempt();

    renderTiles(attempt);
    renderAttemptButtons(attempt);

    if (attempt) {
        renderStepControl(attempt);
        renderGroupChart(attempt);
        renderMultiples(attempt);
        renderDqChart(attempt);
    }

    renderAttempts(attempt);
    renderMetricTable(attempt);
    renderChecks();
}

function renderHeader() {

    const run = state.run;
    const pill = document.getElementById("statusPill");
    const info = document.getElementById("runInfo");

    if (!run) {
        pill.textContent = channel ? "Waiting for a run" : "Live feed unavailable";
        pill.className = "pill";
        info.textContent = "";
        return;
    }

    const labels = {
        running: `Live · attempt ${run.attempts.length} of ${run.attemptsPlanned}`,
        finishing: "Live · straightening",
        done: "Finished",
        stopped: "Stopped early",
        empty: "Nothing could be removed"
    };

    pill.textContent = labels[run.status] || run.status;
    pill.className = run.status === "running" || run.status === "finishing" ? "pill live" : "pill";

    const w = run.weights;
    const started = new Date(run.startedAt);

    info.textContent =
        `${started.toLocaleString()} · ${run.nodes} nodes, ${run.edges} roads, ` +
        `${run.facilities} facilities · budget ${Math.round(run.budget * 100)}% of road length · ` +
        `weights NC ${Math.round(w.nc * 100)}% RS ${Math.round(w.rs * 100)}% BB ${Math.round(w.bb * 100)}% · ` +
        `λ ${run.costWeight} · sharpness ${run.sharpness} → k ${Math.round(run.k)}` +
        (run.junctionsOnly ? " · junctions only" : "");
}

function renderTiles(attempt) {

    const run = state.run;
    const el = document.getElementById("tiles");

    el.textContent = "";

    const latest =
        run.afterStraightening ||
        (attempt && attempt.points[attempt.points.length - 1]) ||
        run.start;

    const caption =
        run.afterStraightening
            ? "final, after straightening"
            : attempt ? `attempt ${attempt.attempt}, latest` : "start";

    const tiles = [
        { label: "Structure", key: "structural" },
        { label: "NC junctions", key: "nc" },
        { label: "RS routes", key: "rs" },
        { label: "BB blocks", key: "bb" },
        { label: "Q (structure − λ·cost)", key: "Q" }
    ];

    for (const t of tiles) {

        const value = latest[t.key];
        const delta = value - run.start[t.key];

        el.appendChild(tile(t.label, fmt3(value), delta, `vs start · ${caption}`));
    }

    const kept = latest.cost;

    el.appendChild(tile(
        "Road length kept",
        fmtPct(kept),
        null,
        `budget: keep ${fmtPct(1 - run.budget)}`
    ));
}

function tile(label, value, delta, caption) {

    const div = document.createElement("div");
    div.className = "tile";

    const l = document.createElement("div");
    l.className = "label";
    l.textContent = label;

    const v = document.createElement("div");
    v.className = "value";
    v.textContent = value;

    const d = document.createElement("div");
    d.className = "delta";

    if (delta != null && Math.abs(delta) >= 0.0005) {
        d.classList.add(delta > 0 ? "up" : "down");
        d.textContent = `${delta > 0 ? "▲" : "▼"} ${fmtSigned(delta)} ${caption}`;
    } else {
        d.textContent = delta != null ? `no change ${caption}` : caption;
    }

    div.append(l, v, d);

    return div;
}

function renderAttemptButtons(current) {

    const el = document.getElementById("attemptButtons");
    const run = state.run;

    el.textContent = "";

    for (const a of run.attempts) {

        const b = document.createElement("button");

        b.textContent =
            `${a.attempt}${run.champion === a.attempt ? " ★" : ""}`;

        b.title =
            run.champion === a.attempt ? "Winning attempt" : `Attempt ${a.attempt}`;

        b.setAttribute("aria-pressed", current && current.attempt === a.attempt ? "true" : "false");

        b.onclick = () => {
            state.selected = a.attempt;
            state.follow = false;
            state.step = null;
            render();
        };

        el.appendChild(b);
    }

    if (!state.follow) {

        const b = document.createElement("button");

        b.textContent = run.status === "running" ? "Follow live" : "Show winner";
        b.setAttribute("aria-pressed", "false");

        b.onclick = () => {
            state.follow = true;
            state.step = null;
            render();
        };

        el.appendChild(b);
    }
}

document.querySelectorAll("#xModeButtons button").forEach(b => {
    b.onclick = () => {
        state.xMode = b.dataset.x;
        document.querySelectorAll("#xModeButtons button").forEach(o => {
            o.setAttribute("aria-pressed", o === b ? "true" : "false");
        });
        render();
    };
});

const stepSlider = document.getElementById("stepSlider");

stepSlider.addEventListener("input", () => {

    const attempt = selectedAttempt();

    if (!attempt) {
        return;
    }

    const v = Number(stepSlider.value);

    // Dragged to the end = follow the latest removal again.
    state.step = v >= attempt.points.length - 1 ? null : v;

    render();
});

function renderStepControl(attempt) {

    const i = inspectedIndex(attempt);
    const p = attempt.points[i];

    stepSlider.max = attempt.points.length - 1;
    stepSlider.value = i;

    document.getElementById("stepLabel").textContent =
        `${i} of ${attempt.points.length - 1} · ${fmtPct(1 - p.cost)} removed`;
}

function setStepFromX(attempt, xv) {

    const xs = attempt.points.map(xOf);

    const i = nearestIndex(xs, xv);

    state.step = i >= attempt.points.length - 1 ? null : i;

    render();
}

function renderGroupChart(attempt) {

    const pts = attempt.points;
    const xs = pts.map(xOf);
    const i = inspectedIndex(attempt);

    legend(document.getElementById("groupLegend"),
        GROUP_SERIES.map(s => ({ label: s.label, color: s.color })));

    lineChart(document.getElementById("groupChart"), {
        height: 300,
        ariaLabel: `Group scores over attempt ${attempt.attempt}`,
        xLabel: xLabel(),
        yDomain: [0, 1],
        yFormat: d3.format(".1f"),
        markerX: xs[i],
        endLabels: true,
        series: GROUP_SERIES.map(s => ({
            label: s.label,
            color: s.color,
            endLabel: `${s.label.split(" ")[0]} ${fmt2(pts[pts.length - 1][s.key])}`,
            values: pts.map((p, k) => ({ x: xs[k], y: p[s.key] }))
        })),
        hover: xv => {
            const k = nearestIndex(xs, xv);
            const p = pts[k];
            return {
                x: xs[k],
                title: xTitle(p, k),
                rows: GROUP_SERIES.map(s => ({
                    color: s.color,
                    value: fmt3(p[s.key]),
                    label: s.label
                })).concat([{ value: fmt3(p.Q), label: "Q" }])
            };
        },
        onPick: xv => setStepFromX(attempt, xv)
    });
}

function renderMultiples(attempt) {

    const run = state.run;
    const el = document.getElementById("multiples");
    const pts = attempt.points;
    const xs = pts.map(xOf);
    const i = inspectedIndex(attempt);
    const p = pts[i];

    el.textContent = "";

    for (const def of run.metrics) {

        const box = document.createElement("div");
        box.className = "multiple";

        const h = document.createElement("h3");
        h.textContent = `${def.label} · ${GROUP_NAMES[def.group].split(" ")[0]}`;

        const rule = document.createElement("p");
        rule.className = "rule";
        rule.textContent = `${def.rule} · ${Math.round(def.weight * 100)}% of ${def.group.toUpperCase()}`;

        const now = document.createElement("p");
        now.className = "now";

        const strong = document.createElement("strong");
        strong.textContent = fmt2(scoreValue(p, def.key));

        now.append(
            "score ", strong,
            ` · raw ${formatRaw(def.unit, rawValue(p, def.raw))}` +
            ` (start ${formatRaw(def.unit, rawValue(run.start, def.raw))})`
        );

        const chart = document.createElement("div");
        chart.className = "chart";

        box.append(h, rule, now, chart);
        el.appendChild(box);

        lineChart(chart, {
            height: 130,
            ariaLabel: `${def.label} score over attempt ${attempt.attempt}`,
            yDomain: [0, 1],
            yTicks: 2,
            yFormat: d3.format(".1f"),
            leftMargin: 30,
            markerX: xs[i],
            series: [{
                color: "var(--series-1)",
                values: pts.map((q, k) => ({ x: xs[k], y: scoreValue(q, def.key) }))
            }],
            hover: xv => {
                const k = nearestIndex(xs, xv);
                const q = pts[k];
                return {
                    x: xs[k],
                    title: xTitle(q, k),
                    rows: [
                        { color: "var(--series-1)", value: fmt3(scoreValue(q, def.key)), label: "score" },
                        { value: formatRaw(def.unit, rawValue(q, def.raw)), label: "raw" }
                    ]
                };
            },
            onPick: xv => setStepFromX(attempt, xv)
        });
    }
}

function renderDqChart(attempt) {

    const run = state.run;

    // Point 0 is the untouched network; removals start at 1.
    const removals = attempt.points
        .map((p, k) => ({ p, k }))
        .filter(d => d.k > 0 && d.p.dQ != null);

    const random = removals.filter(d => d.p.phase !== "greedy");
    const greedy = removals.filter(d => d.p.phase === "greedy");

    legend(document.getElementById("dqLegend"), [
        { label: `Random pick (${random.length})`, color: "var(--series-1)", dot: true },
        { label: `Greedy finish (${greedy.length})`, color: "var(--series-2)", dot: true }
    ]);

    const xs = removals.map(d => d.k);

    lineChart(document.getElementById("dqChart"), {
        height: 240,
        dots: true,
        zeroLine: true,
        leftMargin: 64,
        ariaLabel: `Change in Q per removal, attempt ${attempt.attempt}`,
        xLabel: "Removal number",
        xDomain: [0, Math.max(1, attempt.points.length - 1)],
        yFormat: d3.format(".1e"),
        markerX: inspectedIndex(attempt),
        series: [
            { color: "var(--series-1)", values: random.map(d => ({ x: d.k, y: d.p.dQ })) },
            { color: "var(--series-2)", values: greedy.map(d => ({ x: d.k, y: d.p.dQ })) }
        ],
        hover: xv => {
            if (!xs.length) {
                return null;
            }
            const d = removals[nearestIndex(xs, xv)];
            const prob = 1 / (1 + Math.exp(-run.k * d.p.dQ));
            return {
                x: d.k,
                title: xTitle(d.p, d.k),
                rows: [
                    {
                        color: d.p.phase === "greedy" ? "var(--series-2)" : "var(--series-1)",
                        value: d3.format("+.2e")(d.p.dQ),
                        label: "ΔQ"
                    },
                    d.p.phase === "greedy"
                        ? { value: "greedy", label: "least harmful allowed road" }
                        : { value: fmtPct(prob), label: "chance it had of being removed" },
                    { value: fmt3(d.p.structural), label: "structure after" }
                ]
            };
        },
        onPick: xv => {
            if (xs.length) {
                const d = removals[nearestIndex(xs, xv)];
                state.step = d.k >= attempt.points.length - 1 ? null : d.k;
                render();
            }
        }
    });
}

function renderAttempts(current) {

    const run = state.run;
    const selectedN = current ? current.attempt : null;

    legend(document.getElementById("attemptLegend"), [
        { label: selectedN ? `Attempt ${selectedN} (inspected)` : "Inspected attempt", color: "var(--series-1)" },
        { label: "Other attempts", color: "var(--text-muted)" }
    ]);

    // Structure score of every attempt against road length removed
    // (a shared x, whatever the toggle says, so attempts line up).
    const series = run.attempts
        .slice()
        .sort((a, b) => (a.attempt === selectedN) - (b.attempt === selectedN))
        .map(a => ({
            label: `Attempt ${a.attempt}`,
            color: a.attempt === selectedN ? "var(--series-1)" : "var(--text-muted)",
            width: a.attempt === selectedN ? 2 : 1.5,
            opacity: a.attempt === selectedN ? 1 : 0.6,
            endLabel: a.attempt === selectedN || a.attempt === run.champion
                ? `${a.attempt === run.champion ? "★ " : ""}#${a.attempt} ${fmt3(a.points[a.points.length - 1].structural)}`
                : null,
            values: a.points.map(p => ({ x: (1 - p.cost) * 100, y: p.structural }))
        }));

    lineChart(document.getElementById("attemptChart"), {
        height: 260,
        endLabels: true,
        ariaLabel: "Structure score of every attempt",
        xLabel: "Road length removed (%)",
        yFormat: d3.format(".2f"),
        series,
        hover: xv => ({
            x: xv,
            title: `${d3.format(".1f")(xv)}% of road length removed`,
            rows: run.attempts.map(a => {
                const xs = a.points.map(p => (1 - p.cost) * 100);
                const p = a.points[nearestIndex(xs, xv)];
                return {
                    color: a.attempt === selectedN ? "var(--series-1)" : "var(--text-muted)",
                    value: fmt3(p.structural),
                    label: `attempt ${a.attempt}${a.attempt === run.champion ? " ★ winner" : ""}`
                };
            })
        })
    });

    // Table.
    const table = document.getElementById("attemptTable");

    table.textContent = "";

    const head = table.createTHead().insertRow();

    for (const h of ["Attempt", "Structure", "NC", "RS", "BB", "Q", "Length kept",
                     "Roads removed", "Greedy", "Passes", "Budget met"]) {
        const th = document.createElement("th");
        th.textContent = h;
        head.appendChild(th);
    }

    const body = table.createTBody();

    for (const a of run.attempts) {

        const last = a.points[a.points.length - 1];
        const s = a.summary;
        const row = body.insertRow();

        row.className = "clickable" + (a.attempt === selectedN ? " selected" : "");
        row.onclick = () => {
            state.selected = a.attempt;
            state.follow = false;
            state.step = null;
            render();
        };

        const cells = [
            `${a.attempt}${a.attempt === run.champion ? " ★ winner" : ""}${s ? "" : " (running)"}`,
            fmt3(last.structural),
            fmt3(last.nc),
            fmt3(last.rs),
            fmt3(last.bb),
            fmt3(last.Q),
            fmtPct(last.cost),
            s ? s.removed : a.points.length - 1,
            s ? s.greedy : "–",
            s ? s.passes : "–",
            s ? (s.budgetMet ? "yes" : "no") : "–"
        ];

        cells.forEach((c, k) => {
            const td = row.insertCell();
            td.textContent = c;
            if (k === 0) {
                td.className = "text";
            }
        });
    }
}

function renderMetricTable(attempt) {

    const run = state.run;
    const table = document.getElementById("metricTable");

    table.textContent = "";

    const cols = [{ label: "Start", point: run.start }];

    if (attempt) {

        const i = inspectedIndex(attempt);

        if (i < attempt.points.length - 1) {
            cols.push({ label: `Attempt ${attempt.attempt}, removal ${i}`, point: attempt.points[i] });
        }

        cols.push({
            label: `Attempt ${attempt.attempt}, ${attempt.summary ? "end" : "latest"}`,
            point: attempt.points[attempt.points.length - 1]
        });
    }

    if (run.afterStraightening) {
        cols.push({ label: "Final (straightened)", point: run.afterStraightening });
    }

    const head = table.createTHead().insertRow();

    for (const h of ["Metric", "How it is scored", "Weight"].concat(cols.map(c => c.label))) {
        const th = document.createElement("th");
        th.textContent = h;
        head.appendChild(th);
    }

    const body = table.createTBody();

    const groupRow = (label, key) => {

        const row = body.insertRow();

        row.className = "group";

        const td = row.insertCell();
        td.colSpan = 3;
        td.textContent = label;

        for (const c of cols) {
            const cell = row.insertCell();
            cell.textContent = fmt3(c.point[key]);
            cell.style.textAlign = "right";
        }
    };

    for (const group of ["nc", "rs", "bb"]) {

        groupRow(`${GROUP_NAMES[group]} · ${Math.round(run.weights[group] * 100)}% of structure`, group);

        for (const def of run.metrics.filter(d => d.group === group)) {

            const row = body.insertRow();

            const name = row.insertCell();
            name.textContent = def.label;

            const rule = row.insertCell();
            rule.className = "text";
            rule.textContent = def.rule;

            const w = row.insertCell();
            w.textContent = `${Math.round(def.weight * 100)}%`;

            for (const c of cols) {

                const td = row.insertCell();

                td.append(formatRaw(def.unit, rawValue(c.point, def.raw)));

                const sc = document.createElement("span");
                sc.className = "score";
                sc.textContent = fmt2(scoreValue(c.point, def.key));

                td.appendChild(sc);
            }
        }
    }

    groupRow("Structure (weighted NC + RS + BB)", "structural");
    groupRow(`Q = structure − ${run.costWeight} × cost`, "Q");
    groupRow("Cost (road length ÷ original)", "cost");
}

function renderChecks() {

    const run = state.run;
    const el = document.getElementById("checks");

    el.textContent = "";

    const block = (title, lines) => {

        const div = document.createElement("div");
        const h = document.createElement("h3");

        h.textContent = title;
        div.appendChild(h);

        for (const line of lines) {
            const p = document.createElement("p");
            p.textContent = line;
            div.appendChild(p);
        }

        el.appendChild(div);
    };

    block("Removal probability", [
        `k = ${run.sharpness} ÷ typical |ΔQ| ${run.typicalDQ.toExponential(2)} = ${Math.round(run.k)}`,
        `A removal with ΔQ = +typical has P = ${fmtPct(1 / (1 + Math.exp(-run.sharpness)))}; ` +
        `−typical has P = ${fmtPct(1 / (1 + Math.exp(run.sharpness)))}.`
    ]);

    if (run.rejections) {
        const r = run.rejections;
        block("Hard rules (all attempts)", [
            `${r.accepted} candidate removals allowed`,
            `${r.disconnect} refused: would split the network`,
            `${r.required} refused: dead end at a facility or OD node`,
            `${r.access} refused: a block's last road`
        ]);
    }

    if (run.repair) {
        const r = run.repair;
        block("Access check (winner)", [
            `${r.facilities} facilities and ${r.blocks} blocks need a road`,
            r.restored
                ? `${r.restored} removed roads put back to reconnect ${r.repaired}`
                : "All reachable; nothing to repair"
        ]);
    }

    if (run.finalCheck) {
        const c = run.finalCheck;
        block("After straightening", [
            c.restored
                ? `${c.restored} straightened points put back`
                : "Straightening broke no road",
            `Roads made to cross: unbuildable ground ${c.reasons.ground}, ` +
            `outside the city ${c.reasons.city}, another road ${c.reasons.crossing}`,
            run.beforeStraightening
                ? `Structure ${fmt3(run.beforeStraightening.structural)} → ${fmt3(run.afterStraightening.structural)}`
                : ""
        ].filter(Boolean));
    }
}



// ------------------------------------------------------------
// Real roads vs plan
// ------------------------------------------------------------
//
// The button asks the planner tab (metrics-feed.js, real-roads.js)
// for a comparison. It answers with compare-status messages and a
// compare-result, which is kept in localStorage like the run.

let compareWatchdog = null;

const ASKING = "Asking the planner tab...";

for (const tab of document.querySelectorAll(".tabs button")) {

    tab.addEventListener("click", () => {

        state.view = tab.dataset.view;

        history.replaceState(
            null, "",
            state.view === "compare" ? "#compare" : location.pathname + location.search
        );

        render();
    });
}

document.getElementById("compareBtn").addEventListener("click", () => {

    if (!channel) {
        state.compareStatus = "This browser has no BroadcastChannel, so the page cannot reach the planner.";
        render();
        return;
    }

    state.compareBusy = true;
    state.compareStatus = ASKING;

    channel.postMessage({ type: "compare-request" });

    // Nothing answers when no planner tab is open.
    clearTimeout(compareWatchdog);

    compareWatchdog = setTimeout(() => {
        if (state.compareBusy && state.compareStatus === ASKING) {
            state.compareBusy = false;
            state.compareStatus =
                "No planner tab answered. Open the planner (index page, same address) " +
                "with a finished Simplify run, then try again.";
            render();
        }
    }, 4000);

    render();
});

function handleCompareMessage(msg) {

    if (msg.type === "compare-status") {

        state.compareBusy = true;
        state.compareStatus = msg.message;

    } else if (msg.type === "compare-error") {

        state.compareBusy = false;
        state.compareStatus = msg.message;

    } else if (msg.type === "compare-result") {

        state.compareBusy = false;
        state.compareStatus = `Compared at ${new Date(msg.result.createdAt).toLocaleTimeString()}.`;
        state.compare = msg.result;
    }
}

function compareRaw(side, key) {
    const c = state.compare;
    const i = c.rawKeys.indexOf(key);
    return i >= 0 ? c[side].point.raw[i] : null;
}

function compareScore(side, key) {
    const c = state.compare;
    const i = c.scoreKeys.indexOf(key);
    return i >= 0 ? c[side].point.scores[i] : null;
}

function renderCompare() {

    const c = state.compare;

    document.getElementById("compareBtn").disabled = state.compareBusy;
    document.getElementById("compareStatus").textContent = state.compareStatus;

    document.getElementById("compareEmpty").hidden = !!c;
    document.getElementById("compareContent").hidden = !c;

    if (!c) {
        return;
    }

    const pct = v => `${Math.round(v * 100)}%`;

    document.getElementById("compareInfo").textContent =
        `${c.area.lat.toFixed(4)}, ${c.area.lon.toFixed(4)} · compared ` +
        `${new Date(c.createdAt).toLocaleString()} · OpenStreetMap data of ${c.source.date} · ` +
        `weights NC ${pct(c.weights.nc)} RS ${pct(c.weights.rs)} BB ${pct(c.weights.bb)} · ` +
        `λ ${c.costWeight}`;

    renderCompareTiles(c);
    legend(document.getElementById("compareLegend"), COMPARE_SERIES);
    renderCompareChart(c);
    renderCompareMaps(c);
    renderCompareTable(c);
    renderCompareNotes(c);
}

function kmLabel(c, px) {
    return `${d3.format(".1f")(px * c.area.metresPerPixel / 1000)} km`;
}

function renderCompareTiles(c) {

    const el = document.getElementById("compareTiles");

    el.textContent = "";

    const tiles = [
        { label: "Q (structure − λ·cost)", get: s => c[s].point.Q },
        { label: "Structure", get: s => c[s].point.structural },
        { label: "NC junctions", get: s => c[s].point.nc },
        { label: "RS routes", get: s => c[s].point.rs },
        { label: "BB blocks", get: s => c[s].point.bb }
    ];

    for (const t of tiles) {
        const real = t.get("real");
        const plan = t.get("plan");
        el.appendChild(compareTile(t.label, [fmt3(real), fmt3(plan)], plan - real, "plan − real"));
    }

    const realLen = c.real.stats.length;
    const planLen = c.plan.stats.length;

    el.appendChild(compareTile(
        "Road length",
        [kmLabel(c, realLen), kmLabel(c, planLen)],
        null,
        `plan ${d3.format("+.0%")(planLen / realLen - 1)} vs real`
    ));
}

function compareTile(label, values, delta, caption) {

    const div = document.createElement("div");
    div.className = "tile";

    const l = document.createElement("div");
    l.className = "label";
    l.textContent = label;
    div.appendChild(l);

    COMPARE_SERIES.forEach((series, i) => {

        const row = document.createElement("div");
        row.className = "pair";

        const who = document.createElement("span");
        who.className = "who";
        who.style.setProperty("--key", series.color);
        who.textContent = series.label;

        const num = document.createElement("span");
        num.className = "num";
        num.textContent = values[i];

        row.append(who, num);
        div.appendChild(row);
    });

    const d = document.createElement("div");
    d.className = "delta";

    if (delta != null && Math.abs(delta) >= 0.0005) {
        d.classList.add(delta > 0 ? "up" : "down");
        d.textContent = `${delta > 0 ? "▲" : "▼"} ${fmtSigned(delta)} ${caption}`;
    } else {
        d.textContent = delta != null ? `same ${caption}` : caption;
    }

    div.appendChild(d);

    return div;
}


// Horizontal grouped bars: one row per score, Real and Plan side by
// side, 0..1. Group rows carry value labels; every row has a
// tooltip with the raw values.
function renderCompareChart(c) {

    const el = document.getElementById("compareChart");

    el.textContent = "";

    const mpp = c.area.metresPerPixel;

    const rows = [
        { label: "Structure", get: s => c[s].point.structural, labelled: true },
        { label: "NC · junctions", get: s => c[s].point.nc, labelled: true },
        { label: "RS · routes", get: s => c[s].point.rs, labelled: true },
        { label: "BB · blocks", get: s => c[s].point.bb, labelled: true, last: true }
    ].concat(c.metrics.map(def => ({
        label: def.label,
        get: s => compareScore(s, def.key),
        raw: s => formatRaw(def.unit, compareRaw(s, def.raw), mpp)
    })));

    const width = Math.max(300, el.clientWidth);
    const narrow = width < 520;
    const rowH = 30;
    const gap = 18;
    const m = { top: 22, right: 44, bottom: 6, left: narrow ? 130 : 190 };
    const height = m.top + rows.length * rowH + gap + m.bottom;

    const x = d3.scaleLinear().domain([0, 1]).range([m.left, width - m.right]);
    const rowY = i => m.top + i * rowH + (i >= 4 ? gap : 0);

    const svg = d3.select(el)
        .append("svg")
        .attr("width", width)
        .attr("height", height)
        .attr("role", "img")
        .attr("aria-label", "Scores of the real roads and the plan, side by side");

    svg.append("g")
        .attr("class", "grid")
        .selectAll("line")
        .data(x.ticks(4))
        .join("line")
        .attr("x1", d => x(d))
        .attr("x2", d => x(d))
        .attr("y1", m.top - 4)
        .attr("y2", height - m.bottom);

    svg.append("g")
        .attr("class", "axis")
        .selectAll("text")
        .data(x.ticks(4))
        .join("text")
        .attr("x", d => x(d))
        .attr("y", m.top - 8)
        .attr("text-anchor", "middle")
        .text(d => fmt2(d));

    const bar = 9;

    rows.forEach((row, i) => {

        const y0 = rowY(i);
        const g = svg.append("g");

        g.append("text")
            .attr("class", "axis-label")
            .attr("x", m.left - 8)
            .attr("y", y0 + rowH / 2)
            .attr("dy", "0.35em")
            .attr("text-anchor", "end")
            .style("fill", "var(--text-secondary)")
            .text(narrow && row.label.length > 20 ? `${row.label.slice(0, 19)}…` : row.label);

        COMPARE_SERIES.forEach((series, k) => {

            const v = row.get(series.key);
            const yb = y0 + 5 + k * (bar + 2);

            g.append("rect")
                .attr("x", x(0))
                .attr("y", yb)
                .attr("width", Math.max(0, x(Math.max(0, Math.min(1, v || 0))) - x(0)))
                .attr("height", bar)
                .attr("rx", 2)
                .style("fill", series.color);

            if (row.labelled) {
                g.append("text")
                    .attr("class", "end-label")
                    .attr("x", x(Math.max(0, Math.min(1, v || 0))) + 4)
                    .attr("y", yb + bar / 2)
                    .attr("dy", "0.35em")
                    .text(fmt2(v));
            }
        });

        // Hit target: the whole row.
        g.append("rect")
            .attr("x", 0)
            .attr("y", y0)
            .attr("width", width)
            .attr("height", rowH)
            .style("fill", "transparent")
            .on("mousemove", event => {
                const real = row.get("real");
                const plan = row.get("plan");
                showTooltip(event, row.label, [
                    ...COMPARE_SERIES.map(s => ({
                        color: s.color,
                        value: fmt3(row.get(s.key)),
                        label: s.label + (row.raw ? ` · ${row.raw(s.key)}` : "")
                    })),
                    { value: fmtSigned(plan - real), label: "plan − real" }
                ]);
            })
            .on("mouseleave", hideTooltip);
    });

    svg.append("line")
        .attr("class", "baseline")
        .attr("x1", x(0))
        .attr("x2", x(0))
        .attr("y1", m.top - 4)
        .attr("y2", height - m.bottom);
}


// The two networks on the same area and scale: one overlay map
// with a switch per network, or side by side.
function renderCompareMaps(c) {

    renderMapControls();

    const el = document.getElementById("compareMaps");

    el.textContent = "";
    el.classList.toggle("single", state.mapMode === "overlay");

    const xs = c.area.ring.map(p => p[0]);
    const ys = c.area.ring.map(p => p[1]);
    const pad = Math.max(...xs) - Math.min(...xs);
    const box = [
        Math.min(...xs) - pad * 0.02,
        Math.min(...ys) - pad * 0.02,
        Math.max(...xs) - Math.min(...xs) + pad * 0.04,
        Math.max(...ys) - Math.min(...ys) + pad * 0.04
    ];

    const ring = "M" + c.area.ring.map(p => p.join(",")).join("L") + "Z";

    const panel = (title, color, series) => {

        const div = document.createElement("div");
        div.className = "map-panel";

        const h = document.createElement("h3");
        h.textContent = title;
        if (color) {
            h.style.color = color;
        }
        div.appendChild(h);

        const svg = d3.select(div)
            .append("svg")
            .attr("viewBox", box.join(" "))
            .attr("role", "img")
            .attr("aria-label", `${title}: road network`);

        svg.append("path").attr("class", "city").attr("d", ring);

        // Real first, so the plan is drawn on top of it.
        for (const s of series) {
            drawNetwork(svg, c[s.key], s.color);
        }

        for (const s of series) {
            div.appendChild(networkCaption(c, s));
        }

        el.appendChild(div);
    };

    if (state.mapMode === "overlay") {

        const shown = COMPARE_SERIES.filter(s => state.mapShow[s.key]);

        panel(
            shown.length === 2 ? "Real roads and plan"
                : shown.length ? shown[0].label : "Nothing switched on",
            null,
            shown
        );

    } else {

        for (const s of COMPARE_SERIES) {
            panel(s.label, s.color, [s]);
        }
    }
}

function drawNetwork(svg, side, color) {

    let minor = "";
    let major = "";

    for (let i = 0; i + 5 <= side.lines.length; i += 5) {
        const [x1, y1, x2, y2, big] = side.lines.slice(i, i + 5);
        const d = `M${x1},${y1}L${x2},${y2}`;
        if (big) {
            major += d;
        } else {
            minor += d;
        }
    }

    svg.append("path")
        .attr("class", "net")
        .attr("d", minor)
        .style("stroke", color)
        .style("stroke-width", 1);

    svg.append("path")
        .attr("class", "net")
        .attr("d", major)
        .style("stroke", color)
        .style("stroke-width", 2.4);
}

function networkCaption(c, series) {

    const st = c[series.key].stats;
    const blocks = compareRaw(series.key, "blocks");

    const p = document.createElement("p");
    p.className = "caption";

    const key = document.createElement("span");
    key.style.color = series.color;
    key.textContent = `${series.label}: `;

    p.append(
        key,
        `${kmLabel(c, st.length)} of road · ${st.junctions} intersections · ` +
        `${st.deadEnds} dead ends · ${blocks} enclosed blocks` +
        (st.cutEnds ? ` · ${st.cutEnds} roads cut at the city edge` : "")
    );

    return p;
}

// Overlay / side by side, and in overlay a switch per network.
function renderMapControls() {

    const el = document.getElementById("compareMapControls");

    el.textContent = "";

    const seg = document.createElement("span");
    seg.className = "seg";

    for (const [mode, label] of [["overlay", "Overlay"], ["split", "Side by side"]]) {

        const b = document.createElement("button");
        b.textContent = label;
        b.setAttribute("aria-pressed", String(state.mapMode === mode));
        b.addEventListener("click", () => {
            state.mapMode = mode;
            render();
        });
        seg.appendChild(b);
    }

    el.appendChild(seg);

    if (state.mapMode !== "overlay") {
        return;
    }

    for (const s of COMPARE_SERIES) {

        const label = document.createElement("label");
        label.className = "toggle";

        const box = document.createElement("input");
        box.type = "checkbox";
        box.checked = state.mapShow[s.key];
        box.addEventListener("change", () => {
            state.mapShow[s.key] = box.checked;
            render();
        });

        const key = document.createElement("span");
        key.className = "key";
        key.style.background = s.color;

        label.append(box, key, s.label);
        el.appendChild(label);
    }
}


function renderCompareTable(c) {

    const table = document.getElementById("compareTable");

    table.textContent = "";

    const mpp = c.area.metresPerPixel;

    const head = table.createTHead().insertRow();

    for (const h of ["Metric", "How it is scored", "Weight", "Real roads", "Plan", "Plan − real"]) {
        const th = document.createElement("th");
        th.textContent = h;
        head.appendChild(th);
    }

    const body = table.createTBody();

    const diffCell = (row, d) => {
        const td = row.insertCell();
        const span = document.createElement("span");
        span.className = "diff" + (Math.abs(d) >= 0.0005 ? (d > 0 ? " up" : " down") : "");
        span.textContent = fmtSigned(d);
        td.appendChild(span);
    };

    const groupRow = (label, key) => {

        const row = body.insertRow();
        row.className = "group";

        const td = row.insertCell();
        td.colSpan = 3;
        td.textContent = label;

        for (const s of ["real", "plan"]) {
            const cell = row.insertCell();
            cell.textContent = fmt3(c[s].point[key]);
            cell.style.textAlign = "right";
        }

        diffCell(row, c.plan.point[key] - c.real.point[key]);
    };

    for (const group of ["nc", "rs", "bb"]) {

        groupRow(`${GROUP_NAMES[group]} · ${Math.round(c.weights[group] * 100)}% of structure`, group);

        for (const def of c.metrics.filter(d => d.group === group)) {

            const row = body.insertRow();

            row.insertCell().textContent = def.label;

            const rule = row.insertCell();
            rule.className = "text";
            rule.textContent = def.rule;

            row.insertCell().textContent = `${Math.round(def.weight * 100)}%`;

            for (const s of ["real", "plan"]) {

                const td = row.insertCell();

                td.append(formatRaw(def.unit, compareRaw(s, def.raw), mpp));

                const sc = document.createElement("span");
                sc.className = "score";
                sc.textContent = fmt2(compareScore(s, def.key));
                td.appendChild(sc);
            }

            diffCell(row, compareScore("plan", def.key) - compareScore("real", def.key));
        }
    }

    groupRow("Structure (weighted NC + RS + BB)", "structural");
    groupRow(`Q = structure − ${c.costWeight} × cost`, "Q");

    // Cost: lower is shorter, so the difference is not coloured.
    const row = body.insertRow();
    row.className = "group";
    const td = row.insertCell();
    td.colSpan = 3;
    td.textContent = "Cost (road length ÷ the plan's starting network)";
    for (const s of ["real", "plan"]) {
        const cell = row.insertCell();
        cell.textContent = fmt3(c[s].point.cost);
        cell.style.textAlign = "right";
    }
    row.insertCell().textContent = fmtSigned(c.plan.point.cost - c.real.point.cost);
}


function renderCompareNotes(c) {

    const el = document.getElementById("compareNotes");

    el.textContent = "";

    const n = c.notes;
    const pct = v => `${Math.round(v * 100)}%`;

    const mpp = c.area.metresPerPixel;
    const ha = px2 => d3.format(".1f")(px2 * mpp * mpp / 10000);
    const realSpacing = 1 / compareRaw("real", "junctionsPerLength") * mpp;

    const lines = [
        `Scale: the plan's blocks are spaced R = ${Math.round(c.area.R * mpp)} m apart and it ` +
        `aims for a junction every ${Math.round(1.5 * c.area.R * mpp)} m of road. The real roads ` +
        `have one every ${Math.round(realSpacing)} m, and their blocks average ` +
        `${ha(compareRaw("real", "meanBlockArea"))} ha against the plan's ` +
        `${ha(compareRaw("plan", "meanBlockArea"))} ha. Junction spacing, block area and cost are ` +
        "judged at the plan's scale, so a finer real network scores low on them for being finer, " +
        "not necessarily worse, and Q (which subtracts cost) mostly says how much road each has. " +
        "Structure is the fairer single number; to compare like for like, lower R until the " +
        "plan's blocks match the real ones.",
        `Real roads: © OpenStreetMap contributors (ODbL), data of ${c.source.date} ` +
        `(${c.source.files.join(", ")}). Road classes: ${c.source.classes.join(", ")}. ` +
        "Service roads (driveways, parking aisles), tracks and paths are left out.",
        "Both networks are clipped to the city boundary and scored by the planner's own quality " +
        `model with the run's weights (NC ${pct(c.weights.nc)}, RS ${pct(c.weights.rs)}, ` +
        `BB ${pct(c.weights.bb)}), λ ${c.costWeight}, block-size and Shimbel references and ` +
        "starting road length, so the same yardstick applies to both.",
        "Each network picks its own trip origins for RS the same way (its 16 farthest-apart " +
        "intersections). The plan is scored without its facility spurs, so its numbers differ " +
        "slightly from the Final column of the run view.",
        `${c.real.stats.cutEnds} real roads leave the city; where they are cut at the boundary ` +
        "is not counted as a dead end (or as a node for NC).",
        `${n.crossings} places where two real roads cross without a shared node (flyovers, ` +
        "bridges, tunnels or mapping gaps) were given a node, because blocks (BB) need a planar " +
        "network. Routes may therefore turn there, which the real road may not allow.",
        n.droppedPieces
            ? `${n.droppedPieces} real pieces (${kmLabel(c, n.droppedLength)}) not connected to the ` +
              "main network inside the city were left out; the plan is one network too."
            : "The real roads inside the city form one network.",
        "Real blocks cut by the city edge are open (they would close outside the area), so BB " +
        "counts only blocks enclosed inside the city. The plan has roads along its edge, which " +
        "close its edge blocks.",
        "Shape points of real roads were thinned to within 0.5 px of the original line " +
        `(${d3.format(".1f")(0.5 * c.area.metresPerPixel)} m), keeping bends.`
    ];

    for (const text of lines) {
        const li = document.createElement("li");
        li.textContent = text;
        el.appendChild(li);
    }
}

render();
