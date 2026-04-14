"""Golden-path integration test: real xAI + real tools end-to-end.

Gated behind RUN_LIVE=1 so the inner pytest loop stays free and cheap.
Run on demand:
    RUN_LIVE=1 .venv/bin/pytest tests/test_live_llm.py -v -s
"""
from __future__ import annotations

import os

import pytest

pytestmark = pytest.mark.skipif(
    not os.getenv("RUN_LIVE"),
    reason="set RUN_LIVE=1 to hit real xAI + Google APIs",
)


@pytest.mark.asyncio
async def test_golden_tokyo_3day_trip():
    """3-day Tokyo plan should return a valid multi-day itinerary.

    Asserts composition, not exact content:
      - LLM produced a non-empty reply
      - itinerary extracted with ≥3 days
      - search_flights and search_places both fired
    """
    from app.llm import chat

    result = await chat(
        [{"role": "user", "content":
          "Plan a 3-day trip to Tokyo starting 2026-05-01. "
          "I'm flying from Hong Kong. Give me specific restaurants and attractions."}],
    )

    assert result["reply"], "LLM returned an empty reply"

    itin = result["itinerary"]
    assert itin is not None, (
        "No itinerary extracted. First 500 chars of reply:\n"
        f"{result['reply'][:500]}"
    )

    days = itin.get("days", [])
    assert len(days) >= 3, f"expected ≥3 days, got {len(days)}"

    # Every activity should have coords so the DAYS map can render.
    missing_coords = []
    for day in days:
        for act in day.get("activities", []):
            if act.get("lat") is None or act.get("lng") is None:
                missing_coords.append(act.get("name", "?"))
    # Allow a small amount of slippage — the LLM sometimes invents an
    # activity. Fail hard only if >30% are missing coords.
    total_activities = sum(len(d.get("activities", [])) for d in days)
    if total_activities:
        missing_ratio = len(missing_coords) / total_activities
        assert missing_ratio < 0.3, (
            f"{len(missing_coords)}/{total_activities} activities missing "
            f"coords: {missing_coords[:5]}..."
        )

    tools_used = set(result["tool_calls_made"])
    assert "search_flights" in tools_used, f"flights not called; tools={tools_used}"
    assert "search_places" in tools_used, f"places not called; tools={tools_used}"

    print(f"\n  ✅ {len(days)} days, {total_activities} activities, "
          f"{len(tools_used)} distinct tools used: {sorted(tools_used)}")
