"""Itinerary save/retrieve + route optimization endpoints."""
from __future__ import annotations

import uuid

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from app.optimize import optimize_order

router = APIRouter(prefix="/itinerary", tags=["itinerary"])

_store: dict[str, dict] = {}


class SaveRequest(BaseModel):
    itinerary: dict


class SaveResponse(BaseModel):
    id: str


class OptimizeActivity(BaseModel):
    """One stop in a request to /itinerary/optimize."""

    name: str = ""
    lat: float
    lng: float
    # Free-form passthrough so callers can attach time, address, photo_url, etc.
    # and get them back in the reordered output untouched.
    extra: dict = Field(default_factory=dict)


class OptimizeRequest(BaseModel):
    activities: list[OptimizeActivity]


class OptimizeResponse(BaseModel):
    ordered: list[dict]
    distance_km_before: float
    distance_km_after: float
    savings_pct: float


@router.post("", response_model=SaveResponse)
async def save_itinerary(req: SaveRequest) -> SaveResponse:
    """Persist an itinerary in memory and return its ID."""
    itinerary_id = uuid.uuid4().hex[:8]
    _store[itinerary_id] = req.itinerary
    return SaveResponse(id=itinerary_id)


@router.get("/{itinerary_id}")
async def get_itinerary(itinerary_id: str) -> dict:
    """Retrieve a previously-saved itinerary by ID."""
    if itinerary_id not in _store:
        raise HTTPException(status_code=404, detail="Itinerary not found")
    return _store[itinerary_id]


@router.post("/optimize", response_model=OptimizeResponse)
async def optimize_route(req: OptimizeRequest) -> OptimizeResponse:
    """Reorder a list of activities for shortest total travel distance.

    Uses nearest-neighbor + 2-opt (see app/optimize.py). Coordinates with
    null lat/lng are rejected — the LLM is supposed to populate them from
    search_places results.
    """
    if len(req.activities) < 2:
        raise HTTPException(
            status_code=400,
            detail="Need at least 2 activities with lat/lng to optimize",
        )

    points = [(a.lat, a.lng) for a in req.activities]
    order, before, after = optimize_order(points)

    ordered = [
        {"name": req.activities[i].name, "lat": req.activities[i].lat, "lng": req.activities[i].lng, **req.activities[i].extra}
        for i in order
    ]

    savings_pct = 0.0 if before == 0 else max(0.0, (before - after) / before * 100.0)

    return OptimizeResponse(
        ordered=ordered,
        distance_km_before=round(before, 3),
        distance_km_after=round(after, 3),
        savings_pct=round(savings_pct, 1),
    )
