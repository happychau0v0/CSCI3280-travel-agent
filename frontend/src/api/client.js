// Derive the backend URL from the current page so it follows whatever
// hostname the user loaded the frontend from (localhost, a Tailscale
// IP, a LAN IP, etc). In the browser, `localhost` always resolves to
// the user's own machine — a remote user over Tailscale would try to
// hit their own laptop which has no backend, and see a network error.
//
// Override with VITE_API_BASE when hosting the frontend and backend
// on separate origins (e.g. deploying to a cloud host).
function resolveApiBase() {
  // Build-time override wins if set.
  const envBase = import.meta.env?.VITE_API_BASE;
  if (envBase) return envBase.replace(/\/$/, "");
  if (typeof window === "undefined") return "http://localhost:8000";
  // Use the hostname the frontend was loaded from, and the configured
  // backend port (8000 by default; override via VITE_API_PORT).
  const port = import.meta.env?.VITE_API_PORT || "8000";
  return `${window.location.protocol}//${window.location.hostname}:${port}`;
}

export const API_BASE = resolveApiBase();

/**
 * Build an absolute URL for a relative photo path returned from the backend
 * (e.g. "/photo/places/ChIJ.../photos/Ae...").
 */
export function photoSrc(relativePath) {
  if (!relativePath) return null;
  if (relativePath.startsWith("http")) return relativePath;
  return `${API_BASE}${relativePath}`;
}

export async function postChat(
  message,
  history = [],
  preferences = null,
  userLocation = null,
) {
  const body = { message, history };
  if (preferences) body.preferences = preferences;
  if (userLocation) body.user_location = userLocation;

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
 * Reverse-geocode a lat/lng pair to {city, country, formatted}.
 * Hits our backend proxy so the Google Maps API key stays server-side.
 */
export async function reverseGeocode(lat, lng) {
  const res = await fetch(`${API_BASE}/geo/reverse?lat=${lat}&lng=${lng}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/**
 * Stream a chat request via Server-Sent Events. Calls onEvent({type, data})
 * for each event the backend emits — tool_start, tool_end, done, error.
 *
 * Returns a promise that resolves with the final "done" payload or
 * rejects on error.
 */
export async function streamChat({
  message,
  history = [],
  preferences = null,
  userLocation = null,
  tripDates = null,
  llmModel = null,
  callRole = null,
  onEvent,
}) {
  const body = { message, history };
  if (preferences) body.preferences = preferences;
  if (userLocation) body.user_location = userLocation;
  if (tripDates) body.trip_dates = tripDates;
  if (llmModel) body.preferred_model = llmModel;
  if (callRole) body.call_role = callRole;

  // 90-second overall abort: if the backend crashes or the API stalls
  // mid-stream, reader.read() would block forever without this guard.
  const controller = new AbortController();
  const abortTimer = setTimeout(() => controller.abort(), 90_000);

  let response;
  try {
    response = await fetch(`${API_BASE}/chat/stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(abortTimer);
    if (err.name === "AbortError") throw new Error("Request timed out after 90 s");
    throw err;
  }

  if (!response.ok || !response.body) {
    clearTimeout(abortTimer);
    throw new Error(`HTTP ${response.status}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let final = null;

  try {
  while (true) {
    let chunk;
    try {
      chunk = await reader.read();
    } catch (err) {
      if (err.name === "AbortError") throw new Error("Request timed out after 90 s");
      throw err;
    }
    const { done, value } = chunk;
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    // SSE events are separated by blank lines (\n\n)
    let separatorIdx;
    while ((separatorIdx = buffer.indexOf("\n\n")) !== -1) {
      const rawEvent = buffer.slice(0, separatorIdx);
      buffer = buffer.slice(separatorIdx + 2);

      const lines = rawEvent.split("\n");
      let eventType = "message";
      let dataStr = "";
      for (const line of lines) {
        if (line.startsWith("event:")) {
          eventType = line.slice(6).trim();
        } else if (line.startsWith("data:")) {
          dataStr += line.slice(5).trim();
        }
      }
      if (!dataStr) continue;

      let data;
      try {
        data = JSON.parse(dataStr);
      } catch {
        continue;
      }

      // Timestamp each event for per-event benchmark analysis. The
      // window.__sseEvents buffer is read by scripts/benchmark-round8.mjs
      // to produce per-tool duration rows. Guarded by DEV flag.
      if (typeof window !== "undefined" && import.meta.env.DEV) {
        if (!window.__sseEvents) window.__sseEvents = [];
        window.__sseEvents.push({
          type: eventType,
          data,
          at: Date.now(),
        });
      }

      onEvent?.({ type: eventType, data });

      if (eventType === "done") {
        final = data;
      } else if (eventType === "error") {
        const err = new Error(data.message || "stream error");
        err.status = data.status;
        throw err;
      }
    }
  }

  } finally {
    clearTimeout(abortTimer);
    reader.releaseLock();
  }

  return final;
}

/**
 * Live directions lookup — used by the DAYS panel to show real-time routes
 * on the map when the user clicks an activity. Bypasses the LLM tool loop.
 * Returns { polyline, duration, distance, steps } or null on error.
 */
export async function getDirections(origin, destination, mode = "TRANSIT") {
  try {
    const res = await fetch(`${API_BASE}/api/directions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ origin, destination, mode }),
    });
    if (!res.ok) return null;
    return res.json();
  } catch {
    return null;
  }
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
