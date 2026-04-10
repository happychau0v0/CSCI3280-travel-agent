"""Web search fallback — stub for MVP.

A future iteration can plug in SerpAPI or Tavily here. The signature is kept
stable so the LLM tool definition does not change.
"""
from __future__ import annotations


async def web_search(query: str) -> list[dict]:
    """Return a stub indicating web search is not configured.

    The LLM should rely on places, directions, and weather tools instead.
    """
    return [
        {
            "title": "Web search unavailable",
            "snippet": (
                "No web search API is configured for this MVP. "
                "Use search_places, get_place_details, get_directions, or get_weather "
                "for real data instead."
            ),
            "url": "",
        }
    ]
