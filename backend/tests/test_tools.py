"""Mocked tests for tool wrappers — no live API calls."""
from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest

from app.tools import directions, flights, geocode, places, search, weather
from app.tools.errors import ToolUnavailableError


@pytest.fixture(autouse=True)
def _mock_keys(monkeypatch):
    """Set fake keys so check_key passes."""
    monkeypatch.setattr(places, "GOOGLE_MAPS_API_KEY", "FAKE_KEY")
    monkeypatch.setattr(directions, "GOOGLE_MAPS_API_KEY", "FAKE_KEY")
    monkeypatch.setattr(weather, "GOOGLE_MAPS_API_KEY", "FAKE_KEY")
    monkeypatch.setattr(geocode, "GOOGLE_MAPS_API_KEY", "FAKE_KEY")


def _mock_response(json_data: dict, status: int = 200):
    resp = AsyncMock()
    resp.json = lambda: json_data
    resp.status_code = status
    resp.raise_for_status = lambda: None
    return resp


# ─── search_places ───────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_search_places_returns_normalized_list():
    fake_response = {
        "places": [
            {
                "id": "ChIJabc",
                "displayName": {"text": "Senso-ji Temple"},
                "formattedAddress": "2-3-1 Asakusa, Tokyo",
                "rating": 4.5,
                "photos": [{"name": "places/ChIJabc/photos/xyz"}],
                "priceLevel": "PRICE_LEVEL_FREE",
            }
        ]
    }
    with patch("app.tools.places.httpx.AsyncClient") as mock_client:
        mock_client.return_value.__aenter__.return_value.post = AsyncMock(
            return_value=_mock_response(fake_response)
        )
        result = await places.search_places("temples in Tokyo")

    assert len(result) == 1
    assert result[0]["name"] == "Senso-ji Temple"
    assert result[0]["place_id"] == "ChIJabc"
    assert result[0]["rating"] == 4.5
    assert result[0]["photo_url"] == "/photo/places/ChIJabc/photos/xyz"


@pytest.mark.asyncio
async def test_search_places_missing_key(monkeypatch):
    monkeypatch.setattr(places, "GOOGLE_MAPS_API_KEY", "")
    with pytest.raises(ToolUnavailableError):
        await places.search_places("anything")


@pytest.mark.asyncio
async def test_get_place_details_returns_dict():
    fake_response = {
        "id": "ChIJabc",
        "displayName": {"text": "Senso-ji"},
        "formattedAddress": "2-3-1 Asakusa, Tokyo",
        "editorialSummary": {"text": "Tokyo's oldest temple"},
        "regularOpeningHours": {"weekdayDescriptions": ["Mon: 6 AM - 5 PM"]},
        "reviews": [{"text": {"text": "Beautiful!"}, "rating": 5}],
        "photos": [{"name": "places/ChIJabc/photos/p1"}],
        "rating": 4.5,
    }
    with patch("app.tools.places.httpx.AsyncClient") as mock_client:
        mock_client.return_value.__aenter__.return_value.get = AsyncMock(
            return_value=_mock_response(fake_response)
        )
        result = await places.get_place_details("ChIJabc")

    assert result["name"] == "Senso-ji"
    assert result["description"] == "Tokyo's oldest temple"
    assert result["hours"] == ["Mon: 6 AM - 5 PM"]
    assert len(result["reviews"]) == 1
    assert result["reviews"][0]["rating"] == 5


# ─── get_directions ──────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_get_directions_parses_route():
    fake_response = {
        "routes": [
            {
                "duration": "1234s",
                "distanceMeters": 5400,
                "polyline": {"encodedPolyline": "abcdefg"},
                "legs": [
                    {
                        "steps": [
                            {
                                "navigationInstruction": {
                                    "instructions": "Walk to <b>station</b>"
                                },
                                "distanceMeters": 200,
                                "staticDuration": "180s",
                            }
                        ]
                    }
                ],
            }
        ]
    }
    with patch("app.tools.directions.httpx.AsyncClient") as mock_client:
        mock_client.return_value.__aenter__.return_value.post = AsyncMock(
            return_value=_mock_response(fake_response)
        )
        result = await directions.get_directions("Asakusa", "Shibuya", "TRANSIT")

    assert result["duration"] == "20 min"
    assert result["distance"] == "5.4 km"
    assert result["polyline"] == "abcdefg"
    assert len(result["steps"]) == 1
    assert result["steps"][0]["instruction"] == "Walk to station"  # HTML stripped


@pytest.mark.asyncio
async def test_get_directions_missing_key(monkeypatch):
    monkeypatch.setattr(directions, "GOOGLE_MAPS_API_KEY", "")
    with pytest.raises(ToolUnavailableError):
        await directions.get_directions("a", "b")


# ─── get_weather ─────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_get_weather_returns_current_and_forecast():
    geocode_response = {
        "results": [{"geometry": {"location": {"lat": 35.68, "lng": 139.65}}}]
    }
    current_response = {
        "temperature": {"degrees": 22.5, "unit": "CELSIUS"},
        "weatherCondition": {
            "description": {"text": "Partly cloudy"},
            "type": "PARTLY_CLOUDY",
        },
        "relativeHumidity": 60,
    }
    forecast_response = {
        "forecastDays": [
            {
                "interval": {"startTime": "2026-04-15T00:00:00Z"},
                "maxTemperature": {"degrees": 24},
                "minTemperature": {"degrees": 18},
                "daytimeForecast": {
                    "weatherCondition": {"description": {"text": "Sunny"}}
                },
            }
        ]
    }

    with patch("app.tools.weather.httpx.AsyncClient") as mock_client:
        ctx = mock_client.return_value.__aenter__.return_value
        ctx.get = AsyncMock(
            side_effect=[
                _mock_response(geocode_response),
                _mock_response(current_response),
                _mock_response(forecast_response),
            ]
        )
        result = await weather.get_weather("Tokyo")

    assert result["temp"] == 22.5
    assert result["condition"] == "Partly cloudy"
    assert result["humidity"] == 60
    assert len(result["forecast"]) == 1
    assert result["forecast"][0]["date"] == "2026-04-15"
    assert result["forecast"][0]["temp_max"] == 24


@pytest.mark.asyncio
async def test_get_weather_geocode_failure_returns_empty():
    with patch("app.tools.weather.httpx.AsyncClient") as mock_client:
        mock_client.return_value.__aenter__.return_value.get = AsyncMock(
            return_value=_mock_response({"results": []})
        )
        result = await weather.get_weather("Atlantis")

    assert result["temp"] is None
    assert "Atlantis" in result["condition"]


# ─── geocode_city ────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_geocode_city_returns_coords():
    fake_response = {
        "results": [
            {
                "formatted_address": "Tokyo, Japan",
                "geometry": {"location": {"lat": 35.6762, "lng": 139.6503}},
                "address_components": [
                    {"long_name": "Tokyo", "types": ["locality", "political"]},
                    {"long_name": "Japan", "types": ["country", "political"]},
                ],
            }
        ]
    }
    with patch("app.tools.geocode.httpx.AsyncClient") as mock_client:
        mock_client.return_value.__aenter__.return_value.get = AsyncMock(
            return_value=_mock_response(fake_response)
        )
        result = await geocode.geocode_city("Tokyo")

    assert result["name"] == "Tokyo"
    assert result["country"] == "Japan"
    assert result["lat"] == 35.6762
    assert result["lng"] == 139.6503


@pytest.mark.asyncio
async def test_geocode_city_no_results_returns_error():
    with patch("app.tools.geocode.httpx.AsyncClient") as mock_client:
        mock_client.return_value.__aenter__.return_value.get = AsyncMock(
            return_value=_mock_response({"results": []})
        )
        result = await geocode.geocode_city("Atlantis")

    assert "error" in result
    assert "Atlantis" in result["error"]


@pytest.mark.asyncio
async def test_geocode_city_missing_key(monkeypatch):
    monkeypatch.setattr(geocode, "GOOGLE_MAPS_API_KEY", "")
    with pytest.raises(ToolUnavailableError):
        await geocode.geocode_city("Tokyo")


@pytest.mark.asyncio
async def test_reverse_geocode_returns_city():
    fake_response = {
        "results": [
            {
                "formatted_address": "Hong Kong",
                "address_components": [
                    {"long_name": "Hong Kong", "types": ["locality", "political"]},
                    {"long_name": "Hong Kong", "types": ["country", "political"]},
                ],
            }
        ]
    }
    with patch("app.tools.geocode.httpx.AsyncClient") as mock_client:
        mock_client.return_value.__aenter__.return_value.get = AsyncMock(
            return_value=_mock_response(fake_response)
        )
        result = await geocode.reverse_geocode(22.3193, 114.1694)

    assert result["city"] == "Hong Kong"
    assert result["country"] == "Hong Kong"


# ─── search_flights ──────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_search_flights_estimator_fallback():
    # Force fast-flights to fail by patching it to return [].
    with patch("app.tools.flights._try_fast_flights", return_value=[]):
        result = await flights.search_flights("Hong Kong", "Tokyo", "2026-05-15")

    assert result["from_iata"] == "HKG"
    assert result["to_iata"] == "NRT"
    assert result["source"] == "estimator"
    assert result["estimate_low"] > 0
    assert result["estimate_high"] > result["estimate_low"]
    assert result["distance_km"] > 2500  # HKG-NRT is ~2900 km
    assert result["distance_km"] < 3500
    assert "google.com/travel/flights" in result["google_flights_url"]


@pytest.mark.asyncio
async def test_search_flights_uses_live_data_when_available():
    fake_live = [
        {
            "airline": "Cathay Pacific",
            "price": "$480",
            "duration": "4h 5min",
            "stops": 0,
            "departure": "10:00",
            "arrival": "15:05",
            "is_best": True,
        }
    ]
    with patch("app.tools.flights._try_fast_flights", return_value=fake_live):
        result = await flights.search_flights("Hong Kong", "Tokyo", "2026-05-15")

    assert result["source"] == "fast-flights"
    assert len(result["results"]) == 1
    assert result["results"][0]["airline"] == "Cathay Pacific"


@pytest.mark.asyncio
async def test_search_flights_unknown_origin_returns_error():
    result = await flights.search_flights("Atlantis", "Tokyo")
    assert "error" in result
    assert "Atlantis" in result["error"]


@pytest.mark.asyncio
async def test_search_flights_unknown_destination_returns_error():
    result = await flights.search_flights("Hong Kong", "Narnia")
    assert "error" in result
    assert "Narnia" in result["error"]


@pytest.mark.asyncio
async def test_search_flights_handles_city_with_country():
    """Cities like 'Tokyo, Japan' should resolve via the comma-strip path."""
    with patch("app.tools.flights._try_fast_flights", return_value=[]):
        result = await flights.search_flights("Hong Kong, China", "Tokyo, Japan")
    assert result["from_iata"] == "HKG"
    assert result["to_iata"] == "NRT"


def test_haversine_known_distance():
    # HKG to NRT is roughly 2880 km
    d = flights._haversine_km(22.3080, 113.9185, 35.7720, 140.3929)
    assert 2700 < d < 3100


def test_estimator_seasonality():
    # July (peak) should be more expensive than February (off-peak)
    july = flights._estimate(2900, "2026-07-15")
    feb = flights._estimate(2900, "2026-02-15")
    assert july["low"] > feb["low"]


def test_airport_lookup_handles_punctuation():
    from app.tools import airports

    assert airports.lookup("Hong Kong")[0] == "HKG"
    assert airports.lookup("hong kong")[0] == "HKG"
    assert airports.lookup("Hong Kong, China")[0] == "HKG"
    assert airports.lookup("Tokyo Airport")[0] == "NRT"
    assert airports.lookup("Narnia") is None


# ─── web_search stub ─────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_web_search_returns_stub():
    result = await search.web_search("anything")
    assert len(result) == 1
    assert "unavailable" in result[0]["title"].lower()
