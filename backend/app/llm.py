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


async def chat(messages: list[dict]) -> dict:
    """Run the LLM with a tool-call loop.

    Args:
        messages: prior conversation history [{role, content}, ...]

    Returns:
        {reply: str, itinerary: dict | None, tool_calls_made: list[str]}
    """
    client = _get_client()

    full_messages: list[dict] = [{"role": "system", "content": SYSTEM_PROMPT}] + list(messages)
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


_JSON_BLOCK_RE = re.compile(r"```json\s*(\{.*?\})\s*```", re.DOTALL)
_RAW_ITINERARY_RE = re.compile(r'(\{\s*"itinerary"\s*:\s*\{.*?\}\s*\})', re.DOTALL)


def _extract_itinerary(text: str) -> dict | None:
    """Extract a JSON itinerary block from the LLM response."""
    if not text:
        return None

    # Prefer fenced ```json blocks
    for match in _JSON_BLOCK_RE.finditer(text):
        try:
            data = json.loads(match.group(1))
            if isinstance(data, dict) and "itinerary" in data:
                return data["itinerary"]
        except json.JSONDecodeError:
            continue

    # Fallback: raw {"itinerary": {...}} anywhere in the text
    match = _RAW_ITINERARY_RE.search(text)
    if match:
        try:
            data = json.loads(match.group(1))
            return data.get("itinerary")
        except json.JSONDecodeError:
            pass

    return None
