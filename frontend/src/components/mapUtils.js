/**
 * Pure utility functions for map geometry, extracted from DayMiniMap /
 * HotelsMap / GlobeView so they can be:
 *  1. Unit-tested in isolation (no DOM, no Leaflet, no Three.js)
 *  2. Shared between the legacy Leaflet components and the new MapLibre
 *     MapView during migration
 *  3. Reused for great-circle arc interpolation (needed for MapLibre's
 *     GeoJSON-based flight paths, since MapLibre has no "arc" primitive)
 */

/**
 * Decode a Google encoded polyline string into [[lat, lng], ...] tuples.
 * Uses the standard Google Encoded Polyline Algorithm Format.
 */
export function decodePolyline(encoded) {
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
export function haversineKm(a, b) {
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

/** Compute a centroid (average lat/lng) of [[lat, lng], ...] points. */
export function centroid(pts) {
  if (!pts || !pts.length) return null;
  const sumLat = pts.reduce((s, p) => s + p[0], 0);
  const sumLng = pts.reduce((s, p) => s + p[1], 0);
  return [sumLat / pts.length, sumLng / pts.length];
}

/**
 * Decide whether the airport is an "outlier" — far from the cluster of
 * activity/hotel coords. If so, the map should fit only to the cluster;
 * the airport gets a small corner badge with a flyTo button instead.
 * Returns { airportIsOutlier: boolean, distanceKm: number }.
 */
export function isAirportOutlier(clusterPoints, airportPoint, thresholdKm = 20) {
  if (!airportPoint || !clusterPoints || clusterPoints.length === 0) {
    return { airportIsOutlier: false, distanceKm: 0 };
  }
  const c = centroid(clusterPoints);
  if (!c) return { airportIsOutlier: false, distanceKm: 0 };
  const distFromCentroid = haversineKm(airportPoint, c);
  return {
    airportIsOutlier: distFromCentroid > thresholdKm,
    distanceKm: distFromCentroid,
  };
}

/**
 * Compute a bounding box for [[lat, lng], ...] points.
 * Returns { minLat, maxLat, minLng, maxLng } or null if empty.
 */
export function computeBounds(pts) {
  if (!pts || !pts.length) return null;
  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLng = Infinity;
  let maxLng = -Infinity;
  for (const [lat, lng] of pts) {
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
    if (lng < minLng) minLng = lng;
    if (lng > maxLng) maxLng = lng;
  }
  return { minLat, maxLat, minLng, maxLng };
}

/**
 * Generate an array of [lng, lat] points approximating a great-circle arc
 * between two [lat, lng] endpoints. Used for MapLibre flight-path rendering
 * since MapLibre has no native arc primitive — we interpolate a LineString.
 *
 * Handles antimeridian crossing by splitting into two segments when the
 * arc crosses ±180° longitude. Returns a GeoJSON-ready coordinate array.
 *
 * @param {[number, number]} start - [lat, lng]
 * @param {[number, number]} end - [lat, lng]
 * @param {number} steps - number of intermediate points (default 64)
 * @returns {Array<Array<number>>} [[lng, lat], ...] — GeoJSON order!
 */
export function greatCircleArc(start, end, steps = 64) {
  const [lat1, lng1] = start;
  const [lat2, lng2] = end;
  const toRad = (deg) => (deg * Math.PI) / 180;
  const toDeg = (rad) => (rad * 180) / Math.PI;

  const φ1 = toRad(lat1);
  const λ1 = toRad(lng1);
  const φ2 = toRad(lat2);
  const λ2 = toRad(lng2);

  // Angular distance between points (haversine on unit sphere)
  const d =
    2 *
    Math.asin(
      Math.sqrt(
        Math.sin((φ2 - φ1) / 2) ** 2 +
          Math.cos(φ1) * Math.cos(φ2) * Math.sin((λ2 - λ1) / 2) ** 2,
      ),
    );

  if (d === 0) return [[lng1, lat1]]; // start === end

  const coords = [];
  for (let i = 0; i <= steps; i++) {
    const f = i / steps;
    const A = Math.sin((1 - f) * d) / Math.sin(d);
    const B = Math.sin(f * d) / Math.sin(d);
    const x = A * Math.cos(φ1) * Math.cos(λ1) + B * Math.cos(φ2) * Math.cos(λ2);
    const y = A * Math.cos(φ1) * Math.sin(λ1) + B * Math.cos(φ2) * Math.sin(λ2);
    const z = A * Math.sin(φ1) + B * Math.sin(φ2);
    const φ = Math.atan2(z, Math.sqrt(x * x + y * y));
    const λ = Math.atan2(y, x);
    coords.push([toDeg(λ), toDeg(φ)]); // [lng, lat] for GeoJSON
  }
  return coords;
}

/**
 * Split a great-circle arc at the antimeridian (±180° longitude) so
 * MapLibre doesn't draw a straight line across the map. Returns an array
 * of arc segments, each a [[lng, lat], ...] array.
 *
 * Example: HKG (114°E) → LAX (118°W) crosses the Pacific via antimeridian.
 * Naive line draws a horrible horizontal line. We emit two segments.
 */
export function splitArcAtAntimeridian(coords) {
  if (!coords || coords.length < 2) return [coords];
  const segments = [];
  let current = [coords[0]];
  for (let i = 1; i < coords.length; i++) {
    const [prevLng] = coords[i - 1];
    const [currLng] = coords[i];
    // Detect antimeridian crossing: longitude jumps by >180° between points
    if (Math.abs(currLng - prevLng) > 180) {
      segments.push(current);
      current = [coords[i]];
    } else {
      current.push(coords[i]);
    }
  }
  if (current.length > 0) segments.push(current);
  return segments;
}

/**
 * Generate a Fibonacci-sphere dot grid as a GeoJSON FeatureCollection.
 * These dots are used to give the MapLibre globe a COBE-like dotted
 * aesthetic. Evenly distributes N points on a sphere using the golden
 * angle; returns [lng, lat] pairs as GeoJSON Point features.
 *
 * @param {number} count - number of dots (3000-5000 is a good range)
 * @returns {object} GeoJSON FeatureCollection with Point features
 */
export function fibonacciDots(count = 4000) {
  const features = [];
  const goldenAngle = Math.PI * (3 - Math.sqrt(5)); // ≈ 2.399963...
  for (let i = 0; i < count; i++) {
    // y goes from 1 to -1 linearly; radius is a circle around it
    const y = 1 - (i / (count - 1)) * 2;
    const radius = Math.sqrt(1 - y * y);
    const theta = goldenAngle * i;
    const x = Math.cos(theta) * radius;
    const z = Math.sin(theta) * radius;
    // Convert unit sphere (x, y, z) to (lat, lng) in degrees
    const lat = (Math.asin(y) * 180) / Math.PI;
    const lng = (Math.atan2(z, x) * 180) / Math.PI;
    features.push({
      type: "Feature",
      properties: {},
      geometry: { type: "Point", coordinates: [lng, lat] },
    });
  }
  return { type: "FeatureCollection", features };
}

/**
 * Point-in-polygon test using ray casting (Jordan curve theorem).
 * @param {[number, number]} point - [lng, lat]
 * @param {Array<Array<[number, number]>>} polygon - array of rings;
 *   first ring is outer, rest are holes. Each ring is [[lng, lat], ...]
 * @returns {boolean}
 */
export function pointInPolygon(point, polygon) {
  if (!polygon || polygon.length === 0) return false;
  const [x, y] = point;
  let inside = false;
  // Check outer ring
  const ring = polygon[0];
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    const intersect =
      yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  if (!inside) return false;
  // Subtract holes
  for (let h = 1; h < polygon.length; h++) {
    const hole = polygon[h];
    let inHole = false;
    for (let i = 0, j = hole.length - 1; i < hole.length; j = i++) {
      const [xi, yi] = hole[i];
      const [xj, yj] = hole[j];
      const intersect =
        yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
      if (intersect) inHole = !inHole;
    }
    if (inHole) return false;
  }
  return true;
}

/**
 * Filter a FibonacciDots FeatureCollection to keep only points that fall
 * inside one of the provided country polygons. This produces the COBE-like
 * "continent dot constellation" effect — only land dots remain, ocean
 * dots are removed so continents become visible on the dark sphere.
 *
 * @param {object} dotsFC - FeatureCollection of Point features (from fibonacciDots)
 * @param {object} countriesFC - FeatureCollection of country Polygon/MultiPolygon features
 * @returns {object} filtered FeatureCollection
 */
export function filterDotsByCountries(dotsFC, countriesFC) {
  if (!dotsFC?.features?.length || !countriesFC?.features?.length) return dotsFC;

  // Pre-compute country bounding boxes for fast rejection
  const countries = [];
  for (const f of countriesFC.features) {
    const geom = f.geometry;
    if (!geom) continue;
    const polygons = [];
    if (geom.type === "Polygon") polygons.push(geom.coordinates);
    else if (geom.type === "MultiPolygon") {
      for (const p of geom.coordinates) polygons.push(p);
    }
    for (const poly of polygons) {
      const ring = poly[0];
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      for (const [x, y] of ring) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
      countries.push({ poly, bbox: [minX, minY, maxX, maxY] });
    }
  }

  const kept = [];
  for (const dot of dotsFC.features) {
    const [lng, lat] = dot.geometry.coordinates;
    for (const { poly, bbox } of countries) {
      if (lng < bbox[0] || lng > bbox[2] || lat < bbox[1] || lat > bbox[3]) continue;
      if (pointInPolygon([lng, lat], poly)) {
        kept.push(dot);
        break;
      }
    }
  }
  return { type: "FeatureCollection", features: kept };
}
