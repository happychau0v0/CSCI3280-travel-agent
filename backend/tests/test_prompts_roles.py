"""Tests for day_themes and day_detail role registrations."""
from app.prompts import ROLE_ALLOWED_TOOLS, ROLE_PROMPTS


def test_day_themes_role_registered():
    assert "day_themes" in ROLE_PROMPTS
    assert "day_themes" in ROLE_ALLOWED_TOOLS


def test_day_themes_has_no_tools():
    assert ROLE_ALLOWED_TOOLS["day_themes"] == frozenset()


def test_day_detail_role_registered():
    assert "day_detail" in ROLE_PROMPTS
    assert "day_detail" in ROLE_ALLOWED_TOOLS


def test_day_detail_allowed_tools():
    assert ROLE_ALLOWED_TOOLS["day_detail"] == frozenset(
        {"search_places", "get_directions", "get_weather"}
    )


def test_day_detail_does_not_allow_navigate_menu():
    assert "navigate_menu" not in ROLE_ALLOWED_TOOLS["day_detail"]


def test_existing_roles_unchanged():
    """Existing roles must not be disturbed."""
    assert "plan" in ROLE_PROMPTS
    assert "hotels" in ROLE_PROMPTS
    assert "days" in ROLE_PROMPTS
    assert "navigate_menu" in ROLE_ALLOWED_TOOLS["days"]
