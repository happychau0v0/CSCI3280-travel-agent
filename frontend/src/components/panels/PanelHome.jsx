/**
 * HOME dashboard — combines MAP / TRIP summary / FLIGHT / HOTELS into a
 * single HUD-style landing screen with the globe centered behind. Four
 * corner cards summarize the current state, each clickable to drill
 * into the relevant detail tab.
 *
 * Layout:
 *   ┌──────────┐                  ┌──────────┐
 *   │ LIVE     │                  │ NEXT TRIP│
 *   └──────────┘                  └──────────┘
 *               (globe in middle)
 *   ┌──────────┐                  ┌──────────┐
 *   │ FLIGHT   │                  │ HOTELS   │
 *   └──────────┘                  └──────────┘
 */

const PRICE_LEVEL_LABELS = {
  PRICE_LEVEL_INEXPENSIVE: "$",
  PRICE_LEVEL_MODERATE: "$$",
  PRICE_LEVEL_EXPENSIVE: "$$$",
  PRICE_LEVEL_VERY_EXPENSIVE: "$$$$",
};

function formatHKD(n) {
  if (n == null) return "—";
  return `HK$${n.toLocaleString("en-HK")}`;
}

export default function PanelHome({
  itinerary,
  userLocation,
  agentState = "idle",
  currentTool = null,
  onJumpTo,
}) {
  const flight = itinerary?.flight;
  const hotels = itinerary?.hotels || [];
  const days = itinerary?.days || [];
  const topHotel = hotels[0];

  return (
    <section className="panel panel-home" aria-label="Home dashboard">
      {/* TOP-LEFT — live status */}
      <button
        type="button"
        className={`home-card home-card-tl agent-${agentState}`}
        onClick={() => onJumpTo?.("HOME")}
      >
        <div className="home-card-label">📍 LIVE</div>
        <div className="home-card-value">
          {userLocation?.city || "Locating…"}
        </div>
        <div className="home-card-sub">
          {agentState === "working"
            ? `AGENT WORKING${currentTool ? ` · ${currentTool}` : ""}`
            : agentState === "error"
              ? "AGENT ERROR"
              : "AGENT IDLE"}
        </div>
      </button>

      {/* TOP-RIGHT — next trip summary */}
      <button
        type="button"
        className="home-card home-card-tr"
        onClick={() => onJumpTo?.("TRIP")}
      >
        <div className="home-card-label">🌏 NEXT TRIP</div>
        {itinerary?.destination ? (
          <>
            <div className="home-card-value">
              {itinerary.origin || userLocation?.city || "—"} → {itinerary.destination}
            </div>
            <div className="home-card-sub">
              {days.length > 0
                ? `${days.length} day${days.length !== 1 ? "s" : ""}`
                : "Not yet planned"}
            </div>
          </>
        ) : (
          <>
            <div className="home-card-value home-card-empty">PLAN A TRIP →</div>
            <div className="home-card-sub">Press 2 or click here</div>
          </>
        )}
      </button>

      {/* BOTTOM-LEFT — flight summary */}
      <button
        type="button"
        className="home-card home-card-bl"
        onClick={() => onJumpTo?.("FLIGHTS")}
      >
        <div className="home-card-label">✈ FLIGHT</div>
        {flight ? (
          <>
            <div className="home-card-value">
              {flight.from_iata} → {flight.to_iata}
            </div>
            <div className="home-card-sub">
              {flight.options?.[0] ? formatHKD(flight.options[0].price_low) : "—"}
              {flight.source === "fast-flights" && (
                <span style={{ marginLeft: 8, color: "#5eead4" }}>● LIVE</span>
              )}
            </div>
          </>
        ) : (
          <>
            <div className="home-card-value home-card-empty">—</div>
            <div className="home-card-sub">No flight yet</div>
          </>
        )}
      </button>

      {/* BOTTOM-RIGHT — hotels summary */}
      <button
        type="button"
        className="home-card home-card-br"
        onClick={() => onJumpTo?.("HOTELS")}
      >
        <div className="home-card-label">🏨 HOTELS ({hotels.length})</div>
        {topHotel ? (
          <>
            <div className="home-card-value">{topHotel.name}</div>
            <div className="home-card-sub">
              {topHotel.rating != null && (
                <span style={{ color: "#fbbf24", marginRight: 8 }}>
                  ★ {topHotel.rating.toFixed(1)}
                </span>
              )}
              {PRICE_LEVEL_LABELS[topHotel.price_level] && (
                <span style={{ color: "var(--accent)" }}>
                  {PRICE_LEVEL_LABELS[topHotel.price_level]}
                </span>
              )}
            </div>
          </>
        ) : (
          <>
            <div className="home-card-value home-card-empty">—</div>
            <div className="home-card-sub">No hotels yet</div>
          </>
        )}
      </button>
    </section>
  );
}
