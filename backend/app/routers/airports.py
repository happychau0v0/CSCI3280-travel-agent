"""GET /airports/search?q=&limit= — typeahead airport search."""
from __future__ import annotations

from fastapi import APIRouter, Query

from app.tools.airports import search

router = APIRouter(prefix="/airports", tags=["airports"])


@router.get("/search")
async def search_airports(
    q: str = Query(default="", min_length=0, max_length=100),
    limit: int = Query(default=10, ge=1, le=30),
) -> list[dict]:
    """Return up to `limit` airports matching `q`.

    Searches IATA code, airport name, city, and country.
    Returns [{iata, name, city, country, lat, lng}, …].
    """
    if len(q.strip()) < 1:
        return []
    return search(q, limit=limit)
