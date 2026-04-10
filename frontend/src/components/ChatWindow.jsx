import { useEffect, useRef, useState } from "react";
import VoiceRecorder from "./VoiceRecorder";
import AudioPlayer from "./AudioPlayer";

/**
 * Chat window with message history, text input, and voice input button.
 * Strips JSON code blocks from displayed messages — the structured itinerary
 * is shown in the sidebar instead.
 */
function stripJsonBlocks(text) {
  return (text || "").replace(/```json[\s\S]*?```/g, "").trim();
}

export default function ChatWindow({ messages, onSend, isLoading }) {
  const [input, setInput] = useState("");
  const messagesEndRef = useRef(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, isLoading]);

  const handleSubmit = (e) => {
    e.preventDefault();
    const trimmed = input.trim();
    if (!trimmed || isLoading) return;
    onSend(trimmed);
    setInput("");
  };

  const handleVoiceResult = (transcript) => {
    if (transcript?.trim()) onSend(transcript.trim());
  };

  return (
    <div className="chat-window">
      <div className="message-list">
        {messages.length === 0 && !isLoading && (
          <div className="empty-state">
            <h2>Where would you like to go?</h2>
            <p>
              Type or speak your travel plans. I'll search for real places,
              check directions, and build your itinerary.
            </p>
          </div>
        )}

        {messages.map((msg, i) => {
          const display =
            msg.role === "assistant" ? stripJsonBlocks(msg.content) : msg.content;
          return (
            <div key={i} className={`message message-${msg.role}`}>
              <div className="message-bubble">
                <div className="message-content">{display}</div>
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

      <form className="chat-input-form" onSubmit={handleSubmit}>
        <VoiceRecorder onResult={handleVoiceResult} disabled={isLoading} />
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Plan a 3-day trip to Tokyo..."
          disabled={isLoading}
        />
        <button type="submit" disabled={!input.trim() || isLoading}>
          Send
        </button>
      </form>
    </div>
  );
}
