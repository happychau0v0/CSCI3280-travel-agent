"""Mock tool dispatch for integration testing.

When MOCK_TOOLS=1 is set, these stubs replace the real TOOL_DISPATCH
entries. They return realistic fixture data without calling any external
APIs — no Google Maps key, no fast-flights, no OpenRouter needed.

This lets Playwright integration tests exercise the REAL SSE pipeline,
JSON extraction, and state transitions while keeping the test deterministic
and free.
"""
from __future__ import annotations


async def mock_search_places(query: str, location: str | None = None, radius_km: float = 5.0):
    """Return 5 realistic places without hitting Google Places API."""
    base_name = "hotel" if "hotel" in query.lower() else "place"
    results = []
    for i in range(5):
        results.append({
            "place_id": f"ChIJmock{i:04d}",
            "name": [
                "Park Hyatt Tokyo",
                "Hotel Gracery Shinjuku",
                "Mitsui Garden Hotel Ginza",
                "The Gate Hotel Kaminarimon",
                "Sotetsu Fresa Inn Ningyocho",
            ][i] if base_name == "hotel" else [
                "Senso-ji Temple",
                "Meiji Jingu Shrine",
                "teamLab Borderless",
                "Tsukiji Outer Market",
                "Shinjuku Gyoen National Garden",
            ][i],
            "address": f"Mock Address {i + 1}, Tokyo",
            "rating": round(4.0 + i * 0.15, 1),
            "price_level": ["PRICE_LEVEL_MODERATE", "PRICE_LEVEL_EXPENSIVE",
                            "PRICE_LEVEL_VERY_EXPENSIVE", "PRICE_LEVEL_MODERATE",
                            "PRICE_LEVEL_INEXPENSIVE"][i],
            "photo_url": f"/photo/places/ChIJmock{i:04d}/photos/mock",
            "photos": [f"/photo/places/ChIJmock{i:04d}/photos/mock"],
            "lat": 35.68 + i * 0.01,
            "lng": 139.70 + i * 0.01,
        })
    return results


async def mock_get_place_details(place_id: str):
    """Return mock place details."""
    return {
        "place_id": place_id,
        "name": "Mock Place",
        "address": "1-1-1 Mock, Tokyo",
        "description": "A wonderful mock place for testing.",
        "hours": ["Monday: 9:00 AM – 5:00 PM"],
        "reviews": [{"text": "Great place!", "rating": 5}],
        "photos": ["/photo/mock/1"],
        "rating": 4.5,
        "lat": 35.68,
        "lng": 139.70,
    }


async def mock_get_directions(origin: str, destination: str, mode: str = "TRANSIT"):
    """Return mock directions."""
    return {
        "duration": "15 min",
        "distance": "2.3 km",
        "steps": [
            {"instruction": "Walk to mock station", "duration": "5 min", "distance": "0.4 km"},
            {"instruction": "Take mock line", "duration": "8 min", "distance": "1.5 km"},
            {"instruction": "Walk to destination", "duration": "2 min", "distance": "0.4 km"},
        ],
        "polyline": "e~geCm}|sYv@dBArCDfH",
    }


async def mock_get_weather(city: str, date: str | None = None):
    """Return mock weather data."""
    return {
        "temp": "22°C",
        "condition": "Partly cloudy",
        "humidity": 65,
        "forecast": [
            {"date": "2026-05-01", "temp_max": "24°C", "temp_min": "18°C", "condition": "Sunny"},
            {"date": "2026-05-02", "temp_max": "23°C", "temp_min": "17°C", "condition": "Cloudy"},
            {"date": "2026-05-03", "temp_max": "21°C", "temp_min": "16°C", "condition": "Light rain"},
            {"date": "2026-05-04", "temp_max": "22°C", "temp_min": "17°C", "condition": "Partly cloudy"},
            {"date": "2026-05-05", "temp_max": "25°C", "temp_min": "19°C", "condition": "Sunny"},
        ],
    }


async def mock_search_flights(
    origin: str, destination: str, date: str | None = None, seat_class: str | None = None,
):
    """Return mock flight data matching the real schema."""
    return {
        "from_city": origin.split(",")[0].strip(),
        "from_iata": "HKG",
        "from_name": "Hong Kong International Airport",
        "from_lat": 22.308,
        "from_lng": 113.918,
        "from_alternates": [],
        "to_city": destination.split(",")[0].strip(),
        "to_iata": "NRT",
        "to_name": "Narita International Airport",
        "to_lat": 35.764,
        "to_lng": 140.386,
        "to_alternates": [
            {"iata": "HND", "name": "Tokyo Haneda", "lat": 35.553, "lng": 139.779, "km_from_primary": 68.5},
        ],
        "date": date or "2026-05-15",
        "distance_km": 2878,
        "currency": "HKD",
        "results": [],
        "options": [
            {
                "type": "non-stop",
                "label": "Cheapest non-stop",
                "price_low": 1850,
                "price_high": 2100,
                "duration_min": 235,
                "stops": 0,
                "airline": "ANA",
                "departure_time": "08:00",
                "arrival_time": "13:15",
                "recommended": True,
                "seat_class": seat_class or "economy",
                "seat_class_label": "Economy",
            },
            {
                "type": "non-stop",
                "label": "Alternative airline",
                "price_low": 2200,
                "price_high": 2500,
                "duration_min": 240,
                "stops": 0,
                "airline": "Japan Airlines",
                "departure_time": "14:00",
                "arrival_time": "19:00",
                "recommended": False,
                "seat_class": seat_class or "economy",
                "seat_class_label": "Economy",
            },
            {
                "type": "non-stop",
                "label": "Fastest non-stop",
                "price_low": 2400,
                "price_high": 2700,
                "duration_min": 225,
                "stops": 0,
                "airline": "Cathay Pacific",
                "departure_time": "10:30",
                "arrival_time": "15:30",
                "recommended": False,
                "seat_class": seat_class or "economy",
                "seat_class_label": "Economy",
            },
            {
                "type": "1-stop",
                "label": "1 stop · cheap",
                "price_low": 1400,
                "price_high": 1750,
                "duration_min": 390,
                "stops": 1,
                "airline": "Vietnam Airlines",
                "departure_time": "06:30",
                "arrival_time": "16:00",
                "recommended": False,
                "seat_class": seat_class or "economy",
                "seat_class_label": "Economy",
            },
            {
                "type": "1-stop budget",
                "label": "1 stop · budget",
                "price_low": 1100,
                "price_high": 1400,
                "duration_min": 510,
                "stops": 1,
                "airline": "China Southern",
                "departure_time": "22:30",
                "arrival_time": "14:00",
                "recommended": False,
                "seat_class": seat_class or "economy",
                "seat_class_label": "Economy",
            },
        ],
        "estimate_low": 1850,
        "estimate_high": 2100,
        "duration_min": 235,
        "stops_typical": 0,
        "source": "mock",
        "google_flights_url": "https://www.google.com/travel/flights?q=mock",
        "seat_class": seat_class or "economy",
        "seat_class_label": "Economy",
    }


async def mock_geocode_city(query: str):
    """Return mock geocode data."""
    return {"lat": 35.6762, "lng": 139.6503, "city": "Tokyo", "country": "Japan"}


async def mock_navigate_menu(panel: str, item: str | None = None, **kwargs):
    """Mock navigate — no-op, just returns success."""
    return {"status": "ok", "panel": panel}


async def mock_request_input(field: str, prompt: str, options: list | None = None):
    """Mock request_input."""
    return {"status": "waiting", "field": field}


async def mock_get_day_windows(flight: dict | None = None, trip_days: int = 3, start_date: str | None = None):
    """Return mock day windows."""
    windows = []
    for d in range(1, trip_days + 1):
        start_time = "15:30" if d == 1 else "08:00"
        end_time = "14:00" if d == trip_days else "22:00"
        windows.append({
            "day": d,
            "date": f"2026-05-{14 + d:02d}",
            "start_time": start_time,
            "end_time": end_time,
            "notes": "Arrival day" if d == 1 else ("Departure day" if d == trip_days else "Full day"),
        })
    return windows


async def mock_get_phrasebook(destination: str):
    """Return mock Japanese phrasebook."""
    return {
        "language": "Japanese",
        "language_code": "ja",
        "phrases": [
            {"key": "hello", "english": "Hello", "romanized": "Konnichiwa", "native": "こんにちは"},
            {"key": "thank_you", "english": "Thank you", "romanized": "Arigatou", "native": "ありがとう"},
            {"key": "excuse_me", "english": "Excuse me", "romanized": "Sumimasen", "native": "すみません"},
        ],
    }


# The dispatch table that replaces TOOL_DISPATCH when MOCK_TOOLS=1
MOCK_DISPATCH: dict = {
    "search_places": mock_search_places,
    "get_place_details": mock_get_place_details,
    "get_directions": mock_get_directions,
    "get_weather": mock_get_weather,
    "search_flights": mock_search_flights,
    "geocode_city": mock_geocode_city,
    "navigate_menu": mock_navigate_menu,
    "request_input": mock_request_input,
    "get_day_windows": mock_get_day_windows,
    "get_phrasebook": mock_get_phrasebook,
}
