import { photoSrc } from "../../api/client";
import DayMiniMap from "../DayMiniMap";

/**
 * DAYS panel — left list of days, right detail showing the selected
 * day's weather, mini-map, and activity timeline.
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

export default function PanelDays({ itinerary, listIndex, onSelect }) {
  const days = itinerary?.days || [];
  const hotelName = itinerary?.selected_hotel?.name || itinerary?.hotels?.[0]?.name || null;

  if (days.length === 0) {
    return (
      <section className="panel panel-list" aria-label="Days">
        <div className="panel-empty">
          <h2>NO ITINERARY YET</h2>
          <p>Press T and ask the agent to plan a multi-day trip.</p>
        </div>
      </section>
    );
  }

  const selectedIdx = Math.min(listIndex, days.length - 1);
  const selected = days[selectedIdx];

  return (
    <section className="panel panel-list" aria-label="Days">
      <ul className="panel-list-items">
        {days.map((day, i) => (
          <li
            key={day.day}
            className={`panel-list-item${i === selectedIdx ? " active" : ""}`}
            onClick={() => onSelect?.(i)}
          >
            <span className="panel-list-label">DAY {day.day}{day.date && ` · ${day.date}`}</span>
            <span className="panel-list-value">{day.theme || "—"}</span>
          </li>
        ))}
      </ul>
      <div className="panel-detail panel-day-detail">
        {selected && (
          <>
            <div className="panel-detail-label">
              DAY {selected.day}
              {selected.date && <span> · {selected.date}</span>}
            </div>
            <div style={{ fontSize: 18, fontWeight: 700, color: "var(--text-h)", marginBottom: 8 }}>
              {selected.theme || "—"}
            </div>

            {selected.weather && (
              <div className="day-weather" style={{ marginBottom: 14 }}>
                <span className="weather-icon">{weatherIcon(selected.weather)}</span>
                <span>{selected.weather.condition}</span>
                {selected.weather.temp_c != null && (
                  <span className="weather-temp">{Math.round(selected.weather.temp_c)}°C</span>
                )}
              </div>
            )}

            <DayMiniMap activities={selected.activities} />

            <ol className="activities">
              {(selected.activities || []).map((act, i) => {
                const photo = photoSrc(act.photo_url);
                const isHotel = hotelName && act.name === hotelName;
                return (
                  <li key={i} className={`activity${isHotel ? " activity-hotel" : ""}`}>
                    {photo && (
                      <img
                        src={photo}
                        alt={act.name}
                        className="activity-photo"
                        onError={(e) => {
                          e.currentTarget.style.display = "none";
                        }}
                      />
                    )}
                    <div className="activity-row">
                      <span className="activity-time">{act.time}</span>
                      <div className="activity-info">
                        <strong>
                          {isHotel && <span className="activity-hotel-tag">🏨 HOTEL </span>}
                          {act.name}
                        </strong>
                        {act.address && <p className="activity-addr">{act.address}</p>}
                        {act.description && <p className="activity-desc">{act.description}</p>}
                        {act.duration_min && (
                          <span className="activity-duration">{act.duration_min} min</span>
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
                    </div>
                  </li>
                );
              })}
            </ol>
          </>
        )}
      </div>
    </section>
  );
}
