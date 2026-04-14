#!/usr/bin/env python3
"""Flight-search stress bench.

Runs search_flights against many real routes back-to-back, measures
wall time per call, and prints p50/p95/max. Catches the "hangs forever"
failure mode — any call >15s is flagged as HUNG.

Usage:
    cd backend && .venv/bin/python scripts/bench_flights.py
    # with a wall-clock cap per call (seconds, default 20):
    TIMEOUT=10 .venv/bin/python scripts/bench_flights.py
"""
from __future__ import annotations

import asyncio
import os
import statistics
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.tools import TOOL_DISPATCH  # noqa: E402

TIMEOUT = float(os.getenv("TIMEOUT", "20"))
FUTURE = (datetime.now(timezone.utc) + timedelta(days=30)).date().isoformat()

# Diverse routes — short-haul intra-Asia, long-haul trans-Pacific, classic EU.
ROUTES = [
    ("Hong Kong", "Tokyo"),
    ("Hong Kong", "Kuala Lumpur"),
    ("Hong Kong", "Bangkok"),
    ("Hong Kong", "Taipei"),
    ("Hong Kong", "Singapore"),
    ("Hong Kong", "Seoul"),
    ("Hong Kong", "Vancouver"),   # the "1-flight" regression case
    ("Hong Kong", "London"),
    ("Tokyo", "Seoul"),
    ("Singapore", "Bali"),
]


async def run_one(origin, destination):
    fn = TOOL_DISPATCH["search_flights"]
    t0 = time.perf_counter()
    try:
        result = await asyncio.wait_for(
            fn(origin=origin, destination=destination, date=FUTURE),
            timeout=TIMEOUT,
        )
        elapsed = (time.perf_counter() - t0) * 1000
        if result.get("error"):
            return (origin, destination, "❌", elapsed, result["error"])
        opts = len(result.get("options", []))
        src = result.get("source", "?")
        status = "⚠" if src == "estimator" else "✅"
        return (origin, destination, status, elapsed,
                f"{opts} options, source={src}")
    except asyncio.TimeoutError:
        elapsed = TIMEOUT * 1000
        return (origin, destination, "💀", elapsed,
                f"HUNG >{TIMEOUT:.0f}s (asyncio.wait_for tripped)")
    except Exception as e:
        elapsed = (time.perf_counter() - t0) * 1000
        return (origin, destination, "❌", elapsed,
                f"{type(e).__name__}: {e}")


async def main() -> int:
    print(f"Running {len(ROUTES)} flight searches (timeout={TIMEOUT:.0f}s each)\n")

    # Run sequentially so we measure each call in isolation (parallel
    # would mask per-call hangs behind the fastest).
    results = []
    for origin, dest in ROUTES:
        r = await run_one(origin, dest)
        results.append(r)
        o, d, s, ms, det = r
        print(f"{s} {o:<12}→ {d:<14} {int(ms):>6}ms   {det}")

    print()
    timings = [ms for _, _, _, ms, _ in results]
    counts = {"✅": 0, "⚠": 0, "❌": 0, "💀": 0}
    for _, _, s, _, _ in results:
        counts[s] = counts.get(s, 0) + 1

    n = len(timings)
    print(f"fast-flights hits:   {counts['✅']}/{n}")
    print(f"estimator fallback:  {counts['⚠']}/{n}")
    print(f"hard errors:         {counts['❌']}/{n}")
    print(f"hangs (>{int(TIMEOUT)}s):       {counts['💀']}/{n}")
    print()
    print(f"latency p50: {int(statistics.median(timings))}ms")
    if n >= 2:
        p95 = sorted(timings)[max(0, int(n * 0.95) - 1)]
        print(f"latency p95: {int(p95)}ms")
    print(f"latency max: {int(max(timings))}ms")

    return 1 if (counts["❌"] or counts["💀"]) else 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
