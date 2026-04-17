"""Parity tests for role-based tool allow-listing and fresh-context scoping.

Extends test_day_planning_roles.py to cover the remaining roles (plan,
hotels, days, chat, replace) so every role in ROLE_ALLOWED_TOOLS has an
explicit assertion that _run_loop:
  1. passes exactly the expected tool names to the LLM client
  2. drops (or preserves, for chat) conversation history per spec

Without these, an accidental edit to ALLOWED_TOOLS_* or the fresh-context
branch at llm.py:358 would pass CI silently.
"""
from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import patch

import pytest

from app import llm


# ─── shared fakes ────────────────────────────────────────────────────────────


def _msg(content: str = "", tool_calls: list | None = None):
    return SimpleNamespace(content=content, tool_calls=tool_calls)


def _completion(message):
    return SimpleNamespace(choices=[SimpleNamespace(message=message)])


def _make_fake_client(captured_kwargs: list):
    async def fake_create(**kwargs):
        captured_kwargs.append(kwargs)
        return _completion(_msg(content="ok", tool_calls=None))

    return SimpleNamespace(
        chat=SimpleNamespace(
            completions=SimpleNamespace(create=fake_create)
        )
    )


# History long enough to observe the fresh-context trim.
_HISTORY = [
    {"role": "user", "content": "msg 1"},
    {"role": "assistant", "content": "msg 2"},
    {"role": "user", "content": "msg 3"},
    {"role": "assistant", "content": "msg 4"},
    {"role": "user", "content": "final"},
]


# Expected tool names per role — mirror of ALLOWED_TOOLS_* in prompts.py.
# This is the single source of truth the test compares against; if you
# change the allow-list, update here too.
EXPECTED_TOOLS: dict[str, set[str]] = {
    "plan": {
        "search_flights", "geocode_city", "get_day_windows",
        "get_phrasebook", "request_input", "navigate_menu",
    },
    "hotels": {
        "search_places", "get_weather", "navigate_menu",
    },
    "days": {
        "search_places", "get_directions", "get_weather", "navigate_menu",
    },
    "chat": {
        "request_input", "submit_trip_form", "navigate_menu",
        "toggle_setting", "pick_flight", "pick_hotel",
        "replace_activity", "search_airports",
    },
    "replace": {"search_places"},
    "day_themes": set(),
    "day_detail": {"search_places", "get_directions", "get_weather"},
}

# Scoped roles MUST drop conversation history (llm.py:358-363).
# `chat` is the only role that keeps it.
FRESH_CONTEXT_ROLES = {
    "plan", "hotels", "days", "day_themes", "day_detail",
}


# ─── allow-list assertions ───────────────────────────────────────────────────


@pytest.mark.parametrize("role, expected", sorted(EXPECTED_TOOLS.items()))
@pytest.mark.asyncio
async def test_role_uses_correct_tool_allow_list(role, expected):
    """Every role in ROLE_ALLOWED_TOOLS passes exactly that set to the LLM."""
    captured: list[dict] = []
    fake = _make_fake_client(captured)

    with patch.object(llm, "_get_client", return_value=fake), \
         patch.object(llm, "_get_fallback_client", return_value=fake):
        await llm._run_loop(
            [{"role": "user", "content": f"test {role}"}],
            call_role=role,
        )

    assert captured, f"LLM create was never called for role={role}"
    # Empty allow-list → `tools` and `tool_choice` are omitted entirely
    # (providers reject tool_choice="auto" with tools=[]).
    if not expected:
        assert "tools" not in captured[0], (
            f"Role {role!r} has empty allow-list but tools field was sent"
        )
        return
    tool_names = {t["function"]["name"] for t in captured[0]["tools"]}
    assert tool_names == expected, (
        f"Role {role!r} exposed tools {sorted(tool_names)}; "
        f"expected {sorted(expected)}"
    )


# ─── fresh-context assertions ────────────────────────────────────────────────


@pytest.mark.parametrize("role", sorted(FRESH_CONTEXT_ROLES))
@pytest.mark.asyncio
async def test_scoped_role_drops_conversation_history(role):
    """Scoped roles receive only (system + last user message)."""
    captured: list[dict] = []
    fake = _make_fake_client(captured)

    with patch.object(llm, "_get_client", return_value=fake), \
         patch.object(llm, "_get_fallback_client", return_value=fake):
        await llm._run_loop(list(_HISTORY), call_role=role)

    assert captured, f"LLM create was never called for role={role}"
    msgs = captured[0]["messages"]
    assert len(msgs) == 2, (
        f"Role {role!r} sent {len(msgs)} messages; "
        f"expected 2 (system + last user)"
    )
    assert msgs[0]["role"] == "system"
    assert msgs[1] == _HISTORY[-1]


@pytest.mark.asyncio
async def test_chat_role_preserves_full_history():
    """Chat is the exception — it needs prior turns for context."""
    captured: list[dict] = []
    fake = _make_fake_client(captured)

    with patch.object(llm, "_get_client", return_value=fake), \
         patch.object(llm, "_get_fallback_client", return_value=fake):
        await llm._run_loop(list(_HISTORY), call_role="chat")

    assert captured, "LLM create was never called for role=chat"
    msgs = captured[0]["messages"]
    # system + 5 history entries = 6
    assert len(msgs) == len(_HISTORY) + 1, (
        f"Chat role sent {len(msgs)} messages; expected {len(_HISTORY) + 1}"
    )
    assert msgs[0]["role"] == "system"
    assert msgs[1:] == _HISTORY


# ─── regression guards for the D2 decision ───────────────────────────────────


def test_hotels_allow_list_excludes_get_place_details():
    """Post-D2: get_place_details must NOT be in ALLOWED_TOOLS_HOTELS."""
    from app.prompts import ALLOWED_TOOLS_HOTELS

    assert "get_place_details" not in ALLOWED_TOOLS_HOTELS


def test_days_allow_list_excludes_get_place_details():
    """Post-D2: get_place_details must NOT be in ALLOWED_TOOLS_DAYS."""
    from app.prompts import ALLOWED_TOOLS_DAYS

    assert "get_place_details" not in ALLOWED_TOOLS_DAYS
