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
 *
 * Props:
 *   open:    bool — controlled by parent
 *   onSend:  (text) => void
 *   onClose: () => void
 *   isLoading: bool — disable input while a request is in flight
 */
export default function ChatPopover({ open, onSend, onClose, isLoading }) {
  const [text, setText] = useState("");
  const inputRef = useRef(null);

  // Auto-focus on open
  useEffect(() => {
    if (open) {
      setText("");
      // Defer to next tick so the DOM is ready
      requestAnimationFrame(() => {
        inputRef.current?.focus();
      });
    }
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
