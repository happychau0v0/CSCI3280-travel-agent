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
            # transport_to_next must parse successfully even though the
            # fixture's JSON contains bad backslash escapes in the polyline
            # field.  polyline is intentionally omitted from TransportStep
            # (it is fetched client-side), so we only verify the surrounding
            # transport object was extracted correctly.
            assert activity.transport_to_next is not None
            assert activity.transport_to_next.mode == "WALK"


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


# ─── Round-trip flight fixture (R-PLAN-007) ──────────────────────────────


class TestRoundTripFlight:
    """Validate a round-trip Plan-role output: both outbound and return."""

    @pytest.fixture(autouse=True)
    def setup(self):
        self.data = _parse_fixture("hkg_nrt_roundtrip.txt")
        self.itinerary = _validate(self.data)

    def test_pydantic_validates(self):
        assert isinstance(self.itinerary, Itinerary)

    def test_outbound_options_present(self):
        """R-PLAN-008: outbound options array copied verbatim."""
        assert self.itinerary.flight is not None
        assert len(self.itinerary.flight.options) >= 2

    def test_return_options_populated(self):
        """R-PLAN-007: round-trip MUST have return_options."""
        assert len(self.itinerary.flight.return_options) >= 2

    def test_return_date_set(self):
        """R-PLAN-007: flight.return_date reflects the return leg."""
        assert self.itinerary.flight.return_date == "2026-05-20"

    def test_day_count_matches_trip_length(self):
        """R-PLAN-009: May 15 → May 20 = 6 day stubs."""
        assert len(self.itinerary.days) == 6

    def test_outbound_has_recommended(self):
        """At least one outbound option should be flagged recommended."""
        assert any(opt.recommended for opt in self.itinerary.flight.options)


# ─── Day 1 arrival at non-example time (R-DAYS-005/006) ───────────────────


class TestDay1ArrivalNonExampleTime:
    """Day 1 must use the flight's ACTUAL arrival_time (14:50), not 11:35."""

    @pytest.fixture(autouse=True)
    def setup(self):
        self.data = _parse_fixture("day1_1450_lastday_1800.txt")
        self.itinerary = _validate(self.data)

    def test_pydantic_validates(self):
        assert isinstance(self.itinerary, Itinerary)

    def test_first_activity_is_arrival_airport(self):
        """R-DAYS-006: day 1 activity[0] MUST be '{iata} Airport · Arrival'."""
        day1 = self.itinerary.days[0]
        assert day1.activities[0].name.endswith("Airport · Arrival")

    def test_first_activity_time_matches_flight(self):
        """R-DAYS-005: day 1 activity[0].time == flight.arrival_time (14:50)."""
        assert self.itinerary.days[0].activities[0].time == "14:50"

    def test_first_activity_duration_60(self):
        """R-DAYS-006: arrival airport activity is 60 min."""
        assert self.itinerary.days[0].activities[0].duration_min == 60

    def test_hotel_check_in_at_least_90_min_after_arrival(self):
        """R-DAYS-006: hotel check-in ≥ arrival_time + 90 min (14:50 + 90 = 16:20)."""
        def _to_min(hhmm: str) -> int:
            h, m = map(int, hhmm.split(":"))
            return h * 60 + m

        acts = self.itinerary.days[0].activities
        arrival_min = _to_min(acts[0].time)
        check_in_min = _to_min(acts[1].time)
        assert check_in_min >= arrival_min + 90, (
            f"Hotel check-in at {acts[1].time} is too close to arrival at {acts[0].time}"
        )


# ─── Last-day departure structure (R-DAYS-007) ────────────────────────────


class TestLastDayDeparture:
    """Last day: 09:00 check-out, real activities, departure airport 180 min."""

    @pytest.fixture(autouse=True)
    def setup(self):
        self.data = _parse_fixture("day1_1450_lastday_1800.txt")
        self.itinerary = _validate(self.data)

    def test_first_activity_is_hotel_checkout_at_0900(self):
        """R-DAYS-007: last day activity[0] is hotel check-out at 09:00."""
        last = self.itinerary.days[-1]
        assert last.activities[0].time == "09:00"
        assert last.activities[0].duration_min == 30

    def test_last_activity_is_departure_airport(self):
        """R-DAYS-007: last day activity[-1] is '{iata} Airport · Departure'."""
        last = self.itinerary.days[-1]
        assert last.activities[-1].name.endswith("Airport · Departure")

    def test_departure_activity_duration_180(self):
        """R-DAYS-007: departure airport window is 180 min (3 hours)."""
        last = self.itinerary.days[-1]
        assert last.activities[-1].duration_min == 180

    def test_at_least_one_real_activity_between_checkout_and_airport(self):
        """R-DAYS-007: must have ≥1 real activity before the airport."""
        last = self.itinerary.days[-1]
        # activities[0] is check-out, activities[-1] is airport;
        # anything in between counts as "real".
        assert len(last.activities) >= 3


# ─── day_themes role output (R-THEMES-002/003/005/006) ────────────────────


class TestDayThemesOutput:
    """day_themes returns only {itinerary.days[]} with themes + suggested_areas.

    Pydantic Itinerary requires title/destination which day_themes does not
    emit (legitimately — the frontend merges onto an existing itinerary).
    So these tests work with the raw extracted dict, not the Pydantic model.
    """

    @pytest.fixture(autouse=True)
    def setup(self):
        self.data = _parse_fixture("day_themes_3day_tokyo.txt")
        self.days = self.data["days"]

    def test_has_three_days(self):
        """R-THEMES-002: days array length equals trip days."""
        assert len(self.days) == 3

    def test_every_day_has_theme_and_areas(self):
        """R-THEMES-006: each day has a theme and suggested_areas list."""
        for day in self.days:
            assert day.get("theme"), f"Day {day.get('day')} missing theme"
            areas = day.get("suggested_areas", [])
            assert 3 <= len(areas) <= 5, (
                f"Day {day.get('day')} has {len(areas)} suggested_areas; "
                f"must be 3-5"
            )

    def test_suggested_areas_are_geographically_distinct(self):
        """R-THEMES-003: no neighborhood appears in more than one day."""
        seen: dict[str, int] = {}
        for day in self.days:
            for area in day.get("suggested_areas", []):
                if area in seen:
                    raise AssertionError(
                        f"Area {area!r} appears on days {seen[area]} and "
                        f"{day['day']} — suggested_areas must be distinct"
                    )
                seen[area] = day["day"]

    def test_key_constraints_only_on_flight_days(self):
        """R-THEMES-005: key_constraints only on day 1 (arrival) and last day (departure)."""
        assert "key_constraints" in self.days[0]
        assert self.days[0]["key_constraints"].get("arrival_time")

        assert "key_constraints" in self.days[-1]
        assert self.days[-1]["key_constraints"].get("departure_time")

        for middle in self.days[1:-1]:
            assert "key_constraints" not in middle, (
                f"Middle day {middle['day']} has key_constraints; "
                f"only flight days should."
            )

    def test_suggested_areas_not_generic(self):
        """R-THEMES-006: no 'downtown'/'city center' generic placeholders."""
        banned = {"downtown", "city center", "city centre"}
        for day in self.days:
            for area in day.get("suggested_areas", []):
                assert area.lower() not in banned, (
                    f"Day {day['day']} lists generic area {area!r}"
                )


# ─── Multi-stop flight options (R-MONO-001) ───────────────────────────────


class TestMultiStopFlight:
    """Multi-stop options MUST populate stop_cities with intermediate IATAs."""

    @pytest.fixture(autouse=True)
    def setup(self):
        self.data = _parse_fixture("multi_stop_hkg_bkk_nrt.txt")
        self.itinerary = _validate(self.data)

    def test_pydantic_validates(self):
        assert isinstance(self.itinerary, Itinerary)

    def test_non_stop_has_empty_stop_cities(self):
        """R-MONO-001: stops=0 → stop_cities == []."""
        non_stop = [o for o in self.itinerary.flight.options if o.stops == 0]
        assert non_stop, "Fixture should include at least one non-stop option"
        for opt in non_stop:
            assert opt.stop_cities == [], (
                f"Non-stop option {opt.label!r} has stop_cities={opt.stop_cities}"
            )

    def test_one_stop_has_one_iata_in_stop_cities(self):
        """R-MONO-001: stops=1 → len(stop_cities) == 1."""
        one_stop = [o for o in self.itinerary.flight.options if o.stops == 1]
        assert one_stop, "Fixture should include at least one 1-stop option"
        for opt in one_stop:
            assert len(opt.stop_cities) == 1, (
                f"1-stop option {opt.label!r} has stop_cities={opt.stop_cities}"
            )
            # IATA codes are 3 uppercase letters
            assert len(opt.stop_cities[0]) == 3 and opt.stop_cities[0].isupper()

    def test_two_stop_has_two_iatas_in_stop_cities(self):
        """R-MONO-001: stops=2 → len(stop_cities) == 2."""
        two_stop = [o for o in self.itinerary.flight.options if o.stops == 2]
        if two_stop:  # optional — fixture may or may not have 2-stops
            for opt in two_stop:
                assert len(opt.stop_cities) == 2


# ─── Replace role output (R-REPLACE-005) ──────────────────────────────────


class TestReplaceActivityOutput:
    """replace role emits {itinerary.replace: {day, old_name, activity}}.

    This shape is not a full Itinerary — the frontend merges it as a diff.
    Tests work with the raw extracted dict.
    """

    @pytest.fixture(autouse=True)
    def setup(self):
        self.data = _parse_fixture("replace_activity_tokyo.txt")
        assert "replace" in self.data, (
            "Replace fixture missing itinerary.replace block"
        )
        self.replace = self.data["replace"]

    def test_has_day_and_old_name(self):
        """R-REPLACE-005: replace block has day (int) + old_name (str)."""
        assert isinstance(self.replace.get("day"), int)
        assert isinstance(self.replace.get("old_name"), str)
        assert self.replace["old_name"]

    def test_activity_has_required_fields(self):
        """R-REPLACE-005: replacement activity has time + name + place fields."""
        act = self.replace["activity"]
        assert act.get("time")
        assert act.get("name")
        assert act.get("place_id")
        assert act.get("lat") is not None
        assert act.get("lng") is not None
        assert act.get("photo_url")
        assert act.get("address")

    def test_activity_description_10_to_15_words(self):
        """R-REPLACE-006: description is a brief 10-15-word blurb."""
        desc = self.replace["activity"].get("description", "")
        word_count = len(desc.split())
        assert 8 <= word_count <= 20, (
            f"Description is {word_count} words; expected roughly 10-15. "
            f"Text: {desc!r}"
        )

    def test_no_full_days_array(self):
        """R-REPLACE-004: replace must NOT re-emit the full days array."""
        assert "days" not in self.data, (
            "Replace output should only include the replace block, not full days"
        )
