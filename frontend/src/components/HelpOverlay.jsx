import { useEffect, useRef } from "react";

/**
 * Keyboard help overlay — shows every hotkey in the app, grouped
 * by context. Opened via the ? key. Closes on Esc or clicking the
 * backdrop. Round 14.
 */

const GROUPS = [
  {
    name: "NAVIGATION",
    rows: [
      ["1 / 2 / 3 / 4", "Jump to PLAN / FLIGHTS / HOTELS / DAYS"],
      ["↑ / ↓", "Move list cursor (or activity cursor on DAYS right column)"],
      ["Tab", "Toggle focus left column ↔ right column"],
      ["Esc", "Back / close overlay / leave list scope"],
    ],
  },
  {
    name: "ACTIONS",
    rows: [
      ["Space", "Activate focused row"],
      ["Enter", "Submit form / open flight or hotel PICK"],
      ["⌘Z", "Undo the last flight / hotel pick"],
      ["⌘⇧Z / ⌘Y", "Redo"],
    ],
  },
  {
    name: "VOICE & CHAT",
    rows: [
      ["T", "Open chat popover"],
      ["⌘K", "Same as T"],
      ["M", "Mute / unmute TTS"],
    ],
  },
  {
    name: "OVERLAYS",
    rows: [
      ["H", "Open HISTORY overlay (conversation)"],
      ["S", "Open SETTINGS overlay (preferences, theme, currency)"],
      ["P", "Open print-friendly trip view"],
      ["L", "Open trip checkList (packing + reminders)"],
      ["F", "Open Favorites overlay"],
      ["?", "Open this keyboard help"],
    ],
  },
  {
    name: "HISTORY OVERLAY",
    rows: [
      ["↑ / ↓", "Cycle turns"],
      ["PgUp / PgDn", "Scroll within a turn"],
      ["E", "Edit a user turn and re-run"],
    ],
  },
  {
    name: "DAYS PANEL",
    rows: [
      ["Drag", "Reorder real activities within a day"],
      ["REMOVE ×", "Delete a single activity"],
      ["REPLACE ↻", "Ask agent for a similar alternative"],
    ],
  },
];

export default function HelpOverlay({ open, onClose }) {
  const rootRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const handler = (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose?.();
      }
    };
    document.addEventListener("keydown", handler);
    requestAnimationFrame(() => rootRef.current?.focus());
    return () => document.removeEventListener("keydown", handler);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="help-overlay-backdrop"
      onClick={onClose}
      data-testid="help-overlay"
    >
      <div
        className="help-overlay"
        ref={rootRef}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Keyboard shortcuts"
      >
        <div className="help-overlay-header">
          <span className="help-overlay-chevron">◢</span>
          <span className="help-overlay-title">KEYBOARD SHORTCUTS</span>
          <span className="help-overlay-close-hint">Esc to close</span>
        </div>
        <div className="help-overlay-body">
          {GROUPS.map((group) => (
            <section key={group.name} className="help-group">
              <h3 className="help-group-title">{group.name}</h3>
              <ul className="help-group-rows">
                {group.rows.map(([key, label]) => (
                  <li key={key + label} className="help-row">
                    <kbd className="help-row-key">{key}</kbd>
                    <span className="help-row-label">{label}</span>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
