import { describe, it, expect } from "vitest";
import {
  parseTimeToMinutes,
  minutesToTimeStr,
  cascadeActivityTimes,
} from "./cascadeTimes";

// ---------------------------------------------------------------------------
// parseTimeToMinutes
// ---------------------------------------------------------------------------
describe("parseTimeToMinutes", () => {
  it('parses "09:00" → 540', () => {
    expect(parseTimeToMinutes("09:00")).toBe(540);
  });

  it('parses "00:00" → 0', () => {
    expect(parseTimeToMinutes("00:00")).toBe(0);
  });

  it('parses "23:59" → 1439', () => {
    expect(parseTimeToMinutes("23:59")).toBe(1439);
  });

  it("returns 0 for null", () => {
    expect(parseTimeToMinutes(null)).toBe(0);
  });

  it("returns 0 for undefined", () => {
    expect(parseTimeToMinutes(undefined)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// minutesToTimeStr
// ---------------------------------------------------------------------------
describe("minutesToTimeStr", () => {
  it("converts 540 → \"09:00\"", () => {
    expect(minutesToTimeStr(540)).toBe("09:00");
  });

  it("converts 0 → \"00:00\"", () => {
    expect(minutesToTimeStr(0)).toBe("00:00");
  });

  it("converts 1439 → \"23:59\"", () => {
    expect(minutesToTimeStr(1439)).toBe("23:59");
  });

  it("converts 61 → \"01:01\"", () => {
    expect(minutesToTimeStr(61)).toBe("01:01");
  });
});

// ---------------------------------------------------------------------------
// cascadeActivityTimes
// ---------------------------------------------------------------------------
describe("cascadeActivityTimes — basic cascade", () => {
  it("recalculates downstream times after a duration change at index 0", () => {
    const activities = [
      { name: "Museum",  time: "10:00", duration_min: 120, transport_to_next: { duration: "20 min" } },
      { name: "Lunch",   time: "12:00", duration_min: 60,  transport_to_next: { duration: "10 min" } },
      { name: "Temple",  time: "14:00", duration_min: 60,  transport_to_next: null },
    ];

    const result = cascadeActivityTimes(activities, 0);

    // Museum: 10:00 + 120 min + 20 min transit = 12:20 → Lunch
    expect(result[1].time).toBe("12:20");
    // Lunch: 12:20 + 60 min + 10 min transit = 13:30 → Temple
    expect(result[2].time).toBe("13:30");
  });
});

describe("cascadeActivityTimes — stops at hotel anchor", () => {
  it("does not change times of activities at or after a hotel anchor", () => {
    const activities = [
      { name: "Cafe",       time: "09:00", duration_min: 90, transport_to_next: { duration: "15 min" } },
      { name: "Park Hyatt", time: "10:15", address: "hotel", duration_min: 30, transport_to_next: null },
      { name: "Dinner",     time: "21:00", duration_min: 90, transport_to_next: null },
    ];

    // Cascade from index 0 (Cafe duration was just changed to 90 min)
    const result = cascadeActivityTimes(activities, 0);

    // Park Hyatt is a hotel anchor → its time must not be changed
    expect(result[1].time).toBe("10:15");
    // Dinner is after the anchor → also unchanged
    expect(result[2].time).toBe("21:00");
  });
});

describe("cascadeActivityTimes — stops at airport arrival anchor", () => {
  it("does not change times of activities at or after an Airport · Arrival anchor", () => {
    const activities = [
      { name: "Checkout",              time: "09:00", duration_min: 60, transport_to_next: { duration: "30 min" } },
      { name: "NRT Airport · Arrival", time: "10:00", duration_min: 60, transport_to_next: null },
      { name: "Hotel Check-in",        time: "11:30", duration_min: 30, transport_to_next: null },
    ];

    const result = cascadeActivityTimes(activities, 0);

    // Airport Arrival is a locked anchor → must remain at 10:00
    expect(result[1].time).toBe("10:00");
    // Hotel Check-in is after the anchor → also unchanged
    expect(result[2].time).toBe("11:30");
  });
});

describe("cascadeActivityTimes — parses \"1 hr 5 min\" transit", () => {
  it("correctly handles compound hour+minute transit strings", () => {
    const activities = [
      { name: "Activity A", time: "09:00", duration_min: 30, transport_to_next: { duration: "1 hr 5 min" } },
      { name: "Activity B", time: "10:35", duration_min: 60, transport_to_next: null },
    ];

    const result = cascadeActivityTimes(activities, 0);

    // 09:00 + 30 min + 65 min = 635 min = 10:35
    expect(result[1].time).toBe("10:35");
  });
});

describe("cascadeActivityTimes — does not mutate input", () => {
  it("returns a new array and leaves the original unchanged", () => {
    const original = [
      { name: "Museum",  time: "10:00", duration_min: 120, transport_to_next: { duration: "20 min" } },
      { name: "Lunch",   time: "12:00", duration_min: 60,  transport_to_next: null },
    ];
    const originalTime = original[1].time;

    const result = cascadeActivityTimes(original, 0);

    // Must be a different array reference
    expect(result).not.toBe(original);
    // Original item must be untouched
    expect(original[1].time).toBe(originalTime);
  });
});
