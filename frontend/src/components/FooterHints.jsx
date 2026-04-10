/**
 * Bottom-of-screen NieR-style hint strip showing the universal hotkeys.
 *
 * Mirrors the controller-hint footer in NieR Automata's menus
 * ("◯ Select  ✕ Back"). We show keyboard equivalents.
 *
 * The current scope is shown as a leading "FOCUS:" badge so the user
 * can see whether ←/→ will cycle tabs or be absorbed by the panel.
 */
const HINTS = [
  { key: "1-7", label: "Tab" },
  { key: "← →", label: "Switch" },
  { key: "↑ ↓", label: "Item" },
  { key: "Tab", label: "Focus" },
  { key: "Enter", label: "Speak" },
  { key: "Space", label: "Select" },
  { key: "E", label: "Edit" },
  { key: "Esc", label: "Back" },
  { key: "M", label: "Mute" },
];

export default function FooterHints({ muted = false, scope = "tabs" }) {
  const scopeLabel = scope === "list" ? "LIST" : "TABS";
  return (
    <div className="footer-hints" aria-label="Keyboard hints">
      <span className={`hint hint-scope hint-scope-${scope}`}>
        <span className="hint-label">FOCUS</span>
        <kbd className="hint-key">{scopeLabel}</kbd>
      </span>
      {HINTS.map((h) => (
        <span key={h.key} className="hint">
          <kbd className="hint-key">{h.key}</kbd>
          <span className="hint-label">{h.label}</span>
        </span>
      ))}
      {muted && <span className="hint hint-muted">🔇 MUTED</span>}
    </div>
  );
}
