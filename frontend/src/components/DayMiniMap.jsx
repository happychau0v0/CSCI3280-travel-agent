import { useEffect, useMemo } from "react";
import { MapContainer, TileLayer, Marker, Polyline, useMap } from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";

// Override Leaflet's broken default marker icons (they reference assets
// that Vite doesn't bundle).
delete L.Icon.Default.prototype._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png",
  iconUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png",
  shadowUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png",
});

/** Decode a Google encoded polyline string into [[lat,lng], ...] tuples. */
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

/** Auto-fit the map to all markers + polylines whenever they change.
 * Round 11 — flyToBounds gives a smooth zoom-in after mount. */
function FitBounds({ points }) {
  const map = useMap();
  useEffect(() => {
    if (!points.length) return;
    const bounds = L.latLngBounds(points);
    map.flyToBounds(bounds, {
      padding: [24, 24],
      maxZoom: 15,
      duration: 0.9,
      easeLinearity: 0.25,
    });
  }, [points, map]);
  return null;
}

/**
 * Inline mini-map showing one day's activities and the transit polylines
 * between them. Mounts inside a day card in the itinerary drawer.
 *
 * Props:
 *   activities: list of {name, lat, lng, transport_to_next?}
 *   airport: {lat, lng, iata, label} | null — reference pin for
 *            Day 1 (arrival) / last day (departure). Round 10.
 */
export default function DayMiniMap({ activities, airport = null }) {
  const { points, polylines } = useMemo(() => {
    const pts = [];
    const lines = [];
    let counter = 1;
    for (const a of activities || []) {
      if (a.lat != null && a.lng != null) {
        pts.push({ idx: counter++, name: a.name, lat: a.lat, lng: a.lng });
      }
      if (a.transport_to_next?.polyline) {
        const decoded = decodePolyline(a.transport_to_next.polyline);
        if (decoded.length > 1) lines.push(decoded);
      }
    }
    return { points: pts, polylines: lines };
  }, [activities]);

  const hasAirport =
    airport && airport.lat != null && airport.lng != null;

  if (points.length === 0 && !hasAirport) {
    return (
      <div className="day-mini-map day-mini-map-empty">
        <span>No coordinates for this day — map unavailable</span>
      </div>
    );
  }

  // Custom numbered marker — small cyan disc with the visit order
  const numberedIcon = (n) =>
    L.divIcon({
      className: "day-mini-marker",
      html: `<div class="day-mini-pin">${n}</div>`,
      iconSize: [22, 22],
      iconAnchor: [11, 11],
    });

  const airportIcon = L.divIcon({
    className: "day-mini-marker",
    html: '<div class="day-mini-pin airport">✈</div>',
    iconSize: [28, 28],
    iconAnchor: [14, 14],
  });

  // All points used for fitBounds: markers + polyline vertices + airport
  const allPoints = [
    ...points.map((p) => [p.lat, p.lng]),
    ...polylines.flat(),
  ];
  if (hasAirport) allPoints.push([airport.lat, airport.lng]);

  const centerPoint = points.length
    ? [points[0].lat, points[0].lng]
    : [airport.lat, airport.lng];

  return (
    <div className="day-mini-map" data-testid="day-mini-map">
      <MapContainer
        center={centerPoint}
        zoom={10}
        scrollWheelZoom={false}
        zoomControl={false}
        attributionControl={false}
        style={{ height: "100%", width: "100%" }}
      >
        <TileLayer
          url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
          subdomains="abcd"
        />
        {hasAirport && (
          <Marker
            key={`airport-${airport.iata || "x"}`}
            position={[airport.lat, airport.lng]}
            icon={airportIcon}
          />
        )}
        {points.map((p) => (
          <Marker
            key={`${p.idx}-${p.lat}-${p.lng}`}
            position={[p.lat, p.lng]}
            icon={numberedIcon(p.idx)}
          />
        ))}
        {polylines.map((line, i) => (
          <Polyline
            key={i}
            positions={line}
            pathOptions={{ color: "#00d9ff", weight: 3, opacity: 0.85 }}
          />
        ))}
        <FitBounds points={allPoints} />
      </MapContainer>
    </div>
  );
}
