"""Google Weather API — current conditions and daily forecast.

Requires geocoding the city to lat/lng first via Google Geocoding API.
"""
from __future__ import annotations

import httpx

from app.config import GOOGLE_MAPS_API_KEY, check_key
from app.tools.errors import ToolUnavailableError

GEOCODE_URL = "https://maps.googleapis.com/maps/api/geocode/json"
WEATHER_CURRENT_URL = "https://weather.googleapis.com/v1/currentConditions:lookup"
WEATHER_FORECAST_URL = "https://weather.googleapis.com/v1/forecast/days:lookup"


async def _geocode_city(client: httpx.AsyncClient, city: str) -> tuple[float, float] | None:
    resp = await client.get(
        GEOCODE_URL,
        params={"address": city, "key": GOOGLE_MAPS_API_KEY},
    )
    resp.raise_for_status()
    data = resp.json()
    results = data.get("results", [])
    if not results:
        return None
    loc = results[0]["geometry"]["location"]
    return loc["lat"], loc["lng"]


def _parse_temp(t: dict | None) -> float | None:
    if not t:
        return None
    return t.get("degrees")


def _parse_condition(c: dict | None) -> str:
    if not c:
        return ""
    desc = c.get("description", {})
    if isinstance(desc, dict):
        return desc.get("text", "")
    return c.get("type", "")


async def get_weather(city: str, date: str | None = None) -> dict:
    """Get current weather for a city, plus a multi-day forecast.

    Args:
        city: city name (e.g. "Tokyo, Japan")
        date: optional ISO date string for a specific day's forecast

    Returns:
        {temp, condition, humidity, forecast: [{date, temp_max, temp_min, condition}]}
    """
    if not check_key(GOOGLE_MAPS_API_KEY):
        raise ToolUnavailableError("GOOGLE_MAPS_API_KEY not configured")

    async with httpx.AsyncClient(timeout=15.0, proxy=None) as client:
        coords = await _geocode_city(client, city)
        if not coords:
            return {
                "temp": None,
                "condition": f"Could not locate '{city}'",
                "humidity": None,
                "forecast": [],
            }
        lat, lng = coords

        params = {
            "key": GOOGLE_MAPS_API_KEY,
            "location.latitude": lat,
            "location.longitude": lng,
        }

        # Current conditions — Google Weather API is in preview and
        # occasionally returns 404 for specific lat/lng pairs (ocean
        # tiles, disputed territories, etc.). Catch and degrade
        # gracefully so the tool still returns SOMETHING useful
        # instead of crashing the whole chat stream.
        try:
            current_resp = await client.get(WEATHER_CURRENT_URL, params=params)
            current_resp.raise_for_status()
            current = current_resp.json()
        except httpx.HTTPStatusError as e:
            return {
                "temp": None,
                "condition": f"Weather unavailable for {city} ({e.response.status_code})",
                "humidity": None,
                "forecast": [],
            }
        except httpx.RequestError as e:
            return {
                "temp": None,
                "condition": f"Weather request failed: {type(e).__name__}",
                "humidity": None,
                "forecast": [],
            }

        # 5-day forecast — same defensive handling
        try:
            forecast_params = {**params, "days": 5}
            forecast_resp = await client.get(WEATHER_FORECAST_URL, params=forecast_params)
            forecast_resp.raise_for_status()
            forecast_data = forecast_resp.json()
        except (httpx.HTTPStatusError, httpx.RequestError):
            forecast_data = {"forecastDays": []}

    forecast = []
    for day in forecast_data.get("forecastDays", []):
        interval = day.get("interval", {})
        start = interval.get("startTime", "")
        max_temp = _parse_temp(day.get("maxTemperature"))
        min_temp = _parse_temp(day.get("minTemperature"))
        daytime = day.get("daytimeForecast", {})
        condition = _parse_condition(daytime.get("weatherCondition"))
        forecast.append(
            {
                "date": start[:10] if start else "",
                "temp_max": max_temp,
                "temp_min": min_temp,
                "condition": condition,
            }
        )

    return {
        "temp": _parse_temp(current.get("temperature")),
        "condition": _parse_condition(current.get("weatherCondition")),
        "humidity": current.get("relativeHumidity"),
        "forecast": forecast,
    }
