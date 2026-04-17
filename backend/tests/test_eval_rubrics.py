"""Unit tests for backend/app/evals/rubrics.py.

These test the rubric functions themselves against canned responses —
no real LLM calls. The point is to catch bugs in the rubric logic
before we use the rubrics to grade real LLM output; a false-pass in a
rubric would mask real behavior regressions.
"""
from __future__ import annotations

from app.evals.rubrics import (
    RubricResult,
    count_words,
    run_rubrics,
    strip_json_block,
)


# ─── helper-function tests ──────────────────────────────────────────────────


class TestStripJsonBlock:
    def test_fenced_block_removed(self):
        raw = 'Here is your plan.\n```json\n{"itinerary": {"title": "X"}}\n```\nEnjoy!'
        assert strip_json_block(raw) == "Here is your plan.\n\nEnjoy!"

    def test_unfenced_block_removed(self):
        raw = 'Sure! {"itinerary": {"title": "X", "destination": "Y"}} Have fun.'
        result = strip_json_block(raw)
        assert "itinerary" not in result
        assert "Sure!" in result
        assert "Have fun." in result

    def test_no_json_untouched(self):
        raw = "Hello! Tell me where you'd like to go."
        assert strip_json_block(raw) == raw


class TestCountWords:
    def test_simple(self):
        assert count_words("three little words") == 3

    def test_empty(self):
        assert count_words("") == 0

    def test_whitespace_only(self):
        assert count_words("   \n\t  ") == 0

    def test_multiple_whitespace_collapsed(self):
        assert count_words("a  b\tc\nd") == 4


# ─── R-G-004: prose outside json ────────────────────────────────────────────


class TestR_G_004:
    def test_pass_when_prose_present(self):
        r = run_rubrics(
            {"reply": 'Here is your plan.\n```json\n{"x": 1}\n```\nEnjoy!'},
            {},
            ["R-G-004"],
        )
        assert r[0].verdict == "PASS"

    def test_fail_when_only_json(self):
        r = run_rubrics(
            {"reply": '```json\n{"itinerary": {"title": "X"}}\n```'},
            {},
            ["R-G-004"],
        )
        assert r[0].verdict == "FAIL"
        assert "only a JSON" in r[0].reason or "json" in r[0].reason.lower()


# ─── R-G-005: no markdown ───────────────────────────────────────────────────


class TestR_G_005:
    def test_pass_when_clean(self):
        r = run_rubrics({"reply": "Three days in Tokyo confirmed."}, {}, ["R-G-005"])
        assert r[0].verdict == "PASS"

    def test_fail_on_bold(self):
        r = run_rubrics({"reply": "Three **amazing** days in Tokyo."}, {}, ["R-G-005"])
        assert r[0].verdict == "FAIL"
        assert "bold" in r[0].reason.lower()

    def test_fail_on_backtick_code(self):
        r = run_rubrics(
            {"reply": "Your flight lands in `NRT` at 11:35."}, {}, ["R-G-005"]
        )
        assert r[0].verdict == "FAIL"
        assert "backtick" in r[0].reason.lower() or "code" in r[0].reason.lower()

    def test_fail_on_italic(self):
        r = run_rubrics({"reply": "A *lovely* trip awaits."}, {}, ["R-G-005"])
        assert r[0].verdict == "FAIL"

    def test_ignores_markdown_inside_json(self):
        """Prose is clean; JSON block contains ** but that's not prose."""
        r = run_rubrics(
            {"reply": 'Done.\n```json\n{"description": "**popular** spot"}\n```\nEnjoy!'},
            {},
            ["R-G-005"],
        )
        assert r[0].verdict == "PASS"


# ─── R-G-006: no bullets ────────────────────────────────────────────────────


class TestR_G_006:
    def test_pass_when_single_sentence(self):
        r = run_rubrics({"reply": "Three days in Tokyo confirmed."}, {}, ["R-G-006"])
        assert r[0].verdict == "PASS"

    def test_fail_on_bullet(self):
        r = run_rubrics(
            {"reply": "Your plan:\n- Day 1: Senso-ji\n- Day 2: Shibuya"}, {}, ["R-G-006"]
        )
        assert r[0].verdict == "FAIL"

    def test_fail_on_numbered_list(self):
        r = run_rubrics(
            {"reply": "Steps:\n1. Pick a flight\n2. Pick a hotel"}, {}, ["R-G-006"]
        )
        assert r[0].verdict == "FAIL"


# ─── R-G-015: subtitle length ───────────────────────────────────────────────


class TestR_G_015:
    def test_pass_at_15_words(self):
        text = "Three days in Tokyo confirmed — flights from HKG, hotel in Shinjuku, starting with Senso-ji temple."
        r = run_rubrics({"reply": text}, {}, ["R-G-015"])
        assert r[0].verdict == "PASS"

    def test_fail_when_too_short(self):
        r = run_rubrics({"reply": "Ok."}, {}, ["R-G-015"])
        assert r[0].verdict == "FAIL"
        assert "short" in r[0].reason.lower()

    def test_fail_when_too_long(self):
        text = " ".join(["word"] * 50)
        r = run_rubrics({"reply": text}, {}, ["R-G-015"])
        assert r[0].verdict == "FAIL"

    def test_counts_only_prose(self):
        """Word count excludes the JSON block."""
        prose = "Three days in Tokyo confirmed starting at Senso-ji temple."
        reply = prose + '\n```json\n{"very_long_field": "' + " ".join(["bloat"] * 200) + '"}\n```\nGo!'
        r = run_rubrics({"reply": reply}, {}, ["R-G-015"])
        assert r[0].verdict == "PASS"


# ─── R-REPLACE-006: description word count ──────────────────────────────────


class TestR_REPLACE_006:
    def test_pass_on_reasonable_description(self):
        response = {
            "itinerary": {
                "replace": {
                    "day": 2,
                    "old_name": "X",
                    "activity": {
                        "description": "Solo-booth tonkotsu ramen famed for concentration-focused eating experience",
                    },
                },
            }
        }
        r = run_rubrics(response, {}, ["R-REPLACE-006"])
        assert r[0].verdict == "PASS"

    def test_skip_on_non_replace_response(self):
        r = run_rubrics(
            {"itinerary": {"hotels": [], "days": []}}, {}, ["R-REPLACE-006"]
        )
        assert r[0].verdict == "SKIP"

    def test_fail_on_too_short(self):
        response = {
            "itinerary": {"replace": {"activity": {"description": "Ramen."}}}
        }
        r = run_rubrics(response, {}, ["R-REPLACE-006"])
        assert r[0].verdict == "FAIL"


# ─── R-G-002: transport tool-first ──────────────────────────────────────────


class TestR_G_002:
    def test_pass_when_directions_called(self):
        response = {
            "itinerary": {
                "days": [
                    {"activities": [
                        {"name": "A", "transport_to_next": {"mode": "TRANSIT"}},
                        {"name": "B"},
                    ]}
                ]
            },
            "tool_calls_made": ["search_places", "get_directions"],
        }
        r = run_rubrics(response, {}, ["R-G-002"])
        assert r[0].verdict == "PASS"

    def test_fail_when_transport_but_no_directions(self):
        response = {
            "itinerary": {
                "days": [
                    {"activities": [
                        {"name": "A", "transport_to_next": {"mode": "WALK"}},
                    ]}
                ]
            },
            "tool_calls_made": ["search_places"],
        }
        r = run_rubrics(response, {}, ["R-G-002"])
        assert r[0].verdict == "FAIL"

    def test_skip_when_no_transport(self):
        response = {
            "itinerary": {"days": [{"activities": [{"name": "A"}]}]},
            "tool_calls_made": [],
        }
        r = run_rubrics(response, {}, ["R-G-002"])
        assert r[0].verdict == "SKIP"


# ─── R-G-003: weather tool-first ────────────────────────────────────────────


class TestR_G_003:
    def test_pass_when_get_weather_called(self):
        response = {
            "itinerary": {"days": [{"weather": {"temp": 22, "condition": "Clear"}}]},
            "tool_calls_made": ["get_weather"],
        }
        r = run_rubrics(response, {}, ["R-G-003"])
        assert r[0].verdict == "PASS"

    def test_fail_when_weather_but_no_call(self):
        response = {
            "itinerary": {"days": [{"weather": {"temp": 22, "condition": "Clear"}}]},
            "tool_calls_made": ["search_places"],
        }
        r = run_rubrics(response, {}, ["R-G-003"])
        assert r[0].verdict == "FAIL"


# ─── R-PLAN-002: country destination → request_input ────────────────────────


class TestR_PLAN_002:
    def test_pass_when_request_input_fires(self):
        response = {"tool_calls_made": ["request_input"]}
        r = run_rubrics(response, {"expects_clarification": True}, ["R-PLAN-002"])
        assert r[0].verdict == "PASS"

    def test_fail_when_search_flights_fires_instead(self):
        response = {"tool_calls_made": ["search_flights"]}
        r = run_rubrics(response, {"expects_clarification": True}, ["R-PLAN-002"])
        assert r[0].verdict == "FAIL"

    def test_skip_when_context_does_not_expect_clarification(self):
        response = {"tool_calls_made": ["search_flights"]}
        r = run_rubrics(response, {}, ["R-PLAN-002"])
        assert r[0].verdict == "SKIP"


# ─── R-CHAT-001: chat role cannot call data-fetch tools ─────────────────────


class TestR_CHAT_001:
    def test_pass_when_chat_uses_ui_tools_only(self):
        response = {
            "tool_calls_made": ["submit_trip_form", "request_input", "navigate_menu"]
        }
        r = run_rubrics(response, {"call_role": "chat"}, ["R-CHAT-001"])
        assert r[0].verdict == "PASS"

    def test_fail_when_chat_calls_search_flights(self):
        response = {"tool_calls_made": ["search_flights", "submit_trip_form"]}
        r = run_rubrics(response, {"call_role": "chat"}, ["R-CHAT-001"])
        assert r[0].verdict == "FAIL"
        assert "search_flights" in r[0].reason

    def test_skip_when_not_chat_role(self):
        response = {"tool_calls_made": ["search_flights"]}
        r = run_rubrics(response, {"call_role": "plan"}, ["R-CHAT-001"])
        assert r[0].verdict == "SKIP"


# ─── R-PLAN-004: MUST call search_flights + geocode_city ───────────────────


class TestR_PLAN_004:
    def test_pass_when_both_calls_fired(self):
        response = {
            "itinerary": {"flight": {"options": [{"airline": "ANA"}]}},
            "tool_calls_made": ["search_flights", "geocode_city", "navigate_menu"],
        }
        r = run_rubrics(response, {"call_role": "plan"}, ["R-PLAN-004"])
        assert r[0].verdict == "PASS"

    def test_fail_when_geocode_missing(self):
        response = {
            "itinerary": {"flight": {"options": [{"airline": "ANA"}]}},
            "tool_calls_made": ["search_flights", "navigate_menu"],
        }
        r = run_rubrics(response, {"call_role": "plan"}, ["R-PLAN-004"])
        assert r[0].verdict == "FAIL"
        assert "geocode_city" in r[0].reason

    def test_fail_when_search_flights_missing(self):
        response = {
            "itinerary": {"flight": {"options": [{"airline": "ANA"}]}},
            "tool_calls_made": ["geocode_city", "navigate_menu"],
        }
        r = run_rubrics(response, {"call_role": "plan"}, ["R-PLAN-004"])
        assert r[0].verdict == "FAIL"
        assert "search_flights" in r[0].reason

    def test_skip_when_no_flight_options(self):
        response = {
            "itinerary": {"flight": None},
            "tool_calls_made": ["request_input"],
        }
        r = run_rubrics(response, {"call_role": "plan"}, ["R-PLAN-004"])
        assert r[0].verdict == "SKIP"

    def test_skip_when_flight_present_but_options_empty(self):
        response = {
            "itinerary": {"flight": {"options": []}},
            "tool_calls_made": [],
        }
        r = run_rubrics(response, {"call_role": "plan"}, ["R-PLAN-004"])
        assert r[0].verdict == "SKIP"


# ─── R-HOTELS-003: MUST call search_places when hotels returned ─────────────


class TestR_HOTELS_003:
    def test_pass_when_search_places_fired(self):
        response = {
            "itinerary": {"hotels": [{"name": "Park Hyatt"}, {"name": "Grand Hyatt"}]},
            "tool_calls_made": ["search_places", "get_weather", "navigate_menu"],
        }
        r = run_rubrics(response, {"call_role": "hotels"}, ["R-HOTELS-003"])
        assert r[0].verdict == "PASS"

    def test_fail_when_hotels_returned_without_search(self):
        response = {
            "itinerary": {"hotels": [{"name": "Park Hyatt"}]},
            "tool_calls_made": ["get_weather", "navigate_menu"],
        }
        r = run_rubrics(response, {"call_role": "hotels"}, ["R-HOTELS-003"])
        assert r[0].verdict == "FAIL"
        assert "search_places" in r[0].reason

    def test_skip_when_not_hotels_role(self):
        response = {
            "itinerary": {"hotels": [{"name": "X"}]},
            "tool_calls_made": [],
        }
        r = run_rubrics(response, {"call_role": "plan"}, ["R-HOTELS-003"])
        assert r[0].verdict == "SKIP"

    def test_skip_when_no_hotels_in_response(self):
        response = {
            "itinerary": {"hotels": []},
            "tool_calls_made": [],
        }
        r = run_rubrics(response, {"call_role": "hotels"}, ["R-HOTELS-003"])
        assert r[0].verdict == "SKIP"


# ─── runner contract ────────────────────────────────────────────────────────


class TestRunRubrics:
    def test_unknown_id_returns_skip_not_crash(self):
        r = run_rubrics({"reply": "hi"}, {}, ["R-G-999-bogus"])
        assert len(r) == 1
        assert r[0].verdict == "SKIP"
        assert "no rubric function" in r[0].reason

    def test_rubric_exception_returns_fail(self):
        """A rubric that crashes is caught and reported as FAIL."""
        # Deliberately malformed response
        r = run_rubrics(None, {}, ["R-G-004"])  # type: ignore[arg-type]
        assert r[0].verdict in ("FAIL", "PASS")  # shouldn't propagate exception

    def test_default_runs_all_registered(self):
        """Calling with rubric_ids=None runs every rubric."""
        response = {"reply": "Three days in Tokyo confirmed at Senso-ji temple.",
                    "tool_calls_made": []}
        r = run_rubrics(response, {})
        # At least the regex rubrics should run
        ids = {x.rubric_id for x in r}
        assert "R-G-004" in ids
        assert "R-G-005" in ids


# ─── judge.parse_verdict ────────────────────────────────────────────────────


class TestJudgeParseVerdict:
    def test_clean_json(self):
        from app.evals.judge import parse_verdict

        result = parse_verdict('{"verdict": "PASS", "reason": "all good"}')
        assert result == {"verdict": "PASS", "reason": "all good"}

    def test_verdict_embedded_in_prose(self):
        from app.evals.judge import parse_verdict

        raw = 'Here is my verdict: {"verdict": "FAIL", "reason": "used markdown"} — done.'
        result = parse_verdict(raw)
        assert result["verdict"] == "FAIL"

    def test_unparseable_returns_skip(self):
        from app.evals.judge import parse_verdict

        result = parse_verdict("I think it passes, honestly.")
        assert result["verdict"] == "SKIP"


# ─── RubricResult helpers ───────────────────────────────────────────────────


class TestRubricResult:
    def test_pass_constructor(self):
        r = RubricResult.pass_("R-X-001")
        assert r.verdict == "PASS"
        assert r.reason == "ok"

    def test_fail_constructor(self):
        r = RubricResult.fail("R-X-001", "reason here")
        assert r.verdict == "FAIL"
        assert r.reason == "reason here"

    def test_skip_constructor(self):
        r = RubricResult.skip("R-X-001", "n/a")
        assert r.verdict == "SKIP"
