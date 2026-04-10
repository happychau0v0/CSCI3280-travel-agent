import { useEffect, useRef } from "react";
import AudioPlayer from "./AudioPlayer";

/**
 * Overlay-only chat window. Renders the message history as iMessage-style
 * frosted-glass bubbles in the top-left of the viewport. The input form
 * lives in InputDock now.
 *
 * Strips JSON code blocks from displayed messages — the structured itinerary
 * is shown in the slide-in drawer instead.
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

export default function ChatWindow({ messages, isLoading }) {
  const messagesEndRef = useRef(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, isLoading]);

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
          return (
            <div key={i} className={`message message-${msg.role}`}>
              <div className="message-bubble">
                <div className="message-content">
                  {msg.role === "assistant" ? renderMarkdown(display) : display}
                </div>
                {msg.role === "assistant" && display && (
                  <AudioPlayer text={display} />
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
