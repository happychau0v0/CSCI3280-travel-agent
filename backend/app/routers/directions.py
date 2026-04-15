from fastapi import APIRouter
from pydantic import BaseModel

from app.tools.directions import get_directions

router = APIRouter(prefix="/directions", tags=["directions"])


class DirectionsRequest(BaseModel):
    origin: str        # "lat,lng" string
    destination: str   # "lat,lng" string
    mode: str = "TRANSIT"


@router.post("")
async def directions(req: DirectionsRequest):
    """
    Direct directions lookup — bypasses the LLM tool loop.
    Used by the frontend for live route display when the user
    clicks an activity in the DAYS panel.
    """
    return await get_directions(req.origin, req.destination, req.mode)
