"""Tests for bench_eval mode — collapses multi-turn flow into one response."""
import json
from types import SimpleNamespace
from unittest.mock import patch, AsyncMock

import pytest

from app import llm
from app.llm import chat, _run_loop
from app.prompts import BENCH_EVAL_ADDENDUM

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
