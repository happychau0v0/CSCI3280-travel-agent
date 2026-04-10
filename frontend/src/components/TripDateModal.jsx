import { useEffect, useState } from "react";

/**
 * Compute defaults: next Saturday and Saturday + 2 days. Gives the user
 * a sensible weekend trip without forcing them to think about it.
 */
function defaultDates() {
  const now = new Date();
  const day = now.getDay(); // 0=Sunday, 6=Saturday
  const daysUntilSaturday = (6 - day + 7) % 7 || 7;
  const start = new Date(now);
  start.setDate(now.getDate() + daysUntilSaturday);
  const end = new Date(start);
  end.setDate(start.getDate() + 2);
  return {
    start: start.toISOString().slice(0, 10),
    end: end.toISOString().slice(0, 10),
  };
}

/**
 * Modal that pops on the first trip request. Asks the user to pick a
 * start and end date so the LLM doesn't have to ask "when?" mid-chat.
 *
 * Props:
 *   open:      bool — controlled by parent
 *   onConfirm: ({start, end}) => void
 *   onCancel:  () => void  (skip — proceed without dates)
 */
export default function TripDateModal({ open, onConfirm, onCancel }) {
  const [{ start, end }, setDates] = useState(defaultDates);

  // Reset to defaults each time the modal opens
  useEffect(() => {
    if (open) setDates(defaultDates());
  }, [open]);

  // Esc closes
  useEffect(() => {
    if (!open) return;
    const handleKey = (e) => {
      if (e.key === "Escape") onCancel();
    };
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [open, onCancel]);

  if (!open) return null;

  const handleSubmit = (e) => {
    e.preventDefault();
    if (!start || !end) return;
    if (end < start) {
      onConfirm({ start, end: start });
    } else {
      onConfirm({ start, end });
    }
  };

  const numDays =
    start && end
      ? Math.max(1, Math.round((new Date(end) - new Date(start)) / 86400000) + 1)
      : 0;

  return (
    <div className="trip-date-modal-backdrop" onClick={onCancel}>
      <form
        className="trip-date-modal"
        onClick={(e) => e.stopPropagation()}
        onSubmit={handleSubmit}
      >
        <header className="trip-date-header">
          <h2>When are you traveling?</h2>
          <p>Pick your trip dates so I can find flights and plan the days.</p>
        </header>

        <div className="trip-date-fields">
          <label>
            <span>Start</span>
            <input
              type="date"
              value={start}
              onChange={(e) => setDates((d) => ({ ...d, start: e.target.value }))}
              required
            />
          </label>
          <span className="trip-date-arrow">→</span>
          <label>
            <span>End</span>
            <input
              type="date"
              value={end}
              min={start}
              onChange={(e) => setDates((d) => ({ ...d, end: e.target.value }))}
              required
            />
          </label>
        </div>

        {numDays > 0 && (
          <div className="trip-date-summary">
            {numDays} day{numDays !== 1 ? "s" : ""}
          </div>
        )}

        <div className="trip-date-actions">
          <button type="button" className="trip-date-skip" onClick={onCancel}>
            Skip
          </button>
          <button type="submit" className="trip-date-confirm">
            Confirm dates
          </button>
        </div>
      </form>
    </div>
  );
}
