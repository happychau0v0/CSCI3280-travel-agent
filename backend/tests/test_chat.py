"""Mocked tests for the chat and itinerary endpoints."""
from __future__ import annotations

from unittest.mock import AsyncMock, patch

from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


# ─── /chat ────────────────────────────────────────────────────────────────


def test_chat_returns_simple_reply():
    fake_result = {
        "reply": "I'd recommend visiting the Eiffel Tower.",
        "itinerary": None,
        "tool_calls_made": ["search_places"],
    }
    with patch("app.routers.chat.llm.chat", new=AsyncMock(return_value=fake_result)):
        response = client.post("/chat", json={"message": "What should I do in Paris?"})

    assert response.status_code == 200
    body = response.json()
    assert "Eiffel Tower" in body["reply"]
    assert body["tool_calls_made"] == ["search_places"]
    assert body["itinerary"] is None


def test_chat_returns_itinerary():
    itinerary = {
        "title": "1 Day in Paris",
        "destination": "Paris, France",
        "days": [{"day": 1, "theme": "Highlights", "activities": []}],
    }
    fake_result = {
        "reply": "Here's your day in Paris...",
        "itinerary": itinerary,
        "tool_calls_made": ["search_places", "get_directions"],
    }
    with patch("app.routers.chat.llm.chat", new=AsyncMock(return_value=fake_result)):
        response = client.post("/chat", json={"message": "Plan a day in Paris"})

    assert response.status_code == 200
    body = response.json()
    assert body["itinerary"]["destination"] == "Paris, France"
    assert len(body["tool_calls_made"]) == 2


def test_chat_missing_key_returns_503():
    error = RuntimeError("OPENROUTER_API_KEY not configured")
    with patch("app.routers.chat.llm.chat", new=AsyncMock(side_effect=error)):
        response = client.post("/chat", json={"message": "hi"})

    assert response.status_code == 503
    assert "OPENROUTER_API_KEY" in response.json()["detail"]


def test_chat_internal_error_returns_500():
    with patch("app.routers.chat.llm.chat", new=AsyncMock(side_effect=ValueError("bad"))):
        response = client.post("/chat", json={"message": "hi"})

    assert response.status_code == 500


def test_chat_accepts_history():
    fake_result = {"reply": "ok", "itinerary": None, "tool_calls_made": []}
    with patch("app.routers.chat.llm.chat", new=AsyncMock(return_value=fake_result)) as m:
        response = client.post(
            "/chat",
            json={
                "message": "and dinner?",
                "history": [
                    {"role": "user", "content": "Plan a day in Tokyo"},
                    {"role": "assistant", "content": "Sure!"},
                ],
            },
        )

    assert response.status_code == 200
    # Verify history was forwarded to llm.chat (3 messages total: 2 history + 1 new)
    call_args = m.call_args[0][0]
    assert len(call_args) == 3
    assert call_args[-1] == {"role": "user", "content": "and dinner?"}


def test_chat_forwards_preferences():
    fake_result = {"reply": "ok", "itinerary": None, "tool_calls_made": []}
    with patch("app.routers.chat.llm.chat", new=AsyncMock(return_value=fake_result)) as m:
        response = client.post(
            "/chat",
            json={
                "message": "plan a trip",
                "preferences": {
                    "interests": ["history", "food"],
                    "dislikes": ["crowds"],
                    "budget": "$$",
                },
            },
        )

    assert response.status_code == 200
    # llm.chat called as (messages, preferences=...)
    assert m.call_args.kwargs["preferences"]["interests"] == ["history", "food"]
    assert m.call_args.kwargs["preferences"]["budget"] == "$$"


def test_format_preferences_renders_user_profile_block():
    from app.llm import _format_preferences

    rendered = _format_preferences(
        {"interests": ["history", "ramen"], "budget": "$$", "dislikes": []}
    )
    assert "USER PROFILE" in rendered
    assert "interests: history, ramen" in rendered
    assert "budget: $$" in rendered
    # Empty values are skipped
    assert "dislikes" not in rendered


def test_format_preferences_empty_returns_empty_string():
    from app.llm import _format_preferences

    assert _format_preferences(None) == ""
    assert _format_preferences({}) == ""
    assert _format_preferences({"interests": [], "budget": ""}) == ""


# ─── /itinerary ───────────────────────────────────────────────────────────


def test_itinerary_save_and_retrieve():
    payload = {
        "itinerary": {
            "title": "Test Trip",
            "destination": "Test City",
            "days": [],
        }
    }
    save_resp = client.post("/itinerary", json=payload)
    assert save_resp.status_code == 200
    saved_id = save_resp.json()["id"]
    assert saved_id

    get_resp = client.get(f"/itinerary/{saved_id}")
    assert get_resp.status_code == 200
    assert get_resp.json()["title"] == "Test Trip"


def test_itinerary_not_found():
    response = client.get("/itinerary/nonexistent")
    assert response.status_code == 404
