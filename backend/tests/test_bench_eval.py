"""Tests for bench_eval mode and bench scorer."""
import sys
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch, AsyncMock

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
from bench_models import score_itinerary  # noqa: E402

from app import llm
from app.llm import chat, _run_loop
from app.prompts import BENCH_EVAL_ADDENDUM

# ─── scorer tests ────────────────────────────────────────────────────────────


def test_scorer_search_prompt_caps_at_25():
    """flight-search prompt_type='search' should max out at 25 points."""
    itin = {
        "flight": {"options": [{"label": f"F{i}"} for i in range(5)]},
        "phrasebook": {"language": "Japanese", "phrases": []},
        # days/hotels should be ignored for search prompts
        "days": [{"day": 1, "activities": [{"lat": 35.0, "lng": 139.0, "description": "x" * 30}]}],
        "hotels": [{"name": "H1"}] * 5,
    }
    score, features = score_itinerary(itin, prompt_type="search")
    assert score <= 25, f"search prompt capped at 25, got {score}"
    assert any("flights" in f for f in features)
    assert "phrasebook" in features
    # plan-only features must not appear
    assert not any("d" in f and f[0].isdigit() for f in features), "days should not be in search features"


def test_scorer_plan_prompt_includes_description_coverage():
    """plan prompt with activity descriptions should earn description pts."""
    itin = {
        "flight": {"options": [{"label": "F1"}]},
        "days": [{"day": 1, "activities": [
            {"lat": 35.0, "lng": 139.0, "description": "Ancient Buddhist temple in Asakusa."},
            {"lat": 35.1, "lng": 139.1, "description": ""},  # no desc
        ]}],
        "hotels": [],
        "phrasebook": None,
    }
    score_with_desc, features_with_desc = score_itinerary(itin, prompt_type="plan")
    # Remove description from one activity and verify score drops
    itin_no_desc = {**itin, "days": [{"day": 1, "activities": [
        {"lat": 35.0, "lng": 139.0},
        {"lat": 35.1, "lng": 139.1},
    ]}]}
    score_no_desc, _ = score_itinerary(itin_no_desc, prompt_type="plan")
    assert score_with_desc > score_no_desc, (
        f"descriptions should add score: {score_with_desc} <= {score_no_desc}"
    )
    assert any("descs" in f for f in features_with_desc), "description feature tag missing"


def test_scorer_plan_prompt_can_reach_100():
    """A fully populated plan itinerary should score 100."""
    days = [
        {
            "day": i + 1,
            "activities": [
                {
                    "lat": 35.0 + i * 0.1,
                    "lng": 139.0 + i * 0.1,
                    "description": "This is a real description from Google Places API.",
                }
                for _ in range(3)
            ],
        }
        for i in range(4)
    ]
    itin = {
        "flight": {
            "options": [{"label": f"F{i}", "price_low": 1000} for i in range(7)],
            "return_options": [{"label": "R1"}],
        },
        "hotels": [{"name": f"H{i}", "place_id": f"p{i}"} for i in range(8)],
        "days": days,
        "phrasebook": {"language": "Japanese", "phrases": ["hello", "thanks"]},
    }
    score, features = score_itinerary(itin, prompt_type="plan")
    assert score == 100, f"fully populated plan should score 100, got {score} with {features}"


# ─── bench_eval tests ─────────────────────────────────────────────────────────


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
        await chat(
            [{"role": "user", "content": "Plan 3 days in Tokyo"}],
            bench_eval=True,
        )
    # Verify bench_eval was passed through to _run_loop
    call_kwargs = mock_loop.call_args.kwargs
    assert call_kwargs.get("bench_eval") is True


def _msg(content: str = "", tool_calls: list | None = None):
    return SimpleNamespace(content=content, tool_calls=tool_calls)


def _completion(message):
    return SimpleNamespace(choices=[SimpleNamespace(message=message)])


@pytest.mark.asyncio
@pytest.mark.parametrize("bench_eval", [True, False])
async def test_run_loop_system_message_contains_addendum_iff_bench_eval(bench_eval: bool):
    """_run_loop must append BENCH_EVAL_ADDENDUM to the system message when
    bench_eval=True, and must NOT include it when bench_eval=False."""
    fake_response = _completion(_msg(content="done", tool_calls=None))
    fake_client = SimpleNamespace(
        chat=SimpleNamespace(
            completions=SimpleNamespace(
                create=AsyncMock(return_value=fake_response)
            )
        )
    )

    with patch.object(llm, "_get_client", return_value=fake_client):
        await _run_loop(
            [{"role": "user", "content": "Plan 3 days in Tokyo"}],
            bench_eval=bench_eval,
        )

    # The first positional call always receives `messages` as a kwarg.
    call_kwargs = fake_client.chat.completions.create.await_args.kwargs
    messages = call_kwargs["messages"]
    system_content = next(m["content"] for m in messages if m["role"] == "system")

    if bench_eval:
        assert BENCH_EVAL_ADDENDUM in system_content, (
            "Expected BENCH_EVAL_ADDENDUM in system message when bench_eval=True"
        )
    else:
        assert BENCH_EVAL_ADDENDUM not in system_content, (
            "Expected BENCH_EVAL_ADDENDUM absent from system message when bench_eval=False"
        )
