import { useEffect, useMemo, useRef, useState } from "react";
import Globe from "react-globe.gl";

/**
 * Full-bleed dark globe rendered with react-globe.gl.
 *
 * Modeled on the Shopify Liveview reference:
 * - Hexagonal dot polygons for country fills (no realistic textures)
 * - Animated cyan arcs for flight paths (origin → destination)
 * - Pulsing rings at origin and destination
 * - Gentle auto-rotate when idle
 * - Programmatic camera flight when userLocation or arcs change
 *
 * Props:
 * - userLocation: {lat, lng, city} | null — initial center
 * - arcs:    [{startLat, startLng, endLat, endLng, color?, label?}]
 * - points:  [{lat, lng, size?, color?, label?, ring?}]
 * - drawerOpen: bool — when true, offset the camera so the right side
 *                isn't hidden behind the slide-in drawer
 */
export default function GlobeView({
  userLocation,
  arcs = [],
  points = [],
  drawerOpen = false,
}) {
  const globeRef = useRef(null);
  const [size, setSize] = useState({ w: 800, h: 600 });
  const [countries, setCountries] = useState({ features: [] });

  // Track viewport for the globe canvas
  useEffect(() => {
    const update = () => setSize({ w: window.innerWidth, h: window.innerHeight });
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);

  // Lazy-load the country topology once
  useEffect(() => {
    fetch("/data/countries.geojson")
      .then((r) => r.json())
      .then(setCountries)
      .catch((err) => {
        console.error("Failed to load countries.geojson", err);
      });
  }, []);

  // Configure controls and material once the globe is ready
  useEffect(() => {
    if (!globeRef.current) return;
    const controls = globeRef.current.controls();
    if (controls) {
      controls.autoRotate = true;
      controls.autoRotateSpeed = 0.25;
      controls.enableZoom = true;
      controls.minDistance = 200;
      controls.maxDistance = 800;
    }
  }, [countries]);

  // Fly to user location on first lock
  useEffect(() => {
    if (!globeRef.current || !userLocation) return;
    if (userLocation.lat == null || userLocation.lng == null) return;
    globeRef.current.pointOfView(
      { lat: userLocation.lat, lng: userLocation.lng, altitude: 2.0 },
      1500,
    );
  }, [userLocation]);

  // Fly to the midpoint of the first arc when arcs change (i.e. when a flight
  // is added). Offset eastward when the drawer is open so the destination
  // isn't covered.
  useEffect(() => {
    if (!globeRef.current || arcs.length === 0) return;
    const arc = arcs[0];
    const midLat = (arc.startLat + arc.endLat) / 2;
    let midLng = (arc.startLng + arc.endLng) / 2;
    if (drawerOpen) midLng -= 25; // shift the focus left of the drawer
    globeRef.current.pointOfView({ lat: midLat, lng: midLng, altitude: 2.4 }, 2000);
  }, [arcs, drawerOpen]);

  // Pause auto-rotate while there's an active arc to draw the eye to it
  useEffect(() => {
    if (!globeRef.current) return;
    const controls = globeRef.current.controls();
    if (!controls) return;
    controls.autoRotate = arcs.length === 0;
  }, [arcs]);

  // Build the rings dataset from points that have ring=true
  const ringsData = useMemo(
    () =>
      points
        .filter((p) => p.ring)
        .map((p) => ({ lat: p.lat, lng: p.lng, color: p.color || "#00d9ff" })),
    [points],
  );

  return (
    <div className="globe-canvas">
      <Globe
        ref={globeRef}
        width={size.w}
        height={size.h}
        backgroundColor="rgba(0,0,0,0)"
        globeImageUrl={null}
        showAtmosphere={true}
        atmosphereColor="#00d9ff"
        atmosphereAltitude={0.18}
        // Hexagonal country polygons — the dot-matrix look
        hexPolygonsData={countries.features}
        hexPolygonResolution={3}
        hexPolygonMargin={0.35}
        hexPolygonUseDots={true}
        hexPolygonColor={() => "rgba(0, 217, 255, 0.55)"}
        // Arcs (flight paths)
        arcsData={arcs}
        arcStartLat={(d) => d.startLat}
        arcStartLng={(d) => d.startLng}
        arcEndLat={(d) => d.endLat}
        arcEndLng={(d) => d.endLng}
        arcColor={(d) => d.color || ["#00d9ff", "#5eead4"]}
        arcStroke={0.5}
        arcAltitudeAutoScale={0.5}
        arcDashLength={0.5}
        arcDashGap={0.15}
        arcDashAnimateTime={2500}
        arcLabel={(d) => d.label || ""}
        // Points (origin / destination / activities)
        pointsData={points}
        pointLat={(d) => d.lat}
        pointLng={(d) => d.lng}
        pointColor={(d) => d.color || "#00d9ff"}
        pointAltitude={(d) => d.altitude || 0.01}
        pointRadius={(d) => d.size || 0.4}
        pointLabel={(d) => d.label || ""}
        // Pulsing rings on key points (origin/destination)
        ringsData={ringsData}
        ringColor={(d) => () => d.color}
        ringMaxRadius={3}
        ringPropagationSpeed={2}
        ringRepeatPeriod={1500}
      />
    </div>
  );
}
