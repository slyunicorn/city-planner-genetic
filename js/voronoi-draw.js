// js/voronoi-draw.js
// Block Voronoi drawing.
// Plain script: shares the global scope with the other js/ files,
// so load order in index.html matters.

// ============================================================
// DRAW VORONOI
// ============================================================

function drawVoronoi() {

    voronoiLayer.selectAll("*").remove();


    if (!voronoiToggle.checked) {
        return;
    }


    // --------------------------------------------------------
    // Once the city is closed, the Voronoi diagram is built
    // only from points inside the boundary, so points outside
    // the city no longer influence the cells.
    // --------------------------------------------------------

    const activePoints =
        getInsideCityPoints();


    if (activePoints.length < 2) {
        return;
    }


    const delaunay =
        d3.Delaunay.from(
            activePoints,
            d => d.x,
            d => d.y
        );


    const voronoi =
        delaunay.voronoi(
            getVoronoiExtent()
        );


    const group =
        voronoiLayer
            .append("g");


    if (cityClosed) {

        group.attr(
            "clip-path",
            "url(#cityClip)"
        );
    }


    for (
        let i = 0;
        i < activePoints.length;
        i++
    ) {

        const cell =
            voronoi.cellPolygon(i);


        if (!cell) {
            continue;
        }


        group
            .append("path")
            .attr(
                "class",
                "voronoi-cell"
            )
            .attr(
                "d",
                "M" +
                cell
                    .map(
                        p =>
                            `${p[0]},${p[1]}`
                    )
                    .join("L") +
                "Z"
            );
    }
}
