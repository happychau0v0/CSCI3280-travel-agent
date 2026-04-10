/**
 * Bottom-of-screen NieR-style hint strip showing the universal hotkeys.
 *
 * Mirrors the controller-hint footer in NieR Automata's menus
 * ("◯ Select  ✕ Back"). We show keyboard equivalents.
 */
const HINTS = [
  { key: "1-7", label: "Tab" },
  { key: "← →", label: "Switch" },
  { key: "↑ ↓", label: "Item" },
  { key: "Enter", label: "Speak" },
  { key: "Space", label: "Select" },
  { key: "Esc", label: "Back" },
  { key: "M", label: "Mute" },
];

export default function FooterHints({ muted = false }) {
  return (
    <div className="footer-hints" aria-label="Keyboard hints">
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
