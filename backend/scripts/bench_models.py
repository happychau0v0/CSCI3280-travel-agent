#!/usr/bin/env python3
"""Reasoning vs non-reasoning bake-off.

Restarts the backend with each LLM_MODEL in turn and runs the same
prompt set against each. Scores latency, tool-calling behavior,
accuracy (expected/forbidden tools), and itinerary completeness.
Prints a side-by-side markdown table at the end.

Usage:
    cd backend && .venv/bin/python scripts/bench_models.py
    MODELS=grok-4.20-0309-non-reasoning,grok-4.20-0309-reasoning \\
        .venv/bin/python scripts/bench_models.py
"""
from __future__ import annotations

import asyncio
import json
import os
import subprocess
import sys
import time
from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from scripts.bench_chat import run_prompt  # noqa: E402

BACKEND = "http://localhost:8000"
ROOT = Path(__file__).resolve().parent.parent.parent
RESTART_SCRIPT = ROOT / "scripts" / "restart.sh"

MODELS = (os.getenv("MODELS") or
          "grok-4.20-0309-non-reasoning,grok-4.20-0309-reasoning").split(",")

OUTER_TIMEOUT = float(os.getenv("OUTER_TIMEOUT", "90"))


@dataclass
class Case:
    label: str
    prompt: str
    expect_tools: set[str] = field(default_factory=set)   # at least these
    forbid_tools: set[str] = field(default_factory=set)   # none of these
    expect_itinerary: bool = False
    expect_partial: bool = False
    # "plan" prompts are scored on all dimensions (days, hotels, coords, descriptions).
    # "search" prompts only expect flights + phrasebook so the max meaningful score is ~25.
    prompt_type: str = "plan"


CASES = [
    Case(
        label="greeting",
        prompt="Hello how are you",
        forbid_tools={"search_places", "search_flights", "geocode_city",
                      "get_weather", "get_directions"},
    ),
    Case(
        label="weather",
        prompt="What's the weather in Tokyo?",
        expect_tools={"get_weather"},
        forbid_tools={"search_flights", "search_places"},
    ),
    Case(
        label="flight-search",
        prompt="Search flights from Hong Kong to Tokyo for 2026-05-10.",
        expect_tools={"search_flights"},
        expect_partial=True,
        prompt_type="search",  # correctly responds with flights only, not a full plan
    ),
    Case(
        label="3day-plan",
        prompt="Plan a 3-day trip to Tokyo from Hong Kong, starting 2026-05-01.",
        expect_tools={"search_flights", "geocode_city"},
        expect_itinerary=True,
        expect_partial=True,
    ),
    Case(
        label="5day-foodie",
        prompt="Plan a 5-day Bangkok trip from Hong Kong, May 1 to May 6, "
                "with a focus on street food.",
        expect_tools={"search_flights"},
        expect_itinerary=True,
        expect_partial=True,
    ),
]


# ─── itinerary scoring (best-effort fetch of done payload) ────────────


async def fetch_full_done(client: httpx.AsyncClient, prompt: str) -> dict | None:
    """Re-run the prompt to capture the full `done` payload (reply + itinerary)."""
    try:
        async with client.stream(
            "POST",
            f"{BACKEND}/chat/stream",
            json={"message": prompt, "history": [], "bench_eval": True},
            timeout=httpx.Timeout(connect=10.0, read=OUTER_TIMEOUT, write=10.0, pool=5.0),
        ) as resp:
            resp.raise_for_status()
            pending = None
            async for line in resp.aiter_lines():
                if line.startswith("event:"):
                    pending = line[6:].strip()
                    continue
                if not line.startswith("data:"):
                    continue
                raw = line[5:].strip()
                if not raw:
                    continue
                try:
                    data = json.loads(raw)
                except json.JSONDecodeError:
                    continue
                if pending == "done":
                    return data
                pending = None
    except Exception as e:
        return {"_error": f"{type(e).__name__}: {e}"}
    return None


def score_itinerary(itin: dict | None, prompt_type: str = "plan") -> tuple[int, list[str]]:
    """Return (0-100 completeness score, list of features present).

    Scoring dimensions:
      search prompts (prompt_type="search"):
        flights (≤20) + phrasebook (5) = 25 max
      plan prompts (prompt_type="plan"):
        days (≤20) + flights (≤20) + return (5) + hotels (≤15) +
        phrasebook (5) + coords (≤20) + descriptions (≤15) = 100 max
    """
    if not isinstance(itin, dict):
        return 0, []
    features = []
    score = 0

    flight = itin.get("flight") or {}
    opts = flight.get("options") or []
    if opts:
        features.append(f"{len(opts)} flights")
        score += min(20, len(opts) * 3)
    if itin.get("phrasebook"):
        features.append("phrasebook")
        score += 5

    if prompt_type == "search":
        # Flight-search prompts only reasonably include flights + phrasebook
        return min(25, score), features

    # Plan-only dimensions below
    days = itin.get("days") or []
    if days:
        features.append(f"{len(days)}d")
        score += min(20, len(days) * 5)
    if flight.get("return_options"):
        features.append("rt")
        score += 5
    hotels = itin.get("hotels") or []
    if hotels:
        features.append(f"{len(hotels)} hotels")
        score += min(15, len(hotels) * 2)

    # Activity coord coverage (≤20 pts)
    total_acts = sum(len(d.get("activities", []) or []) for d in days)
    coord_acts = sum(
        1 for d in days for a in (d.get("activities") or [])
        if a.get("lat") is not None and a.get("lng") is not None
    )
    if total_acts:
        coord_pct = int(coord_acts * 100 / total_acts)
        features.append(f"{coord_pct}% coords")
        score += coord_pct // 5

    # Activity description coverage (≤15 pts) — rewards real Places data
    desc_acts = sum(
        1 for d in days for a in (d.get("activities") or [])
        if a.get("description") and len(a["description"]) > 20
    )
    if total_acts:
        desc_pct = int(desc_acts * 100 / total_acts)
        features.append(f"{desc_pct}% descs")
        score += min(15, desc_acts * 3)

    return min(100, score), features


# ─── backend lifecycle ────────────────────────────────────────────────


def restart_backend_with_model(model: str) -> bool:
    """Stop existing backend, start a fresh one with LLM_MODEL=model."""
    print(f"\n══ restarting backend with LLM_MODEL={model} ══")
    # Kill existing
    subprocess.run(["pkill", "-9", "-f", "uvicorn app.main:app"],
                   check=False, capture_output=True)
    time.sleep(0.5)
    # Start fresh, in background, with the model env var
    log = open("/tmp/bench-backend.log", "w")
    env = os.environ.copy()
    env["LLM_MODEL"] = model
    # Strip proxy so xAI calls go direct (matches restart.sh)
    for k in ("HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy",
              "ALL_PROXY", "all_proxy"):
        env.pop(k, None)
    proc = subprocess.Popen(
        [".venv/bin/uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"],
        cwd=str(Path(__file__).resolve().parent.parent),
        env=env,
        stdout=log, stderr=subprocess.STDOUT,
        start_new_session=True,
    )
    # Wait for /health
    for _ in range(30):
        time.sleep(0.5)
        try:
            r = httpx.get(f"{BACKEND}/health", timeout=2.0)
            if r.status_code == 200:
                print(f"  ✅ backend up (PID {proc.pid})")
                return True
        except Exception:
            pass
    print("  ❌ backend failed to start within 15s")
    return False


# ─── per-model run ────────────────────────────────────────────────────


async def run_model(model: str) -> list[dict]:
    """Run all CASES against one model. Returns per-case result dicts."""
    if not restart_backend_with_model(model):
        return [{"case": c.label, "error": "backend start failed"} for c in CASES]

    out = []
    async with httpx.AsyncClient(trust_env=False) as client:
        for case in CASES:
            print(f"\n  ▶ {case.label}: {case.prompt}")
            try:
                # Outer wall-clock guard so a single hang doesn't poison the run.
                r = await asyncio.wait_for(
                    run_prompt(client, case.prompt),
                    timeout=OUTER_TIMEOUT,
                )
            except asyncio.TimeoutError:
                print(f"    💀 outer timeout >{OUTER_TIMEOUT:.0f}s")
                out.append({"case": case.label, "model": model,
                            "error": f"outer-timeout-{int(OUTER_TIMEOUT)}s"})
                continue
            except Exception as e:
                out.append({"case": case.label, "model": model,
                            "error": f"{type(e).__name__}: {e}"})
                continue

            # Score
            tool_set = set(r.get("tool_calls") or [])
            missing = case.expect_tools - tool_set
            forbidden_hit = case.forbid_tools & tool_set
            saw_partial = r.get("first_partial_ms") is not None
            partial_ok = (saw_partial == case.expect_partial) or \
                         (case.expect_partial and saw_partial)

            # Re-run to capture the done payload (reply + itinerary)
            done_payload = await fetch_full_done(client, case.prompt)
            itin = (done_payload or {}).get("itinerary")
            reply_text = (done_payload or {}).get("reply", "") or ""
            itin_score, features = score_itinerary(itin, prompt_type=case.prompt_type)

            itin_ok = case.expect_itinerary == bool(itin)
            accuracy_pass = (not missing) and (not forbidden_hit) and itin_ok and partial_ok

            row = {
                "case": case.label,
                "model": model,
                "prompt_type": case.prompt_type,
                **{k: r.get(k) for k in ("ttfb_ms", "first_tool_start_ms",
                                          "first_partial_ms", "done_ms",
                                          "tool_rounds")},
                "tool_count": len(r.get("tool_calls") or []),
                "tool_breakdown": dict(Counter(r.get("tool_calls") or [])),
                "missing_tools": sorted(missing),
                "forbidden_tools_hit": sorted(forbidden_hit),
                "expected_itinerary": case.expect_itinerary,
                "got_itinerary": bool(itin),
                "itin_score": itin_score,
                "itin_features": features,
                "reply_words": len(reply_text.split()),
                "reply_preview": reply_text[:120],
                "accuracy_pass": accuracy_pass,
            }
            out.append(row)
            print(f"    done={r['done_ms']:.0f}ms  tools={row['tool_count']} "
                  f"({row['tool_rounds']} rounds)  itin={itin_score} "
                  f"{'✅' if accuracy_pass else '⚠'}")

    return out


# ─── reporting ────────────────────────────────────────────────────────


def fmt_ms(v):
    return f"{int(v):>5}ms" if isinstance(v, (int, float)) else "    —"


def print_table(all_results: dict[str, list[dict]]):
    models = list(all_results.keys())
    print("\n\n══ RESULTS ══\n")
    # Per-case rows
    for case in CASES:
        print(f"### {case.label}\n")
        print("| metric | " + " | ".join(models) + " |")
        print("|" + "---|" * (len(models) + 1))
        # Build per-model lookup
        per_model = {m: next((r for r in all_results[m] if r.get("case") == case.label), {})
                     for m in models}
        for metric, key, fmt in [
            ("done", "done_ms", fmt_ms),
            ("first partial", "first_partial_ms", fmt_ms),
            ("tool rounds", "tool_rounds", lambda v: str(v) if v is not None else "—"),
            ("tool count", "tool_count", lambda v: str(v) if v is not None else "—"),
            ("itin score", "itin_score", lambda v: f"{v}/100" if isinstance(v, int) else "—"),
            ("itin features", "itin_features",
                lambda v: ", ".join(v) if isinstance(v, list) and v else "—"),
            ("missing tools", "missing_tools",
                lambda v: ", ".join(v) if v else "—"),
            ("forbidden hit", "forbidden_tools_hit",
                lambda v: ", ".join(v) if v else "—"),
            ("reply words", "reply_words", lambda v: str(v) if v is not None else "—"),
            ("accuracy", "accuracy_pass",
                lambda v: "✅" if v else ("⚠" if v is False else "—")),
        ]:
            cells = [fmt(per_model[m].get(key)) for m in models]
            print(f"| {metric} | " + " | ".join(cells) + " |")
        print()
        for m in models:
            preview = per_model[m].get("reply_preview", "")
            err = per_model[m].get("error")
            tag = err if err else preview
            print(f"  - **{m}**: {tag}")
        print()

    # Aggregate row
    print("### aggregate\n")
    print("| metric | " + " | ".join(models) + " |")
    print("|" + "---|" * (len(models) + 1))
    for metric, fn in [
        ("total wall-clock",
         lambda rows: f"{sum(r.get('done_ms', 0) or 0 for r in rows) / 1000:.1f}s"),
        ("total tool calls",
         lambda rows: str(sum(r.get("tool_count", 0) or 0 for r in rows))),
        ("accuracy passes",
         lambda rows: f"{sum(1 for r in rows if r.get('accuracy_pass'))}/{len(rows)}"),
        ("avg itin score (plan prompts)",
         lambda rows: (
             f"{sum(r.get('itin_score', 0) or 0 for r in rows if r.get('prompt_type') == 'plan' and r.get('expected_itinerary')) // max(1, sum(1 for r in rows if r.get('prompt_type') == 'plan' and r.get('expected_itinerary')))}"
             if any(r.get("prompt_type") == "plan" and r.get("expected_itinerary") for r in rows) else "—")),
        ("errors",
         lambda rows: str(sum(1 for r in rows if r.get("error")))),
    ]:
        cells = [fn(all_results[m]) for m in models]
        print(f"| {metric} | " + " | ".join(cells) + " |")


# ─── main ─────────────────────────────────────────────────────────────


async def main() -> int:
    print(f"Bake-off: {' vs '.join(MODELS)}")
    print(f"{len(CASES)} prompts per model, outer timeout {OUTER_TIMEOUT:.0f}s")
    all_results = {}
    for model in MODELS:
        all_results[model] = await run_model(model)

    print_table(all_results)

    # Restore default model on the way out
    print("\n══ restoring default model ══")
    restart_backend_with_model(MODELS[0])

    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
