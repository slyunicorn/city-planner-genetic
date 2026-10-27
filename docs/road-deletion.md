# How roads get deleted

Roads are removed in two separate stages:

1. **Build-time cleanup** (`buildRoadNetwork()`, `js/roads-network.js`). This runs every time the network is rebuilt (after closing the city, relaxing, or changing a Roads setting). It is deterministic: the same city always gives the same result.
2. **Probabilistic simplification** (the *Simplify Network* button). It is random on purpose, so two runs give different cities, and the best of several runs is kept. The files involved:
   * `js/roads-quality.js`: quality model and hard rules
   * `js/roads-simplify.js`: graph and sigmoid
   * `js/roads-junctions.js`: per-node removal and junction selection
   * `js/roads-stepwise.js`: passes and the greedy finish
   * `js/roads-animated.js`: attempts, champion, repair and final check

The full pipeline:

| Step | What | Where |
|---|---|---|
| A | Candidate network: Urquhart graph on Voronoi cell corners | `urquhart.js`, `buildRoadNetwork()` |
| B | Hard constraints: remove roads over unbuildable ground or outside the city | `removeUnbuildableCrossings()` |
| C | Required access links: facility spurs | `buildRoadNetwork()` |
| D | Baseline metrics: NC, RS and BB at the start | `createQualityState()` |
| E | Probabilistic pruning by ΔQ | `selectAndRemoveRoad()`, `createSimplifyRunner()` |
| F | Repair required access, if anything lost it | `repairRequiredAccess()` |
| G | Straighten and classify roads | `straightenRoadChains()`, `classifyRoads()`, main-road straightening |
| H | Validate and rescore: undo moves that broke a road, then score before/after | `validateStraightenedNetwork()`, `scoreNetwork()` |

Hard rules are never traded against the score. A high Q can never justify disconnecting the network, cutting off a facility or leaving a block without a road.

---

## Stage 1: build-time cleanup

The starting network is the Urquhart graph built on the Voronoi cell corners: take the Delaunay triangulation of the corners and drop the longest edge of every triangle. Optionally, *Extra edges* puts back some of the shortest dropped edges.

### 1a. Roads over unbuildable ground or outside the city (`removeUnbuildableCrossings()`)

Every road node is on buildable land inside the city, but the straight road between two nodes can still cross a river, a forest or a cliff. In a concave city it can also cut across a notch outside the boundary.

* **Unbuildable ground.** The road is sampled every 0.75 px (`CROSSING_STEP`) against `isLand()`.
* **Outside the city.** The road is sampled every 2 px against the city curve (`roadLeavesCity()`). A sample counts as outside only if it is more than 0.5 px out, because roads along the boundary sit exactly on it.

| Case | What happens |
|---|---|
| Crosses unbuildable ground, and its "chance" value is below `BRIDGE_KEEP_CHANCE` (0.2) | **kept** (about 1 in 5) |
| Removing it would disconnect its two ends | **kept** |
| Otherwise (including every road that leaves the city) | **removed** |

The "chance" is a hash of the road's two endpoints (`roadHash01()`), not `Math.random()`. That way the same road gets the same answer on every rebuild, and bridges don't flicker during relaxation or zoom.

Kept crossings are labelled afterwards:
* over any open water (`isWaterAt()`): a **bridge**, drawn hot pink;
* over other unbuildable ground only: an **off-land road**, drawn dashed orange.

### 1b. Dead ends (`pruneDeadEnds()`, only if *Prune cul-de-sacs* is on)

Nodes with exactly one road are removed, repeatedly, so whole dangling chains unwind.

### 1c. Facility spurs

Each facility is linked to its nearest road node(s) (*Links per facility*, default 1). Targets whose spur stays on dry ground are preferred.

---

## Stage 2: probabilistic simplification

### The idea in one paragraph

Visit the busiest nodes one by one. At each node, look at its roads in random order and ask two questions:
1. Is it *allowed* to remove this road (the hard rules)? If not, skip it.
2. How much would the network's quality Q change without it (ΔQ)?

ΔQ becomes a probability through a sigmoid; roll a die and maybe remove the road. Stop once the requested share of road length is gone. Repeat several times from the same starting network and keep the attempt with the best structure.

### Hard rules (`qualityCanRemove()`)

A road may be removed when either:

1. **It is not a bridge**, in the graph-theory sense: an edge whose removal splits the graph. Removing it keeps the network in one piece. Bridges are found with Tarjan's algorithm (`findGraphBridges()`), recomputed after every removal, so this check is a lookup.
2. **Or it is a dead end whose tip is not needed.** The tip (the degree-1 end) must not be a facility or an OD source (see RS below). Every buildable block that the tip is a corner of must still have another corner with a road.

The second case is new. Previously every node had to keep at least one road, so a dead end could never be removed. Now an unnecessary cul-de-sac can go, but never one that is a block's only road access or a facility's spur. A node left with no road is dropped from the counts and from the drawing.

Rejections are counted in `removalRejections`:
* `disconnect`: a bridge that isn't a dead end
* `required`: a facility or OD tip
* `access`: a block's last road
* `accepted`

### Quality Q (`scoreQuality()`, `js/roads-quality.js`)

Each raw metric becomes a score from 0 to 1, where 1 is desirable. The scores are averaged into three groups, and the groups into Q:

```
structural = wNC·S_NC + wRS·S_RS + wBB·S_BB        (weights rescaled to sum to 1)
Q          = structural − λ · cost                 cost = road length ÷ original length
```

The group weights (default 30 / 40 / 30) and λ (default 1.0) are sliders on the Roads tab.

The score shapes used below:

| Shape | Formula |
|---|---|
| *target* | `exp(−|x − x*| / σ)` |
| *lower* | `1 − clip((x − best) / span)` |
| *range* | 1 inside [lo, hi]; `x/lo` below; `hi/x` above |

#### NC: Nodal connections (intersections)

"Intersection" means a road node of degree ≥ 3, and "nodes" here means intersections plus dead ends. Degree-2 nodes are just bends along a road, and facility nodes don't count.

| Metric | Raw value | Score | Weight in NC |
|---|---|---|---|
| NC1 junction spacing | intersections ÷ road length | *target*: one intersection per 1.5 R of road (R = Poisson radius), σ = 50% | 0.25 |
| NC2 mean degree | mean degree of the nodes | *target* 3.0, σ 0.5 | 0.25 |
| NC3 intersection angles | at each intersection, each road's angle to its nearest neighbouring road, scored `1 − |θ − 90°| / 90°` | the mean (a T-junction scores 1) | 0.2 |
| NC4 dead ends | dead ends ÷ nodes | *lower*, 0 at 15% | 0.2 |
| side diversity | the old measure: 1 − length of the average unit vector of a node's roads | the mean over nodes with ≥ 2 roads | 0.1 |

NC5 (dead-end clustering) is not implemented.

#### RS: Road segments (routes)

A fixed origin–destination (OD) sample is chosen once per run: 16 intersections spread over the city (farthest-point sampling) plus up to 8 facilities. Every node with a road is a destination.

| Metric | Raw value | Score | Weight in RS |
|---|---|---|---|
| RS1 Shimbel distance | mean shortest-path distance over the OD pairs | *lower*, relative to the start: 1 at the start, 0 at 50% longer | 0.15 |
| RS2 circuity | Σ network distance ÷ Σ straight-line distance over the OD pairs | *lower*, 1 at 1.0, 0 at 1.8 | 0.3 |
| RS3 alpha | `(E − V + 1) / (2V − 5)` (share of possible loops) | *range* [0.20, 0.45] | 0.3 |
| RS4 tortuosity | Σ chain length ÷ Σ straight distance between chain ends (a chain runs between nodes whose road degree isn't 2) | *lower*, 0 at 1.5 | 0.25 |

Beta and gamma are still reported but not scored, because they measure nearly the same thing as alpha. Shimbel distance and circuity are also correlated, which is why they share weight rather than each getting a full share. RS5–RS8 are not implemented: hierarchy, time budget and service-area coverage need demand and speed assumptions. Self-loops can't occur in this graph.

#### BB: Barrier blocks (the land the roads enclose)

The road graph (facility spurs left out) is planar, so its faces are found with a half-edge walk (`buildQualityFaces()`). The largest face is the outside, and the others are blocks. Removing a road merges the blocks on its two sides; a dead end has the same block on both sides, so nothing changes. If the merged face is the outside, the block is lost (opened to the outside).

| Metric | Raw value | Score | Weight in BB |
|---|---|---|---|
| BB1 block area | each block's area ÷ the median starting block | *range* [0.4, 3.0], area-weighted, divided by the starting total enclosed area (so a block opened to the outside costs its whole area) | 0.5 |
| BB2 intersections per block | intersections ÷ blocks | *range* [1.5, 2.5] | 0.2 |
| compactness | `4πA / P²` (P = perimeter, not counting dangling stubs inside) | *range* [0.45, 1], area-weighted | 0.3 |

#### TF and D (traffic flow and directional patterns)

TF and D are not part of Q. Travel time, velocity ratio, flow/capacity, directional imbalance and route entropy all need a traffic-demand model (who travels where, and road capacities), and the app has none. Adding them with made-up demand would only add noise to the decision.

### How ΔQ is computed fast (`qualityEvaluateRemoval()`)

Q is asked "what would you be without this road?" thousands of times per attempt, so a state object keeps running sums. A removal updates only what it touches:

* the two end nodes' NC terms;
* the road chains through those two nodes (RS4);
* the two faces on either side (BB);
* only the shortest-path trees that used this road (each source keeps a bitmask per edge). Only the subtree that hung below the road is recomputed (`repairShortestPaths()`).

The incremental result was checked against a full recompute after 220 random removals: every metric agreed to about 1e-13. One evaluation takes about 0.4 ms on a ~1,000-road network.

### From ΔQ to a probability

```
ΔQ = Q_without − Q_with
P  = 1 / (1 + e^(−k · ΔQ))
k  = Removal sharpness ÷ typical |ΔQ|
```

k is **calibrated each run**. About 150 allowed removals are sampled on the starting network, and "typical |ΔQ|" is their median, ignoring removals that change nothing. A fixed k (the old 300) stops fitting as soon as the weights change. With sharpness 2 (the default), a typical improving removal has P ≈ 0.88 and a typical harmful one P ≈ 0.12.

Measured on a concave city with 4 attempts per setting (structural score of the result):

| Sharpness | Structural score |
|---|---|
| 0.2 (almost random) | 0.34–0.39 |
| 1 | 0.61–0.65 |
| 3 | about 0.70 |

### The sweep (`createSimplifyRunner()`)

* **Order of a pass:** nodes with degree ≥ 2, shuffled, then sorted by degree (highest first).
* **At each node** (`selectAndRemoveRoad()`): its roads are tried in random order, and at most one is removed per visit.
* **Junction mode** (*Prune at junctions only*): only the selected junctions are visited.
* **Stopping:**
  * The road budget is the stopping rule: stop once `cost ≤ 1 − Road budget cut`.
  * **Greedy finish:** late in a run every allowed removal can hurt Q, and a whole pass may remove nothing. From the first empty pass (or after 40 passes), each step removes the allowed road with the highest ΔQ, which is the least harmful one, until the budget is met or nothing may go.

### Several attempts, compared at the same budget

* *Attempts* (default 6) independent runs. All start from the same network and use the same quality context (same OD sample, blocks and references), so their scores are comparable.
* The champion is chosen by **meeting the budget first, then structural quality** (Q without the cost term). With the cost term included, an attempt that happened to overshoot the budget by one road would win just for being shorter.

### Repair (step F, `repairRequiredAccess()`)

The champion is checked: every facility, and every buildable block that had road access at the start, must be reachable from the main network. If one isn't, the cheapest way back is put back: a Dijkstra where kept roads cost 0 and removed roads cost their length. With the hard rules above this should never trigger, and the log says so ("all reachable, nothing to repair").

---

## After deletion

1. **Chain straightening:** degree-2 nodes slide towards their neighbours' midpoint.
2. **Main and smaller roads (automatic):** every pair of buildings (one per buildable block) gets a trip along its quickest route, and each road's traffic is the share of all trips that use it. Roads are traced into corridors that follow the busiest way through junctions (turns up to 60°). A corridor, with its quiet ends trimmed off (below the city's average traffic per metre), is a main road when it is at least 5 blocks long and busier than average per metre, i.e. its share of all travel is larger than its share of road length. Main roads are then treated as twice as fast, trips move onto them, and the choice is redone until it stops changing (usually 3–7 rounds). The main road share is the result, not a setting: 15–22% of road length on the test cities, carrying 54–63% of the travel.
3. **Main-road straightening:** gentle turns are flattened; sharp turns are left as corners.
4. **Validate and rescore (step H, `validateStraightenedNetwork()`):**
   * Each straightening move only checked that the point itself lands on buildable land.
   * Every road is compared with its position before straightening. A road that now crosses unbuildable ground, leaves the city or crosses another road has its moved ends put back; this repeats until nothing new is broken.
   * Then the network is scored before and after straightening, with the run's references (`scoreNetwork()`). The log shows both (straightening usually raises RS through tortuosity).
   * Buildings are placed last and shrink to clear roads, so a building is never crossed.

---

## Seeing the metrics

*Open metrics page* (Roads tab, under Simplify Network) opens `metrics.html` in its own tab. While Simplify runs it fills in live, one point per removed road. The finished run is saved, so the page also works after a reload. It shows:

* **Headline tiles:** structure, NC, RS, BB and Q, with the change since the start.
* **Group scores over one attempt:** pick the attempt; the x axis is the % of road length removed or the removal number; the slider (or a click on a chart) pins one removal.
* **All 12 metrics as small charts:** score over the removals, plus the raw value at the pinned removal.
* **ΔQ of every removal:** random picks and greedy picks.
* **All attempts compared:** a chart plus a table with the winner marked.
* **Metric table:** raw value and score at the start, at the pinned removal, at the attempt's end and for the final straightened network.
* **Rules and checks:** how k was calibrated, rejections per hard rule, the access check and the straightening check.

## Settings

| Control | Default | Effect |
|---|---|---|
| Extra edges | 0% | More starting roads |
| Prune cul-de-sacs | off | Stage 1b |
| Links per facility | 1 | Facility spurs; a facility's last spur can never be removed |
| Road budget cut | 25% | Total length removed (the stopping rule) |
| Quality weights NC / RS / BB | 30 / 40 / 30 | What "good" means; rescaled to sum to 100% |
| Cost weight λ | 1.0 | How much shorter roads count; higher favours removing long roads |
| Removal sharpness | 2.0 | k = this ÷ typical \|ΔQ\| (low = random, high = greedy) |
| Attempts | 6 | Independent runs; the best is kept |
| Speed | Max | Steps per frame (animation only); Max = as many as fit in 50 ms per frame |
| Prune at junctions only | off | Visit only the selected junctions |
| Junction radius | 40 px | Density radius for junction selection |

Metric targets and ranges are constants at the top of `js/roads-quality.js`:
* `NC_JUNCTION_SPACING_R`, `NC_TARGET_DEGREE`, `NC_DEAD_END_LIMIT`
* `RS_CIRCUITY_LIMIT`, `RS_TORTUOSITY_SPAN`
* `BB_AREA_RANGE`, `BB_COMPACTNESS_MIN`, `BB_NODES_PER_BLOCK_RANGE`
* the per-group weights

They were set from one test area (around 750 nodes, R = 18 px, about 12 m per pixel) and are worth re-checking on other cities.
