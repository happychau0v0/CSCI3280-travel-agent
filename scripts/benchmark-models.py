#!/usr/bin/env python3
"""Benchmark LLM models for travel agent itinerary quality.

Sends the same trip request to multiple models via OpenRouter (with
MOCK_TOOLS=1 so all tool responses are identical) and compares:
  - JSON validity (did it produce parseable itinerary JSON?)
  - Flight count (should be ≥5, copied VERBATIM from tool)
  - Hotel count (should be ≥5, copied VERBATIM from tool)
  - Activity density per day (middle days should have ≥4)
  - Time gaps (no gap >3 hours without an activity)
  - selected_hotel type (should be null or object, not string)
  - Total latency (seconds to full response)

Usage:
  # Set your OpenRouter key first:
  export OPENROUTER_API_KEY=sk-or-v1-...

  # Run from project root:
  cd backend && MOCK_TOOLS=1 python ../scripts/benchmark-models.py

  # Or test specific models:
  MOCK_TOOLS=1 python ../scripts/benchmark-models.py model1 model2
"""
from __future__ import annotations

import asyncio
import json
import os
import sys
import time

# Add backend to path so we can import app modules
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "backend"))

os.environ["MOCK_TOOLS"] = "1"

from app.config import OPENROUTER_API_KEY, check_key  # noqa: E402
from app.llm import _extract_itinerary  # noqa: E402
from app.prompts import SYSTEM_PROMPT, Itinerary  # noqa: E402
from app.tools import TOOL_DEFINITIONS, TOOL_DISPATCH  # noqa: E402

# ─── Models to benchmark ────────────────────────────────────────────────

DEFAULT_MODELS = [
    "google/gemini-3.1-pro-preview",    # Gemini 3.1 Pro — frontier reasoning
    "x-ai/grok-4.20",                   # Grok 4.20 — flagship multi-agent
    "moonshotai/kimi-k2.5",             # Kimi K2.5 — strong agentic tool-calling
]

# ─── Proxy stripping (same as llm.py fix) ───────────────────────────────

_PROXY_VARS = ("HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy",
               "ALL_PROXY", "all_proxy")

# ─── The test prompt ─────────────────────────────────────────────────────

USER_MESSAGE = (
    "Plan a 3-day trip to Tokyo from Hong Kong, "
    "departing 2026-05-15, returning 2026-05-17. "
    "2 travelers, economy class, interests: food, temples, nightlife. "
    "Use public transit."
)

MAX_TOOL_ROUNDS = 20


async def run_model(model_id: str) -> dict:
    """Run one model through the full tool-calling loop and measure quality."""
    from openai import AsyncOpenAI

    # Strip proxy vars
    saved = {k: os.environ.pop(k, None) for k in _PROXY_VARS}
    client = AsyncOpenAI(
        api_key=OPENROUTER_API_KEY,
        base_url="https://openrouter.ai/api/v1",
    )
    for k, v in saved.items():
        if v is not None:
            os.environ[k] = v

    messages = [
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "user", "content": USER_MESSAGE},
    ]

    tool_calls_made = []
    last_text = ""
    start = time.time()

    try:
        for round_idx in range(MAX_TOOL_ROUNDS):
            response = await client.chat.completions.create(
                model=model_id,
                messages=messages,
                tools=TOOL_DEFINITIONS,
                tool_choice="auto",
            )
            msg = response.choices[0].message
            last_text = msg.content or last_text

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
                tool_calls_made.append(fn_name)
                try:
                    fn_args = json.loads(tc.function.arguments or "{}")
                except json.JSONDecodeError:
                    fn_args = {}

                fn = TOOL_DISPATCH.get(fn_name)
                if fn:
                    try:
                        result = await fn(**fn_args)
                    except Exception as e:
                        result = {"error": str(e)}
                else:
                    result = {"error": f"Unknown tool: {fn_name}"}

                messages.append({
                    "role": "tool",
                    "tool_call_id": tc.id,
                    "content": json.dumps(result, default=str),
                })

        elapsed = time.time() - start
        itinerary = _extract_itinerary(last_text)

        return {
            "model": model_id,
            "elapsed_s": round(elapsed, 1),
            "tool_rounds": round_idx + 1,
            "tool_calls": len(tool_calls_made),
            "tools_used": sorted(set(tool_calls_made)),
            "has_itinerary": itinerary is not None,
            "itinerary": itinerary,
            "raw_length": len(last_text),
            "error": None,
        }

    except Exception as e:
        return {
            "model": model_id,
            "elapsed_s": round(time.time() - start, 1),
            "tool_rounds": 0,
            "tool_calls": 0,
            "error": str(e),
            "has_itinerary": False,
            "itinerary": None,
        }


def score_itinerary(result: dict) -> dict:
    """Score the itinerary quality."""
    if not result["has_itinerary"]:
        return {
            "model": result["model"],
            "elapsed_s": result.get("elapsed_s"),
            "error": result.get("error", "No itinerary produced"),
            "score": 0,
        }

    itin = result["itinerary"]
    scores = {}
    notes = []

    # 1. Pydantic validation
    try:
        parsed = Itinerary(**itin)
        scores["valid_schema"] = True
    except Exception as e:
        scores["valid_schema"] = False
        notes.append(f"Schema invalid: {e}")
        # Still try to score what we can
        parsed = None

    # 2. Flight options count (should be ≥5 from mock)
    flight_opts = len(itin.get("flight", {}).get("options", []))
    scores["flight_count"] = flight_opts
    if flight_opts < 3:
        notes.append(f"Only {flight_opts} flights (expected ≥5)")

    # 3. Hotel count (should be ≥5 from mock)
    hotel_count = len(itin.get("hotels", []))
    scores["hotel_count"] = hotel_count
    if hotel_count < 3:
        notes.append(f"Only {hotel_count} hotels (expected ≥5)")

    # 4. selected_hotel type (should be null, not string)
    sh = itin.get("selected_hotel")
    if sh is None:
        scores["selected_hotel_type"] = "null (correct)"
    elif isinstance(sh, dict):
        scores["selected_hotel_type"] = "object (acceptable)"
    elif isinstance(sh, str):
        scores["selected_hotel_type"] = "STRING (bug)"
        notes.append("selected_hotel is a string, not null/object")
    else:
        scores["selected_hotel_type"] = f"unexpected: {type(sh).__name__}"

    # 5. Day count
    days = itin.get("days", [])
    scores["day_count"] = len(days)
    if len(days) < 3:
        notes.append(f"Only {len(days)} days (expected 3)")

    # 6. Activity density per day
    day_activities = []
    for d in days:
        acts = d.get("activities", [])
        # Count non-hotel/airport activities
        real = [a for a in acts
                if not any(kw in (a.get("name", "").lower()) for kw in
                           ["airport", "hotel", "check-in", "check-out",
                            "return to", "start day"])]
        day_activities.append({
            "day": d.get("day"),
            "total": len(acts),
            "real": len(real),
        })
    scores["activities_per_day"] = day_activities

    sparse_days = [da for da in day_activities if da["real"] < 2]
    if sparse_days:
        for sd in sparse_days:
            notes.append(f"Day {sd['day']}: only {sd['real']} real activities")

    # 7. Time gaps > 3 hours
    big_gaps = []
    for d in days:
        acts = d.get("activities", [])
        for i in range(len(acts) - 1):
            t1 = acts[i].get("time", "")
            t2 = acts[i + 1].get("time", "")
            try:
                h1, m1 = map(int, t1.split(":"))
                h2, m2 = map(int, t2.split(":"))
                gap = (h2 * 60 + m2) - (h1 * 60 + m1)
                if gap > 180:
                    big_gaps.append(f"Day {d.get('day')}: {t1}→{t2} ({gap}min)")
            except (ValueError, AttributeError):
                pass
    scores["big_gaps"] = big_gaps
    if big_gaps:
        notes.append(f"{len(big_gaps)} time gaps >3h")

    # 8. Has phrasebook
    scores["has_phrasebook"] = bool(itin.get("phrasebook"))

    # 9. Has directions/transport_to_next
    has_directions = any(
        a.get("transport_to_next")
        for d in days
        for a in d.get("activities", [])
    )
    scores["has_directions"] = has_directions

    # 10. Composite score (0-100)
    total = 0
    total += 15 if scores["valid_schema"] else 0
    total += min(15, flight_opts * 3)           # up to 15 for 5+ flights
    total += min(15, hotel_count * 3)           # up to 15 for 5+ hotels
    total += 10 if len(days) >= 3 else 0
    total += 5 if sh is None else (3 if isinstance(sh, dict) else 0)
    # Activity density: up to 20 points
    avg_real = sum(da["real"] for da in day_activities) / max(len(day_activities), 1)
    total += min(20, int(avg_real * 5))
    total += 5 if not big_gaps else 0
    total += 5 if scores["has_phrasebook"] else 0
    total += 5 if has_directions else 0
    total += 5 if not notes else 0              # bonus for zero issues

    return {
        "model": result["model"],
        "elapsed_s": result.get("elapsed_s"),
        "tool_rounds": result.get("tool_rounds"),
        "tool_calls": result.get("tool_calls"),
        "score": total,
        "scores": scores,
        "notes": notes,
    }


async def main():
    if not check_key(OPENROUTER_API_KEY):
        print("❌ OPENROUTER_API_KEY not set. Add it to backend/.env or export it.")
        print("   export OPENROUTER_API_KEY=sk-or-v1-...")
        sys.exit(1)

    models = sys.argv[1:] if len(sys.argv) > 1 else DEFAULT_MODELS

    print(f"🧪 Benchmarking {len(models)} models with MOCK_TOOLS=1")
    print(f"📝 Prompt: \"{USER_MESSAGE[:60]}...\"")
    print(f"{'═' * 70}\n")

    # Run models sequentially (to avoid rate limits)
    results = []
    for model in models:
        print(f"▸ Running {model}...")
        result = await run_model(model)
        scored = score_itinerary(result)
        results.append(scored)

        if scored.get("error"):
            print(f"  ❌ ERROR: {scored['error']}")
        else:
            print(f"  ✓ Done in {scored['elapsed_s']}s — "
                  f"score {scored['score']}/100 — "
                  f"{scored.get('tool_calls', '?')} tool calls in "
                  f"{scored.get('tool_rounds', '?')} rounds")
            for note in scored.get("notes", []):
                print(f"    ⚠ {note}")
        print()

    # Summary table
    print(f"\n{'═' * 70}")
    print(f"{'MODEL':<40} {'SCORE':>6} {'TIME':>7} {'FLIGHTS':>8} "
          f"{'HOTELS':>7} {'DAYS':>5} {'GAPS':>5}")
    print(f"{'─' * 40} {'─' * 6} {'─' * 7} {'─' * 8} {'─' * 7} {'─' * 5} {'─' * 5}")

    for r in sorted(results, key=lambda x: x.get("score", 0), reverse=True):
        s = r.get("scores", {})
        print(f"{r['model']:<40} "
              f"{r.get('score', 0):>5}% "
              f"{r.get('elapsed_s', '?'):>6}s "
              f"{s.get('flight_count', '?'):>7} "
              f"{s.get('hotel_count', '?'):>6} "
              f"{s.get('day_count', '?'):>4} "
              f"{len(s.get('big_gaps', [])):>4}")

    print(f"\n{'═' * 70}")

    # Recommendation
    best = max(results, key=lambda x: x.get("score", 0))
    fastest = min(
        (r for r in results if r.get("elapsed_s") and not r.get("error")),
        key=lambda x: x["elapsed_s"],
        default=None,
    )
    print(f"\n🏆 Best quality:  {best['model']} ({best.get('score', 0)}%)")
    if fastest and fastest["model"] != best["model"]:
        print(f"⚡ Fastest:       {fastest['model']} ({fastest['elapsed_s']}s)")

    # Dump detailed results to JSON
    out_path = os.path.join(os.path.dirname(__file__), "..", "docs", "benchmark-results.json")
    with open(out_path, "w") as f:
        json.dump(results, f, indent=2, default=str)
    print(f"\n📊 Detailed results saved to benchmark-results.json")


if __name__ == "__main__":
    asyncio.run(main())
