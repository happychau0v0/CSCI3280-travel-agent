/**
 * MAP panel — empty container. The GlobeView renders behind everything
 * via fixed positioning, so this panel just shows a thin status overlay
 * with the current trip summary if there is one.
 */
export default function PanelMap({ itinerary, userLocation }) {
  return (
    <section className="panel panel-map" aria-label="Map">
      <div className="panel-map-status">
        {userLocation?.city && (
          <div className="map-status-line">
            <span className="map-status-label">YOU ARE HERE</span>
            <span className="map-status-value">{userLocation.city}</span>
          </div>
        )}
        {itinerary?.destination && (
          <div className="map-status-line">
            <span className="map-status-label">DESTINATION</span>
            <span className="map-status-value">{itinerary.destination}</span>
          </div>
        )}
        {itinerary?.flight && (
          <div className="map-status-line">
            <span className="map-status-label">ROUTE</span>
            <span className="map-status-value">
              {itinerary.flight.from_iata} → {itinerary.flight.to_iata}
            </span>
          </div>
        )}
      </div>
    </section>
  );
}
