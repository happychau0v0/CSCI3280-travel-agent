"""P3: SSE event ordering tests.

Test chat_stream's event ordering invariants WITHOUT mocking the
event emission logic. We mock the OpenAI client to return predetermined
tool_calls, and mock TOOL_DISPATCH so tools return instantly, but let
the real async queue / event pipeline run.

This catches:
  - navigate events firing before done (empty panel flash)
  - tool_start without matching tool_end
  - done event missing itinerary when tools were called
  - request_input events racing with done
"""
from __future__ import annotations

import json
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.llm import chat_stream


# ─── Helpers ─────────────────────────────────────────────────────────────


def _make_message(content: str = "", tool_calls=None):
    """Build a fake OpenAI ChatCompletionMessage."""
    msg = MagicMock()
    msg.content = content
    msg.tool_calls = tool_calls
    return msg


def _make_tool_call(tc_id: str, name: str, args: dict):
    """Build a fake tool_call object."""
    tc = MagicMock()
    tc.id = tc_id
    tc.function.name = name
    tc.function.arguments = json.dumps(args)
    return tc


def _make_completion(message):
    """Wrap a message in a fake ChatCompletion response (kept for readability at call sites)."""
    resp = MagicMock()
    resp.choices = [MagicMock()]
    resp.choices[0].message = message
    return resp


async def _astream_message(msg):
    """Convert a fake message into streaming chunks (async generator).

    chat_stream() now uses stream=True, so mocks must return async generators
    instead of plain completion objects.
    """
    if msg.content:
        yield SimpleNamespace(
            choices=[SimpleNamespace(
                delta=SimpleNamespace(content=msg.content, tool_calls=None)
            )]
        )
    if msg.tool_calls:
        for i, tc in enumerate(msg.tool_calls):
            yield SimpleNamespace(
                choices=[SimpleNamespace(
                    delta=SimpleNamespace(
                        content=None,
                        tool_calls=[SimpleNamespace(
                            index=i,
                            id=tc.id,
                            function=SimpleNamespace(
                                name=tc.function.name,
                                arguments=tc.function.arguments,
                            ),
                        )],
                    )
                )]
            )


def _non_token(events: list) -> list:
    """Filter out token and thinking events so ordering tests stay focused on control flow."""
    return [e for e in events if e["type"] not in ("token", "thinking")]


def _mock_client_with_responses(responses: list):
    """Build a mock OpenAI client that streams responses in sequence.

    Accepts the same list of _make_completion(msg) objects as before;
    internally extracts the message and returns a streaming async generator.
    """
    msgs = [r.choices[0].message for r in responses]
    idx = 0

    async def fake_create(*args, **kwargs):
        nonlocal idx
        stream = _astream_message(msgs[idx])
        idx += 1
        return stream

    client = AsyncMock()
    client.chat.completions.create = fake_create
    return client


# ─── Simple flow: no tool calls ─────────────────────────────────────────


class TestStreamNoTools:
    """A simple reply with no tool calls should emit only a done event."""

    @pytest.mark.asyncio
    async def test_single_done_event(self):
        msg = _make_message(content="Hello! How can I help?")
        client = _mock_client_with_responses([_make_completion(msg)])

        with patch("app.llm._get_client", return_value=client):
            events = [e async for e in chat_stream([{"role": "user", "content": "hi"}])]

        ctl = _non_token(events)
        assert len(ctl) == 1
        assert ctl[0]["type"] == "done"
        assert "Hello" in ctl[0]["data"]["reply"]
        # token events should carry the text
        tokens = [e for e in events if e["type"] == "token"]
        assert any("Hello" in e["data"]["text"] for e in tokens)

    @pytest.mark.asyncio
    async def test_done_has_null_itinerary_when_no_json(self):
        msg = _make_message(content="Just a text reply, no JSON.")
        client = _mock_client_with_responses([_make_completion(msg)])

        with patch("app.llm._get_client", return_value=client):
            events = [e async for e in chat_stream([{"role": "user", "content": "hi"}])]

        done = next(e for e in events if e["type"] == "done")
        assert done["data"]["itinerary"] is None


# ─── Tool call flow: tool_start/tool_end pairing ────────────────────────


class TestStreamToolPairing:
    """Every tool_start must have a matching tool_end."""

    @pytest.mark.asyncio
    async def test_start_end_paired(self):
        """Single tool call: tool_start, tool_end, done."""
        tc = _make_tool_call("tc1", "geocode_city", {"query": "Tokyo"})
        msg1 = _make_message(tool_calls=[tc])
        msg2 = _make_message(content="Tokyo is at 35.68, 139.69.")

        client = _mock_client_with_responses([
            _make_completion(msg1),
            _make_completion(msg2),
        ])

        mock_tool = AsyncMock(return_value={"lat": 35.68, "lng": 139.69})

        with (
            patch("app.llm._get_client", return_value=client),
            patch("app.llm.TOOL_DISPATCH", {"geocode_city": mock_tool}),
        ):
            events = [e async for e in chat_stream([{"role": "user", "content": "Where is Tokyo?"}])]

        ctl = _non_token(events)
        starts = [e["data"]["name"] for e in ctl if e["type"] == "tool_start"]
        ends = [e["data"]["name"] for e in ctl if e["type"] == "tool_end"]

        assert starts == ends, f"Unpaired tool events: starts={starts}, ends={ends}"
        assert ctl[-1]["type"] == "done"

    @pytest.mark.asyncio
    async def test_multiple_parallel_tools_paired(self):
        """Multiple parallel tool calls all get start/end pairs."""
        tc1 = _make_tool_call("tc1", "geocode_city", {"query": "Tokyo"})
        tc2 = _make_tool_call("tc2", "get_weather", {"city": "Tokyo"})
        msg1 = _make_message(tool_calls=[tc1, tc2])
        msg2 = _make_message(content="Tokyo weather is sunny.")

        client = _mock_client_with_responses([
            _make_completion(msg1),
            _make_completion(msg2),
        ])

        mock_geocode = AsyncMock(return_value={"lat": 35.68, "lng": 139.69})
        mock_weather = AsyncMock(return_value={"condition": "Sunny", "temp_c": 25})

        dispatch = {"geocode_city": mock_geocode, "get_weather": mock_weather}

        with (
            patch("app.llm._get_client", return_value=client),
            patch("app.llm.TOOL_DISPATCH", dispatch),
        ):
            events = [e async for e in chat_stream([{"role": "user", "content": "Tokyo weather"}])]

        ctl = _non_token(events)
        starts = sorted([e["data"]["name"] for e in ctl if e["type"] == "tool_start"])
        ends = sorted([e["data"]["name"] for e in ctl if e["type"] == "tool_end"])

        assert starts == ends
        assert len(starts) == 2

    @pytest.mark.asyncio
    async def test_tool_error_still_emits_end(self):
        """Tool that throws an exception still gets a tool_end event."""
        tc = _make_tool_call("tc1", "get_weather", {"city": "Ocean"})
        msg1 = _make_message(tool_calls=[tc])
        msg2 = _make_message(content="Weather unavailable.")

        client = _mock_client_with_responses([
            _make_completion(msg1),
            _make_completion(msg2),
        ])

        mock_weather = AsyncMock(side_effect=Exception("API 404"))

        with (
            patch("app.llm._get_client", return_value=client),
            patch("app.llm.TOOL_DISPATCH", {"get_weather": mock_weather}),
        ):
            events = [e async for e in chat_stream([{"role": "user", "content": "ocean weather"}])]

        ctl = _non_token(events)
        starts = [e["data"]["name"] for e in ctl if e["type"] == "tool_start"]
        ends = [e["data"]["name"] for e in ctl if e["type"] == "tool_end"]
        assert starts == ends == ["get_weather"]


# ─── Navigate event ordering ────────────────────────────────────────────


class TestStreamNavigateOrdering:
    """Navigate events must be emitted, and done must be the final event."""

    @pytest.mark.asyncio
    async def test_navigate_emitted_before_done(self):
        """navigate_menu call should emit a navigate event."""
        tc = _make_tool_call("tc1", "navigate_menu", {"panel": "FLIGHTS"})
        msg1 = _make_message(tool_calls=[tc])
        msg2 = _make_message(content="Switching to flights.")

        client = _mock_client_with_responses([
            _make_completion(msg1),
            _make_completion(msg2),
        ])

        mock_navigate = AsyncMock(return_value={"status": "ok"})

        with (
            patch("app.llm._get_client", return_value=client),
            patch("app.llm.TOOL_DISPATCH", {"navigate_menu": mock_navigate}),
        ):
            events = [e async for e in chat_stream([{"role": "user", "content": "show flights"}])]

        ctl = _non_token(events)
        types = [e["type"] for e in ctl]

        # Navigate event should exist
        assert "navigate" in types, "navigate event was not emitted"
        # done must be the last event
        assert types[-1] == "done"

    @pytest.mark.asyncio
    async def test_done_is_always_last_event(self):
        """No matter what tools run, done must be the final event."""
        tc1 = _make_tool_call("tc1", "geocode_city", {"query": "Tokyo"})
        tc2 = _make_tool_call("tc2", "navigate_menu", {"panel": "HOTELS"})
        msg1 = _make_message(tool_calls=[tc1, tc2])
        msg2 = _make_message(content="Here are Tokyo hotels.")

        client = _mock_client_with_responses([
            _make_completion(msg1),
            _make_completion(msg2),
        ])

        dispatch = {
            "geocode_city": AsyncMock(return_value={"lat": 35.68, "lng": 139.69}),
            "navigate_menu": AsyncMock(return_value={"status": "ok"}),
        }

        with (
            patch("app.llm._get_client", return_value=client),
            patch("app.llm.TOOL_DISPATCH", dispatch),
        ):
            events = [e async for e in chat_stream([{"role": "user", "content": "hotels tokyo"}])]

        ctl = _non_token(events)
        types = [e["type"] for e in ctl]
        assert types[-1] == "done"
        # No events after done
        done_idx = types.index("done")
        assert done_idx == len(types) - 1


# ─── request_input event emission ───────────────────────────────────────


class TestStreamRequestInput:
    """request_input tool should emit a request_input event."""

    @pytest.mark.asyncio
    async def test_request_input_event_emitted(self):
        tc = _make_tool_call("tc1", "request_input", {
            "field": "destination",
            "prompt": "Where would you like to go?",
        })
        msg1 = _make_message(tool_calls=[tc])
        msg2 = _make_message(content="Please tell me your destination.")

        client = _mock_client_with_responses([
            _make_completion(msg1),
            _make_completion(msg2),
        ])

        mock_ri = AsyncMock(return_value={"status": "waiting"})

        with (
            patch("app.llm._get_client", return_value=client),
            patch("app.llm.TOOL_DISPATCH", {"request_input": mock_ri}),
        ):
            events = [e async for e in chat_stream([{"role": "user", "content": "plan a trip"}])]

        ctl = _non_token(events)
        types = [e["type"] for e in ctl]
        assert "request_input" in types

        ri_event = next(e for e in ctl if e["type"] == "request_input")
        assert ri_event["data"]["field"] == "destination"


# ─── Error handling ─────────────────────────────────────────────────────


class TestStreamErrorHandling:
    """Missing API key or LLM crash should emit an error event."""

    @pytest.mark.asyncio
    async def test_missing_api_key_emits_error(self):
        with patch("app.llm._get_client", side_effect=RuntimeError("OPENROUTER_API_KEY not configured")):
            events = [e async for e in chat_stream([{"role": "user", "content": "hi"}])]

        assert len(events) == 1
        assert events[0]["type"] == "error"
        assert "API_KEY" in events[0]["data"]["message"]

    @pytest.mark.asyncio
    async def test_llm_crash_emits_error(self):
        client = AsyncMock()
        client.chat.completions.create = AsyncMock(
            side_effect=Exception("Connection timeout")
        )

        with patch("app.llm._get_client", return_value=client):
            events = [e async for e in chat_stream([{"role": "user", "content": "hi"}])]

        # A "thinking" event may precede the error (LLM signalled start before crash).
        error_events = [e for e in events if e["type"] == "error"]
        assert len(error_events) == 1
        assert error_events[0]["type"] == "error"
