/**
 * TRANSCRIPT panel — chat history archive. Left list shows past
 * messages (role + first 60 chars), right detail shows the full
 * message text. Replaces the old chat overlay as the place to scroll
 * back through the conversation.
 */

function summarize(text, max = 60) {
  if (!text) return "";
  // Strip JSON code blocks and markdown for the preview
  const clean = text
    .replace(/```[\s\S]*?```/g, "[itinerary]")
    .replace(/\*\*/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return clean.length > max ? clean.slice(0, max) + "…" : clean;
}

export default function PanelHistory({ messages, listIndex }) {
  if (!messages || messages.length === 0) {
    return (
      <section className="panel panel-list" aria-label="Transcript">
        <div className="panel-empty">
          <h2>NO CONVERSATION YET</h2>
          <p>Press Enter to speak with the agent.</p>
        </div>
      </section>
    );
  }

  const selectedIdx = Math.min(listIndex, messages.length - 1);
  const selected = messages[selectedIdx];

  return (
    <section className="panel panel-list" aria-label="Transcript">
      <ul className="panel-list-items">
        {messages.map((msg, i) => (
          <li
            key={i}
            className={`panel-list-item${i === selectedIdx ? " active" : ""}`}
          >
            <span className="panel-list-label">
              {msg.role === "user" ? "YOU" : "AGENT"}
            </span>
            <span className="panel-list-value">{summarize(msg.content)}</span>
          </li>
        ))}
      </ul>
      <div className="panel-detail panel-day-detail">
        {selected && (
          <>
            <div className="panel-detail-label">
              {selected.role === "user" ? "USER MESSAGE" : "AGENT REPLY"}
              {" · "}
              {selectedIdx + 1} / {messages.length}
            </div>
            <div
              style={{
                fontSize: 14,
                lineHeight: 1.6,
                color: "var(--text-h)",
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
              }}
            >
              {selected.content}
            </div>
          </>
        )}
      </div>
    </section>
  );
}
