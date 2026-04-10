/**
 * Renders the flight section at the top of the itinerary drawer.
 * Shows origin → destination, price band, duration, source badge,
 * and a "View live prices on Google Flights" link.
 */
function formatDuration(min) {
  if (!min) return "—";
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

export default function FlightCard({ flight }) {
  if (!flight) return null;

  const isLive = flight.source === "fast-flights";
  const fromLabel = flight.from_iata || flight.from_city || "—";
  const toLabel = flight.to_iata || flight.to_city || "—";

  const priceText =
    flight.estimate_low != null && flight.estimate_high != null
      ? `$${flight.estimate_low}–$${flight.estimate_high}`
      : "—";

  const stopsText =
    flight.stops_typical === 0
      ? "non-stop"
      : flight.stops_typical === 1
        ? "1 stop"
        : flight.stops_typical
          ? `${flight.stops_typical} stops`
          : "—";

  return (
    <section className="flight-card">
      <header className="flight-card-header">
        <div className="flight-route">
          <span className="flight-iata">{fromLabel}</span>
          <span className="flight-arrow">→</span>
          <span className="flight-iata">{toLabel}</span>
        </div>
        <span className={`flight-source-badge ${isLive ? "live" : "estimate"}`}>
          {isLive ? "LIVE" : "ESTIMATE"}
        </span>
      </header>

      <div className="flight-cities">
        {flight.from_city} → {flight.to_city}
        {flight.date && <span className="flight-date"> · {flight.date}</span>}
      </div>

      <div className="flight-stats">
        <div className="flight-stat">
          <div className="flight-stat-value">{priceText}</div>
          <div className="flight-stat-label">price</div>
        </div>
        <div className="flight-stat">
          <div className="flight-stat-value">{formatDuration(flight.duration_min)}</div>
          <div className="flight-stat-label">duration</div>
        </div>
        <div className="flight-stat">
          <div className="flight-stat-value">{stopsText}</div>
          <div className="flight-stat-label">stops</div>
        </div>
      </div>

      {flight.google_flights_url && (
        <a
          href={flight.google_flights_url}
          target="_blank"
          rel="noopener noreferrer"
          className="flight-cta"
        >
          View live prices on Google Flights ↗
        </a>
      )}
    </section>
  );
}
