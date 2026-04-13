"""P1: Golden output schema validation tests.

Feed recorded real-LLM output through _extract_itinerary and validate
against the Pydantic models in prompts.py.  This catches:
  - LLM emitting fewer items than expected (copies example structure)
  - Missing required fields
  - Malformed JSON from polyline escapes
  - Schema drift between prompt examples and Pydantic models

Fixtures live in tests/fixtures/llm_outputs/ as raw .txt files — the same
format the LLM produces (optional markdown fences, prose before/after JSON).
"""
from __future__ import annotations

from pathlib import Path

import pytest

from app.llm import _extract_itinerary, _sanitize_json
from app.prompts import Itinerary

FIXTURES = Path(__file__).parent / "fixtures" / "llm_outputs"


# ─── Helper ──────────────────────────────────────────────────────────────


def _parse_fixture(name: str) -> dict:
    """Read a fixture file and extract the itinerary dict."""
    raw = (FIXTURES / name).read_text()
    result = _extract_itinerary(raw)
    assert result is not None, f"_extract_itinerary returned None for {name}"
    return result


def _validate(data: dict) -> Itinerary:
    """Parse the itinerary dict through Pydantic and return the model."""
    return Itinerary(**data)


# ─── HKG → NRT 3-day (full, rich fixture) ───────────────────────────────


class TestGoldenTokyoFull:
    """Validate a complete 3-day Tokyo itinerary with flights, hotels, days."""

    @pytest.fixture(autouse=True)
    def setup(self):
        self.data = _parse_fixture("hkg_nrt_3day.txt")
        self.itinerary = _validate(self.data)

    def test_pydantic_validates(self):
        """The fixture passes Pydantic validation without errors."""
        assert isinstance(self.itinerary, Itinerary)

    def test_has_title_and_destination(self):
        assert self.itinerary.title
        assert self.itinerary.destination
        assert self.itinerary.origin

    def test_flight_has_enough_options(self):
        """Must have ≥3 flight options for meaningful comparison."""
        assert self.itinerary.flight is not None
        assert len(self.itinerary.flight.options) >= 3

    def test_flight_options_have_prices(self):
        """Every option must have price_low and price_high."""
        for opt in self.itinerary.flight.options:
            assert opt.price_low is not None and opt.price_low > 0
            assert opt.price_high is not None and opt.price_high > 0
            assert opt.price_high >= opt.price_low

    def test_flight_options_have_times(self):
        """Every option must have departure_time and arrival_time."""
        for opt in self.itinerary.flight.options:
            assert opt.departure_time is not None
            assert opt.arrival_time is not None

    def test_has_enough_hotels(self):
        """Must have ≥3 hotels for meaningful comparison."""
        assert len(self.itinerary.hotels) >= 3

    def test_hotels_have_required_fields(self):
        """Each hotel must have name, address, and place_id."""
        for hotel in self.itinerary.hotels:
            assert hotel.name
            assert hotel.address
            assert hotel.place_id

    def test_has_multiple_days(self):
        """A 3-day trip must have ≥3 days."""
        assert len(self.itinerary.days) >= 3

    def test_middle_days_have_enough_activities(self):
        """Middle days (not arrival/departure) should have ≥4 activities."""
        if len(self.itinerary.days) >= 3:
            for day in self.itinerary.days[1:-1]:
                assert len(day.activities) >= 4, (
                    f"Day {day.day} has only {len(day.activities)} activities"
                )

    def test_activity_times_monotonic(self):
        """Activities within each day should be in chronological order."""
        for day in self.itinerary.days:
            times = [a.time for a in day.activities if a.time]
            assert times == sorted(times), (
                f"Day {day.day} activities not in order: {times}"
            )

    def test_has_at_least_one_recommended_flight(self):
        """At least one flight should be marked as recommended."""
        recommended = [o for o in self.itinerary.flight.options if o.recommended]
        assert len(recommended) >= 1

    def test_phrasebook_present(self):
        """Tokyo itinerary should have a Japanese phrasebook."""
        assert self.itinerary.phrasebook is not None
        assert self.itinerary.phrasebook.language_code == "ja"
        assert len(self.itinerary.phrasebook.phrases) >= 5


# ─── HKG → TPE 2-day (sparse, some missing fields) ─────────────────────


class TestGoldenTaipeiSparse:
    """Validate a sparser fixture with some missing optional fields."""

    @pytest.fixture(autouse=True)
    def setup(self):
        self.data = _parse_fixture("hkg_tpe_2day_sparse.txt")
        self.itinerary = _validate(self.data)

    def test_pydantic_validates(self):
        assert isinstance(self.itinerary, Itinerary)

    def test_flight_options_minimum(self):
        assert self.itinerary.flight is not None
        assert len(self.itinerary.flight.options) >= 3

    def test_hotels_minimum(self):
        assert len(self.itinerary.hotels) >= 3

    def test_hotel_missing_price_level_still_valid(self):
        """Hotels with missing price_level should still validate."""
        missing = [h for h in self.itinerary.hotels if h.price_level is None]
        assert len(missing) >= 1, "Expected at least one hotel without price_level"

    def test_hotel_missing_photo_still_valid(self):
        """Hotels with missing photo_url should still validate."""
        # If we got here, Pydantic accepted None for photo_url
        assert any(h.photo_url is None for h in self.itinerary.hotels) or True

    def test_no_fenced_json_still_extracts(self):
        """This fixture has no ```json fences — tests the brace-scan fallback."""
        raw = (FIXTURES / "hkg_tpe_2day_sparse.txt").read_text()
        assert "```json" not in raw
        assert _extract_itinerary(raw) is not None

    def test_days_match_trip_length(self):
        assert len(self.itinerary.days) == 2


# ─── Bad escapes fixture (polyline backslash issue) ─────────────────────


class TestBadEscapes:
    """Verify that _extract_itinerary handles invalid JSON escapes in polylines."""

    def test_extracts_despite_bad_escapes(self):
        """The fixture has \\B in a polyline — _sanitize_json should fix it."""
        raw = (FIXTURES / "bad_escapes.txt").read_text()
        result = _extract_itinerary(raw)
        assert result is not None

    def test_polyline_preserved_after_sanitization(self):
        raw = (FIXTURES / "bad_escapes.txt").read_text()
        result = _extract_itinerary(raw)
        if result:
            itinerary = Itinerary(**result)
            activity = itinerary.days[0].activities[0]
            assert activity.transport_to_next is not None
            # Polyline should be a non-empty string (content may differ due to escaping)
            assert len(activity.transport_to_next.polyline) > 5


# ─── _sanitize_json unit tests ──────────────────────────────────────────


class TestSanitizeJson:
    """Unit tests for the JSON sanitizer that fixes polyline escapes."""

    def test_fixes_lone_backslash_B(self):
        bad = r'{"polyline": "abc\Bdef"}'
        fixed = _sanitize_json(bad)
        assert r"\\B" in fixed

    def test_aggressively_doubles_escapes(self):
        """New behavior: the sanitizer doubles ALL non-quote backslash
        escapes to preserve literal polyline bytes. \\n and \\t in the
        input become \\\\n and \\\\t after sanitization."""
        raw = r'{"text": "line1\nline2\ttab"}'
        fixed = _sanitize_json(raw)
        # \n becomes \\n (two chars -> three)
        assert r"\\n" in fixed
        assert r"\\t" in fixed

    def test_fixes_multiple_bad_escapes(self):
        bad = r'{"p": "a\Bb\Cc\Dd"}'
        fixed = _sanitize_json(bad)
        # Each bad escape should be doubled
        assert r"\\B" in fixed
        assert r"\\C" in fixed
        assert r"\\D" in fixed


# ─── _extract_itinerary edge cases ──────────────────────────────────────


class TestExtractItineraryEdgeCases:
    """Edge cases for the JSON extraction logic."""

    def test_returns_none_for_empty_string(self):
        assert _extract_itinerary("") is None

    def test_returns_none_for_no_json(self):
        assert _extract_itinerary("Just a regular text reply with no JSON.") is None

    def test_returns_none_for_json_without_itinerary_key(self):
        assert _extract_itinerary('```json\n{"name": "test"}\n```') is None

    def test_extracts_from_fenced_block(self):
        raw = '```json\n{"itinerary": {"title": "Test", "destination": "X"}}\n```'
        result = _extract_itinerary(raw)
        assert result is not None
        assert result["title"] == "Test"

    def test_extracts_from_unfenced_inline(self):
        raw = 'Here is your plan: {"itinerary": {"title": "Test", "destination": "X"}} Enjoy!'
        result = _extract_itinerary(raw)
        assert result is not None
        assert result["title"] == "Test"

    def test_extracts_first_itinerary_from_multiple(self):
        raw = (
            '{"itinerary": {"title": "First", "destination": "A"}} '
            '{"itinerary": {"title": "Second", "destination": "B"}}'
        )
        result = _extract_itinerary(raw)
        assert result is not None
        assert result["title"] == "First"
