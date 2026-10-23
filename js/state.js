// js/state.js
// Shared world, camera, settings and relaxation state.
// Plain script: shares the global scope with the other js/ files,
// so load order in index.html matters.

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
