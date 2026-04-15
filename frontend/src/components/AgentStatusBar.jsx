import { useEffect, useState } from "react";

/**
 * Prominent banner pinned below the tab strip that shows agent state
 * during long-running chat requests. The user's #1 round-7 complaint
 * was "feels unresponsive — no idea what the agent is doing after
 * pressing send", so this is the most important UI of round 8.
 *
 * States:
 *   idle    — hidden
 *   working — cyan glow, big "AGENT WORKING" heading, current tool
 *             label, animated progress sweep, live elapsed seconds
 *   done    — brief 1-second "✓ READY" flash before collapsing
 *   error   — red banner with error message, dismissible
 */

// P50 estimates per role for non-reasoning model. Used for ETA display only.
const ROLE_ETA_MS = {
  plan:   12_000,
  hotels: 16_000,
  days:   18_000,
  chat:    4_000,
};

const TOOL_LABELS = {
  _thinking: "LLM thinking…",
  search_flights: "Searching flights",
  search_places: "Looking up places",
  get_place_details: "Fetching place details",
  get_directions: "Routing directions",
  get_weather: "Checking weather",
  geocode_city: "Geocoding city",
  navigate_menu: "Navigating menu",
  request_input: "Awaiting your input",
  get_day_windows: "Calculating day windows",
  get_phrasebook: "Building phrasebook",
  toggle_setting: "Applying setting",
  submit_trip_form: "Submitting form",
  web_search: "Searching the web",
};

function friendlyTool(tool) {
  if (!tool) return null;
  return TOOL_LABELS[tool] || tool.replace(/_/g, " ");
}

function formatMs(ms) {
  if (ms == null) return "";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export default function AgentStatusBar({
  state = "idle",
  currentTool = null,
  startedAt = null,
  errorMessage = null,
  onDismissError,
  toolTimings = [],
  callRole = null,
  isReasoningModel = false,
}) {
  const [elapsed, setElapsed] = useState(0);

  // Tick the elapsed counter while working
  useEffect(() => {
    if (state !== "working" || !startedAt) {
      setElapsed(0);
      return undefined;
    }
    const tick = () => setElapsed(Math.floor((Date.now() - startedAt) / 1000));
    tick();
    const id = setInterval(tick, 250);
    return () => clearInterval(id);
  }, [state, startedAt]);

  if (state === "idle") return null;

  if (state === "error") {
    return (
      <div className="agent-status-bar status-error" role="alert">
        <span className="status-icon">✗</span>
        <div className="status-content">
          <div className="status-heading">AGENT ERROR</div>
          <div className="status-detail">{errorMessage || "Request failed"}</div>
        </div>
        <button
          type="button"
          className="status-dismiss"
          onClick={onDismissError}
          aria-label="Dismiss error"
        >
          ✕
        </button>
      </div>
    );
  }

  if (state === "done") {
    // Aggregate parallel tool calls by name (take max if called twice)
    const timingMap = {};
    for (const { name, elapsed_ms } of toolTimings) {
      if (elapsed_ms == null) continue;
      timingMap[name] = Math.max(timingMap[name] ?? 0, elapsed_ms);
    }
    const sorted = Object.entries(timingMap).sort((a, b) => b[1] - a[1]);
    const totalMs = toolTimings.reduce((s, t) => s + (t.elapsed_ms ?? 0), 0);

    return (
      <div className="agent-status-bar status-done" role="status">
        <span className="status-icon">✓</span>
        <div className="status-content">
          <div className="status-heading">
            READY
            {sorted.length > 0 && (
              <span className="status-tool"> · {sorted.length} tool{sorted.length > 1 ? "s" : ""} · {formatMs(totalMs)}</span>
            )}
          </div>
          {sorted.length > 0 && (
            <div className="status-timings">
              {sorted.map(([name, ms]) => (
                <span key={name} className={`status-timing-chip${ms > 10000 ? " timing-slow" : ms > 3000 ? " timing-warn" : ""}`}>
                  {friendlyTool(name)} {formatMs(ms)}
                </span>
              ))}
            </div>
          )}
        </div>
      </div>
    );
  }

  // working — show current tool with a live per-tool timer
  return (
    <div className="agent-status-bar status-working" role="status">
      <span className="status-icon">◢</span>
      <div className="status-content">
        <div className="status-heading">
          AGENT WORKING
          {currentTool && (
            <span className="status-tool"> · {friendlyTool(currentTool)}</span>
          )}
        </div>
        {currentTool === "_thinking" && !isReasoningModel && callRole && ROLE_ETA_MS[callRole] ? (
          (() => {
            const etaMs = ROLE_ETA_MS[callRole];
            const elapsedMs = elapsed * 1000;
            const progressPct = Math.min(98, (elapsedMs / etaMs) * 100);
            const etaSec = Math.max(0, Math.ceil((etaMs - elapsedMs) / 1000));
            return (
              <div className="status-progress-eta-row">
                <div className="status-progress">
                  <div className="status-progress-fill" style={{ width: `${progressPct}%` }} />
                </div>
                <span className="status-eta">~{etaSec}s</span>
              </div>
            );
          })()
        ) : (
          <div className="status-progress">
            <div className="status-progress-sweep" />
          </div>
        )}
        {toolTimings.length > 0 && (
          <div className="status-timings">
            {toolTimings.slice(-4).map(({ name, elapsed_ms }, i) => (
              <span key={i} className={`status-timing-chip${elapsed_ms > 10000 ? " timing-slow" : elapsed_ms > 3000 ? " timing-warn" : ""}`}>
                {friendlyTool(name)} {elapsed_ms != null ? formatMs(elapsed_ms) : "…"}
              </span>
            ))}
          </div>
        )}
      </div>
      <div className="status-elapsed">{elapsed}s</div>
    </div>
  );
}
