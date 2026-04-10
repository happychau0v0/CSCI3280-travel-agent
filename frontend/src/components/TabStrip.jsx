import { PANELS } from "../hooks/useMenuState";

const TAB_LABELS = {
  HOME: "HOME",
  FLIGHTS: "FLIGHTS",
  HOTELS: "HOTELS",
  DAYS: "DAYS",
};

/**
 * Top-of-screen NieR-style tab strip. Shows the seven panel tabs with
 * the active one highlighted. Each tab has a small numeric badge for
 * the corresponding hotkey (1-7).
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
