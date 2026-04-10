import { useState } from "react";
import { optimizeRoute, photoSrc } from "../api/client";
import DayMiniMap from "./DayMiniMap";

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
 * and weather indicators. Each day has an "Optimize order" button that
 * sends the activities to /itinerary/optimize and updates the parent.
 */
export default function ItineraryCard({ itinerary, onItineraryUpdate }) {
  const [optimizing, setOptimizing] = useState(null); // day index currently optimizing
  const [savings, setSavings] = useState({}); // {dayIdx: pct}
  const [error, setError] = useState(null);

  if (!itinerary) return null;

  const days = itinerary.days || [];

  const handleOptimize = async (dayIdx) => {
    const day = days[dayIdx];
    const activities = day.activities || [];
    const withCoords = activities.filter((a) => a.lat != null && a.lng != null);
    if (withCoords.length < 2) {
      setError("Need at least 2 activities with coordinates to optimize.");
      return;
    }

    setOptimizing(dayIdx);
    setError(null);
    try {
      const result = await optimizeRoute(withCoords);
      // Build a map from name → original activity so we can preserve fields
      // that may not have made it through `extra` (like transport_to_next).
      const byName = new Map(activities.map((a) => [a.name, a]));
      const reordered = result.ordered.map((o) => {
        const original = byName.get(o.name) || {};
        return { ...original, ...o };
      });

      // Strip transport_to_next from reordered activities since the order
      // changed — the routes are no longer accurate. Caller can re-fetch
      // directions if desired.
      reordered.forEach((a) => {
        delete a.transport_to_next;
      });

      const newDays = days.map((d, i) =>
        i === dayIdx ? { ...d, activities: reordered } : d,
      );
      const newItinerary = { ...itinerary, days: newDays };
      onItineraryUpdate?.(newItinerary);
      setSavings({ ...savings, [dayIdx]: result.savings_pct });
    } catch (err) {
      setError(`Optimization failed: ${err.message}`);
    } finally {
      setOptimizing(null);
    }
  };

  return (
    <div className="itinerary-card">
      <header className="itinerary-header">
        <h2>{itinerary.title || "Your Itinerary"}</h2>
        {itinerary.destination && (
          <p className="destination">{itinerary.destination}</p>
        )}
      </header>

      {error && <div className="optimize-error">{error}</div>}

      {days.map((day, dayIdx) => {
        const optimizable = (day.activities || []).filter(
          (a) => a.lat != null && a.lng != null,
        ).length >= 2;
        const savedPct = savings[dayIdx];

        return (
          <section key={day.day} className="day-card">
            <div className="day-header">
              <h3>
                Day {day.day}
                {day.date && <span className="day-date"> · {day.date}</span>}
                {day.theme && <span className="day-theme"> — {day.theme}</span>}
              </h3>
              {optimizable && (
                <button
                  type="button"
                  className="optimize-btn"
                  onClick={() => handleOptimize(dayIdx)}
                  disabled={optimizing === dayIdx}
                  title="Reorder activities for shortest travel distance"
                >
                  {optimizing === dayIdx ? "…" : "⇄ Optimize"}
                </button>
              )}
            </div>

            {savedPct != null && (
              <div className="savings-badge">
                {savedPct > 0
                  ? `Saved ${savedPct}% travel distance`
                  : "Already optimal"}
              </div>
            )}

            {day.weather && (
              <div className="day-weather">
                <span className="weather-icon">{weatherIcon(day.weather)}</span>
                <span>{day.weather.condition}</span>
                {day.weather.temp_c != null && (
                  <span className="weather-temp">
                    {Math.round(day.weather.temp_c)}°C
                  </span>
                )}
              </div>
            )}

            <DayMiniMap activities={day.activities} />

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
        );
      })}
    </div>
  );
}
