/**
 * FLIGHTS panel — left list of flight options, right detail for the
 * selected one. Reads itinerary.flight.options and respects listIndex
 * for the active item (driven by ↑/↓ via useKeyboard).
 */

function formatHKD(n) {
  if (n == null) return "—";
  return `HK$${n.toLocaleString("en-HK")}`;
}

function formatDuration(min) {
  if (!min) return "—";
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

function stopsLabel(stops) {
  if (stops === 0) return "non-stop";
  if (stops === 1) return "1 stop";
  return `${stops} stops`;
}

export default function PanelFlights({ itinerary, listIndex, onSelect }) {
  const flight = itinerary?.flight;
  const options = flight?.options || [];

  if (!flight || options.length === 0) {
    return (
      <section className="panel panel-list" aria-label="Flights">
        <div className="panel-empty">
          <h2>NO FLIGHTS YET</h2>
          <p>Press Enter and ask the agent to plan a trip with flights.</p>
        </div>
      </section>
    );
  }

  const selectedIdx = Math.min(listIndex, options.length - 1);
  const selected = options[selectedIdx];
  const isLive = flight.source === "fast-flights";

  return (
    <section className="panel panel-list" aria-label="Flights">
      <ul className="panel-list-items">
        {options.map((opt, i) => (
          <li
            key={i}
            className={`panel-list-item${i === selectedIdx ? " active" : ""}`}
            onClick={() => onSelect?.(i)}
          >
            <span className="panel-list-label">
              {opt.label || stopsLabel(opt.stops)}
            </span>
            <span className="panel-list-value">
              {formatHKD(opt.price_low)}
              {opt.price_high && opt.price_high !== opt.price_low && (
                <span style={{ color: "var(--text-dim)" }}>
                  {" "}
                  – {formatHKD(opt.price_high)}
                </span>
              )}
            </span>
          </li>
        ))}
      </ul>
      <div className="panel-detail">
        <div className="panel-detail-label">
          {flight.from_iata} → {flight.to_iata}
          <span
            className={`flight-source-badge ${isLive ? "live" : "estimate"}`}
            style={{ marginLeft: 8 }}
          >
            {isLive ? "LIVE" : "ESTIMATE"}
          </span>
        </div>

        {selected && (
          <>
            <div style={{ fontSize: 28, fontWeight: 700, color: "var(--text-h)", marginBottom: 4 }}>
              {selected.airline || selected.label || stopsLabel(selected.stops)}
            </div>
            <div style={{ fontSize: 22, color: "var(--accent)", fontWeight: 700, marginBottom: 16 }}>
              {formatHKD(selected.price_low)}
              {selected.price_high && selected.price_high !== selected.price_low && (
                <span style={{ color: "var(--text-dim)", fontSize: 16 }}>
                  {" "}
                  – {formatHKD(selected.price_high)}
                </span>
              )}
            </div>
            <div className="flight-stats">
              <div className="flight-stat">
                <div className="flight-stat-value">{formatDuration(selected.duration_min)}</div>
                <div className="flight-stat-label">duration</div>
              </div>
              <div className="flight-stat">
                <div className="flight-stat-value">{stopsLabel(selected.stops)}</div>
                <div className="flight-stat-label">stops</div>
              </div>
              <div className="flight-stat">
                <div className="flight-stat-value">{flight.distance_km || "—"} km</div>
                <div className="flight-stat-label">distance</div>
              </div>
            </div>

            {flight.google_flights_url && (
              <a
                href={flight.google_flights_url}
                target="_blank"
                rel="noopener noreferrer"
                className="flight-cta"
                style={{ marginTop: 16 }}
              >
                View live prices on Google Flights ↗
              </a>
            )}
          </>
        )}
      </div>
    </section>
  );
}
