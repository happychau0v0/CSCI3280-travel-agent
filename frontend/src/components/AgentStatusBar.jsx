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

const TOOL_LABELS = {
  search_flights: "Searching flights",
  search_places: "Looking up places",
  get_place_details: "Fetching place details",
  get_directions: "Routing directions",
  get_weather: "Checking weather",
  geocode_city: "Geocoding city",
  navigate_menu: "Navigating menu",
  request_input: "Awaiting your input",
  web_search: "Searching the web",
};

function friendlyTool(tool) {
  if (!tool) return null;
  return TOOL_LABELS[tool] || tool.replace(/_/g, " ");
}

export default function AgentStatusBar({
  state = "idle",
  currentTool = null,
  startedAt = null,
  errorMessage = null,
  onDismissError,
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
    return (
      <div className="agent-status-bar status-done" role="status">
        <span className="status-icon">✓</span>
        <div className="status-content">
          <div className="status-heading">READY</div>
          <div className="status-detail">Trip ready · check the panels</div>
        </div>
      </div>
    );
  }

  // working
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
        <div className="status-progress">
          <div className="status-progress-sweep" />
        </div>
      </div>
      <div className="status-elapsed">{elapsed}s</div>
    </div>
  );
}
