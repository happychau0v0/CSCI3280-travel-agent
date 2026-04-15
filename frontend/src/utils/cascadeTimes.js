// ---------------------------------------------------------------------------
// Pure time-cascade helpers for the DAYS panel activity editor.
// Extracted from App.jsx so they can be unit-tested independently.
// ---------------------------------------------------------------------------

export function parseTimeToMinutes(timeStr) {
  if (!timeStr) return 0;
  const [h, m] = timeStr.split(":").map(Number);
  return (h || 0) * 60 + (m || 0);
}

export function minutesToTimeStr(totalMin) {
  const h = Math.floor(totalMin / 60) % 24;
  const m = totalMin % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

export function cascadeActivityTimes(activities, fromIdx) {
  // Recalculate start times for all activities after fromIdx based on:
  // next_start = prev_start + prev_duration + transit_duration
  const result = [...activities];
  for (let i = fromIdx + 1; i < result.length; i++) {
    const prev = result[i - 1];
    const curr = result[i];
    // Stop cascading when we hit a fixed time anchor (hotel check-in on
    // day 1, or the final hotel-return placeholder).
    const isLocked =
      curr.address === "hotel" ||
      (curr.name && curr.name.includes("Airport · Arrival"));
    if (isLocked) break;
    const prevStartMin = parseTimeToMinutes(prev.time);
    const prevDuration = prev.duration_min ?? 0;
    // Parse transit duration from strings like "22 min" or "1 hr 5 min".
    const transitStr = prev.transport_to_next?.duration ?? "0 min";
    const transitMin = transitStr.includes("hr")
      ? (() => {
          const hrMatch = transitStr.match(/(\d+)\s*hr/);
          const minMatch = transitStr.match(/(\d+)\s*min/);
          return (
            (hrMatch ? parseInt(hrMatch[1]) * 60 : 0) +
            (minMatch ? parseInt(minMatch[1]) : 0)
          );
        })()
      : parseInt(transitStr) || 0;
    const newStartMin = prevStartMin + prevDuration + transitMin;
    result[i] = { ...curr, time: minutesToTimeStr(newStartMin) };
  }
  return result;
}
