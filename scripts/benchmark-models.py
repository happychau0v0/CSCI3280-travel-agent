#!/usr/bin/env python3
"""Thorough LLM benchmark for travel agent itinerary quality.

Runs 12 models × 6 diverse prompts × 3 runs via OpenRouter, measuring:
  - Itinerary schema validity
  - Flight/hotel count completeness
  - Day count accuracy
  - Activity density
  - Time realism (no 4am activities)
  - Scheduling gaps
  - Phrasebook & directions coverage
  - Cost-efficiency (score per dollar)
  - Variance (mean ± std over 3 runs)

Usage:
  export OPENROUTER_API_KEY=sk-or-v1-...
  cd backend && MOCK_TOOLS=1 python ../scripts/benchmark-models.py

  # Dry run (1 model, 1 prompt, 1 run):
  cd backend && MOCK_TOOLS=1 python ../scripts/benchmark-models.py \\
    --models x-ai/grok-4.20-0309-non-reasoning --prompts P1 --runs 1

  # Test Claude (was 0% via old OpenRouter key):
  cd backend && MOCK_TOOLS=1 python ../scripts/benchmark-models.py \\
    --models anthropic/claude-sonnet-4-5 --prompts P1 --runs 1
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
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
from app.prompts import SYSTEM_PROMPT, Itinerary  # noqa: E402
from app.tools import TOOL_DEFINITIONS, TOOL_DISPATCH  # noqa: E402

# ─── Models ─────────────────────────────────────────────────────────────────

# All accessed via OpenRouter — single API key.
# Exact slugs follow openrouter.ai/models naming. Verify against the site
# if any return 404/auth errors during the dry run.
MODELS = [
    "x-ai/grok-4.20",
    "x-ai/grok-4.20:thinking",
    "anthropic/claude-sonnet-4.6",
    "google/gemini-3.1-pro-preview",
    "deepseek/deepseek-v3.2",
    "deepseek/deepseek-v3.2-speciale",
    "moonshotai/kimi-k2-0905",
    "minimax/minimax-m2",
    "minimax/minimax-m2.7",
]

N_RUNS = 3

# ─── Prompts ─────────────────────────────────────────────────────────────────

# 6 prompts vary: trip duration (2/3/5 days), destination type, origin,
# traveler type, and constraints. P3 is train-only (no flight).
PROMPTS = [
    {
        "id": "P1",
        "expected_days": 3,
        "has_flight": True,
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
        "text": (
            "Plan a 5-day trip to Bali from Hong Kong, departing 2026-08-05, "
            "returning 2026-08-09. Couple, business class preferred, "
            "interests: surfing, yoga, upscale dining. Avoid chain restaurants."
        ),
    },
    {
        "id": "P5",
        "expected_days": 3,
        "has_flight": True,
        "text": (
            "Plan a 3-day trip to Seoul from Tokyo, departing 2026-09-15, "
            "returning 2026-09-17. Solo traveler, vegetarian diet, "
            "interests: K-pop, art museums, hiking. Economy class."
        ),
    },
    {
        "id": "P6",
        "expected_days": 2,
        "has_flight": True,
        "text": (
            "Plan a 2-day trip to Taipei from Hong Kong, departing 2026-07-20, "
            "returning 2026-07-21. Family of 4 (2 adults, 2 children aged 8 and 10), "
            "economy class. Interests: night markets, family-friendly attractions, dim sum."
        ),
    },
]

# ─── Cost table ──────────────────────────────────────────────────────────────

# Approximate April 2026 OpenRouter pricing ($/1M tokens)
COST_PER_1M: dict[str, dict[str, float]] = {
    "x-ai/grok-4.20":                    {"input": 2.00,  "output": 8.00},
    "x-ai/grok-4.20:thinking":           {"input": 3.00,  "output": 15.00},
    "anthropic/claude-sonnet-4.6":       {"input": 3.00,  "output": 15.00},
    "google/gemini-3.1-pro-preview":     {"input": 1.25,  "output": 5.00},
    "deepseek/deepseek-v3.2":            {"input": 0.28,  "output": 1.10},
    "deepseek/deepseek-v3.2-speciale":   {"input": 0.28,  "output": 1.10},
    "moonshotai/kimi-k2-0905":           {"input": 0.60,  "output": 2.50},
    "minimax/minimax-m2":                {"input": 0.40,  "output": 1.60},
    "minimax/minimax-m2.7":              {"input": 0.40,  "output": 1.60},
}

MAX_TOOL_ROUNDS = 20

# ─── OpenRouter client ───────────────────────────────────────────────────────

_client: AsyncOpenAI | None = None


def _get_client() -> AsyncOpenAI:
    global _client
    if _client is None:
        # IMPORTANT: Do NOT pass trust_env=False or a custom httpx client here.
        # OpenRouter calls MUST go through the system proxy (HTTP_PROXY / HTTPS_PROXY)
        # set at http://127.0.0.1:7897 — running without proxy risks account bans.
        _client = AsyncOpenAI(
            api_key=OPENROUTER_API_KEY,
            base_url="https://openrouter.ai/api/v1",
        )
    return _client


# ─── Single run ──────────────────────────────────────────────────────────────


async def run_one(model_id: str, prompt: dict, run_idx: int) -> dict:
    """Run one model on one prompt and return raw result with usage data."""
    client = _get_client()
    messages = [
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "user", "content": prompt["text"]},
    ]
    tool_calls_made: list[str] = []
    last_text = ""
    start = time.time()
    total_usage: dict[str, int] = {"prompt_tokens": 0, "completion_tokens": 0}

    try:
        for round_idx in range(MAX_TOOL_ROUNDS):
            response = await client.chat.completions.create(
                model=model_id,
                messages=messages,
                tools=TOOL_DEFINITIONS,
                tool_choice="auto",
            )
            if response.usage:
                total_usage["prompt_tokens"] += response.usage.prompt_tokens or 0
                total_usage["completion_tokens"] += response.usage.completion_tokens or 0

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
            "prompt_id": prompt["id"],
            "run_idx": run_idx,
            "elapsed_s": round(elapsed, 1),
            "tool_rounds": round_idx + 1,
            "tool_calls_made": tool_calls_made,
            "has_itinerary": itinerary is not None,
            "itinerary": itinerary,
            "usage": total_usage,
            "error": None,
        }
    except Exception as e:
        return {
            "model": model_id,
            "prompt_id": prompt["id"],
            "run_idx": run_idx,
            "elapsed_s": round(time.time() - start, 1),
            "tool_rounds": 0,
            "tool_calls_made": [],
            "has_itinerary": False,
            "itinerary": None,
            "usage": total_usage,
            "error": str(e),
        }


# ─── Scoring ─────────────────────────────────────────────────────────────────


def score_itinerary_v2(result: dict, prompt_meta: dict) -> dict:
    """Score an itinerary result. Returns result dict augmented with score/notes."""
    if not result["has_itinerary"]:
        return {
            **result,
            "score": 0,
            "notes": [result.get("error") or "No itinerary produced"],
            "day_activities": [],
            "big_gaps": [],
            "has_phrasebook": False,
            "has_directions": False,
        }

    itin = result["itinerary"]
    notes: list[str] = []
    total = 0

    # 1. Valid Pydantic schema (15pts)
    try:
        Itinerary(**itin)
        total += 15
    except Exception as e:
        notes.append(f"Schema invalid: {e}")

    # 2. Flight count (15pts) — P3 is train-only: reward correctly omitting flights
    flight_opts = len(itin.get("flight", {}).get("options", []))
    if prompt_meta["has_flight"]:
        total += min(15, flight_opts * 3)
        if flight_opts < 3:
            notes.append(f"Only {flight_opts} flights (expected ≥5)")
    else:
        if flight_opts > 0:
            notes.append(f"Train-only prompt but produced {flight_opts} flights")
        else:
            total += 15

    # 3. Hotel count (15pts)
    hotel_count = len(itin.get("hotels", []))
    total += min(15, hotel_count * 3)
    if hotel_count < 3:
        notes.append(f"Only {hotel_count} hotels (expected ≥5)")

    # 4. Day count matches expected (10pts)
    days = itin.get("days", [])
    if len(days) >= prompt_meta["expected_days"]:
        total += 10
    else:
        notes.append(f"Only {len(days)} days (expected {prompt_meta['expected_days']})")

    # 5. selected_hotel = null (5pts)
    sh = itin.get("selected_hotel")
    if sh is None:
        total += 5
    elif isinstance(sh, str):
        notes.append("selected_hotel is a string (bug)")

    # 6. Activity density (15pts)
    _BOOKEND_KEYWORDS = ("airport", "hotel", "check-in", "check-out", "return to", "start day")
    day_activities = []
    for d in days:
        acts = d.get("activities", [])
        real = [
            a for a in acts
            if not any(kw in a.get("name", "").lower() for kw in _BOOKEND_KEYWORDS)
        ]
        day_activities.append({"day": d.get("day"), "total": len(acts), "real": len(real)})
    avg_real = sum(da["real"] for da in day_activities) / max(len(day_activities), 1)
    total += min(15, int(avg_real * 5))
    for da in day_activities:
        if da["real"] < 2:
            notes.append(f"Day {da['day']}: only {da['real']} real activities")

    # 7. Time-realism check (5pts) — no activities before 08:00 or after 22:00
    def _has_unrealistic_times() -> bool:
        for day in days:
            for act in day.get("activities", []):
                t = act.get("time", "")
                try:
                    h, _ = map(int, t.split(":"))
                    if h < 8 or h > 22:
                        return True
                except (ValueError, AttributeError):
                    pass
        return False

    if not _has_unrealistic_times():
        total += 5
    else:
        notes.append("Activities scheduled outside 08:00–22:00 window")

    # 8. No time gaps >3h (5pts)
    big_gaps: list[str] = []
    for d in days:
        acts = d.get("activities", [])
        for i in range(len(acts) - 1):
            t1, t2 = acts[i].get("time", ""), acts[i + 1].get("time", "")
            try:
                h1, m1 = map(int, t1.split(":"))
                h2, m2 = map(int, t2.split(":"))
                gap = (h2 * 60 + m2) - (h1 * 60 + m1)
                if gap > 180:
                    big_gaps.append(f"Day {d.get('day')}: {t1}→{t2} ({gap}min)")
            except (ValueError, AttributeError):
                pass
    if not big_gaps:
        total += 5
    else:
        notes.append(f"{len(big_gaps)} time gaps >3h")

    # 9. Phrasebook (5pts) — skip for P3 (domestic Osaka→Kyoto trip)
    has_phrasebook = bool(itin.get("phrasebook"))
    if prompt_meta["id"] != "P3":
        if has_phrasebook:
            total += 5
        else:
            notes.append("No phrasebook")

    # 10. Directions included (5pts)
    has_directions = any(
        a.get("transport_to_next")
        for d in days
        for a in d.get("activities", [])
    )
    if has_directions:
        total += 5
    else:
        notes.append("No transport_to_next directions")

    return {
        **result,
        "score": total,
        "notes": notes,
        "day_activities": day_activities,
        "big_gaps": big_gaps,
        "has_phrasebook": has_phrasebook,
        "has_directions": has_directions,
    }


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
    header = f"{'MODEL':<{col_w}}" + "".join(f"{pid:>8}" for pid in prompt_ids) + f"{'MEAN':>8}{'$/trip':>9}{'score/$':>10}"
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
        f"# Benchmark Results — {today}",
        "",
        f"**Models tested:** {len(models)}  "
        f"**Prompts:** {len(prompts)}  "
        f"**Runs per cell:** {N_RUNS}  "
        f"**Total LLM calls:** {len(models) * len(prompts) * N_RUNS}",
        "",
        "Scores are mean ± std over 3 runs (0–100). "
        "All runs use `MOCK_TOOLS=1` (deterministic tool responses) "
        "so variance reflects LLM non-determinism, not tool variability.",
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
            f"| {short} | " + " | ".join(cells) +
            f" | **{overall}** | ${avg_cost:.4f} | {spd} |"
        )

    lines += ["", "## Per-Prompt Notes", ""]
    for p in prompts:
        lines.append(f"### {p['id']}: {p['text'][:90]}...")
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
            for n in unique_notes[:3]:
                lines.append(f"  - {n}")
        lines.append("")

    lines += [
        "## Scoring Rubric (v2)",
        "",
        "| Criterion | Points |",
        "|---|---|",
        "| Valid Pydantic schema | 15 |",
        "| Flight options ≥5 (or correctly omitted for train-only) | 15 |",
        "| Hotel count ≥5 | 15 |",
        "| Day count matches expected trip length | 10 |",
        "| selected_hotel = null | 5 |",
        "| Activity density (avg real activities/day × 5, capped 15) | 15 |",
        "| Time realism (all activities 08:00–22:00) | 5 |",
        "| No time gaps >3h | 5 |",
        "| Phrasebook included (skipped for domestic trips) | 5 |",
        "| Directions (transport_to_next) included | 5 |",
        "| **Total** | **100** |",
        "",
        "## Notes",
        "",
        "- OpenRouter model slugs may differ from display names. "
          "If a model returned errors, check exact slug at openrouter.ai/models.",
        "- Claude models tested via OpenRouter (previously 0% due to proxy "
          "tool-calling incompatibility). Results reflect whether that was fixed.",
        "- Cost estimates are approximate; actual billing may vary.",
    ]

    out_dir = os.path.join(os.path.dirname(__file__), "..", "docs")
    os.makedirs(out_dir, exist_ok=True)

    md_path = os.path.join(out_dir, f"bench-{today}.md")
    with open(md_path, "w") as f:
        f.write("\n".join(lines) + "\n")
    print(f"\nReport saved to docs/bench-{today}.md")

    json_path = os.path.join(out_dir, "benchmark-results.json")
    with open(json_path, "w") as f:
        json.dump(all_results, f, indent=2, default=str)
    print(f"Raw data saved to docs/benchmark-results.json")


# ─── Main ─────────────────────────────────────────────────────────────────────


async def main() -> None:
    parser = argparse.ArgumentParser(description="Benchmark LLM models for travel agent quality")
    parser.add_argument("--models", nargs="+", default=None, help="Model IDs to test (default: all)")
    parser.add_argument("--prompts", nargs="+", default=None, help="Prompt IDs to test, e.g. P1 P3 (default: all)")
    parser.add_argument("--runs", type=int, default=N_RUNS, help="Runs per model per prompt (default: 3)")
    parser.add_argument("--delay", type=float, default=0.5, help="Seconds between runs (default: 0.5)")
    args = parser.parse_args()

    if not check_key(OPENROUTER_API_KEY):
        print("ERROR: OPENROUTER_API_KEY not set. Add it to backend/.env or export it.")
        print("  export OPENROUTER_API_KEY=sk-or-v1-...")
        sys.exit(1)

    models = args.models or MODELS
    prompts = [p for p in PROMPTS if args.prompts is None or p["id"] in args.prompts]
    n_runs = args.runs

    total_calls = len(models) * len(prompts) * n_runs
    print(f"Benchmarking {len(models)} model(s) × {len(prompts)} prompt(s) × {n_runs} run(s) = {total_calls} calls")
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
                raw = await run_one(model_id, prompt, run_idx)
                scored = score_itinerary_v2(raw, prompt)
                runs.append(scored)
                if scored.get("error"):
                    print(f"ERROR: {scored['error'][:60]}")
                else:
                    print(f"score={scored['score']}/100  {scored.get('elapsed_s')}s  "
                          f"tools={len(scored.get('tool_calls_made', []))}")
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
