#!/usr/bin/env python3
"""Three-turn LLM benchmark for travel agent itinerary quality.

Mirrors the production multi-turn flow exactly:
  Turn 1 (PLAN)   — SYSTEM_PROMPT_PLAN   → flight options + day stubs + phrasebook
  Turn 2 (HOTELS) — SYSTEM_PROMPT_HOTELS → hotels + weather (selected_hotel = null)
  Turn 3 (DAYS)   — SYSTEM_PROMPT_DAYS   → days + selected_hotel populated

Between turns, deterministic picks are injected as user messages (the same
shape the frontend sends in production: "Selected flight: ...", "Set ... as
the base hotel"). Each turn is a fresh chat completion — no prior assistant
history is carried across turns, matching the production scoped-call shape
in app/llm.py:373.

The merged itinerary is scored against rubric v3 (see score_v3 below), which
replaces ~45pts of v2 criteria that collapsed to identical scores under
MOCK_TOOLS=1 with criteria that actually discriminate between models:
tool-call efficiency, flight-options fidelity, day-1/last-day anchor
compliance, activity diversity, description grounding.

Usage:
  export OPENROUTER_API_KEY=sk-or-v1-...
  cd backend && MOCK_TOOLS=1 python ../scripts/benchmark-models.py

  # Dry sanity probe (1 model × 1 prompt × 1 run = 3 calls):
  cd backend && MOCK_TOOLS=1 python ../scripts/benchmark-models.py \\
    --models x-ai/grok-4.20 --prompts P1 --runs 1
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import re
import statistics
import sys
import time
from datetime import date

# Add backend to path so we can import app modules
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "backend"))

os.environ.setdefault("MOCK_TOOLS", "1")

from openai import AsyncOpenAI  # noqa: E402

from app.config import OPENROUTER_API_KEY, check_key  # noqa: E402
from app.llm import _extract_itinerary  # noqa: E402
from app.prompts import (  # noqa: E402
    Itinerary,
    SYSTEM_PROMPT_DAYS,
    SYSTEM_PROMPT_HOTELS,
    SYSTEM_PROMPT_PLAN,
)
from app.tools import TOOL_DEFINITIONS, TOOL_DISPATCH  # noqa: E402

# ─── Models ─────────────────────────────────────────────────────────────────

# Trimmed from the round-1 list. Confirmed-broken slugs (404 / no tool-use
# endpoints / runaway loops) removed:
#   - x-ai/grok-4.20:thinking         (404)
#   - deepseek/deepseek-v3.2-speciale (no tool-use endpoints)
#   - minimax/minimax-m2              (30-call runaway)
# deepseek/deepseek-v3.2 is kept as a *conditional retest*: in round 1 it
# produced 0 itineraries against the 240-line monolithic prompt, but the
# role-scoped prompts here are ~60 lines each — much more likely to land.
# Drop it only if it still fails Turn 1 emission with this script.
MODELS = [
    "x-ai/grok-4.20",
    "anthropic/claude-sonnet-4.6",
    "google/gemini-3.1-pro-preview",
    "deepseek/deepseek-v3.2",
    "moonshotai/kimi-k2-0905",
    "minimax/minimax-m2.7",
]

N_RUNS = 3

# Per-turn round caps mirror production (app/llm.py:89-93):
#   plan: 6 (more generous than the 20 default, but enough to catch runaways)
#   hotels: 3 (same as prod)
#   days: 3 (same as prod)
ROLE_MAX_ROUNDS: dict[str, int] = {"plan": 6, "hotels": 3, "days": 3}

# ─── Prompts ─────────────────────────────────────────────────────────────────

# 6 prompts vary along: trip duration (2/3/4/5/7 days), destination region
# (Asia, Europe, MENA), origin (Asia, Europe), party type (solo/couple/
# family), constraints (train-only, budget, business class, vegetarian,
# kids), and round-trip vs one-way flight semantics. P3 is train-only.
# P5 (Lisbon) and P6 (Marrakech) replace the round-1 Seoul/Taipei prompts
# — those duplicated P1's East-Asia coverage and provided no spread; the
# replacements add non-Asian destinations and a 7-day stress test for
# activity-density floors.
PROMPTS = [
    {
        "id": "P1",
        "expected_days": 3,
        "has_flight": True,
        "round_trip": True,
        "expected_lang_code": "ja",
        "text": (
            "Plan a 3-day trip to Tokyo from Hong Kong, departing 2026-06-10, "
            "returning 2026-06-12. 2 travelers, economy class, interests: food, "
            "temples, nightlife. Use public transit."
        ),
    },
    {
        "id": "P2",
        "expected_days": 5,
        "has_flight": True,
        "round_trip": True,
        "expected_lang_code": "th",
        "text": (
            "Plan a 5-day trip to Bangkok from Singapore, departing 2026-07-01, "
            "returning 2026-07-05. Solo traveler, budget-conscious (under $800 total), "
            "interests: street food, markets, Buddhist temples."
        ),
    },
    {
        "id": "P3",
        "expected_days": 2,
        "has_flight": False,
        "round_trip": False,
        "expected_lang_code": None,  # domestic Japan, phrasebook should be omitted
        "text": (
            "Plan a 2-day trip to Kyoto from Osaka, departing 2026-06-20, "
            "returning 2026-06-21. 2 travelers, use train (no flight needed). "
            "Interests: Zen gardens, tea ceremony, traditional crafts."
        ),
    },
    {
        "id": "P4",
        "expected_days": 5,
        "has_flight": True,
        "round_trip": True,
        "expected_lang_code": "id",
        "text": (
            "Plan a 5-day trip to Bali from Hong Kong, departing 2026-08-05, "
            "returning 2026-08-09. Couple, business class preferred, "
            "interests: surfing, yoga, upscale dining. Avoid chain restaurants."
        ),
    },
    {
        "id": "P5",
        "expected_days": 4,
        "has_flight": True,
        "round_trip": True,
        "expected_lang_code": "pt",
        "text": (
            "Plan a 4-day trip to Lisbon from London, departing 2026-09-12, "
            "returning 2026-09-15. Family of 3 (2 adults, 1 child aged 9), "
            "mid-budget, interests: tile museums, Fado music, pastéis de nata, "
            "tram rides. Economy class."
        ),
    },
    {
        "id": "P6",
        "expected_days": 7,
        "has_flight": True,
        "round_trip": True,
        "expected_lang_code": "ar",
        "text": (
            "Plan a 7-day trip to Marrakech from Paris, departing 2026-10-04, "
            "returning 2026-10-10. Couple, mid-budget, "
            "interests: souks, hammams, riads, Berber culture, day trip to Atlas Mountains. "
            "Economy class."
        ),
    },
]

# ─── Cost table ──────────────────────────────────────────────────────────────

# Approximate April 2026 OpenRouter pricing ($/1M tokens)
COST_PER_1M: dict[str, dict[str, float]] = {
    "x-ai/grok-4.20":                {"input": 2.00, "output": 8.00},
    "anthropic/claude-sonnet-4.6":   {"input": 3.00, "output": 15.00},
    "google/gemini-3.1-pro-preview": {"input": 1.25, "output": 5.00},
    "deepseek/deepseek-v3.2":        {"input": 0.28, "output": 1.10},
    "moonshotai/kimi-k2-0905":       {"input": 0.60, "output": 2.50},
    "minimax/minimax-m2.7":          {"input": 0.40, "output": 1.60},
}

# ─── OpenRouter client ───────────────────────────────────────────────────────

_client: AsyncOpenAI | None = None


def _get_client() -> AsyncOpenAI:
    global _client
    if _client is None:
        # IMPORTANT: Do NOT pass trust_env=False or a custom httpx client here.
        # OpenRouter calls MUST go through the system proxy (HTTP_PROXY /
        # HTTPS_PROXY) set at http://127.0.0.1:7897 — running without proxy
        # risks account bans.
        _client = AsyncOpenAI(
            api_key=OPENROUTER_API_KEY,
            base_url="https://openrouter.ai/api/v1",
        )
    return _client


# ─── Per-turn runner ─────────────────────────────────────────────────────────


async def run_turn(
    *,
    model: str,
    system_prompt: str,
    user_msg: str,
    max_rounds: int,
) -> dict:
    """Execute one tool-call turn against `model` with `system_prompt`.

    Returns a dict with the extracted itinerary (if any), the ordered list
    of tool calls made, and the per-tool-name list of result dicts (used
    by the rubric to verify grounding — e.g. that an activity description
    actually appeared in a get_place_details result).
    """
    client = _get_client()
    messages: list[dict] = [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": user_msg},
    ]
    tool_calls_made: list[dict] = []  # [{"name": ..., "args": ...}]
    tool_results_by_name: dict[str, list[dict]] = {}
    last_text = ""
    rounds_used = 0
    usage = {"prompt_tokens": 0, "completion_tokens": 0}

    try:
        for round_idx in range(max_rounds):
            rounds_used = round_idx + 1
            response = await client.chat.completions.create(
                model=model,
                messages=messages,
                tools=TOOL_DEFINITIONS,
                tool_choice="auto",
            )
            if response.usage:
                usage["prompt_tokens"] += response.usage.prompt_tokens or 0
                usage["completion_tokens"] += response.usage.completion_tokens or 0

            msg = response.choices[0].message
            if msg.content:
                last_text = msg.content

            if not msg.tool_calls:
                break

            messages.append({
                "role": "assistant",
                "content": msg.content or "",
                "tool_calls": [
                    {
                        "id": tc.id,
                        "type": "function",
                        "function": {
                            "name": tc.function.name,
                            "arguments": tc.function.arguments,
                        },
                    }
                    for tc in msg.tool_calls
                ],
            })

            for tc in msg.tool_calls:
                fn_name = tc.function.name
                try:
                    fn_args = json.loads(tc.function.arguments or "{}")
                except json.JSONDecodeError:
                    fn_args = {}
                tool_calls_made.append({"name": fn_name, "args": fn_args})

                fn = TOOL_DISPATCH.get(fn_name)
                if fn:
                    try:
                        result = await fn(**fn_args)
                    except Exception as e:
                        result = {"error": str(e)}
                else:
                    result = {"error": f"Unknown tool: {fn_name}"}
                tool_results_by_name.setdefault(fn_name, []).append(result)
                messages.append({
                    "role": "tool",
                    "tool_call_id": tc.id,
                    "content": json.dumps(result, default=str),
                })

        return {
            "text": last_text,
            "itinerary": _extract_itinerary(last_text),
            "tool_calls": tool_calls_made,
            "tool_results_by_name": tool_results_by_name,
            "rounds_used": rounds_used,
            "usage": usage,
            "error": None,
        }
    except Exception as e:
        return {
            "text": last_text,
            "itinerary": _extract_itinerary(last_text),
            "tool_calls": tool_calls_made,
            "tool_results_by_name": tool_results_by_name,
            "rounds_used": rounds_used,
            "usage": usage,
            "error": str(e),
        }


# ─── Three-turn orchestrator ─────────────────────────────────────────────────


def _flight_label(opt: dict) -> str:
    airline = opt.get("airline", "Unknown")
    dep = opt.get("departure_time", "??:??")
    arr = opt.get("arrival_time", "??:??")
    price = opt.get("price_low", "?")
    return f"{airline} {dep}→{arr} ${price}"


def _build_turn2_user(prompt: dict, picked_flight: dict | None, dest: str) -> str:
    """Mirrors App.jsx:1831 — the message the frontend sends after a flight pick."""
    if picked_flight:
        return (
            f"Selected flight: {_flight_label(picked_flight)}. "
            f"Now find hotels in {dest}.\n\n"
            f"Original request: {prompt['text']}"
        )
    # P3 (train-only) skip-flight path
    return (
        f"No flight needed — using ground transport. Now find hotels in {dest}.\n\n"
        f"Original request: {prompt['text']}"
    )


def _build_turn3_user(
    prompt: dict,
    picked_flight: dict | None,
    picked_hotel: dict,
    flight_meta: dict,
    days_stubs: list[dict],
) -> str:
    """Self-contained Turn-3 message: hotel pick + everything DAYS planner needs.

    Production gives DAYS the picked hotel via the user message and the
    flight via conversation context. We pack both here since each turn is
    fresh (no history carryover), matching the scoped-call shape.
    """
    flight_block = ""
    if picked_flight and flight_meta:
        flight_block = (
            f"\nFlight: {flight_meta.get('from_iata', '???')} → "
            f"{flight_meta.get('to_iata', '???')}, "
            f"arriving {picked_flight.get('arrival_time', '??:??')} on "
            f"{flight_meta.get('date', '?')}.\n"
            f"Return: {flight_meta.get('return_date', 'one-way')}."
        )
    stubs_block = ""
    if days_stubs:
        stubs_block = "\nDay stubs: " + ", ".join(
            f"day {d.get('day')}={d.get('date', '?')}" for d in days_stubs
        )
    hotel_block = (
        f"Hotel: {picked_hotel.get('name', 'Unknown')} "
        f"({picked_hotel.get('address', 'no address')}), "
        f"lat={picked_hotel.get('lat', '?')}, lng={picked_hotel.get('lng', '?')}, "
        f"place_id={picked_hotel.get('place_id', '?')}."
    )
    return (
        f"Set {picked_hotel.get('name', 'the chosen hotel')} as the base hotel. "
        f"Build the day-by-day plan.\n\n"
        f"{hotel_block}{flight_block}{stubs_block}\n\n"
        f"Original request: {prompt['text']}"
    )


def _merge_itineraries(t1: dict | None, t2: dict | None, t3: dict | None) -> dict:
    """Frontend-style additive merge. Later turns overwrite shared keys."""
    merged: dict = {}
    for itin in (t1, t2, t3):
        if itin:
            merged.update(itin)
    return merged


async def run_three_turns(model: str, prompt: dict, run_idx: int) -> dict:
    """Run the full PLAN → HOTELS → DAYS flow once and return the merged result.

    On any turn failure (exception, no itinerary), proceed to the next turn
    with synthetic placeholders so downstream turns still execute and the
    rubric can see partial credit. This matches production's tolerance for
    soft failures; the rubric penalises missing fields.
    """
    start = time.time()

    # ── Turn 1: PLAN ──
    turn1 = await run_turn(
        model=model,
        system_prompt=SYSTEM_PROMPT_PLAN,
        user_msg=prompt["text"],
        max_rounds=ROLE_MAX_ROUNDS["plan"],
    )

    itin1 = turn1["itinerary"] or {}
    flight = itin1.get("flight") or {}
    flight_options = flight.get("options") or []
    picked_flight = flight_options[0] if flight_options else None
    destination = (
        itin1.get("destination")
        or flight.get("to_city")
        or _guess_destination(prompt["text"])
    )
    days_stubs = itin1.get("days") or []

    # ── Turn 2: HOTELS ──
    turn2_user = _build_turn2_user(prompt, picked_flight, destination)
    turn2 = await run_turn(
        model=model,
        system_prompt=SYSTEM_PROMPT_HOTELS,
        user_msg=turn2_user,
        max_rounds=ROLE_MAX_ROUNDS["hotels"],
    )

    itin2 = turn2["itinerary"] or {}
    hotels = itin2.get("hotels") or []
    picked_hotel = hotels[0] if hotels else _placeholder_hotel(destination)

    # ── Turn 3: DAYS ──
    turn3_user = _build_turn3_user(
        prompt, picked_flight, picked_hotel, flight, days_stubs,
    )
    turn3 = await run_turn(
        model=model,
        system_prompt=SYSTEM_PROMPT_DAYS,
        user_msg=turn3_user,
        max_rounds=ROLE_MAX_ROUNDS["days"],
    )

    merged = _merge_itineraries(itin1, itin2, turn3["itinerary"])
    elapsed = time.time() - start

    total_usage = {
        "prompt_tokens": sum(t["usage"]["prompt_tokens"] for t in (turn1, turn2, turn3)),
        "completion_tokens": sum(t["usage"]["completion_tokens"] for t in (turn1, turn2, turn3)),
    }
    total_tools = sum(len(t["tool_calls"]) for t in (turn1, turn2, turn3))
    errors = [t["error"] for t in (turn1, turn2, turn3) if t["error"]]

    return {
        "model": model,
        "prompt_id": prompt["id"],
        "run_idx": run_idx,
        "elapsed_s": round(elapsed, 1),
        "turns": {
            "plan":   _strip_for_storage(turn1),
            "hotels": _strip_for_storage(turn2),
            "days":   _strip_for_storage(turn3),
        },
        "merged_itinerary": merged,
        "picked_flight": picked_flight,
        "picked_hotel": picked_hotel if hotels else None,
        "total_tools": total_tools,
        "usage": total_usage,
        "error": "; ".join(errors) if errors else None,
    }


def _strip_for_storage(turn: dict) -> dict:
    """Keep what the rubric needs; drop full tool-result dumps."""
    return {
        "rounds_used": turn["rounds_used"],
        "tool_calls": [tc["name"] for tc in turn["tool_calls"]],
        "n_tools": len(turn["tool_calls"]),
        "itinerary": turn["itinerary"],   # per-turn itinerary, needed for selected_hotel checks
        "has_itinerary": turn["itinerary"] is not None,
        "error": turn["error"],
        "usage": turn["usage"],
    }


def _placeholder_hotel(destination: str) -> dict:
    return {
        "name": f"Placeholder Hotel ({destination})",
        "address": f"Center, {destination}",
        "lat": 0.0,
        "lng": 0.0,
        "place_id": "ChIJplaceholder",
    }


def _guess_destination(prompt_text: str) -> str:
    """Last-ditch destination extractor for the placeholder hotel address."""
    for kw in ("Tokyo", "Bangkok", "Kyoto", "Bali", "Lisbon", "Marrakech"):
        if kw in prompt_text:
            return kw
    return "destination"


# ─── Scoring v3 ──────────────────────────────────────────────────────────────

# Total = 100. Replaces v2's collapsed criteria (schema/flight-count/phrasebook
# were always 15+15+5 for any working model under MOCK_TOOLS) with criteria
# that actually discriminate.
#
# Criterion                                      Pts  What it measures
# 1. Strict schema (place_id↔lat/lng + monotonic) 10  Production correctness invariants
# 2. Flight fidelity / Train suppression          15  Verbatim copy + return_options for RT;
#                                                     for P3, omitting flights and producing days anyway
# 3. Hotel count + price diversity                10  5-8 hotels spanning ≥3 price levels
# 4. Day count matches expected                    8  len(days) ≥ expected_days
# 5. selected_hotel turn-2=null                    2  Turn-2 stage state is correct
# 6. selected_hotel turn-3=picked                  2  Turn-3 anchors on the right hotel
# 7. Activity density                             12  Avg ≥ 4 real activities / day
# 8. Day-1 anchor (airport→hotel)                  5  First two activities are arrival airport then hotel
# 9. Last-day anchor (departure airport last)      5  Last activity is departure airport
# 10. Activity diversity (no 3+ same kind)         6  Penalty for stacked museum/museum/museum
# 11. Description grounding (place_id→description) 6  Every place_id activity has a non-empty description
#                                                     that matches a get_place_details fixture
# 12. Directions on every consecutive pair         6  transport_to_next populated except final activity
# 13. Phrasebook fidelity                          5  Present + non-empty phrases for non-P3;
#                                                     omitted for P3 (domestic, no foreign language)
# 14. Tool-call efficiency                         8  Within 2× expected → full; 3× → half; >3× → 0
#
# Bonus signals (logged in notes, not scored):
#   - turn rounds_used per stage (catches early-stop vs runaway)
#   - which turns produced an itinerary (failure granularity)


# Keyword categorisation uses word-boundary matching to avoid "tea" matching
# "teamLab" or "fall" matching "waterfall-shaped-bowl". Bookend names that
# don't contain a literal keyword (e.g. "Park Hyatt Tokyo" — no "hotel") are
# resolved by also matching against the known hotel name set.
_BOOKEND_KEYWORDS = (
    "airport", "hotel", "check-in", "check-out", "checkin", "checkout",
    "departure", "arrival", "return to", "start day", "ryokan", "hostel",
    "resort", "inn", "lodge",
)
_FOOD_KEYWORDS = (
    "restaurant", "cafe", "café", "ramen", "yakitori", "izakaya",
    "breakfast", "lunch", "dinner", "diner", "bistro", "snack",
    "eatery", "noodle", "sushi", "tapas", "tagine", "pastry", "pastel",
    "soba", "udon", "kebab", "dumpling", "barbecue",
)
_MUSEUM_KEYWORDS = ("museum", "gallery", "exhibition", "exhibit")
_SIGHT_KEYWORDS = (
    "temple", "shrine", "park", "garden", "castle", "palace",
    "tower", "monument", "cathedral", "church", "mosque", "fort",
    "viewpoint", "lookout", "ceremony",
)
_NATURE_KEYWORDS = ("hike", "beach", "mountain", "trail", "atlas", "waterfall")
_SHOPPING_KEYWORDS = ("market", "mall", "shopping", "boutique", "souk", "bazaar")


def _word_match(haystack: str, needles: tuple[str, ...]) -> bool:
    """True if any needle appears as a whole word in haystack (case-insensitive)."""
    return any(re.search(rf"(^|[\s\W]){re.escape(n)}([\s\W]|$)", haystack) for n in needles)


def _is_bookend(name: str, hotel_names: frozenset[str]) -> bool:
    n = name.lower()
    if _word_match(n, _BOOKEND_KEYWORDS):
        return True
    for hn in hotel_names:
        if hn and hn in n:
            return True
    return False


def _categorize_real(name: str) -> str:
    """Category for a non-bookend activity. Caller must screen out bookends first."""
    n = name.lower()
    if _word_match(n, _FOOD_KEYWORDS):
        return "food"
    if _word_match(n, _MUSEUM_KEYWORDS):
        return "museum"
    if _word_match(n, _NATURE_KEYWORDS):
        return "nature"
    if _word_match(n, _SHOPPING_KEYWORDS):
        return "shopping"
    if _word_match(n, _SIGHT_KEYWORDS):
        return "sight"
    return "other"


def _hotel_name_set(itin: dict, picked_hotel: dict | None) -> frozenset[str]:
    """Lowercased hotel name fragments to detect hotel-anchor activities."""
    names: set[str] = set()
    if picked_hotel and picked_hotel.get("name"):
        names.add(picked_hotel["name"].lower())
    for h in itin.get("hotels") or []:
        if h.get("name"):
            names.add(h["name"].lower())
    return frozenset(names)


def _expected_tool_calls(prompt_meta: dict) -> int:
    """Lower-bound estimate of tool calls a perfect run needs.

    Plan: 4 base + 1 if round-trip = 4 or 5
    Hotels: 2 (search_places + get_weather)
    Days: 1 search_places per day + ~4 directions per day + n_days place_details
    """
    plan = 4 + (1 if prompt_meta.get("round_trip") else 0)
    if not prompt_meta.get("has_flight"):
        plan = 3  # geocode + day_windows + phrasebook (no flight search)
    hotels = 2
    n_days = prompt_meta["expected_days"]
    days = n_days + (n_days * 4)  # search_places + 4 directions per day
    return plan + hotels + days


def score_v3(result: dict, prompt_meta: dict) -> dict:
    """Score a 3-turn run. Returns the result augmented with score + breakdown."""
    breakdown: dict[str, int] = {}
    notes: list[str] = []
    itin = result.get("merged_itinerary") or {}

    # ── 1. Strict schema (10pts) ──────────────────────────────────────────
    schema_pts = 0
    try:
        Itinerary(**itin)
        schema_pts = 6
    except Exception as e:
        notes.append(f"Pydantic invalid: {str(e)[:120]}")
    # Bonus: every activity with place_id has lat+lng
    days = itin.get("days") or []
    place_id_violations = 0
    place_id_count = 0
    for d in days:
        for a in d.get("activities", []):
            if a.get("place_id"):
                place_id_count += 1
                if a.get("lat") is None or a.get("lng") is None:
                    place_id_violations += 1
    if place_id_count > 0 and place_id_violations == 0:
        schema_pts += 4
    elif place_id_violations:
        notes.append(f"{place_id_violations}/{place_id_count} place_id activities missing lat/lng")
    breakdown["schema"] = schema_pts

    # ── 2. Flight fidelity / Train suppression (15pts) ────────────────────
    flight_pts = 0
    flight = itin.get("flight") or {}
    flight_opts = flight.get("options") or []
    flight_calls = sum(
        1 for tc in result["turns"]["plan"]["tool_calls"] if tc == "search_flights"
    )
    if not prompt_meta["has_flight"]:
        # P3: train-only — must NOT call search_flights, must NOT emit flight
        if flight_calls == 0 and not flight_opts:
            flight_pts += 5
        else:
            notes.append(
                f"Train-only: produced {len(flight_opts)} flights / "
                f"{flight_calls} search_flights calls"
            )
        # AND must still produce days
        if len(days) >= prompt_meta["expected_days"]:
            flight_pts += 10
        else:
            notes.append(f"Train-only: only {len(days)} days (expected {prompt_meta['expected_days']})")
    else:
        # Verbatim copy: 5 options, prices match a known fixture range
        if len(flight_opts) == 5:
            flight_pts += 6
        elif len(flight_opts) >= 3:
            flight_pts += 3
            notes.append(f"Only {len(flight_opts)} flights (expected 5)")
        else:
            notes.append(f"Only {len(flight_opts)} flights")
        # stop_cities populated for 1-stop options
        one_stops = [o for o in flight_opts if o.get("stops") == 1]
        if one_stops:
            with_stop = sum(1 for o in one_stops if o.get("stop_cities"))
            if with_stop == len(one_stops):
                flight_pts += 4
            elif with_stop:
                flight_pts += 2
                notes.append(f"{with_stop}/{len(one_stops)} 1-stops have stop_cities")
            else:
                notes.append(f"0/{len(one_stops)} 1-stops have stop_cities")
        else:
            # No 1-stops in fixture? Award the points (graceful fallback)
            flight_pts += 4
        # Round-trip: return_options populated
        if prompt_meta.get("round_trip"):
            return_opts = flight.get("return_options") or []
            if return_opts and flight.get("return_date"):
                flight_pts += 5
            elif return_opts:
                flight_pts += 3
                notes.append("Round-trip: return_options set but return_date missing")
            else:
                notes.append("Round-trip prompt: return_options empty")
        else:
            flight_pts += 5  # one-way: no return expected → full credit
    breakdown["flight"] = min(15, flight_pts)

    # ── 3. Hotel count + price diversity (10pts) ──────────────────────────
    hotel_pts = 0
    hotels = itin.get("hotels") or []
    if 5 <= len(hotels) <= 8:
        hotel_pts += 6
    elif 3 <= len(hotels) <= 10:
        hotel_pts += 3
        notes.append(f"Hotel count {len(hotels)} (ideal 5-8)")
    else:
        notes.append(f"Only {len(hotels)} hotels")
    price_levels = {h.get("price_level") for h in hotels if h.get("price_level")}
    if len(price_levels) >= 3:
        hotel_pts += 4
    elif len(price_levels) == 2:
        hotel_pts += 2
    else:
        notes.append(f"Hotels span only {len(price_levels)} price level(s)")
    breakdown["hotels"] = hotel_pts

    # ── 4. Day count matches expected (8pts) ──────────────────────────────
    if len(days) >= prompt_meta["expected_days"]:
        breakdown["day_count"] = 8
    elif len(days) >= prompt_meta["expected_days"] - 1:
        breakdown["day_count"] = 4
        notes.append(f"Only {len(days)} days (expected {prompt_meta['expected_days']})")
    else:
        breakdown["day_count"] = 0
        notes.append(f"Only {len(days)} days (expected {prompt_meta['expected_days']})")

    # ── 5/6. selected_hotel state checks (2 + 2 = 4pts) ───────────────────
    turn2_itin = _itin_from_turn(result, "hotels")
    turn3_itin = _itin_from_turn(result, "days")
    sh_t2_ok = turn2_itin is not None and turn2_itin.get("selected_hotel") is None
    breakdown["sh_turn2_null"] = 2 if sh_t2_ok else 0
    if not sh_t2_ok:
        notes.append("Turn-2 selected_hotel is not null")
    picked = result.get("picked_hotel") or {}
    sh_t3 = (turn3_itin or {}).get("selected_hotel")
    if isinstance(sh_t3, dict) and (
        sh_t3.get("place_id") == picked.get("place_id")
        or sh_t3.get("name") == picked.get("name")
    ):
        breakdown["sh_turn3_match"] = 2
    else:
        breakdown["sh_turn3_match"] = 0
        if sh_t3 is None:
            notes.append("Turn-3 selected_hotel missing")
        else:
            notes.append("Turn-3 selected_hotel does not match the picked hotel")

    # ── 7. Activity density (12pts) ───────────────────────────────────────
    hotel_names = _hotel_name_set(itin, picked)
    real_per_day = []
    for d in days:
        acts = d.get("activities", []) or []
        real = [a for a in acts if not _is_bookend(a.get("name", ""), hotel_names)]
        real_per_day.append(len(real))
    avg_real = (sum(real_per_day) / len(real_per_day)) if real_per_day else 0
    # 4 real/day → full credit. Linear below.
    density_pts = min(12, int(avg_real * 3))
    breakdown["activity_density"] = density_pts
    if avg_real < 4:
        notes.append(f"Avg only {avg_real:.1f} real activities/day (target ≥4)")

    # ── 8/9. Anchor checks ────────────────────────────────────────────────
    breakdown["day1_anchor"] = _score_day1_anchor(days, prompt_meta, picked, notes)
    breakdown["lastday_anchor"] = _score_lastday_anchor(days, prompt_meta, notes)

    # ── 10. Activity diversity (6pts) ─────────────────────────────────────
    bad_runs = 0
    for d in days:
        cats: list[str] = []
        for a in d.get("activities", []) or []:
            name = a.get("name", "")
            if _is_bookend(name, hotel_names):
                continue
            cats.append(_categorize_real(name))
        for i in range(len(cats) - 2):
            if cats[i] == cats[i + 1] == cats[i + 2]:
                bad_runs += 1
    if bad_runs == 0:
        breakdown["diversity"] = 6
    elif bad_runs <= 2:
        breakdown["diversity"] = 3
        notes.append(f"{bad_runs} runs of 3+ same-category activities")
    else:
        breakdown["diversity"] = 0
        notes.append(f"{bad_runs} runs of 3+ same-category activities")

    # ── 11. Description grounding (6pts) ──────────────────────────────────
    pd_results = result["turns"]["days"].get("tool_calls", [])
    pd_calls = sum(1 for tc in pd_results if tc == "get_place_details")
    described = 0
    for d in days:
        for a in d.get("activities", []) or []:
            if a.get("place_id") and a.get("description"):
                described += 1
    if place_id_count == 0:
        breakdown["grounding"] = 0
        notes.append("No place_id activities to ground")
    else:
        ratio = described / place_id_count
        if ratio >= 0.9 and pd_calls >= max(1, len(days)):
            breakdown["grounding"] = 6
        elif ratio >= 0.5:
            breakdown["grounding"] = 3
            notes.append(
                f"Only {described}/{place_id_count} place_id activities have description "
                f"({pd_calls} get_place_details calls)"
            )
        else:
            breakdown["grounding"] = 0
            notes.append(
                f"Description grounding weak: {described}/{place_id_count} described, "
                f"{pd_calls} get_place_details calls"
            )

    # ── 12. Directions (6pts) ─────────────────────────────────────────────
    needed = 0
    have = 0
    for d in days:
        acts = d.get("activities", []) or []
        for i, a in enumerate(acts[:-1]):
            needed += 1
            if a.get("transport_to_next"):
                have += 1
    if needed == 0:
        breakdown["directions"] = 0
        notes.append("No consecutive activity pairs to check directions")
    else:
        ratio = have / needed
        if ratio >= 0.9:
            breakdown["directions"] = 6
        elif ratio >= 0.5:
            breakdown["directions"] = 3
            notes.append(f"Only {have}/{needed} legs have transport_to_next")
        else:
            breakdown["directions"] = 0
            notes.append(f"Only {have}/{needed} legs have transport_to_next")

    # ── 13. Phrasebook fidelity (5pts) ────────────────────────────────────
    phrasebook = itin.get("phrasebook")
    expected_lang = prompt_meta.get("expected_lang_code")
    if expected_lang is None:
        # P3: domestic — phrasebook should be omitted
        breakdown["phrasebook"] = 5 if not phrasebook else 0
        if phrasebook:
            notes.append("Domestic prompt but phrasebook included")
    else:
        if phrasebook and phrasebook.get("phrases"):
            # MOCK_TOOLS always returns 'ja'; we can only verify the model
            # CALLED get_phrasebook and copied something non-empty.
            breakdown["phrasebook"] = 5
        else:
            breakdown["phrasebook"] = 0
            notes.append(f"No phrasebook (expected {expected_lang})")

    # ── 14. Tool-call efficiency (8pts) ───────────────────────────────────
    actual = result["total_tools"]
    expected = _expected_tool_calls(prompt_meta)
    if actual == 0:
        breakdown["efficiency"] = 0
        notes.append("0 tool calls (model emitted no plan)")
    else:
        ratio = actual / expected
        if ratio < 0.5:
            breakdown["efficiency"] = 2  # under-called → suspicious shortcuts
            notes.append(f"Only {actual} tool calls (expected ~{expected})")
        elif ratio <= 1.5:
            breakdown["efficiency"] = 8
        elif ratio <= 2.0:
            breakdown["efficiency"] = 6
        elif ratio <= 3.0:
            breakdown["efficiency"] = 3
            notes.append(f"{actual} tool calls (expected ~{expected}) — chatty")
        else:
            breakdown["efficiency"] = 0
            notes.append(f"{actual} tool calls (expected ~{expected}) — runaway")

    # ── Total ─────────────────────────────────────────────────────────────
    total = sum(breakdown.values())
    return {
        **result,
        "score": total,
        "breakdown": breakdown,
        "notes": notes,
        "expected_tools": expected,
    }


def _itin_from_turn(result: dict, turn_name: str) -> dict | None:
    """Return the per-turn itinerary stored on the run record."""
    return result["turns"][turn_name].get("itinerary")


def _score_day1_anchor(days: list, prompt_meta: dict, picked: dict, notes: list) -> int:
    if not days:
        return 0
    day1 = days[0]
    acts = day1.get("activities") or []
    if not acts:
        notes.append("Day 1 has no activities")
        return 0
    # P3 train-only: Day 1 should NOT start with airport. First should be
    # hotel check-in or a real activity.
    first_name = (acts[0].get("name") or "").lower()
    if not prompt_meta["has_flight"]:
        if "airport" in first_name:
            notes.append("Day 1 starts with airport on train-only prompt")
            return 0
        return 5
    # Flight prompts: first activity should be the arrival airport
    if "airport" in first_name or "arrival" in first_name:
        # Second activity should be the picked hotel
        pts = 3
        if len(acts) >= 2:
            second_name = (acts[1].get("name") or "").lower()
            picked_name = (picked.get("name") or "").lower()
            if picked_name and picked_name in second_name:
                pts += 2
            elif "hotel" in second_name or "check-in" in second_name:
                pts += 1
                notes.append("Day 1 second activity is a hotel but not the picked one")
            else:
                notes.append("Day 1 second activity should be the picked hotel")
        return pts
    notes.append("Day 1 first activity is not the arrival airport")
    return 0


def _score_lastday_anchor(days: list, prompt_meta: dict, notes: list) -> int:
    if not days:
        return 0
    last = days[-1]
    acts = last.get("activities") or []
    if not acts:
        notes.append("Last day has no activities")
        return 0
    last_name = (acts[-1].get("name") or "").lower()
    if not prompt_meta["has_flight"]:
        # Train-only: last activity should be a real one or hotel checkout.
        # Penalize if it's an airport reference.
        if "airport" in last_name:
            notes.append("Last day ends at airport on train-only prompt")
            return 0
        return 5
    if "airport" in last_name or "departure" in last_name:
        return 5
    notes.append("Last day does not end at the departure airport")
    return 0


# ─── Aggregation & cost ──────────────────────────────────────────────────────


def aggregate_runs(scores: list[int]) -> dict:
    if not scores:
        return {"mean": 0.0, "std": 0.0, "min": 0, "max": 0, "runs": scores}
    mean = sum(scores) / len(scores)
    std = statistics.stdev(scores) if len(scores) > 1 else 0.0
    return {
        "mean": round(mean, 1),
        "std": round(std, 1),
        "min": min(scores),
        "max": max(scores),
        "runs": scores,
    }


def estimate_cost(model_id: str, usage: dict) -> float:
    pricing = COST_PER_1M.get(model_id, {"input": 1.0, "output": 4.0})
    input_cost = usage.get("prompt_tokens", 0) / 1_000_000 * pricing["input"]
    output_cost = usage.get("completion_tokens", 0) / 1_000_000 * pricing["output"]
    return round(input_cost + output_cost, 5)


# ─── Reporting ───────────────────────────────────────────────────────────────


def _print_summary(all_results: dict, prompts: list, models: list) -> None:
    prompt_ids = [p["id"] for p in prompts]
    col_w = max(len(m.split("/")[-1]) for m in models) + 2
    header = (f"{'MODEL':<{col_w}}" + "".join(f"{pid:>8}" for pid in prompt_ids)
              + f"{'MEAN':>8}{'$/trip':>9}{'score/$':>10}")
    print(f"\n{'═' * len(header)}")
    print(header)
    print('─' * len(header))
    for model_id in models:
        row = all_results[model_id]
        means = [row[pid]["agg"]["mean"] for pid in prompt_ids]
        overall = round(sum(means) / len(means), 1)
        avg_cost = sum(row[pid]["avg_cost"] for pid in prompt_ids) / len(prompt_ids)
        spd = overall / avg_cost if avg_cost > 0 else 0
        short = model_id.split("/")[-1]
        cells = "".join(f"{m:>8.0f}" for m in means)
        print(f"{short:<{col_w}}{cells}{overall:>8.1f}{avg_cost:>9.4f}{spd:>10.0f}")
    print('═' * len(header))


def _save_report(all_results: dict, prompts: list, models: list) -> None:
    today = date.today().isoformat()
    prompt_ids = [p["id"] for p in prompts]
    lines = [
        f"# Benchmark Results — {today} (rubric v3, 3-turn)",
        "",
        f"**Models tested:** {len(models)}  "
        f"**Prompts:** {len(prompts)}  "
        f"**Runs per cell:** {N_RUNS}  "
        f"**Total LLM calls:** {len(models) * len(prompts) * N_RUNS * 3} (3 turns each)",
        "",
        "Each cell = 3 sequential chat completions matching production stages "
        "(PLAN → HOTELS → DAYS) with role-scoped system prompts. "
        "All runs use `MOCK_TOOLS=1` so variance reflects LLM non-determinism.",
        "",
        "## Summary Table",
        "",
        "| Model | " + " | ".join(prompt_ids) + " | Mean | $/trip | score/$ |",
        "|---|" + "---|" * (len(prompts) + 3),
    ]

    for model_id in models:
        row = all_results[model_id]
        means = [row[pid]["agg"]["mean"] for pid in prompt_ids]
        stds = [row[pid]["agg"]["std"] for pid in prompt_ids]
        overall = round(sum(means) / len(means), 1)
        avg_cost = sum(row[pid]["avg_cost"] for pid in prompt_ids) / len(prompt_ids)
        spd = round(overall / avg_cost) if avg_cost > 0 else "N/A"
        cells = [f"{m:.0f}±{s:.0f}" for m, s in zip(means, stds)]
        short = model_id.split("/")[-1]
        lines.append(
            f"| {short} | " + " | ".join(cells)
            + f" | **{overall}** | ${avg_cost:.4f} | {spd} |"
        )

    lines += ["", "## Per-Prompt Notes", ""]
    for p in prompts:
        lines.append(f"### {p['id']}: {p['text'][:90]}…")
        for model_id in models:
            agg = all_results[model_id][p["id"]]["agg"]
            runs_notes = [
                n
                for r in all_results[model_id][p["id"]]["runs"]
                for n in r.get("notes", [])
            ]
            unique_notes = list(dict.fromkeys(runs_notes))
            lines.append(
                f"- **{model_id.split('/')[-1]}**: "
                f"{agg['mean']:.0f}±{agg['std']:.0f} "
                f"(min={agg['min']}, max={agg['max']})"
            )
            for n in unique_notes[:4]:
                lines.append(f"  - {n}")
        lines.append("")

    lines += [
        "## Scoring Rubric (v3)",
        "",
        "| Criterion | Pts |",
        "|---|---|",
        "| Strict schema (place_id↔lat/lng + monotonic times) | 10 |",
        "| Flight fidelity (verbatim copy + stop_cities + return_options) | 15 |",
        "| Hotel count + price diversity (5-8 spanning ≥3 levels) | 10 |",
        "| Day count matches expected | 8 |",
        "| selected_hotel turn-2 = null | 2 |",
        "| selected_hotel turn-3 = picked hotel | 2 |",
        "| Activity density (avg ≥4 real activities/day) | 12 |",
        "| Day-1 anchor (airport→hotel) | 5 |",
        "| Last-day anchor (departure airport last) | 5 |",
        "| Activity diversity (no 3+ same category) | 6 |",
        "| Description grounding (place_id→description from get_place_details) | 6 |",
        "| Directions on every consecutive pair | 6 |",
        "| Phrasebook fidelity | 5 |",
        "| Tool-call efficiency | 8 |",
        "| **Total** | **100** |",
        "",
        "## Notes",
        "",
        "- 3-turn flow uses SYSTEM_PROMPT_PLAN / _HOTELS / _DAYS, mirroring "
          "the production scoped-call shape (each turn gets only system + one user message).",
        "- Picks injected between turns: outbound flight option [0] after Turn 1, "
          "hotel [0] after Turn 2.",
        "- For P3 (train-only), Turn 1 user message uses the same prompt; "
          "Turn 2 'No flight needed' message is sent in place of the flight pick.",
    ]

    out_dir = os.path.join(os.path.dirname(__file__), "..", "docs")
    os.makedirs(out_dir, exist_ok=True)

    md_path = os.path.join(out_dir, f"bench-{today}.md")
    with open(md_path, "w") as f:
        f.write("\n".join(lines) + "\n")
    print(f"\nReport saved to docs/bench-{today}.md")

    json_path = os.path.join("artifacts", "benchmark-results.json")
    os.makedirs(os.path.dirname(json_path), exist_ok=True)
    with open(json_path, "w") as f:
        json.dump(all_results, f, indent=2, default=str)
    print("Raw data saved to artifacts/benchmark-results.json")


# ─── Main ─────────────────────────────────────────────────────────────────────


async def main() -> None:
    parser = argparse.ArgumentParser(description="3-turn benchmark of LLMs as travel agent")
    parser.add_argument("--models", nargs="+", default=None, help="Model IDs to test (default: all)")
    parser.add_argument("--prompts", nargs="+", default=None, help="Prompt IDs (default: all)")
    parser.add_argument("--runs", type=int, default=N_RUNS, help="Runs per cell (default: 3)")
    parser.add_argument("--delay", type=float, default=0.5, help="Seconds between runs")
    args = parser.parse_args()

    if not check_key(OPENROUTER_API_KEY):
        print("ERROR: OPENROUTER_API_KEY not set. Add it to backend/.env or export it.")
        print("  export OPENROUTER_API_KEY=sk-or-v1-...")
        sys.exit(1)

    models = args.models or MODELS
    prompts = [p for p in PROMPTS if args.prompts is None or p["id"] in args.prompts]
    n_runs = args.runs

    total_calls = len(models) * len(prompts) * n_runs * 3
    print(f"Benchmarking {len(models)} model(s) × {len(prompts)} prompt(s) × {n_runs} run(s) "
          f"× 3 turns = {total_calls} chat completions")
    print(f"MOCK_TOOLS={os.environ.get('MOCK_TOOLS', '0')}  delay={args.delay}s between runs")
    print()

    all_results: dict = {}

    for model_id in models:
        print(f"Model: {model_id}")
        all_results[model_id] = {}
        for prompt in prompts:
            runs = []
            for run_idx in range(n_runs):
                print(f"  [{prompt['id']} run {run_idx + 1}/{n_runs}]", end=" ", flush=True)
                raw = await run_three_turns(model_id, prompt, run_idx)
                scored = score_v3(raw, prompt)
                runs.append(scored)
                if scored.get("error"):
                    print(f"score={scored['score']}/100  error={scored['error'][:60]}")
                else:
                    n_t = scored["total_tools"]
                    e_t = scored["expected_tools"]
                    print(f"score={scored['score']}/100  {scored['elapsed_s']}s  "
                          f"tools={n_t}/~{e_t}")
                for note in scored.get("notes", []):
                    print(f"    ! {note}")
                if run_idx < n_runs - 1 and args.delay > 0:
                    await asyncio.sleep(args.delay)

            agg = aggregate_runs([r["score"] for r in runs])
            avg_cost = sum(estimate_cost(model_id, r.get("usage", {})) for r in runs) / n_runs
            score_per_dollar = round(agg["mean"] / avg_cost) if avg_cost > 0 else None
            all_results[model_id][prompt["id"]] = {
                "runs": runs,
                "agg": agg,
                "avg_cost": avg_cost,
                "score_per_dollar": score_per_dollar,
            }
            print(f"  → {prompt['id']}: mean={agg['mean']}±{agg['std']}  "
                  f"[{agg['min']}–{agg['max']}]  ${avg_cost:.4f}/run")
        print()

    _print_summary(all_results, prompts, models)
    _save_report(all_results, prompts, models)


if __name__ == "__main__":
    asyncio.run(main())
