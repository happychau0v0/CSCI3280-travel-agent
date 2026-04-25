"""Google Geocoding API — convert a city name (or any address) to lat/lng.

Used in two places:
1. As an LLM tool (`geocode_city`) so the agent can pin destinations on the
   globe before drawing flight arcs.
2. By the /geo/reverse router for the GPS reverse-lookup flow.
"""
from __future__ import annotations

import httpx

from app.config import GOOGLE_MAPS_API_KEY, check_key, make_http_client
from app.tools.errors import ToolUnavailableError

# Module-level shared client: reuses TCP connections across calls.
_http = make_http_client(15.0)

GEOCODE_URL = "https://maps.googleapis.com/maps/api/geocode/json"


async def geocode_city(query: str) -> dict:
    """Look up the coordinates of a city or address.

    Returns a single best match:
        {
            "name": "Tokyo",
            "formatted": "Tokyo, Japan",
            "country": "Japan",
            "lat": 35.6762,
            "lng": 139.6503,
        }

    If no result is found, returns ``{"error": "No match for '...'"}``
    instead of raising — that way the LLM can recover gracefully.
    """
    if not check_key(GOOGLE_MAPS_API_KEY):
        raise ToolUnavailableError("GOOGLE_MAPS_API_KEY not configured")

    params = {
        "address": query,
        "key": GOOGLE_MAPS_API_KEY,
        # Restrict to localities and countries so we get clean city centroids
        # instead of street-level addresses.
        "result_type": "locality|administrative_area_level_1|country",
    }

    resp = await _http.get(GEOCODE_URL, params=params)
    resp.raise_for_status()
    data = resp.json()

    results = data.get("results", [])
    if not results:
        return {"error": f"No match for '{query}'"}

    best = results[0]
    loc = best["geometry"]["location"]

    # Extract the country from the address components if present.
    country = ""
    name = ""
    for comp in best.get("address_components", []):
        types = comp.get("types", [])
        if "country" in types:
            country = comp.get("long_name", "")
        if "locality" in types or "administrative_area_level_1" in types:
            if not name:
                name = comp.get("long_name", "")

    return {
        "name": name or best.get("formatted_address", query),
        "formatted": best.get("formatted_address", query),
        "country": country,
        "lat": loc["lat"],
        "lng": loc["lng"],
    }


async def reverse_geocode(lat: float, lng: float) -> dict:
    """Look up the city/country for a given lat/lng.

    Used by /geo/reverse to turn browser GPS coordinates into a friendly
    location label.
    """
    if not check_key(GOOGLE_MAPS_API_KEY):
        raise ToolUnavailableError("GOOGLE_MAPS_API_KEY not configured")

    params = {
        "latlng": f"{lat},{lng}",
        "key": GOOGLE_MAPS_API_KEY,
        "result_type": "locality|administrative_area_level_1|country",
    }

    resp = await _http.get(GEOCODE_URL, params=params)
    resp.raise_for_status()
    data = resp.json()

    results = data.get("results", [])
    if not results:
        return {"city": "", "country": "", "formatted": f"{lat:.3f}, {lng:.3f}"}

    best = results[0]
    city = ""
    country = ""
    for comp in best.get("address_components", []):
        types = comp.get("types", [])
        if "locality" in types and not city:
            city = comp.get("long_name", "")
        elif "administrative_area_level_1" in types and not city:
            city = comp.get("long_name", "")
        if "country" in types:
            country = comp.get("long_name", "")

    return {
        "city": city,
        "country": country,
        "formatted": best.get("formatted_address", f"{lat}, {lng}"),
    }
