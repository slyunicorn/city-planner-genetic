// js/ui-panels.js
// Tabs, draggable control panel, window resize.
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
