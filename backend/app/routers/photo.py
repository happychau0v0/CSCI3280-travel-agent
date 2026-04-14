"""Photo proxy: streams Google Places photos with the server-side API key.

Frontend hits GET /photo/places/{place_id}/photos/{photo_id}
We forward to https://places.googleapis.com/v1/{path}/media?key=...&maxWidthPx=800
and stream the bytes back so the API key never reaches the browser.
"""
from __future__ import annotations

import httpx
from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse

from app.config import GOOGLE_MAPS_API_KEY, check_key

router = APIRouter(prefix="/photo", tags=["photo"])

PHOTO_BASE = "https://places.googleapis.com/v1"


@router.get("/{photo_name:path}")
async def get_photo(photo_name: str, max_width: int = 800):
    """Stream a Google Places photo through the backend.

    `photo_name` is the resource name returned by the Places API,
    e.g. `places/ChIJ.../photos/AeXyz...`.
    """
    if not check_key(GOOGLE_MAPS_API_KEY):
        raise HTTPException(status_code=503, detail="GOOGLE_MAPS_API_KEY not configured")

    upstream_url = f"{PHOTO_BASE}/{photo_name}/media"
    params = {"key": GOOGLE_MAPS_API_KEY, "maxWidthPx": max_width}

    client = httpx.AsyncClient(timeout=30.0, follow_redirects=True, trust_env=False)
    try:
        upstream = await client.get(upstream_url, params=params)
    except httpx.HTTPError as e:
        await client.aclose()
        raise HTTPException(status_code=502, detail=f"Upstream photo fetch failed: {e}") from e

    if upstream.status_code != 200:
        await client.aclose()
        raise HTTPException(
            status_code=upstream.status_code,
            detail=f"Upstream returned {upstream.status_code}",
        )

    content_type = upstream.headers.get("content-type", "image/jpeg")

    async def _stream():
        try:
            yield upstream.content
        finally:
            await client.aclose()

    return StreamingResponse(
        _stream(),
        media_type=content_type,
        headers={"Cache-Control": "public, max-age=86400"},
    )
