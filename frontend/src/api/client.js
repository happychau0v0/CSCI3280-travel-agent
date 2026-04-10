export const API_BASE = "http://localhost:8000";

/**
 * Build an absolute URL for a relative photo path returned from the backend
 * (e.g. "/photo/places/ChIJ.../photos/Ae...").
 */
export function photoSrc(relativePath) {
  if (!relativePath) return null;
  if (relativePath.startsWith("http")) return relativePath;
  return `${API_BASE}${relativePath}`;
}

export async function postChat(message, history = [], preferences = null) {
  const body = { message, history };
  if (preferences) body.preferences = preferences;

  const response = await fetch(`${API_BASE}/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    let detail = `HTTP ${response.status}`;
    try {
      const err = await response.json();
      detail = err.detail || detail;
    } catch {
      // ignore JSON parse errors
    }
    const error = new Error(detail);
    error.status = response.status;
    throw error;
  }
  return response.json();
}

export async function saveItinerary(itinerary) {
  const res = await fetch(`${API_BASE}/itinerary`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ itinerary }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function getItinerary(id) {
  const res = await fetch(`${API_BASE}/itinerary/${id}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/**
 * Reorder a list of activities for shortest total travel distance.
 * Each activity must have lat and lng. Other fields ride along in `extra`.
 */
export async function optimizeRoute(activities) {
  // Strip lat/lng/name out of each activity; everything else passes through.
  const payload = {
    activities: activities.map((a) => {
      const { lat, lng, name, ...extra } = a;
      return { name: name || "", lat, lng, extra };
    }),
  };
  const res = await fetch(`${API_BASE}/itinerary/optimize`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const err = await res.json();
      detail = err.detail || detail;
    } catch {
      // ignore
    }
    throw new Error(detail);
  }
  return res.json();
}
