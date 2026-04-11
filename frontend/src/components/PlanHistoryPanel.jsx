/**
 * Plan history panel — mounts in the PLAN panel's right column.
 * Shows recent itineraries from localStorage["travel-plan-history"]
 * and lets the user re-load any past plan via a LOAD button.
 *
 * Round 13 — each card also has an EXPORT button that downloads the
 * plan as a JSON file. The panel is also a drop zone for .json
 * files exported from another browser / device, so plans become
 * portable without a backend.
 *
 * Props:
 *   plans:    [{id, created_at, destination, origin, start_date,
 *              end_date, day_count, itinerary, messages}, ...]
 *   onLoad:   (id) => void — restore the plan into currentItinerary
 *   onDelete: (id) => void — remove from history
 *   onImport: (entry) => void — accept an imported plan JSON
 */

function downloadPlanAsJson(entry) {
  try {
    const json = JSON.stringify(entry, null, 2);
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    const safeDest = (entry.destination || "plan").replace(/[^a-z0-9]+/gi, "-");
    a.download = `travel-plan-${safeDest.toLowerCase()}-${entry.id}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 500);
  } catch {
    /* ignore — user's browser blocked blob downloads */
  }
}

// Round 16 — copy a permalink URL that embeds the plan as base64
// in the query string. Opening the URL in another browser imports
// the plan automatically.
function buildPlanPermalink(entry) {
  try {
    // Strip messages to keep the URL short — receiving browser
    // still gets enough to render + re-load the itinerary.
    const slim = {
      destination: entry.destination,
      origin: entry.origin,
      start_date: entry.start_date,
      end_date: entry.end_date,
      day_count: entry.day_count,
      itinerary: entry.itinerary,
    };
    const json = JSON.stringify(slim);
    // Use unescape/btoa for UTF-8 safety
    const b64 = btoa(unescape(encodeURIComponent(json)));
    const url = new URL(window.location.href);
    url.hash = `plan=${b64}`;
    return url.toString();
  } catch {
    return null;
  }
}

async function copyPermalink(entry) {
  const link = buildPlanPermalink(entry);
  if (!link) return false;
  try {
    await navigator.clipboard.writeText(link);
    return true;
  } catch {
    // Fallback: prompt so the user can copy manually
    try {
      window.prompt("Copy this shareable link:", link);
      return true;
    } catch {
      return false;
    }
  }
}

async function readImportedFile(file) {
  try {
    const text = await file.text();
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object") return null;
    // Accept either a single plan entry or an array of them.
    const entry = Array.isArray(parsed) ? parsed[0] : parsed;
    if (!entry?.itinerary?.destination) return null;
    return entry;
  } catch {
    return null;
  }
}

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

export default function PlanHistoryPanel({ plans = [], onLoad, onDelete, onImport }) {
  const handleDragOver = (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    e.currentTarget.classList.add("plan-history-dragover");
  };
  const handleDragLeave = (e) => {
    e.currentTarget.classList.remove("plan-history-dragover");
  };
  const handleDrop = async (e) => {
    e.preventDefault();
    e.currentTarget.classList.remove("plan-history-dragover");
    const file = e.dataTransfer.files?.[0];
    if (!file) return;
    const entry = await readImportedFile(file);
    if (entry && onImport) onImport(entry);
  };

  return (
    <aside
      className="plan-history-panel"
      data-testid="plan-history-panel"
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
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
            plan shows up here so you can revisit or tweak it later. You
            can also drag a .json plan export into this panel to import it.
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
                  className="plan-history-card-btn share"
                  onClick={async () => {
                    const ok = await copyPermalink(p);
                    if (ok) {
                      // Brief visual confirmation via class toggle
                      const el = document.querySelector(
                        `[data-testid="plan-history-share-${p.id}"]`,
                      );
                      if (el) {
                        el.classList.add("copied");
                        setTimeout(() => el.classList.remove("copied"), 1500);
                      }
                    }
                  }}
                  data-testid={`plan-history-share-${p.id}`}
                  aria-label="Copy shareable link"
                  title="Copy shareable link"
                >
                  ⇪
                </button>
                <button
                  type="button"
                  className="plan-history-card-btn export"
                  onClick={() => downloadPlanAsJson(p)}
                  data-testid={`plan-history-export-${p.id}`}
                  aria-label="Export plan as JSON"
                  title="Export as JSON"
                >
                  ↓
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
