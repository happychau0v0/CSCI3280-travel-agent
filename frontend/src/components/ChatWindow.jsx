import { useEffect, useRef, useState } from "react";
import AudioPlayer from "./AudioPlayer";

/**
 * Overlay-only chat window. Renders the message history as iMessage-style
 * frosted-glass bubbles in the top-left of the viewport. The input form
 * lives in InputDock now.
 *
 * Strips JSON code blocks from displayed messages — the structured itinerary
 * is shown in the persistent right sidebar instead.
 *
 * The most-recent user message can be edited inline: hover to reveal a
 * pencil icon, click to swap the bubble for a textarea, save to truncate
 * the conversation history and resend with the edited text.
 */
function stripJsonBlocks(text) {
  return (text || "").replace(/```json[\s\S]*?```/g, "").trim();
}

/**
 * Render a string with minimal markdown support: **bold** segments become
 * <strong>. Splits on the bold pattern and rebuilds as a React fragment.
 */
function renderMarkdown(text) {
  if (!text) return null;
  const parts = text.split(/(\*\*[^*]+\*\*)/g);
  return parts.map((part, i) => {
    const m = part.match(/^\*\*([^*]+)\*\*$/);
    if (m) return <strong key={i}>{m[1]}</strong>;
    return <span key={i}>{part}</span>;
  });
}

export default function ChatWindow({ messages, isLoading, onEditAndResend }) {
  const messagesEndRef = useRef(null);
  const [editingIndex, setEditingIndex] = useState(null);
  const [editText, setEditText] = useState("");

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, isLoading]);

  // Index of the LAST user message (the only one that's editable)
  const lastUserIndex = (() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "user") return i;
    }
    return -1;
  })();

  const startEdit = (i, text) => {
    setEditingIndex(i);
    setEditText(text);
  };

  const cancelEdit = () => {
    setEditingIndex(null);
    setEditText("");
  };

  const saveEdit = () => {
    const trimmed = editText.trim();
    if (!trimmed) return;
    setEditingIndex(null);
    setEditText("");
    onEditAndResend?.(trimmed);
  };

  const handleEditKeyDown = (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      saveEdit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      cancelEdit();
    }
  };

  return (
    <div className="chat-overlay">
      {messages.length === 0 && !isLoading && (
        <div className="chat-empty">
          <h2>Where would you like to go?</h2>
          <p>
            Type or speak your travel plans. I'll search for real places,
            check directions, and build your itinerary.
          </p>
        </div>
      )}

      <div className="message-list">
        {messages.map((msg, i) => {
          const display =
            msg.role === "assistant" ? stripJsonBlocks(msg.content) : msg.content;
          const isEditing = editingIndex === i;
          const isEditableUser =
            msg.role === "user" && i === lastUserIndex && !isLoading;

          return (
            <div key={i} className={`message message-${msg.role}`}>
              <div className="message-bubble">
                {isEditing ? (
                  <div className="message-edit">
                    <textarea
                      autoFocus
                      value={editText}
                      onChange={(e) => setEditText(e.target.value)}
                      onKeyDown={handleEditKeyDown}
                      rows={2}
                    />
                    <div className="message-edit-actions">
                      <button type="button" onClick={cancelEdit} title="Cancel">
                        ×
                      </button>
                      <button
                        type="button"
                        className="message-edit-save"
                        onClick={saveEdit}
                        title="Save and resend"
                      >
                        ✓
                      </button>
                    </div>
                  </div>
                ) : (
                  <>
                    <div className="message-content">
                      {msg.role === "assistant" ? renderMarkdown(display) : display}
                    </div>
                    {msg.role === "assistant" && display && (
                      <AudioPlayer text={display} />
                    )}
                    {isEditableUser && (
                      <button
                        type="button"
                        className="message-edit-btn"
                        onClick={() => startEdit(i, msg.content)}
                        title="Edit and resend"
                        aria-label="Edit message"
                      >
                        ✎
                      </button>
                    )}
                  </>
                )}
              </div>
            </div>
          );
        })}

        {isLoading && (
          <div className="message message-assistant">
            <div className="message-bubble loading">
              <span className="dot" />
              <span className="dot" />
              <span className="dot" />
            </div>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>
    </div>
  );
}
