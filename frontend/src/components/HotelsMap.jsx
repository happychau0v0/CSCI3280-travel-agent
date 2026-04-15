import { useEffect, useMemo } from "react";
import { MapContainer, TileLayer, Marker, useMap } from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";

/**
 * Leaflet map for the HOTELS panel. Shows one numbered pin per hotel
 * candidate, the currently-selected hotel in amber, and a ✈ airport
 * pin as a reference anchor. The `FitBounds` hook auto-zooms to
 * include every marker whenever the props change.
 *
 * Props:
 *   hotels:      [{name, lat, lng, ...}]
 *   airport:     {lat, lng, iata, label} | null
 *   selectedIdx: number — which hotel is highlighted (defaults to 0)
 */

function FitBounds({ points }) {
  const map = useMap();
  // Stable string key so the effect only re-fires when coordinates
  // actually change — not on every parent re-render (shake fix).
  const key = points.map((p) => `${p[0].toFixed(4)},${p[1].toFixed(4)}`).join("|");
  useEffect(() => {
    if (!points.length) return;
    const bounds = L.latLngBounds(points);
    map.flyToBounds(bounds, {
      padding: [32, 32],
      maxZoom: 14,
      duration: 0.9,
      easeLinearity: 0.25,
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, map]);
  return null;
}

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
      title={`Fly to ${airport.iata || "airport"} (${Math.round(distanceKm)} km away)`}
    >
      ✈ {airport.iata || "AIRPORT"} · {Math.round(distanceKm)}km ↗
    </button>
  );
}

function hotelIcon(n, active) {
  return L.divIcon({
    className: "day-mini-marker",
    html: `<div class="day-mini-pin${active ? " active" : ""}">${n}</div>`,
    iconSize: [24, 24],
    iconAnchor: [12, 12],
  });
}

function airportIcon(distant) {
  return L.divIcon({
    className: "day-mini-marker",
    html: `<div class="day-mini-pin airport${distant ? " airport-distant" : ""}">✈</div>`,
    iconSize: [28, 28],
    iconAnchor: [14, 14],
  });
}

export default function HotelsMap({ hotels, airport = null, selectedIdx = 0, theme = "dark" }) {
  const { markers, bounds, airportIsOutlier, distanceKm } = useMemo(() => {
    const markers = [];
    const hotelCoords = [];
    (hotels || []).forEach((h, i) => {
      if (h.lat == null || h.lng == null) return;
      markers.push({
        key: h.place_id || `${h.lat}-${h.lng}-${i}`,
        lat: h.lat,
        lng: h.lng,
        idx: i + 1,
        active: i === selectedIdx,
        name: h.name,
      });
      hotelCoords.push([h.lat, h.lng]);
    });
    let outlier = false;
    let dist = 0;
    const bounds = [...hotelCoords];
    if (airport?.lat != null && airport?.lng != null && hotelCoords.length > 0) {
      const sumLat = hotelCoords.reduce((s, p) => s + p[0], 0);
      const sumLng = hotelCoords.reduce((s, p) => s + p[1], 0);
      const centroid = [sumLat / hotelCoords.length, sumLng / hotelCoords.length];
      dist = haversineKm([airport.lat, airport.lng], centroid);
      outlier = dist > 20;
      if (!outlier) bounds.push([airport.lat, airport.lng]);
    }
    return { markers, bounds, airportIsOutlier: outlier, distanceKm: dist };
  // selectedIdx only affects which pin is highlighted — not the bounds.
  // Removing it from deps prevents FitBounds re-firing on every selection.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hotels, airport]);

  if (markers.length === 0) {
    return (
      <div className="day-mini-map day-mini-map-empty">
        <span>No hotel coordinates yet</span>
      </div>
    );
  }

  const center = [markers[0].lat, markers[0].lng];

  return (
    <div className="day-mini-map" data-testid="hotels-map">
      <MapContainer
        center={center}
        zoom={9}
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
        {markers.map((m) => (
          <Marker
            key={m.key}
            position={[m.lat, m.lng]}
            icon={hotelIcon(m.idx, m.active)}
          />
        ))}
        {airport?.lat != null && airport?.lng != null && (
          <Marker
            key={`airport-${airport.iata || "x"}`}
            position={[airport.lat, airport.lng]}
            icon={airportIcon(airportIsOutlier)}
          />
        )}
        <FitBounds points={bounds} />
        {airportIsOutlier && (
          <AirportBadge airport={airport} distanceKm={distanceKm} />
        )}
      </MapContainer>
    </div>
  );
}
