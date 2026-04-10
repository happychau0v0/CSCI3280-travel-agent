/**
 * Renders the flight section at the top of the itinerary drawer.
 *
 * If `flight.options` is present (round-5 schema), shows a horizontal
 * scroller of mini-cards with non-stop + 1-stop alternatives. Otherwise
 * falls back to the single-card layout for backwards compatibility with
 * cached itineraries from earlier rounds.
 *
 * Currency is HKD throughout.
 */
function formatDuration(min) {
  if (!min) return "—";
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

function formatHKD(amount) {
  if (amount == null) return "—";
  return `HK$${amount.toLocaleString("en-HK")}`;
}

function stopsLabel(stops) {
  if (stops === 0) return "non-stop";
  if (stops === 1) return "1 stop";
  return `${stops} stops`;
}

export default function FlightCard({ flight }) {
  if (!flight) return null;

  const isLive = flight.source === "fast-flights";
  const fromLabel = flight.from_iata || flight.from_city || "—";
  const toLabel = flight.to_iata || flight.to_city || "—";

  // Prefer the new options array; fall back to the flat fields for old data
  const options =
    flight.options && flight.options.length > 0
      ? flight.options
      : [
          {
            type: "non-stop",
            label: "Non-stop",
            price_low: flight.estimate_low,
            price_high: flight.estimate_high,
            duration_min: flight.duration_min,
            stops: flight.stops_typical || 0,
            recommended: true,
          },
        ];

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

      <div className="flight-options-scroller">
        {options.map((opt, i) => (
          <div
            key={i}
            className={`flight-option${opt.recommended ? " recommended" : ""}`}
          >
            <div className="flight-option-header">
              <span className="flight-option-label">{opt.label || stopsLabel(opt.stops)}</span>
              {opt.recommended && (
                <span className="flight-option-badge">BEST</span>
              )}
            </div>
            <div className="flight-option-price">
              {formatHKD(opt.price_low)}
              <span className="flight-option-price-sep">–</span>
              {formatHKD(opt.price_high)}
            </div>
            <div className="flight-option-meta">
              <span>{formatDuration(opt.duration_min)}</span>
              <span className="flight-option-dot">·</span>
              <span>{stopsLabel(opt.stops)}</span>
            </div>
          </div>
        ))}
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
