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


# ─── tool_results cache exposed through _run_loop ─────────────────────────


@pytest.mark.asyncio
async def test_tool_results_captured_and_returned():
    """_run_loop should return a tool_results dict mapping name → list of
    result payloads (so rubrics can verify grounding against actual data)."""

    async def places_tool(**kwargs):
        return {"places": [{"name": "Senso-ji", "lat": 35.7, "lng": 139.8}]}

    async def directions_tool(**kwargs):
        return {"duration": "15 mins", "distance": "2 km"}

    round0 = _completion(_msg(
        content="",
        tool_calls=[
            _tc("c1", "search_places", {"query": "temples in Tokyo"}),
            _tc("c2", "get_directions", {"origin": "A", "destination": "B"}),
            _tc("c3", "search_places", {"query": "hotels in Tokyo"}),
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

    fake_tools = {
        "search_places": places_tool,
        "get_directions": directions_tool,
    }

    with patch.object(llm, "_get_client", return_value=fake_client), \
         patch.object(llm, "TOOL_DISPATCH", fake_tools):
        result = await llm._run_loop([{"role": "user", "content": "hi"}])

    assert "tool_results" in result
    tr = result["tool_results"]
    # Two distinct search_places calls should both be kept (list, not overwrite).
    assert len(tr.get("search_places", [])) == 2
    assert tr["search_places"][0] == {
        "places": [{"name": "Senso-ji", "lat": 35.7, "lng": 139.8}]
    }
    assert len(tr.get("get_directions", [])) == 1
    assert tr["get_directions"][0]["duration"] == "15 mins"


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

    region_err = openai.APIConnectionError(
        message="403 region not available",
        request=SimpleNamespace(method="POST", url="https://api.x.ai/v1/chat/completions"),
    )

    # Now that on_event triggers the streaming path, the mock must return an
    # async generator (not a plain _completion object) on the second call.
    async def _fallback_stream():
        yield SimpleNamespace(
            choices=[SimpleNamespace(
                delta=SimpleNamespace(content="from fallback", tool_calls=None)
            )]
        )

    calls: list[dict] = []

    async def fake_create(*args, **kwargs):
        calls.append(kwargs)
        if len(calls) == 1:
            raise region_err
        return _fallback_stream()

    fake_client = SimpleNamespace(
        chat=SimpleNamespace(
            completions=SimpleNamespace(create=fake_create)
        )
    )

    events: list[tuple[str, dict]] = []

    async def on_event(t, p):
        events.append((t, p))

    with patch.object(llm, "_get_client", return_value=fake_client), \
         patch.object(llm, "_get_fallback_client", return_value=fake_client), \
         patch.object(llm, "LLM_MODEL", "primary-model"), \
         patch.object(llm, "FALLBACK_LLM_MODEL", "fallback-model"):
        result = await llm._run_loop(
            [{"role": "user", "content": "hi"}],
            on_event=on_event,
        )

    assert result["reply"] == "from fallback"
    assert len(calls) == 2
    # Second call should have used the fallback model.
    assert calls[1]["model"] == "fallback-model"
    # A model_fallback event should have been emitted.
    assert any(t == "model_fallback" for t, _ in events)


# ─── Gemini thought_signature round-trip ─────────────────────────────────


@pytest.mark.asyncio
async def test_gemini_thought_signature_is_preserved_in_history():
    """thought_signature from a Gemini thinking-model tool call must be
    round-tripped into the assistant message on the next request, otherwise
    Gemini rejects the history with 400 INVALID_ARGUMENT."""

    sig = "AQID"  # fake base-64 signature

    # Round 0: Gemini returns a tool call whose function carries thought_signature
    # in model_extra (how the OpenAI SDK surfaces extra fields from Pydantic v2).
    tc_with_sig = SimpleNamespace(
        id="c1",
        model_extra={},  # not at tc level
        function=SimpleNamespace(
            name="geocode_city",
            arguments='{"city": "Tokyo"}',
            model_extra={"thought_signature": sig},
        ),
    )
    round0 = _completion(_msg(tool_calls=[tc_with_sig]))
    round1 = _completion(_msg(content="done", tool_calls=None))

    captured_calls: list[dict] = []

    async def fake_create(**kwargs):
        captured_calls.append(kwargs)
        idx = len(captured_calls) - 1
        return round0 if idx == 0 else round1

    fake_client = SimpleNamespace(
        chat=SimpleNamespace(completions=SimpleNamespace(create=fake_create))
    )

    async def noop_tool(**kwargs):
        return {"ok": True}

    with patch.object(llm, "_get_client", return_value=fake_client), \
         patch.object(llm, "TOOL_DISPATCH", {"geocode_city": noop_tool}):
        await llm._run_loop([{"role": "user", "content": "plan tokyo"}])

    assert len(captured_calls) == 2, "expected exactly 2 LLM calls (tool round + final)"

    # The second request must include the thought_signature in the assistant message.
    round1_messages = captured_calls[1]["messages"]
    assistant_msg = next(m for m in round1_messages if m.get("role") == "assistant")
    tc_sent = assistant_msg["tool_calls"][0]
    assert tc_sent["function"].get("thought_signature") == sig, (
        "thought_signature was dropped — Gemini would reject this with 400"
    )


@pytest.mark.asyncio
async def test_thought_signature_absent_when_not_in_model_extra():
    """When the model returns no thought_signature (xAI / non-thinking Gemini),
    the serialised tool call must NOT include a thought_signature key."""

    tc_plain = SimpleNamespace(
        id="c1",
        model_extra={},
        function=SimpleNamespace(
            name="geocode_city",
            arguments='{"city": "Paris"}',
            model_extra={},  # no thought_signature
        ),
    )
    round0 = _completion(_msg(tool_calls=[tc_plain]))
    round1 = _completion(_msg(content="done", tool_calls=None))

    calls: list[dict] = []

    async def fake_create(**kwargs):
        calls.append(kwargs)
        return round0 if len(calls) == 1 else round1

    fake_client = SimpleNamespace(
        chat=SimpleNamespace(completions=SimpleNamespace(create=fake_create))
    )

    async def noop_tool(**kwargs):
        return {"ok": True}

    with patch.object(llm, "_get_client", return_value=fake_client), \
         patch.object(llm, "TOOL_DISPATCH", {"geocode_city": noop_tool}):
        await llm._run_loop([{"role": "user", "content": "plan paris"}])

    round1_messages = calls[1]["messages"]
    assistant_msg = next(m for m in round1_messages if m.get("role") == "assistant")
    tc_sent = assistant_msg["tool_calls"][0]
    assert "thought_signature" not in tc_sent["function"], (
        "thought_signature should be absent for non-thinking models"
    )


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


# ─── per-role model routing ───────────────────────────────────────────────


def _make_fake_client(model_calls: list):
    """Return an AsyncMock client that records which model was requested."""

    async def fake_create(**kwargs):
        model_calls.append(kwargs.get("model"))
        return _completion(_msg(content="done"))

    fake_client = AsyncMock()
    fake_client.chat.completions.create = fake_create
    return fake_client


@pytest.mark.asyncio
async def test_role_default_model_applies_when_no_preferred_model():
    """call_role='plan' with no preferred_model → role default (non-reasoning)."""
    model_calls: list[str] = []
    fake_client = _make_fake_client(model_calls)

    with patch.object(llm, "_get_client", return_value=fake_client), \
         patch.object(llm, "_get_fallback_client", return_value=fake_client), \
         patch.object(llm, "LLM_MODEL", "grok-4.20-0309-non-reasoning"):
        await llm._run_loop(
            [{"role": "user", "content": "hi"}],
            preferred_model=None,
            call_role="plan",
        )

    assert model_calls, "client was never called"
    assert model_calls[0] == llm.ROLE_DEFAULT_MODELS["plan"]
    assert "non-reasoning" in model_calls[0]


@pytest.mark.asyncio
async def test_explicit_preferred_model_overrides_role_default():
    """Explicit preferred_model overrides the role default."""
    model_calls: list[str] = []
    fake_client = _make_fake_client(model_calls)

    with patch.object(llm, "_get_client", return_value=fake_client), \
         patch.object(llm, "_get_fallback_client", return_value=fake_client), \
         patch.object(llm, "LLM_MODEL", "grok-4.20-0309-non-reasoning"):
        await llm._run_loop(
            [{"role": "user", "content": "hi"}],
            preferred_model="grok-4.20-0309-reasoning",
            call_role="plan",
        )

    assert model_calls, "client was never called"
    assert model_calls[0] == "grok-4.20-0309-reasoning"


@pytest.mark.asyncio
async def test_role_default_overrides_global_llm_model():
    """When LLM_MODEL is reasoning but call_role has a default, role default wins."""
    model_calls: list[str] = []
    fake_client = _make_fake_client(model_calls)

    with patch.object(llm, "_get_client", return_value=fake_client), \
         patch.object(llm, "_get_fallback_client", return_value=fake_client), \
         patch.object(llm, "LLM_MODEL", "grok-4.20-0309-reasoning"):
        await llm._run_loop(
            [{"role": "user", "content": "hi"}],
            preferred_model=None,
            call_role="hotels",
        )

    assert model_calls, "client was never called"
    assert model_calls[0] == llm.ROLE_DEFAULT_MODELS["hotels"]
    assert "non-reasoning" in model_calls[0]
