"""LLM-as-judge wrapper for rubrics that can't be checked with regex.

Used by LLM-JUDGE-category rubrics in rubrics.py. Calls a small/cheap
Gemini Flash model by default (different provider from the xAI primary,
so we're not self-grading), parses the one-line JSON verdict.

Not invoked in unit tests — each call costs ~$0.001-0.01 and adds ~1-2s
latency. Reserve for scheduled eval runs only.

Override with EVAL_JUDGE_MODEL / EVAL_JUDGE_BASE_URL / EVAL_JUDGE_API_KEY
if you want to point at OpenRouter, Anthropic, or a different Gemini model.
"""
from __future__ import annotations

import json
import logging
import os
import re

from openai import AsyncOpenAI

from app.config import GEMINI_API_KEY, GEMINI_BASE_URL

logger = logging.getLogger(__name__)


JUDGE_MODEL = os.getenv("EVAL_JUDGE_MODEL", "gemini-2.5-flash")
JUDGE_BASE_URL = os.getenv("EVAL_JUDGE_BASE_URL", GEMINI_BASE_URL)

JUDGE_SYSTEM_PROMPT = """You are a strict evaluator grading an LLM response
against a single rubric rule.

Return ONLY a JSON object on one line, no prose:
  {"verdict": "PASS" | "FAIL", "reason": "<one sentence>"}

If the rule is ambiguous or doesn't apply, return PASS with reason
"rule does not apply". Be terse; one sentence of reason max.
"""


JUDGE_USER_TEMPLATE = """Rule: {rule_text}

Response to evaluate:
---
{response_text}
---

Context:
{context_text}
"""


_VERDICT_RE = re.compile(r'\{[^{}]*"verdict"\s*:\s*"(PASS|FAIL)"[^{}]*\}', re.DOTALL)


async def judge(
    rule_text: str,
    response_text: str,
    context_text: str = "",
    model: str | None = None,
    api_key: str | None = None,
) -> dict:
    """Call the judge LLM. Returns {"verdict": ..., "reason": ...}.

    Never raises — on error (network, parse failure, etc.) returns
    {"verdict": "SKIP", "reason": "<error>"}. The eval runner treats
    SKIP as inconclusive and flags it in the report.
    """
    api_key = (
        api_key
        or os.getenv("EVAL_JUDGE_API_KEY")
        or (GEMINI_API_KEY if JUDGE_BASE_URL == GEMINI_BASE_URL else None)
        or os.getenv("OPENROUTER_API_KEY")
    )
    if not api_key:
        return {"verdict": "SKIP", "reason": "no judge API key configured"}

    client = AsyncOpenAI(base_url=JUDGE_BASE_URL, api_key=api_key)
    try:
        completion = await client.chat.completions.create(
            model=model or JUDGE_MODEL,
            messages=[
                {"role": "system", "content": JUDGE_SYSTEM_PROMPT},
                {
                    "role": "user",
                    "content": JUDGE_USER_TEMPLATE.format(
                        rule_text=rule_text,
                        response_text=response_text,
                        context_text=context_text or "(none)",
                    ),
                },
            ],
            temperature=0,
            max_tokens=200,
        )
    except Exception as exc:  # noqa: BLE001
        logger.exception("judge call failed")
        return {"verdict": "SKIP", "reason": f"judge call raised: {exc}"}

    raw = completion.choices[0].message.content or ""
    return parse_verdict(raw)


def parse_verdict(raw: str) -> dict:
    """Extract {"verdict", "reason"} from a possibly-messy LLM reply."""
    # Try direct JSON parse first.
    try:
        obj = json.loads(raw.strip())
        if obj.get("verdict") in ("PASS", "FAIL"):
            return {"verdict": obj["verdict"], "reason": obj.get("reason", "")}
    except json.JSONDecodeError:
        pass
    # Fallback: regex-scan for a verdict object anywhere in the reply.
    m = _VERDICT_RE.search(raw)
    if m:
        try:
            obj = json.loads(m.group(0))
            return {"verdict": obj["verdict"], "reason": obj.get("reason", "")}
        except json.JSONDecodeError:
            pass
    return {"verdict": "SKIP", "reason": f"could not parse judge reply: {raw[:100]!r}"}
