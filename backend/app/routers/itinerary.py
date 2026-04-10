"""Itinerary save/retrieve endpoints — in-memory store for MVP."""
from __future__ import annotations

import uuid

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

router = APIRouter(prefix="/itinerary", tags=["itinerary"])

_store: dict[str, dict] = {}


class SaveRequest(BaseModel):
    itinerary: dict


class SaveResponse(BaseModel):
    id: str


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
