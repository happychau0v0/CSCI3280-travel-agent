"""Google Places API (New) — search and details.

Two functions exposed to the LLM as tools:

- ``search_places(query, location?, radius_km?)`` — text search for any
  query like "best ramen in Tokyo", returns a list of normalized result
  dicts.
- ``get_place_details(place_id)`` — fetch hours, reviews, photos, and
  full description for a specific place.

Both functions hit the *Places API (New)*, which is a different surface
from the legacy Places API. The new API uses GET/POST with two required
headers:

- ``X-Goog-Api-Key`` — the Google Maps Platform API key. We send it in
  the header rather than the query string so it doesn't end up in
  request logs.
- ``X-Goog-FieldMask`` — a comma-separated list of fields to return.
  This is *required*; the API rejects requests without it. Field masks
  are also how Google bills the API: requesting fewer fields is cheaper.

Photo URLs are returned as relative paths (``/photo/places/...``) that
hit our backend proxy in ``app/routers/photo.py``. This lets the
frontend render images via ``<img src=...>`` without ever seeing the
API key.
"""
from __future__ import annotations

import httpx

from app.config import GOOGLE_MAPS_API_KEY, check_key
from app.tools.errors import ToolUnavailableError

PLACES_SEARCH_URL = "https://places.googleapis.com/v1/places:searchText"
PLACES_DETAILS_URL = "https://places.googleapis.com/v1/places/{place_id}"

# Field masks select which fields the API returns. The set below covers
# everything ItineraryCard renders (photo, location, rating, address) plus
# the place_id we need to call get_place_details later. Adding more fields
# costs more per request — see Google's pricing tiers for the breakdown.
SEARCH_FIELD_MASK = (
    "places.id,places.displayName,places.formattedAddress,places.location,"
    "places.rating,places.photos,places.priceLevel"
)
DETAILS_FIELD_MASK = (
    "id,displayName,formattedAddress,location,editorialSummary,"
    "regularOpeningHours,reviews,photos,priceLevel,rating,websiteUri"
)


def _photo_url(photo_name: str) -> str:
    """Return a relative URL pointing at our backend photo proxy.

    The Places API returns photos as resource names like
    ``places/ChIJ.../photos/Ae...``. The actual image bytes live behind
    ``https://places.googleapis.com/v1/{name}/media?key=...`` which would
    expose our key if we sent that URL to the browser. Instead we send the
    relative path ``/photo/{name}`` and let our backend proxy
    (``app/routers/photo.py``) substitute the key server-side.
    """
    return f"/photo/{photo_name}"


async def search_places(
    query: str,
    location: str | None = None,
    radius_km: float = 5.0,
) -> list[dict]:
    """Search for places matching a text query.

    Returns a list of {name, address, rating, photo_url, place_id, price_level}.
    """
    if not check_key(GOOGLE_MAPS_API_KEY):
        raise ToolUnavailableError("GOOGLE_MAPS_API_KEY not configured")

    # pageSize is the max results we want back. 20 gives the LLM room
    # to pick 5-8 diverse hotels / activities while still keeping the
    # response small enough to not blow the model context.
    #
    # Round 11 — ALWAYS set pageSize. Google Places (New) defaults
    # pageSize to 1 when omitted, which previously collapsed the
    # entire itinerary to 1 hotel / 1 activity / 1 restaurant whenever
    # the LLM called this tool without the optional `location` arg.
    body: dict = {
        "textQuery": f"{query} near {location}" if location else query,
        "pageSize": 20,
    }

    headers = {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": GOOGLE_MAPS_API_KEY,
        "X-Goog-FieldMask": SEARCH_FIELD_MASK,
    }

    async with httpx.AsyncClient(timeout=15.0, trust_env=False) as client:
        resp = await client.post(PLACES_SEARCH_URL, json=body, headers=headers)
        resp.raise_for_status()
        data = resp.json()

    results = []
    for place in data.get("places", []):
        photos = place.get("photos") or []
        location = place.get("location") or {}
        photo_urls = [_photo_url(p["name"]) for p in photos[:10] if p.get("name")]
        results.append(
            {
                "place_id": place.get("id", ""),
                "name": place.get("displayName", {}).get("text", ""),
                "address": place.get("formattedAddress", ""),
                "rating": place.get("rating"),
                "price_level": place.get("priceLevel"),
                # Backcompat: the existing itinerary schema references
                # photo_url as the primary image.
                "photo_url": photo_urls[0] if photo_urls else None,
                # New in round 9: multi-photo gallery (up to 5 images)
                "photos": photo_urls,
                "lat": location.get("latitude"),
                "lng": location.get("longitude"),
            }
        )
    return results


async def get_place_details(place_id: str) -> dict:
    """Get detailed info for a place by its ID."""
    if not check_key(GOOGLE_MAPS_API_KEY):
        raise ToolUnavailableError("GOOGLE_MAPS_API_KEY not configured")

    headers = {
        "X-Goog-Api-Key": GOOGLE_MAPS_API_KEY,
        "X-Goog-FieldMask": DETAILS_FIELD_MASK,
    }
    url = PLACES_DETAILS_URL.format(place_id=place_id)

    async with httpx.AsyncClient(timeout=15.0, trust_env=False) as client:
        resp = await client.get(url, headers=headers)
        resp.raise_for_status()
        data = resp.json()

    hours = []
    if data.get("regularOpeningHours"):
        hours = data["regularOpeningHours"].get("weekdayDescriptions", [])

    reviews = []
    for r in (data.get("reviews") or [])[:5]:
        reviews.append(
            {
                "text": r.get("text", {}).get("text", ""),
                "rating": r.get("rating"),
            }
        )

    photos = [_photo_url(p["name"]) for p in (data.get("photos") or [])[:5]]
    location = data.get("location") or {}

    return {
        "place_id": data.get("id", place_id),
        "name": data.get("displayName", {}).get("text", ""),
        "address": data.get("formattedAddress", ""),
        "description": data.get("editorialSummary", {}).get("text", ""),
        "hours": hours,
        "reviews": reviews,
        "photos": photos,
        "price_level": data.get("priceLevel"),
        "rating": data.get("rating"),
        "website": data.get("websiteUri"),
        "lat": location.get("latitude"),
        "lng": location.get("longitude"),
    }
