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

import re
from dataclasses import dataclass
from typing import Callable


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
    "R-PLAN-002": check_R_PLAN_002_country_triggers_request_input,
    "R-PLAN-003": check_R_PLAN_003_no_text_question,
    "R-PLAN-004": check_R_PLAN_004_must_call_search_flights_and_geocode,
    "R-CHAT-001": check_R_CHAT_001_no_data_fetch_tools,
    "R-CHAT-008": check_R_CHAT_008_one_sentence_reply,
    "R-HOTELS-003": check_R_HOTELS_003_must_call_search_places,
    "R-DAYS-012": check_R_DAYS_012_no_flight_or_hotels_re_emit,
    "R-DETAIL-006": check_R_DETAIL_006_exactly_one_day,
}


def run_rubrics(
    response: dict,
    context: dict,
    rubric_ids: list[str] | None = None,
) -> list[RubricResult]:
    """Run a set of rubrics against one response.

    If rubric_ids is None, runs every registered rubric (useful for triage).
    Unknown IDs produce a SKIP result with a warning reason.
    """
    ids = rubric_ids if rubric_ids is not None else list(RUBRICS.keys())
    results: list[RubricResult] = []
    for rid in ids:
        fn = RUBRICS.get(rid)
        if fn is None:
            results.append(RubricResult.skip(rid, f"no rubric function registered for {rid}"))
            continue
        try:
            results.append(fn(response, context))
        except Exception as exc:  # noqa: BLE001 — top-level guard so one bad rubric doesn't tank the run
            results.append(RubricResult.fail(rid, f"rubric raised: {exc}"))
    return results
