"""LLM orchestrator: OpenRouter via OpenAI SDK with tool-calling loop."""
from __future__ import annotations

import json
import logging
import re

from openai import AsyncOpenAI

from app.config import LLM_MODEL, OPENROUTER_API_KEY, OPENROUTER_BASE_URL, check_key
from app.prompts import SYSTEM_PROMPT
from app.tools import TOOL_DEFINITIONS, TOOL_DISPATCH, ToolUnavailableError

logger = logging.getLogger(__name__)

MAX_TOOL_ROUNDS = 10  # safety limit on tool-call iterations

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

    system_content = SYSTEM_PROMPT + _format_preferences(preferences)
    full_messages: list[dict] = [{"role": "system", "content": system_content}] + list(messages)
    tool_calls_made: list[str] = []
    last_text = ""

    for round_idx in range(MAX_TOOL_ROUNDS):
        response = await client.chat.completions.create(
            model=LLM_MODEL,
            messages=full_messages,
            tools=TOOL_DEFINITIONS,
            tool_choice="auto",
        )

        msg = response.choices[0].message
        last_text = msg.content or last_text

        if not msg.tool_calls:
            break

        # Append the assistant's tool-call message to history
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

        # Execute each tool call
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

    Google's encoded polyline format embeds backslash characters that the
    LLM tends to copy verbatim into JSON string values, producing invalid
    escapes like '\\A' or '\\z'. We double them so the parser accepts them.
    """
    return _INVALID_ESCAPE_RE.sub(r"\\\\", text)


def _balanced_json_object(text: str, start: int) -> str | None:
    """Return the JSON object starting at `start` in `text`, balanced over braces.

    Naively scans braces while respecting strings (so braces inside string
    literals don't throw off the count). Returns None if no balanced object found.
    """
    if start >= len(text) or text[start] != "{":
        return None
    depth = 0
    in_string = False
    escape = False
    for i in range(start, len(text)):
        ch = text[i]
        if in_string:
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
