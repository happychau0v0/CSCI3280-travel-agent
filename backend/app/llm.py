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

Two entry points:
- ``chat(...)`` returns the final response in one shot.
- ``chat_stream(...)`` is an async generator that yields tool_start /
  tool_end events as the loop runs, then a final ``done`` event with
  the same response shape. The frontend uses this for the live status
  ticker via SSE.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import re
from pathlib import Path
from typing import AsyncIterator, Awaitable, Callable

from openai import AsyncOpenAI

from app.config import LLM_MODEL, OPENROUTER_API_KEY, OPENROUTER_BASE_URL, check_key
from app.prompts import SYSTEM_PROMPT
from app.tools import TOOL_DEFINITIONS, TOOL_DISPATCH, ToolUnavailableError

logger = logging.getLogger(__name__)

# A typical multi-day itinerary takes 3-6 tool calls (one weather lookup,
# 2-4 place searches, a handful of directions). 10 rounds gives plenty of
# headroom while still capping pathological loops where the model keeps
# calling tools without producing a final reply.
MAX_TOOL_ROUNDS = 20

# Proxy env vars that Clash/Shadowsocks/V2Ray set. The OpenAI SDK uses
# httpx internally, which will try to route through these proxies and
# fail with "socksio not installed" on most installs. Strip them before
# creating the client, same as flights.py does for Google Flights.
_PROXY_ENV_VARS = (
    "HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy",
    "ALL_PROXY", "all_proxy",
)

_client: AsyncOpenAI | None = None


def _get_client() -> AsyncOpenAI:
    """Lazily build the OpenAI client pointed at OpenRouter."""
    global _client
    if _client is None:
        if not check_key(OPENROUTER_API_KEY):
            raise RuntimeError(
                "OPENROUTER_API_KEY not configured. Add it to .env to enable the LLM."
            )
        # Clear proxy env vars so httpx doesn't try to route through a
        # local SOCKS proxy (Clash, Shadowsocks, V2Ray). These proxies
        # cause "socksio not installed" crashes on most machines.
        saved = {}
        for key in _PROXY_ENV_VARS:
            val = os.environ.pop(key, None)
            if val is not None:
                saved[key] = val
        _client = AsyncOpenAI(
            api_key=OPENROUTER_API_KEY,
            base_url=OPENROUTER_BASE_URL,
        )
        # Restore env vars so other code (e.g. user scripts) isn't affected.
        os.environ.update(saved)
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


def _format_user_location(user_location: dict | None) -> str:
    """Render a USER LOCATION block to prepend the system prompt with origin context."""
    if not user_location:
        return ""
    city = user_location.get("city", "")
    country = user_location.get("country", "")
    lat = user_location.get("lat")
    lng = user_location.get("lng")
    if not city and lat is None:
        return ""
    line = f"{city}"
    if country and country != city:
        line += f", {country}"
    if lat is not None and lng is not None:
        line += f" (lat={lat}, lng={lng})"
    return (
        "\n\nUSER LOCATION (the user is RIGHT NOW at this place — use it as the trip origin "
        "without asking):\n- " + line
    )


def _format_trip_dates(trip_dates: dict | None) -> str:
    """Render a TRIP DATES block telling the agent which dates to plan for."""
    if not trip_dates:
        return ""
    start = trip_dates.get("start")
    end = trip_dates.get("end")
    if not start and not end:
        return ""
    if start and end and start != end:
        line = f"{start} to {end}"
    else:
        line = start or end
    return (
        "\n\nTRIP DATES (the user has already picked these — do NOT ask 'when?'. "
        "Use them as the start/end of the itinerary and as the date for "
        "search_flights and any date-sensitive lookups):\n- " + line
    )


EventCallback = Callable[[str, dict], Awaitable[None]]


async def _run_loop(
    messages: list[dict],
    *,
    preferences: dict | None = None,
    user_location: dict | None = None,
    trip_dates: dict | None = None,
    on_event: EventCallback | None = None,
) -> dict:
    """Internal: shared tool-call loop used by both chat() and chat_stream().

    `on_event(event_type, payload)` is called before each tool starts
    (``"tool_start"``) and after it finishes (``"tool_end"``). Pass None to
    disable streaming.
    """
    client = _get_client()

    # User preferences and live location are injected as addenda to the system
    # prompt rather than separate messages — this keeps them visible to the
    # model on every tool-call iteration without polluting the conversation
    # history.
    system_content = (
        SYSTEM_PROMPT
        + _format_user_location(user_location)
        + _format_trip_dates(trip_dates)
        + _format_preferences(preferences)
    )
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

        # Execute tool calls in PARALLEL via asyncio.gather. The LLM
        # often requests multiple independent calls per round
        # (e.g. get_directions between several pairs of activities,
        # or search_places for hotels + the next day's activities at
        # once). Running them serially added ~15s per multi-day plan
        # on the benchmark; gather brings that down to the slowest
        # single call's latency.
        async def _run_one(tc):
            fn_name = tc.function.name
            try:
                fn_args = json.loads(tc.function.arguments or "{}")
            except json.JSONDecodeError:
                fn_args = {}

            tool_calls_made.append(fn_name)
            logger.info("Tool call: %s(%s)", fn_name, fn_args)

            if on_event is not None:
                await on_event("tool_start", {"name": fn_name, "args": fn_args})
                # navigate_menu is a UI-driving tool — emit a parallel
                # navigate event so the frontend can update its menu state
                # immediately, without waiting for the (no-op) tool execution.
                if fn_name == "navigate_menu":
                    await on_event("navigate", fn_args)
                # request_input asks the user for a structured value via
                # the TRIP form. Emit a parallel request_input event so
                # the frontend can switch panels and focus the field.
                elif fn_name == "request_input":
                    await on_event("request_input", fn_args)

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

            if on_event is not None:
                await on_event("tool_end", {"name": fn_name})

            return {
                "role": "tool",
                "tool_call_id": tc.id,
                "content": json.dumps(tool_result, default=str),
            }

        tool_results = await asyncio.gather(*(_run_one(tc) for tc in msg.tool_calls))
        full_messages.extend(tool_results)
    else:
        logger.warning("Hit MAX_TOOL_ROUNDS=%d without final reply", MAX_TOOL_ROUNDS)

    # Debug: dump raw LLM text when DUMP_LLM=1 so we can record golden
    # fixtures for schema validation tests (P1 of the testing plan).
    import os

    if os.getenv("DUMP_LLM"):
        dump_dir = Path(__file__).resolve().parent.parent / "tests" / "fixtures" / "llm_outputs"
        dump_dir.mkdir(parents=True, exist_ok=True)
        dump_file = dump_dir / f"dump_{len(tool_calls_made)}tools.txt"
        dump_file.write_text(last_text)
        logger.info("Dumped LLM output to %s", dump_file)

    itinerary = _extract_itinerary(last_text)
    if itinerary:
        itin_keys = list(itinerary.keys())
        day_count = len(itinerary.get("days", []))
        logger.info("Extracted itinerary keys=%s, days=%d", itin_keys, day_count)
    else:
        logger.warning("_extract_itinerary returned None (text length=%d)", len(last_text))

    return {
        "reply": last_text,
        "itinerary": itinerary,
        "tool_calls_made": tool_calls_made,
    }


async def chat(
    messages: list[dict],
    preferences: dict | None = None,
    user_location: dict | None = None,
    trip_dates: dict | None = None,
) -> dict:
    """Run the LLM with a tool-call loop and return the final response.

    Args:
        messages: prior conversation history [{role, content}, ...]
        preferences: optional user profile dict
        user_location: optional {city, country, lat, lng} from browser GPS
        trip_dates: optional {start, end} ISO dates picked by the user

    Returns:
        {reply: str, itinerary: dict | None, tool_calls_made: list[str]}
    """
    return await _run_loop(
        messages,
        preferences=preferences,
        user_location=user_location,
        trip_dates=trip_dates,
        on_event=None,
    )


async def chat_stream(
    messages: list[dict],
    preferences: dict | None = None,
    user_location: dict | None = None,
    trip_dates: dict | None = None,
) -> AsyncIterator[dict]:
    """Run the LLM and yield events as tool calls fire.

    Bridges the callback-driven _run_loop into an async generator via an
    asyncio.Queue. Yields:
      - {"type": "tool_start", "data": {"name": ..., "args": ...}}
      - {"type": "tool_end",   "data": {"name": ...}}
      - {"type": "done",       "data": {"reply": ..., "itinerary": ..., "tool_calls_made": [...]}}
      - {"type": "error",      "data": {"message": ...}}  on failure
    """
    queue: asyncio.Queue = asyncio.Queue()

    async def emit(event_type: str, payload: dict) -> None:
        await queue.put({"type": event_type, "data": payload})

    async def run() -> None:
        try:
            result = await _run_loop(
                messages,
                preferences=preferences,
                user_location=user_location,
                trip_dates=trip_dates,
                on_event=emit,
            )
            await queue.put({"type": "done", "data": result})
        except RuntimeError as e:
            # Missing API key — surface as error event so the SSE stream
            # can close gracefully instead of dropping the connection.
            await queue.put({"type": "error", "data": {"status": 503, "message": str(e)}})
        except Exception as e:
            logger.exception("chat_stream failed")
            await queue.put({"type": "error", "data": {"status": 500, "message": str(e)}})
        finally:
            await queue.put(None)  # sentinel

    task = asyncio.create_task(run())
    try:
        while True:
            item = await queue.get()
            if item is None:
                break
            yield item
    finally:
        # Ensure the background task is awaited (or cancelled) when the
        # consumer disconnects mid-stream.
        if not task.done():
            task.cancel()
            try:
                await task
            except (asyncio.CancelledError, Exception):
                pass


_JSON_FENCE_RE = re.compile(r"```json\s*(.*?)```", re.DOTALL)
def _sanitize_json(text: str) -> str:
    """Escape ALL backslashes inside JSON string literals.

    Google's encoded polyline format contains backslashes that are NOT
    meant to be JSON escape sequences — they're literal chars in the
    polyline encoding. When the LLM copies them into a JSON string,
    they become invalid (e.g. ``\\A``, ``\\z``) OR get silently
    converted (e.g. ``\\f`` becomes form-feed, corrupting the polyline).

    Strategy: walk the text and double EVERY backslash inside a string
    literal, unless it's followed by a quote (which would otherwise
    close the string prematurely). This is aggressive but produces
    valid JSON that round-trips the original polyline bytes literally.
    """
    out = []
    i = 0
    in_string = False
    while i < len(text):
        ch = text[i]
        if not in_string:
            out.append(ch)
            if ch == '"':
                in_string = True
            i += 1
        else:
            if ch == '\\' and i + 1 < len(text):
                next_ch = text[i + 1]
                if next_ch == '"':
                    # Escaped quote — keep as is so the string stays open
                    out.append(ch)
                    out.append(next_ch)
                    i += 2
                elif next_ch == '\\':
                    # Already-escaped backslash — keep as is (valid JSON)
                    out.append(ch)
                    out.append(next_ch)
                    i += 2
                else:
                    # Lone backslash followed by non-escape char —
                    # double it so JSON treats it as literal
                    out.append('\\')
                    out.append('\\')
                    out.append(next_ch)
                    i += 2
            elif ch == '\\':
                # Trailing backslash at end of text — double it
                out.append('\\')
                out.append('\\')
                i += 1
            elif ch == '"':
                out.append(ch)
                in_string = False
                i += 1
            else:
                out.append(ch)
                i += 1
    return ''.join(out)


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

    Uses json-repair as a fallback when strict parsing fails — this handles
    the Google encoded polyline escape mess that's hard to fix via regex.
    """
    if not text:
        return None

    # Lazy import so tests without the dep still import this module
    try:
        import json_repair
    except ImportError:  # pragma: no cover
        json_repair = None

    def _try_parse(candidate: str) -> dict | None:
        # Try strict parse first (with our sanitizer)
        for attempt in (candidate, _sanitize_json(candidate)):
            try:
                data = json.loads(attempt)
            except json.JSONDecodeError:
                continue
            if isinstance(data, dict) and "itinerary" in data:
                return data["itinerary"]
        # Fallback: lenient parse via json-repair. Handles malformed
        # polyline escapes that our sanitizer can't untangle.
        if json_repair is not None:
            try:
                data = json_repair.loads(candidate)
                if isinstance(data, dict) and "itinerary" in data:
                    return data["itinerary"]
            except Exception:
                pass
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
