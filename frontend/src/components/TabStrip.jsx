import { PANELS } from "../hooks/useMenuState";

const TAB_LABELS = {
  HOME: "PLAN",
  FLIGHTS: "FLIGHTS",
  HOTELS: "HOTELS",
  DAYS: "DAYS",
};

const TOOL_LABELS = {
  _thinking: "THINKING",
  search_flights: "FLIGHTS",
  search_places: "PLACES",
  get_place_details: "DETAILS",
  get_directions: "ROUTING",
  get_weather: "WEATHER",
  geocode_city: "GEOCODE",
  get_day_windows: "WINDOWS",
  get_phrasebook: "PHRASES",
};

function compactTool(tool) {
  if (!tool) return null;
  return TOOL_LABELS[tool] || tool.replace(/_/g, " ").toUpperCase().slice(0, 16);
}

/**
 * Top-of-screen NieR-style tab strip. Shows the panel tabs on the left;
 * a compact agent-working indicator fills the empty right-side space.
 */
export default function TabStrip({ activePanel, scope, onTabClick, agentState = "idle", currentTool = null }) {
  const toolLabel = compactTool(currentTool);
  return (
    <nav className="tab-strip" aria-label="Menu sections">
      {PANELS.map((panel, i) => {
        const isActive = panel === activePanel;
        const inFocus = isActive && scope === "tabs";
        return (
          <button
            key={panel}
            type="button"
            className={`tab${isActive ? " active" : ""}${inFocus ? " focused" : ""}`}
            onClick={() => onTabClick?.(panel)}
            aria-current={isActive ? "page" : undefined}
          >
            <span className="tab-bracket">◢</span>
            <span className="tab-num">{i + 1}</span>
            <span className="tab-label">{TAB_LABELS[panel]}</span>
          </button>
        );
      })}

      {agentState === "working" && (
        <div className="tab-strip-working" aria-live="polite">
          <span className="tab-strip-working-icon">◢</span>
          <span className="tab-strip-working-label">
            WORKING{toolLabel ? ` · ${toolLabel}` : ""}
          </span>
          <span className="tab-strip-working-bar" />
        </div>
      )}
    </nav>
  );
}
