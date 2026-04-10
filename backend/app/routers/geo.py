"""Geo helper endpoints — reverse geocoding for browser GPS lookups.

The frontend gets lat/lng from `navigator.geolocation` but can't call
Google Geocoding directly without exposing the API key. This router
proxies the call server-side and caches the result so noisy GPS jitter
doesn't waste quota.
"""
from __future__ import annotations

from collections import OrderedDict

from fastapi import APIRouter, HTTPException

from app.tools.errors import ToolUnavailableError
from app.tools.geocode import reverse_geocode

router = APIRouter(prefix="/geo", tags=["geo"])

# Tiny LRU cache keyed by rounded (3 decimal place) lat/lng. 3 dp ≈ 100m
# precision, which is well below GPS noise so consecutive prompts from the
# same physical spot share an entry. Cap at 256 entries to bound memory.
_CACHE: "OrderedDict[tuple[float, float], dict]" = OrderedDict()
_CACHE_MAX = 256


def _cache_key(lat: float, lng: float) -> tuple[float, float]:
    return (round(lat, 3), round(lng, 3))


@router.get("/reverse")
async def get_reverse_geocode(lat: float, lng: float) -> dict:
    """Look up the city/country for a given lat/lng pair."""
    key = _cache_key(lat, lng)
    if key in _CACHE:
        # Touch for LRU.
        _CACHE.move_to_end(key)
        return _CACHE[key]

    try:
        result = await reverse_geocode(lat, lng)
    except ToolUnavailableError as e:
        raise HTTPException(status_code=503, detail=str(e)) from e
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Geocoding failed: {e}") from e

    _CACHE[key] = result
    if len(_CACHE) > _CACHE_MAX:
        _CACHE.popitem(last=False)
    return result
