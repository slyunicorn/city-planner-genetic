// js/ui-panels.js
// Tabs, draggable panels (controls, land cover legend), window resize.
// Plain script: shares the global scope with the other js/ files,
// so load order in index.html matters.


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
// DRAGGABLE PANELS
// ============================================================

// Drag `panel` by pressing on `handle` (its header bar).
function makeDraggable(panel, handle) {

    let dragging = false;

    let offsetX = 0;
    let offsetY = 0;


    handle.addEventListener(
        "pointerdown",
        event => {

            // Buttons in a header bar stay clickable.
            if (event.target.closest("button, input, select")) {
                return;
            }

            dragging = true;

            // Lets CSS stop an iframe inside from eating the drag.
            panel.classList.add("dragging");


            const rect =
                panel.getBoundingClientRect();


            offsetX =
                event.clientX - rect.left;

            offsetY =
                event.clientY - rect.top;


            handle.setPointerCapture(
                event.pointerId
            );
        }
    );


    handle.addEventListener(
        "pointermove",
        event => {

            if (!dragging) {
                return;
            }


            panel.style.left =
                `${event.clientX - offsetX}px`;


            panel.style.top =
                `${event.clientY - offsetY}px`;


            // The legend is anchored by `bottom` in CSS
            // in some layouts; once moved, `top` rules.
            panel.style.bottom = "auto";
        }
    );


    handle.addEventListener(
        "pointerup",
        () => {

            dragging = false;

            panel.classList.remove("dragging");
        }
    );
}


const controls =
    document.getElementById("controls");

const controlsHeader =
    document.getElementById("controls-header");

makeDraggable(controls, controlsHeader);


makeDraggable(
    document.getElementById("landCoverLegend"),
    document.getElementById("landCoverLegend-header")
);


// ============================================================
// METRICS WINDOW
// ============================================================
//
// The metrics page (metrics.html) in a window over the map. A
// Simplify run is animated with requestAnimationFrame, which
// browsers pause while a tab is in the background, so watching
// it from another tab stalls the run. In this window both stay in
// one visible tab. The page talks to the planner over the same
// BroadcastChannel either way.

function showMetricsWindow(show = metricsWindow.hidden) {

    if (show && !metricsFrame.getAttribute("src")) {
        metricsFrame.src = "metrics.html";
    }

    metricsWindow.hidden = !show;

    metricsPageBtn.textContent =
        show ? "Hide metrics window" : "Show metrics window";
}

makeDraggable(
    metricsWindow,
    document.getElementById("metricsWindow-header")
);

document.getElementById("metricsCloseBtn").addEventListener(
    "click",
    () => showMetricsWindow(false)
);

document.getElementById("metricsTabBtn").addEventListener(
    "click",
    () => {
        showMetricsWindow(false);
        openMetricsPage();
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
