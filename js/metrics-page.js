// js/metrics-page.js
// The metrics page (metrics.html): charts and tables of the road
// quality metrics, fed live by js/metrics-feed.js in the app.
// Plain script, loaded only by metrics.html (not by index.html).

const CHANNEL_NAME = "ai-city-road-metrics";
const STORAGE_KEY = "aiCity.roadMetrics.lastRun";

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
    xMode: "removed"
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

function formatRaw(unit, v) {

    if (v == null) {
        return "–";
    }

    const mpp = state.run.metresPerPixel || 1;

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

    document.getElementById("emptyState").hidden = !!run;
    document.getElementById("content").hidden = !run;

    renderHeader();

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

render();
