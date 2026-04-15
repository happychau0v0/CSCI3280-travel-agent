import { useEffect, useMemo, useRef, useState } from "react";
import Globe from "react-globe.gl";
import * as THREE from "three";

// Derive globe palette from the current theme so light mode looks natural.
function buildGlobeMaterial(theme) {
  const mat = new THREE.MeshPhongMaterial();
  if (theme === "light") {
    mat.color.set(0xc8cdd4);   // cool slate-gray — neutral contrast on cream bg
    mat.specular.set(0x90b0c8);
    mat.shininess = 14;
  } else {
    mat.color.set(0x0a1525);   // deep navy
    mat.specular.set(0x224466);
    mat.shininess = 8;
  }
  return mat;
}

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
  focus = null,
  theme = "dark",
  explodeTrigger = 0,
}) {
  const globeRef = useRef(null);
  const globeCanvasRef = useRef(null);
  const prevFocusRef = useRef(null);
  const animationFrameRef = useRef(null);
  const [size, setSize] = useState({ w: 800, h: 600 });
  const [countries, setCountries] = useState({ features: [] });

  const globeMaterial = useMemo(() => buildGlobeMaterial(theme), [theme]);

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

  // Configure controls and material once the globe is ready, and add a
  // starfield to the underlying Three.js scene so the void around the
  // globe has some depth instead of feeling pitch-black.
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

    // Inject a starfield once. Skip if we already added one (StrictMode
    // double-mounts effects in dev).
    const scene = globeRef.current.scene?.();
    if (scene && !scene.userData.starfield) {
      const starCount = 800;
      const positions = new Float32Array(starCount * 3);
      // Place stars on the surface of a sphere of radius ~700 (well outside
      // the globe's ~100 unit radius and beyond max camera distance) so they
      // sit at infinity and never clip the camera.
      for (let i = 0; i < starCount; i++) {
        const r = 700;
        const u = Math.random();
        const v = Math.random();
        const theta = 2 * Math.PI * u;
        const phi = Math.acos(2 * v - 1);
        positions[i * 3] = r * Math.sin(phi) * Math.cos(theta);
        positions[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta);
        positions[i * 3 + 2] = r * Math.cos(phi);
      }
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
      const material = new THREE.PointsMaterial({
        color: 0xffffff,
        size: 1.5,
        sizeAttenuation: true,
        transparent: true,
        opacity: 0.65,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      });
      const stars = new THREE.Points(geometry, material);
      scene.add(stars);
      scene.userData.starfield = stars;
    }
  }, [countries]);

  // Show/hide starfield based on theme — stars make no sense on a cream background.
  useEffect(() => {
    const scene = globeRef.current?.scene?.();
    if (!scene?.userData.starfield) return;
    scene.userData.starfield.material.opacity = theme === "light" ? 0 : 0.65;
  }, [theme, countries]); // re-run after countries loads (which is when stars are added)

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
  // isn't covered. Skipped when `focus` is set — panel-driven focus wins.
  //
  // Antimeridian fix: simple (start+end)/2 gives the wrong hemisphere for
  // routes that cross ±180° (e.g. HKG +114° → YVR −123° averages to −4.5°
  // in the Atlantic instead of +175.5° in the Pacific). Detect the crossing
  // and add/subtract 360° so the midpoint always uses the shorter arc.
  useEffect(() => {
    if (!globeRef.current || arcs.length === 0) return;
    if (focus) return;
    const arc = arcs[0];
    const midLat = (arc.startLat + arc.endLat) / 2;
    const lngDiff = arc.endLng - arc.startLng;
    let rawMidLng;
    if (lngDiff > 180) {
      rawMidLng = (arc.startLng + arc.endLng - 360) / 2;
    } else if (lngDiff < -180) {
      rawMidLng = (arc.startLng + arc.endLng + 360) / 2;
    } else {
      rawMidLng = (arc.startLng + arc.endLng) / 2;
    }
    let midLng = rawMidLng;
    if (drawerOpen) midLng -= 25; // shift the focus left of the drawer
    globeRef.current.pointOfView({ lat: midLat, lng: midLng, altitude: 2.4 }, 2000);
  }, [arcs, drawerOpen, focus]);

  // Panel-driven focus (Round 10). When the user switches to HOTELS or
  // DAYS the parent computes a low-altitude target centered on the trip
  // destination; this effect animates the camera there and pauses auto-
  // rotate so the Leaflet map that fades in on top isn't visually
  // fighting a spinning globe underneath.
  //
  // __debug.globeFocus is exposed even before the globe ref is ready so
  // the Playwright harness can assert that a focus target was at least
  // computed for the current panel.
  useEffect(() => {
    if (typeof window !== "undefined") {
      window.__debug = window.__debug || {};
      window.__debug.globeFocus = focus ? { ...focus } : null;
    }
    // Track focus transitions so we can detect focused → unfocused regardless
    // of the current camera altitude (which may be mid-animation).
    const wasFocused = prevFocusRef.current !== null;
    prevFocusRef.current = focus;

    if (!globeRef.current) return;

    if (!focus) {
      // Returning to HOME/FLIGHTS — re-enable autoRotate and zoom back out.
      // Use wasFocused instead of checking pov.altitude: if Q is pressed while
      // the zoom-in animation is still running the intermediate altitude may be
      // ≥ 0.5 and the old altitude guard would silently skip the reset.
      const controls = globeRef.current.controls?.();
      if (controls) controls.autoRotate = true;
      if (wasFocused) {
        const pov = globeRef.current.pointOfView();
        globeRef.current.pointOfView(
          { lat: pov?.lat ?? 0, lng: pov?.lng ?? 0, altitude: 2.0 },
          1500,
        );
      }
      return;
    }

    const controls = globeRef.current.controls?.();
    if (controls) controls.autoRotate = false;
    // Round 11 — longer flight (2200ms) gives the camera time to
    // truly "zoom in" before the map overlay fades in on top. The
    // CSS .panel-grid-center scale-in starts at 1400ms, so the
    // globe is still moving when the map emerges, creating a
    // continuous-zoom illusion.
    globeRef.current.pointOfView(
      { lat: focus.lat, lng: focus.lng, altitude: focus.altitude ?? 0.08 },
      2200,
    );
    const reArm = setTimeout(() => {
      if (globeRef.current) {
        const c = globeRef.current.controls?.();
        if (c) c.autoRotate = true;
      }
    }, 4200);
    return () => clearTimeout(reArm);
  }, [focus]);

  // Globe-explode animation — fires whenever explodeTrigger increments.
  //
  // Sequence:
  //   1. Particles burst outward from the globe surface at constant velocity and
  //      fade to nothing — no reform, they just keep going.
  //   2. While particles fly, the globe is hidden and the camera instantly jumps
  //      to a very far altitude so the scene is "empty".
  //   3. After a short delay the globe reappears and the camera zooms in from
  //      that far position, creating the illusion of a brand-new globe arriving
  //      from deep space.
  useEffect(() => {
    if (!explodeTrigger || !globeRef.current) return;
    const scene = globeRef.current.scene?.();
    if (!scene) return;

    const GLOBE_R = 100;
    const N = 2500;
    const origPos   = new Float32Array(N * 3);
    const velocities = new Float32Array(N * 3);

    for (let i = 0; i < N; i++) {
      const phi = Math.acos(2 * Math.random() - 1);
      const theta = 2 * Math.PI * Math.random();
      const nx = Math.sin(phi) * Math.cos(theta);
      const ny = Math.sin(phi) * Math.sin(theta);
      const nz = Math.cos(phi);
      origPos[i * 3]     = GLOBE_R * nx;
      origPos[i * 3 + 1] = GLOBE_R * ny;
      origPos[i * 3 + 2] = GLOBE_R * nz;
      // Slightly randomised outward direction so the burst has texture
      const speed = 0.7 + Math.random() * 0.6;
      const jitter = 0.25;
      velocities[i * 3]     = nx * speed + (Math.random() - 0.5) * jitter;
      velocities[i * 3 + 1] = ny * speed + (Math.random() - 0.5) * jitter;
      velocities[i * 3 + 2] = nz * speed + (Math.random() - 0.5) * jitter;
    }

    const pos = new Float32Array(origPos);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    const mat = new THREE.PointsMaterial({
      color: theme === "light" ? 0x1a9b8f : 0x00d9ff,
      size: 1.4,
      sizeAttenuation: true,
      transparent: true,
      opacity: 0.95,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const particles = new THREE.Points(geometry, mat);
    scene.add(particles);

    // Hide the ThreeGlobe group immediately (sphere + hex dots + arcs + atmosphere).
    const globeGroup = scene.children.find((c) => c.isGroup);
    if (globeGroup) globeGroup.visible = false;

    // Also hide the canvas wrapper so the globe is fully invisible before reveal.
    const canvas = globeCanvasRef.current;
    if (canvas) {
      canvas.style.transition = "none";
      canvas.style.opacity    = "0";
    }

    // Instantly move the camera to a very far altitude while everything is hidden.
    const pov = globeRef.current.pointOfView();
    const targetLat = pov?.lat ?? 20;
    const targetLng = pov?.lng ?? 0;
    globeRef.current.pointOfView({ lat: targetLat, lng: targetLng, altitude: 18.0 }, 0);

    // After the burst has spread, reveal the globe as a tiny distant speck and
    // zoom the camera in — the globe fades in AND grows simultaneously.
    const GLOBE_REVEAL_DELAY = 800;  // ms — let particles spread first
    const ZOOM_IN_DURATION   = 3800; // ms — long fly-in from deep space
    const FADE_IN_DURATION   = 3000; // ms — opacity 0 → 1 (starts at reveal)
    const revealTimer = setTimeout(() => {
      if (globeGroup) globeGroup.visible = true;
      // Fade the canvas in over FADE_IN_DURATION via CSS transition
      if (canvas) {
        canvas.style.transition = `opacity ${FADE_IN_DURATION}ms ease-in`;
        canvas.style.opacity    = "1";
      }
      const c = globeRef.current?.controls?.();
      if (c) c.autoRotate = false;
      globeRef.current?.pointOfView(
        { lat: targetLat, lng: targetLng, altitude: 2.0 },
        ZOOM_IN_DURATION,
      );
      // Re-arm auto-rotate after the fly-in settles
      setTimeout(() => {
        const ctrl = globeRef.current?.controls?.();
        if (ctrl) ctrl.autoRotate = true;
      }, ZOOM_IN_DURATION + 400);
    }, GLOBE_REVEAL_DELAY);

    // Particle loop — constant outward velocity, linear fade to black.
    const PARTICLE_DURATION = 1400; // particles fade out over this many ms
    const MAX_DIST = 700;           // maximum travel distance (plenty past camera far-plane)
    let startTime = null;
    const frame = (time) => {
      if (!startTime) startTime = time;
      const elapsed = time - startTime;
      const t = Math.min(elapsed / PARTICLE_DURATION, 1);

      for (let i = 0; i < N; i++) {
        const dist = t * MAX_DIST;
        pos[i * 3]     = origPos[i * 3]     + velocities[i * 3]     * dist;
        pos[i * 3 + 1] = origPos[i * 3 + 1] + velocities[i * 3 + 1] * dist;
        pos[i * 3 + 2] = origPos[i * 3 + 2] + velocities[i * 3 + 2] * dist;
      }
      geometry.attributes.position.needsUpdate = true;
      mat.opacity = 0.95 * (1 - t);  // linear fade — particles vanish as they travel

      if (t < 1) {
        animationFrameRef.current = requestAnimationFrame(frame);
      } else {
        scene.remove(particles);
        geometry.dispose();
        mat.dispose();
        animationFrameRef.current = null;
      }
    };

    animationFrameRef.current = requestAnimationFrame(frame);

    return () => {
      clearTimeout(revealTimer);
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
        animationFrameRef.current = null;
      }
      scene.remove(particles);
      geometry.dispose();
      mat.dispose();
      if (globeGroup) globeGroup.visible = true;
      if (canvas) {
        canvas.style.transition = "none";
        canvas.style.opacity    = "1";
      }
    };
  }, [explodeTrigger, theme]);

  // Build the rings dataset from points that have ring=true
  const ringsData = useMemo(
    () =>
      points
        .filter((p) => p.ring)
        .map((p) => ({ lat: p.lat, lng: p.lng, color: p.color || "#00d9ff" })),
    [points],
  );

  return (
    <div className="globe-canvas" ref={globeCanvasRef}>
      <Globe
        ref={globeRef}
        width={size.w}
        height={size.h}
        backgroundColor="rgba(0,0,0,0)"
        globeImageUrl={null}
        globeMaterial={globeMaterial}
        showAtmosphere={true}
        atmosphereColor={theme === "light" ? "#2bbfb0" : "#4cc9f0"}
        atmosphereAltitude={0.25}
        // Hexagonal country polygons — the dot-matrix look
        hexPolygonsData={countries.features}
        hexPolygonResolution={3}
        hexPolygonMargin={0.35}
        hexPolygonUseDots={true}
        hexPolygonColor={() => theme === "light" ? "rgba(26, 155, 143, 0.9)" : "rgba(0, 217, 255, 0.75)"}
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
