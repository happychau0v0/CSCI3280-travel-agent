import { photoSrc } from "../api/client";

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

/**
 * Renders a structured itinerary as a day-by-day card stack with photos
 * and weather indicators.
 */
export default function ItineraryCard({ itinerary }) {
  if (!itinerary) return null;

  const days = itinerary.days || [];

  return (
    <div className="itinerary-card">
      <header className="itinerary-header">
        <h2>{itinerary.title || "Your Itinerary"}</h2>
        {itinerary.destination && (
          <p className="destination">{itinerary.destination}</p>
        )}
      </header>

      {days.map((day) => (
        <section key={day.day} className="day-card">
          <h3>
            Day {day.day}
            {day.date && <span className="day-date"> · {day.date}</span>}
            {day.theme && <span className="day-theme"> — {day.theme}</span>}
          </h3>
          {day.weather && (
            <div className="day-weather">
              <span className="weather-icon">{weatherIcon(day.weather)}</span>
              <span>{day.weather.condition}</span>
              {day.weather.temp_c != null && (
                <span className="weather-temp">{Math.round(day.weather.temp_c)}°C</span>
              )}
            </div>
          )}
          <ol className="activities">
            {(day.activities || []).map((act, i) => {
              const photo = photoSrc(act.photo_url);
              return (
                <li key={i} className="activity">
                  {photo && (
                    <img
                      src={photo}
                      alt={act.name}
                      className="activity-photo"
                      loading="lazy"
                      onError={(e) => {
                        e.currentTarget.style.display = "none";
                      }}
                    />
                  )}
                  <div className="activity-row">
                    <span className="activity-time">{act.time}</span>
                    <div className="activity-info">
                      <strong>{act.name}</strong>
                      {act.address && <p className="activity-addr">{act.address}</p>}
                      {act.description && (
                        <p className="activity-desc">{act.description}</p>
                      )}
                      {act.duration_min && (
                        <span className="activity-duration">
                          {act.duration_min} min
                        </span>
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
        </section>
      ))}
    </div>
  );
}
