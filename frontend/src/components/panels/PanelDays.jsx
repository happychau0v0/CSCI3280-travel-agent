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

function ActivityRow({ activity, isHotel, isActive, onClick }) {
  const [expanded, setExpanded] = useState(false);
  const gallery =
    activity.photos?.length > 0
      ? activity.photos
      : activity.photo_url
        ? [activity.photo_url]
        : [];
  const transport = activity.transport_to_next;
  return (
    <li
      className={
        `activity` +
        (isHotel ? " activity-hotel" : "") +
        (isActive ? " activity-active" : "")
      }
      onClick={() => {
        onClick?.();
        setExpanded((x) => !x);
      }}
    >
      <div className="activity-row">
        <span className="activity-time">{activity.time}</span>
        <div className="activity-info">
          <strong>
            {isHotel && <span className="activity-hotel-tag">🏨 HOTEL </span>}
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
    </li>
  );
}

export default function PanelDays({ itinerary, listIndex, onSelect }) {
  const days = itinerary?.days || [];
  const hotelName =
    itinerary?.selected_hotel?.name || itinerary?.hotels?.[0]?.name || null;
  const [activeActivityIdx, setActiveActivityIdx] = useState(-1);

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
      {/* TOP band — day summary */}
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
        </div>
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

      {/* RIGHT — activity timeline */}
      <aside className="panel-grid-right panel-grid-scroll day-detail-card">
        <ol className="activities">
          {activities.map((act, i) => (
            <ActivityRow
              key={i}
              activity={act}
              isHotel={hotelName && act.name === hotelName}
              isActive={i === activeActivityIdx}
              onClick={() => setActiveActivityIdx(i)}
            />
          ))}
        </ol>
      </aside>
    </section>
  );
}
