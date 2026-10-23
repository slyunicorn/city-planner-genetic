// js/city-search.js
// City name search (Nominatim) and dropdown.
// Plain script: shares the global scope with the other js/ files,
// so load order in index.html matters.

// ============================================================
// CITY SEARCH (OpenStreetMap Nominatim geocoding)
// ============================================================
//
// A free-text search box above the lat/lon fields. Typing debounces
// into a Nominatim lookup; picking a result just fills latInput/
// lonInput (and a sensible radius guess for a city-sized place) -
// it does not load terrain on its own, so the person can still
// tweak radius/grid before pressing Load Terrain.
// ============================================================

const NOMINATIM_URL =
    "https://nominatim.openstreetmap.org/search";

let citySearchTimer = null;
let citySearchAbort = null;
let citySearchResultsData = [];
let citySearchActiveIndex = -1;

function hideCityDropdown() {

    citySearchResults.classList.add("hidden");
    citySearchResults.innerHTML = "";

    citySearchResultsData = [];
    citySearchActiveIndex = -1;
}

function renderCityStatus(message) {

    citySearchResults.innerHTML = "";
    citySearchResults.classList.remove("hidden");

    const row = document.createElement("div");
    row.className = "city-search-status";
    row.textContent = message;

    citySearchResults.appendChild(row);
}

function pickCityResult(index) {

    const result = citySearchResultsData[index];

    if (!result) {
        return;
    }

    latInput.value = Number(result.lat).toFixed(4);
    lonInput.value = Number(result.lon).toFixed(4);

    // A city-sized bounding box in the geocoder result implies a
    // sensible default radius; fall back to the current value for
    // a point-ish result (a single address, a POI).
    if (result.boundingbox) {

        const [south, north, west, east] =
            result.boundingbox.map(Number);

        const latSpanM = (north - south) * 110574;

        const lonSpanM =
            (east - west) * 111320 *
            Math.cos(Number(result.lat) * Math.PI / 180);

        const span = Math.max(latSpanM, lonSpanM);

        if (Number.isFinite(span) && span > 200) {
            distInput.value =
                Math.round(Math.min(20000, Math.max(300, span / 2)));
        }
    }

    citySearchInput.value = result.display_name;

    hideCityDropdown();

    logStep(
        `Selected "${result.display_name}" - press Load Terrain ` +
        `to fetch this area.`
    );
}

function renderCityResults(results) {

    citySearchResultsData = results;
    citySearchActiveIndex = -1;

    citySearchResults.innerHTML = "";
    citySearchResults.classList.remove("hidden");

    if (!results.length) {
        renderCityStatus("No matches.");
        return;
    }

    results.forEach((result, i) => {

        const parts = result.display_name.split(",");

        const name = parts[0]?.trim() || result.display_name;
        const detail = parts.slice(1).join(",").trim();

        const row = document.createElement("div");
        row.className = "city-option";
        row.dataset.index = i;

        row.innerHTML =
            `<span class="city-name"></span>` +
            (detail ? `<span class="city-detail"></span>` : "");

        row.querySelector(".city-name").textContent = name;

        if (detail) {
            row.querySelector(".city-detail").textContent = detail;
        }

        row.addEventListener("click", () => pickCityResult(i));

        citySearchResults.appendChild(row);
    });
}

async function runCitySearch(query) {

    if (citySearchAbort) {
        citySearchAbort.abort();
    }

    const controller = new AbortController();
    citySearchAbort = controller;

    renderCityStatus("Searching...");

    try {

        const url =
            `${NOMINATIM_URL}?format=jsonv2&addressdetails=0` +
            `&limit=6&q=${encodeURIComponent(query)}`;

        const res =
            await fetch(url, {
                signal: controller.signal,
                headers: { "Accept-Language": "en" }
            });

        if (!res.ok) {
            throw new Error(`Search failed (${res.status}).`);
        }

        const results = await res.json();

        renderCityResults(results);

    } catch (err) {

        if (err.name === "AbortError") {
            return;
        }

        renderCityStatus(`Search failed: ${err.message}`);

        console.error(err);
    }
}

citySearchInput.addEventListener("input", () => {

    const query = citySearchInput.value.trim();

    clearTimeout(citySearchTimer);

    if (query.length < 2) {
        hideCityDropdown();
        return;
    }

    citySearchTimer =
        setTimeout(() => runCitySearch(query), 400);
});

citySearchInput.addEventListener("keydown", event => {

    if (citySearchResults.classList.contains("hidden")) {
        return;
    }

    const options =
        citySearchResults.querySelectorAll(".city-option");

    if (event.key === "ArrowDown") {

        event.preventDefault();

        citySearchActiveIndex =
            Math.min(options.length - 1, citySearchActiveIndex + 1);

    } else if (event.key === "ArrowUp") {

        event.preventDefault();

        citySearchActiveIndex =
            Math.max(0, citySearchActiveIndex - 1);

    } else if (event.key === "Enter") {

        event.preventDefault();

        if (citySearchActiveIndex >= 0) {
            pickCityResult(citySearchActiveIndex);
        }

        return;

    } else if (event.key === "Escape") {

        hideCityDropdown();
        return;

    } else {

        return;
    }

    options.forEach((opt, i) =>
        opt.classList.toggle("active", i === citySearchActiveIndex)
    );
});

document.addEventListener("click", event => {

    if (
        event.target !== citySearchInput &&
        !citySearchResults.contains(event.target)
    ) {
        hideCityDropdown();
    }
});
