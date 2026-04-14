import { useEffect } from "react";
import { formatDisplayPrice } from "./SettingsOverlay";

/**
 * Round 17 — print-friendly itinerary view. Opens when the user
 * presses P. Shows a minimal B&W-compatible layout of the whole
 * trip: title, flight, hotel, and day-by-day activity schedule
 * with times + addresses + user notes. Backed by @media print CSS
 * in index.css so window.print() produces a clean PDF.
 */
export default function PrintView({ open, itinerary, currency = "HKD", onClose }) {
  useEffect(() => {
    if (!open) return undefined;
    const handler = (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose?.();
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [open, onClose]);

  if (!open) return null;
  if (!itinerary) {
    return (
      <div className="print-overlay-backdrop" onClick={onClose} data-testid="print-view">
        <div className="print-overlay" onClick={(e) => e.stopPropagation()}>
          <p>No itinerary to print yet.</p>
          <button type="button" onClick={onClose}>Close</button>
        </div>
      </div>
    );
  }

  const flight = itinerary.flight || null;
  const picked = itinerary.selected_flight || flight?.options?.[0] || null;
  const hotel = itinerary.selected_hotel || itinerary.hotels?.[0] || null;
  const days = itinerary.days || [];

  return (
    <div className="print-overlay-backdrop" onClick={onClose} data-testid="print-view">
      <div
        className="print-overlay"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Printable itinerary"
      >
        <div className="print-overlay-actions no-print">
          <button
            type="button"
            onClick={() => window.print()}
            data-testid="print-view-print"
          >
            🖨 PRINT
          </button>
          <button type="button" onClick={onClose}>
            Close (Esc)
          </button>
        </div>

        <article className="print-itinerary">
          <header className="print-header">
            <h1>{itinerary.title || itinerary.destination || "Trip"}</h1>
            <p className="print-subheader">
              {itinerary.origin || ""}
              {itinerary.origin && itinerary.destination ? " → " : ""}
              {itinerary.destination || ""}
              {days.length > 0 && ` · ${days.length} days`}
            </p>
          </header>

          {flight && (
            <section className="print-section">
              <h2>FLIGHT</h2>
              <p>
                {flight.from_iata} → {flight.to_iata} · {flight.date || "date TBA"}
                {picked?.airline && ` · ${picked.airline}`}
                {picked?.price_low && ` · ${formatDisplayPrice(picked.price_low, currency)}`}
                {picked?.departure_time && ` · dep ${picked.departure_time}`}
                {picked?.arrival_time && ` · arr ${picked.arrival_time}`}
              </p>
            </section>
          )}

          {hotel && (
            <section className="print-section">
              <h2>HOTEL</h2>
              <p>
                <strong>{hotel.name}</strong>
                {hotel.address && ` · ${hotel.address}`}
                {hotel.rating != null && ` · ★ ${hotel.rating.toFixed(1)}`}
              </p>
            </section>
          )}

          {days.length > 0 && (
            <section className="print-section">
              <h2>DAY BY DAY</h2>
              {days.map((day) => (
                <div key={day.day} className="print-day">
                  <h3>
                    Day {day.day}
                    {day.date && ` · ${day.date}`}
                    {day.theme && ` · ${day.theme}`}
                  </h3>
                  {day.weather?.condition && (
                    <p className="print-weather">
                      {day.weather.condition}
                      {day.weather.temp != null && ` · ${Math.round(day.weather.temp)}°C`}
                    </p>
                  )}
                  <ol className="print-activities">
                    {(day.activities || []).map((act, i) => (
                      <li key={i}>
                        <strong>{act.time}</strong> · {act.name}
                        {act.address && <span className="print-dim"> · {act.address}</span>}
                        {act.duration_min && (
                          <span className="print-dim"> ({act.duration_min} min)</span>
                        )}
                        {act.user_note && (
                          <div className="print-note">◇ {act.user_note}</div>
                        )}
                      </li>
                    ))}
                  </ol>
                </div>
              ))}
            </section>
          )}

          <footer className="print-footer">
            <p>Generated from CSCI3280 Travel Agent · {new Date().toLocaleString()}</p>
          </footer>
        </article>
      </div>
    </div>
  );
}
