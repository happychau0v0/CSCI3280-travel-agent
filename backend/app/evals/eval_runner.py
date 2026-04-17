"""Eval runner — orchestrates prompt_suite.yaml → chat() → rubric scoring.

Not part of pytest. Runs separately, writes a markdown report to
docs/bench-YYYY-MM-DD.md (follows the format of the existing
docs/bench-models-*.md files).

Usage:
    cd backend && source .venv/bin/activate
    python -m app.evals.eval_runner --suite=app/evals/prompt_suite.yaml \
        --model=x-ai/grok-4.20 --out=docs/bench-$(date +%F).md

Requires:
    OPENROUTER_API_KEY in env (for chat() calls)
    XAI_API_KEY if running against xAI direct

Cost: roughly $0.50-2 per full suite run against Grok-4.20, depending
on rubric LLM-judge count.
"""
from __future__ import annotations

import argparse
import asyncio
import logging
import sys
from collections import Counter
from datetime import date, datetime
from pathlib import Path

logger = logging.getLogger(__name__)


def _load_suite(path: Path) -> list[dict]:
    """Load prompt_suite.yaml — the only external dep is PyYAML.

    If PyYAML is unavailable we fall back to an eager read; the suite
    format is simple enough that we could parse it by hand but keep the
    single PyYAML dep for readability.
    """
    import yaml  # noqa: PLC0415 — optional at runtime, required only for eval_runner

    with path.open("r") as f:
        return yaml.safe_load(f)


async def _run_one(item: dict, model: str | None) -> dict:
    """Execute one suite entry via chat(); capture response + tool trace."""
    from app.llm import chat  # late import — avoid pulling LLM stack into unit tests

    messages = [{"role": "user", "content": item["user_message"]}]
    context = item.get("context") or {}

    # Inject USER LOCATION / TODAY'S DATE via preferences + a date hint
    preferences = {}
    if context.get("user_location"):
        preferences["user_location"] = context["user_location"]

    try:
        result = await chat(
            messages=messages,
            preferences=preferences,
            call_role=item.get("call_role"),
            preferred_model=model,
        )
    except Exception as exc:  # noqa: BLE001
        logger.exception("chat() raised for %s", item["id"])
        return {
            "id": item["id"],
            "reply": "",
            "itinerary": None,
            "tool_calls_made": [],
            "tool_results": {},
            "error": str(exc),
        }

    return {
        "id": item["id"],
        "reply": result.get("reply", ""),
        "itinerary": result.get("itinerary"),
        "tool_calls_made": result.get("tool_calls_made", []),
        "tool_calls_detail": result.get("tool_calls_detail", []),
        "tool_results": result.get("tool_results", {}),
        "error": None,
    }


async def _render_report(results: list[dict], model: str) -> str:
    """Write the markdown report body; caller adds headers."""
    from app.evals.rubrics import arun_rubrics  # noqa: PLC0415

    rows: list[str] = []
    counts: Counter = Counter()

    for run in results:
        context = {**(run.get("context") or {}), "call_role": run.get("call_role")}
        rubric_ids = run.get("rubrics") or []
        rubric_results = await arun_rubrics(run, context, rubric_ids)
        for r in rubric_results:
            counts[r.verdict] += 1
            if r.verdict == "FAIL":
                rows.append(f"| {run['id']} | {r.rubric_id} | FAIL | {r.reason} |")

    total = sum(counts.values())
    pass_ = counts.get("PASS", 0)
    fail = counts.get("FAIL", 0)
    skip = counts.get("SKIP", 0)
    pass_rate = (pass_ / total * 100) if total else 0.0

    body = [
        f"# LLM Behavior Eval — {date.today().isoformat()}",
        "",
        f"Model: {model}",
        f"Prompts: {len(results)}",
        f"Total rubric checks: {total}",
        f"Pass rate: {pass_rate:.1f}% ({pass_}/{total})",
        f"Fails: {fail}",
        f"Skips: {skip}",
        "",
        "## Failures",
        "",
    ]
    if rows:
        body.append("| Prompt ID | Rubric | Verdict | Reason |")
        body.append("|---|---|---|---|")
        body.extend(rows)
    else:
        body.append("_None — clean run._")
    return "\n".join(body)


async def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description="LLM behavior eval runner")
    parser.add_argument("--suite", required=True, help="Path to prompt_suite.yaml")
    parser.add_argument("--model", default=None, help="Override LLM_MODEL env var")
    parser.add_argument(
        "--out",
        default=None,
        help="Output markdown path; defaults to docs/bench-YYYY-MM-DD.md",
    )
    args = parser.parse_args(argv)

    suite_path = Path(args.suite)
    if not suite_path.exists():
        print(f"Suite not found: {suite_path}", file=sys.stderr)
        return 1

    suite = _load_suite(suite_path)
    if not isinstance(suite, list):
        print("Suite must be a top-level YAML list", file=sys.stderr)
        return 1

    print(f"Running {len(suite)} prompts against {args.model or 'default model'}…")
    results = []
    for item in suite:
        print(f"  - {item['id']}")
        result = await _run_one(item, args.model)
        result["call_role"] = item.get("call_role")
        result["context"] = item.get("context") or {}
        result["rubrics"] = item.get("rubrics", [])
        results.append(result)

    report = await _render_report(results, args.model or "default")

    out_path = Path(args.out) if args.out else Path(
        f"docs/bench-{date.today().isoformat()}.md"
    )
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(report)
    print(f"\nReport written to {out_path}")
    print(f"Finished at {datetime.now().isoformat()}")
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main(sys.argv[1:])))
