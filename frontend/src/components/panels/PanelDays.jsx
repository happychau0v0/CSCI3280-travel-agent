import { useState } from "react";
import DayMiniMap from "../DayMiniMap";
import PhotoGallery from "../PhotoGallery";

/**
 * DAYS panel — shares the .panel-grid layout with HOME/FLIGHTS/HOTELS.
 * Left column: vertical list of days with theme + weather icon.
 * Center: DayMiniMap (Leaflet) promoted to fullscreen of the grid
 *         center cell, showing the selected day's route.
 * Right column: activity timeline for the selected day — each row has
 *         a photo gallery, name, description, duration, and a
 *         transport-to-next detail that expands when clicked.
 * Top band: "DAY n · theme · weather".
 */

const WEATHER_ICONS = {
  sunny: "☀️",
  "partly-cloudy": "⛅",
  cloudy: "☁️",
  rainy: "🌧️",
  snowy: "❄️",
  stormy: "⛈️",
};

function weatherIcon(weather) {
  if (!weather) return null;
  const key = (weather.icon || "").toLowerCase();
  return WEATHER_ICONS[key] || "🌡️";
}

// Round 18 — heuristic check: is the weather likely to make outdoor
// activities unpleasant? Returns "rainy" | "snowy" | "stormy" | null.
function badOutdoorWeather(weather) {
  if (!weather) return null;
  const key = (weather.icon || weather.condition || "").toLowerCase();
  if (/rain/.test(key)) return "rainy";
  if (/snow/.test(key)) return "snowy";
  if (/storm|thunder/.test(key)) return "stormy";
  return null;
}

// Activities that sound outdoor-heavy by name. Rough keyword match;
// the LLM doesn't tag indoor vs outdoor so we infer from the name.
function isLikelyOutdoor(activity) {
  const name = (activity.name || "").toLowerCase();
  const desc = (activity.description || "").toLowerCase();
  const blob = `${name} ${desc}`;
  if (/museum|gallery|market|mall|cafe|restaurant|bar|lounge|cinema|theater|theatre|spa|shop|store|indoor/.test(blob)) {
    return false;
  }
  return /park|garden|temple|shrine|beach|hike|trail|tower|bridge|square|plaza|outdoor|viewpoint|waterfall|mountain|lake|river|cruise|walk/.test(blob);
}

function ActivityRow({
  activity,
  index,
  isHotel,
  isAirport,
  isActive,
  isDragTarget,
  expandOverride,
  onClick,
  onDragStart,
  onDragOver,
  onDragLeave,
  onDrop,
  onDragEnd,
  onRemove,
  onReplace,
  onNoteChange,
}) {
  const [expandedLocal, setExpandedLocal] = useState(false);
  // Round 15 — when expandOverride is non-null (from expand/collapse
  // all button), use it and ignore local toggle state.
  const expanded = expandOverride != null ? expandOverride : expandedLocal;
  const setExpanded = (v) => {
    if (expandOverride == null) setExpandedLocal(v);
  };
  const gallery =
    activity.photos?.length > 0
      ? activity.photos
      : activity.photo_url
        ? [activity.photo_url]
        : [];
  const transport = activity.transport_to_next;
  // Round 13 — only non-hotel, non-airport rows are draggable. Hotel
  // bookends and airport activities are anchors the LLM computed;
  // letting the user drag them mid-day would invalidate the day
  // window logic.
  const isDraggable = !isHotel && !isAirport;
  return (
    <li
      className={
        `activity` +
        (isHotel ? " activity-hotel" : "") +
        (isActive ? " activity-active" : "") +
        (isDragTarget ? " activity-drag-target" : "")
      }
      draggable={isDraggable}
      onDragStart={isDraggable ? (e) => onDragStart?.(e, index) : undefined}
      onDragOver={(e) => onDragOver?.(e, index)}
      onDragLeave={(e) => onDragLeave?.(e, index)}
      onDrop={(e) => onDrop?.(e, index)}
      onDragEnd={onDragEnd}
      onClick={() => {
        onClick?.();
        setExpanded((x) => !x);
      }}
      data-testid={`activity-row-${index}`}
    >
      <div className="activity-row">
        <span className="activity-time">{activity.time}</span>
        <div className="activity-info">
          <strong>
            {isHotel && <span className="activity-hotel-tag">🏨 HOTEL </span>}
            {isAirport && <span className="activity-hotel-tag">✈ AIRPORT </span>}
            {activity.name}
          </strong>
          {activity.address && <p className="activity-addr">{activity.address}</p>}
          {activity.description && (
            <p className="activity-desc">{activity.description}</p>
          )}
          {activity.duration_min && (
            <span className="activity-duration">{activity.duration_min} min</span>
          )}
          {transport && (
            <div className={`transport${expanded ? " expanded" : ""}`}>
              → {transport.mode?.toLowerCase?.() || "transit"}:{" "}
              {transport.duration}
              {transport.distance && ` (${transport.distance})`}
              {expanded && transport.steps?.length > 0 && (
                <ol className="transport-steps">
                  {transport.steps.map((step, i) => (
                    <li key={i}>{step.instruction || step}</li>
                  ))}
                </ol>
              )}
            </div>
          )}
        </div>
      </div>
      {gallery.length > 0 && (
        <PhotoGallery photos={gallery} altPrefix={activity.name} maxCount={4} />
      )}
      {expanded && onNoteChange && (
        <div className="activity-note-wrap" onClick={(e) => e.stopPropagation()}>
          <span className="activity-note-label">NOTE</span>
          <input
            type="text"
            className="activity-note-input"
            placeholder="Add a personal note (e.g. reserve ahead)…"
            defaultValue={activity.user_note || ""}
            onBlur={(e) => onNoteChange(index, e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                e.target.blur();
              }
            }}
            data-testid={`activity-note-${index}`}
          />
        </div>
      )}
      {activity.user_note && !expanded && (
        <div className="activity-note-preview">◇ {activity.user_note}</div>
      )}
      {isDraggable && (onRemove || onReplace) && (
        <div
          className="activity-actions"
          onClick={(e) => e.stopPropagation()}
        >
          {onReplace && (
            <button
              type="button"
              className="activity-action-btn"
              onClick={() => onReplace(index)}
              data-testid={`activity-replace-${index}`}
              title="Ask the agent for a similar alternative"
            >
              ↻ REPLACE
            </button>
          )}
          {onRemove && (
            <button
              type="button"
              className="activity-action-btn delete"
              onClick={() => onRemove(index)}
              data-testid={`activity-remove-${index}`}
              aria-label="Remove activity"
            >
              × REMOVE
            </button>
          )}
        </div>
      )}
    </li>
  );
}

export default function PanelDays({
  itinerary,
  listIndex,
  onSelect,
  onReorderActivities,
  onRemoveActivity,
  onReplaceActivity,
  onSetActivityNote,
}) {
  const days = itinerary?.days || [];
  const hotelName =
    itinerary?.selected_hotel?.name || itinerary?.hotels?.[0]?.name || null;
  const [activeActivityIdx, setActiveActivityIdx] = useState(-1);
  // Round 13 — drag state for activity reordering within a day.
  const [dragFromIdx, setDragFromIdx] = useState(-1);
  const [dragOverIdx, setDragOverIdx] = useState(-1);
  // Round 15 — null = per-row local toggle, true = all expanded,
  // false = all collapsed.
  const [expandAllOverride, setExpandAllOverride] = useState(null);

  if (days.length === 0) {
    return (
      <section className="panel panel-grid panel-days" aria-label="Days">
        <div className="panel-grid-empty">
          <h2>NO ITINERARY YET</h2>
          <p>Press T and ask the agent to plan a multi-day trip.</p>
        </div>
      </section>
    );
  }

  const selectedIdx = Math.min(Math.max(0, listIndex), days.length - 1);
  const selected = days[selectedIdx];
  const activities = selected?.activities || [];

  // Round 13 — drag-to-reorder handlers. Only non-hotel, non-airport
  // activities can be dragged. The target row is highlighted via
  // dragOverIdx so the user sees where the drop will land.
  const handleDragStart = (e, idx) => {
    setDragFromIdx(idx);
    e.dataTransfer.effectAllowed = "move";
    // Firefox requires some payload or drag is cancelled.
    e.dataTransfer.setData("text/plain", String(idx));
  };
  const handleDragOver = (e, idx) => {
    if (dragFromIdx < 0) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    if (idx !== dragOverIdx) setDragOverIdx(idx);
  };
  const handleDragLeave = (e, idx) => {
    if (idx === dragOverIdx) setDragOverIdx(-1);
  };
  const handleDrop = (e, toIdx) => {
    if (dragFromIdx < 0 || dragFromIdx === toIdx) {
      setDragFromIdx(-1);
      setDragOverIdx(-1);
      return;
    }
    e.preventDefault();
    const fromIdx = dragFromIdx;
    setDragFromIdx(-1);
    setDragOverIdx(-1);
    onReorderActivities?.(selectedIdx, fromIdx, toIdx);
  };
  const handleDragEnd = () => {
    setDragFromIdx(-1);
    setDragOverIdx(-1);
  };

  // Airport reference pin — shown on Day 1 (arrival) and the last
  // day (departure). Both use the destination airport (to_lat/to_lng)
  // because the user arrives there on Day 1 and flies out of the same
  // physical airport on the last day. Middle days get no airport pin.
  const isFirstDay = selectedIdx === 0;
  const isLastDay = days.length > 1 && selectedIdx === days.length - 1;
  const airportPin =
    (isFirstDay || isLastDay) &&
    itinerary?.flight?.to_lat != null &&
    itinerary?.flight?.to_lng != null
      ? {
          lat: itinerary.flight.to_lat,
          lng: itinerary.flight.to_lng,
          iata: itinerary.flight.to_iata,
          label: `${itinerary.flight.to_iata || ""} Airport`.trim(),
        }
      : null;

  return (
    <section className="panel panel-grid panel-days" aria-label="Days">
      {/* TOP band — day summary + R15 forecast strip */}
      <header className="panel-grid-top-band home-summary-top">
        <div className="home-card-label">
          📅 DAY {selected?.day} · {selected?.theme || "—"}
        </div>
        <div className="home-summary-line">
          {selected?.date && (
            <span className="home-summary-meta">{selected.date}</span>
          )}
          {selected?.weather && (
            <>
              {" · "}
              <span>{weatherIcon(selected.weather)}</span>{" "}
              {selected.weather.condition}
              {selected.weather.temp_c != null && (
                <> · {Math.round(selected.weather.temp_c)}°C</>
              )}
            </>
          )}
          {" · "}
          <strong>{activities.length}</strong>
          <span className="home-summary-meta"> stops</span>
          <span className="day-expand-controls">
            <button
              type="button"
              className={`day-expand-chip${expandAllOverride === true ? " active" : ""}`}
              onClick={() => setExpandAllOverride(expandAllOverride === true ? null : true)}
              data-testid="day-expand-all"
            >
              EXPAND ALL
            </button>
            <button
              type="button"
              className={`day-expand-chip${expandAllOverride === false ? " active" : ""}`}
              onClick={() => setExpandAllOverride(expandAllOverride === false ? null : false)}
              data-testid="day-collapse-all"
            >
              COLLAPSE
            </button>
          </span>
        </div>
        {days.some((d) => d.weather) && (
          <div className="day-forecast-strip" data-testid="day-forecast-strip">
            {days.map((d, i) => (
              <button
                key={`forecast-${i}`}
                type="button"
                className={`day-forecast-cell${i === selectedIdx ? " active" : ""}`}
                onClick={() => onSelect?.(i)}
                data-testid={`day-forecast-${i}`}
                title={`${d.theme || ""} · ${d.weather?.condition || ""}`}
              >
                <span className="day-forecast-num">D{d.day}</span>
                <span className="day-forecast-icon">
                  {d.weather ? weatherIcon(d.weather) : "—"}
                </span>
                {d.weather?.temp_c != null && (
                  <span className="day-forecast-temp">
                    {Math.round(d.weather.temp_c)}°
                  </span>
                )}
              </button>
            ))}
          </div>
        )}
      </header>

      {/* LEFT — day list */}
      <div className="panel-grid-left panel-grid-scroll">
        <ul className="panel-list-items">
          {days.map((day, i) => (
            <li
              key={day.day}
              className={
                `panel-list-item` + (i === selectedIdx ? " active" : "")
              }
              onClick={() => {
                onSelect?.(i);
                setActiveActivityIdx(-1);
              }}
              data-testid={`day-option-${i}`}
            >
              <span className="panel-list-label">
                DAY {day.day}
                {day.date && ` · ${day.date}`}
              </span>
              <span className="panel-list-value">{day.theme || "—"}</span>
              <span className="day-option-meta">
                {(day.activities || []).length} stops
                {day.weather?.icon && <> · {weatherIcon(day.weather)}</>}
              </span>
            </li>
          ))}
        </ul>
      </div>

      {/* CENTER — mini-map of the selected day. The map renders in
       *  the center grid cell with pointer-events auto so the user
       *  can interact with it. */}
      <div className="panel-grid-center panel-day-map-center" data-testid="day-map-center">
        <DayMiniMap activities={activities} airport={airportPin} />
      </div>

      {/* RIGHT — activity timeline + R17 phrasebook + R18 weather hint */}
      <aside className="panel-grid-right panel-grid-scroll day-detail-card">
        {(() => {
          const bad = badOutdoorWeather(selected?.weather);
          if (!bad) return null;
          const outdoors = (activities || []).filter(isLikelyOutdoor);
          if (outdoors.length === 0) return null;
          return (
            <div
              className="day-weather-hint"
              data-testid="day-weather-hint"
              role="note"
            >
              <strong>⚠ {bad.toUpperCase()} FORECAST</strong>
              <p>
                {outdoors.length} outdoor activit{outdoors.length === 1 ? "y" : "ies"}{" "}
                on this day ({outdoors.map((a) => a.name).slice(0, 2).join(", ")}
                {outdoors.length > 2 && ", …"}). Consider the REPLACE button to
                swap for an indoor alternative, or plan for an umbrella.
              </p>
            </div>
          );
        })()}
        {itinerary?.phrasebook && (
          <div className="day-phrasebook" data-testid="day-phrasebook">
            <div className="day-phrasebook-header">
              ◢ {itinerary.phrasebook.language?.toUpperCase() || "PHRASEBOOK"}
            </div>
            <ul className="day-phrasebook-list">
              {(itinerary.phrasebook.phrases || []).slice(0, 10).map((p, i) => (
                <li key={p.key || i} className="day-phrasebook-row">
                  <span className="day-phrasebook-en">{p.english}</span>
                  <span className="day-phrasebook-rom">{p.romanized}</span>
                  {p.native && p.native !== p.romanized && (
                    <span className="day-phrasebook-native">{p.native}</span>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}
        <ol className="activities">
          {activities.map((act, i) => (
            <ActivityRow
              key={`${selectedIdx}-${i}-${act.name || ""}`}
              activity={act}
              index={i}
              isHotel={hotelName && act.name === hotelName}
              isAirport={/airport/i.test(act.name || "")}
              isActive={i === activeActivityIdx}
              isDragTarget={i === dragOverIdx && dragFromIdx !== i}
              expandOverride={expandAllOverride}
              onClick={() => setActiveActivityIdx(i)}
              onDragStart={handleDragStart}
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              onDrop={handleDrop}
              onDragEnd={handleDragEnd}
              onRemove={onRemoveActivity ? (idx) => onRemoveActivity(selectedIdx, idx) : null}
              onReplace={onReplaceActivity ? (idx) => onReplaceActivity(selectedIdx, idx) : null}
              onNoteChange={onSetActivityNote ? (idx, note) => onSetActivityNote(selectedIdx, idx, note) : null}
            />
          ))}
        </ol>
      </aside>
    </section>
  );
}
