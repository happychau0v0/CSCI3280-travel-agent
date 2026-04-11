import { useState } from "react";
import HighlightedText from "./HighlightedText";

/**
 * Bottom-of-screen subtitle bar — displays one sentence at a time
 * synced with the auto-TTS subtitle queue. Inspired by NieR's
 * single-line dialogue subtitles. Important entities (places, prices,
 * dates, IATA codes) get inline highlights via HighlightedText.
 *
 * Round 16 — the history prop carries the last ~20 subtitle lines.
 * Clicking the ↑ button opens a popover so the user can re-read
 * narration they missed.
 */
export default function Subtitle({ text, history = [] }) {
  const [historyOpen, setHistoryOpen] = useState(false);
  const hasHistory = history.length > 0;
  return (
    <div className={`subtitle${text ? " visible" : ""}`} aria-live="polite">
      {hasHistory && (
        <button
          type="button"
          className={`subtitle-history-toggle${historyOpen ? " active" : ""}`}
          onClick={() => setHistoryOpen((v) => !v)}
          aria-label="Toggle subtitle history"
          title="Show recent narration"
          data-testid="subtitle-history-toggle"
        >
          ↑
        </button>
      )}
      {text && <HighlightedText text={text} className="subtitle-text" />}
      {historyOpen && hasHistory && (
        <div className="subtitle-history" data-testid="subtitle-history">
          <div className="subtitle-history-header">
            <span>RECENT NARRATION · {history.length}</span>
            <button
              type="button"
              className="subtitle-history-close"
              onClick={() => setHistoryOpen(false)}
              aria-label="Close"
            >
              ×
            </button>
          </div>
          <ol className="subtitle-history-list">
            {history.slice().reverse().map((line, i) => (
              <li key={i} className="subtitle-history-row">
                <HighlightedText text={line} className="subtitle-history-text" />
              </li>
            ))}
          </ol>
        </div>
      )}
    </div>
  );
}
