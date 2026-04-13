import { describe, it, expect } from "vitest";
import {
  decodePolyline,
  haversineKm,
  centroid,
  isAirportOutlier,
  computeBounds,
  greatCircleArc,
  splitArcAtAntimeridian,
  fibonacciDots,
} from "../mapUtils";

describe("haversineKm", () => {
  it("returns 0 for identical points", () => {
    expect(haversineKm([35.68, 139.69], [35.68, 139.69])).toBe(0);
  });

  it("computes HKG→NRT distance ~2960km (±50km)", () => {
    const d = haversineKm([22.308, 113.918], [35.764, 140.386]);
    expect(d).toBeGreaterThan(2910);
    expect(d).toBeLessThan(3010);
  });

  it("is symmetric", () => {
    const a = haversineKm([40.7128, -74.006], [51.5074, -0.1278]);
    const b = haversineKm([51.5074, -0.1278], [40.7128, -74.006]);
    expect(Math.abs(a - b)).toBeLessThan(0.01);
  });
});

describe("centroid", () => {
  it("returns null for empty array", () => {
    expect(centroid([])).toBeNull();
    expect(centroid(null)).toBeNull();
  });

  it("returns the point itself for single input", () => {
    expect(centroid([[10, 20]])).toEqual([10, 20]);
  });

  it("averages multiple points", () => {
    const c = centroid([[0, 0], [10, 10], [20, 20]]);
    expect(c[0]).toBeCloseTo(10);
    expect(c[1]).toBeCloseTo(10);
  });
});

describe("isAirportOutlier", () => {
  it("returns false when airport is null", () => {
    const r = isAirportOutlier([[35.68, 139.69]], null);
    expect(r.airportIsOutlier).toBe(false);
  });

  it("returns false when cluster is empty", () => {
    const r = isAirportOutlier([], [35.76, 140.38]);
    expect(r.airportIsOutlier).toBe(false);
  });

  it("returns true for NRT (60km from Tokyo centroid)", () => {
    const activities = [
      [35.68, 139.69], // Shinjuku
      [35.71, 139.79], // Senso-ji
      [35.66, 139.70], // Shibuya
    ];
    const r = isAirportOutlier(activities, [35.764, 140.386]); // NRT
    expect(r.airportIsOutlier).toBe(true);
    expect(r.distanceKm).toBeGreaterThan(40);
  });

  it("returns false for HND (within 20km of Tokyo centroid)", () => {
    const activities = [
      [35.68, 139.69],
      [35.71, 139.79],
      [35.66, 139.70],
    ];
    const r = isAirportOutlier(activities, [35.553, 139.779]); // HND
    expect(r.airportIsOutlier).toBe(false);
    expect(r.distanceKm).toBeLessThan(20);
  });

  it("honors custom threshold", () => {
    const activities = [[0, 0]];
    const airport = [0, 0.1]; // ~11km away
    expect(isAirportOutlier(activities, airport, 5).airportIsOutlier).toBe(true);
    expect(isAirportOutlier(activities, airport, 20).airportIsOutlier).toBe(false);
  });
});

describe("decodePolyline", () => {
  it("returns empty array for empty input", () => {
    expect(decodePolyline("")).toEqual([]);
    expect(decodePolyline(null)).toEqual([]);
  });

  // Google's reference example from their docs
  it("decodes Google reference string correctly", () => {
    const encoded = "_p~iF~ps|U_ulLnnqC_mqNvxq`@";
    const points = decodePolyline(encoded);
    expect(points.length).toBe(3);
    expect(points[0][0]).toBeCloseTo(38.5, 1);
    expect(points[0][1]).toBeCloseTo(-120.2, 1);
    expect(points[2][0]).toBeCloseTo(43.252, 1);
    expect(points[2][1]).toBeCloseTo(-126.453, 1);
  });
});

describe("computeBounds", () => {
  it("returns null for empty input", () => {
    expect(computeBounds([])).toBeNull();
    expect(computeBounds(null)).toBeNull();
  });

  it("computes min/max for multiple points", () => {
    const b = computeBounds([
      [10, 20],
      [30, 40],
      [-5, 100],
    ]);
    expect(b.minLat).toBe(-5);
    expect(b.maxLat).toBe(30);
    expect(b.minLng).toBe(20);
    expect(b.maxLng).toBe(100);
  });
});

describe("greatCircleArc", () => {
  it("preserves start and end points", () => {
    const arc = greatCircleArc([22.308, 113.918], [35.764, 140.386], 64);
    // GeoJSON order is [lng, lat]
    expect(arc[0][0]).toBeCloseTo(113.918, 2);
    expect(arc[0][1]).toBeCloseTo(22.308, 2);
    expect(arc[arc.length - 1][0]).toBeCloseTo(140.386, 2);
    expect(arc[arc.length - 1][1]).toBeCloseTo(35.764, 2);
  });

  it("has steps+1 points", () => {
    const arc = greatCircleArc([0, 0], [10, 10], 10);
    expect(arc.length).toBe(11);
  });

  it("returns a single point if start equals end", () => {
    const arc = greatCircleArc([10, 20], [10, 20]);
    expect(arc.length).toBe(1);
  });

  it("produces monotonic intermediate points along a short arc", () => {
    // HKG → Taipei (both in Asia, no antimeridian crossing)
    const arc = greatCircleArc([22.308, 113.918], [25.03, 121.21], 20);
    // Longitude should be monotonically increasing
    for (let i = 1; i < arc.length; i++) {
      expect(arc[i][0]).toBeGreaterThanOrEqual(arc[i - 1][0]);
    }
  });
});

describe("splitArcAtAntimeridian", () => {
  it("returns single segment when no crossing", () => {
    const coords = [[0, 0], [10, 10], [20, 20]];
    expect(splitArcAtAntimeridian(coords).length).toBe(1);
  });

  it("splits at antimeridian (long jump >180°)", () => {
    const coords = [
      [170, 0],
      [179, 0],
      [-179, 0], // crosses 180° antimeridian
      [-170, 0],
    ];
    const segments = splitArcAtAntimeridian(coords);
    expect(segments.length).toBe(2);
    expect(segments[0].length).toBe(2);
    expect(segments[1].length).toBe(2);
  });
});

describe("fibonacciDots", () => {
  it("generates requested count of features", () => {
    const fc = fibonacciDots(100);
    expect(fc.type).toBe("FeatureCollection");
    expect(fc.features.length).toBe(100);
  });

  it("all points are valid lat/lng", () => {
    const fc = fibonacciDots(500);
    for (const f of fc.features) {
      const [lng, lat] = f.geometry.coordinates;
      expect(lat).toBeGreaterThanOrEqual(-90);
      expect(lat).toBeLessThanOrEqual(90);
      expect(lng).toBeGreaterThanOrEqual(-180);
      expect(lng).toBeLessThanOrEqual(180);
    }
  });

  it("points are evenly distributed (no clumping)", () => {
    const fc = fibonacciDots(1000);
    // Count points in each hemisphere — should be roughly balanced
    let north = 0;
    let south = 0;
    for (const f of fc.features) {
      const lat = f.geometry.coordinates[1];
      if (lat > 0) north++;
      else south++;
    }
    // Should split roughly 50/50 (within 10%)
    expect(Math.abs(north - south)).toBeLessThan(100);
  });
});
