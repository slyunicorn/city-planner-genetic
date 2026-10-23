// js/log.js
// Log panel (right-hand side) - logStep().
// Plain script: shares the global scope with the other js/ files,
// so load order in index.html matters.

// ============================================================
// LOG PANEL
// ============================================================

function logStep(message) {

    const time =
        new Date().toLocaleTimeString(
            [],
            {
                hour: "2-digit",
                minute: "2-digit",
                second: "2-digit"
            }
        );

    const entry =
        document.createElement("div");

    entry.className = "log-entry";

    const timeSpan =
        document.createElement("span");

    timeSpan.className = "log-time";
    timeSpan.textContent = time;

    entry.appendChild(timeSpan);
    entry.appendChild(
        document.createTextNode(message)
    );

    logList.appendChild(entry);

    logList.scrollTop =
        logList.scrollHeight;
}


// Copy the whole log as plain text.
document.getElementById("copyLogBtn").addEventListener("click", async () => {

    const text =
        Array.from(logList.querySelectorAll(".log-entry"))
            .map(e => e.textContent)
            .join("\n");

    const btn = document.getElementById("copyLogBtn");

    try {

        await navigator.clipboard.writeText(text);

    } catch (err) {

        // Clipboard API can be unavailable (e.g. opened from file://).
        const ta = document.createElement("textarea");
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        ta.remove();
    }

    btn.textContent = "Copied";
    setTimeout(() => { btn.textContent = "Copy all"; }, 1200);
});
