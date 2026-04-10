import { useEffect, useRef } from "react";
import HighlightedText from "../HighlightedText";

/**
 * HISTORY panel — Zelda-style scrolling conversation review.
 *
 * One full-width column with the entire conversation flowing top to
 * bottom. Each turn has a small colored speaker badge above the text:
 * teal "YOU" for user, cyan "AGENT" for assistant. Important entities
 * (places, prices, dates, IATA codes) are highlighted inline via
 * HighlightedText.
 *
 * The pane scrolls via the wheel or keyboard. ↑/↓ scrolls a step,
 * PgUp/PgDn scrolls a page. Auto-scrolls to the bottom when a new
 * message arrives so the user always sees the latest turn.
 *
 * The most recent user message gets a small "[E to edit]" hint so
 * the user discovers the edit-and-rerun shortcut from C9a.
 */

function stripJsonBlocks(text) {
  if (!text) return "";
  // Replace ```json ... ``` blocks with a placeholder so the
  // structured itinerary doesn't fill the conversation pane.
  return text.replace(/```json[\s\S]*?```/g, "[itinerary attached]");
}

export default function PanelHistory({ messages }) {
  const scrollRef = useRef(null);

  // Auto-scroll to bottom when a new message arrives
  useEffect(() => {
    if (!scrollRef.current) return;
    scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages.length]);

  // Keyboard scrolling — PgUp/PgDn handled here, ↑/↓ falls back to the
  // global hook (no list cursor on this panel).
  useEffect(() => {
    const handler = (e) => {
      if (!scrollRef.current) return;
      // Only intercept when no input is focused
      const target = e.target;
      if (target?.tagName === "INPUT" || target?.tagName === "TEXTAREA") return;
      const el = scrollRef.current;
      if (e.key === "PageDown") {
        e.preventDefault();
        el.scrollBy({ top: el.clientHeight * 0.85, behavior: "smooth" });
      } else if (e.key === "PageUp") {
        e.preventDefault();
        el.scrollBy({ top: -el.clientHeight * 0.85, behavior: "smooth" });
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, []);

  if (!messages || messages.length === 0) {
    return (
      <section className="panel panel-history" aria-label="History">
        <div className="panel-empty">
          <h2>NO CONVERSATION YET</h2>
          <p>Press Enter to speak with the agent.</p>
        </div>
      </section>
    );
  }

  // Find the index of the most recent user message so we can flag it
  // with the [E] hint.
  let lastUserIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      lastUserIdx = i;
      break;
    }
  }

  return (
    <section className="panel panel-history" aria-label="History">
      <div className="history-scroll" ref={scrollRef}>
        {messages.map((msg, i) => {
          const isUser = msg.role === "user";
          const text = stripJsonBlocks(msg.content);
          return (
            <article
              key={i}
              className={`history-turn history-turn-${isUser ? "user" : "agent"}`}
            >
              <header className="history-badge">
                <span className="history-badge-name">{isUser ? "YOU" : "AGENT"}</span>
                {i === lastUserIdx && (
                  <span className="history-edit-hint">
                    <kbd>E</kbd> to edit & rerun
                  </span>
                )}
              </header>
              <div className="history-body">
                <HighlightedText text={text} />
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}
