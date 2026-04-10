"""Google Places API (New) — search and details."""
from __future__ import annotations

import httpx

from app.config import GOOGLE_MAPS_API_KEY, check_key
from app.tools.errors import ToolUnavailableError

PLACES_SEARCH_URL = "https://places.googleapis.com/v1/places:searchText"
PLACES_DETAILS_URL = "https://places.googleapis.com/v1/places/{place_id}"

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

    The frontend prepends its API_BASE so the API key never reaches the browser.
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

    body: dict = {"textQuery": query if not location else f"{query} near {location}"}
    if location:
        body["pageSize"] = 10

    headers = {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": GOOGLE_MAPS_API_KEY,
        "X-Goog-FieldMask": SEARCH_FIELD_MASK,
    }

    async with httpx.AsyncClient(timeout=15.0) as client:
        resp = await client.post(PLACES_SEARCH_URL, json=body, headers=headers)
        resp.raise_for_status()
        data = resp.json()

    results = []
    for place in data.get("places", []):
        photos = place.get("photos") or []
        location = place.get("location") or {}
        results.append(
            {
                "place_id": place.get("id", ""),
                "name": place.get("displayName", {}).get("text", ""),
                "address": place.get("formattedAddress", ""),
                "rating": place.get("rating"),
                "price_level": place.get("priceLevel"),
                "photo_url": _photo_url(photos[0]["name"]) if photos else None,
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

    async with httpx.AsyncClient(timeout=15.0) as client:
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
