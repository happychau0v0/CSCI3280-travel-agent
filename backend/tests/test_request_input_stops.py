"""The request_input stopping rule (llm.py:620-638).

When the LLM emits request_input alongside other tools in the same batch,
the loop MUST:
  1. execute only request_input (and submit_trip_form if present)
  2. skip every other tool call in that batch (search_flights, navigate_menu, …)
  3. break immediately — no further LLM round

This protects against the LLM pre-fetching flight data while simultaneously
asking the user for a missing field, which leads to a confusing UI where
the form is waiting for input while a search spinner runs.
"""
from __future__ import annotations

import json
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest

from app import llm


def _msg(content: str = "", tool_calls: list | None = None):
    return SimpleNamespace(content=content, tool_calls=tool_calls)


def _tc(call_id: str, name: str, args: dict):
    return SimpleNamespace(
        id=call_id,
        function=SimpleNamespace(name=name, arguments=json.dumps(args)),
    )


def _completion(message):
    return SimpleNamespace(choices=[SimpleNamespace(message=message)])


@pytest.mark.asyncio
async def test_request_input_in_batch_skips_concurrent_tools():
    """request_input + search_flights in one batch → only request_input fires."""
    # Track which tools actually get dispatched.
    dispatched: list[str] = []

    async def fake_request_input(**kwargs):
        dispatched.append("request_input")
        return {"ok": True}

    async def fake_search_flights(**kwargs):
        dispatched.append("search_flights")
        return {"ok": True}

    async def fake_navigate_menu(**kwargs):
        dispatched.append("navigate_menu")
        return {"ok": True}

    fake_tools = {
        "request_input": fake_request_input,
        "search_flights": fake_search_flights,
        "navigate_menu": fake_navigate_menu,
    }

    # Round 0: LLM returns a batch of three tool calls. The loop should
    # execute ONLY request_input and break before round 1.
    round0 = _completion(_msg(
        content="",
        tool_calls=[
            _tc("c1", "request_input", {"field": "start_date", "prompt": "When?"}),
            _tc("c2", "search_flights", {"origin": "HKG", "destination": "NRT"}),
            _tc("c3", "navigate_menu", {"panel": "FLIGHTS"}),
        ],
    ))
    # If the loop does not break after round 0, this "don't call me" response
    # serves as a safety net — but the test also asserts only 1 create() call.
    round1 = _completion(_msg(content="should not be reached", tool_calls=None))

    create_mock = AsyncMock(side_effect=[round0, round1])
    fake_client = SimpleNamespace(
        chat=SimpleNamespace(
            completions=SimpleNamespace(create=create_mock)
        )
    )

    with patch.object(llm, "_get_client", return_value=fake_client), \
         patch.object(llm, "_get_fallback_client", return_value=fake_client), \
         patch.object(llm, "TOOL_DISPATCH", fake_tools):
        await llm._run_loop([{"role": "user", "content": "plan a trip"}])

    # Only request_input should have been dispatched; search_flights and
    # navigate_menu must be filtered out.
    assert dispatched == ["request_input"], (
        f"Expected only ['request_input'], got {dispatched}"
    )
    # And the loop must break — no second round.
    assert create_mock.call_count == 1, (
        f"Expected 1 LLM round, got {create_mock.call_count}"
    )


@pytest.mark.asyncio
async def test_request_input_plus_submit_trip_form_both_run():
    """request_input + submit_trip_form is an allowed combo — both should run."""
    dispatched: list[str] = []

    async def fake_request_input(**kwargs):
        dispatched.append("request_input")
        return {"ok": True}

    async def fake_submit_trip_form(**kwargs):
        dispatched.append("submit_trip_form")
        return {"ok": True}

    fake_tools = {
        "request_input": fake_request_input,
        "submit_trip_form": fake_submit_trip_form,
    }

    round0 = _completion(_msg(
        content="",
        tool_calls=[
            _tc("c1", "submit_trip_form", {"destination": "NRT"}),
            _tc("c2", "request_input", {"field": "start_date", "prompt": "When?"}),
        ],
    ))

    create_mock = AsyncMock(side_effect=[round0])
    fake_client = SimpleNamespace(
        chat=SimpleNamespace(
            completions=SimpleNamespace(create=create_mock)
        )
    )

    with patch.object(llm, "_get_client", return_value=fake_client), \
         patch.object(llm, "_get_fallback_client", return_value=fake_client), \
         patch.object(llm, "TOOL_DISPATCH", fake_tools):
        await llm._run_loop([{"role": "user", "content": "plan a trip"}])

    # Both should run (order doesn't matter — they gather in parallel).
    assert set(dispatched) == {"request_input", "submit_trip_form"}, (
        f"Expected both tools to run, got {dispatched}"
    )
    # Loop breaks after round 0 regardless.
    assert create_mock.call_count == 1
