"""Rubric functions — one per R-* requirement the eval harness checks.

Each rubric is a pure function `(response, context) -> RubricResult`.

Rubric categories:
  - REGEX: deterministic, fast, offline. Regex on the reply text.
  - TOOL-USE: needs tool_calls_made + tool_result cache from the chat() call.
  - LLM-JUDGE: calls a second LLM to score the response (see judge.py).

`response` shape:
    {
      "reply": str,                  # final LLM text (includes ```json block)
      "itinerary": dict | None,      # parsed from _extract_itinerary
      "tool_calls_made": list[str],  # names in call order
      "tool_results": dict[str, list[dict]],  # name → list of result dicts
    }

`context` is the eval-suite fixture (call_role, seed user_message, etc.).

Rubric IDs mirror docs/llm-spec.md requirement IDs.
"""
from __future__ import annotations

import inspect
import json
import math
import re
from dataclasses import dataclass
from typing import Callable

from app.evals.judge import judge


@dataclass
class RubricResult:
    rubric_id: str
    verdict: str  # "PASS" | "FAIL" | "SKIP"
    reason: str

    @classmethod
    def pass_(cls, rubric_id: str, reason: str = "") -> "RubricResult":
        return cls(rubric_id, "PASS", reason or "ok")

    @classmethod
    def fail(cls, rubric_id: str, reason: str) -> "RubricResult":
        return cls(rubric_id, "FAIL", reason)

    @classmethod
    def skip(cls, rubric_id: str, reason: str) -> "RubricResult":
        return cls(rubric_id, "SKIP", reason)


# ─── helpers ────────────────────────────────────────────────────────────────


_FENCED_JSON_RE = re.compile(r"```json\s*(.*?)\s*```", re.DOTALL)
_UNFENCED_JSON_RE = re.compile(r"\{[^{}]*\"itinerary\"", re.DOTALL)


def strip_json_block(reply: str) -> str:
    """Return the reply text with any ```json``` block removed."""
    # Fenced block
    prose = _FENCED_JSON_RE.sub("", reply)
    # Fallback: if there's an unfenced `{"itinerary": ...}` inline, find the
    # matching closing brace and strip it.
    if "itinerary" in prose:
        match = _UNFENCED_JSON_RE.search(prose)
        if match:
            start = match.start()
            depth = 0
            for i in range(start, len(prose)):
                if prose[i] == "{":
                    depth += 1
                elif prose[i] == "}":
                    depth -= 1
                    if depth == 0:
                        prose = prose[:start] + prose[i + 1 :]
                        break
    return prose.strip()


def count_words(text: str) -> int:
    return len([w for w in re.split(r"\s+", text.strip()) if w])


def haversine_km(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    """Great-circle distance in km between two lat/lng points."""
    r = 6371.0
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlam = math.radians(lng2 - lng1)
    a = math.sin(dphi / 2) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(dlam / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


# ─── REGEX rubrics ──────────────────────────────────────────────────────────


def check_R_G_004_has_prose_outside_json(response: dict, context: dict) -> RubricResult:
    """R-G-004: every reply MUST include spoken text outside any JSON block."""
    rid = "R-G-004"
    prose = strip_json_block(response.get("reply", ""))
    if not prose:
        return RubricResult.fail(rid, "Reply contains only a JSON block (no spoken subtitle)")
    return RubricResult.pass_(rid, f"prose: {prose[:60]!r}")


def check_R_G_005_no_markdown(response: dict, context: dict) -> RubricResult:
    """R-G-005: no **bold**, *italic*, `code` in reply prose."""
    rid = "R-G-005"
    prose = strip_json_block(response.get("reply", ""))
    patterns = {
        "bold": r"\*\*[^*]+\*\*",
        "italic": r"(?<!\*)\*[^*\s][^*]*[^*\s]\*(?!\*)",
        "backtick-code": r"`[^`\n]+`",
        "underscore-emphasis": r"__[^_]+__",
    }
    for kind, pattern in patterns.items():
        if re.search(pattern, prose):
            return RubricResult.fail(rid, f"Markdown {kind} detected in reply prose")
    return RubricResult.pass_(rid)


def check_R_G_006_no_bullets(response: dict, context: dict) -> RubricResult:
    """R-G-006: no bullet lists / paragraphs in reply text."""
    rid = "R-G-006"
    prose = strip_json_block(response.get("reply", ""))
    for line in prose.splitlines():
        stripped = line.strip()
        if re.match(r"^([-*•]|\d+[.)])\s+\S", stripped):
            return RubricResult.fail(rid, f"Bullet/numbered list detected: {stripped[:40]!r}")
    return RubricResult.pass_(rid)


def check_R_G_015_subtitle_length_10_25_words(
    response: dict, context: dict
) -> RubricResult:
    """R-G-015: subtitle is punchy ~10-25 words."""
    rid = "R-G-015"
    prose = strip_json_block(response.get("reply", ""))
    n = count_words(prose)
    # Allow a small tolerance band; spec says ~10-25 but clarifying questions
    # are legitimately shorter.
    if n < 6:
        return RubricResult.fail(rid, f"Subtitle is {n} words; too short")
    if n > 35:
        return RubricResult.fail(rid, f"Subtitle is {n} words; exceeds 25-word target")
    return RubricResult.pass_(rid, f"{n} words")


def check_R_REPLACE_006_description_10_to_15_words(
    response: dict, context: dict
) -> RubricResult:
    """R-REPLACE-006: replacement activity description is 10-15 words."""
    rid = "R-REPLACE-006"
    itinerary = response.get("itinerary") or {}
    replace = itinerary.get("replace")
    if not replace:
        return RubricResult.skip(rid, "not a replace response")
    desc = (replace.get("activity") or {}).get("description", "")
    n = count_words(desc)
    if 8 <= n <= 20:
        return RubricResult.pass_(rid, f"{n} words")
    return RubricResult.fail(rid, f"Description is {n} words; expected ~10-15")


# ─── TOOL-USE rubrics ───────────────────────────────────────────────────────


def check_R_G_002_transport_preceded_by_directions(
    response: dict, context: dict
) -> RubricResult:
    """R-G-002: every activity with transport_to_next must be preceded by
    at least one get_directions call in the same turn."""
    rid = "R-G-002"
    itinerary = response.get("itinerary") or {}
    days = itinerary.get("days") or []
    has_any_transport = any(
        (a.get("transport_to_next") is not None)
        for d in days
        for a in d.get("activities", [])
    )
    if not has_any_transport:
        return RubricResult.skip(rid, "no transport_to_next in itinerary")
    tool_calls = response.get("tool_calls_made", [])
    if "get_directions" not in tool_calls:
        return RubricResult.fail(
            rid,
            "Itinerary contains transport_to_next but no get_directions call was made",
        )
    return RubricResult.pass_(rid, f"{tool_calls.count('get_directions')} directions calls")


def check_R_G_003_weather_preceded_by_get_weather(
    response: dict, context: dict
) -> RubricResult:
    """R-G-003: every day with weather data must have get_weather fired."""
    rid = "R-G-003"
    itinerary = response.get("itinerary") or {}
    days = itinerary.get("days") or []
    has_any_weather = any(d.get("weather") for d in days)
    if not has_any_weather:
        return RubricResult.skip(rid, "no weather in itinerary")
    if "get_weather" not in response.get("tool_calls_made", []):
        return RubricResult.fail(rid, "Itinerary has weather but no get_weather call")
    return RubricResult.pass_(rid)


def check_R_PLAN_002_country_triggers_request_input(
    response: dict, context: dict
) -> RubricResult:
    """R-PLAN-002: country destination should trigger request_input, not search_flights."""
    rid = "R-PLAN-002"
    expect_clarification = context.get("expects_clarification") is True
    if not expect_clarification:
        return RubricResult.skip(rid, "context does not expect a clarification")
    calls = response.get("tool_calls_made", [])
    if "request_input" not in calls:
        return RubricResult.fail(rid, f"Expected request_input; got {calls}")
    if "search_flights" in calls:
        return RubricResult.fail(
            rid, "search_flights was called despite missing clarification — R-G-016 violation"
        )
    return RubricResult.pass_(rid)


def check_R_CHAT_001_no_data_fetch_tools(
    response: dict, context: dict
) -> RubricResult:
    """R-CHAT-001: chat role MUST NOT call search_flights/search_places/etc."""
    rid = "R-CHAT-001"
    if context.get("call_role") != "chat":
        return RubricResult.skip(rid, "not a chat role response")
    banned = {"search_flights", "search_places", "get_directions",
              "get_weather", "get_place_details"}
    calls = set(response.get("tool_calls_made", []))
    offenders = calls & banned
    if offenders:
        return RubricResult.fail(rid, f"Chat role called data-fetch tools: {sorted(offenders)}")
    return RubricResult.pass_(rid)


def check_R_PLAN_004_must_call_search_flights_and_geocode(
    response: dict, context: dict
) -> RubricResult:
    """R-PLAN-004: if response has flight options, both search_flights AND
    geocode_city MUST be in tool_calls_made."""
    rid = "R-PLAN-004"
    itinerary = response.get("itinerary") or {}
    flight = itinerary.get("flight") or {}
    options = flight.get("options") if isinstance(flight, dict) else None
    if not options:
        return RubricResult.skip(rid, "no flight options to verify")
    calls = response.get("tool_calls_made", [])
    missing = [t for t in ("search_flights", "geocode_city") if t not in calls]
    if missing:
        return RubricResult.fail(rid, f"missing required calls: {missing}")
    return RubricResult.pass_(rid)


def check_R_PLAN_003_no_text_question(
    response: dict, context: dict
) -> RubricResult:
    """R-PLAN-003: plan role MUST NOT ask for missing info via reply text —
    always use request_input. A prose question mark is OK only when
    request_input also fires (the question accompanies a structured ask)."""
    rid = "R-PLAN-003"
    if context.get("call_role") != "plan":
        return RubricResult.skip(rid, "not plan role")
    prose = strip_json_block(response.get("reply", ""))
    if not prose.rstrip().endswith("?"):
        return RubricResult.pass_(rid)
    calls = response.get("tool_calls_made", [])
    if "request_input" in calls:
        return RubricResult.pass_(
            rid, "question accompanies a request_input call"
        )
    tail = prose[-80:].replace("\n", " ")
    return RubricResult.fail(
        rid,
        f"prose ends with '?' but no request_input call: {tail!r}",
    )


def check_R_CHAT_008_one_sentence_reply(
    response: dict, context: dict
) -> RubricResult:
    """R-CHAT-008: chat reply is ONE short friendly sentence, no JSON."""
    rid = "R-CHAT-008"
    if context.get("call_role") != "chat":
        return RubricResult.skip(rid, "not chat role")
    reply = response.get("reply", "")
    if "```json" in reply:
        return RubricResult.fail(rid, "chat reply contains a JSON block")
    prose = strip_json_block(reply)
    if not prose:
        return RubricResult.fail(rid, "chat reply is empty after stripping JSON")
    sentence_count = len([s for s in re.split(r"[.!?]+\s", prose) if s.strip()])
    if sentence_count > 2:
        return RubricResult.fail(
            rid, f"chat reply has {sentence_count} sentences; expected 1"
        )
    return RubricResult.pass_(rid, f"{sentence_count} sentence(s)")


def check_R_DAYS_012_no_flight_or_hotels_re_emit(
    response: dict, context: dict
) -> RubricResult:
    """R-DAYS-012: days role MUST NOT re-emit flight or hotels."""
    rid = "R-DAYS-012"
    if context.get("call_role") != "days":
        return RubricResult.skip(rid, "not days role")
    itinerary = response.get("itinerary") or {}
    leaked = [k for k in ("flight", "hotels") if k in itinerary]
    if leaked:
        return RubricResult.fail(rid, f"days response leaks keys: {leaked}")
    return RubricResult.pass_(rid)


def check_R_DETAIL_006_exactly_one_day(
    response: dict, context: dict
) -> RubricResult:
    """R-DETAIL-006: day_detail output MUST contain exactly one day object."""
    rid = "R-DETAIL-006"
    if context.get("call_role") != "day_detail":
        return RubricResult.skip(rid, "not day_detail role")
    days = (response.get("itinerary") or {}).get("days") or []
    if len(days) != 1:
        return RubricResult.fail(
            rid, f"day_detail returned {len(days)} day(s); expected 1"
        )
    return RubricResult.pass_(rid)


def check_R_G_001_no_hallucinated_places(
    response: dict, context: dict
) -> RubricResult:
    """R-G-001: every place name in itinerary.hotels and grounded activities
    (place_id set) MUST appear in the `name` field of at least one
    search_places result from the same turn.

    v1 uses strict equality. Future: fuzzy match to handle LLM diacritic
    drift (e.g. 'Senso-ji' vs 'Sensō-ji Temple')."""
    rid = "R-G-001"
    tool_results = response.get("tool_results")
    if tool_results is None:
        # No cache provided by the runner (legacy path) — can't verify.
        return RubricResult.skip(rid, "no tool_results cache in response")

    itinerary = response.get("itinerary") or {}
    sp_results = tool_results.get("search_places") or []

    emitted: list[str] = []
    for h in itinerary.get("hotels") or []:
        if h.get("name"):
            emitted.append(h["name"])
    for d in itinerary.get("days") or []:
        for a in d.get("activities") or []:
            if a.get("place_id") is None:
                continue  # airport / hotel stubs aren't grounded in search_places
            if a.get("name"):
                emitted.append(a["name"])

    if not emitted:
        return RubricResult.skip(rid, "no place-backed activities to verify")

    tool_names: set[str] = set()
    for batch in sp_results:
        for p in (batch.get("places") or []):
            if p.get("name"):
                tool_names.add(p["name"])

    hallucinated = [n for n in emitted if n not in tool_names]
    if hallucinated:
        return RubricResult.fail(
            rid, f"place(s) not in any search_places result: {hallucinated}"
        )
    return RubricResult.pass_(rid, f"{len(emitted)} places, all grounded")


def check_R_HOTELS_002_hotels_near_destination(
    response: dict, context: dict
) -> RubricResult:
    """R-HOTELS-002: hotel coordinates must be near the flight's destination
    city (within 80 km of flight.to_lat/to_lng). Catches cases where the
    LLM used an example destination (Tokyo) instead of the real one."""
    rid = "R-HOTELS-002"
    if context.get("call_role") != "hotels":
        return RubricResult.skip(rid, "not hotels role")
    lat = context.get("flight_to_lat")
    lng = context.get("flight_to_lng")
    if lat is None or lng is None:
        return RubricResult.skip(rid, "flight_to_lat/lng missing from context")

    hotels = (response.get("itinerary") or {}).get("hotels") or []
    if not hotels:
        return RubricResult.skip(rid, "no hotels to check")

    misplaced = []
    for h in hotels:
        hlat, hlng = h.get("lat"), h.get("lng")
        if hlat is None or hlng is None:
            continue
        dist = haversine_km(lat, lng, hlat, hlng)
        if dist > 80.0:
            misplaced.append(f"{h.get('name','?')} ({dist:.0f} km away)")
    if misplaced:
        return RubricResult.fail(rid, f"hotels too far from destination: {misplaced}")
    return RubricResult.pass_(rid, f"{len(hotels)} hotels within 80 km")


def check_R_REPLACE_002_activity_place_id_grounded(
    response: dict, context: dict
) -> RubricResult:
    """R-REPLACE-002: replacement activity's place_id must appear in at
    least one search_places result from this turn."""
    rid = "R-REPLACE-002"
    tool_results = response.get("tool_results")
    if tool_results is None:
        return RubricResult.skip(rid, "no tool_results cache")
    replace = (response.get("itinerary") or {}).get("replace")
    if not replace:
        return RubricResult.skip(rid, "not a replace response")
    pid = (replace.get("activity") or {}).get("place_id")
    if not pid:
        return RubricResult.skip(rid, "replacement activity has no place_id")

    tool_ids: set[str] = set()
    for batch in tool_results.get("search_places") or []:
        for p in (batch.get("places") or []):
            if p.get("place_id"):
                tool_ids.add(p["place_id"])
    if pid not in tool_ids:
        return RubricResult.fail(
            rid, f"place_id {pid!r} not in any search_places result"
        )
    return RubricResult.pass_(rid)


def _find_detail_call(response: dict, name: str) -> dict | None:
    """Return the first {name, args} entry in tool_calls_detail matching
    `name`, or None."""
    for call in response.get("tool_calls_detail") or []:
        if call.get("name") == name:
            return call
    return None


_IATA_RE = re.compile(r"^[A-Z]{3}$")
_LABEL_IATA_RE = re.compile(r"\(([A-Z]{3})\)")


def check_R_CHAT_002_airport_disambiguation(
    response: dict, context: dict
) -> RubricResult:
    """R-CHAT-002: multi-airport cities (Tokyo, London, NY) — LLM must call
    search_airports AND request_input with 2+ 'Name (IATA)' options."""
    rid = "R-CHAT-002"
    if not context.get("expects_airport_disambiguation"):
        return RubricResult.skip(rid, "context does not expect disambiguation")
    if context.get("call_role") != "chat":
        return RubricResult.skip(rid, "not chat role")
    calls = response.get("tool_calls_made", [])
    missing = [t for t in ("search_airports", "request_input") if t not in calls]
    if missing:
        return RubricResult.fail(rid, f"missing required calls: {missing}")
    req = _find_detail_call(response, "request_input")
    options = (req or {}).get("args", {}).get("options") or []
    if len(options) < 2:
        return RubricResult.fail(
            rid, f"request_input options had {len(options)} items; need ≥2"
        )
    with_iata = [o for o in options if _LABEL_IATA_RE.search(str(o))]
    if len(with_iata) < 2:
        return RubricResult.fail(
            rid,
            f"options lack 'Name (IATA)' format — only {len(with_iata)} of "
            f"{len(options)} contain a parenthesised IATA code",
        )
    return RubricResult.pass_(rid)


def check_R_CHAT_003_single_airport_shortcut(
    response: dict, context: dict
) -> RubricResult:
    """R-CHAT-003: single-airport cities (SIN, HKG, BKK) skip
    search_airports and submit_trip_form directly."""
    rid = "R-CHAT-003"
    if not context.get("expects_single_airport"):
        return RubricResult.skip(rid, "context does not expect single-airport flow")
    if context.get("call_role") != "chat":
        return RubricResult.skip(rid, "not chat role")
    calls = response.get("tool_calls_made", [])
    if "search_airports" in calls:
        return RubricResult.fail(
            rid, "search_airports fired for a single-airport city; should skip it"
        )
    if "submit_trip_form" not in calls:
        return RubricResult.fail(rid, "submit_trip_form did not fire")
    return RubricResult.pass_(rid)


def check_R_CHAT_004_round_trip_requires_end_date(
    response: dict, context: dict
) -> RubricResult:
    """R-CHAT-004: if end_date is missing, request_input('end_date', …)
    MUST fire before submit_trip_form (or instead of it, to wait for user)."""
    rid = "R-CHAT-004"
    if not context.get("expects_end_date_prompt"):
        return RubricResult.skip(rid, "context does not expect end_date prompt")
    if context.get("call_role") != "chat":
        return RubricResult.skip(rid, "not chat role")
    detail = response.get("tool_calls_detail") or []
    end_prompt_idx: int | None = None
    submit_idx: int | None = None
    for i, call in enumerate(detail):
        if (
            call.get("name") == "request_input"
            and call.get("args", {}).get("field") == "end_date"
        ):
            end_prompt_idx = i if end_prompt_idx is None else end_prompt_idx
        if call.get("name") == "submit_trip_form":
            submit_idx = i if submit_idx is None else submit_idx
    if end_prompt_idx is None:
        return RubricResult.fail(
            rid, "no request_input(field='end_date') call before submit_trip_form"
        )
    if submit_idx is not None and end_prompt_idx > submit_idx:
        return RubricResult.fail(
            rid, "request_input('end_date') fired AFTER submit_trip_form"
        )
    return RubricResult.pass_(rid)


def check_R_CHAT_005_submit_trip_form_four_fields(
    response: dict, context: dict
) -> RubricResult:
    """R-CHAT-005: submit_trip_form requires destination (IATA), start_date
    (YYYY-MM-DD), end_date (YYYY-MM-DD), transport — all four present."""
    rid = "R-CHAT-005"
    call = _find_detail_call(response, "submit_trip_form")
    if not call:
        return RubricResult.skip(rid, "no submit_trip_form call to verify")
    args = call.get("args") or {}
    required = ("destination", "start_date", "end_date", "transport")
    missing = [f for f in required if not args.get(f)]
    if missing:
        return RubricResult.fail(rid, f"submit_trip_form missing fields: {missing}")
    if not _IATA_RE.match(str(args.get("destination", ""))):
        return RubricResult.fail(
            rid,
            f"destination {args.get('destination')!r} is not a 3-letter IATA code",
        )
    for field in ("start_date", "end_date"):
        if not re.match(r"^\d{4}-\d{2}-\d{2}$", str(args[field])):
            return RubricResult.fail(
                rid, f"{field}={args[field]!r} not in YYYY-MM-DD format"
            )
    return RubricResult.pass_(rid)


def check_R_CHAT_006_relative_date_computation(
    response: dict, context: dict
) -> RubricResult:
    """R-CHAT-006: relative dates ('this Sunday', '6 day trip') must be
    correctly resolved against TODAY. The context supplies
    expected_start_date / expected_end_date — we compare the submit args."""
    rid = "R-CHAT-006"
    expected_start = context.get("expected_start_date")
    expected_end = context.get("expected_end_date")
    if not (expected_start and expected_end):
        return RubricResult.skip(rid, "no expected dates in context")
    call = _find_detail_call(response, "submit_trip_form")
    if not call:
        return RubricResult.skip(rid, "submit_trip_form did not fire")
    args = call.get("args") or {}
    actual_start = args.get("start_date")
    actual_end = args.get("end_date")
    if actual_start != expected_start or actual_end != expected_end:
        return RubricResult.fail(
            rid,
            f"got start={actual_start}/end={actual_end}; "
            f"expected start={expected_start}/end={expected_end}",
        )
    return RubricResult.pass_(rid)


# ─── LLM-JUDGE rubrics ──────────────────────────────────────────────────────


_R_G_007_RULE = (
    "The reply MUST NOT narrate intermediate tool calls or work-in-progress. "
    "Examples of FAIL (narration): 'Let me search for flights now…', "
    "'Now I'll look for hotels…', 'First, I'll call the weather API.', "
    "'I found flights, now searching hotels…'. "
    "Examples of PASS (no narration): direct statements about the trip "
    "('Three days in Tokyo confirmed.'), greetings, clarifying questions "
    "('Which Tokyo airport works best?'), or short result summaries. "
    "The user wants a silent build, then a short summary — never running "
    "commentary about the process."
)


async def check_R_G_007_no_tool_narration(
    response: dict, context: dict
) -> RubricResult:
    """R-G-007: LLM-judge checks that the reply does not narrate tool calls."""
    rid = "R-G-007"
    prose = strip_json_block(response.get("reply", ""))
    if not prose:
        return RubricResult.skip(rid, "no prose to judge")
    verdict = await judge(_R_G_007_RULE, prose)
    return RubricResult(rid, verdict.get("verdict", "SKIP"), verdict.get("reason", ""))


_R_THEMES_004_RULE = (
    "Day 1's theme MUST reflect the limited afternoon time when an "
    "arrival_time is given in key_constraints (e.g. 'airport + light "
    "check-in + nearby walk'). The last day's theme MUST fit activities "
    "that end before the departure_time (e.g. 'quick local bites before "
    "flight' rather than 'full day trek'). FAIL when theme contradicts "
    "the timing constraint (e.g. 'full-day excursion' with 17:00 "
    "departure)."
)


async def check_R_THEMES_004_day_timing(
    response: dict, context: dict
) -> RubricResult:
    """R-THEMES-004: LLM-judge checks that day 1 / last-day themes
    account for arrival / departure timing constraints."""
    rid = "R-THEMES-004"
    days = (response.get("itinerary") or {}).get("days") or []
    flight_days = [
        d for d in days
        if (d.get("key_constraints") or {}).get("arrival_time")
        or (d.get("key_constraints") or {}).get("departure_time")
    ]
    if not flight_days:
        return RubricResult.skip(rid, "no flight key_constraints to judge")
    context_blob = json.dumps(
        [
            {
                "day": d.get("day"),
                "theme": d.get("theme"),
                "key_constraints": d.get("key_constraints"),
            }
            for d in flight_days
        ],
        default=str,
    )
    verdict = await judge(_R_THEMES_004_RULE, context_blob)
    return RubricResult(rid, verdict.get("verdict", "SKIP"), verdict.get("reason", ""))


def check_R_HOTELS_003_must_call_search_places(
    response: dict, context: dict
) -> RubricResult:
    """R-HOTELS-003: hotels role — if response returns hotels,
    search_places MUST have fired."""
    rid = "R-HOTELS-003"
    if context.get("call_role") != "hotels":
        return RubricResult.skip(rid, "not hotels role")
    itinerary = response.get("itinerary") or {}
    hotels = itinerary.get("hotels") or []
    if not hotels:
        return RubricResult.skip(rid, "no hotels in response")
    if "search_places" not in response.get("tool_calls_made", []):
        return RubricResult.fail(rid, "hotels returned but no search_places call")
    return RubricResult.pass_(rid)


# ─── registry ───────────────────────────────────────────────────────────────


# All rubrics, keyed by their canonical ID. eval_runner looks up by ID when
# the prompt_suite.yaml lists applicable rubrics.
RUBRICS: dict[str, Callable[[dict, dict], RubricResult]] = {
    "R-G-004": check_R_G_004_has_prose_outside_json,
    "R-G-005": check_R_G_005_no_markdown,
    "R-G-006": check_R_G_006_no_bullets,
    "R-G-015": check_R_G_015_subtitle_length_10_25_words,
    "R-REPLACE-006": check_R_REPLACE_006_description_10_to_15_words,
    "R-G-002": check_R_G_002_transport_preceded_by_directions,
    "R-G-003": check_R_G_003_weather_preceded_by_get_weather,
    "R-G-001": check_R_G_001_no_hallucinated_places,
    "R-PLAN-002": check_R_PLAN_002_country_triggers_request_input,
    "R-PLAN-003": check_R_PLAN_003_no_text_question,
    "R-PLAN-004": check_R_PLAN_004_must_call_search_flights_and_geocode,
    "R-CHAT-001": check_R_CHAT_001_no_data_fetch_tools,
    "R-CHAT-002": check_R_CHAT_002_airport_disambiguation,
    "R-CHAT-003": check_R_CHAT_003_single_airport_shortcut,
    "R-CHAT-004": check_R_CHAT_004_round_trip_requires_end_date,
    "R-CHAT-005": check_R_CHAT_005_submit_trip_form_four_fields,
    "R-CHAT-006": check_R_CHAT_006_relative_date_computation,
    "R-CHAT-008": check_R_CHAT_008_one_sentence_reply,
    "R-G-007": check_R_G_007_no_tool_narration,
    "R-THEMES-004": check_R_THEMES_004_day_timing,
    "R-HOTELS-002": check_R_HOTELS_002_hotels_near_destination,
    "R-HOTELS-003": check_R_HOTELS_003_must_call_search_places,
    "R-REPLACE-002": check_R_REPLACE_002_activity_place_id_grounded,
    "R-DAYS-012": check_R_DAYS_012_no_flight_or_hotels_re_emit,
    "R-DETAIL-006": check_R_DETAIL_006_exactly_one_day,
}


def run_rubrics(
    response: dict,
    context: dict,
    rubric_ids: list[str] | None = None,
) -> list[RubricResult]:
    """Run a set of SYNC rubrics against one response.

    If rubric_ids is None, runs every registered sync rubric (async ones
    are skipped with a clear reason so offline callers aren't surprised).
    Unknown IDs produce a SKIP result with a warning reason.
    """
    ids = rubric_ids if rubric_ids is not None else list(RUBRICS.keys())
    results: list[RubricResult] = []
    for rid in ids:
        fn = RUBRICS.get(rid)
        if fn is None:
            results.append(RubricResult.skip(rid, f"no rubric function registered for {rid}"))
            continue
        if inspect.iscoroutinefunction(fn):
            results.append(RubricResult.skip(
                rid, "async rubric — use arun_rubrics to evaluate"
            ))
            continue
        try:
            results.append(fn(response, context))
        except Exception as exc:  # noqa: BLE001 — top-level guard so one bad rubric doesn't tank the run
            results.append(RubricResult.fail(rid, f"rubric raised: {exc}"))
    return results


async def arun_rubrics(
    response: dict,
    context: dict,
    rubric_ids: list[str] | None = None,
) -> list[RubricResult]:
    """Async variant that awaits coroutine rubrics (LLM-judge) and runs
    sync ones in-line. Use this when rubric_ids may include async
    rubrics (R-G-007, R-THEMES-004, …)."""
    ids = rubric_ids if rubric_ids is not None else list(RUBRICS.keys())
    results: list[RubricResult] = []
    for rid in ids:
        fn = RUBRICS.get(rid)
        if fn is None:
            results.append(RubricResult.skip(rid, f"no rubric function registered for {rid}"))
            continue
        try:
            ret = fn(response, context)
            if inspect.iscoroutine(ret):
                ret = await ret
            results.append(ret)
        except Exception as exc:  # noqa: BLE001
            results.append(RubricResult.fail(rid, f"rubric raised: {exc}"))
    return results
