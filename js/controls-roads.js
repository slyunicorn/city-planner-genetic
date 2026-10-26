// js/controls-roads.js
// Roads tab controls.
// Plain script: shares the global scope with the other js/ files,
// so load order in index.html matters.

straightenSlider.addEventListener(
    "input",
    () => {

        straightenValue.textContent =
            straightenSlider.value;
    }
);


mainShareSlider.addEventListener(
    "input",
    () => {

        mainShareValue.textContent =
            mainShareSlider.value;
    }
);


mainTurnSlider.addEventListener(
    "input",
    () => {

        mainTurnValue.textContent =
            mainTurnSlider.value;
    }
);


attemptsSlider.addEventListener(
    "input",
    () => {

        attemptsValue.textContent =
            attemptsSlider.value;
    }
);


speedSlider.addEventListener(
    "input",
    () => {

        speedValue.textContent =
            speedSlider.value;
    }
);


junctionRadiusSlider.addEventListener(
    "input",
    () => {

        junctionRadiusValue.textContent =
            junctionRadiusSlider.value;
    }
);


junctionToggle.addEventListener(
    "change",
    () => {

        drawUrquhart();
    }
);


reductionSlider.addEventListener(
    "input",
    () => {

        reductionValue.textContent =
            `${reductionSlider.value}%`;
    }
);


simplifyKSlider.addEventListener(
    "input",
    () => {

        simplifyKValue.textContent =
            simplifyKSlider.value;
    }
);


simplifyBtn.addEventListener(
    "click",
    runRoadSimplification
);


extraEdgeSlider.addEventListener(
    "input",
    () => {

        invalidateRoadNetwork();

        extraEdgeValue.textContent =
            `${extraEdgeSlider.value}%`;

        drawUrquhart();
    }
);


pruneToggle.addEventListener(
    "change",
    () => {

        invalidateRoadNetwork();

        drawUrquhart();

        if (roadNetwork) {
            logStep(
                pruneToggle.checked
                    ? `Pruned ${roadNetwork.prunedNodes} cul-de-sac ` +
                      `nodes; α now ` +
                      `${roadNetwork.roadIndices.alpha.toFixed(3)}.`
                    : "Cul-de-sacs restored."
            );
        }
    }
);


facilityLinkSlider.addEventListener(
    "input",
    () => {

        invalidateRoadNetwork();

        facilityLinkValue.textContent =
            facilityLinkSlider.value;

        drawUrquhart();
    }
);
