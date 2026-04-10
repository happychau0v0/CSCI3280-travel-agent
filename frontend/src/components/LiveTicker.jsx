import { useEffect, useState } from "react";

/**
 * Friendly labels for each tool name. Used by LiveTicker to narrate
 * progress in plain English while the agent is working.
 */
const TOOL_LABELS = {
  search_places: "Searching places",
  get_place_details: "Looking up details",
  get_directions: "Routing transit",
  get_weather: "Checking weather",
  geocode_city: "Locating destination",
  search_flights: "Searching flights",
  web_search: "Searching the web",
};

/**
 * Top-left LIVE chip — mirrors the "LIVE / Today's order highlights"
 * element from the Shopify Liveview reference. Shows the user's city,
 * a pulsing red dot, and a live narration of which tool the agent is
 * calling right now (driven by SSE events from /chat/stream).
 *
 * Props:
 *   userLocation: {city, country, lat, lng} | null
 *   isLoading:    bool — agent currently working?
 *   lastAction:   string — fallback status text between tool calls
 *   currentTool:  string | null — tool currently executing
 */
export default function LiveTicker({
  userLocation,
  isLoading,
  lastAction,
  currentTool,
}) {
  // Animate trailing dots when working but no specific tool is running
  // (i.e. the model is thinking between tool calls).
  const [thinkingDots, setThinkingDots] = useState(".");
  useEffect(() => {
    if (!isLoading) return;
    const id = setInterval(() => {
      setThinkingDots((d) => (d.length >= 3 ? "." : d + "."));
    }, 400);
    return () => clearInterval(id);
  }, [isLoading]);

  let status;
  if (currentTool) {
    status = `${TOOL_LABELS[currentTool] || currentTool}${thinkingDots}`;
  } else if (isLoading) {
    status = `Thinking${thinkingDots}`;
  } else {
    status = lastAction || "Ready";
  }

  return (
    <div className="live-ticker">
      <div className="live-row">
        <span className="live-dot" />
        <span className="live-label">LIVE</span>
        {userLocation?.city && (
          <span className="live-city">— {userLocation.city}</span>
        )}
      </div>
      <div className={`live-status${isLoading ? " working" : ""}`}>{status}</div>
    </div>
  );
}
