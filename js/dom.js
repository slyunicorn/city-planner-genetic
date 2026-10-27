// js/dom.js
// DOM references: every element the app reads or writes.
// Plain script: shares the global scope with the other js/ files,
// so load order in index.html matters.

// ============================================================
// AI CITY PLANNER
// ============================================================

// ------------------------------------------------------------
// DOM
// ------------------------------------------------------------

const viewport = document.getElementById("viewport");
const world = document.getElementById("world");
const mapElement = document.getElementById("map");
const svg = d3.select("#viz");

const voronoiLayer = d3.select("#voronoiLayer");
const urquhartLayer = d3.select("#urquhartLayer");
const boundaryLayer = d3.select("#boundaryLayer");
const pointLayer = d3.select("#pointLayer");
const facilityVoronoiLayer = d3.select("#facilityVoronoiLayer");
const facilityPointLayer = d3.select("#facilityPointLayer");
const vertexLayer = d3.select("#vertexLayer");
const landCoverCellLayer = d3.select("#landCoverCellLayer");
const densityLayer = d3.select("#densityLayer");
const buildingLayer = d3.select("#buildingLayer");

const cityClipPath = d3.select("#cityClipPath");

const rSlider = document.getElementById("rSlider");
const kSlider = document.getElementById("kSlider");

const rValue = document.getElementById("rValue");
const kValue = document.getElementById("kValue");

const generateBtn = document.getElementById("generateBtn");
const closeBtn = document.getElementById("closeBtn");
const resetBtn = document.getElementById("resetBtn");

const relaxIterationsSlider = document.getElementById("relaxIterationsSlider");
const relaxIterationsValue = document.getElementById("relaxIterationsValue");
const relaxBtn = document.getElementById("relaxBtn");
const centreDensitySlider = document.getElementById("centreDensitySlider");
const centreDensityValue = document.getElementById("centreDensityValue");
const hotspotSlider = document.getElementById("hotspotSlider");
const hotspotValue = document.getElementById("hotspotValue");
const flatPullSlider = document.getElementById("flatPullSlider");
const flatPullValue = document.getElementById("flatPullValue");
const lowPullSlider = document.getElementById("lowPullSlider");
const lowPullValue = document.getElementById("lowPullValue");

const latInput = document.getElementById("latInput");
const lonInput = document.getElementById("lonInput");
const distInput = document.getElementById("distInput");
const sizeSelect = document.getElementById("sizeSelect");
const loadTerrainBtn = document.getElementById("loadTerrainBtn");
const scaleNote = document.getElementById("scaleNote");

const citySearchInput = document.getElementById("citySearchInput");
const citySearchResults = document.getElementById("citySearchResults");

const placeFacilitiesBtn = document.getElementById("placeFacilitiesBtn");

const epochsSlider = document.getElementById("epochsSlider");
const epochsValue = document.getElementById("epochsValue");
const optimizeBtn = document.getElementById("optimizeBtn");

const seaLevelInput = document.getElementById("seaLevelInput");
const sobelToggle = document.getElementById("sobelToggle");
const voronoiToggle = document.getElementById("voronoiToggle");
const urquhartToggle = document.getElementById("urquhartToggle");
const hidePointsToggle = document.getElementById("hidePointsToggle");
const buildingsToggle = document.getElementById("buildingsToggle");
const extraEdgeSlider = document.getElementById("extraEdgeSlider");
const extraEdgeValue = document.getElementById("extraEdgeValue");
const pruneToggle = document.getElementById("pruneToggle");
const facilityLinkSlider = document.getElementById("facilityLinkSlider");
const facilityLinkValue = document.getElementById("facilityLinkValue");
const roadStats = document.getElementById("roadStats");
const straightenSlider = document.getElementById("straightenSlider");
const straightenValue = document.getElementById("straightenValue");
const mainTurnSlider = document.getElementById("mainTurnSlider");
const mainTurnValue = document.getElementById("mainTurnValue");
const maxBuildingSlider = document.getElementById("maxBuildingSlider");
const maxBuildingValue = document.getElementById("maxBuildingValue");
const attemptsSlider = document.getElementById("attemptsSlider");
const attemptsValue = document.getElementById("attemptsValue");
const speedSlider = document.getElementById("speedSlider");
const speedValue = document.getElementById("speedValue");
const junctionToggle = document.getElementById("junctionToggle");
const junctionRadiusSlider = document.getElementById("junctionRadiusSlider");
const junctionRadiusValue = document.getElementById("junctionRadiusValue");
const reductionSlider = document.getElementById("reductionSlider");
const reductionValue = document.getElementById("reductionValue");
const simplifyKSlider = document.getElementById("simplifyKSlider");
const simplifyKValue = document.getElementById("simplifyKValue");
const weightNcSlider = document.getElementById("weightNcSlider");
const weightNcValue = document.getElementById("weightNcValue");
const weightRsSlider = document.getElementById("weightRsSlider");
const weightRsValue = document.getElementById("weightRsValue");
const weightBbSlider = document.getElementById("weightBbSlider");
const weightBbValue = document.getElementById("weightBbValue");
const costWeightSlider = document.getElementById("costWeightSlider");
const costWeightValue = document.getElementById("costWeightValue");
const simplifyBtn = document.getElementById("simplifyBtn");
const metricsPageBtn = document.getElementById("metricsPageBtn");

const maxSlopeInput = document.getElementById("maxSlopeInput");
const riverBufferInput = document.getElementById("riverBufferInput");
const loadLandCoverBtn = document.getElementById("loadLandCoverBtn");
const landCoverNote = document.getElementById("landCoverNote");
const landCoverToggle = document.getElementById("landCoverToggle");
const landCoverSourceSelect = document.getElementById("landCoverSourceSelect");
const landCoverAllToggle = document.getElementById("landCoverAllToggle");
const landCoverFileInput = document.getElementById("landCoverFileInput");
const landcoverCanvas = document.getElementById("landcoverCanvas");

const metricScore = document.getElementById("metricScore");
const metricDetail = document.getElementById("metricDetail");

const status = document.getElementById("status");

const logList = document.getElementById("logList");
