"""Mocked tests for tool wrappers — no live API calls."""
from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest

from app.tools import (
    day_windows,
    directions,
    flights,
    geocode,
    navigate,
    phrasebook,
    places,
    request_input as request_input_tool,
    weather,
)
from app.tools.errors import ToolUnavailableError
from app.llm import _prune_tool_results
from app.tools import TOOL_DEFINITIONS


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
    with patch("app.tools.places._http") as mock_http:
        mock_http.post = AsyncMock(return_value=_mock_response(fake_response))
        result = await places.search_places("temples in Tokyo")

    assert len(result) == 1
    assert result[0]["name"] == "Senso-ji Temple"
    assert result[0]["place_id"] == "ChIJabc"
    assert result[0]["rating"] == 4.5
    assert result[0]["photo_url"] == "/photo/places/ChIJabc/photos/xyz"


@pytest.mark.asyncio
async def test_search_places_includes_description_and_hours():
    fake_response = {
        "places": [
            {
                "id": "place123",
                "displayName": {"text": "Senso-ji Temple"},
                "formattedAddress": "2-3-1 Asakusa, Taito City, Tokyo",
                "location": {"latitude": 35.7148, "longitude": 139.7967},
                "rating": 4.7,
                "priceLevel": "PRICE_LEVEL_FREE",
                "editorialSummary": {"text": "Ancient Buddhist temple with iconic gate."},
                "regularOpeningHours": {
                    "weekdayDescriptions": ["Monday: Open 24 hours"]
                },
                "photos": [{"name": "places/place123/photos/photo1"}],
            }
        ]
    }
    with patch("app.tools.places._http") as mock_http:
        mock_http.post = AsyncMock(return_value=_mock_response(fake_response))
        results = await places.search_places("temples in Tokyo")

    assert len(results) == 1
    place = results[0]
    assert place.get("description") == "Ancient Buddhist temple with iconic gate."
    assert place.get("hours") is not None
    assert "Monday: Open 24 hours" in place["hours"]


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
    with patch("app.tools.places._http") as mock_http:
        mock_http.get = AsyncMock(return_value=_mock_response(fake_response))
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
    with patch("app.tools.directions._http") as mock_http:
        mock_http.post = AsyncMock(return_value=_mock_response(fake_response))
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

    with patch("app.tools.weather._http") as mock_http:
        mock_http.get = AsyncMock(
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
    with patch("app.tools.weather._http") as mock_http:
        mock_http.get = AsyncMock(return_value=_mock_response({"results": []}))
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
    with patch("app.tools.geocode._http") as mock_http:
        mock_http.get = AsyncMock(return_value=_mock_response(fake_response))
        result = await geocode.geocode_city("Tokyo")

    assert result["name"] == "Tokyo"
    assert result["country"] == "Japan"
    assert result["lat"] == 35.6762
    assert result["lng"] == 139.6503


@pytest.mark.asyncio
async def test_geocode_city_no_results_returns_error():
    with patch("app.tools.geocode._http") as mock_http:
        mock_http.get = AsyncMock(return_value=_mock_response({"results": []}))
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
    with patch("app.tools.geocode._http") as mock_http:
        mock_http.get = AsyncMock(return_value=_mock_response(fake_response))
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
    assert result["currency"] == "HKD"
    assert result["estimate_low"] > 0
    assert result["estimate_high"] > result["estimate_low"]
    assert result["distance_km"] > 2500  # HKG-NRT is ~2900 km
    assert result["distance_km"] < 3500
    assert "google.com/travel/flights" in result["google_flights_url"]
    # Multi-option output for medium-haul (>2000km): 3 non-stop time
    # slots + 1 convenient 1-stop + 1 budget 1-stop = 5 options.
    assert isinstance(result["options"], list)
    assert len(result["options"]) == 5
    assert result["options"][0]["type"] == "non-stop"
    assert result["options"][0]["recommended"] is True
    stops = [o["stops"] for o in result["options"]]
    assert stops.count(0) == 3
    assert stops.count(1) == 2
    # The last entry is the budget 1-stop, cheaper than the cheapest
    # non-stop.
    budget = result["options"][-1]
    assert budget["type"] == "1-stop budget"
    assert budget["price_low"] < result["options"][0]["price_low"]


@pytest.mark.asyncio
async def test_search_flights_short_hop_has_three_options():
    # Hong Kong → Taipei is ~810 km, below the 2000km 1-stop cutoff.
    # Round 11 still returns 3 non-stop estimator options (early,
    # midday, evening) so the user always has a real choice.
    with patch("app.tools.flights._try_fast_flights", return_value=[]):
        result = await flights.search_flights("Hong Kong", "Taipei", "2026-05-15")

    assert len(result["options"]) == 3
    assert all(o["type"] == "non-stop" for o in result["options"])


def test_to_hkd_conversion():
    # 100 USD * 7.78 = 778, rounded to nearest 10 = 780
    assert flights._to_hkd(100) == 780
    # Negative or zero shouldn't blow up
    assert flights._to_hkd(0) == 0


def test_estimator_prices_are_in_hkd():
    options = flights._build_options(2900, "2026-05-15")  # HKG-NRT
    # HKG-NRT non-stop typically lands around HK$2000-4000
    assert options[0]["price_low"] > 1000
    assert options[0]["price_low"] < 6000


@pytest.mark.asyncio
async def test_search_flights_uses_live_data_when_available():
    fake_live = [
        {
            "airline": "Cathay Pacific",
            "price_str": "HK$3,800",
            "price_num": 3800,
            "duration_str": "4 hr 5 min",
            "duration_min": 245,
            "stops": 0,
            "departure": "10:00",
            "arrival": "15:05",
            "is_best": True,
        },
        {
            "airline": "Hong Kong Express",
            "price_str": "HK$1,304",
            "price_num": 1304,
            "duration_str": "4 hr 30 min",
            "duration_min": 270,
            "stops": 0,
            "departure": "08:00",
            "arrival": "12:30",
            "is_best": True,
        },
        {
            "airline": "ANA",
            "price_str": "HK$2,500",
            "price_num": 2500,
            "duration_str": "4 hr 15 min",
            "duration_min": 255,
            "stops": 0,
            "departure": "14:00",
            "arrival": "18:15",
            "is_best": False,
        },
    ]
    with patch("app.tools.flights._try_fast_flights", return_value=fake_live):
        result = await flights.search_flights("Hong Kong", "Tokyo", "2026-05-15")

    assert result["source"] == "fast-flights"
    assert len(result["options"]) >= 1
    # The cheapest non-stop should be the recommended one
    assert result["options"][0]["recommended"] is True
    assert result["options"][0]["price_low"] == 1304
    assert result["options"][0]["airline"] == "Hong Kong Express"


def test_parse_price_handles_hkd_format():
    assert flights._parse_price("HK$1,304") == 1304
    assert flights._parse_price("$480") == 480
    assert flights._parse_price("HK$1304") == 1304
    assert flights._parse_price("") is None
    assert flights._parse_price("Free") is None


def test_parse_duration_handles_hr_min():
    assert flights._parse_duration("4 hr 30 min") == 270
    assert flights._parse_duration("4 hr") == 240
    assert flights._parse_duration("45 min") == 45
    assert flights._parse_duration("8 hr 30 min") == 510
    assert flights._parse_duration("") is None


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
    july = flights._build_options(2900, "2026-07-15")
    feb = flights._build_options(2900, "2026-02-15")
    assert july[0]["price_low"] > feb[0]["price_low"]


def test_airport_lookup_handles_punctuation():
    from app.tools import airports

    assert airports.lookup("Hong Kong")[0] == "HKG"
    assert airports.lookup("hong kong")[0] == "HKG"
    assert airports.lookup("Hong Kong, China")[0] == "HKG"
    assert airports.lookup("Tokyo Airport")[0] == "NRT"
    assert airports.lookup("Narnia") is None


# ─── navigate_menu ───────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_navigate_menu_echoes_args():
    result = await navigate.navigate_menu("FLIGHTS", item="non-stop")
    assert result["navigated"] is True
    assert result["panel"] == "FLIGHTS"
    assert result["item"] == "non-stop"


@pytest.mark.asyncio
async def test_navigate_menu_uppercases_panel():
    result = await navigate.navigate_menu("flights")
    assert result["panel"] == "FLIGHTS"


@pytest.mark.asyncio
async def test_navigate_menu_rejects_unknown_panel():
    result = await navigate.navigate_menu("garbage")
    assert "error" in result
    assert "Unknown panel" in result["error"]


@pytest.mark.asyncio
async def test_navigate_menu_accepts_filter():
    result = await navigate.navigate_menu("FLIGHTS", filter={"sort": "price_asc"})
    assert result["filter"] == {"sort": "price_asc"}


# ─── request_input ───────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_request_input_echoes_args():
    result = await request_input_tool.request_input(
        "destination", "Where do you want to go?"
    )
    assert result["requested"] is True
    assert result["field"] == "destination"
    assert result["prompt"] == "Where do you want to go?"
    assert result["options"] is None


@pytest.mark.asyncio
async def test_request_input_lowercases_field():
    result = await request_input_tool.request_input("TRANSPORT", "How?")
    assert result["field"] == "transport"


@pytest.mark.asyncio
async def test_request_input_accepts_options():
    result = await request_input_tool.request_input(
        "transport", "Driving, transit, or walking?", options=["driving", "transit", "walking"]
    )
    assert result["options"] == ["driving", "transit", "walking"]


@pytest.mark.asyncio
async def test_request_input_rejects_unknown_field():
    result = await request_input_tool.request_input("garbage", "Hello?")
    assert "error" in result
    assert "Unknown field" in result["error"]


# ─── get_day_windows (round 9) ──────────────────────────────────────────


@pytest.mark.asyncio
async def test_get_day_windows_full_middle_day():
    """Middle days of a multi-day trip are full 09:00-21:00 windows."""
    flight = {"arrival_time": "10:00", "departure_time": "18:00"}
    result = await day_windows.get_day_windows(flight=flight, trip_days=5)
    # Middle days (2, 3, 4) should be 09:00-21:00 full days
    for day in result[1:-1]:
        assert day["start_time"] == "09:00"
        assert day["end_time"] == "21:00"
        assert "Full day" in day["notes"]


@pytest.mark.asyncio
async def test_get_day_windows_arrival_late_night():
    """Late arrival (>=20:00) → short day 1 with 'one dinner spot' note."""
    flight = {"arrival_time": "22:15", "departure_time": "10:00"}
    result = await day_windows.get_day_windows(flight=flight, trip_days=3)
    day1 = result[0]
    # 22:15 + 90 min buffer = 23:45
    assert day1["start_time"] == "23:45"
    assert day1["end_time"] == "23:00"  # late night cap
    assert "Late arrival" in day1["notes"]


@pytest.mark.asyncio
async def test_get_day_windows_arrival_early_morning():
    """Early arrival (<=13:00) → near-full day after check-in buffer."""
    flight = {"arrival_time": "08:30", "departure_time": "15:00"}
    result = await day_windows.get_day_windows(flight=flight, trip_days=3)
    day1 = result[0]
    # 08:30 + 90 = 10:00
    assert day1["start_time"] == "10:00"
    assert day1["end_time"] == "21:00"
    assert "Early arrival" in day1["notes"]


@pytest.mark.asyncio
async def test_get_day_windows_departure_before_noon():
    """Early departure (<=12:00) → tight last-day window."""
    flight = {"arrival_time": "15:00", "departure_time": "09:00"}
    result = await day_windows.get_day_windows(flight=flight, trip_days=3)
    last_day = result[-1]
    # 09:00 - 180 = 06:00
    assert last_day["start_time"] == "09:00"
    assert last_day["end_time"] == "06:00"  # end < start is expected
    assert "Early departure" in last_day["notes"]


@pytest.mark.asyncio
async def test_get_day_windows_departure_late_evening():
    """Late departure (>=18:00) → near-full last day."""
    flight = {"arrival_time": "15:00", "departure_time": "20:00"}
    result = await day_windows.get_day_windows(flight=flight, trip_days=3)
    last_day = result[-1]
    # 20:00 - 180 = 17:00
    assert last_day["start_time"] == "09:00"
    assert last_day["end_time"] == "17:00"
    assert "Late departure" in last_day["notes"]


@pytest.mark.asyncio
async def test_get_day_windows_no_flight():
    """No flight data → default full-day windows for every day."""
    result = await day_windows.get_day_windows(flight=None, trip_days=3)
    assert len(result) == 3
    for day in result:
        assert day["start_time"] == "09:00"
        assert day["end_time"] == "21:00"


@pytest.mark.asyncio
async def test_get_day_windows_dates_from_start():
    """start_date seeds each day's date field."""
    flight = {"arrival_time": "15:00", "departure_time": "16:00"}
    result = await day_windows.get_day_windows(
        flight=flight, trip_days=3, start_date="2026-06-01"
    )
    assert result[0]["date"] == "2026-06-01"
    assert result[1]["date"] == "2026-06-02"
    assert result[2]["date"] == "2026-06-03"


@pytest.mark.asyncio
async def test_get_day_windows_reads_flight_options_fallback():
    """When top-level arrival/departure_time are missing, fall back to
    options[0]."""
    flight = {
        "options": [
            {"arrival_time": "18:00", "departure_time": "12:00"},
        ],
    }
    result = await day_windows.get_day_windows(flight=flight, trip_days=2)
    # Arrival 18:00 is mid-afternoon → extended evening end
    assert result[0]["start_time"] == "19:30"
    assert result[0]["end_time"] == "22:00"


# ─── round 10 — airport coords in day_windows + nav flow ─────────────────


@pytest.mark.asyncio
async def test_get_day_windows_includes_arrival_airport_on_day_one():
    """Round 10: day 1 carries arrival_airport coords copied from the
    flight dict."""
    flight = {
        "from_iata": "HKG",
        "from_city": "Hong Kong",
        "from_lat": 22.308,
        "from_lng": 113.918,
        "to_iata": "NRT",
        "to_city": "Tokyo",
        "to_lat": 35.772,
        "to_lng": 140.393,
        "arrival_time": "18:30",
        "departure_time": "12:00",
    }
    result = await day_windows.get_day_windows(flight=flight, trip_days=3)
    assert result[0]["arrival_airport"] is not None
    assert result[0]["arrival_airport"]["iata"] == "NRT"
    assert result[0]["arrival_airport"]["lat"] == 35.772
    assert result[0]["arrival_airport"]["lng"] == 140.393
    assert result[0]["arrival_airport"]["arrival_time"] == "18:30"
    # Middle day has neither airport
    assert result[1]["arrival_airport"] is None
    assert result[1]["departure_airport"] is None


@pytest.mark.asyncio
async def test_get_day_windows_includes_departure_airport_on_last_day():
    """Round 10: last day carries departure_airport coords."""
    flight = {
        "from_iata": "HKG",
        "from_lat": 22.308,
        "from_lng": 113.918,
        "to_iata": "NRT",
        "to_city": "Tokyo",
        "to_lat": 35.772,
        "to_lng": 140.393,
        "arrival_time": "18:30",
        "departure_time": "12:00",
    }
    result = await day_windows.get_day_windows(flight=flight, trip_days=3)
    last = result[-1]
    assert last["departure_airport"] is not None
    # Last day's departure airport is the destination-side airport
    # (that's where the user boards the return flight)
    assert last["departure_airport"]["iata"] == "NRT"
    assert last["departure_airport"]["departure_time"] == "12:00"
    # Round-trip metadata — origin IATA exposed for symmetry
    assert last["departure_airport"]["origin_iata"] == "HKG"


def test_flights_pads_from_onestops_when_nonstops_exhausted():
    """Round 10: the option padding loop falls through to onestops so
    mostly-1-stop routes still return ≥4 options."""
    live = [
        {"airline": "Cathay", "price_num": 1200, "duration_min": 240, "stops": 0,
         "departure": "10:00", "arrival": "14:00"},
        # Only 1 nonstop, the rest are 1-stops on various airlines
        {"airline": "JAL", "price_num": 1100, "duration_min": 380, "stops": 1,
         "departure": "09:00", "arrival": "15:20"},
        {"airline": "ANA", "price_num": 1250, "duration_min": 400, "stops": 1,
         "departure": "12:00", "arrival": "18:40"},
        {"airline": "Korean", "price_num": 1050, "duration_min": 520, "stops": 1,
         "departure": "07:00", "arrival": "15:40"},
        {"airline": "China Air", "price_num": 1150, "duration_min": 460, "stops": 1,
         "departure": "14:00", "arrival": "21:40"},
    ]
    options = flights._options_from_live(live)
    # Minimum 4 options when at least 4 raw flights exist, even if
    # most are 1-stops. The 6-step strategy gives 1 non-stop + 1-2
    # 1-stops; the padding loop then fills from remaining onestops.
    assert len(options) >= 4, f"got {len(options)} options: {options}"


def test_flights_option_always_has_time_fields():
    """Round 10: every option carries departure_time and arrival_time
    keys (value may be None when fast-flights omits them)."""
    live = [
        {"airline": "Cathay", "price_num": 1200, "duration_min": 240, "stops": 0,
         "departure": "10:00", "arrival": "14:00"},
        {"airline": "JAL", "price_num": 1300, "duration_min": 230, "stops": 0,
         "departure": None, "arrival": None},
    ]
    options = flights._options_from_live(live)
    for opt in options:
        assert "departure_time" in opt
        assert "arrival_time" in opt


def test_flights_normalize_time_handles_none():
    """_normalize_time returns None for falsy input — PanelFlights
    renders em-dash as fallback (R10-B1)."""
    assert flights._normalize_time(None) is None
    assert flights._normalize_time("") is None


# ─── Round 11 — sparseness regression guards ─────────────────────────────


@pytest.mark.asyncio
async def test_places_search_always_sends_pagesize_without_location():
    """Round 11 — the #1 sparseness bug. search_places MUST send
    pageSize=20 even when the LLM omits the `location` kwarg. Google
    Places (New) defaults to pageSize=1 which previously collapsed
    every plan to 1 hotel / 1 activity / 1 restaurant."""
    captured: dict = {}

    class _Resp:
        status_code = 200
        def raise_for_status(self): pass
        def json(self): return {"places": []}

    async def fake_post(url, json=None, headers=None):
        captured["body"] = json
        return _Resp()

    with patch("app.tools.places._http") as mock_http:
        mock_http.post = fake_post
        await places.search_places("hotels in Tokyo")

    assert captured["body"]["pageSize"] == 20
    assert captured["body"]["textQuery"] == "hotels in Tokyo"


@pytest.mark.asyncio
async def test_places_search_with_location_still_sends_pagesize():
    """Regression guard for the location-provided branch."""
    captured: dict = {}

    class _Resp:
        status_code = 200
        def raise_for_status(self): pass
        def json(self): return {"places": []}

    async def fake_post(url, json=None, headers=None):
        captured["body"] = json
        return _Resp()

    with patch("app.tools.places._http") as mock_http:
        mock_http.post = fake_post
        await places.search_places("ramen", location="Shinjuku")

    assert captured["body"]["pageSize"] == 20
    assert captured["body"]["textQuery"] == "ramen near Shinjuku"


def test_flights_estimator_short_haul_returns_three_options():
    """Round 11 — _build_options must return 3 non-stop slots for
    short-haul routes too, not 1. Previously HKG→Taipei returned a
    single option when fast-flights was blocked."""
    # 800 km is short-haul (< 2000 km cutoff).
    options = flights._build_options(distance_km=800, when="2026-06-01")
    assert len(options) == 3
    assert all(o["type"] == "non-stop" for o in options)
    # Each slot has a distinct departure_time so the FLIGHTS panel
    # shows 3 distinguishable rows.
    departures = {o["departure_time"] for o in options}
    assert len(departures) == 3


def test_flights_estimator_medium_haul_returns_five_options():
    """Medium/long-haul gets 3 non-stops + 2 one-stops = 5."""
    options = flights._build_options(distance_km=2800, when="2026-06-01")
    assert len(options) == 5
    assert sum(1 for o in options if o["stops"] == 0) == 3
    assert sum(1 for o in options if o["stops"] == 1) == 2


def test_flights_live_padding_reaches_eight_options():
    """Round 11 — _options_from_live padding ceiling was 6, now 8."""
    live = [
        {"airline": f"Air{i}", "price_num": 1000 + i * 50, "duration_min": 240,
         "stops": 0, "departure": f"{6 + i:02d}:00", "arrival": f"{10 + i:02d}:00"}
        for i in range(12)
    ]
    options = flights._options_from_live(live)
    assert len(options) == 8, f"expected 8 options, got {len(options)}"


def test_prompts_hotel_count_is_consistent():
    """Round 11 — the system prompt must NOT have the old "3 well-
    rated" hotel hint that contradicted Step 3's "5-8 hotels" rule
    and drove the LLM toward 3 hotels."""
    from app.prompts import SYSTEM_PROMPT
    assert "3 well-rated options" not in SYSTEM_PROMPT
    # The intended phrasing (5 to 8) should be present in at least
    # one place.
    assert "5 to 8" in SYSTEM_PROMPT or "5-8" in SYSTEM_PROMPT


# ─── Round 12 — flight seat class ────────────────────────────────────────


@pytest.mark.asyncio
async def test_search_flights_default_seat_class_economy():
    """When seat_class is omitted, search_flights defaults to economy
    and every option carries seat_class='economy'."""
    with patch("app.tools.flights._try_fast_flights", return_value=[]):
        result = await flights.search_flights("Hong Kong", "Tokyo", "2026-06-01")
    assert result["seat_class"] == "economy"
    assert result["seat_class_label"] == "Economy"
    for opt in result["options"]:
        assert opt["seat_class"] == "economy"


@pytest.mark.asyncio
async def test_search_flights_business_seat_class_scales_prices():
    """Business seat class multiplies prices by 3.2× vs economy."""
    with patch("app.tools.flights._try_fast_flights", return_value=[]):
        economy = await flights.search_flights("Hong Kong", "Tokyo", "2026-06-01")
        business = await flights.search_flights("Hong Kong", "Tokyo", "2026-06-01", seat_class="business")
    assert business["seat_class"] == "business"
    assert business["seat_class_label"] == "Business"
    # The non-stop early option is always the first entry; verify
    # its price scaled.
    econ_price = economy["options"][0]["price_low"]
    biz_price = business["options"][0]["price_low"]
    # 3.2× with rounding — allow ±1 for int rounding.
    assert abs(biz_price - round(econ_price * 3.2)) <= 1
    for opt in business["options"]:
        assert opt["seat_class"] == "business"


@pytest.mark.asyncio
async def test_search_flights_unknown_seat_class_falls_back_to_economy():
    """Defensive: a typo or unknown value defaults to economy."""
    with patch("app.tools.flights._try_fast_flights", return_value=[]):
        result = await flights.search_flights("Hong Kong", "Tokyo", "2026-06-01", seat_class="coach")
    assert result["seat_class"] == "economy"


@pytest.mark.asyncio
async def test_search_flights_includes_alternate_airports():
    """Round 12 — Tokyo has HND as a nearby alternate; the return
    dict surfaces it under to_alternates with a km distance."""
    with patch("app.tools.flights._try_fast_flights", return_value=[]):
        result = await flights.search_flights("Hong Kong", "Tokyo", "2026-06-01")
    assert isinstance(result["to_alternates"], list)
    assert any(a["iata"] == "HND" for a in result["to_alternates"])
    hnd = next(a for a in result["to_alternates"] if a["iata"] == "HND")
    assert hnd["km_from_primary"] > 0
    # Hong Kong has no bundled alternates — from_alternates should be empty
    assert result["from_alternates"] == []


@pytest.mark.asyncio
async def test_phrasebook_tokyo_returns_japanese():
    """Round 17 — get_phrasebook('Tokyo') resolves to Japanese."""
    result = await phrasebook.get_phrasebook("Tokyo")
    assert result.get("language") == "Japanese"
    assert result.get("language_code") == "ja"
    assert len(result.get("phrases", [])) >= 8
    # Every phrase has the expected shape
    for p in result["phrases"]:
        assert "key" in p
        assert "romanized" in p
        assert "native" in p


@pytest.mark.asyncio
async def test_phrasebook_unknown_returns_error():
    """Unknown destination returns an error dict the LLM can ignore."""
    result = await phrasebook.get_phrasebook("Atlantis")
    assert "error" in result


@pytest.mark.asyncio
async def test_phrasebook_country_name_works():
    """Country names also resolve (not just cities)."""
    result = await phrasebook.get_phrasebook("France")
    assert result.get("language") == "French"


@pytest.mark.asyncio
async def test_search_flights_london_has_multiple_alternates():
    """London has LGW + STN + LTN alternates."""
    with patch("app.tools.flights._try_fast_flights", return_value=[]):
        result = await flights.search_flights("New York", "London", "2026-06-01")
    iatas = {a["iata"] for a in result["to_alternates"]}
    assert "LGW" in iatas
    assert "STN" in iatas
    # NYC from_alternates include EWR + LGA
    from_iatas = {a["iata"] for a in result["from_alternates"]}
    assert "EWR" in from_iatas or "LGA" in from_iatas


# ─── flights.py round 9 — 4-6 options ────────────────────────────────────


def test_flights_options_from_live_returns_multiple():
    """A diverse set of real flights should produce 3-6 options."""
    live = [
        {"airline": "Cathay", "price_num": 1200, "duration_min": 240, "stops": 0,
         "departure": "10:00", "arrival": "14:00"},
        {"airline": "JAL", "price_num": 1300, "duration_min": 230, "stops": 0,
         "departure": "11:00", "arrival": "15:00"},
        {"airline": "ANA", "price_num": 1500, "duration_min": 220, "stops": 0,
         "departure": "09:00", "arrival": "13:00"},
        {"airline": "Budget Air", "price_num": 900, "duration_min": 420, "stops": 1,
         "departure": "07:00", "arrival": "15:00"},
    ]
    options = flights._options_from_live(live)
    assert len(options) >= 3
    assert len(options) <= 8
    # All options have price_low > 0
    assert all(o["price_low"] > 0 for o in options)
    # Deduped — no duplicate (airline, price_num) pairs
    seen = set()
    for o in options:
        key = (o["airline"], o["price_low"])
        assert key not in seen, f"duplicate option: {key}"
        seen.add(key)
    # Times are normalized to HH:MM
    for o in options:
        if o.get("departure_time"):
            assert len(o["departure_time"]) == 5
            assert o["departure_time"][2] == ":"


def test_flights_normalize_time_12h():
    """12-hour AM/PM strings convert to 24-hour HH:MM."""
    assert flights._normalize_time("6:30 PM") == "18:30"
    assert flights._normalize_time("9:15 AM") == "09:15"
    assert flights._normalize_time("12:00 AM") == "00:00"
    assert flights._normalize_time("12:00 PM") == "12:00"


def test_flights_normalize_time_24h():
    """24-hour HH:MM strings pass through."""
    assert flights._normalize_time("18:30") == "18:30"
    assert flights._normalize_time("6:30") == "06:30"


def test_flights_normalize_time_strips_day_suffix():
    """The +1 day suffix fast-flights uses for overnight is dropped."""
    assert flights._normalize_time("18:30+1") == "18:30"
    assert flights._normalize_time("6:30 AM+2") == "06:30"


# ─── places.py round 9 — photos gallery ──────────────────────────────────


@pytest.mark.asyncio
async def test_places_search_returns_photos_gallery():
    """search_places returns up to 5 photo URLs per place."""
    mock_response = {
        "places": [
            {
                "id": "p1",
                "displayName": {"text": "Place 1"},
                "formattedAddress": "addr",
                "location": {"latitude": 1.0, "longitude": 2.0},
                "photos": [
                    {"name": f"photo_{i}"} for i in range(7)
                ],
            }
        ]
    }
    with patch("httpx.AsyncClient.post", new_callable=AsyncMock) as mock_post:
        mock_post.return_value.status_code = 200
        mock_post.return_value.json = lambda: mock_response
        mock_post.return_value.raise_for_status = lambda: None
        results = await places.search_places("hotels", location="Tokyo")
        assert len(results) == 1
        # Up to 5 photos in the gallery
        assert len(results[0]["photos"]) == 5
        # photo_url stays as the first for back-compat
        assert results[0]["photo_url"] == results[0]["photos"][0]


# ─── places.py null-guard tests ───────────────────────────────────────────


@pytest.mark.asyncio
async def test_search_places_null_guards_for_new_fields():
    """description and hours must be falsy (not raise) when fields are absent."""
    mock_response = {
        "places": [
            {
                "id": "p1",
                "displayName": {"text": "Some Place"},
                "formattedAddress": "Tokyo",
                "location": {"latitude": 35.0, "longitude": 139.0},
            }
        ]
    }
    with patch("app.tools.places.GOOGLE_MAPS_API_KEY", "fake-key"), \
         patch("app.tools.places._http") as mock_http:
        mock_resp = AsyncMock()
        mock_resp.raise_for_status = lambda: None
        mock_resp.json = lambda: mock_response
        mock_http.post = AsyncMock(return_value=mock_resp)

        results = await places.search_places("anything")

    assert len(results) == 1
    place = results[0]
    assert not place.get("description")   # None or empty string — not an error
    assert place.get("hours") == []       # always a list, never None


# ─── Fix A — mock_weather shape ──────────────────────────────────────────


@pytest.mark.asyncio
async def test_mock_weather_matches_live_shape():
    """Mock weather must match the live get_weather return shape."""
    from app.tools.mock_dispatch import mock_get_weather
    result = await mock_get_weather(city="Tokyo")
    assert "temp" in result, f"missing 'temp'; got: {list(result.keys())}"
    assert "condition" in result
    assert "humidity" in result
    assert isinstance(result.get("forecast"), list)
    assert "current" not in result, "old mock shape — 'current' key must not exist"
    if result["forecast"]:
        day = result["forecast"][0]
        assert "temp_max" in day, f"should use temp_max, got: {list(day.keys())}"
        assert "temp_min" in day
        assert "date" in day
        assert "high_c" not in day
        assert "low_c" not in day


# ─── Fix B — fast_flights seat class passthrough ─────────────────────────


def test_fast_flights_passes_seat_class():
    """_try_fast_flights must forward seat_class to get_flights, not hardcode economy."""
    import sys
    from types import SimpleNamespace
    from unittest.mock import MagicMock
    from app.tools.flights import _try_fast_flights

    mock_get_flights = MagicMock(return_value=SimpleNamespace(flights=[]))
    fake_ff = SimpleNamespace(
        FlightData=MagicMock(return_value=None),
        Passengers=MagicMock(return_value=None),
        get_flights=mock_get_flights,
    )
    with patch.dict(sys.modules, {"fast_flights": fake_ff}):
        _try_fast_flights("HKG", "NRT", "2026-05-10", seat_class="business")

    call_kwargs = mock_get_flights.call_args.kwargs
    assert call_kwargs.get("seat") == "business", (
        f"Expected seat='business', got: {call_kwargs.get('seat')!r}"
    )


# ─── Fix C — navigate_menu description ───────────────────────────────────


def test_navigate_menu_description_does_not_mention_home():
    """navigate_menu description must not mention HOME — system prompt forbids it."""
    from app.tools import TOOL_DEFINITIONS
    nav_tool = next(
        (t for t in TOOL_DEFINITIONS if t.get("function", {}).get("name") == "navigate_menu"),
        None,
    )
    assert nav_tool is not None
    desc = nav_tool["function"]["description"].upper()
    assert "HOME" not in desc, "navigate_menu description contradicts system prompt by mentioning HOME"


# ─── Task 3 — tools list only contains function-type tools ────────────────


def test_tools_list_only_contains_function_types():
    """All tools sent to the model must be type=function.

    xAI deprecated web_search_preview (now returns 422); it was removed so
    the tools list only contains standard function-call tool definitions.
    """
    for t in TOOL_DEFINITIONS:
        assert t.get("type") == "function", (
            f"Non-function tool found in list: {t}"
        )


# ─── Task 7 — context size management ────────────────────────────────────


@pytest.mark.parametrize("model,expected_rounds", [
    ("grok-4.20-0309-non-reasoning", 2),
    ("grok-4.20-0309-reasoning", 3),
    ("grok-4.20-multi-agent-0309", 2),  # no "reasoning" in name
])
def test_prune_keep_rounds_is_model_aware(model, expected_rounds, monkeypatch):
    """PRUNE_KEEP_ROUNDS must be 3 for reasoning models, 2 for non-reasoning."""
    import importlib
    import app.config as cfg
    monkeypatch.setattr(cfg, "LLM_MODEL", model)
    # Re-derive the value the same way config.py does
    _m = (model or "").lower()
    derived = 3 if ("reasoning" in _m and "non-reasoning" not in _m) else 2
    assert derived == expected_rounds, (
        f"Model '{model}' should give keep_rounds={expected_rounds}, got {derived}"
    )


def test_prune_tool_results_truncates_old_rounds():
    """Tool results older than keep_recent_rounds should be replaced with a stub."""
    messages = []
    for i in range(4):
        messages.append({"role": "assistant", "content": f"round {i}", "tool_calls": []})
        messages.append({
            "role": "tool",
            "tool_call_id": f"tc_{i}",
            "content": "x" * 500,
        })

    pruned = _prune_tool_results(messages, keep_recent_rounds=2)

    tool_msgs = [m for m in pruned if m.get("role") == "tool"]
    assert len(tool_msgs) == 4  # count unchanged
    assert len(tool_msgs[0]["content"]) < 500  # round 0 — pruned
    assert len(tool_msgs[1]["content"]) < 500  # round 1 — pruned
    assert len(tool_msgs[2]["content"]) == 500  # round 2 — kept
    assert len(tool_msgs[3]["content"]) == 500  # round 3 — kept
