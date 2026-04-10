/**
 * Bottom-of-screen NieR-style hint strip showing context-relevant
 * hotkeys. The hint set depends on which panel is active and whether
 * an overlay is open.
 *
 * The leading FOCUS: TABS / FOCUS: LIST badge tells the user whether
 * arrow keys cycle tabs or are absorbed by the panel list. It only
 * appears on main menu contexts (not while an overlay owns the
 * keyboard).
 */

const HINT_SETS = {
  HOME: [
    { key: "1-4", label: "Tab" },
    { key: "← →", label: "Switch" },
    { key: "↑ ↓", label: "Field" },
    { key: "Tab", label: "Focus" },
    { key: "Space", label: "Edit" },
    { key: "Enter", label: "Submit" },
    { key: "T", label: "Speak" },
    { key: "H", label: "History" },
    { key: "S", label: "Settings" },
    { key: "M", label: "Mute" },
  ],
  FLIGHTS: [
    { key: "1-4", label: "Tab" },
    { key: "← →", label: "Switch" },
    { key: "↑ ↓", label: "Item" },
    { key: "Tab", label: "Focus" },
    { key: "Space", label: "Pick" },
    { key: "T", label: "Speak" },
    { key: "H", label: "History" },
    { key: "S", label: "Settings" },
    { key: "Esc", label: "Back" },
  ],
  HOTELS: [
    { key: "1-4", label: "Tab" },
    { key: "← →", label: "Switch" },
    { key: "↑ ↓", label: "Item" },
    { key: "Tab", label: "Focus" },
    { key: "Space", label: "Pick" },
    { key: "T", label: "Speak" },
    { key: "H", label: "History" },
    { key: "S", label: "Settings" },
    { key: "Esc", label: "Back" },
  ],
  DAYS: [
    { key: "1-4", label: "Tab" },
    { key: "← →", label: "Switch" },
    { key: "↑ ↓", label: "Day" },
    { key: "Tab", label: "Focus" },
    { key: "T", label: "Speak" },
    { key: "H", label: "History" },
    { key: "S", label: "Settings" },
    { key: "Esc", label: "Back" },
  ],
  HISTORY_OVERLAY: [
    { key: "↑ ↓", label: "Turn" },
    { key: "PgUp PgDn", label: "Scroll" },
    { key: "E", label: "Edit" },
    { key: "Esc", label: "Close" },
  ],
  SETTINGS_OVERLAY: [
    { key: "↑ ↓", label: "Row" },
    { key: "Space", label: "Activate" },
    { key: "Esc", label: "Close" },
  ],
};

export default function FooterHints({
  muted = false,
  scope = "tabs",
  panel = "HOME",
  overlay = null, // null | "history" | "settings"
}) {
  let hints;
  let showScopeBadge = true;

  if (overlay === "history") {
    hints = HINT_SETS.HISTORY_OVERLAY;
    showScopeBadge = false;
  } else if (overlay === "settings") {
    hints = HINT_SETS.SETTINGS_OVERLAY;
    showScopeBadge = false;
  } else {
    hints = HINT_SETS[panel] || HINT_SETS.HOME;
  }

  const scopeLabel = scope === "list" ? "LIST" : "TABS";

  return (
    <div className="footer-hints" aria-label="Keyboard hints">
      {showScopeBadge && (
        <span className={`hint hint-scope hint-scope-${scope}`}>
          <span className="hint-label">FOCUS</span>
          <kbd className="hint-key">{scopeLabel}</kbd>
        </span>
      )}
      {hints.map((h) => (
        <span key={`${h.key}-${h.label}`} className="hint">
          <kbd className="hint-key">{h.key}</kbd>
          <span className="hint-label">{h.label}</span>
        </span>
      ))}
      {muted && <span className="hint hint-muted">🔇 MUTED</span>}
    </div>
  );
}
