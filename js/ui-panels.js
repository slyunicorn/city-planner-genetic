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

            dragging = true;


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
