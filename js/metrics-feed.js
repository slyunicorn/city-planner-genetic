// js/metrics-feed.js
// Sends road-pruning metrics to the metrics page (metrics.html).
// Plain script: shares the global scope with the other js/ files,
// so load order in index.html matters.

// ============================================================
// METRICS FEED
// ============================================================
//
// The metrics page is a separate tab on the same origin. Each
// Simplify run is sent to it over a BroadcastChannel while it
// runs - one point per removed road - and the finished run is
// also kept in localStorage, so a page opened later (or reloaded)
// still shows the last run. The page asks for the current run
// with a "hello" message when it opens.
//
// Message types (all { type, ... }):
//   run       the whole run so far (sent at start, end and on hello)
//   attempt   a new attempt began: { attempt, points }
//   points    new points for an attempt: { attempt, from, points }
//   attempt-end { attempt, summary }
//
// The page can also ask for a comparison with the area's real roads
// ("compare-request"); real-roads.js answers with compare-status
// messages and a compare-result (or compare-error).
// ============================================================

const METRICS_CHANNEL_NAME = "ai-city-road-metrics";
const METRICS_STORAGE_KEY = "aiCity.roadMetrics.lastRun";
const METRICS_COMPARE_KEY = "aiCity.roadMetrics.lastCompare";

const metricsFeed = (() => {

    let channel = null;

    try {
        channel = new BroadcastChannel(METRICS_CHANNEL_NAME);
    } catch (err) {
        channel = null;
    }

    let run = null;

    const post = message => {
        if (channel) {
            try {
                channel.postMessage(message);
            } catch (err) {
                // A closed channel or an uncloneable value: the page
                // just misses this update.
            }
        }
    };

    // Attempt objects hold `points` as the quality state's own
    // history array; `sent` counts what the page already has.
    const forPage = () => run && {
        ...run,
        attempts: run.attempts.map(a => ({
            attempt: a.attempt,
            points: a.points.slice(),
            summary: a.summary
        }))
    };

    if (channel) {
        channel.onmessage = event => {
            if (event.data && event.data.type === "hello" && run) {
                run.attempts.forEach(a => { a.sent = a.points.length; });
                post({ type: "run", run: forPage() });
            }
            if (event.data && event.data.type === "compare-request") {
                compareWithRealRoads();
            }
        };
    }

    return {

        send: post,

        startRun(info) {
            run = { ...info, status: "running", attempts: [] };
            post({ type: "run", run: forPage() });
        },

        beginAttempt(attempt, history) {

            if (!run) {
                return;
            }

            run.attempts.push({ attempt, points: history, sent: history.length, summary: null });
            post({ type: "attempt", attempt, points: history.slice() });
        },

        // Send what the attempt recorded since the last call.
        progress(attempt) {

            const a = run && run.attempts.find(x => x.attempt === attempt);

            if (!a || a.points.length <= a.sent) {
                return;
            }

            post({
                type: "points",
                attempt,
                from: a.sent,
                points: a.points.slice(a.sent)
            });

            a.sent = a.points.length;
        },

        endAttempt(attempt, summary) {

            const a = run && run.attempts.find(x => x.attempt === attempt);

            if (!a) {
                return;
            }

            this.progress(attempt);
            a.summary = summary;
            post({ type: "attempt-end", attempt, summary });
        },

        endRun(result) {

            if (!run) {
                return;
            }

            Object.assign(run, result, { status: result.status || "done" });

            const full = forPage();

            post({ type: "run", run: full });

            try {
                localStorage.setItem(METRICS_STORAGE_KEY, JSON.stringify(full));
            } catch (err) {
                // Storage full or blocked: the live page still has it.
            }
        }
    };
})();


function openMetricsPage() {
    window.open("metrics.html", "aiCityRoadMetrics");
}
