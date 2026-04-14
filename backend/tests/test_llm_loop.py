"""Tests for the LLM dispatcher loop in app/llm.py.

Covers what the chat-endpoint and tool-wrapper suites don't:
  - parallel tool execution via asyncio.gather (not serial)
  - MAX_TOOL_ROUNDS halts a runaway loop
  - region-error on round 0 swaps to FALLBACK_LLM_MODEL silently
  - _extract_itinerary handles fenced, bare, and malformed JSON
"""
from __future__ import annotations

import asyncio
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import openai
import pytest

from app import llm
from app.llm import _extract_itinerary, _is_region_error


def _msg(content: str = "", tool_calls: list | None = None):
    """Build a fake openai chat-completion choice message."""
    return SimpleNamespace(content=content, tool_calls=tool_calls)


def _tc(call_id: str, name: str, args: dict):
    """Build a fake tool_call object."""
    return SimpleNamespace(
        id=call_id,
        function=SimpleNamespace(name=name, arguments=json.dumps(args)),
    )


def _completion(message):
    return SimpleNamespace(choices=[SimpleNamespace(message=message)])


# ─── parallel tool execution ──────────────────────────────────────────────


@pytest.mark.asyncio
async def test_tools_run_in_parallel_via_gather():
    """Multiple tool calls in one round must run concurrently, not serially."""

    started: list[float] = []

    async def slow_tool(**kwargs):
        started.append(asyncio.get_event_loop().time())
        await asyncio.sleep(0.2)
        return {"ok": True}

    fake_tools = {"slow_a": slow_tool, "slow_b": slow_tool, "slow_c": slow_tool}

    round0 = _completion(_msg(
        content="",
        tool_calls=[
            _tc("c1", "slow_a", {}),
            _tc("c2", "slow_b", {}),
            _tc("c3", "slow_c", {}),
        ],
    ))
    round1 = _completion(_msg(content="done", tool_calls=None))

    fake_client = SimpleNamespace(
        chat=SimpleNamespace(
            completions=SimpleNamespace(
                create=AsyncMock(side_effect=[round0, round1])
            )
        )
    )

    with patch.object(llm, "_get_client", return_value=fake_client), \
         patch.object(llm, "TOOL_DISPATCH", fake_tools):
        t0 = asyncio.get_event_loop().time()
        result = await llm._run_loop([{"role": "user", "content": "hi"}])
        elapsed = asyncio.get_event_loop().time() - t0

    assert len(started) == 3
    # All three tools should have started within ~50ms of each other if parallel.
    assert max(started) - min(started) < 0.05
    # Total wall time should be ~0.2s (one slow_tool), not ~0.6s (three serial).
    assert elapsed < 0.45
    assert result["reply"] == "done"
    assert sorted(result["tool_calls_made"]) == ["slow_a", "slow_b", "slow_c"]


# ─── MAX_TOOL_ROUNDS guard ────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_max_tool_rounds_halts_runaway_loop():
    """If the model keeps emitting tool_calls forever, the loop must stop."""

    async def noop(**kwargs):
        return {"ok": True}

    looping_response = _completion(_msg(
        content="thinking…",
        tool_calls=[_tc("x", "noop", {})],
    ))

    fake_client = SimpleNamespace(
        chat=SimpleNamespace(
            completions=SimpleNamespace(
                create=AsyncMock(return_value=looping_response)
            )
        )
    )

    with patch.object(llm, "_get_client", return_value=fake_client), \
         patch.object(llm, "TOOL_DISPATCH", {"noop": noop}), \
         patch.object(llm, "MAX_TOOL_ROUNDS", 5):
        result = await llm._run_loop([{"role": "user", "content": "go"}])

    # Exactly MAX_TOOL_ROUNDS calls — the 6th would be over the cap.
    assert fake_client.chat.completions.create.await_count == 5
    assert len(result["tool_calls_made"]) == 5
    assert result["reply"] == "thinking…"


# ─── region-error fallback ────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_region_error_swaps_to_fallback_model_on_round_zero():
    """A 403 / region error on round 0 must transparently retry with the fallback."""

    fallback_response = _completion(_msg(content="from fallback", tool_calls=None))

    region_err = openai.APIConnectionError(
        message="403 region not available",
        request=SimpleNamespace(method="POST", url="https://api.x.ai/v1/chat/completions"),
    )

    fake_client = SimpleNamespace(
        chat=SimpleNamespace(
            completions=SimpleNamespace(
                create=AsyncMock(side_effect=[region_err, fallback_response])
            )
        )
    )

    events: list[tuple[str, dict]] = []

    async def on_event(t, p):
        events.append((t, p))

    with patch.object(llm, "_get_client", return_value=fake_client), \
         patch.object(llm, "LLM_MODEL", "primary-model"), \
         patch.object(llm, "FALLBACK_LLM_MODEL", "fallback-model"):
        result = await llm._run_loop(
            [{"role": "user", "content": "hi"}],
            on_event=on_event,
        )

    assert result["reply"] == "from fallback"
    # Second call should have used the fallback model.
    second_call_kwargs = fake_client.chat.completions.create.await_args_list[1].kwargs
    assert second_call_kwargs["model"] == "fallback-model"
    # A model_fallback event should have been emitted.
    assert any(t == "model_fallback" for t, _ in events)


def test_is_region_error_recognises_common_phrasings():
    assert _is_region_error(Exception("403 forbidden"))
    assert _is_region_error(Exception("model not available in your region"))
    assert _is_region_error(Exception("country restriction"))
    assert not _is_region_error(Exception("rate limit exceeded"))
    assert not _is_region_error(Exception("invalid api key"))


# ─── _extract_itinerary ───────────────────────────────────────────────────


def test_extract_itinerary_from_fenced_block():
    text = '''Here you go!
```json
{"itinerary": {"title": "X", "days": []}}
```
Have fun.'''
    out = _extract_itinerary(text)
    assert out == {"title": "X", "days": []}


def test_extract_itinerary_from_bare_object():
    text = 'preamble {"itinerary": {"title": "Bare", "days": [{"day": 1}]}} trailing'
    out = _extract_itinerary(text)
    assert out["title"] == "Bare"
    assert out["days"] == [{"day": 1}]


def test_extract_itinerary_returns_none_when_absent():
    assert _extract_itinerary("just a text reply, no json") is None
    assert _extract_itinerary("") is None
    assert _extract_itinerary(None) is None
