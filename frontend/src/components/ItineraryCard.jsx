/**
 * Renders a structured itinerary as a day-by-day card stack.
 * Expects the JSON shape produced by the LLM.
 */
export default function ItineraryCard({ itinerary }) {
  if (!itinerary) return null;

  const days = itinerary.days || [];

  return (
    <div className="itinerary-card">
      <header className="itinerary-header">
        <h2>{itinerary.title || "Your Itinerary"}</h2>
        {itinerary.destination && (
          <p className="destination">{itinerary.destination}</p>
        )}
      </header>

      {days.map((day) => (
        <section key={day.day} className="day-card">
          <h3>
            Day {day.day}
            {day.date && <span className="day-date"> · {day.date}</span>}
            {day.theme && <span className="day-theme"> — {day.theme}</span>}
          </h3>
          <ol className="activities">
            {(day.activities || []).map((act, i) => (
              <li key={i} className="activity">
                <span className="activity-time">{act.time}</span>
                <div className="activity-info">
                  <strong>{act.name}</strong>
                  {act.address && <p className="activity-addr">{act.address}</p>}
                  {act.description && (
                    <p className="activity-desc">{act.description}</p>
                  )}
                  {act.duration_min && (
                    <span className="activity-duration">
                      {act.duration_min} min
                    </span>
                  )}
                  {act.transport_to_next && (
                    <div className="transport">
                      → {act.transport_to_next.mode.toLowerCase()}:{" "}
                      {act.transport_to_next.duration}
                      {act.transport_to_next.distance &&
                        ` (${act.transport_to_next.distance})`}
                    </div>
                  )}
                </div>
              </li>
            ))}
          </ol>
        </section>
      ))}
    </div>
  );
}
