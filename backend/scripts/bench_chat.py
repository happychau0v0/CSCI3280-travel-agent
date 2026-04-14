#!/usr/bin/env python3
"""End-to-end chat-stream bench — measures the REAL user-facing latency.

Hits /chat/stream with a flight-search prompt and times:
  - TTFB (first SSE byte received)
  - time-to-first-tool-start event
  - time-to-first-partial-itinerary event (when flights/hotels appear)
  - time-to-done
  - total tool rounds + distinct tools called

Requires a running backend (uvicorn on :8000) and real API keys.

Usage:
    # Backend must be running:
    cd backend && .venv/bin/python scripts/bench_chat.py
    BACKEND_URL=http://localhost:8000 PROMPT="..." .venv/bin/python scripts/bench_chat.py
"""
from __future__ import annotations

import asyncio
import json
import os
import sys
import time
from collections import Counter
from pathlib import Path

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

BACKEND = os.getenv("BACKEND_URL", "http://localhost:8000").rstrip("/")

PROMPTS = os.getenv("PROMPTS")
if PROMPTS:
    PROMPT_LIST = [p.strip() for p in PROMPTS.split("|") if p.strip()]
else:
    PROMPT_LIST = [
        "Search flights from Hong Kong to Tokyo for 2026-05-10.",
        "What flights are there from Hong Kong to Vancouver next month?",
        "Plan a 3-day trip to Tokyo from Hong Kong, starting 2026-05-01.",
    ]


async def run_prompt(client: httpx.AsyncClient, prompt: str) -> dict:
    """Stream /chat/stream and record per-event timings."""
    t0 = time.perf_counter()
    marks = {
        "ttfb_ms": None,
        "first_tool_start_ms": None,
        "first_partial_ms": None,
        "done_ms": None,
        "error_ms": None,
    }
    tool_calls: list[str] = []
    tool_rounds = 0
    in_round = False
    error_msg = None

    async with client.stream(
        "POST",
        f"{BACKEND}/chat/stream",
        json={"message": prompt, "history": []},
        timeout=httpx.Timeout(connect=10.0, read=180.0, write=10.0, pool=5.0),
    ) as resp:
        resp.raise_for_status()
        pending_event_type = None
        async for line in resp.aiter_lines():
            now_ms = (time.perf_counter() - t0) * 1000
            if marks["ttfb_ms"] is None:
                marks["ttfb_ms"] = now_ms
            if line.startswith("event:"):
                pending_event_type = line[6:].strip()
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
            etype = pending_event_type or data.get("type")
            pending_event_type = None
            if not isinstance(data, dict):
                data = {}
            if etype == "tool_start":
                if marks["first_tool_start_ms"] is None:
                    marks["first_tool_start_ms"] = now_ms
                tool_calls.append(data.get("name", "?"))
                if not in_round:
                    in_round = True
                    tool_rounds += 1
            elif etype == "tool_end":
                in_round = False
            elif etype == "partial_itinerary":
                if marks["first_partial_ms"] is None:
                    marks["first_partial_ms"] = now_ms
            elif etype == "done":
                marks["done_ms"] = now_ms
            elif etype == "error":
                marks["error_ms"] = now_ms
                error_msg = data.get("message") or str(data)

    return {
        "prompt": prompt,
        **marks,
        "tool_calls": tool_calls,
        "tool_rounds": tool_rounds,
        "error": error_msg,
    }


def fmt(ms):
    return f"{int(ms):>6}ms" if ms is not None else "     —"


async def main() -> int:
    # Warm up backend is up
    async with httpx.AsyncClient(trust_env=False) as client:
        try:
            await client.get(f"{BACKEND}/health", timeout=3.0)
        except Exception as e:
            print(f"❌ backend not reachable at {BACKEND}: {e}")
            return 1

        results = []
        for p in PROMPT_LIST:
            print(f"\n▶ {p}")
            try:
                r = await run_prompt(client, p)
            except Exception as e:
                print(f"  ❌ request failed: {type(e).__name__}: {e}")
                continue
            results.append(r)
            print(f"  TTFB              {fmt(r['ttfb_ms'])}")
            print(f"  first tool_start  {fmt(r['first_tool_start_ms'])}")
            print(f"  first partial     {fmt(r['first_partial_ms'])}")
            print(f"  done              {fmt(r['done_ms'])}")
            print(f"  tool rounds       {r['tool_rounds']}")
            print(f"  tool calls ({len(r['tool_calls'])}): "
                  f"{dict(Counter(r['tool_calls']))}")
            if r["error"]:
                print(f"  ❌ error: {r['error']}")

    if not results:
        return 1

    # Aggregate
    done_times = [r["done_ms"] for r in results if r["done_ms"] is not None]
    ttfb_times = [r["ttfb_ms"] for r in results if r["ttfb_ms"] is not None]
    print("\n─── summary ───────────────────────────────")
    if done_times:
        print(f"end-to-end median: {int(sorted(done_times)[len(done_times)//2])}ms")
        print(f"end-to-end max:    {int(max(done_times))}ms")
    if ttfb_times:
        print(f"TTFB median:       {int(sorted(ttfb_times)[len(ttfb_times)//2])}ms")
    errors = sum(1 for r in results if r["error"] or r["done_ms"] is None)
    print(f"errors / total:    {errors} / {len(results)}")
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
