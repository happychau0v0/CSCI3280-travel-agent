/**
 * Plan history panel — mounts in the PLAN panel's right column.
 * Shows recent itineraries from localStorage["travel-plan-history"]
 * and lets the user re-load any past plan via a LOAD button.
 *
 * Props:
 *   plans:    [{id, created_at, destination, origin, start_date,
 *              end_date, day_count, itinerary, messages}, ...]
 *   onLoad:   (id) => void — restore the plan into currentItinerary
 *   onDelete: (id) => void — remove from history
 */

function formatDateRange(start, end) {
  if (!start) return "";
  if (!end || end === start) return start;
  try {
    const s = new Date(start);
    const e = new Date(end);
    const sameMonth = s.getMonth() === e.getMonth() && s.getFullYear() === e.getFullYear();
    const month = s.toLocaleDateString("en", { month: "short" });
    if (sameMonth) return `${month} ${s.getDate()}-${e.getDate()}`;
    const eMonth = e.toLocaleDateString("en", { month: "short" });
    return `${month} ${s.getDate()} – ${eMonth} ${e.getDate()}`;
  } catch {
    return `${start} → ${end}`;
  }
}

function formatRelativeTime(ts) {
  if (!ts) return "";
  const diff = Date.now() - ts;
  const min = Math.round(diff / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  if (day < 30) return `${day}d ago`;
  return new Date(ts).toLocaleDateString();
}

export default function PlanHistoryPanel({ plans = [], onLoad, onDelete }) {
  return (
    <aside className="plan-history-panel" data-testid="plan-history-panel">
      <div className="plan-history-header">
        <span className="plan-history-chevron">◢</span>
        <span className="plan-history-label">PLAN HISTORY</span>
        {plans.length > 0 && (
          <span className="plan-history-count">{plans.length}</span>
        )}
      </div>
      {plans.length === 0 ? (
        <div className="plan-history-empty">
          <p>No past plans yet.</p>
          <p className="plan-history-hint">
            Press START PLANNING to create your first trip. Every completed
            plan shows up here so you can revisit or tweak it later.
          </p>
        </div>
      ) : (
        <ul className="plan-history-list">
          {plans.map((p) => (
            <li
              key={p.id}
              className="plan-history-card"
              data-testid={`plan-history-card-${p.id}`}
            >
              <div className="plan-history-card-head">
                <strong>{p.destination || "Unknown destination"}</strong>
                <span className="plan-history-card-age">
                  {formatRelativeTime(p.created_at)}
                </span>
              </div>
              <div className="plan-history-card-meta">
                {p.origin && (
                  <>
                    {p.origin}
                    <span className="plan-history-arrow"> → </span>
                  </>
                )}
                {p.destination}
                {p.day_count > 0 && ` · ${p.day_count} day${p.day_count === 1 ? "" : "s"}`}
              </div>
              {(p.start_date || p.end_date) && (
                <div className="plan-history-card-dates">
                  {formatDateRange(p.start_date, p.end_date)}
                </div>
              )}
              <div className="plan-history-card-actions">
                <button
                  type="button"
                  className="plan-history-card-btn load"
                  onClick={() => onLoad?.(p.id)}
                  data-testid={`plan-history-load-${p.id}`}
                >
                  LOAD
                </button>
                <button
                  type="button"
                  className="plan-history-card-btn delete"
                  onClick={() => onDelete?.(p.id)}
                  aria-label="Delete plan"
                >
                  ×
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </aside>
  );
}
