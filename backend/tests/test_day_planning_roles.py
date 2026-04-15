"""Integration tests for day_themes and day_detail role scoping in _run_loop.

Verifies:
  - day_themes passes an empty tools list (no tool calls allowed)
  - day_detail passes only the three permitted tools
  - both roles drop conversation history (fresh context = 2 messages)
  - each role uses its dedicated system prompt
"""
from __future__ import annotations

import json
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest

from app import llm
from app.prompts import SYSTEM_PROMPT_DAY_THEMES, SYSTEM_PROMPT_DAY_DETAIL


# ─── shared helpers (mirror test_llm_loop.py) ────────────────────────────────


def _msg(content: str = "", tool_calls: list | None = None):
    return SimpleNamespace(content=content, tool_calls=tool_calls)


def _completion(message):
    return SimpleNamespace(choices=[SimpleNamespace(message=message)])


def _make_fake_client(captured_kwargs: list):
    """Return a fake client that records every kwargs dict passed to create()."""

    async def fake_create(**kwargs):
        captured_kwargs.append(kwargs)
        return _completion(_msg(content="ok", tool_calls=None))

    fake_client = SimpleNamespace(
        chat=SimpleNamespace(
            completions=SimpleNamespace(create=fake_create)
        )
    )
    return fake_client


# ─── 5 history messages used by fresh-context tests ──────────────────────────

_HISTORY = [
    {"role": "user", "content": "msg 1"},
    {"role": "assistant", "content": "msg 2"},
    {"role": "user", "content": "msg 3"},
    {"role": "assistant", "content": "msg 4"},
    {"role": "user", "content": "plan themes for day 1"},
]


# ─── test 1: day_themes → empty tool list ────────────────────────────────────


@pytest.mark.asyncio
async def test_day_themes_uses_empty_tool_list():
    """day_themes must pass tools=[] to the LLM (no tools allowed)."""
    captured: list[dict] = []
    fake_client = _make_fake_client(captured)

    with patch.object(llm, "_get_client", return_value=fake_client), \
         patch.object(llm, "_get_fallback_client", return_value=fake_client):
        await llm._run_loop(
            [{"role": "user", "content": "plan themes"}],
            call_role="day_themes",
        )

    assert captured, "LLM create was never called"
    assert captured[0]["tools"] == [], (
        f"Expected tools=[], got {captured[0]['tools']}"
    )


# ─── test 2: day_themes → fresh context (2 messages) ────────────────────────


@pytest.mark.asyncio
async def test_day_themes_fresh_context():
    """day_themes must drop all history — only system + last user message go in."""
    captured: list[dict] = []
    fake_client = _make_fake_client(captured)

    with patch.object(llm, "_get_client", return_value=fake_client), \
         patch.object(llm, "_get_fallback_client", return_value=fake_client):
        await llm._run_loop(_HISTORY, call_role="day_themes")

    assert captured, "LLM create was never called"
    msgs = captured[0]["messages"]
    assert len(msgs) == 2, (
        f"Expected 2 messages (system + last user), got {len(msgs)}: {msgs}"
    )
    assert msgs[0]["role"] == "system"
    assert msgs[1] == _HISTORY[-1]


# ─── test 3: day_detail → only the three allowed tools ───────────────────────


@pytest.mark.asyncio
async def test_day_detail_allowed_tools():
    """day_detail must only pass search_places, get_directions, get_weather."""
    captured: list[dict] = []
    fake_client = _make_fake_client(captured)

    with patch.object(llm, "_get_client", return_value=fake_client), \
         patch.object(llm, "_get_fallback_client", return_value=fake_client):
        await llm._run_loop(
            [{"role": "user", "content": "plan day activities"}],
            call_role="day_detail",
        )

    assert captured, "LLM create was never called"
    tool_names = {t["function"]["name"] for t in captured[0]["tools"]}
    assert tool_names == {"search_places", "get_directions", "get_weather"}, (
        f"Unexpected tool names: {tool_names}"
    )


# ─── test 4: day_detail → fresh context (2 messages) ────────────────────────


@pytest.mark.asyncio
async def test_day_detail_fresh_context():
    """day_detail must drop conversation history just like day_themes."""
    captured: list[dict] = []
    fake_client = _make_fake_client(captured)

    with patch.object(llm, "_get_client", return_value=fake_client), \
         patch.object(llm, "_get_fallback_client", return_value=fake_client):
        await llm._run_loop(_HISTORY, call_role="day_detail")

    assert captured, "LLM create was never called"
    msgs = captured[0]["messages"]
    assert len(msgs) == 2, (
        f"Expected 2 messages (system + last user), got {len(msgs)}: {msgs}"
    )
    assert msgs[0]["role"] == "system"
    assert msgs[1] == _HISTORY[-1]


# ─── test 5: day_themes → uses SYSTEM_PROMPT_DAY_THEMES ─────────────────────


@pytest.mark.asyncio
async def test_day_themes_uses_correct_system_prompt():
    """System message sent to LLM must start with the day_themes prompt content."""
    captured: list[dict] = []
    fake_client = _make_fake_client(captured)

    with patch.object(llm, "_get_client", return_value=fake_client), \
         patch.object(llm, "_get_fallback_client", return_value=fake_client):
        await llm._run_loop(
            [{"role": "user", "content": "plan themes"}],
            call_role="day_themes",
        )

    assert captured, "LLM create was never called"
    system_content = captured[0]["messages"][0]["content"]
    assert "TRIP THEME PLANNER" in system_content, (
        f"Expected 'TRIP THEME PLANNER' in system prompt, got:\n{system_content[:300]}"
    )


# ─── test 6: day_detail → uses SYSTEM_PROMPT_DAY_DETAIL ─────────────────────


@pytest.mark.asyncio
async def test_day_detail_uses_correct_system_prompt():
    """System message sent to LLM must start with the day_detail prompt content."""
    captured: list[dict] = []
    fake_client = _make_fake_client(captured)

    with patch.object(llm, "_get_client", return_value=fake_client), \
         patch.object(llm, "_get_fallback_client", return_value=fake_client):
        await llm._run_loop(
            [{"role": "user", "content": "plan day activities"}],
            call_role="day_detail",
        )

    assert captured, "LLM create was never called"
    system_content = captured[0]["messages"][0]["content"]
    assert "DAY ACTIVITY PLANNER" in system_content, (
        f"Expected 'DAY ACTIVITY PLANNER' in system prompt, got:\n{system_content[:300]}"
    )


# ─── test 7: cascade_times note ──────────────────────────────────────────────
# test_cascade_times_via_replace_merge is intentionally omitted.
# The {"itinerary": {"replace": {...}}} merge shape is frontend logic handled
# in PanelDays.jsx — it is covered by the frontend component tests, not here.
