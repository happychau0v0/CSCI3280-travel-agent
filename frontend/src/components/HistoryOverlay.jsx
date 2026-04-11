import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import HighlightedText from "./HighlightedText";

/**
 * HistoryOverlay — full-screen dimmed conversation review.
 *
 * Triggered by the H hotkey. Renders a portal to document.body so it
 * sits above the menu shell and AgentStatusBar. Inside:
 *   - A scrollable pane with all turns rendered top-to-bottom
 *   - Speaker badges (YOU teal, AGENT cyan)
 *   - The active turn is highlighted with a glow
 *   - ↑/↓ moves activeIdx between turns and centers the active one
 *   - PgUp/PgDn does free scrolling without changing activeIdx
 *   - E on the active turn calls onEditTurn(idx, content), which the
 *     parent uses to truncate history to before idx and open the
 *     chat popover prefilled with that text
 *   - Esc closes the overlay
 *
 * Markdown leakage (** __ * `) is stripped via HighlightedText.
 */

function stripJsonBlocks(text) {
  if (!text) return "";
  return text.replace(/```json[\s\S]*?```/g, "[itinerary attached]");
}

export default function HistoryOverlay({ open, messages = [], onClose, onEditTurn }) {
  const [activeIdx, setActiveIdx] = useState(0);
  const scrollRef = useRef(null);
  const turnRefs = useRef([]);
  const previousFocusRef = useRef(null);
  const rootRef = useRef(null);

  // Reset active turn when the overlay opens. Default to the LAST
  // turn so the user lands on the most recent message.
  useEffect(() => {
    if (open) {
      const lastIdx = Math.max(0, messages.length - 1);
      setActiveIdx(lastIdx);
      // Save the previously focused element so we can restore on close
      previousFocusRef.current = document.activeElement;
      // Focus the overlay root so keyboard events land here
      requestAnimationFrame(() => {
        rootRef.current?.focus();
      });
    } else if (previousFocusRef.current) {
      // Restore focus when closing
      try {
        previousFocusRef.current.focus();
      } catch {
        // ignore
      }
      previousFocusRef.current = null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Scroll active turn into view whenever it changes
  useEffect(() => {
    if (!open) return;
    const el = turnRefs.current[activeIdx];
    if (el) el.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [open, activeIdx]);

  // Document-level keyboard handling while open. The parent's
  // useKeyboard is disabled via the `enabled` flag so there's no
  // double-handling.
  useEffect(() => {
    if (!open) return undefined;
    const handler = (e) => {
      // Esc → close
      if (e.key === "Escape") {
        e.preventDefault();
        onClose?.();
        return;
      }
      // Ignore keystrokes that originate inside an input (the chat
      // popover input might still be focused if the user is typing).
      const tag = e.target?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;

      if (e.key === "ArrowUp") {
        e.preventDefault();
        setActiveIdx((i) => Math.max(0, i - 1));
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        setActiveIdx((i) => Math.min(messages.length - 1, i + 1));
      } else if (e.key === "PageUp") {
        e.preventDefault();
        scrollRef.current?.scrollBy({ top: -scrollRef.current.clientHeight * 0.85, behavior: "smooth" });
      } else if (e.key === "PageDown") {
        e.preventDefault();
        scrollRef.current?.scrollBy({ top: scrollRef.current.clientHeight * 0.85, behavior: "smooth" });
      } else if (e.key === "e" || e.key === "E") {
        e.preventDefault();
        // Only user turns are editable — the user shouldn't be able
        // to "edit" an agent reply (that would fork the conversation
        // at a nonsense point). Pressing E on an agent turn is a
        // no-op. Arrow-navigation still works on agent turns so the
        // user can read them.
        const turn = messages[activeIdx];
        if (turn && turn.role === "user") {
          onEditTurn?.(activeIdx, turn.content);
        }
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [open, messages, activeIdx, onClose, onEditTurn]);

  if (!open) return null;

  const content = (
    <div
      className="history-overlay"
      role="dialog"
      aria-label="Conversation history"
      ref={rootRef}
      tabIndex={-1}
    >
      <div className="history-overlay-backdrop" onClick={onClose} />
      <div className="history-overlay-frame">
        <header className="history-overlay-header">
          <span className="history-overlay-title">CONVERSATION HISTORY</span>
          <span className="history-overlay-meta">
            {messages.length} turn{messages.length !== 1 ? "s" : ""}
            {messages.length > 0 && (
              <>
                {" · "}
                <kbd>E</kbd> edit · <kbd>↑↓</kbd> turn · <kbd>Esc</kbd> close
              </>
            )}
          </span>
        </header>
        {messages.length === 0 ? (
          <div className="history-overlay-empty">
            <h2>NO CONVERSATION YET</h2>
            <p>Press T to talk to the agent.</p>
          </div>
        ) : (
          <div className="history-overlay-scroll" ref={scrollRef}>
            {messages.map((msg, i) => {
              const isUser = msg.role === "user";
              const text = stripJsonBlocks(msg.content);
              const isActive = i === activeIdx;
              return (
                <article
                  key={i}
                  ref={(el) => {
                    turnRefs.current[i] = el;
                  }}
                  className={
                    `history-turn history-turn-${isUser ? "user" : "agent"}` +
                    (isActive ? " history-turn-active" : "")
                  }
                  data-turn-index={i}
                  onClick={() => setActiveIdx(i)}
                >
                  <header className="history-badge">
                    <span className="history-badge-name">{isUser ? "YOU" : "AGENT"}</span>
                    {isActive && isUser && (
                      <span className="history-edit-hint">
                        <kbd>E</kbd> edit & rerun
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
        )}
      </div>
    </div>
  );

  return createPortal(content, document.body);
}
