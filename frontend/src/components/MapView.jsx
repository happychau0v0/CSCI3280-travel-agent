import { useEffect, useMemo } from "react";
import { MapContainer, TileLayer, Marker, Popup, Polyline, useMap } from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";

// Leaflet's default marker icons reference assets that don't resolve through
// Vite's bundler. Override with explicit URLs from the leaflet CDN.
delete L.Icon.Default.prototype._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl:
    "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png",
  iconUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png",
  shadowUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png",
});

/**
 * Decode a Google encoded polyline string into [lat, lng] tuples.
 * Reference: https://developers.google.com/maps/documentation/utilities/polylinealgorithm
 */
function decodePolyline(encoded) {
  if (!encoded) return [];
  const points = [];
  let index = 0;
  const len = encoded.length;
  let lat = 0;
  let lng = 0;

  while (index < len) {
    let result = 0;
    let shift = 0;
    let b;
    do {
      b = encoded.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    const dlat = result & 1 ? ~(result >> 1) : result >> 1;
    lat += dlat;

    result = 0;
    shift = 0;
    do {
      b = encoded.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    const dlng = result & 1 ? ~(result >> 1) : result >> 1;
    lng += dlng;

    points.push([lat / 1e5, lng / 1e5]);
  }
  return points;
}

/** Auto-fit the map to all markers + polylines whenever they change. */
function FitBounds({ points }) {
  const map = useMap();
  useEffect(() => {
    if (!points.length) return;
    const bounds = L.latLngBounds(points);
    map.fitBounds(bounds, { padding: [30, 30] });
  }, [points, map]);
  return null;
}

/**
 * Render an interactive map with numbered pins for each itinerary activity
 * and decoded polylines for the routes between them.
 */
export default function MapView({ itinerary }) {
  const { activityPoints, polylinePoints } = useMemo(() => {
    if (!itinerary) return { activityPoints: [], polylinePoints: [] };

    const acts = [];
    const polys = [];
    let counter = 1;
    for (const day of itinerary.days || []) {
      for (const a of day.activities || []) {
        if (a.lat != null && a.lng != null) {
          acts.push({ idx: counter++, name: a.name, lat: a.lat, lng: a.lng });
        }
        if (a.transport_to_next?.polyline) {
          const decoded = decodePolyline(a.transport_to_next.polyline);
          if (decoded.length > 1) polys.push(decoded);
        }
      }
    }
    return { activityPoints: acts, polylinePoints: polys };
  }, [itinerary]);

  if (!itinerary || activityPoints.length === 0) {
    return (
      <div className="map-view map-view-empty">
        <p>Map will appear here once your itinerary is generated.</p>
      </div>
    );
  }

  // All points used for fitBounds: markers + polyline vertices
  const allPoints = [
    ...activityPoints.map((p) => [p.lat, p.lng]),
    ...polylinePoints.flat(),
  ];

  // Create numbered marker icons
  const numberedIcon = (n) =>
    L.divIcon({
      className: "numbered-marker",
      html: `<div class="marker-pin">${n}</div>`,
      iconSize: [30, 30],
      iconAnchor: [15, 15],
    });

  const center = activityPoints[0];

  return (
    <div className="map-view">
      <MapContainer
        center={[center.lat, center.lng]}
        zoom={13}
        scrollWheelZoom={false}
        style={{ height: "100%", width: "100%" }}
      >
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />
        {activityPoints.map((p) => (
          <Marker
            key={`${p.idx}-${p.lat}-${p.lng}`}
            position={[p.lat, p.lng]}
            icon={numberedIcon(p.idx)}
          >
            <Popup>
              <strong>
                {p.idx}. {p.name}
              </strong>
            </Popup>
          </Marker>
        ))}
        {polylinePoints.map((line, i) => (
          <Polyline key={i} positions={line} pathOptions={{ color: "#0891b2", weight: 4 }} />
        ))}
        <FitBounds points={allPoints} />
      </MapContainer>
    </div>
  );
}
