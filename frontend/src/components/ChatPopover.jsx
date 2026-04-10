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
 */
export default function ChatPopover({
  open,
  onSend,
  onClose,
  isLoading,
  initialText = "",
  onRecallLast,
}) {
  const [text, setText] = useState("");
  const inputRef = useRef(null);

  // Auto-focus on open and seed with initialText if provided
  useEffect(() => {
    if (open) {
      setText(initialText || "");
      // Defer to next tick so the DOM is ready
      requestAnimationFrame(() => {
        const el = inputRef.current;
        if (el) {
          el.focus();
          // Place cursor at the end so the user can keep typing
          const len = (initialText || "").length;
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
    onSend?.(trimmed);
    setText("");
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
      onSend?.(transcript.trim());
      onClose?.();
    }
  };

  return (
    <>
      <div className="chat-popover-backdrop" onClick={onClose} />
      <form className="chat-popover" onSubmit={handleSubmit}>
        <div className="chat-popover-bracket chat-popover-bracket-tl" />
        <div className="chat-popover-bracket chat-popover-bracket-tr" />
        <div className="chat-popover-bracket chat-popover-bracket-bl" />
        <div className="chat-popover-bracket chat-popover-bracket-br" />
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
      </form>
    </>
  );
}
