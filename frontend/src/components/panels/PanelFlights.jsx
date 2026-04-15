import { useState, useEffect } from "react";
import { formatDisplayPrice } from "../SettingsOverlay";
import VisaAlertBanner from "../VisaAlertBanner";

/**
 * FLIGHTS panel — shares the .panel-grid layout with HOME/HOTELS/DAYS.
 * Left column: vertical list of flight options with airline + price.
 * Center: reserved for the globe (background behind the grid) — the
 * flight's arc is drawn by App.jsx's arcs memo.
 * Right column: detail card for the focused option with big airline,
 * price, duration, PICK button, Google Flights link.
 * Top band: summary "HKG → NRT · N options".
 *
 * Round 14 — currency prop controls the displayed currency, backed
 * by a fixed rate table in SettingsOverlay. Backend always returns
 * HKD; the frontend re-labels.
 *
 * Round N — outbound/return tab strip when return_options are present;
 * stop cities shown in STOPS DETAIL.
 */

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

/** Always-visible depart→arrive string with em-dash fallbacks.
 * Appends "+1" when the arrival appears to be the next day
 * (arrival time numerically earlier than departure, which happens
 * on long-haul overnight flights). */
function formatTimeRange(opt) {
  const dep = opt?.departure_time || "—";
  const arr = opt?.arrival_time || "—";
  let suffix = "";
  if (dep !== "—" && arr !== "—" && opt?.duration_min > 0) {
    const [dh, dm] = dep.split(":").map(Number);
    const [ah, am] = arr.split(":").map(Number);
    const depMin = dh * 60 + dm;
    const arrMin = ah * 60 + am;
    if (arrMin <= depMin && opt.duration_min > 120) {
      suffix = "+1";
    }
  }
  return `${dep} → ${arr}${suffix}`;
}

export default function PanelFlights({
  itinerary,
  listIndex,
  currency = "HKD",
  visaAlert = null,
  side = "left",
  isLoading = false,
  onSelect,
  onPick,
  onSkipFlight,
}) {
  const formatPrice = (n) => formatDisplayPrice(n, currency);
  const flight = itinerary?.flight;
  const outboundOptions = flight?.options || [];
  const returnOptions = flight?.return_options || [];
  const hasReturn = returnOptions.length > 0;

  // Tab state — only relevant when return_options are present
  const [activeTab, setActiveTab] = useState("outbound");

  // Auto-advance to RETURN tab when outbound is picked and return options exist
  useEffect(() => {
    if (itinerary?.selected_flight && hasReturn && activeTab === "outbound") {
      setActiveTab("return");
    }
  }, [itinerary?.selected_flight]); // eslint-disable-line react-hooks/exhaustive-deps

  const options = activeTab === "return" ? returnOptions : outboundOptions;

  if (!flight || outboundOptions.length === 0) {
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
  const picked = activeTab === "return"
    ? itinerary?.selected_return_flight
    : itinerary?.selected_flight;
  const pickedIdx = picked
    ? options.findIndex(
        (o) =>
          o === picked ||
          (o.label === picked.label && o.airline === picked.airline),
      )
    : -1;

  // Route label swaps for return tab
  const fromLabel = activeTab === "return"
    ? (flight.to_city || flight.to_iata)
    : (flight.from_city || flight.from_iata);
  const toLabel = activeTab === "return"
    ? (flight.from_city || flight.from_iata)
    : (flight.to_city || flight.to_iata);
  const fromIata = activeTab === "return" ? flight.to_iata : flight.from_iata;
  const toIata = activeTab === "return" ? flight.from_iata : flight.to_iata;
  const fromName = activeTab === "return"
    ? (flight.to_name || `${flight.to_city} Airport`)
    : (flight.from_name || `${flight.from_city} Airport`);
  const toName = activeTab === "return"
    ? (flight.from_name || `${flight.from_city} Airport`)
    : (flight.to_name || `${flight.to_city} Airport`);
  const legDate = activeTab === "return" ? (flight.return_date || "—") : (flight.date || "—");

  return (
    <section className={`panel panel-grid panel-flights side-focus-${side}`} aria-label="Flights">
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
          <VisaAlertBanner visaAlert={visaAlert} />
          {flight.seat_class_label && flight.seat_class !== "economy" && (
            <span
              className="flight-source-badge"
              style={{ marginLeft: 8, background: "rgba(251, 191, 36, 0.15)", color: "#fbbf24" }}
            >
              {flight.seat_class_label.toUpperCase()}
            </span>
          )}
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

        {/* Outbound / Return tab strip — only when return_options exist */}
        {hasReturn && (
          <div className="flight-tab-strip" role="tablist" aria-label="Flight direction">
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === "outbound"}
              className={`flight-tab${activeTab === "outbound" ? " active" : ""}`}
              onClick={() => setActiveTab("outbound")}
              data-testid="flight-tab-outbound"
            >
              ✈ {flight.from_iata} → {flight.to_iata}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === "return"}
              className={`flight-tab${activeTab === "return" ? " active" : ""}`}
              onClick={() => setActiveTab("return")}
              data-testid="flight-tab-return"
            >
              ✈ {flight.to_iata} → {flight.from_iata}
            </button>
          </div>
        )}
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
                {(opt.airline || opt.flight_number) && (
                  <span style={{ color: "var(--text-dim)", marginRight: 6 }}>
                    {opt.flight_number && (
                      <strong style={{ marginRight: 4 }}>{opt.flight_number}</strong>
                    )}
                    {opt.airline}
                  </span>
                )}
                {formatPrice(opt.price_low)}
              </span>
              <span className="flight-option-meta">
                {opt.duration_min ? formatDuration(opt.duration_min) : "—"}
                {" · "}
                {formatTimeRange(opt)}
              </span>
            </li>
          ))}
        </ul>
      </div>

      {/* RIGHT — detail card for the focused option */}
      <aside className="panel-grid-right panel-grid-scroll flight-detail-card">
        {selected && (
          <>
            {/* Route header */}
            <div className="flight-route-header">
              <span>{fromLabel}</span>
              <span className="flight-route-arrow"> → </span>
              <span>{toLabel}</span>
            </div>
            <div className="flight-route-meta">
              {legDate} · {formatDuration(selected.duration_min)} · {stopsLabel(selected.stops)}
            </div>

            {/* Timeline: departure → arrival */}
            <div className="flight-timeline">
              <div className="flight-timeline-row">
                <div className="flight-timeline-time">{selected.departure_time || "—"}</div>
                <div className="flight-timeline-dot" />
                <div className="flight-timeline-info">
                  {fromIata} {fromName}
                </div>
              </div>
              <div className="flight-timeline-line">
                <div className="flight-timeline-airline">
                  {selected.flight_number && (
                    <strong style={{ marginRight: 6 }}>{selected.flight_number}</strong>
                  )}
                  {selected.airline || "—"} · {selected.seat_class_label || "Economy"}
                </div>
                {selected.stops > 0 && selected.stop_cities?.length > 0 && (
                  <div className="flight-timeline-stops">
                    via {selected.stop_cities.join(" → ")}
                  </div>
                )}
              </div>
              <div className="flight-timeline-row">
                <div className="flight-timeline-time">
                  {selected.arrival_time || "—"}
                  {selected.next_day_arrival && (
                    <sup title="Arrives the following calendar day" style={{ fontSize: "0.65em", marginLeft: 2, color: "var(--accent)" }}>+1</sup>
                  )}
                </div>
                <div className="flight-timeline-dot" />
                <div className="flight-timeline-info">
                  {toIata} {toName}
                </div>
              </div>
            </div>

            {/* Price */}
            <div className="flight-detail-price">
              {formatPrice(selected.price_low)}
              {selected.price_high &&
                selected.price_high !== selected.price_low && (
                  <span className="flight-detail-price-range">
                    {" "}– {formatPrice(selected.price_high)}
                  </span>
                )}
            </div>

            <button
              type="button"
              className="trip-plan-btn"
              onClick={() => onPick?.(selectedIdx, activeTab)}
              disabled={isLoading || selectedIdx === pickedIdx}
              data-testid="flight-pick-btn"
              style={{ marginTop: 16 }}
            >
              {selectedIdx === pickedIdx
                ? "✓ PICKED"
                : activeTab === "return"
                  ? "PICK RETURN & FIND HOTELS →"
                  : hasReturn
                    ? "PICK OUTBOUND →"
                    : "PICK & FIND HOTELS →"}
            </button>

            {(() => {
              // Use the backend-provided deep link (includes correct dates).
              // Fall back to a constructed URL that includes dates if available.
              const flightDate = activeTab === "return" ? (flight.return_date || flight.date) : flight.date;
              const retDate = activeTab === "return" ? flight.date : flight.return_date;
              const dateQ = flightDate ? `+on+${encodeURIComponent(flightDate)}` : "";
              const retQ = retDate ? `+return+${encodeURIComponent(retDate)}` : "";
              const tripType = retDate ? "round+trip+flights" : "Flights";
              const gUrl = flight.google_flights_url
                || `https://www.google.com/travel/flights?q=${tripType}+from+${encodeURIComponent(fromIata)}+to+${encodeURIComponent(toIata)}${dateQ}${retQ}`;
              return (
                <a
                  href={gUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flight-cta"
                  style={{ marginTop: 12 }}
                >
                  View live prices on Google Flights ↗
                </a>
              );
            })()}
            {onSkipFlight && (
              <button
                type="button"
                className="flight-skip-btn"
                onClick={onSkipFlight}
                data-testid="flight-skip-btn"
                title="Skip flight selection — useful for short trips with ground transport"
              >
                Skip — no flight needed
              </button>
            )}
          </>
        )}
      </aside>

      {/* BOTTOM band — stops detail and alternate airports */}
      {(() => {
        const altFrom = (flight.from_alternates || []).slice(0, 3);
        const altTo = (flight.to_alternates || []).slice(0, 3);
        const hasStops = selected && selected.stops > 0;
        const hasAlts = altFrom.length > 0 || altTo.length > 0;
        if (!hasStops && !hasAlts) return null;
        return (
          <footer className="panel-grid-bottom-band home-summary-top">
            {hasStops && (
              <>
                <div className="home-card-label">STOPS DETAIL</div>
                <div className="home-summary-line">
                  {selected.stop_cities?.length > 0
                    ? <>via <strong>{selected.stop_cities.join(" → ")}</strong> · total <strong>{formatDuration(selected.duration_min)}</strong></>
                    : <>{selected.stops} {selected.stops === 1 ? "stop" : "stops"} · total <strong>{formatDuration(selected.duration_min)}</strong></>
                  }
                </div>
              </>
            )}
            {hasAlts && (
              <>
                <div className="home-card-label" style={{ marginTop: hasStops ? 8 : 0 }}>
                  ALSO NEARBY
                </div>
                <div className="home-summary-line" style={{ fontSize: 11 }}>
                  {altFrom.length > 0 && (
                    <>
                      From {flight.from_iata}:{" "}
                      {altFrom.map((a) => `${a.iata} (${a.km_from_primary}km)`).join(", ")}
                      {altTo.length > 0 && <span> · </span>}
                    </>
                  )}
                  {altTo.length > 0 && (
                    <>
                      To {flight.to_iata}:{" "}
                      {altTo.map((a) => `${a.iata} (${a.km_from_primary}km)`).join(", ")}
                    </>
                  )}
                </div>
              </>
            )}
          </footer>
        );
      })()}
    </section>
  );
}
