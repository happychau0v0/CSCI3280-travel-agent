"""LLM orchestrator: OpenRouter via OpenAI SDK with tool-calling loop.

Architecture (matches the TA brief's "Brain → Hands → Interface" diagram):

    user message ─► chat() ─► OpenAI SDK pointed at OpenRouter
                       ▲                  │
                       │                  ▼
                       │           model response
                       │                  │
                       │       has tool calls? ─── no ─► return reply
                       │                  │
                       │                  yes
                       │                  │
                       │           dispatch each tool
                       │           via TOOL_DISPATCH
                       │                  │
                       └─── feed results ─┘
                            back to model

The loop repeats up to MAX_TOOL_ROUNDS times, after which we return
whatever text we have. The system prompt (see prompts.py) instructs the
model to embed structured itineraries as ```json blocks; we extract them
with a brace-balancing parser at the end.
"""
from __future__ import annotations

import json
import logging
import re

from openai import AsyncOpenAI

from app.config import LLM_MODEL, OPENROUTER_API_KEY, OPENROUTER_BASE_URL, check_key
from app.prompts import SYSTEM_PROMPT
from app.tools import TOOL_DEFINITIONS, TOOL_DISPATCH, ToolUnavailableError

logger = logging.getLogger(__name__)

# A typical multi-day itinerary takes 3-6 tool calls (one weather lookup,
# 2-4 place searches, a handful of directions). 10 rounds gives plenty of
# headroom while still capping pathological loops where the model keeps
# calling tools without producing a final reply.
MAX_TOOL_ROUNDS = 10

_client: AsyncOpenAI | None = None


def _get_client() -> AsyncOpenAI:
    """Lazily build the OpenAI client pointed at OpenRouter."""
    global _client
    if _client is None:
        if not check_key(OPENROUTER_API_KEY):
            raise RuntimeError(
                "OPENROUTER_API_KEY not configured. Add it to .env to enable the LLM."
            )
        _client = AsyncOpenAI(
            api_key=OPENROUTER_API_KEY,
            base_url=OPENROUTER_BASE_URL,
        )
    return _client


def _format_preferences(preferences: dict | None) -> str:
    """Render a USER PROFILE block to append to the system prompt."""
    if not preferences:
        return ""
    parts: list[str] = []
    for key in ("interests", "dislikes", "dietary", "budget", "travel_style"):
        value = preferences.get(key)
        if value in (None, "", []):
            continue
        if isinstance(value, list):
            value = ", ".join(str(v) for v in value)
        parts.append(f"- {key.replace('_', ' ')}: {value}")
    if not parts:
        return ""
    return "\n\nUSER PROFILE (honor these on every recommendation):\n" + "\n".join(parts)


async def chat(messages: list[dict], preferences: dict | None = None) -> dict:
    """Run the LLM with a tool-call loop.

    Args:
        messages: prior conversation history [{role, content}, ...]
        preferences: optional user profile dict to inject into system prompt

    Returns:
        {reply: str, itinerary: dict | None, tool_calls_made: list[str]}
    """
    client = _get_client()

    # User preferences are injected as an addendum to the system prompt rather
    # than a separate message — this keeps them visible to the model on every
    # tool-call iteration without polluting the conversation history.
    system_content = SYSTEM_PROMPT + _format_preferences(preferences)
    full_messages: list[dict] = [{"role": "system", "content": system_content}] + list(messages)
    tool_calls_made: list[str] = []
    last_text = ""

    for round_idx in range(MAX_TOOL_ROUNDS):
        # Each iteration is a full chat completion. The model decides whether
        # to call tools (by returning .tool_calls) or to produce a final text
        # reply (by leaving .tool_calls empty).
        response = await client.chat.completions.create(
            model=LLM_MODEL,
            messages=full_messages,
            tools=TOOL_DEFINITIONS,
            tool_choice="auto",
        )

        msg = response.choices[0].message
        last_text = msg.content or last_text

        if not msg.tool_calls:
            # Model is done — return whatever text it produced.
            break

        # Persist the assistant's tool-call message into the running history
        # so the next iteration sees its own decisions. The OpenAI API requires
        # the assistant message and the matching tool result messages to be
        # paired in order; the role="tool" messages we append below carry the
        # tool_call_id that ties them back to this assistant message.
        full_messages.append(
            {
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
            }
        )

        # Execute each tool call requested by the model. Tools may run in any
        # order (we go sequentially for simplicity); errors are caught and
        # reported back to the model as a structured error so it can recover
        # gracefully — e.g. tell the user "the weather service is unavailable"
        # instead of crashing the request.
        for tc in msg.tool_calls:
            fn_name = tc.function.name
            try:
                fn_args = json.loads(tc.function.arguments or "{}")
            except json.JSONDecodeError:
                fn_args = {}

            tool_calls_made.append(fn_name)
            logger.info("Tool call: %s(%s)", fn_name, fn_args)

            fn = TOOL_DISPATCH.get(fn_name)
            if fn is None:
                tool_result = {"error": f"Unknown tool: {fn_name}"}
            else:
                try:
                    tool_result = await fn(**fn_args)
                except ToolUnavailableError as e:
                    tool_result = {"error": str(e)}
                except Exception as e:
                    logger.exception("Tool %s failed", fn_name)
                    tool_result = {"error": f"Tool execution failed: {e}"}

            full_messages.append(
                {
                    "role": "tool",
                    "tool_call_id": tc.id,
                    "content": json.dumps(tool_result, default=str),
                }
            )
    else:
        logger.warning("Hit MAX_TOOL_ROUNDS=%d without final reply", MAX_TOOL_ROUNDS)

    itinerary = _extract_itinerary(last_text)

    return {
        "reply": last_text,
        "itinerary": itinerary,
        "tool_calls_made": tool_calls_made,
    }


_JSON_FENCE_RE = re.compile(r"```json\s*(.*?)```", re.DOTALL)
_INVALID_ESCAPE_RE = re.compile(r'\\(?!["\\/bfnrtu])')


def _sanitize_json(text: str) -> str:
    """Escape lone backslashes that aren't valid JSON escapes.

    Google's encoded polyline format (the result of get_directions) is a
    string of ASCII characters in the range 0x3F-0x7E that frequently
    contains backslashes. When the LLM copies a polyline value verbatim
    into a JSON string literal, those backslashes become invalid escape
    sequences (e.g. ``\\A``, ``\\z``) that strict JSON parsers reject.

    Example of what the model produces and what this function fixes::

        before: {"polyline": "|Ar@zAkD\\Bf@_Bt@yC..."}
                                   ^^^ invalid escape
        after:  {"polyline": "|Ar@zAkD\\\\Bf@_Bt@yC..."}
                                   ^^^^^ doubled, now a literal "\\B"

    We only touch backslashes that don't begin a valid JSON escape (one of
    " \\ / b f n r t u). This is a pragmatic fix — a fully strict
    alternative would be a custom JSON tokenizer.
    """
    return _INVALID_ESCAPE_RE.sub(r"\\\\", text)


def _balanced_json_object(text: str, start: int) -> str | None:
    """Return the JSON object starting at `start` in `text`, balanced over braces.

    A naive regex like ``\\{.*?\\}`` (non-greedy) returns the SHORTEST match,
    which for nested JSON objects yields just the innermost ``{}``. A greedy
    ``\\{.*\\}`` extends past the closing brace into any text that follows.
    Neither works for the deeply-nested itinerary objects we deal with, so we
    walk the string character by character, tracking brace depth and being
    careful not to count braces that appear inside string literals.

    Returns None if `start` doesn't point at a ``{`` or no matching ``}`` is
    found before the end of the input.
    """
    if start >= len(text) or text[start] != "{":
        return None
    depth = 0
    in_string = False
    escape = False
    for i in range(start, len(text)):
        ch = text[i]
        if in_string:
            # Inside a "..." literal — don't count braces, but do honor
            # backslash escapes so we don't mistake an escaped quote for the
            # end of the string.
            if escape:
                escape = False
            elif ch == "\\":
                escape = True
            elif ch == '"':
                in_string = False
        else:
            if ch == '"':
                in_string = True
            elif ch == "{":
                depth += 1
            elif ch == "}":
                depth -= 1
                if depth == 0:
                    # Closed the object that started at `start`.
                    return text[start : i + 1]
    return None


def _extract_itinerary(text: str) -> dict | None:
    """Extract a JSON itinerary block from the LLM response.

    Tries fenced ```json blocks first, then falls back to scanning for any
    `{"itinerary": ...}` object anywhere in the text.
    """
    if not text:
        return None

    def _try_parse(candidate: str) -> dict | None:
        for attempt in (candidate, _sanitize_json(candidate)):
            try:
                data = json.loads(attempt)
            except json.JSONDecodeError:
                continue
            if isinstance(data, dict) and "itinerary" in data:
                return data["itinerary"]
        return None

    # 1. Look inside ```json``` code fences
    for match in _JSON_FENCE_RE.finditer(text):
        result = _try_parse(match.group(1).strip())
        if result is not None:
            return result

    # 2. Scan for the literal substring `"itinerary"` and balance braces from
    #    the nearest preceding `{`
    idx = 0
    while True:
        pos = text.find('"itinerary"', idx)
        if pos == -1:
            break
        brace = text.rfind("{", 0, pos)
        if brace != -1:
            obj = _balanced_json_object(text, brace)
            if obj:
                result = _try_parse(obj)
                if result is not None:
                    return result
        idx = pos + 1

    return None
