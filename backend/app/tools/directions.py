"""Google Routes API — compute route between origin and destination."""
from __future__ import annotations

import re
from datetime import datetime, timezone
from typing import Any

import httpx

from app.config import GOOGLE_MAPS_API_KEY, check_key
from app.tools.errors import ToolUnavailableError

# Module-level shared client: reuses TCP connections across calls.
_http = httpx.AsyncClient(timeout=15.0, trust_env=False)

ROUTES_URL = "https://routes.googleapis.com/directions/v2:computeRoutes"

ROUTES_FIELD_MASK = (
    "routes.duration,routes.distanceMeters,routes.polyline.encodedPolyline,"
    "routes.legs.steps.travelMode,"
    "routes.legs.steps.navigationInstruction,"
    "routes.legs.steps.distanceMeters,"
    "routes.legs.steps.staticDuration,"
    "routes.legs.steps.transitDetails.stopDetails,"
    "routes.legs.steps.transitDetails.transitLine,"
    "routes.legs.steps.transitDetails.stopCount,"
    "routes.legs.steps.transitDetails.headsign"
)

VALID_MODES = {"DRIVE", "WALK", "BICYCLE", "TRANSIT", "TWO_WHEELER"}


_LAT_LNG_RE = re.compile(r"^(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)$")


def _waypoint(location: str) -> dict[str, Any]:
    """Build a Routes API waypoint object.

    If *location* looks like 'lat,lng', use the latLng struct;
    otherwise treat it as a free-text address.
    """
    m = _LAT_LNG_RE.match(location.strip())
    if m:
        return {"location": {"latLng": {"latitude": float(m.group(1)), "longitude": float(m.group(2))}}}
    return {"address": location}


def _strip_html(text: str) -> str:
    return re.sub(r"<[^>]+>", "", text or "")


def _parse_step(step: dict) -> dict:
    """Return a structured step dict, with transit-specific fields when available."""
    td = step.get("transitDetails", {})
    if td:
        line = td.get("transitLine", {})
        stops = td.get("stopDetails", {})
        return {
            "type": "TRANSIT",
            "line": line.get("name") or line.get("nameShort", ""),
            "vehicle": line.get("vehicle", {}).get("type", ""),
            "headsign": td.get("headsign", ""),
            "from": stops.get("departureStop", {}).get("name", ""),
            "to": stops.get("arrivalStop", {}).get("name", ""),
            "stop_count": td.get("stopCount", 0),
            "duration": _format_duration(step.get("staticDuration", "")),
            "distance": _format_distance(step.get("distanceMeters", 0)),
            "instruction": "",
        }
    travel_mode = step.get("travelMode", "")
    step_type = "WALK" if travel_mode == "WALK" else ("DRIVE" if travel_mode == "DRIVE" else travel_mode or "WALK")
    instr = _strip_html(step.get("navigationInstruction", {}).get("instructions", ""))
    return {
        "type": step_type,
        "instruction": instr,
        "duration": _format_duration(step.get("staticDuration", "")),
        "distance": _format_distance(step.get("distanceMeters", 0)),
    }


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

    body: dict[str, Any] = {
        "origin": _waypoint(origin),
        "destination": _waypoint(destination),
        "travelMode": travel_mode,
        "polylineQuality": "OVERVIEW",
    }
    # Routes API requires departureTime for TRANSIT mode.
    if travel_mode == "TRANSIT":
        body["departureTime"] = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    headers = {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": GOOGLE_MAPS_API_KEY,
        "X-Goog-FieldMask": ROUTES_FIELD_MASK,
    }

    resp = await _http.post(ROUTES_URL, json=body, headers=headers)
    resp.raise_for_status()
    data = resp.json()

    routes = data.get("routes", [])
    if not routes and travel_mode == "TRANSIT":
        # TRANSIT may return no routes outside service hours; retry with DRIVE.
        body["travelMode"] = "DRIVE"
        del body["departureTime"]
        resp = await _http.post(ROUTES_URL, json=body, headers=headers)
        resp.raise_for_status()
        data = resp.json()
        routes = data.get("routes", [])
    if not routes:
        return {"duration": "", "distance": "", "steps": [], "polyline": ""}

    route = routes[0]
    steps = [
        _parse_step(s)
        for leg in route.get("legs", [])
        for s in leg.get("steps", [])
    ]

    return {
        "duration": _format_duration(route.get("duration", "")),
        "distance": _format_distance(route.get("distanceMeters", 0)),
        "steps": steps,
        "polyline": route.get("polyline", {}).get("encodedPolyline", ""),
    }
