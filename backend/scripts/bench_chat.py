#!/usr/bin/env python3
"""E2E performance report — measures real user-facing latency with full waterfall.

Hits /chat/stream and produces:
  1. A human-readable waterfall table printed to stdout showing every SSE
     phase (thinking, LLM TTFT, tool_start/end, partial, done) with ms offsets
     from request receipt, bottleneck annotations, and a summary.
  2. A machine-readable JSON saved to scripts/reports/perf_<timestamp>.json
     for diff-over-time analysis.

Requires a running backend (uvicorn on :8000) and real API keys.

Usage:
    cd backend
    .venv/bin/python scripts/bench_chat.py
    .venv/bin/python scripts/bench_chat.py --runs 3
    .venv/bin/python scripts/bench_chat.py --query "Plan a 2-day trip to Paris"
    BACKEND_URL=http://localhost:8000 .venv/bin/python scripts/bench_chat.py
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
import time
from datetime import datetime
from pathlib import Path

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

BACKEND = os.getenv("BACKEND_URL", "http://localhost:8000").rstrip("/")

DEFAULT_PROMPTS = [
    "Search flights from Hong Kong to Tokyo for 2026-05-10.",
    "What flights are there from Hong Kong to Vancouver next month?",
    "Plan a 3-day trip to Tokyo from Hong Kong, starting 2026-05-01.",
]

# Thresholds for bottleneck annotation
LLM_BOTTLENECK_MS = 5_000   # LLM TTFT above this → annotate as bottleneck
TOOL_SLOW_MS = 5_000        # single tool above this → annotate slow
PARALLEL_LOW_EFFICIENCY = 0.50  # max/sum below this → warn low parallelism


# ── SSE streaming ─────────────────────────────────────────────────────────────

async def stream_events(
    client: httpx.AsyncClient,
    prompt: str,
    call_role: str | None = None,
    model: str | None = None,
) -> tuple[float, list[dict]]:
    """Stream /chat/stream and return (ttfb_local_ms, event_log).

    Each entry in event_log: {type, data, local_ms}
    data will include server-side "t" (ms from request receipt) when available.
    """
    t0 = time.perf_counter()
    ttfb_ms = None
    events: list[dict] = []

    body: dict = {"message": prompt, "history": []}
    if call_role:
        body["call_role"] = call_role
    if model:
        body["preferred_model"] = model

    async with client.stream(
        "POST",
        f"{BACKEND}/chat/stream",
        json=body,
        timeout=httpx.Timeout(connect=10.0, read=180.0, write=10.0, pool=5.0),
    ) as resp:
        resp.raise_for_status()
        pending_event_type = None
        async for line in resp.aiter_lines():
            local_ms = (time.perf_counter() - t0) * 1000
            if ttfb_ms is None:
                ttfb_ms = local_ms
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
            events.append({"type": etype, "data": data, "local_ms": local_ms})

    return ttfb_ms or 0.0, events


async def run_prompt(client: httpx.AsyncClient, prompt: str) -> dict:
    """Backward-compatible wrapper used by bench_models.py.

    Returns the old flat dict format: {ttfb_ms, first_tool_start_ms,
    first_partial_ms, done_ms, tool_calls, tool_rounds, error}.
    """
    ttfb_ms, events = await stream_events(client, prompt)
    marks: dict = {
        "ttfb_ms": ttfb_ms,
        "first_tool_start_ms": None,
        "first_partial_ms": None,
        "done_ms": None,
        "error_ms": None,
    }
    tool_calls: list[str] = []
    tool_rounds = 0
    in_round = False
    error_msg = None
    for ev in events:
        et = ev["type"]
        ms = ev["local_ms"]
        if et == "tool_start":
            if marks["first_tool_start_ms"] is None:
                marks["first_tool_start_ms"] = ms
            tool_calls.append(ev["data"].get("name", "?"))
            if not in_round:
                in_round = True
                tool_rounds += 1
        elif et == "tool_end":
            in_round = False
        elif et == "partial_itinerary":
            if marks["first_partial_ms"] is None:
                marks["first_partial_ms"] = ms
        elif et == "done":
            marks["done_ms"] = ms
        elif et == "error":
            marks["error_ms"] = ms
            error_msg = ev["data"].get("message") or str(ev["data"])
    return {**marks, "tool_calls": tool_calls, "tool_rounds": tool_rounds, "error": error_msg}


# ── Waterfall analysis ────────────────────────────────────────────────────────

def _t(event: dict) -> float:
    """Server-side ms offset from request receipt, fallback to local timing."""
    server_t = event["data"].get("t")
    return float(server_t) if server_t is not None else event["local_ms"]


def analyse(ttfb_ms: float, events: list[dict]) -> dict:
    """Post-process the event log into rounds, phases, and summary metrics."""

    # --- Group events into rounds. A new round starts at each "thinking" event.
    rounds: list[dict] = []
    current: dict | None = None

    for ev in events:
        etype = ev["type"]
        if etype == "thinking":
            if current is not None:
                rounds.append(current)
            current = {
                "thinking_t": _t(ev),
                "thinking_round": ev["data"].get("round", len(rounds)),
                "tokens": [],
                "tool_starts": [],   # list of {name, args, t}
                "tool_ends": [],     # list of {name, elapsed_ms, t}
                "partials": [],      # list of {label, t}
            }
        elif current is None:
            # Events before first thinking (e.g. model_fallback) — skip for now
            continue
        elif etype == "token":
            current["tokens"].append({"text": ev["data"].get("text", ""), "t": _t(ev)})
        elif etype == "tool_start":
            current["tool_starts"].append({
                "name": ev["data"].get("name", "?"),
                "args": ev["data"].get("args", {}),
                "t": _t(ev),
            })
        elif etype == "tool_end":
            current["tool_ends"].append({
                "name": ev["data"].get("name", "?"),
                "elapsed_ms": ev["data"].get("elapsed_ms"),
                "t": _t(ev),
            })
        elif etype == "partial_itinerary":
            label = "flight" if "flight" in ev["data"] else "hotels" if "hotels" in ev["data"] else "data"
            current["partials"].append({"label": label, "t": _t(ev)})

    if current is not None:
        rounds.append(current)

    # --- Find done event
    done_ev = next((e for e in events if e["type"] == "done"), None)
    done_t = _t(done_ev) if done_ev else None

    # --- Per-round metrics
    round_metrics: list[dict] = []
    total_llm_ms = 0.0
    total_tool_ms = 0.0  # uses max per parallel batch, not sum

    for r in rounds:
        think_t = r["thinking_t"]

        # TTFT: time from thinking to first token
        first_token_t = r["tokens"][0]["t"] if r["tokens"] else None
        ttft_ms = (first_token_t - think_t) if first_token_t is not None else None

        # LLM full duration:
        #   - If the round produced text tokens: thinking → last token (before first tool_start)
        #   - If the round produced only tool calls (no tokens): thinking → first tool_start
        #     (tool_start fires immediately after the stream closes, so this ≈ LLM stream time)
        #   - Fallback: None (e.g. request_input with 0ms tool)
        first_tool_t = r["tool_starts"][0]["t"] if r["tool_starts"] else None
        if r["tokens"]:
            if first_tool_t is not None:
                tokens_before_tools = [tk for tk in r["tokens"] if tk["t"] <= first_tool_t]
            else:
                tokens_before_tools = r["tokens"]
            last_token_t = tokens_before_tools[-1]["t"] if tokens_before_tools else first_token_t
            llm_dur_ms = (last_token_t - think_t) if last_token_t is not None else None
        elif first_tool_t is not None:
            # Tool-call-only round: LLM streamed tool args, no visible text
            last_token_t = None
            llm_dur_ms = first_tool_t - think_t
        else:
            last_token_t = None
            llm_dur_ms = None

        # Tool parallel batches: group tool_ends by proximity (same batch if
        # all their tool_starts share the same thinking interval and ran concurrently).
        # Simplest proxy: all tools in a round that were started before any tool_end.
        tool_pairs: list[dict] = []
        starts_by_name: dict[str, list] = {}
        for ts in r["tool_starts"]:
            starts_by_name.setdefault(ts["name"], []).append(ts)
        ends_used: set[int] = set()
        for i, te in enumerate(r["tool_ends"]):
            pair = {"name": te["name"], "elapsed_ms": te["elapsed_ms"], "start_t": None, "end_t": te["t"]}
            candidates = starts_by_name.get(te["name"], [])
            for s in candidates:
                if id(s) not in ends_used:
                    pair["start_t"] = s["t"]
                    ends_used.add(id(s))
                    break
            tool_pairs.append(pair)

        # Parallel efficiency: all tools in this round ran via asyncio.gather
        elapsed_values = [p["elapsed_ms"] for p in tool_pairs if p["elapsed_ms"] is not None]
        if len(elapsed_values) > 1:
            max_elapsed = max(elapsed_values)
            sum_elapsed = sum(elapsed_values)
            par_efficiency = max_elapsed / sum_elapsed
        elif len(elapsed_values) == 1:
            max_elapsed = elapsed_values[0]
            sum_elapsed = elapsed_values[0]
            par_efficiency = 1.0
        else:
            max_elapsed = 0
            sum_elapsed = 0
            par_efficiency = None

        if llm_dur_ms is not None:
            total_llm_ms += llm_dur_ms
        total_tool_ms += max_elapsed

        round_metrics.append({
            "round": r["thinking_round"],
            "thinking_t": think_t,
            "ttft_ms": ttft_ms,
            "llm_dur_ms": llm_dur_ms,
            "first_token_t": first_token_t,
            "last_token_t": last_token_t,
            "tool_pairs": tool_pairs,
            "par_efficiency": par_efficiency,
            "max_elapsed_ms": max_elapsed,
            "sum_elapsed_ms": sum_elapsed,
            "partials": r["partials"],
        })

    total_ms = done_t if done_t is not None else (events[-1]["local_ms"] if events else 0)
    overhead_ms = total_ms - total_llm_ms - total_tool_ms

    return {
        "ttfb_ms": ttfb_ms,
        "total_ms": total_ms,
        "done_t": done_t,
        "rounds": round_metrics,
        "total_llm_ms": total_llm_ms,
        "total_tool_ms": total_tool_ms,
        "overhead_ms": overhead_ms,
        "all_tools": [te["name"] for r in rounds for te in r["tool_ends"]],
    }


# ── Waterfall rendering ───────────────────────────────────────────────────────

def _fmt_t(t_ms: float | None) -> str:
    if t_ms is None:
        return "T+?"
    return f"T+{int(t_ms):>7,}"

def _fmt_ms(ms: float | None) -> str:
    if ms is None:
        return "?"
    return f"{int(ms):,}ms"

def _pct(part: float, total: float) -> str:
    if total <= 0:
        return ""
    return f"({int(part / total * 100)}%)"


def render_waterfall(prompt: str, analysis: dict) -> str:
    lines: list[str] = []
    W = 70

    lines.append("═" * W)
    lines.append("  E2E PERFORMANCE REPORT")
    lines.append(f"  Query:   {prompt[:65]}")
    lines.append(f"  Backend: {BACKEND}")
    lines.append(f"  Time:    {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    lines.append("═" * W)
    lines.append("")
    lines.append("  WATERFALL  (server-side ms offsets from request receipt)")
    lines.append("")

    ttfb = analysis["ttfb_ms"]
    lines.append(f"  {_fmt_t(0)}   POST received")
    lines.append(f"  {_fmt_t(ttfb)}   SSE connection (TTFB: {_fmt_ms(ttfb)} local)")

    for rm in analysis["rounds"]:
        rn = rm["round"] + 1

        # thinking
        lines.append(f"  {_fmt_t(rm['thinking_t'])}   thinking [round {rn}]")

        # first token / TTFT
        if rm["first_token_t"] is not None:
            flag = "  ← BOTTLENECK" if (rm["ttft_ms"] or 0) >= LLM_BOTTLENECK_MS else ""
            lines.append(
                f"  {_fmt_t(rm['first_token_t'])}   first token [round {rn}]"
                f"   LLM TTFT: {_fmt_ms(rm['ttft_ms'])}{flag}"
            )

        # tool_start / tool_end pairs
        for tp in rm["tool_pairs"]:
            em = tp["elapsed_ms"]
            flag = "  ← SLOW" if (em or 0) >= TOOL_SLOW_MS else ""
            lines.append(
                f"  {_fmt_t(tp['start_t'])}   tool_start: {tp['name']}"
            )
            lines.append(
                f"  {_fmt_t(tp['end_t'])}   tool_end:   {tp['name']}  {_fmt_ms(em)}{flag}"
            )

        # parallel efficiency note
        if rm["par_efficiency"] is not None and len(rm["tool_pairs"]) > 1:
            eff_pct = int(rm["par_efficiency"] * 100)
            warn = "  ⚠ low parallelism" if rm["par_efficiency"] < PARALLEL_LOW_EFFICIENCY else ""
            lines.append(
                f"               ↳ parallel: max={_fmt_ms(rm['max_elapsed_ms'])} / "
                f"sum={_fmt_ms(rm['sum_elapsed_ms'])} = {eff_pct}%{warn}"
            )

        # partial_itinerary
        for p in rm["partials"]:
            lines.append(f"  {_fmt_t(p['t'])}   partial_itinerary ({p['label']})")

    # done
    lines.append(f"  {_fmt_t(analysis['done_t'])}   done")
    lines.append("")
    lines.append("─" * W)

    # Summary
    total = analysis["total_ms"]
    llm = analysis["total_llm_ms"]
    tool = analysis["total_tool_ms"]
    overhead = analysis["overhead_ms"]
    all_tools = analysis["all_tools"]

    lines.append("")
    lines.append("  SUMMARY")
    lines.append(f"  Total end-to-end:   {_fmt_ms(total)}")
    lines.append(f"  LLM generation:     {_fmt_ms(llm)}  {_pct(llm, total)}  [thinking→last token, summed across rounds]")
    lines.append(f"  Tool execution:     {_fmt_ms(tool)}  {_pct(tool, total)}  [max of parallel batch per round, summed]")
    lines.append(f"  Overhead/network:   {_fmt_ms(overhead)}  {_pct(overhead, total)}")

    from collections import Counter
    tc = Counter(all_tools)
    tools_str = ", ".join(f"{k}×{v}" if v > 1 else k for k, v in tc.items())
    lines.append(f"  Rounds: {len(analysis['rounds'])} | Tools: {len(all_tools)} ({tools_str})")
    lines.append("")

    return "\n".join(lines)


# ── JSON report ───────────────────────────────────────────────────────────────

def save_report(prompt: str, analysis: dict) -> Path:
    reports_dir = Path(__file__).parent / "reports"
    reports_dir.mkdir(exist_ok=True)
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    path = reports_dir / f"perf_{ts}.json"
    report = {
        "timestamp": datetime.now().isoformat(),
        "backend": BACKEND,
        "prompt": prompt,
        "summary": {
            "ttfb_ms": analysis["ttfb_ms"],
            "total_ms": analysis["total_ms"],
            "total_llm_ms": analysis["total_llm_ms"],
            "total_tool_ms": analysis["total_tool_ms"],
            "overhead_ms": analysis["overhead_ms"],
            "tool_rounds": len(analysis["rounds"]),
            "tools_called": analysis["all_tools"],
        },
        "rounds": analysis["rounds"],
    }
    path.write_text(json.dumps(report, indent=2, default=str))
    return path


# ── Multi-run aggregation ─────────────────────────────────────────────────────

def print_aggregate(all_analyses: list[dict]) -> None:
    if len(all_analyses) < 2:
        return
    totals = [a["total_ms"] for a in all_analyses if a["total_ms"]]
    llms   = [a["total_llm_ms"] for a in all_analyses]
    tools  = [a["total_tool_ms"] for a in all_analyses]
    ttfbs  = [a["ttfb_ms"] for a in all_analyses if a["ttfb_ms"]]

    def _stats(vals: list[float]) -> str:
        if not vals:
            return "n/a"
        s = sorted(vals)
        p50 = s[len(s) // 2]
        p90 = s[int(len(s) * 0.9)]
        return f"p50={_fmt_ms(p50)}  p90={_fmt_ms(p90)}  max={_fmt_ms(max(s))}"

    print("═" * 70)
    print(f"  AGGREGATE ({len(all_analyses)} runs)")
    print(f"  Total:    {_stats(totals)}")
    print(f"  LLM:      {_stats(llms)}")
    print(f"  Tools:    {_stats(tools)}")
    print(f"  TTFB:     {_stats(ttfbs)}")
    print("═" * 70)


# ── Entry point ───────────────────────────────────────────────────────────────

async def main() -> int:
    parser = argparse.ArgumentParser(description="E2E performance report for /chat/stream")
    parser.add_argument("--query", "-q", help="Single query to benchmark (overrides default list)")
    parser.add_argument("--runs", "-n", type=int, default=1, help="Repeat each query N times")
    parser.add_argument("--call-role", help="call_role to pass to the backend (plan/hotels/days/chat)")
    parser.add_argument("--model", help="preferred_model override (e.g. gemini-3.1-pro-preview)")
    args = parser.parse_args()

    prompts = [args.query] if args.query else DEFAULT_PROMPTS
    call_role = args.call_role
    model = args.model

    # Check backend health
    async with httpx.AsyncClient(trust_env=False) as client:
        try:
            await client.get(f"{BACKEND}/health", timeout=3.0)
        except Exception as e:
            print(f"❌ backend not reachable at {BACKEND}: {e}")
            return 1

        all_analyses: list[dict] = []
        errors = 0

        for prompt in prompts:
            for run_i in range(args.runs):
                run_label = f" [run {run_i+1}/{args.runs}]" if args.runs > 1 else ""
                print(f"\n▶ {prompt[:70]}{run_label}")
                print("  streaming…", end="", flush=True)
                try:
                    ttfb_ms, events = await stream_events(client, prompt, call_role=call_role, model=model)
                except Exception as e:
                    print(f"\n  ❌ request failed: {type(e).__name__}: {e}")
                    errors += 1
                    continue

                print(" done")
                analysis = analyse(ttfb_ms, events)
                all_analyses.append(analysis)

                waterfall = render_waterfall(prompt, analysis)
                print(waterfall)

                report_path = save_report(prompt, analysis)
                print(f"  Report saved: {report_path.relative_to(Path(__file__).parent.parent)}")

        if args.runs > 1 and len(prompts) == 1:
            print()
            print_aggregate(all_analyses)

    return 1 if errors and not all_analyses else 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
