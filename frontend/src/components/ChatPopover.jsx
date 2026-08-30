import { useEffect, useRef, useState } from "react";
import VoiceRecorder from "./VoiceRecorder";

/**
 * Centered floating chat input popover. Triggered by pressing Enter
 * or Cmd/Ctrl+K from anywhere in the menu shell.
 *
 * Behavior:
 *  - Auto-focuses the text input on open
 *  - Enter sends the message and closes the popover
 *  - Esc closes without sending
 *  - The mic button (left) triggers VoiceRecorder push-to-talk
 *  - When voice recognition returns a transcript, it's sent immediately
 *  - ↑ in an empty input recalls the most recent user message (terminal-
 *    style history walk-back) so the user can refine and re-run
 *  - When opened with `initialText`, the input is prefilled with that
 *    text and the cursor lands at the end (used by the E hotkey)
 *
 * Props:
 *   open:    bool — controlled by parent
 *   onSend:  (text) => void
 *   onClose: () => void
 *   isLoading: bool — disable input while a request is in flight
 *   initialText: string | null — prefill text on open (E hotkey path)
 *   onRecallLast: () => string | null — fetch last user message
 *   promptLabel: string — question text shown above input
 *   options: string[] | null — when set, render clickable choice buttons
 */
export default function ChatPopover({
  open,
  onSend,
  onClose,
  isLoading,
  initialText = "",
  onRecallLast,
  promptLabel = "",
  options = null,
}) {
  const [text, setText] = useState("");
  // The "this popover session is an edit" flag lives here, NOT in the
  // parent. When the popover mounts with a non-empty initialText
  // (e.g. opened via E or a HISTORY-overlay turn edit), we capture
  // that fact into local state at mount-time. Subsequent submits in
  // the same session pass { editLast: isEditSession } directly to
  // onSend so the parent doesn't need to read its own state from a
  // stale closure (B5). When the user opens via T (initialText empty)
  // the flag is false and submits are fresh sends.
  const [isEditSession, setIsEditSession] = useState(false);
  const inputRef = useRef(null);

  // Auto-focus on open and seed with initialText if provided
  useEffect(() => {
    if (open) {
      const seed = initialText || "";
      setText(seed);
      setIsEditSession(seed.length > 0);
      // Defer to next tick so the DOM is ready
      requestAnimationFrame(() => {
        const el = inputRef.current;
        if (el) {
          el.focus();
          // Place cursor at the end so the user can keep typing
          const len = seed.length;
          try {
            el.setSelectionRange(len, len);
          } catch {
            // Some browsers reject setSelectionRange on certain input types
          }
        }
      });
    }
    // We intentionally only react to `open` flipping — initialText is
    // captured on the same render that opens the popover.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (!open) return null;

  const handleSubmit = (e) => {
    e.preventDefault();
    const trimmed = text.trim();
    if (!trimmed || isLoading) return;
    onSend?.(trimmed, { editLast: isEditSession });
    setText("");
    setIsEditSession(false);
    onClose?.();
  };

  const handleKeyDown = (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose?.();
    } else if (e.key === "ArrowUp" && !text) {
      // Empty input + ↑ → recall the most recent user message,
      // shell-history style.
      const last = onRecallLast?.();
      if (last) {
        e.preventDefault();
        setText(last);
        requestAnimationFrame(() => {
          const el = inputRef.current;
          if (el) {
            try {
              el.setSelectionRange(last.length, last.length);
            } catch {
              // ignore
            }
          }
        });
      }
    }
  };

  const handleVoiceResult = (transcript) => {
    if (transcript?.trim()) {
      onSend?.(transcript.trim(), { editLast: isEditSession });
      setIsEditSession(false);
      onClose?.();
    }
  };

  return (
    <>
      <div className="chat-popover-backdrop" onClick={onClose} />
      <form
        className="chat-popover"
        onSubmit={handleSubmit}
        role="dialog"
        aria-label="Chat with travel agent"
        aria-modal="true"
      >
        <div className="chat-popover-bracket chat-popover-bracket-tl" />
        <div className="chat-popover-bracket chat-popover-bracket-tr" />
        <div className="chat-popover-bracket chat-popover-bracket-bl" />
        <div className="chat-popover-bracket chat-popover-bracket-br" />
        {promptLabel && (
          <p className="chat-popover-prompt-label">{promptLabel}</p>
        )}
        {options && options.length > 0 && (
          <div className="chat-popover-options">
            {options.map((opt) => (
              <button
                key={opt}
                type="button"
                className="chat-popover-option-btn"
                disabled={isLoading}
                onClick={() => {
                  onSend?.(opt, { editLast: false });
                  onClose?.();
                }}
              >
                {opt}
              </button>
            ))}
          </div>
        )}
        <div className="chat-popover-input-row">
          <VoiceRecorder onResult={handleVoiceResult} disabled={isLoading} />
          <input
            ref={inputRef}
            type="text"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Speak or type to the agent…"
            disabled={isLoading}
            autoComplete="off"
          />
          <button
            type="submit"
            className="chat-popover-send"
            disabled={!text.trim() || isLoading}
          >
            {isLoading ? "…" : "→"}
          </button>
          <button
            type="button"
            className="chat-popover-close"
            onClick={onClose}
            aria-label="Close"
          >
            ×
          </button>
        </div>
      </form>
    </>
  );
}
