"""Google Routes API — compute route between origin and destination."""
from __future__ import annotations

import re

import httpx

from app.config import GOOGLE_MAPS_API_KEY, check_key
from app.tools.errors import ToolUnavailableError

ROUTES_URL = "https://routes.googleapis.com/directions/v2:computeRoutes"

ROUTES_FIELD_MASK = (
    "routes.duration,routes.distanceMeters,routes.polyline.encodedPolyline,"
    "routes.legs.steps.navigationInstruction,routes.legs.steps.distanceMeters,"
    "routes.legs.steps.staticDuration"
)

VALID_MODES = {"DRIVE", "WALK", "BICYCLE", "TRANSIT", "TWO_WHEELER"}


def _strip_html(text: str) -> str:
    return re.sub(r"<[^>]+>", "", text or "")


def _format_duration(duration_str: str) -> str:
    """Convert protobuf '1234s' to '20 min' or '2h 5min'."""
    if not duration_str:
        return ""
    m = re.match(r"(\d+)s", duration_str)
    if not m:
        return duration_str
    seconds = int(m.group(1))
    minutes = seconds // 60
    if minutes < 60:
        return f"{minutes} min"
    hours, mins = divmod(minutes, 60)
    return f"{hours}h {mins}min" if mins else f"{hours}h"


def _format_distance(meters: int) -> str:
    if not meters:
        return ""
    if meters < 1000:
        return f"{meters} m"
    return f"{meters / 1000:.1f} km"


async def get_directions(
    origin: str,
    destination: str,
    mode: str = "TRANSIT",
) -> dict:
    """Compute a route from origin to destination.

    Args:
        origin: address or lat,lng string
        destination: address or lat,lng string
        mode: DRIVE, WALK, BICYCLE, TRANSIT, or TWO_WHEELER

    Returns:
        {duration, distance, steps[{instruction, distance, duration}], polyline}
    """
    if not check_key(GOOGLE_MAPS_API_KEY):
        raise ToolUnavailableError("GOOGLE_MAPS_API_KEY not configured")

    travel_mode = mode.upper()
    if travel_mode not in VALID_MODES:
        travel_mode = "TRANSIT"

    body = {
        "origin": {"address": origin},
        "destination": {"address": destination},
        "travelMode": travel_mode,
        "polylineQuality": "OVERVIEW",
    }
    headers = {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": GOOGLE_MAPS_API_KEY,
        "X-Goog-FieldMask": ROUTES_FIELD_MASK,
    }

    async with httpx.AsyncClient(timeout=15.0, trust_env=False) as client:
        resp = await client.post(ROUTES_URL, json=body, headers=headers)
        resp.raise_for_status()
        data = resp.json()

    routes = data.get("routes", [])
    if not routes:
        return {"duration": "", "distance": "", "steps": [], "polyline": ""}

    route = routes[0]
    steps = []
    for leg in route.get("legs", []):
        for step in leg.get("steps", []):
            instr = step.get("navigationInstruction", {}).get("instructions", "")
            steps.append(
                {
                    "instruction": _strip_html(instr),
                    "distance": _format_distance(step.get("distanceMeters", 0)),
                    "duration": _format_duration(step.get("staticDuration", "")),
                }
            )

    return {
        "duration": _format_duration(route.get("duration", "")),
        "distance": _format_distance(route.get("distanceMeters", 0)),
        "steps": steps,
        "polyline": route.get("polyline", {}).get("encodedPolyline", ""),
    }
