#!/usr/bin/env python3
"""Streaming benchmark — measures progressive SSE latency.

Connects to the live /chat/stream endpoint and records client-side timestamps
for each SSE event. Computes key metrics that quantify how much earlier users
see results when partial_itinerary streaming is active.

Metrics:
  t_first_tool_ms    — LLM think time before any tool fires
  t_first_partial_ms — when first real data (flights/hotels) becomes visible
  t_done_ms          — total turn latency (baseline)
  partial_lead_ms    — time saved by streaming (t_done - t_first_partial)
  sum_tool_ms        — total tool I/O time
  llm_inference_ms   — approximate LLM-only time (t_done - sum_tool_ms)
  server_to_client_ms — SSE transport lag (needs _emitted_at in payload)

Usage:
  # Start backend in mock mode (one terminal):
  cd backend && source .venv/bin/activate
  MOCK_TOOLS=1 uvicorn app.main:app --port 8000

  # Run benchmark (another terminal):
  python scripts/benchmark-streaming.py --mock --runs 5

  # Against real backend (./scripts/dev.sh running):
  python scripts/benchmark-streaming.py --real --runs 3

  # Custom prompt:
  python scripts/benchmark-streaming.py --mock --prompt "Plan 2 days in Paris from London"
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import statistics
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

try:
    import httpx
except ImportError:
    print("ERROR: httpx not installed. Run: pip install httpx")
    sys.exit(1)


# ─── Defaults ────────────────────────────────────────────────────────────────

BASE_URL = "http://localhost:8000"
DEFAULT_PROMPT = (
    "Plan a 3-day trip to Tokyo from Hong Kong, "
    "departing 2026-05-15, returning 2026-05-17. "
    "2 travelers, economy class, interests: food, temples, nightlife."
)
REQUEST_PAYLOAD_BASE = {
    "history": [],
    "preferences": {},
    "user_location": {"city": "Hong Kong", "country": "Hong Kong", "lat": 22.3193, "lng": 114.1694},
    "trip_dates": {"start": "2026-05-15", "end": "2026-05-17"},
}
DOCS_PERF_DIR = Path(__file__).resolve().parent.parent / "docs" / "perf"


# ─── SSE parser ──────────────────────────────────────────────────────────────

def _parse_sse_line(event_buf: dict, line: str) -> dict | None:
    """
    Update the in-progress event buffer from a single SSE line.
    Returns the completed event dict when a blank line (event boundary) is hit,
    or None if more lines are expected.
    """
    if line.startswith("event:"):
        event_buf["type"] = line[6:].strip()
    elif line.startswith("data:"):
        event_buf["data"] = line[5:].strip()
    elif line == "":
        # End of event — fire if we have both type and data
        if event_buf.get("type") and event_buf.get("data"):
            completed = dict(event_buf)
            event_buf.clear()
            return completed
        event_buf.clear()
    return None


# ─── Single benchmark run ────────────────────────────────────────────────────

async def run_one(client: httpx.AsyncClient, prompt: str, base_url: str = BASE_URL) -> dict:
    """Execute one planning request and return timing metrics."""
    payload = dict(REQUEST_PAYLOAD_BASE)
    payload["message"] = prompt

    t0 = time.perf_counter()
    t0_epoch_ms = time.time() * 1000  # wall-clock epoch at request start

    timestamps: dict[str, float] = {}   # event_type → first occurrence (ms from T0)
    tool_timings: list[dict] = []        # [{name, elapsed_ms}]
    partial_events: list[dict] = []      # [{received_ms, server_at, has_flight, has_hotels}]
    error_msg: str | None = None

    event_buf: dict = {}

    try:
        async with client.stream(
            "POST",
            f"{base_url}/chat/stream",
            json=payload,
            timeout=120.0,
        ) as resp:
            if resp.status_code != 200:
                return {"error": f"HTTP {resp.status_code}"}

            async for raw_line in resp.aiter_lines():
                received_ms = (time.perf_counter() - t0) * 1000
                evt = _parse_sse_line(event_buf, raw_line)
                if evt is None:
                    continue

                etype = evt["type"]
                try:
                    edata = json.loads(evt["data"])
                except json.JSONDecodeError:
                    edata = {}

                # Record first occurrence of each event type
                if etype not in timestamps:
                    timestamps[etype] = received_ms

                if etype == "tool_end":
                    tool_timings.append({
                        "name": edata.get("name", "?"),
                        "elapsed_ms": edata.get("elapsed_ms", 0),
                    })

                elif etype == "partial_itinerary":
                    server_at = edata.get("_emitted_at")
                    partial_events.append({
                        "received_ms": received_ms,
                        "server_at": server_at,
                        "has_flight": "flight" in edata,
                        "has_hotels": "hotels" in edata,
                        "hotel_count": len(edata.get("hotels", [])),
                        "flight_options": len((edata.get("flight") or {}).get("options", [])),
                    })

                elif etype == "error":
                    error_msg = edata.get("message", "unknown error")
                    break

                elif etype == "done":
                    # done is always the last event — stop reading
                    break

    except httpx.TimeoutException:
        return {"error": "timeout after 120s"}
    except Exception as e:
        return {"error": str(e)}

    if error_msg:
        return {"error": error_msg}

    t_done = timestamps.get("done")
    if t_done is None:
        return {"error": "stream ended without 'done' event"}

    t_first_tool = timestamps.get("tool_start")
    t_first_partial = partial_events[0]["received_ms"] if partial_events else None

    sum_tool_ms = sum(t["elapsed_ms"] for t in tool_timings)

    # server→client latency: difference between client receive time and
    # server epoch, adjusted for clock offset using t0_epoch_ms.
    server_to_client_ms = None
    if partial_events and partial_events[0]["server_at"] is not None:
        server_at = partial_events[0]["server_at"]
        client_epoch_at_receive = t0_epoch_ms + partial_events[0]["received_ms"]
        server_to_client_ms = round(client_epoch_at_receive - server_at)

    return {
        "t_first_tool_ms": round(t_first_tool) if t_first_tool is not None else None,
        "t_first_partial_ms": round(t_first_partial) if t_first_partial is not None else None,
        "t_done_ms": round(t_done),
        "partial_lead_ms": round(t_done - t_first_partial) if t_first_partial is not None else None,
        "sum_tool_ms": round(sum_tool_ms),
        "llm_inference_ms": round(t_done - sum_tool_ms),
        "tool_count": len(tool_timings),
        "tools": tool_timings,
        "partial_count": len(partial_events),
        "partial_events": partial_events,
        "server_to_client_ms": server_to_client_ms,
        "error": None,
    }


# ─── Aggregate stats ─────────────────────────────────────────────────────────

def _stats(values: list[float | None]) -> dict:
    clean = [v for v in values if v is not None]
    if not clean:
        return {"mean": None, "p50": None, "p90": None, "min": None, "max": None}
    clean.sort()
    n = len(clean)
    p90_idx = min(int(n * 0.9), n - 1)
    return {
        "mean": round(statistics.mean(clean)),
        "p50": round(statistics.median(clean)),
        "p90": round(clean[p90_idx]),
        "min": round(min(clean)),
        "max": round(max(clean)),
    }


def _tool_breakdown(runs: list[dict]) -> dict[str, list[float]]:
    """Aggregate per-tool elapsed_ms across all runs."""
    by_tool: dict[str, list[float]] = {}
    for r in runs:
        for t in r.get("tools", []):
            by_tool.setdefault(t["name"], []).append(t["elapsed_ms"])
    return by_tool


# ─── Formatting ──────────────────────────────────────────────────────────────

def _bar(ms: float, max_ms: float, width: int = 20) -> str:
    if max_ms == 0:
        return ""
    filled = round((ms / max_ms) * width)
    return "█" * filled


def _fmt(v: int | None) -> str:
    if v is None:
        return "  N/A  "
    return f"{v:6,}"


def print_report(runs: list[dict], mode: str, n_runs: int) -> None:
    good = [r for r in runs if not r.get("error")]
    failed = [r for r in runs if r.get("error")]

    print()
    print(f"STREAMING BENCHMARK  ({n_runs} run{'s' if n_runs > 1 else ''} · {mode} mode"
          + (f" · {len(failed)} failed" if failed else "") + ")")
    print("═" * 64)

    if not good:
        print("ALL RUNS FAILED:")
        for r in failed:
            print(f"  {r['error']}")
        return

    metrics = [
        ("t_first_tool_ms",    "t_first_tool    "),
        ("t_first_partial_ms", "t_first_partial "),
        ("t_done_ms",          "t_done          "),
        ("partial_lead_ms",    "partial_lead    "),
        ("sum_tool_ms",        "sum_tool        "),
        ("llm_inference_ms",   "llm_inference   "),
    ]

    header = f"{'':20s}  {'mean':>7}  {'P50':>7}  {'P90':>7}  {'min':>7}  {'max':>7}"
    sep = "─" * 64
    print(header)
    print(sep)

    for key, label in metrics:
        s = _stats([r.get(key) for r in good])
        lead_marker = " ◄ key" if key == "partial_lead_ms" else ""
        print(
            f"{label}  {_fmt(s['mean'])}  {_fmt(s['p50'])}  {_fmt(s['p90'])}"
            f"  {_fmt(s['min'])}  {_fmt(s['max'])}{lead_marker}"
        )

    # Server-to-client (only show if we have values)
    s2c = [r["server_to_client_ms"] for r in good if r.get("server_to_client_ms") is not None]
    if s2c:
        s = _stats(s2c)
        print(f"{'server_to_client ':20s}  {_fmt(s['mean'])}  {_fmt(s['p50'])}  "
              f"{_fmt(s['p90'])}  {_fmt(s['min'])}  {_fmt(s['max'])}")

    print(sep)

    # Tool breakdown
    by_tool = _tool_breakdown(good)
    if by_tool:
        means = {name: round(statistics.mean(vals)) for name, vals in by_tool.items()}
        sorted_tools = sorted(means.items(), key=lambda x: -x[1])
        max_ms = sorted_tools[0][1] if sorted_tools else 1
        print("TOOL BREAKDOWN (mean elapsed_ms, slowest first):")
        for name, ms in sorted_tools:
            bar = _bar(ms, max_ms, width=18)
            print(f"  {name:<28} {ms:5,} ms  {bar}")

    # Partial events summary
    partial_counts = [r["partial_count"] for r in good]
    if any(pc > 0 for pc in partial_counts):
        avg_partials = statistics.mean(partial_counts)
        print(f"\nPartial events per run: {avg_partials:.1f} avg")
        # Show what each partial carried
        for r in good[:1]:  # show first run as example
            for i, pe in enumerate(r.get("partial_events", [])):
                typ = "flight" if pe["has_flight"] else f"{pe['hotel_count']} hotels"
                print(f"  partial[{i}]: {typ} at {pe['received_ms']:.0f}ms")
    else:
        print("\n⚠ No partial_itinerary events received — check backend has _map_partial support")

    if failed:
        print(f"\nFailed runs ({len(failed)}):")
        for r in failed:
            print(f"  {r['error']}")

    print("═" * 64)


# ─── Main ─────────────────────────────────────────────────────────────────────

async def main() -> None:
    parser = argparse.ArgumentParser(
        description="Benchmark SSE streaming latency for the travel agent backend."
    )
    mode_group = parser.add_mutually_exclusive_group()
    mode_group.add_argument(
        "--mock", action="store_true",
        help="Expect backend running with MOCK_TOOLS=1 (no API spend).",
    )
    mode_group.add_argument(
        "--real", action="store_true",
        help="Run against real backend (costs API credits).",
    )
    parser.add_argument("--runs", type=int, default=3, help="Number of iterations (default 3).")
    parser.add_argument("--prompt", default=DEFAULT_PROMPT, help="Override the trip prompt.")
    parser.add_argument(
        "--url", default=BASE_URL,
        help=f"Backend base URL (default: {BASE_URL}).",
    )
    parser.add_argument(
        "--out", default=None,
        help="Output JSON path (default: docs/perf/streaming-<timestamp>.json).",
    )
    args = parser.parse_args()

    mode = "mock" if args.mock else "real"
    if not args.mock and not args.real:
        print("NOTE: No --mock or --real flag given. Assuming --real.")
        mode = "real"

    print(f"Connecting to {args.url}  ...")
    print(f"Mode: {mode}  |  Runs: {args.runs}  |  Prompt: {args.prompt[:60]}...")

    # Quick health check
    async with httpx.AsyncClient(trust_env=False) as probe:
        try:
            r = await probe.get(f"{args.url}/health", timeout=5.0)
            if r.status_code != 200:
                print(f"WARNING: /health returned {r.status_code}")
        except Exception:
            print(f"ERROR: Cannot reach {args.url} — is the backend running?")
            sys.exit(1)

    all_runs: list[dict] = []
    async with httpx.AsyncClient(trust_env=False) as client:
        for i in range(args.runs):
            print(f"  Run {i + 1}/{args.runs} ...", end=" ", flush=True)
            result = await run_one(client, args.prompt, base_url=args.url)
            all_runs.append(result)
            if result.get("error"):
                print(f"FAILED: {result['error']}")
            else:
                print(
                    f"done  t_done={result['t_done_ms']}ms  "
                    f"partial_lead={result.get('partial_lead_ms', 'N/A')}ms"
                )

    print_report(all_runs, mode, args.runs)

    # Save JSON
    ts = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H-%M-%S")
    out_path = Path(args.out) if args.out else DOCS_PERF_DIR / f"streaming-{ts}.json"
    out_path.parent.mkdir(parents=True, exist_ok=True)

    good_runs = [r for r in all_runs if not r.get("error")]
    summary = {
        "timestamp": ts,
        "mode": mode,
        "runs": args.runs,
        "prompt": args.prompt,
        "url": args.url,
        "aggregate": {
            key: _stats([r.get(key) for r in good_runs])
            for key in (
                "t_first_tool_ms", "t_first_partial_ms", "t_done_ms",
                "partial_lead_ms", "sum_tool_ms", "llm_inference_ms",
            )
        },
        "tool_breakdown": {
            name: _stats(vals)
            for name, vals in _tool_breakdown(good_runs).items()
        },
        "raw": all_runs,
    }

    with open(out_path, "w") as f:
        json.dump(summary, f, indent=2)

    print(f"\nSaved → {out_path}")


if __name__ == "__main__":
    asyncio.run(main())
