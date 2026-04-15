"""Tool wrappers + OpenAI function-calling definitions for the LLM."""
from __future__ import annotations

from app.tools import (
    airports as airports_tool,
    day_windows,
    directions,
    flights,
    geocode,
    navigate,
    phrasebook,
    places,
    request_input as request_input_tool,
    ui_tools,
    weather,
)
from app.tools.errors import ToolUnavailableError

import os

__all__ = ["TOOL_DEFINITIONS", "TOOL_DISPATCH", "ToolUnavailableError"]


TOOL_DEFINITIONS: list[dict] = [
    {
        "type": "function",
        "function": {
            "name": "search_places",
            "description": (
                "Search for real places (restaurants, attractions, hotels, museums) by text query. "
                "ALWAYS call this before recommending any place. Returns names, addresses, ratings, "
                "place IDs, editorial descriptions, and opening hours."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "What to search for, e.g. 'best ramen', 'art museums'",
                    },
                    "location": {
                        "type": "string",
                        "description": "City or area for the search, e.g. 'Tokyo, Japan'",
                    },
                    "radius_km": {
                        "type": "number",
                        "description": "Search radius in kilometers (default 5)",
                    },
                },
                "required": ["query"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_place_details",
            "description": (
                "Get detailed info about a specific place by its place_id, including opening "
                "hours, reviews, photos, and description. Use after search_places."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "place_id": {
                        "type": "string",
                        "description": "The place_id from a search_places result",
                    },
                },
                "required": ["place_id"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_directions",
            "description": (
                "Get a route between two locations. ALWAYS call this before suggesting transport "
                "between attractions. Returns duration, distance, and step-by-step instructions."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "origin": {
                        "type": "string",
                        "description": "Starting address or place name",
                    },
                    "destination": {
                        "type": "string",
                        "description": "Ending address or place name",
                    },
                    "mode": {
                        "type": "string",
                        "enum": ["DRIVE", "WALK", "BICYCLE", "TRANSIT", "TWO_WHEELER"],
                        "description": "Travel mode (default TRANSIT)",
                    },
                },
                "required": ["origin", "destination"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_weather",
            "description": (
                "Get current weather and 5-day forecast for a city. Call this when planning "
                "outdoor activities or when the user asks about weather."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "city": {
                        "type": "string",
                        "description": "City name, e.g. 'Paris, France'",
                    },
                    "date": {
                        "type": "string",
                        "description": "Optional ISO date (YYYY-MM-DD) for a specific day",
                    },
                },
                "required": ["city"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "search_flights",
            "description": (
                "Search for flights between two cities. Use this when planning a trip "
                "to a destination far enough that flying makes sense (>500km). Returns "
                "real flight prices when available, or a deterministic price estimate "
                "as a fallback. Always returns a Google Flights deep link the user can "
                "click to verify live prices."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "origin": {
                        "type": "string",
                        "description": (
                            "Departure airport — prefer a 3-letter IATA code (e.g. 'HKG', 'NRT'). "
                            "The ORIGIN field in the form contains a label like "
                            "'Hong Kong International Airport (HKG)' — extract the code in "
                            "parentheses and pass just that. A city name also works as fallback."
                        ),
                    },
                    "destination": {
                        "type": "string",
                        "description": (
                            "Arrival airport — prefer a 3-letter IATA code (e.g. 'NRT', 'LHR'). "
                            "The DESTINATION field contains a label like 'Tokyo Narita (NRT)' — "
                            "extract the code in parentheses and pass just that. "
                            "A city name also works as fallback."
                        ),
                    },
                    "date": {
                        "type": "string",
                        "description": "Optional ISO date (YYYY-MM-DD). Defaults to 30 days from now.",
                    },
                    "seat_class": {
                        "type": "string",
                        "enum": ["economy", "premium_economy", "business", "first"],
                        "description": "Optional cabin class. Defaults to 'economy'. When the user has picked a non-economy class on the PLAN form, pass it here so prices reflect the right cabin.",
                    },
                },
                "required": ["origin", "destination"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "geocode_city",
            "description": (
                "Look up the lat/lng coordinates of a city or country. Use this when "
                "the user mentions a destination so you can pin it on the map and "
                "compute travel distance from the user's current location."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "City or place name, e.g. 'Tokyo, Japan' or 'Paris'",
                    },
                },
                "required": ["query"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "navigate_menu",
            "description": (
                "Navigate the UI to a named panel. Call ONCE at the very end of your reply, "
                "after the JSON block has been emitted. Valid targets: "
                "'FLIGHTS' (after building a flight list), "
                "'HOTELS' (after a hotel replan), "
                "'DAYS' (after a day replan). "
                "Never call this mid-stream or before the JSON is complete."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "panel": {
                        "type": "string",
                        "enum": ["FLIGHTS", "HOTELS", "DAYS"],
                        "description": "The panel to switch to",
                    },
                    "item": {
                        "type": "string",
                        "description": (
                            "Optional item to highlight in the panel's list — "
                            "for FLIGHTS pass a type like 'non-stop', for HOTELS "
                            "pass a hotel name, for DAYS pass a day number."
                        ),
                    },
                    "filter": {
                        "type": "object",
                        "description": "Optional filter/sort hint, e.g. {\"sort\": \"price_asc\"}",
                    },
                },
                "required": ["panel"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "request_input",
            "description": (
                "Ask the user for a single structured value through the "
                "TRIP form UI instead of via voice. Use this whenever you "
                "need a discrete input — destination, transport mode, "
                "dates, party size — and prefer it over asking via reply "
                "text. The frontend will switch to the TRIP panel, focus "
                "the requested field with a pulsing glow, and display "
                "the prompt above it. The user's answer comes back as a "
                "follow-up chat message."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "field": {
                        "type": "string",
                        "enum": [
                            "destination",
                            "start_date",
                            "end_date",
                            "transport",
                            "party_size",
                            "interests",
                            "origin",
                        ],
                        "description": "Which TRIP form field to focus",
                    },
                    "prompt": {
                        "type": "string",
                        "description": "Short prompt to display, e.g. 'Driving, transit, or walking?'",
                    },
                    "options": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "Optional list of choices for select-style fields",
                    },
                },
                "required": ["field", "prompt"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_day_windows",
            "description": (
                "Compute flight-aware activity windows for each day of a "
                "multi-day trip. Call this AFTER search_flights and BEFORE "
                "populating the day-by-day itinerary. It returns a list "
                "of {day, date, start_time, end_time, notes} per day, "
                "accounting for airport transit + baggage on the arrival "
                "day and airport check-in buffer on the departure day. "
                "Every activity you emit must fall within its day's "
                "window — otherwise the day plan would have activities "
                "starting before the flight has landed or after the "
                "passenger has left for the airport."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "flight": {
                        "type": "object",
                        "description": (
                            "The selected flight option dict. Must include "
                            "arrival_time and departure_time as HH:MM strings "
                            "(local destination time). If you have the full "
                            "flight dict from search_flights, pass it as-is."
                        ),
                    },
                    "trip_days": {
                        "type": "integer",
                        "description": "Total number of days in the trip (≥1)",
                    },
                    "start_date": {
                        "type": "string",
                        "description": "ISO start date YYYY-MM-DD. Used to label each window with its date.",
                    },
                },
                "required": ["trip_days"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "toggle_setting",
            "description": (
                "Change a UI setting in the app. Use this when the user asks to "
                "turn TTS on/off, change currency, adjust subtitle size, switch "
                "dark/light theme, or toggle auto-replan. The frontend will apply "
                "the change immediately without requiring the user to open settings."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "setting": {
                        "type": "string",
                        "enum": ["tts_enabled", "theme", "currency", "subtitle_size", "auto_replan"],
                        "description": "Which setting to change",
                    },
                    "value": {
                        "description": (
                            "New value. For tts_enabled: true/false. "
                            "For theme: 'dark' or 'light'. "
                            "For currency: ISO 4217 code e.g. 'USD', 'HKD', 'JPY'. "
                            "For subtitle_size: 'small', 'medium', 'large'. "
                            "For auto_replan: true/false."
                        ),
                    },
                },
                "required": ["setting", "value"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "submit_trip_form",
            "description": (
                "Pre-fill the trip planning form and auto-start planning when all "
                "required fields are valid (destination, start_date YYYY-MM-DD, "
                "end_date YYYY-MM-DD, transport). If any required field is missing "
                "or invalid the form is pre-filled for the user to review and submit. "
                "Use when the user tells you a destination, dates, or trip details."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "destination": {
                        "type": "string",
                        "description": (
                            "Arrival airport as a 3-letter IATA code (e.g. 'NRT', 'LHR'). "
                            "Do not pass a city name — the form uses airport pickers."
                        ),
                    },
                    "origin": {
                        "type": "string",
                        "description": (
                            "Departure airport as a 3-letter IATA code (e.g. 'HKG', 'SIN'). "
                            "Do not pass a city name — the form uses airport pickers."
                        ),
                    },
                    "start_date": {
                        "type": "string",
                        "description": "ISO date YYYY-MM-DD",
                    },
                    "end_date": {
                        "type": "string",
                        "description": "ISO date YYYY-MM-DD",
                    },
                    "transport": {
                        "type": "string",
                        "enum": ["flight", "train", "drive", "any"],
                        "description": "Preferred transport mode",
                    },
                    "party_size": {
                        "type": "integer",
                        "description": "Number of travelers",
                    },
                    "interests": {
                        "type": "string",
                        "description": "Comma-separated interests, e.g. 'food, museums, hiking'",
                    },
                },
                "required": [],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "pick_flight",
            "description": (
                "Select a flight option from the FLIGHTS panel. Use when the user "
                "says 'pick the first flight', 'book the cheapest option', or similar. "
                "Pass either label/airline name OR zero-based index — not both."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "label": {
                        "type": "string",
                        "description": "Airline name or flight label to match, e.g. 'Cathay Pacific'",
                    },
                    "index": {
                        "type": "integer",
                        "description": "Zero-based index of the flight option (0 = first listed)",
                    },
                },
                "required": [],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "pick_hotel",
            "description": (
                "Select a hotel from the HOTELS panel. Use when the user says "
                "'pick that hotel', 'book the Park Hyatt', or similar. "
                "Pass either name OR zero-based index — not both."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "name": {
                        "type": "string",
                        "description": "Hotel name to match, e.g. 'Park Hyatt Tokyo'",
                    },
                    "index": {
                        "type": "integer",
                        "description": "Zero-based index of the hotel (0 = first listed)",
                    },
                },
                "required": [],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "replace_activity",
            "description": (
                "Replace a specific activity in the day itinerary. Use when the user "
                "says 'swap the lunch on day 2', 'change the museum visit', etc. "
                "Triggers a days replan scoped to the replacement query."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "day": {
                        "type": "integer",
                        "description": "Day number (1-based) containing the activity",
                    },
                    "activity_name": {
                        "type": "string",
                        "description": "Name of the activity to replace",
                    },
                    "query": {
                        "type": "string",
                        "description": "What to replace it with, e.g. 'a different sushi restaurant'",
                    },
                },
                "required": ["day", "activity_name"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "search_airports",
            "description": (
                "Search the airport database by name, city, country, or IATA code. "
                "Use this when the user mentions an ambiguous location that could map "
                "to multiple airports (e.g. 'Tokyo' → NRT or HND, 'London' → LHR/LGW/STN). "
                "Returns up to `limit` matching airports with IATA codes and city names. "
                "After calling this, present the options to the user with request_input "
                "using the `options` list so they can pick the right airport."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "City name, airport name, or IATA code, e.g. 'Tokyo' or 'LHR'",
                    },
                    "limit": {
                        "type": "integer",
                        "description": "Max results to return (default 5, max 10)",
                    },
                },
                "required": ["query"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_phrasebook",
            "description": (
                "Return a small phrasebook (10 essential phrases) for the destination's "
                "local language. Useful for international trips. Call this once after "
                "picking a destination and embed the result in the itinerary's "
                "`phrasebook` field so the DAYS panel can display it. Supports: "
                "ja/ko/zh/fr/es/de/it/th. Returns {error} for unsupported destinations; "
                "skip the field in that case."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "destination": {
                        "type": "string",
                        "description": "City, country, or language name (e.g. 'Tokyo', 'Japan', 'ja').",
                    },
                },
                "required": ["destination"],
            },
        },
    },
]


async def _search_airports(query: str, limit: int = 5) -> list[dict]:
    """Thin async wrapper around airports.search() for TOOL_DISPATCH."""
    results = airports_tool.search(query, limit=min(limit, 10))
    return results


TOOL_DISPATCH: dict = {
    "search_places": places.search_places,
    "get_place_details": places.get_place_details,
    "get_directions": directions.get_directions,
    "get_weather": weather.get_weather,
    "geocode_city": geocode.geocode_city,
    "search_flights": flights.search_flights,
    "search_airports": _search_airports,
    "navigate_menu": navigate.navigate_menu,
    "request_input": request_input_tool.request_input,
    "get_day_windows": day_windows.get_day_windows,
    "get_phrasebook": phrasebook.get_phrasebook,
    "toggle_setting": ui_tools.toggle_setting,
    "submit_trip_form": ui_tools.submit_trip_form,
    "pick_flight": ui_tools.pick_flight,
    "pick_hotel": ui_tools.pick_hotel,
    "replace_activity": ui_tools.replace_activity,
}

# Integration testing: when MOCK_TOOLS=1 is set, replace all tool
# implementations with deterministic fixture-returning stubs. This lets
# Playwright integration tests exercise the REAL SSE pipeline, JSON
# extraction, and state transitions without needing API keys.
if os.getenv("MOCK_TOOLS"):
    from app.tools.mock_dispatch import MOCK_DISPATCH

    TOOL_DISPATCH.update(MOCK_DISPATCH)
