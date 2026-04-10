/**
 * TRIP panel — command center summary view. Shows origin → destination,
 * dates, flight cost, day count, and weather glance. Empty state if no
 * itinerary yet.
 */
function formatHKD(n) {
  if (n == null) return "—";
  return `HK$${n.toLocaleString("en-HK")}`;
}

export default function PanelTrip({ itinerary, userLocation, tripDates }) {
  if (!itinerary) {
    return (
      <section className="panel panel-trip" aria-label="Trip">
        <div className="panel-empty">
          <h2>NO TRIP PLANNED</h2>
          <p>Press Enter to speak with the agent and plan your trip.</p>
          {userLocation?.city && (
            <p className="panel-empty-meta">
              You are in <strong>{userLocation.city}</strong>
            </p>
          )}
        </div>
      </section>
    );
  }

  const dayCount = (itinerary.days || []).length;
  const flight = itinerary.flight;
  const hotelCount = (itinerary.hotels || []).length;

  return (
    <section className="panel panel-trip" aria-label="Trip">
      <header className="panel-header">
        <h2>{itinerary.title || itinerary.destination}</h2>
        <p className="panel-subtitle">
          {itinerary.origin || userLocation?.city || "—"} → {itinerary.destination}
        </p>
      </header>

      <div className="panel-trip-grid">
        <div className="trip-stat">
          <div className="trip-stat-label">DAYS</div>
          <div className="trip-stat-value">{dayCount}</div>
        </div>
        <div className="trip-stat">
          <div className="trip-stat-label">FLIGHT</div>
          <div className="trip-stat-value">
            {flight ? formatHKD(flight.estimate_low) : "—"}
            {flight && (
              <span className="trip-stat-sub">
                – {formatHKD(flight.estimate_high)}
              </span>
            )}
          </div>
        </div>
        <div className="trip-stat">
          <div className="trip-stat-label">HOTELS</div>
          <div className="trip-stat-value">{hotelCount}</div>
        </div>
        <div className="trip-stat">
          <div className="trip-stat-label">TRANSPORT</div>
          <div className="trip-stat-value trip-stat-text">
            {itinerary.local_transport_mode || "—"}
          </div>
        </div>
      </div>

      {tripDates?.start && (
        <div className="trip-dates-row">
          <span className="trip-dates-label">DATES</span>
          <span className="trip-dates-value">
            {tripDates.start} → {tripDates.end || tripDates.start}
          </span>
        </div>
      )}
    </section>
  );
}
