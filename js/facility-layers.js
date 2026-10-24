// js/facility-layers.js
// Facility layer definitions (Emergency / Amenity / Shop) and optimizer flags.
// Plain script: shares the global scope with the other js/ files,
// so load order in index.html matters.

// ============================================================
// FACILITY LAYER STATE
// ============================================================
//
// A second, much sparser Poisson-disc point set laid over the
// city. Each of these points is an essential facility (fire
// station, hospital, ...) and gets its own Voronoi cell - the
// area that facility serves. These are the ONLY points moved
// during optimization; the fine-grained block points stay put
// and act as the "demand" the metric is measured against.
// ============================================================

// ============================================================
// FACILITY LAYERS
// ============================================================
//
// Three layers taken from the OpenStreetMap Map Features
// taxonomy, each rendered in its own colour with its own
// Voronoi service areas and Delaunay adjacency graph.
//
// `groups` lists the OSM sub-categories that belong to each
// layer. They are descriptive for now - the generator places
// abstract sites, not tagged OSM objects - but they fix what
// each layer means and are what a future OSM import would
// query against.
//
// Spacing defaults reflect how far apart each kind of thing
// actually sits: emergency services are sparse and strategic,
// amenities mid-density, shops dense.
// ============================================================

const FACILITY_LAYERS = [
    {
        key: "emergency",
        label: "Emergency",
        osmKey: "emergency",
        color: "#FF3B3B",
        fill: "rgba(255, 60, 60, 0.06)",
        spacing: 140,
        // Only allowed where the blocks are dense (see
        // buildDensityField() in facilities.js).
        denseOnly: true,
        groups: [
            "Medical rescue",
            "Firefighters",
            "Lifeguards",
            "Assembly point",
            "Other structure"
        ],
        points: [],
        metric: null,
        stepScale: 1,
        drowned: 0,
        visible: true,
        showCells: true,
        showDelaunay: false
    },
    {
        key: "amenity",
        label: "Amenity",
        osmKey: "amenity",
        color: "#FFC93C",
        fill: "rgba(255, 201, 60, 0.06)",
        spacing: 90,
        denseOnly: true,
        groups: [
            "Sustenance",
            "Education",
            "Transportation",
            "Financial",
            "Healthcare",
            "Entertainment, Arts & Culture",
            "Public Service",
            "Facilities",
            "Waste Management"
        ],
        points: [],
        metric: null,
        stepScale: 1,
        drowned: 0,
        visible: true,
        showCells: true,
        showDelaunay: false
    },
    {
        key: "shop",
        label: "Shop",
        osmKey: "shop",
        color: "#B36BFF",
        fill: "rgba(179, 107, 255, 0.06)",
        spacing: 55,
        denseOnly: false,
        groups: [
            "Food, beverages",
            "General store, department store, mall",
            "Clothing, shoes, accessories",
            "Discount store, charity",
            "Health and beauty",
            "Do-it-yourself, household, building materials, gardening",
            "Furniture and interior",
            "Electronics",
            "Outdoors and sport, vehicles",
            "Art, music, hobbies",
            "Stationery, gifts, books, newspapers",
            "Others"
        ],
        points: [],
        metric: null,
        stepScale: 1,
        drowned: 0,
        visible: true,
        showCells: true,
        showDelaunay: false
    }
];


function layerByKey(key) {
    return FACILITY_LAYERS.find(l => l.key === key);
}

let optimizing = false;

// Latest evaluated metric, kept so the UI and the optimizer
// can both read it without recomputing.
let currentMetric = null;

// Adaptive move size is tracked per layer (layer.stepScale).
