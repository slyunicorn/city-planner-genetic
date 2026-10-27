// js/controls-facilities.js
// Relaxation and facility controls, per-layer sliders and toggles.
// Plain script: shares the global scope with the other js/ files,
// so load order in index.html matters.

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

flatPullSlider.addEventListener(
    "input",
    () => {

        flatPullValue.textContent =
            Number(flatPullSlider.value).toFixed(1);
    }
);

lowPullSlider.addEventListener(
    "input",
    () => {

        lowPullValue.textContent =
            Number(lowPullSlider.value).toFixed(1);
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
