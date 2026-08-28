import { useEffect, useMemo } from "react";
import { MapContainer, TileLayer, Marker, Polyline, Tooltip, useMap } from "react-leaflet";
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

/** Haversine distance in km between two [lat, lng] pairs. */
function haversineKm(a, b) {
  const R = 6371;
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(b[0] - a[0]);
  const dLng = toRad(b[1] - a[1]);
  const lat1 = toRad(a[0]);
  const lat2 = toRad(b[0]);
  const x =
    Math.sin(dLat / 2) ** 2 +
    Math.sin(dLng / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
  return 2 * R * Math.asin(Math.sqrt(x));
}

/** Compute a centroid of [[lat,lng], ...] points. */
function centroid(pts) {
  if (!pts.length) return null;
  const sumLat = pts.reduce((s, p) => s + p[0], 0);
  const sumLng = pts.reduce((s, p) => s + p[1], 0);
  return [sumLat / pts.length, sumLng / pts.length];
}

/** Decide whether the airport is an "outlier" — far from the cluster of
 * activity coords. If so, the map should fit only to activities, and the
 * airport gets a small corner badge with a flyTo button instead.
 * Returns { airportIsOutlier, distanceKm }. */
function isAirportOutlier(activityPoints, airportPoint) {
  if (!airportPoint || activityPoints.length === 0) {
    return { airportIsOutlier: false, distanceKm: 0 };
  }
  const c = centroid(activityPoints);
  if (!c) return { airportIsOutlier: false, distanceKm: 0 };
  const distFromCentroid = haversineKm(airportPoint, c);
  // If airport is >20km from city activity centroid, treat as outlier
  return { airportIsOutlier: distFromCentroid > 20, distanceKm: distFromCentroid };
}

// Transport mode → polyline color
const MODE_COLOR = {
  WALK: "#4ade80",
  TRANSIT: "#00d9ff",
  DRIVE: "#fbbf24",
};
const MODE_DEFAULT_COLOR = "#00d9ff";

const MODE_ICON = { WALK: "🚶", TRANSIT: "🚇", DRIVE: "🚗" };
const MODE_LABEL = { WALK: "Walking", TRANSIT: "Transit", DRIVE: "Taxi" };

/** Auto-fit the map to provided bounds points whenever coordinates change.
 * Uses a stable string key to avoid re-triggering on reference changes. */
function FitBounds({ points }) {
  const map = useMap();
  const key = points.map((p) => `${p[0].toFixed(4)},${p[1].toFixed(4)}`).join("|");
  useEffect(() => {
    if (!points.length) return;
    const bounds = L.latLngBounds(points);
    map.flyToBounds(bounds, {
      padding: [24, 24],
      maxZoom: 15,
      duration: 0.9,
      easeLinearity: 0.25,
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, map]);
  return null;
}

/** A small corner button that flies the map to the airport pin. */
function AirportBadge({ airport, distanceKm }) {
  const map = useMap();
  if (!airport || !airport.lat || !airport.lng) return null;
  return (
    <button
      type="button"
      className="day-mini-airport-badge"
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        map.flyTo([airport.lat, airport.lng], 13, { duration: 0.8 });
      }}
      data-testid="day-mini-airport-badge"
      title={`Fly to ${airport.iata || "airport"} (${Math.round(distanceKm)} km away)`}
    >
      ✈ {airport.iata || "AIRPORT"} · {Math.round(distanceKm)}km ↗
    </button>
  );
}

/** Floating chip showing transport mode + duration for the active leg. */
function TransportBadge({ activity, liveRoute }) {
  const transport = activity?.transport_to_next;
  const mode = transport?.mode || liveRoute?.mode;
  if (!mode) return null;
  const duration = liveRoute?.duration || transport?.duration;
  const icon = MODE_ICON[mode] || "→";
  const label = MODE_LABEL[mode] || mode;
  const color = MODE_COLOR[mode] || MODE_DEFAULT_COLOR;
  return (
    <div
      className="transport-badge"
      style={{ borderColor: color, color }}
      data-testid="transport-badge"
    >
      {icon} {label}{duration ? ` · ${duration}` : ""}
    </div>
  );
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
export default function DayMiniMap({
  activities,
  airport = null,
  activeActivityIdx = -1,
  liveRoute = null,
  liveRouteLoading = false,
  theme = "dark",
}) {
  const { points, polylines } = useMemo(() => {
    const pts = [];
    const lines = [];
    let counter = 1;
    for (let i = 0; i < (activities || []).length; i++) {
      const a = activities[i];
      if (a.lat != null && a.lng != null) {
        pts.push({ idx: counter++, activityIdx: i, name: a.name, lat: a.lat, lng: a.lng });
      }
      if (a.transport_to_next?.polyline) {
        const decoded = decodePolyline(a.transport_to_next.polyline);
        if (decoded.length > 1) {
          lines.push({ activityIdx: i, coords: decoded, mode: a.transport_to_next.mode || "TRANSIT" });
        }
      }
    }
    return { points: pts, polylines: lines };
  }, [activities]);

  // focusPoints: when an activity is selected, zoom to just the active pair.
  // If a live route polyline is available, use its endpoints for tighter fit.
  // Must be called before any early return (Rules of Hooks).
  const focusPoints = useMemo(() => {
    const actPts = points.map((p) => [p.lat, p.lng]);
    if (activeActivityIdx < 0 || points.length < 2) return actPts;
    // Prefer live route endpoints for the most accurate fit.
    if (liveRoute?.polyline) {
      const decoded = decodePolyline(liveRoute.polyline);
      if (decoded.length >= 2) {
        return [decoded[0], decoded[decoded.length - 1]];
      }
    }
    // Origin = previous activity; destination = clicked activity (both by raw 0-based activityIdx)
    const a = points.find((p) => p.activityIdx === activeActivityIdx - 1);
    const b = points.find((p) => p.activityIdx === activeActivityIdx);
    const pair = [a, b].filter(Boolean).map((p) => [p.lat, p.lng]);
    return pair.length >= 2 ? pair : actPts;
  }, [activeActivityIdx, points, liveRoute]);

  const hasAirport =
    airport && airport.lat != null && airport.lng != null;

  if (points.length === 0 && !hasAirport) {
    return (
      <div className="day-mini-map day-mini-map-empty">
        <span>No coordinates for this day — map unavailable</span>
      </div>
    );
  }

  // Custom numbered marker — active pin is large amber, others are small dim dots
  const numberedIcon = (n, isActive, isNext) => {
    if (isActive) {
      return L.divIcon({
        className: "day-mini-marker",
        html: `<div class="day-mini-pin active">${n}</div>`,
        iconSize: [26, 26],
        iconAnchor: [13, 13],
      });
    }
    if (isNext) {
      return L.divIcon({
        className: "day-mini-marker",
        html: `<div class="day-mini-pin">${n}</div>`,
        iconSize: [22, 22],
        iconAnchor: [11, 11],
      });
    }
    // Dim dot for inactive pins
    return L.divIcon({
      className: "day-mini-marker",
      html: `<div class="day-mini-pin dim">${n}</div>`,
      iconSize: [14, 14],
      iconAnchor: [7, 7],
    });
  };

  // Decide if airport is far from the activity cluster
  const activityPoints = points.map((p) => [p.lat, p.lng]);
  const { airportIsOutlier, distanceKm } = hasAirport
    ? isAirportOutlier(activityPoints, [airport.lat, airport.lng])
    : { airportIsOutlier: false, distanceKm: 0 };

  const airportIcon = L.divIcon({
    className: "day-mini-marker",
    html: `<div class="day-mini-pin airport${airportIsOutlier ? " airport-distant" : ""}">✈</div>`,
    iconSize: [28, 28],
    iconAnchor: [14, 14],
  });

  const centerPoint = points.length
    ? [points[0].lat, points[0].lng]
    : [airport.lat, airport.lng];

  // Active activity (for TransportBadge)
  const activeActivity =
    activeActivityIdx >= 0 ? (activities || [])[activeActivityIdx] : null;

  return (
    <div className="day-mini-map" data-testid="day-mini-map" style={{ position: "relative" }}>
      <MapContainer
        center={centerPoint}
        zoom={10}
        scrollWheelZoom={false}
        zoomControl={false}
        attributionControl={false}
        style={{ height: "100%", width: "100%" }}
      >
        <TileLayer
          key={theme}
          url={`https://{s}.basemaps.cartocdn.com/${theme === "light" ? "light_all" : "dark_all"}/{z}/{x}/{y}{r}.png`}
          subdomains="abcd"
        />
        {hasAirport && (
          <Marker
            key={`airport-${airport.iata || "x"}`}
            position={[airport.lat, airport.lng]}
            icon={airportIcon}
          />
        )}
        {points.map((p) => {
          const isActive = activeActivityIdx >= 0 && p.activityIdx === activeActivityIdx;
          const isNext = activeActivityIdx > 0 && p.activityIdx === activeActivityIdx - 1;
          return (
            <Marker
              key={`${p.idx}-${p.lat}-${p.lng}`}
              position={[p.lat, p.lng]}
              icon={numberedIcon(p.idx, isActive, isNext)}
            />
          );
        })}
        {polylines.map((line, i) => {
          const isActiveLine = activeActivityIdx > 0 && line.activityIdx === activeActivityIdx - 1;
          const color = MODE_COLOR[line.mode] || MODE_DEFAULT_COLOR;
          if (activeActivityIdx >= 0 && !isActiveLine) {
            return (
              <Polyline
                key={i}
                positions={line.coords}
                pathOptions={{ color, weight: 1.5, opacity: 0.25 }}
              />
            );
          }
          return (
            <Polyline
              key={i}
              positions={line.coords}
              pathOptions={{ color, weight: 5, opacity: 1.0 }}
            />
          );
        })}
        {/* Live route overlay — dashed animated polyline fetched on activity click */}
        {liveRoute?.polyline && (() => {
          const coords = decodePolyline(liveRoute.polyline);
          const color = MODE_COLOR[liveRoute.mode] || MODE_DEFAULT_COLOR;
          return coords.length > 1 ? (
            <Polyline
              positions={coords}
              pathOptions={{ color, weight: 5, opacity: 0.9, dashArray: "10 6" }}
              className="live-route-line"
            >
              {liveRoute.duration && (
                <Tooltip permanent direction="center" className="route-duration-label">
                  {liveRoute.duration}
                </Tooltip>
              )}
            </Polyline>
          ) : null;
        })()}
        <FitBounds points={focusPoints} />
        {hasAirport && airportIsOutlier && (
          <AirportBadge airport={airport} distanceKm={distanceKm} />
        )}
      </MapContainer>
      {liveRouteLoading && (
        <div className="map-live-loading" aria-live="polite">ROUTING…</div>
      )}
      {(activeActivity?.transport_to_next?.mode || liveRoute?.mode) && (
        <TransportBadge activity={activeActivity} liveRoute={liveRoute} />
      )}
    </div>
  );
}
