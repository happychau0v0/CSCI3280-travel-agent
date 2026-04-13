import { useCallback, useEffect, useState } from "react";
import { reverseGeocode } from "../api/client";

const SESSION_KEY = "travel-user-location";

/**
 * IP-based geolocation fallback for non-HTTPS origins (e.g. Tailscale IPs).
 * Uses ip-api.com free tier — no key required.
 * Returns a location object on success, null on failure.
 */
async function tryIpGeolocation() {
  try {
    const r = await fetch(
      "https://ip-api.com/json/?fields=status,city,country,lat,lon",
      { signal: AbortSignal.timeout(5000) },
    );
    const data = await r.json();
    if (data.status === "success" && data.lat != null) {
      return {
        lat: data.lat,
        lng: data.lon,
        city: data.city || "",
        country: data.country || "",
        formatted: data.city ? `${data.city}, ${data.country}` : `${data.lat.toFixed(2)}, ${data.lon.toFixed(2)}`,
        source: "ip",
      };
    }
  } catch {
    // network error or timeout — caller will set status "unavailable"
  }
  return null;
}

/**
 * Geolocation hook with reverse-geocoded city name.
 *
 * Returns {location, status, error, requestPermission, setManual} where:
 *   - location: {lat, lng, city, country, formatted} | null
 *   - status:   "idle" | "requesting" | "granted" | "denied" | "unavailable"
 *
 * Uses sessionStorage so reloads don't re-prompt the user. Auto-requests
 * on mount only if a previous session already granted permission (via
 * the Permissions API), otherwise waits for an explicit
 * `requestPermission()` call so the prompt is gestured-triggered.
 */
export function useGeolocation() {
  const [location, setLocation] = useState(() => {
    try {
      const cached = sessionStorage.getItem(SESSION_KEY);
      return cached ? JSON.parse(cached) : null;
    } catch {
      return null;
    }
  });
  const [status, setStatus] = useState(location ? "granted" : "idle");
  const [error, setError] = useState(null);

  const persist = useCallback((loc) => {
    setLocation(loc);
    try {
      sessionStorage.setItem(SESSION_KEY, JSON.stringify(loc));
    } catch {
      // ignore
    }
  }, []);

  const requestPermission = useCallback(async () => {
    if (!navigator.geolocation) {
      // No GPS API — likely a non-HTTPS origin (e.g. Tailscale IP).
      // Fall back to IP-based geolocation so the LIVE card still works.
      setStatus("requesting");
      const ipLoc = await tryIpGeolocation();
      if (ipLoc) {
        persist(ipLoc);
        setStatus("granted");
        return ipLoc;
      }
      setStatus("unavailable");
      setError(new Error("Geolocation is not supported in this browser."));
      return null;
    }

    setStatus("requesting");
    setError(null);

    try {
      const position = await new Promise((resolve, reject) => {
        navigator.geolocation.getCurrentPosition(resolve, reject, {
          enableHighAccuracy: false,
          timeout: 8000,
          maximumAge: 5 * 60 * 1000,
        });
      });

      const lat = position.coords.latitude;
      const lng = position.coords.longitude;

      // Reverse geocode through our backend so the API key stays server-side.
      let city = "";
      let country = "";
      let formatted = `${lat.toFixed(3)}, ${lng.toFixed(3)}`;
      try {
        const geo = await reverseGeocode(lat, lng);
        city = geo.city || "";
        country = geo.country || "";
        formatted = geo.formatted || formatted;
      } catch {
        // Backend down or key missing — keep the raw coordinates so the
        // globe still works, the chat just won't have a friendly city name.
      }

      const loc = { lat, lng, city, country, formatted };
      persist(loc);
      setStatus("granted");
      return loc;
    } catch (err) {
      // 1 = permission denied, 2 = position unavailable, 3 = timeout.
      // For denied/unavailable, try IP fallback so Tailscale users aren't stuck.
      const code = err?.code;
      if (code === 1 || code === 2) {
        const ipLoc = await tryIpGeolocation();
        if (ipLoc) {
          persist(ipLoc);
          setStatus("granted");
          return ipLoc;
        }
      }
      if (code === 1) setStatus("denied");
      else setStatus("unavailable");
      setError(err);
      return null;
    }
  }, [persist]);

  /** Manual override for users who deny GPS — no lat/lng, just a city name. */
  const setManual = useCallback(
    (city) => {
      const loc = { lat: null, lng: null, city, country: "", formatted: city };
      persist(loc);
      setStatus("granted");
      setError(null);
    },
    [persist],
  );

  // On mount: if the browser already remembers a permission grant for this
  // origin, fire the request silently. Otherwise stay idle until the user
  // clicks the "Locate me" affordance.
  useEffect(() => {
    if (location) return; // already have a cached location
    if (!navigator.permissions) return;

    let cancelled = false;
    (async () => {
      try {
        const result = await navigator.permissions.query({ name: "geolocation" });
        if (cancelled) return;
        if (result.state === "granted") {
          requestPermission();
        }
      } catch {
        // Permissions API not supported in this browser; just wait for click.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [location, requestPermission]);

  return { location, status, error, requestPermission, setManual };
}
