"""Tool wrappers + OpenAI function-calling definitions for the LLM."""
from __future__ import annotations

from app.tools import directions, flights, geocode, places, search, weather
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
    "web_search": search.web_search,
}
