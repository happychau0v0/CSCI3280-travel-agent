"""LLM behavior evaluation harness.

Closes the behavioral GAPs in docs/llm-spec.md §7 that cannot be asserted
with unit tests — rules that only the LLM can choose to obey
(no-hallucination, no-markdown-in-reply, relative-date computation, etc.).

Architecture:
    prompt_suite.yaml  → eval_runner.py  → chat() → reply
                                               │
                                               └→ rubrics.py → pass/fail

Regex-based rubrics are deterministic; LLM-judge rubrics call a small
model (Haiku / Gemini Flash) to score responses against a rubric.

Not run in CI — cost and flakiness make this a manual/scheduled job.
Results land in docs/bench-YYYY-MM-DD.md (see docs/bench-models-2026-04-14.md
for the reference format).
"""
