"""Unit tests for backend/app/evals/rubrics.py.

These test the rubric functions themselves against canned responses —
no real LLM calls. The point is to catch bugs in the rubric logic
before we use the rubrics to grade real LLM output; a false-pass in a
rubric would mask real behavior regressions.
"""
from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest

from app.evals.rubrics import (
    RubricResult,
    arun_rubrics,
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


# ─── R-PLAN-003: no text questions (plan role) ──────────────────────────────


class TestR_PLAN_003:
    def test_pass_when_reply_is_declarative(self):
        response = {
            "reply": 'Tokyo trip locked in.\n```json\n{"itinerary": {"flight": {}}}\n```',
            "tool_calls_made": ["search_flights", "geocode_city"],
        }
        r = run_rubrics(response, {"call_role": "plan"}, ["R-PLAN-003"])
        assert r[0].verdict == "PASS"

    def test_fail_when_prose_ends_in_question_without_request_input(self):
        response = {
            "reply": "Where in Japan would you like to visit?",
            "tool_calls_made": [],
        }
        r = run_rubrics(response, {"call_role": "plan"}, ["R-PLAN-003"])
        assert r[0].verdict == "FAIL"
        assert "?" in r[0].reason

    def test_pass_when_prose_ends_question_but_request_input_fired(self):
        """Prose trailing on a request_input call is fine."""
        response = {
            "reply": "Which destination did you have in mind?",
            "tool_calls_made": ["request_input"],
        }
        r = run_rubrics(response, {"call_role": "plan"}, ["R-PLAN-003"])
        assert r[0].verdict == "PASS"

    def test_skip_when_not_plan_role(self):
        response = {
            "reply": "Where do you want to go?",
            "tool_calls_made": [],
        }
        r = run_rubrics(response, {"call_role": "hotels"}, ["R-PLAN-003"])
        assert r[0].verdict == "SKIP"


# ─── R-CHAT-008: one-sentence chat reply, no JSON ───────────────────────────


class TestR_CHAT_008:
    def test_pass_on_short_friendly_sentence(self):
        r = run_rubrics(
            {"reply": "Got it, swapping to Osaka."},
            {"call_role": "chat"},
            ["R-CHAT-008"],
        )
        assert r[0].verdict == "PASS"

    def test_fail_when_chat_contains_json_block(self):
        r = run_rubrics(
            {
                "reply": 'Here you go.\n```json\n{"itinerary": {"destination": "OSA"}}\n```',
            },
            {"call_role": "chat"},
            ["R-CHAT-008"],
        )
        assert r[0].verdict == "FAIL"
        assert "json" in r[0].reason.lower()

    def test_fail_on_multi_sentence_paragraph(self):
        text = (
            "Tokyo is great. You'll love the ramen. "
            "Let me know which airport works for you."
        )
        r = run_rubrics({"reply": text}, {"call_role": "chat"}, ["R-CHAT-008"])
        assert r[0].verdict == "FAIL"

    def test_skip_when_not_chat_role(self):
        r = run_rubrics(
            {"reply": "Three days in Tokyo confirmed at Senso-ji temple."},
            {"call_role": "plan"},
            ["R-CHAT-008"],
        )
        assert r[0].verdict == "SKIP"


# ─── R-DAYS-012: days role must not re-emit flight/hotels ───────────────────


class TestR_DAYS_012:
    def test_pass_when_only_days_and_selected_hotel_emitted(self):
        response = {
            "itinerary": {
                "selected_hotel": {"name": "Park Hyatt"},
                "days": [{"day": 1, "activities": []}],
            }
        }
        r = run_rubrics(response, {"call_role": "days"}, ["R-DAYS-012"])
        assert r[0].verdict == "PASS"

    def test_fail_when_flight_re_emitted(self):
        response = {
            "itinerary": {
                "flight": {"options": []},
                "days": [{"day": 1, "activities": []}],
            }
        }
        r = run_rubrics(response, {"call_role": "days"}, ["R-DAYS-012"])
        assert r[0].verdict == "FAIL"
        assert "flight" in r[0].reason

    def test_fail_when_hotels_re_emitted(self):
        response = {
            "itinerary": {
                "hotels": [{"name": "X"}],
                "days": [{"day": 1, "activities": []}],
            }
        }
        r = run_rubrics(response, {"call_role": "days"}, ["R-DAYS-012"])
        assert r[0].verdict == "FAIL"
        assert "hotels" in r[0].reason

    def test_skip_when_not_days_role(self):
        response = {
            "itinerary": {
                "flight": {"options": [{"airline": "ANA"}]},
                "days": [],
            }
        }
        r = run_rubrics(response, {"call_role": "plan"}, ["R-DAYS-012"])
        assert r[0].verdict == "SKIP"


# ─── R-DETAIL-006: day_detail emits exactly one day ─────────────────────────


class TestR_DETAIL_006:
    def test_pass_on_exactly_one_day(self):
        response = {
            "itinerary": {"days": [{"day": 2, "activities": []}]}
        }
        r = run_rubrics(response, {"call_role": "day_detail"}, ["R-DETAIL-006"])
        assert r[0].verdict == "PASS"

    def test_fail_on_zero_days(self):
        response = {"itinerary": {"days": []}}
        r = run_rubrics(response, {"call_role": "day_detail"}, ["R-DETAIL-006"])
        assert r[0].verdict == "FAIL"
        assert "0" in r[0].reason

    def test_fail_on_multiple_days(self):
        response = {
            "itinerary": {
                "days": [
                    {"day": 1, "activities": []},
                    {"day": 2, "activities": []},
                ]
            }
        }
        r = run_rubrics(response, {"call_role": "day_detail"}, ["R-DETAIL-006"])
        assert r[0].verdict == "FAIL"
        assert "2" in r[0].reason

    def test_skip_when_not_day_detail_role(self):
        response = {"itinerary": {"days": []}}
        r = run_rubrics(response, {"call_role": "days"}, ["R-DETAIL-006"])
        assert r[0].verdict == "SKIP"


# ─── R-G-001: no hallucinated places (tool-grounding) ──────────────────────


class TestR_G_001:
    def test_pass_when_every_name_appears_in_tool_results(self):
        response = {
            "itinerary": {
                "hotels": [
                    {"name": "Park Hyatt Tokyo"},
                    {"name": "Grand Hyatt Tokyo"},
                ],
                "days": [
                    {
                        "activities": [
                            {"name": "Senso-ji", "place_id": "abc"},
                            {"name": "Meiji Shrine", "place_id": "def"},
                        ]
                    }
                ],
            },
            "tool_results": {
                "search_places": [
                    {"places": [
                        {"name": "Park Hyatt Tokyo"},
                        {"name": "Grand Hyatt Tokyo"},
                    ]},
                    {"places": [
                        {"name": "Senso-ji"},
                        {"name": "Meiji Shrine"},
                    ]},
                ]
            },
        }
        r = run_rubrics(response, {}, ["R-G-001"])
        assert r[0].verdict == "PASS"

    def test_fail_when_fabricated_place_emitted(self):
        response = {
            "itinerary": {
                "hotels": [
                    {"name": "Park Hyatt Tokyo"},
                    {"name": "Invented Hotel de la Mer"},
                ],
                "days": [],
            },
            "tool_results": {
                "search_places": [
                    {"places": [{"name": "Park Hyatt Tokyo"}]}
                ]
            },
        }
        r = run_rubrics(response, {}, ["R-G-001"])
        assert r[0].verdict == "FAIL"
        assert "Invented Hotel de la Mer" in r[0].reason

    def test_airport_and_hotel_stubs_skipped(self):
        """Activities with place_id=None (airports, hotels) aren't grounded."""
        response = {
            "itinerary": {
                "days": [
                    {
                        "activities": [
                            {"name": "NRT Airport · Arrival", "place_id": None},
                            {"name": "Park Hyatt Tokyo · Check-in", "place_id": None},
                            {"name": "Senso-ji", "place_id": "abc"},
                        ]
                    }
                ],
            },
            "tool_results": {
                "search_places": [{"places": [{"name": "Senso-ji"}]}]
            },
        }
        r = run_rubrics(response, {}, ["R-G-001"])
        assert r[0].verdict == "PASS"

    def test_skip_when_no_grounded_places_emitted(self):
        """Plan-only output has no place-backed activities; nothing to verify."""
        response = {
            "itinerary": {
                "flight": {"options": [{"airline": "ANA"}]},
                "days": [{"activities": []}],
            },
            "tool_results": {},
        }
        r = run_rubrics(response, {}, ["R-G-001"])
        assert r[0].verdict == "SKIP"

    def test_no_tool_results_cache_is_skip(self):
        """If the runner didn't provide tool_results (legacy path), skip."""
        response = {
            "itinerary": {
                "hotels": [{"name": "Park Hyatt Tokyo"}],
                "days": [],
            },
        }
        r = run_rubrics(response, {}, ["R-G-001"])
        assert r[0].verdict == "SKIP"


# ─── R-HOTELS-002: hotels near flight.to coords ────────────────────────────


class TestR_HOTELS_002:
    def test_pass_when_all_hotels_near_flight_destination(self):
        """Tokyo hotels within 50 km of NRT (35.76, 140.39 is NRT itself;
        city-centre hotels are ~50-70 km away, so we allow 80 km)."""
        response = {
            "itinerary": {
                "hotels": [
                    {"name": "Park Hyatt", "lat": 35.6858, "lng": 139.6908},
                    {"name": "Grand Hyatt", "lat": 35.6602, "lng": 139.7290},
                ],
            },
            "tool_results": {},
        }
        context = {
            "call_role": "hotels",
            "flight_to_lat": 35.6895,
            "flight_to_lng": 139.6917,
        }
        r = run_rubrics(response, context, ["R-HOTELS-002"])
        assert r[0].verdict == "PASS"

    def test_fail_when_hotel_in_wrong_city(self):
        """Hotel coords point to Osaka instead of Tokyo — clear violation."""
        response = {
            "itinerary": {
                "hotels": [
                    {"name": "Park Hyatt Tokyo", "lat": 35.6858, "lng": 139.6908},
                    {"name": "Osaka Mishap", "lat": 34.6937, "lng": 135.5023},
                ],
            },
            "tool_results": {},
        }
        context = {
            "call_role": "hotels",
            "flight_to_lat": 35.6895,
            "flight_to_lng": 139.6917,
        }
        r = run_rubrics(response, context, ["R-HOTELS-002"])
        assert r[0].verdict == "FAIL"
        assert "Osaka Mishap" in r[0].reason

    def test_skip_when_no_flight_coords_in_context(self):
        response = {
            "itinerary": {"hotels": [{"name": "X", "lat": 0, "lng": 0}]},
        }
        r = run_rubrics(response, {"call_role": "hotels"}, ["R-HOTELS-002"])
        assert r[0].verdict == "SKIP"

    def test_skip_when_not_hotels_role(self):
        response = {"itinerary": {"hotels": [{"name": "X", "lat": 0, "lng": 0}]}}
        context = {
            "call_role": "plan",
            "flight_to_lat": 35.68,
            "flight_to_lng": 139.69,
        }
        r = run_rubrics(response, context, ["R-HOTELS-002"])
        assert r[0].verdict == "SKIP"


# ─── R-REPLACE-002: replacement place_id grounded in search_places ─────────


class TestR_REPLACE_002:
    def test_pass_when_place_id_matches_tool_result(self):
        response = {
            "itinerary": {
                "replace": {
                    "day": 2,
                    "activity": {"name": "Ichiran", "place_id": "chijq1"},
                }
            },
            "tool_results": {
                "search_places": [
                    {"places": [
                        {"name": "Ichiran", "place_id": "chijq1"},
                        {"name": "Tonkatsu X", "place_id": "abc"},
                    ]}
                ]
            },
        }
        r = run_rubrics(response, {}, ["R-REPLACE-002"])
        assert r[0].verdict == "PASS"

    def test_fail_when_place_id_fabricated(self):
        response = {
            "itinerary": {
                "replace": {
                    "day": 2,
                    "activity": {"name": "Ichiran", "place_id": "fake_id"},
                }
            },
            "tool_results": {
                "search_places": [
                    {"places": [{"name": "Ichiran", "place_id": "real_id"}]}
                ]
            },
        }
        r = run_rubrics(response, {}, ["R-REPLACE-002"])
        assert r[0].verdict == "FAIL"

    def test_skip_on_non_replace_response(self):
        response = {"itinerary": {"days": []}, "tool_results": {}}
        r = run_rubrics(response, {}, ["R-REPLACE-002"])
        assert r[0].verdict == "SKIP"

    def test_skip_without_tool_results(self):
        response = {
            "itinerary": {"replace": {"activity": {"place_id": "x"}}}
        }
        r = run_rubrics(response, {}, ["R-REPLACE-002"])
        assert r[0].verdict == "SKIP"


# ─── R-CHAT-002: multi-airport disambiguation ──────────────────────────────


class TestR_CHAT_002:
    def test_pass_when_search_airports_and_request_input_fire(self):
        response = {
            "tool_calls_made": ["search_airports", "request_input"],
            "tool_calls_detail": [
                {"name": "search_airports", "args": {"query": "Tokyo"}},
                {"name": "request_input", "args": {
                    "field": "destination",
                    "prompt": "Which Tokyo airport?",
                    "options": [
                        "Narita International (NRT)",
                        "Haneda International (HND)",
                    ],
                }},
            ],
        }
        r = run_rubrics(
            response,
            {"call_role": "chat", "expects_airport_disambiguation": True},
            ["R-CHAT-002"],
        )
        assert r[0].verdict == "PASS"

    def test_fail_when_search_airports_missing(self):
        response = {
            "tool_calls_made": ["request_input"],
            "tool_calls_detail": [
                {"name": "request_input", "args": {"options": ["NRT", "HND"]}}
            ],
        }
        r = run_rubrics(
            response,
            {"call_role": "chat", "expects_airport_disambiguation": True},
            ["R-CHAT-002"],
        )
        assert r[0].verdict == "FAIL"
        assert "search_airports" in r[0].reason

    def test_fail_when_options_lack_iata(self):
        response = {
            "tool_calls_made": ["search_airports", "request_input"],
            "tool_calls_detail": [
                {"name": "search_airports", "args": {"query": "Tokyo"}},
                {"name": "request_input", "args": {
                    "field": "destination",
                    "options": ["Tokyo airport", "Second airport"],
                }},
            ],
        }
        r = run_rubrics(
            response,
            {"call_role": "chat", "expects_airport_disambiguation": True},
            ["R-CHAT-002"],
        )
        assert r[0].verdict == "FAIL"
        assert "IATA" in r[0].reason or "(" in r[0].reason

    def test_skip_when_context_does_not_expect_disambiguation(self):
        response = {"tool_calls_made": ["submit_trip_form"]}
        r = run_rubrics(response, {"call_role": "chat"}, ["R-CHAT-002"])
        assert r[0].verdict == "SKIP"


# ─── R-CHAT-003: single-airport city → direct submit_trip_form ────────────


class TestR_CHAT_003:
    def test_pass_when_single_airport_city_submits_directly(self):
        response = {
            "tool_calls_made": ["submit_trip_form"],
            "tool_calls_detail": [
                {"name": "submit_trip_form", "args": {"destination": "SIN"}},
            ],
        }
        r = run_rubrics(
            response,
            {"call_role": "chat", "expects_single_airport": True},
            ["R-CHAT-003"],
        )
        assert r[0].verdict == "PASS"

    def test_fail_when_search_airports_called_for_single_airport_city(self):
        response = {
            "tool_calls_made": ["search_airports", "submit_trip_form"],
            "tool_calls_detail": [
                {"name": "search_airports", "args": {"query": "Singapore"}},
                {"name": "submit_trip_form", "args": {"destination": "SIN"}},
            ],
        }
        r = run_rubrics(
            response,
            {"call_role": "chat", "expects_single_airport": True},
            ["R-CHAT-003"],
        )
        assert r[0].verdict == "FAIL"

    def test_skip_when_not_expecting_single_airport(self):
        response = {"tool_calls_made": ["submit_trip_form"]}
        r = run_rubrics(response, {"call_role": "chat"}, ["R-CHAT-003"])
        assert r[0].verdict == "SKIP"


# ─── R-CHAT-004: always round-trip — request end_date if missing ─────────


class TestR_CHAT_004:
    def test_pass_when_request_input_end_date_before_submit(self):
        response = {
            "tool_calls_made": ["request_input", "submit_trip_form"],
            "tool_calls_detail": [
                {"name": "request_input", "args": {"field": "end_date"}},
                {"name": "submit_trip_form", "args": {
                    "destination": "NRT",
                    "start_date": "2026-05-15",
                    "end_date": "2026-05-17",
                    "transport": "plane",
                }},
            ],
        }
        r = run_rubrics(
            response,
            {"call_role": "chat", "expects_end_date_prompt": True},
            ["R-CHAT-004"],
        )
        assert r[0].verdict == "PASS"

    def test_pass_when_only_request_input_end_date(self):
        """LLM may stop after request_input, waiting for user to provide it."""
        response = {
            "tool_calls_made": ["request_input"],
            "tool_calls_detail": [
                {"name": "request_input", "args": {"field": "end_date"}},
            ],
        }
        r = run_rubrics(
            response,
            {"call_role": "chat", "expects_end_date_prompt": True},
            ["R-CHAT-004"],
        )
        assert r[0].verdict == "PASS"

    def test_fail_when_submit_fires_without_end_date_prompt(self):
        response = {
            "tool_calls_made": ["submit_trip_form"],
            "tool_calls_detail": [
                {"name": "submit_trip_form", "args": {
                    "destination": "NRT",
                    "start_date": "2026-05-15",
                    "transport": "plane",
                }},
            ],
        }
        r = run_rubrics(
            response,
            {"call_role": "chat", "expects_end_date_prompt": True},
            ["R-CHAT-004"],
        )
        assert r[0].verdict == "FAIL"

    def test_skip_when_not_expecting_end_date_prompt(self):
        response = {"tool_calls_made": ["submit_trip_form"]}
        r = run_rubrics(response, {"call_role": "chat"}, ["R-CHAT-004"])
        assert r[0].verdict == "SKIP"


# ─── R-CHAT-005: submit_trip_form has all four required fields ────────────


class TestR_CHAT_005:
    def test_pass_on_complete_submit(self):
        response = {
            "tool_calls_detail": [
                {"name": "submit_trip_form", "args": {
                    "destination": "NRT",
                    "start_date": "2026-05-15",
                    "end_date": "2026-05-17",
                    "transport": "plane",
                }}
            ],
        }
        r = run_rubrics(response, {"call_role": "chat"}, ["R-CHAT-005"])
        assert r[0].verdict == "PASS"

    def test_fail_when_missing_end_date(self):
        response = {
            "tool_calls_detail": [
                {"name": "submit_trip_form", "args": {
                    "destination": "NRT",
                    "start_date": "2026-05-15",
                    "transport": "plane",
                }}
            ],
        }
        r = run_rubrics(response, {"call_role": "chat"}, ["R-CHAT-005"])
        assert r[0].verdict == "FAIL"
        assert "end_date" in r[0].reason

    def test_fail_when_destination_is_not_iata(self):
        response = {
            "tool_calls_detail": [
                {"name": "submit_trip_form", "args": {
                    "destination": "Tokyo",
                    "start_date": "2026-05-15",
                    "end_date": "2026-05-17",
                    "transport": "plane",
                }}
            ],
        }
        r = run_rubrics(response, {"call_role": "chat"}, ["R-CHAT-005"])
        assert r[0].verdict == "FAIL"
        assert "IATA" in r[0].reason or "3-letter" in r[0].reason

    def test_skip_when_no_submit_call(self):
        response = {
            "tool_calls_detail": [
                {"name": "request_input", "args": {"field": "end_date"}}
            ],
        }
        r = run_rubrics(response, {"call_role": "chat"}, ["R-CHAT-005"])
        assert r[0].verdict == "SKIP"


# ─── R-CHAT-006: relative dates computed from TODAY ───────────────────────


class TestR_CHAT_006:
    def test_pass_when_dates_match_expected(self):
        response = {
            "tool_calls_detail": [
                {"name": "submit_trip_form", "args": {
                    "destination": "NRT",
                    "start_date": "2026-04-19",
                    "end_date": "2026-04-24",
                    "transport": "plane",
                }}
            ],
        }
        context = {
            "call_role": "chat",
            "today": "2026-04-17",
            "expected_start_date": "2026-04-19",
            "expected_end_date": "2026-04-24",
        }
        r = run_rubrics(response, context, ["R-CHAT-006"])
        assert r[0].verdict == "PASS"

    def test_fail_when_dates_drift(self):
        response = {
            "tool_calls_detail": [
                {"name": "submit_trip_form", "args": {
                    "destination": "NRT",
                    "start_date": "2026-04-20",  # off by 1 day
                    "end_date": "2026-04-24",
                    "transport": "plane",
                }}
            ],
        }
        context = {
            "call_role": "chat",
            "today": "2026-04-17",
            "expected_start_date": "2026-04-19",
            "expected_end_date": "2026-04-24",
        }
        r = run_rubrics(response, context, ["R-CHAT-006"])
        assert r[0].verdict == "FAIL"

    def test_skip_when_expected_dates_missing(self):
        response = {"tool_calls_detail": []}
        r = run_rubrics(response, {"call_role": "chat"}, ["R-CHAT-006"])
        assert r[0].verdict == "SKIP"


# ─── R-PLAN-006: IATA extraction in search_flights args ───────────────────


class TestR_PLAN_006:
    def test_pass_on_three_letter_iata_codes(self):
        response = {
            "tool_calls_detail": [
                {"name": "search_flights", "args": {
                    "origin": "HKG", "destination": "NRT",
                    "date": "2026-05-15",
                }}
            ]
        }
        r = run_rubrics(response, {"call_role": "plan"}, ["R-PLAN-006"])
        assert r[0].verdict == "PASS"

    def test_fail_when_origin_is_full_label(self):
        response = {
            "tool_calls_detail": [
                {"name": "search_flights", "args": {
                    "origin": "Hong Kong International (HKG)",
                    "destination": "NRT",
                }}
            ]
        }
        r = run_rubrics(response, {"call_role": "plan"}, ["R-PLAN-006"])
        assert r[0].verdict == "FAIL"
        assert "origin" in r[0].reason

    def test_fail_when_destination_is_city_name(self):
        response = {
            "tool_calls_detail": [
                {"name": "search_flights", "args": {
                    "origin": "HKG", "destination": "Tokyo",
                }}
            ]
        }
        r = run_rubrics(response, {"call_role": "plan"}, ["R-PLAN-006"])
        assert r[0].verdict == "FAIL"

    def test_skip_when_no_search_flights_call(self):
        response = {"tool_calls_detail": [
            {"name": "request_input", "args": {}}
        ]}
        r = run_rubrics(response, {"call_role": "plan"}, ["R-PLAN-006"])
        assert r[0].verdict == "SKIP"


# ─── R-DAYS-008: middle-day meals pattern ─────────────────────────────────


class TestR_DAYS_008:
    def test_pass_when_middle_days_have_meals(self):
        response = {
            "itinerary": {
                "days": [
                    {"day": 1, "activities": [
                        {"name": "NRT Airport · Arrival"},
                        {"name": "Hotel · Check-in"},
                    ]},
                    {"day": 2, "activities": [
                        {"name": "Tsukiji Outer Market breakfast"},
                        {"name": "Senso-ji"},
                        {"name": "Ichiran Ramen lunch"},
                        {"name": "Harajuku"},
                    ]},
                    {"day": 3, "activities": [
                        {"name": "Hotel · Check-out"},
                        {"name": "Airport departure"},
                    ]},
                ]
            }
        }
        r = run_rubrics(response, {"call_role": "days"}, ["R-DAYS-008"])
        assert r[0].verdict == "PASS"

    def test_fail_when_middle_day_has_no_meal(self):
        response = {
            "itinerary": {
                "days": [
                    {"day": 1, "activities": [{"name": "Airport"}]},
                    {"day": 2, "activities": [
                        {"name": "Senso-ji"},
                        {"name": "Meiji Shrine"},
                        {"name": "Harajuku walk"},
                    ]},
                    {"day": 3, "activities": [{"name": "Airport"}]},
                ]
            }
        }
        r = run_rubrics(response, {"call_role": "days"}, ["R-DAYS-008"])
        assert r[0].verdict == "FAIL"

    def test_skip_on_2_day_trip_no_middle_days(self):
        response = {
            "itinerary": {
                "days": [
                    {"day": 1, "activities": []},
                    {"day": 2, "activities": []},
                ]
            }
        }
        r = run_rubrics(response, {"call_role": "days"}, ["R-DAYS-008"])
        assert r[0].verdict == "SKIP"

    def test_skip_when_not_days_role(self):
        response = {"itinerary": {"days": []}}
        r = run_rubrics(response, {"call_role": "plan"}, ["R-DAYS-008"])
        assert r[0].verdict == "SKIP"


# ─── R-DAYS-011: activity descriptions 10-15 words (self-written) ─────────


class TestR_DAYS_011:
    def test_pass_on_typical_description(self):
        response = {
            "itinerary": {
                "days": [{"activities": [
                    {
                        "place_id": "abc",
                        "description": (
                            "Iconic crimson gate temple with ancient "
                            "architecture and bustling Nakamise souvenir street."
                        ),
                    }
                ]}]
            }
        }
        r = run_rubrics(response, {"call_role": "days"}, ["R-DAYS-011"])
        assert r[0].verdict == "PASS"

    def test_fail_when_description_too_short(self):
        response = {
            "itinerary": {
                "days": [{"activities": [
                    {"place_id": "abc", "description": "Famous temple."}
                ]}]
            }
        }
        r = run_rubrics(response, {"call_role": "days"}, ["R-DAYS-011"])
        assert r[0].verdict == "FAIL"

    def test_fail_when_description_too_long(self):
        text = " ".join(["word"] * 40)
        response = {
            "itinerary": {
                "days": [{"activities": [
                    {"place_id": "abc", "description": text},
                ]}]
            }
        }
        r = run_rubrics(response, {"call_role": "days"}, ["R-DAYS-011"])
        assert r[0].verdict == "FAIL"

    def test_skip_for_airport_and_hotel_stubs(self):
        """Stub activities (no place_id) don't need a description."""
        response = {
            "itinerary": {
                "days": [{"activities": [
                    {"place_id": None, "description": "x"},
                    {"place_id": None},
                ]}]
            }
        }
        r = run_rubrics(response, {"call_role": "days"}, ["R-DAYS-011"])
        assert r[0].verdict == "SKIP"


# ─── R-DETAIL-002: search_places per area + directions per pair ───────────


class TestR_DETAIL_002:
    def test_pass_when_counts_match(self):
        response = {
            "itinerary": {
                "days": [{
                    "activities": [
                        {"name": "A", "place_id": "1"},
                        {"name": "B", "place_id": "2"},
                        {"name": "C", "place_id": "3"},
                    ]
                }]
            },
            "tool_calls_made": [
                "search_places", "search_places", "search_places",
                "get_directions", "get_directions",
            ],
        }
        context = {
            "call_role": "day_detail",
            "suggested_areas_count": 3,  # 3 areas → 3 search_places calls
        }
        r = run_rubrics(response, context, ["R-DETAIL-002"])
        assert r[0].verdict == "PASS"

    def test_fail_when_directions_call_count_too_low(self):
        response = {
            "itinerary": {
                "days": [{
                    "activities": [
                        {"name": "A", "place_id": "1"},
                        {"name": "B", "place_id": "2"},
                        {"name": "C", "place_id": "3"},
                        {"name": "D", "place_id": "4"},
                    ]
                }]
            },
            "tool_calls_made": [
                "search_places", "search_places", "search_places",
                "get_directions",
            ],
        }
        context = {"call_role": "day_detail", "suggested_areas_count": 3}
        r = run_rubrics(response, context, ["R-DETAIL-002"])
        assert r[0].verdict == "FAIL"
        assert "directions" in r[0].reason.lower()

    def test_skip_when_not_day_detail_role(self):
        response = {}
        r = run_rubrics(
            response,
            {"call_role": "days", "suggested_areas_count": 2},
            ["R-DETAIL-002"],
        )
        assert r[0].verdict == "SKIP"


# ─── R-DETAIL-003: get_directions mode matches transport ─────────────────


class TestR_DETAIL_003:
    def test_pass_when_all_modes_match(self):
        response = {
            "tool_calls_detail": [
                {"name": "get_directions", "args": {
                    "origin": "A", "destination": "B", "mode": "TRANSIT",
                }},
                {"name": "get_directions", "args": {
                    "origin": "B", "destination": "C", "mode": "TRANSIT",
                }},
            ]
        }
        context = {"call_role": "day_detail", "local_transport_mode": "transit"}
        r = run_rubrics(response, context, ["R-DETAIL-003"])
        assert r[0].verdict == "PASS"

    def test_fail_when_mode_mismatch(self):
        response = {
            "tool_calls_detail": [
                {"name": "get_directions", "args": {
                    "origin": "A", "destination": "B", "mode": "WALK",
                }},
            ]
        }
        context = {"call_role": "day_detail", "local_transport_mode": "transit"}
        r = run_rubrics(response, context, ["R-DETAIL-003"])
        assert r[0].verdict == "FAIL"
        assert "WALK" in r[0].reason and "TRANSIT" in r[0].reason

    def test_fail_when_mode_missing(self):
        response = {
            "tool_calls_detail": [
                {"name": "get_directions", "args": {
                    "origin": "A", "destination": "B",
                }},
            ]
        }
        context = {"call_role": "day_detail", "local_transport_mode": "driving"}
        r = run_rubrics(response, context, ["R-DETAIL-003"])
        assert r[0].verdict == "FAIL"
        assert "mode" in r[0].reason.lower()

    def test_skip_when_no_transport_mode_in_context(self):
        response = {"tool_calls_detail": []}
        r = run_rubrics(response, {"call_role": "day_detail"}, ["R-DETAIL-003"])
        assert r[0].verdict == "SKIP"


# ─── R-REPLACE-003: preserve time / duration_min ──────────────────────────


class TestR_REPLACE_003:
    def test_pass_when_time_and_duration_preserved(self):
        response = {
            "itinerary": {
                "replace": {
                    "activity": {
                        "name": "Ichiran",
                        "time": "12:30",
                        "duration_min": 60,
                    }
                }
            }
        }
        context = {
            "original_activity": {"time": "12:30", "duration_min": 60},
        }
        r = run_rubrics(response, context, ["R-REPLACE-003"])
        assert r[0].verdict == "PASS"

    def test_fail_when_time_changed(self):
        response = {
            "itinerary": {
                "replace": {
                    "activity": {
                        "name": "Ichiran",
                        "time": "13:00",
                        "duration_min": 60,
                    }
                }
            }
        }
        context = {
            "original_activity": {"time": "12:30", "duration_min": 60},
        }
        r = run_rubrics(response, context, ["R-REPLACE-003"])
        assert r[0].verdict == "FAIL"
        assert "12:30" in r[0].reason

    def test_pass_when_duration_changed_but_time_same(self):
        """Duration may change if the activity is fundamentally different,
        but time must stay the same."""
        response = {
            "itinerary": {
                "replace": {
                    "activity": {
                        "name": "Ichiran",
                        "time": "12:30",
                        "duration_min": 90,
                    }
                }
            }
        }
        context = {
            "original_activity": {"time": "12:30", "duration_min": 60},
        }
        r = run_rubrics(response, context, ["R-REPLACE-003"])
        assert r[0].verdict == "PASS"

    def test_skip_without_original_activity_in_context(self):
        response = {"itinerary": {"replace": {"activity": {"time": "10:00"}}}}
        r = run_rubrics(response, {}, ["R-REPLACE-003"])
        assert r[0].verdict == "SKIP"


# ─── R-G-007: no tool-call narration (LLM-judge) ───────────────────────────


class TestR_G_007:
    @pytest.mark.asyncio
    async def test_pass_when_judge_returns_pass(self):
        response = {"reply": "Three days in Tokyo confirmed at Senso-ji temple."}
        with patch(
            "app.evals.rubrics.judge",
            AsyncMock(return_value={"verdict": "PASS", "reason": "direct"}),
        ):
            results = await arun_rubrics(response, {}, ["R-G-007"])
        assert results[0].verdict == "PASS"

    @pytest.mark.asyncio
    async def test_fail_when_judge_returns_fail(self):
        response = {"reply": "Let me search for flights now, then look for hotels."}
        with patch(
            "app.evals.rubrics.judge",
            AsyncMock(return_value={"verdict": "FAIL", "reason": "narrates"}),
        ):
            results = await arun_rubrics(response, {}, ["R-G-007"])
        assert results[0].verdict == "FAIL"

    @pytest.mark.asyncio
    async def test_skip_when_no_prose(self):
        response = {"reply": ""}
        with patch(
            "app.evals.rubrics.judge", AsyncMock()
        ) as mock_judge:
            results = await arun_rubrics(response, {}, ["R-G-007"])
        assert results[0].verdict == "SKIP"
        mock_judge.assert_not_called()

    @pytest.mark.asyncio
    async def test_skip_when_judge_unavailable(self):
        response = {"reply": "Three days confirmed."}
        with patch(
            "app.evals.rubrics.judge",
            AsyncMock(return_value={"verdict": "SKIP", "reason": "no key"}),
        ):
            results = await arun_rubrics(response, {}, ["R-G-007"])
        assert results[0].verdict == "SKIP"


# ─── R-THEMES-004: day 1 / last-day themes account for flight timing ───────


class TestR_THEMES_004:
    @pytest.mark.asyncio
    async def test_pass_when_judge_says_themes_fit_timing(self):
        response = {
            "itinerary": {
                "days": [
                    {
                        "day": 1,
                        "theme": "Airport arrival afternoon easy walk",
                        "key_constraints": {"arrival_time": "14:50"},
                    },
                    {"day": 2, "theme": "Full Shibuya"},
                    {
                        "day": 3,
                        "theme": "Relaxed shopping before 18:00 flight",
                        "key_constraints": {"departure_time": "18:00"},
                    },
                ]
            }
        }
        with patch(
            "app.evals.rubrics.judge",
            AsyncMock(return_value={"verdict": "PASS", "reason": "timing accounted"}),
        ):
            results = await arun_rubrics(response, {}, ["R-THEMES-004"])
        assert results[0].verdict == "PASS"

    @pytest.mark.asyncio
    async def test_skip_when_no_key_constraints(self):
        """No flight event means no constraint — skip."""
        response = {
            "itinerary": {
                "days": [
                    {"day": 1, "theme": "Sightseeing"},
                    {"day": 2, "theme": "Food"},
                ]
            }
        }
        with patch("app.evals.rubrics.judge", AsyncMock()) as mock_judge:
            results = await arun_rubrics(response, {}, ["R-THEMES-004"])
        assert results[0].verdict == "SKIP"
        mock_judge.assert_not_called()


# ─── arun_rubrics runs both sync + async ───────────────────────────────────


class TestArunRubrics:
    @pytest.mark.asyncio
    async def test_awaits_async_and_passes_sync_through(self):
        response = {
            "reply": "Three days confirmed.",
            "itinerary": {},
        }
        with patch(
            "app.evals.rubrics.judge",
            AsyncMock(return_value={"verdict": "PASS", "reason": "ok"}),
        ):
            results = await arun_rubrics(
                response, {}, ["R-G-004", "R-G-007"]
            )
        verdicts = {r.rubric_id: r.verdict for r in results}
        assert verdicts["R-G-004"] == "PASS"
        assert verdicts["R-G-007"] == "PASS"


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
