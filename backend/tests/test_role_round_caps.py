"""Tests for per-role max-rounds enforcement.

Closes R-HOTELS-001 / R-DAYS-001 / R-DETAIL-001: the three scoped
planner roles (hotels, days, day_detail) are specced for exactly
2 tool-call rounds. `prompts.py` says so in prose; `llm.py` now
enforces it with `ROLE_MAX_ROUNDS`.

The pattern mirrors `test_llm_loop.py::test_max_tool_rounds_halts_runaway_loop`:
feed a fake LLM that keeps emitting tool_calls forever and assert the
loop exits at the per-role cap.
"""
from __future__ import annotations

import json
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest

from app import llm


def _msg(content: str = "", tool_calls: list | None = None):
    return SimpleNamespace(content=content, tool_calls=tool_calls)


def _completion(message):
    return SimpleNamespace(choices=[SimpleNamespace(message=message)])


def _tc(call_id: str, name: str, args: dict):
    return SimpleNamespace(
        id=call_id,
        function=SimpleNamespace(name=name, arguments=json.dumps(args)),
    )


# A tool the LLM keeps calling forever — we want to prove the cap halts us.
async def _noop(**kwargs):
    return {"ok": True}


@pytest.mark.asyncio
@pytest.mark.parametrize("call_role", ["hotels", "days", "day_detail"])
async def test_scoped_planner_halts_at_two_rounds(call_role):
    """hotels / days / day_detail must stop after round 2 even when the
    LLM keeps trying to call tools. This matches R-HOTELS-001/DAYS-001/
    DETAIL-001 in docs/llm-spec.md."""

    # Use tools from the role's allow-list so the filter doesn't drop them.
    # search_places is in all three allow-lists.
    looping = _completion(_msg(
        content="still thinking…",
        tool_calls=[_tc("c1", "search_places", {"query": "tokyo"})],
    ))

    fake_client = SimpleNamespace(
        chat=SimpleNamespace(
            completions=SimpleNamespace(
                create=AsyncMock(return_value=looping)
            )
        )
    )

    with patch.object(llm, "_get_client", return_value=fake_client), \
         patch.object(llm, "TOOL_DISPATCH", {"search_places": _noop}):
        result = await llm._run_loop(
            [{"role": "user", "content": "plan"}],
            call_role=call_role,
        )

    # Exactly 2 LLM calls — the 3rd would be a spec violation.
    assert fake_client.chat.completions.create.await_count == 2
    assert len(result["tool_calls_made"]) == 2
    assert result["reply"] == "still thinking…"


@pytest.mark.asyncio
async def test_plan_role_still_uses_global_cap():
    """plan is NOT in ROLE_MAX_ROUNDS — it inherits MAX_TOOL_ROUNDS.
    Patch the global cap low so the test is fast, and verify the loop
    runs up to that limit instead of 2."""

    looping = _completion(_msg(
        content="still thinking…",
        tool_calls=[_tc("c1", "search_flights", {
            "origin": "HKG", "destination": "NRT",
        })],
    ))

    fake_client = SimpleNamespace(
        chat=SimpleNamespace(
            completions=SimpleNamespace(
                create=AsyncMock(return_value=looping)
            )
        )
    )

    with patch.object(llm, "_get_client", return_value=fake_client), \
         patch.object(llm, "TOOL_DISPATCH", {"search_flights": _noop}), \
         patch.object(llm, "MAX_TOOL_ROUNDS", 5):
        await llm._run_loop(
            [{"role": "user", "content": "plan HKG to NRT"}],
            call_role="plan",
        )

    # plan isn't in ROLE_MAX_ROUNDS, so it uses the global cap (patched to 5).
    assert fake_client.chat.completions.create.await_count == 5


@pytest.mark.asyncio
async def test_chat_role_still_uses_global_cap():
    """chat is NOT in ROLE_MAX_ROUNDS — it inherits MAX_TOOL_ROUNDS.
    Chat conversations may legitimately span many rounds (request_input
    → user reply → submit_trip_form)."""

    looping = _completion(_msg(
        content="still thinking…",
        tool_calls=[_tc("c1", "search_airports", {"query": "Tokyo"})],
    ))

    fake_client = SimpleNamespace(
        chat=SimpleNamespace(
            completions=SimpleNamespace(
                create=AsyncMock(return_value=looping)
            )
        )
    )

    with patch.object(llm, "_get_client", return_value=fake_client), \
         patch.object(llm, "TOOL_DISPATCH", {"search_airports": _noop}), \
         patch.object(llm, "MAX_TOOL_ROUNDS", 4):
        await llm._run_loop(
            [{"role": "user", "content": "hi"}],
            call_role="chat",
        )

    assert fake_client.chat.completions.create.await_count == 4


@pytest.mark.asyncio
async def test_role_cap_does_not_interfere_when_llm_finishes_early():
    """If the LLM finishes in 1 round (no tool_calls), the cap is a
    no-op — we don't force it to keep going."""

    done = _completion(_msg(content="done in one round", tool_calls=None))

    fake_client = SimpleNamespace(
        chat=SimpleNamespace(
            completions=SimpleNamespace(create=AsyncMock(return_value=done))
        )
    )

    with patch.object(llm, "_get_client", return_value=fake_client):
        result = await llm._run_loop(
            [{"role": "user", "content": "plan"}],
            call_role="hotels",
        )

    assert fake_client.chat.completions.create.await_count == 1
    assert result["reply"] == "done in one round"


@pytest.mark.asyncio
async def test_role_cap_stops_before_third_llm_call():
    """The halt must occur BEFORE the 3rd LLM call is made — not after.
    A model that emits tools in rounds 1 and 2 must never see a round 3
    prompt, because sending it would waste a Grok/Gemini request."""

    call_count = 0

    async def fake_create(**kwargs):
        nonlocal call_count
        call_count += 1
        return _completion(_msg(
            content=f"round {call_count}",
            tool_calls=[_tc(f"c{call_count}", "search_places", {"query": "x"})],
        ))

    fake_client = SimpleNamespace(
        chat=SimpleNamespace(completions=SimpleNamespace(create=fake_create))
    )

    with patch.object(llm, "_get_client", return_value=fake_client), \
         patch.object(llm, "TOOL_DISPATCH", {"search_places": _noop}):
        await llm._run_loop(
            [{"role": "user", "content": "plan"}],
            call_role="days",
        )

    assert call_count == 2
