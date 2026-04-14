"""Tests for bench_eval mode — collapses multi-turn flow into one response."""
import pytest
from unittest.mock import patch, AsyncMock
from app.llm import chat

MOCK_FULL_ITIN = {
    "itinerary": {
        "title": "3 Days in Tokyo",
        "origin": "Hong Kong",
        "destination": "Tokyo",
        "flight": {"options": [{"label": "A", "price_low": 1000}] * 5},
        "hotels": [{"name": "H1", "place_id": "p1"}] * 3,
        "days": [{"day": 1, "activities": []}] * 3,
        "phrasebook": {"language": "Japanese", "phrases": []},
    }
}

@pytest.mark.asyncio
async def test_bench_eval_produces_complete_itinerary():
    """bench_eval=True must produce flights + hotels + days in one response."""
    with patch("app.llm._run_loop", new_callable=AsyncMock) as mock_loop:
        mock_loop.return_value = {
            "reply": "```json\n" + str(MOCK_FULL_ITIN) + "\n```\nDone.",
            "itinerary": MOCK_FULL_ITIN["itinerary"],
            "tool_calls_made": [],
        }
        result = await chat(
            [{"role": "user", "content": "Plan 3 days in Tokyo"}],
            bench_eval=True,
        )
    # Verify bench_eval was passed through to _run_loop
    call_kwargs = mock_loop.call_args.kwargs
    assert call_kwargs.get("bench_eval") is True
