"""Tool wrappers + OpenAI function-calling definitions for the LLM."""
from __future__ import annotations

from app.tools import (
    day_windows,
    directions,
    flights,
    geocode,
    navigate,
    places,
    request_input as request_input_tool,
    search,
    weather,
)
from app.tools.errors import ToolUnavailableError

__all__ = ["TOOL_DEFINITIONS", "TOOL_DISPATCH", "ToolUnavailableError"]


TOOL_DEFINITIONS: list[dict] = [
    {
        "type": "function",
        "function": {
            "name": "search_places",
            "description": (
                "Search for real places (restaurants, attractions, hotels, museums) by text query. "
                "ALWAYS call this before recommending any place. Returns names, addresses, ratings, "
                "and place IDs."
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
                        "description": "Origin city name, e.g. 'Hong Kong'. Major cities only.",
                    },
                    "destination": {
                        "type": "string",
                        "description": "Destination city name, e.g. 'Tokyo'. Major cities only.",
                    },
                    "date": {
                        "type": "string",
                        "description": "Optional ISO date (YYYY-MM-DD). Defaults to 30 days from now.",
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
                "Move the user's menu cursor to a specific panel. The user is "
                "viewing a NieR-style menu with four tabs (HOME, FLIGHTS, "
                "HOTELS, DAYS). HOME contains the editable trip form and the "
                "live status dashboard. Call this tool to focus the user's "
                "attention on a specific tab — e.g. after building a trip, "
                "call navigate_menu('HOME') to show them the dashboard with the "
                "globe; if they ask about hotels, call navigate_menu('HOTELS')."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "panel": {
                        "type": "string",
                        "enum": ["HOME", "FLIGHTS", "HOTELS", "DAYS"],
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
            "name": "web_search",
            "description": (
                "Fallback web search for general info not covered by other tools. "
                "Currently a stub — prefer the other tools whenever possible."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "Search query"},
                },
                "required": ["query"],
            },
        },
    },
]


TOOL_DISPATCH: dict = {
    "search_places": places.search_places,
    "get_place_details": places.get_place_details,
    "get_directions": directions.get_directions,
    "get_weather": weather.get_weather,
    "geocode_city": geocode.geocode_city,
    "search_flights": flights.search_flights,
    "navigate_menu": navigate.navigate_menu,
    "request_input": request_input_tool.request_input,
    "get_day_windows": day_windows.get_day_windows,
    "web_search": search.web_search,
}
