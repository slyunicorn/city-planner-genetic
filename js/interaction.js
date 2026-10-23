// js/interaction.js
// Map click, panning and zooming.
// Plain script: shares the global scope with the other js/ files,
// so load order in index.html matters.

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
