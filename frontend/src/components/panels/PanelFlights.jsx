/**
 * FLIGHTS panel — shares the .panel-grid layout with HOME/HOTELS/DAYS.
 * Left column: vertical list of flight options with airline + price.
 * Center: reserved for the globe (background behind the grid) — the
 * flight's arc is drawn by App.jsx's arcs memo.
 * Right column: detail card for the focused option with big airline,
 * price, duration, PICK button, Google Flights link.
 * Top band: summary "HKG → NRT · N options".
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

export default function PanelFlights({ itinerary, listIndex, onSelect, onPick }) {
  const flight = itinerary?.flight;
  const options = flight?.options || [];

  if (!flight || options.length === 0) {
    return (
      <section className="panel panel-grid panel-flights" aria-label="Flights">
        <div className="panel-grid-empty">
          <h2>NO FLIGHTS YET</h2>
          <p>Fill the PLAN form and press START PLANNING to fetch flights.</p>
        </div>
      </section>
    );
  }

  const selectedIdx = Math.min(Math.max(0, listIndex), options.length - 1);
  const selected = options[selectedIdx];
  const isLive = flight.source === "fast-flights";
  const picked = itinerary?.selected_flight;
  const pickedIdx = picked
    ? options.findIndex(
        (o) =>
          o === picked ||
          (o.label === picked.label && o.airline === picked.airline),
      )
    : -1;

  return (
    <section className="panel panel-grid panel-flights" aria-label="Flights">
      {/* TOP band — route summary */}
      <header className="panel-grid-top-band home-summary-top">
        <div className="home-card-label">
          ✈ FLIGHT · {flight.from_iata} → {flight.to_iata}
          <span
            className={`flight-source-badge ${isLive ? "live" : "estimate"}`}
            style={{ marginLeft: 8 }}
          >
            {isLive ? "LIVE" : "ESTIMATE"}
          </span>
        </div>
        <div className="home-summary-line">
          <strong>{options.length}</strong>
          <span className="home-summary-meta"> options</span>
          {pickedIdx >= 0 && (
            <span className="home-summary-meta">
              {" "}· picked <strong>{options[pickedIdx].airline}</strong>
            </span>
          )}
        </div>
      </header>

      {/* LEFT — options list */}
      <div className="panel-grid-left panel-grid-scroll">
        <ul className="panel-list-items">
          {options.map((opt, i) => (
            <li
              key={i}
              className={
                `panel-list-item flight-option-row` +
                (i === selectedIdx ? " active" : "") +
                (i === pickedIdx ? " picked" : "")
              }
              onClick={() => onSelect?.(i)}
              data-testid={`flight-option-${i}`}
            >
              <span className="panel-list-label">
                {opt.label || stopsLabel(opt.stops)}
                {i === pickedIdx && (
                  <span className="panel-list-picked-tag"> ✓ PICKED</span>
                )}
              </span>
              <span className="panel-list-value">
                {opt.airline && (
                  <span style={{ color: "var(--text-dim)", marginRight: 6 }}>
                    {opt.airline}
                  </span>
                )}
                {formatHKD(opt.price_low)}
              </span>
              <span className="flight-option-meta">
                {opt.duration_min ? formatDuration(opt.duration_min) : "—"}
                {opt.departure_time && opt.arrival_time && (
                  <>
                    {" · "}
                    {opt.departure_time} → {opt.arrival_time}
                  </>
                )}
              </span>
            </li>
          ))}
        </ul>
      </div>

      {/* RIGHT — detail card for the focused option */}
      <aside className="panel-grid-right panel-grid-scroll flight-detail-card">
        {selected && (
          <>
            <div className="flight-detail-airline">
              {selected.airline || selected.label || stopsLabel(selected.stops)}
            </div>
            <div className="flight-detail-price">
              {formatHKD(selected.price_low)}
              {selected.price_high &&
                selected.price_high !== selected.price_low && (
                  <span className="flight-detail-price-range">
                    {" "}– {formatHKD(selected.price_high)}
                  </span>
                )}
            </div>

            <div className="flight-stats">
              <div className="flight-stat">
                <div className="flight-stat-value">
                  {formatDuration(selected.duration_min)}
                </div>
                <div className="flight-stat-label">duration</div>
              </div>
              <div className="flight-stat">
                <div className="flight-stat-value">
                  {stopsLabel(selected.stops)}
                </div>
                <div className="flight-stat-label">stops</div>
              </div>
              {selected.departure_time && (
                <div className="flight-stat">
                  <div className="flight-stat-value">
                    {selected.departure_time}
                  </div>
                  <div className="flight-stat-label">depart</div>
                </div>
              )}
              {selected.arrival_time && (
                <div className="flight-stat">
                  <div className="flight-stat-value">
                    {selected.arrival_time}
                  </div>
                  <div className="flight-stat-label">arrive</div>
                </div>
              )}
            </div>

            <button
              type="button"
              className="trip-plan-btn"
              onClick={() => onPick?.(selectedIdx)}
              disabled={selectedIdx === pickedIdx}
              data-testid="flight-pick-btn"
              style={{ marginTop: 16 }}
            >
              {selectedIdx === pickedIdx ? "✓ PICKED" : "PICK THIS FLIGHT →"}
            </button>

            {flight.google_flights_url && (
              <a
                href={flight.google_flights_url}
                target="_blank"
                rel="noopener noreferrer"
                className="flight-cta"
                style={{ marginTop: 12 }}
              >
                View live prices on Google Flights ↗
              </a>
            )}
          </>
        )}
      </aside>

      {/* BOTTOM band — stops detail when >0 stops */}
      {selected && selected.stops > 0 && (
        <footer className="panel-grid-bottom-band home-summary-top">
          <div className="home-card-label">STOPS DETAIL</div>
          <div className="home-summary-line">
            {selected.stops} {selected.stops === 1 ? "stop" : "stops"} · total{" "}
            <strong>{formatDuration(selected.duration_min)}</strong>
          </div>
        </footer>
      )}
    </section>
  );
}
