import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import {
  fibonacciDots,
  filterDotsByCountries,
  greatCircleArc,
  splitArcAtAntimeridian,
  isAirportOutlier,
  decodePolyline,
} from "./mapUtils";

/**
 * MapView — unified MapLibre GL JS component that replaces the previous
 * react-globe.gl (HOME) and react-leaflet (HOTELS/DAYS) split architecture.
 *
 * Modes:
 *  - "globe": low-zoom globe view with Fibonacci dots (COBE-inspired)
 *             plus flight arcs and origin/destination pins
 *  - "hotels": city-zoom view with hotel pins + airport reference
 *  - "days": city-zoom view with activity pins + polylines + airport
 *
 * MapLibre 5.0's globe projection auto-transitions to Mercator between
 * zoom 6-12 via shader interpolation, producing a truly seamless camera
 * flight from orbit to street level.
 *
 * Ref API (via useImperativeHandle):
 *  - flyTo({ center, zoom, duration? }) — imperative camera fly
 *  - getMap() — escape hatch for debug
 */
const MapView = forwardRef(function MapView(props, ref) {
  const {
    mode = "globe",
    userLocation = null,
    arcs = [],
    points = [],
    hotels = [],
    selectedHotelIdx = 0,
    activities = [],
    activeActivityIdx = -1,
    airport = null,
    focus = null,
    reducedMotion = false,
  } = props;

  const containerRef = useRef(null);
  const mapRef = useRef(null);
  const [loaded, setLoaded] = useState(false);

  // Imperative API for App.jsx orchestration
  useImperativeHandle(
    ref,
    () => {
      const handle = {
        flyTo: (target) => {
          const map = mapRef.current;
          if (!map || !target) return;
          const opts = {
            center: [target.lng ?? target.center?.[0], target.lat ?? target.center?.[1]],
            zoom: target.zoom ?? 13,
            duration: reducedMotion ? 0 : (target.duration ?? 2200),
            essential: true,
          };
          if (reducedMotion) map.jumpTo(opts);
          else map.flyTo(opts);
        },
        resetToGlobe: () => {
          const map = mapRef.current;
          if (!map) return;
          const opts = { center: [0, 20], zoom: 1.5, duration: reducedMotion ? 0 : 1800 };
          if (reducedMotion) map.jumpTo(opts); else map.flyTo(opts);
        },
        getMap: () => mapRef.current,
      };
      // Expose on window so App.jsx panel-switch effect can call it
      // even if the React ref hasn't propagated yet (lazy-load timing).
      if (typeof window !== "undefined") window.__mapViewHandle = handle;
      return handle;
    },
    [reducedMotion],
  );

  // Initial mount — create the map instance once
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;

    // Custom NieR/COBE-style globe: dark space background, cyan
    // Fibonacci dot grid for landmass approximation, CartoCDN dark
    // raster tiles kick in at zoom >6 for city-level Mercator view.
    const style = {
      version: 8,
      name: "NieR Travel Agent",
      glyphs: "https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf",
      sources: {
        "fibonacci-dots": {
          type: "geojson",
          // Initial: full Fibonacci grid (placeholder while countries.geojson
          // loads). Replaced asynchronously below with land-only dots.
          data: fibonacciDots(15000),
        },
        "carto-dark": {
          type: "raster",
          tiles: [
            "https://a.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png",
            "https://b.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png",
            "https://c.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png",
            "https://d.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png",
          ],
          tileSize: 256,
          minzoom: 4,
          maxzoom: 19,
          attribution: "© OpenStreetMap contributors © CARTO",
        },
      },
      layers: [
        {
          id: "space-bg",
          type: "background",
          paint: { "background-color": "#02060d" },
        },
        {
          id: "fibonacci-dots-layer",
          type: "circle",
          source: "fibonacci-dots",
          // Dots fade out as we zoom in past the globe view
          paint: {
            "circle-radius": [
              "interpolate",
              ["linear"],
              ["zoom"],
              0, 2.4,
              2, 2.8,
              4, 2.0,
              6, 0,
            ],
            "circle-color": "#00d9ff",
            "circle-opacity": [
              "interpolate",
              ["linear"],
              ["zoom"],
              0, 1.0,
              3, 0.95,
              5, 0.4,
              6, 0,
            ],
            "circle-blur": 0.15,
          },
        },
        {
          id: "carto-tiles",
          type: "raster",
          source: "carto-dark",
          // City-level raster tiles fade in as the dots fade out
          paint: {
            "raster-opacity": [
              "interpolate",
              ["linear"],
              ["zoom"],
              4, 0,
              6, 0.5,
              8, 1,
            ],
          },
        },
      ],
      sky: {
        "atmosphere-blend": [
          "interpolate",
          ["linear"],
          ["zoom"],
          0, 1,
          5, 1,
          10, 0,
        ],
      },
    };

    const map = new maplibregl.Map({
      container: containerRef.current,
      style,
      center: [0, 20],
      zoom: 0,  // zoom 0 = full globe visible
      renderWorldCopies: false,
      attributionControl: false,
      fadeDuration: 300,
    });
    // Set globe projection AFTER map construction (some MapLibre v5
    // builds need this rather than the constructor option).
    map.on("style.load", () => {
      try { map.setProjection({ type: "globe" }); } catch { /* fallback to mercator */ }
    });
    mapRef.current = map;

    // Expose for E2E tests as a top-level window global (not __debug
    // because App.jsx overwrites __debug wholesale on every render).
    if (typeof window !== "undefined") {
      window.__mapInstance = map;
    }

    map.on("load", () => {
      setLoaded(true);
      if (typeof performance !== "undefined") {
        performance.mark?.("map-first-paint");
      }
    });

    // Slow auto-rotate for the globe view when idle
    let rotationStart = Date.now();
    let userInteracted = false;
    map.on("mousedown", () => { userInteracted = true; });
    map.on("wheel", () => { userInteracted = true; });
    const rotateFrame = () => {
      if (!mapRef.current) return;
      if (!userInteracted && mapRef.current.getZoom() < 3) {
        const elapsed = (Date.now() - rotationStart) / 1000;
        mapRef.current.setBearing((elapsed * 4) % 360);
      }
      requestAnimationFrame(rotateFrame);
    };
    if (!reducedMotion) requestAnimationFrame(rotateFrame);

    return () => {
      map.remove();
      mapRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Fetch countries.geojson + filter Fibonacci dots to land only.
  // This produces the COBE-like "continent constellation" effect —
  // ocean dots are removed so the dotted sphere shows recognizable
  // continent shapes instead of a uniform mesh.
  useEffect(() => {
    let cancelled = false;
    fetch("/data/countries.geojson")
      .then((r) => r.json())
      .then((countriesFC) => {
        if (cancelled) return;
        const allDots = fibonacciDots(15000);
        const landDots = filterDotsByCountries(allDots, countriesFC);
        // eslint-disable-next-line no-console
        console.log("[MapView] Filtered dots:", landDots.features.length, "of", allDots.features.length);
        // Apply on a 200ms tick to ensure map is ready
        const apply = () => {
          const map = mapRef.current;
          if (!map) return false;
          const src = map.getSource("fibonacci-dots");
          if (!src) return false;
          src.setData(landDots);
          // eslint-disable-next-line no-console
          console.log("[MapView] Applied land dots to source");
          return true;
        };
        if (!apply()) {
          // Retry on style load + a few timer ticks
          const tryAgain = () => { if (!cancelled) apply(); };
          mapRef.current?.once("style.load", tryAgain);
          mapRef.current?.once("load", tryAgain);
          setTimeout(tryAgain, 500);
          setTimeout(tryAgain, 1500);
        }
      })
      .catch((err) => {
        // eslint-disable-next-line no-console
        console.warn("[MapView] countries.geojson load failed:", err);
      });
    return () => { cancelled = true; };
  }, []);

  // Build GeoJSON for route polylines (DAYS mode — decoded transit routes)
  const polylinesGeoJSON = useMemo(() => {
    if (mode !== "days") return { type: "FeatureCollection", features: [] };
    const features = [];
    (activities || []).forEach((a, i) => {
      if (!a.transport_to_next?.polyline) return;
      const decoded = decodePolyline(a.transport_to_next.polyline);
      if (decoded.length < 2) return;
      // GeoJSON needs [lng, lat] order
      const coords = decoded.map(([lat, lng]) => [lng, lat]);
      const isActive = activeActivityIdx >= 0 && i === activeActivityIdx;
      features.push({
        type: "Feature",
        properties: { active: isActive },
        geometry: { type: "LineString", coordinates: coords },
      });
    });
    return { type: "FeatureCollection", features };
  }, [mode, activities, activeActivityIdx]);

  // Build GeoJSON for arcs (flight paths)
  const arcsGeoJSON = useMemo(() => {
    const features = [];
    for (const arc of arcs || []) {
      const start = [arc.startLat, arc.startLng];
      const end = [arc.endLat, arc.endLng];
      const coords = greatCircleArc(start, end, 64);
      const segments = splitArcAtAntimeridian(coords);
      for (const seg of segments) {
        features.push({
          type: "Feature",
          properties: { color: arc.color || "#00d9ff", label: arc.label || "" },
          geometry: { type: "LineString", coordinates: seg },
        });
      }
    }
    return { type: "FeatureCollection", features };
  }, [arcs]);

  // Build GeoJSON for points (origin/destination/activity/hotel pins)
  const pointsGeoJSON = useMemo(() => {
    const features = [];
    const allPoints = [];
    if (mode === "globe") {
      for (const p of points || []) allPoints.push(p);
    } else if (mode === "hotels") {
      (hotels || []).forEach((h, i) => {
        if (h.lat != null && h.lng != null) {
          allPoints.push({
            lat: h.lat,
            lng: h.lng,
            label: String(i + 1),
            kind: i === selectedHotelIdx ? "active" : "default",
          });
        }
      });
    } else if (mode === "days") {
      (activities || []).forEach((a, i) => {
        if (a.lat != null && a.lng != null) {
          let kind = "dim";
          if (activeActivityIdx >= 0) {
            if (i === activeActivityIdx) kind = "active";
            else if (i === activeActivityIdx + 1) kind = "default";
          } else {
            kind = "default";
          }
          allPoints.push({
            lat: a.lat,
            lng: a.lng,
            label: String(i + 1),
            kind,
          });
        }
      });
    }
    for (const p of allPoints) {
      features.push({
        type: "Feature",
        properties: {
          label: p.label || "",
          kind: p.kind || "default",
          color: p.color || "#00d9ff",
        },
        geometry: { type: "Point", coordinates: [p.lng, p.lat] },
      });
    }
    // Airport pin (always visible when present)
    if (airport && airport.lat != null && airport.lng != null) {
      // Detect outlier for styling
      const clusterPts = allPoints.map((p) => [p.lat, p.lng]);
      const { airportIsOutlier } = isAirportOutlier(clusterPts, [airport.lat, airport.lng]);
      features.push({
        type: "Feature",
        properties: {
          label: "✈",
          kind: airportIsOutlier ? "airport-distant" : "airport",
          color: "#5eead4",
        },
        geometry: { type: "Point", coordinates: [airport.lng, airport.lat] },
      });
    }
    return { type: "FeatureCollection", features };
  }, [mode, points, hotels, selectedHotelIdx, activities, activeActivityIdx, airport]);

  // Attach arcs + points sources+layers when map is loaded
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loaded) return;

    // Arcs source + layer
    if (!map.getSource("arcs")) {
      map.addSource("arcs", { type: "geojson", data: arcsGeoJSON });
      map.addLayer({
        id: "arcs-line",
        type: "line",
        source: "arcs",
        paint: {
          "line-color": ["get", "color"],
          "line-width": [
            "interpolate", ["linear"], ["zoom"],
            1, 1.5,
            5, 2.5,
          ],
          "line-opacity": 0.9,
          "line-blur": 0.5,
        },
      });
    } else {
      map.getSource("arcs").setData(arcsGeoJSON);
    }

    // Points source + layer
    if (!map.getSource("points")) {
      map.addSource("points", { type: "geojson", data: pointsGeoJSON });
      map.addLayer({
        id: "points-circle",
        type: "circle",
        source: "points",
        paint: {
          "circle-radius": [
            "match",
            ["get", "kind"],
            "active", 12,
            "airport", 14,
            "airport-distant", 10,
            "dim", 6,
            8,
          ],
          "circle-color": [
            "match",
            ["get", "kind"],
            "active", "#fbbf24",
            "airport", "#5eead4",
            "airport-distant", "#5eead4",
            "#00d9ff",
          ],
          "circle-stroke-width": 2,
          "circle-stroke-color": "#02060d",
          "circle-opacity": [
            "match",
            ["get", "kind"],
            "dim", 0.4,
            "airport-distant", 0.5,
            1,
          ],
        },
      });
    } else {
      map.getSource("points").setData(pointsGeoJSON);
    }

    // Polylines source + layer (DAYS mode route segments)
    if (!map.getSource("polylines")) {
      map.addSource("polylines", { type: "geojson", data: polylinesGeoJSON });
      map.addLayer(
        {
          id: "polylines-dim",
          type: "line",
          source: "polylines",
          filter: ["!=", ["get", "active"], true],
          paint: {
            "line-color": "#00d9ff",
            "line-width": 2,
            "line-opacity": 0.45,
            "line-dasharray": [4, 3],
          },
        },
        // Insert below points so pins render on top of routes
        "points-circle",
      );
      map.addLayer(
        {
          id: "polylines-active",
          type: "line",
          source: "polylines",
          filter: ["==", ["get", "active"], true],
          paint: {
            "line-color": "#fbbf24",
            "line-width": 3,
            "line-opacity": 0.9,
          },
        },
        "points-circle",
      );
    } else {
      map.getSource("polylines").setData(polylinesGeoJSON);
    }
  }, [loaded, arcsGeoJSON, pointsGeoJSON, polylinesGeoJSON]);

  // React to `focus` prop changes via imperative flyTo
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loaded || !focus) return;
    const opts = {
      center: [focus.lng, focus.lat],
      zoom: focus.zoom ?? (mode === "days" ? 13 : 12),
      duration: reducedMotion ? 0 : 2200,
      essential: true,
    };
    if (reducedMotion) map.jumpTo(opts); else map.flyTo(opts);
    if (typeof window !== "undefined") {
      window.__debug = window.__debug || {};
      window.__debug.mapFocus = focus;
      window.__debug.globeFocus = focus; // backward-compat alias
    }
  }, [focus, loaded, mode, reducedMotion]);

  // When mode switches, adjust zoom automatically if no explicit focus
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loaded) return;
    if (mode === "globe" && !focus) {
      const opts = { center: [0, 20], zoom: 1.5, duration: reducedMotion ? 0 : 1800 };
      if (reducedMotion) map.jumpTo(opts); else map.flyTo(opts);
    }
  }, [mode, loaded, focus, reducedMotion]);

  // Fly to selected hotel when selectedHotelIdx changes in hotels mode
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loaded || mode !== "hotels") return;
    const hotel = (hotels || [])[selectedHotelIdx];
    if (!hotel || hotel.lat == null || hotel.lng == null) return;
    const opts = {
      center: [hotel.lng, hotel.lat],
      zoom: 14,
      duration: reducedMotion ? 0 : 1200,
      essential: true,
    };
    if (reducedMotion) map.jumpTo(opts); else map.flyTo(opts);
  }, [selectedHotelIdx, loaded, mode, hotels, reducedMotion]);

  // Airport badge (DOM overlay) when airport is distant
  const airportBadge = useMemo(() => {
    if (!airport || airport.lat == null || airport.lng == null) return null;
    const clusterPts = [];
    if (mode === "hotels") {
      for (const h of hotels || []) {
        if (h.lat != null && h.lng != null) clusterPts.push([h.lat, h.lng]);
      }
    } else if (mode === "days") {
      for (const a of activities || []) {
        if (a.lat != null && a.lng != null) clusterPts.push([a.lat, a.lng]);
      }
    }
    const { airportIsOutlier, distanceKm } = isAirportOutlier(
      clusterPts,
      [airport.lat, airport.lng],
    );
    if (!airportIsOutlier) return null;
    return { iata: airport.iata, distanceKm };
  }, [mode, hotels, activities, airport]);

  const handleAirportBadgeClick = () => {
    const map = mapRef.current;
    if (!map || !airport) return;
    map.flyTo({
      center: [airport.lng, airport.lat],
      zoom: 11,
      duration: reducedMotion ? 0 : 1200,
    });
  };

  return (
    <div className="map-view-root">
      <div className="map-canvas" ref={containerRef} data-testid="maplibre-canvas" />
      {airportBadge && (
        <button
          type="button"
          className="day-mini-airport-badge map-airport-badge"
          onClick={handleAirportBadgeClick}
          data-testid="map-airport-badge"
          title={`Fly to ${airportBadge.iata || "airport"} (${Math.round(airportBadge.distanceKm)} km away)`}
        >
          ✈ {airportBadge.iata || "AIRPORT"} · {Math.round(airportBadge.distanceKm)}km ↗
        </button>
      )}
    </div>
  );
});

export default MapView;
