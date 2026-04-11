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
  useEffect(() => {
    if (!points.length) return;
    const bounds = L.latLngBounds(points);
    map.fitBounds(bounds, { padding: [32, 32], maxZoom: 14 });
  }, [points, map]);
  return null;
}

function hotelIcon(n, active) {
  return L.divIcon({
    className: "day-mini-marker",
    html: `<div class="day-mini-pin${active ? " active" : ""}">${n}</div>`,
    iconSize: [24, 24],
    iconAnchor: [12, 12],
  });
}

function airportIcon() {
  return L.divIcon({
    className: "day-mini-marker",
    html: '<div class="day-mini-pin airport">✈</div>',
    iconSize: [28, 28],
    iconAnchor: [14, 14],
  });
}

export default function HotelsMap({ hotels, airport = null, selectedIdx = 0 }) {
  const { markers, bounds } = useMemo(() => {
    const markers = [];
    const bounds = [];
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
      bounds.push([h.lat, h.lng]);
    });
    if (airport?.lat != null && airport?.lng != null) {
      bounds.push([airport.lat, airport.lng]);
    }
    return { markers, bounds };
  }, [hotels, airport, selectedIdx]);

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
        zoom={12}
        scrollWheelZoom={false}
        zoomControl={false}
        attributionControl={false}
        style={{ height: "100%", width: "100%" }}
      >
        <TileLayer
          url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
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
            icon={airportIcon()}
          />
        )}
        <FitBounds points={bounds} />
      </MapContainer>
    </div>
  );
}
