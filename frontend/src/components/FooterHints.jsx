/**
 * Bottom-of-screen NieR-style hint strip showing context-relevant hotkeys.
 * The hint set depends on which panel is active and whether an overlay is open.
 */

const HINT_SETS = {
  HOME: [
    { key: "1-4", label: "Tab" },
    { key: "Tab", label: "Next" },
    { key: "↑ ↓", label: "Field" },
    { key: "Space", label: "Edit" },
    { key: "Enter", label: "Submit" },
    { key: "T", label: "Speak" },
    { key: "H", label: "History" },
    { key: "S", label: "Settings" },
    { key: "M", label: "Mute" },
  ],
  FLIGHTS: [
    { key: "1-4", label: "Tab" },
    { key: "Tab", label: "Next" },
    { key: "↑ ↓", label: "Item" },
    { key: "Space", label: "Pick" },
    { key: "⌘Z", label: "Undo" },
    { key: "T", label: "Speak" },
    { key: "H", label: "History" },
    { key: "S", label: "Settings" },
    { key: "Esc", label: "Back" },
  ],
  HOTELS: [
    { key: "1-4", label: "Tab" },
    { key: "Tab", label: "Next" },
    { key: "↑ ↓", label: "Item" },
    { key: "Space", label: "Pick" },
    { key: "⌘Z", label: "Undo" },
    { key: "T", label: "Speak" },
    { key: "H", label: "History" },
    { key: "S", label: "Settings" },
    { key: "Esc", label: "Back" },
  ],
  DAYS: [
    { key: "1-4", label: "Tab" },
    { key: "Tab", label: "Next" },
    { key: "↑ ↓", label: "Day" },
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
  panel = "HOME",
  overlay = null, // null | "history" | "settings"
}) {
  let hints;

  if (overlay === "history") {
    hints = HINT_SETS.HISTORY_OVERLAY;
  } else if (overlay === "settings") {
    hints = HINT_SETS.SETTINGS_OVERLAY;
  } else {
    hints = HINT_SETS[panel] || HINT_SETS.HOME;
  }

  return (
    <div className="footer-hints" aria-label="Keyboard hints">
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
