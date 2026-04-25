"""Google Routes API — compute route between origin and destination."""
from __future__ import annotations

import re
from datetime import datetime, timezone
from typing import Any

import httpx

from app.config import GOOGLE_MAPS_API_KEY, check_key, make_http_client
from app.tools.errors import ToolUnavailableError

# Module-level shared client: reuses TCP connections across calls.
_http = make_http_client(15.0)

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


def _collapse_drive_steps(steps: list[dict]) -> list[dict]:
    """Replace consecutive DRIVE steps with a single summary step.

    Turn-by-turn driving instructions are noise in a travel itinerary — only
    transit steps (which bus/train to board, where to alight) need detail.
    """
    result: list[dict] = []
    i = 0
    while i < len(steps):
        if steps[i].get("type") != "DRIVE":
            result.append(steps[i])
            i += 1
            continue
        # Collect the run of DRIVE steps and sum their durations/distances.
        j = i
        total_sec = 0
        total_m = 0
        while j < len(steps) and steps[j].get("type") == "DRIVE":
            # duration is already formatted (e.g. "5 min") — we need raw seconds.
            # Re-parse from the formatted string as a best-effort approximation.
            dur = steps[j].get("duration", "")
            m = re.match(r"(?:(\d+)h\s*)?(\d+)\s*min", dur)
            if m:
                total_sec += (int(m.group(1) or 0) * 3600) + int(m.group(2)) * 60
            # distance is formatted (e.g. "1.2 km" or "300 m")
            dist = steps[j].get("distance", "")
            km = re.match(r"([\d.]+)\s*km", dist)
            metres = re.match(r"(\d+)\s*m$", dist)
            if km:
                total_m += int(float(km.group(1)) * 1000)
            elif metres:
                total_m += int(metres.group(1))
            j += 1
        result.append({
            "type": "DRIVE",
            "instruction": "Drive",
            "duration": _format_duration(f"{total_sec}s") if total_sec else "",
            "distance": _format_distance(total_m) if total_m else "",
        })
        i = j
    return result


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
    raw_steps = [
        _parse_step(s)
        for leg in route.get("legs", [])
        for s in leg.get("steps", [])
    ]
    steps = _collapse_drive_steps(raw_steps)

    return {
        "duration": _format_duration(route.get("duration", "")),
        "distance": _format_distance(route.get("distanceMeters", 0)),
        "steps": steps,
        "polyline": route.get("polyline", {}).get("encodedPolyline", ""),
    }
