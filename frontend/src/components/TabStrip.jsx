import { PANELS } from "../hooks/useMenuState";

const TAB_LABELS = {
  HOME: "PLAN",
  FLIGHTS: "FLIGHTS",
  HOTELS: "HOTELS",
  DAYS: "DAYS",
};

/**
 * Top-of-screen NieR-style tab strip. Shows the panel tabs on the left.
 * Agent status is shown separately in the AgentStatusBar (top-right corner).
 */
export default function TabStrip({ activePanel, scope, onTabClick }) {
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
    </nav>
  );
}
