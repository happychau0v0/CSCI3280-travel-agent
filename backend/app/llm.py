"""LLM orchestrator: xAI direct API via OpenAI SDK with tool-calling loop.

Architecture (matches the TA brief's "Brain → Hands → Interface" diagram):

    user message ─► chat() ─► OpenAI SDK pointed at xAI (api.x.ai)
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
import time
from pathlib import Path
from types import SimpleNamespace
from typing import AsyncIterator, Awaitable, Callable

import httpx
import openai
from openai import AsyncOpenAI

from app.config import (
    FALLBACK_LLM_MODEL,
    GEMINI_API_KEY,
    GEMINI_BASE_URL,
    LLM_MODEL,
    PRUNE_KEEP_ROUNDS,
    XAI_API_KEY,
    XAI_BASE_URL,
    check_key,
)
from app.prompts import BENCH_EVAL_ADDENDUM, ROLE_ALLOWED_TOOLS, ROLE_PROMPTS, SYSTEM_PROMPT
from app.tools import TOOL_DEFINITIONS, TOOL_DISPATCH, ToolUnavailableError

logger = logging.getLogger(__name__)


def _build_tools_list(model: str = LLM_MODEL) -> list[dict]:
    """Return TOOL_DEFINITIONS for the given model.

    xAI deprecated web_search_preview in their tools API (now returns 422);
    all providers including xAI only accept type=function tools via this endpoint.
    """
    return list(TOOL_DEFINITIONS)

# A typical multi-day itinerary takes 3-6 tool calls (one weather lookup,
# 2-4 place searches, a handful of directions). 10 rounds gives plenty of
# headroom while still capping pathological loops where the model keeps
# calling tools without producing a final reply.
MAX_TOOL_ROUNDS = 20

# Role-specific model defaults. Only applied when preferred_model is unset or
# matches the global default (i.e., no explicit user override from Settings).
ROLE_DEFAULT_MODELS: dict[str, str] = {
    "plan":   "grok-4.20-0309-non-reasoning",
    "hotels": "grok-4.20-0309-non-reasoning",
    "days":   "grok-4.20-0309-non-reasoning",
    "chat":   "grok-4.20-0309-non-reasoning",
}

_client: AsyncOpenAI | None = None
_fallback_client: AsyncOpenAI | None = None


def _get_client() -> AsyncOpenAI:
    """Lazily build the OpenAI client pointed at xAI's direct API."""
    global _client
    if _client is None:
        if not check_key(XAI_API_KEY):
            raise RuntimeError(
                "XAI_API_KEY not configured. Add it to .env to enable the LLM."
            )
        # read=45s: each SSE chunk from the LLM must arrive within 45 s.
        # With streaming, chunks come continuously — 45 s is enough headroom
        # even for slow reasoning, while cutting hangs from stalled API
        # connections (was 120 s, which felt like "hung forever" to users).
        timeout = httpx.Timeout(connect=10.0, read=45.0, write=30.0, pool=5.0)
        http_client = httpx.AsyncClient(timeout=timeout, trust_env=False)
        _client = AsyncOpenAI(
            api_key=XAI_API_KEY,
            base_url=XAI_BASE_URL,
            timeout=timeout,
            http_client=http_client,
        )
    return _client


def _get_fallback_client() -> AsyncOpenAI:
    """Lazily build the fallback client pointed at Google Gemini's OpenAI-compatible API.

    Used when xAI is down (outage) or geo-restricted. Gemini uses the same
    OpenAI SDK wire format so no changes to tool calling or response parsing needed.
    """
    global _fallback_client
    if _fallback_client is None:
        if not check_key(GEMINI_API_KEY):
            raise RuntimeError(
                "GEMINI_API_KEY not configured. Add it to .env for LLM fallback."
            )
        timeout = httpx.Timeout(connect=10.0, read=45.0, write=30.0, pool=5.0)
        _fallback_client = AsyncOpenAI(
            api_key=GEMINI_API_KEY,
            base_url=GEMINI_BASE_URL,
            timeout=timeout,
        )
    return _fallback_client


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


def _map_partial(fn_name: str, fn_args: dict, result: dict) -> dict | None:
    """Map a completed tool result to a partial_itinerary payload, or return None."""
    if result.get("error"):
        return None
    if fn_name == "search_flights":
        return {"flight": result}  # already has options, from_lat/lng, to_lat/lng
    if fn_name == "search_places":
        places = result.get("places", [])
        if not places:
            return None
        query = (fn_args.get("query") or "").lower()
        is_hotel = any(k in query for k in
            ("hotel", "hostel", "resort", "inn", "accommodation", "lodging"))
        if is_hotel:
            hotels = [
                {
                    "name": p.get("name", ""),
                    "lat": p.get("lat"),
                    "lng": p.get("lng"),
                    "rating": p.get("rating"),
                    "price_level": p.get("price_level"),
                    "address": p.get("address", ""),
                    "photo_url": p.get("photo_url"),
                    "place_id": p.get("place_id"),
                    "_preview": True,
                }
                for p in places if p.get("lat") is not None
            ]
            return {"hotels": hotels} if hotels else None
    return None


def _is_region_error(exc: Exception) -> bool:
    """Return True when the provider rejected the model due to geo-restriction."""
    msg = str(exc).lower()
    return any(k in msg for k in (
        "region", "not available", "not supported", "geo", "country",
        "unsupported", "access denied", "403",
    ))


def _is_provider_outage(exc: Exception) -> bool:
    """Return True when the primary provider is having an outage (500 from their API)."""
    return isinstance(exc, openai.InternalServerError)


def _prune_tool_results(messages: list[dict], keep_recent_rounds: int = 2) -> list[dict]:
    """Replace content of old tool result messages with a short summary.

    Identifies assistant turns (round boundaries) and truncates tool result
    messages from rounds older than keep_recent_rounds.
    """
    round_starts = [i for i, m in enumerate(messages) if m.get("role") == "assistant"]
    if len(round_starts) <= keep_recent_rounds:
        return messages
    cutoff_idx = round_starts[-keep_recent_rounds]
    pruned = []
    for i, msg in enumerate(messages):
        if msg.get("role") == "tool" and i < cutoff_idx:
            pruned.append({**msg, "content": "[tool result omitted]"})
        else:
            pruned.append(msg)
    return pruned


EventCallback = Callable[[str, dict], Awaitable[None]]


async def _run_loop(
    messages: list[dict],
    *,
    preferences: dict | None = None,
    user_location: dict | None = None,
    trip_dates: dict | None = None,
    on_event: EventCallback | None = None,
    bench_eval: bool = False,
    preferred_model: str | None = None,
    call_role: str | None = None,
    sid: str | None = None,
) -> dict:
    """Internal: shared tool-call loop used by both chat() and chat_stream().

    `on_event(event_type, payload)` is called before each tool starts
    (``"tool_start"``) and after it finishes (``"tool_end"``). Pass None to
    disable streaming.
    """
    # Pick the right client for whichever model is active — Gemini models use
    # the Gemini client; everything else uses the xAI client.
    # Resolution: explicit user choice > role default > global env default
    _user_chose_explicitly = preferred_model and preferred_model != LLM_MODEL
    if _user_chose_explicitly:
        active_model = preferred_model
    elif call_role and call_role in ROLE_DEFAULT_MODELS:
        active_model = ROLE_DEFAULT_MODELS[call_role]
    else:
        active_model = preferred_model or LLM_MODEL
    client = _get_fallback_client() if active_model.startswith("gemini") else _get_client()

    # Pick system prompt and tool allow-list based on call_role.
    # Scoped calls (plan/hotels/days/chat) get a focused prompt and a strict
    # tool allow-list; legacy calls (call_role=None) keep the monolithic prompt.
    base_prompt = ROLE_PROMPTS.get(call_role, SYSTEM_PROMPT) if call_role else SYSTEM_PROMPT
    system_content = (
        base_prompt
        + _format_user_location(user_location)
        + _format_trip_dates(trip_dates)
        + _format_preferences(preferences)
    )
    if bench_eval:
        system_content += BENCH_EVAL_ADDENDUM

    # Filter TOOL_DEFINITIONS to the allow-list for this role.
    allowed = ROLE_ALLOWED_TOOLS.get(call_role) if call_role else None
    tools_for_role = (
        [t for t in TOOL_DEFINITIONS if t["function"]["name"] in allowed]
        if allowed else list(TOOL_DEFINITIONS)
    )

    # Scoped calls (plan/hotels/days) must NOT see prior conversation history —
    # each is a fresh, single-purpose call. Only the system prompt + the one
    # structured user message go in. Chat keeps the full history for context.
    if call_role in ("plan", "hotels", "days"):
        # messages[-1] is the structured user prompt built by the frontend
        full_messages: list[dict] = [
            {"role": "system", "content": system_content},
            messages[-1],
        ]
    else:
        full_messages = [{"role": "system", "content": system_content}] + list(messages)
    tool_calls_made: list[str] = []
    last_text = ""

    for round_idx in range(MAX_TOOL_ROUNDS):
        # Each iteration is a full chat completion. The model decides whether
        # to call tools (by returning .tool_calls) or to produce a final text
        # reply (by leaving .tool_calls empty).
        try:
            if on_event is not None:
                # Signal that the LLM is now processing — this fires before
                # the first token arrives so the status bar always has context
                # during the silent thinking phase (up to 3-5s for Grok).
                await on_event("thinking", {"round": round_idx})
                # Streaming path: forward tokens to the client as they arrive.
                # This cuts time-to-first-visible-text from ~3-5s to ~200ms.
                stream = await client.chat.completions.create(
                    model=active_model,
                    messages=full_messages,
                    tools=tools_for_role,
                    tool_choice="auto",
                    stream=True,
                )
                content_chunks: list[str] = []
                # tc_accum keys are logical slot indices.
                # We key first by (index, id) when Gemini sends all tools as
                # index=0 with distinct ids, falling back to bare index for
                # providers (xAI) that correctly number each tool call.
                tc_accum: dict[int, dict] = {}
                # id_to_slot: maps call_id → slot index so chunks for the same
                # call land in the right slot regardless of streaming order.
                _id_to_slot: dict[str, int] = {}
                _next_slot = 0
                async for chunk in stream:
                    if not chunk.choices:
                        continue
                    delta = chunk.choices[0].delta
                    if delta.content:
                        content_chunks.append(delta.content)
                        await on_event("token", {"text": delta.content})
                    if delta.tool_calls:
                        for tc_chunk in delta.tool_calls:
                            # Determine which logical slot this chunk belongs to.
                            #
                            # xAI / standard OpenAI: sends sequential index values
                            #   (0, 1, 2…) with a non-empty id on the first chunk.
                            # Gemini OpenAI-compat: sends index=None with a
                            #   distinct id per call. We key by id instead.
                            call_id = tc_chunk.id or ""
                            raw_idx = tc_chunk.index  # may be None (Gemini)

                            if call_id and call_id in _id_to_slot:
                                # Continuation chunk for a call we've already seen.
                                slot = _id_to_slot[call_id]
                            elif call_id:
                                # New call id → allocate a fresh slot, ignoring
                                # raw_idx (handles index=None and index-collision).
                                slot = _next_slot
                                _next_slot += 1
                                _id_to_slot[call_id] = slot
                                tc_accum[slot] = {"id": call_id, "type": "function",
                                                  "function": {"name": "", "arguments": ""}}
                            elif raw_idx is not None:
                                # No id yet (first chunk of an xAI call carries
                                # the id; subsequent chunks may omit it).
                                if raw_idx not in tc_accum:
                                    tc_accum[raw_idx] = {"id": "", "type": "function",
                                                         "function": {"name": "", "arguments": ""}}
                                    _next_slot = max(_next_slot, raw_idx + 1)
                                slot = raw_idx
                            else:
                                # No id, no index — skip malformed chunk.
                                continue

                            if tc_chunk.id:
                                tc_accum[slot]["id"] = tc_chunk.id
                            if tc_chunk.function:
                                if tc_chunk.function.name:
                                    tc_accum[slot]["function"]["name"] += tc_chunk.function.name
                                if tc_chunk.function.arguments:
                                    tc_accum[slot]["function"]["arguments"] += tc_chunk.function.arguments
                content = "".join(content_chunks)
                tcs = [
                    SimpleNamespace(
                        id=tc_accum[i]["id"],
                        function=SimpleNamespace(
                            name=tc_accum[i]["function"]["name"],
                            arguments=tc_accum[i]["function"]["arguments"],
                        ),
                    )
                    for i in sorted(tc_accum.keys())
                ]
                msg = SimpleNamespace(
                    content=content or None,
                    tool_calls=tcs if tcs else None,
                )
            else:
                # Non-streaming path: used by chat() for the /chat endpoint.
                response = await client.chat.completions.create(
                    model=active_model,
                    messages=full_messages,
                    tools=tools_for_role,
                    tool_choice="auto",
                )
                msg = response.choices[0].message
        except (openai.APIStatusError, openai.APIConnectionError) as exc:
            # On round 0 only: if the primary provider is down (outage) or
            # geo-restricted, transparently retry with the Gemini fallback.
            # Any error on later rounds re-raises — we don't mid-stream switch
            # providers since tool results are already in the message history.
            is_first_round = round_idx == 0
            already_on_fallback = active_model.startswith("gemini")
            should_fallback = is_first_round and not already_on_fallback and (
                _is_provider_outage(exc) or _is_region_error(exc)
                or isinstance(exc, openai.APITimeoutError)
            )
            if should_fallback:
                reason = "outage" if _is_provider_outage(exc) else "region_restricted"
                logger.warning(
                    "Primary model %s unavailable (%s), falling back to %s: %s",
                    active_model, reason, FALLBACK_LLM_MODEL, exc,
                )
                client = _get_fallback_client()
                active_model = FALLBACK_LLM_MODEL
                if on_event is not None:
                    await on_event("model_fallback", {
                        "from": LLM_MODEL, "to": FALLBACK_LLM_MODEL,
                        "reason": reason,
                    })
                continue
            raise
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
            t0 = asyncio.get_event_loop().time()
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
                # toggle_setting changes a UI setting immediately.
                elif fn_name == "toggle_setting":
                    await on_event("setting_change", fn_args)
                # submit_trip_form pre-fills the PLAN form and triggers planning.
                elif fn_name == "submit_trip_form":
                    await on_event("submit_form", fn_args)
                # pick_flight / pick_hotel / replace_activity — chat mode
                # UI-action tools that mirror the FLIGHTS/HOTELS/DAYS buttons.
                elif fn_name == "pick_flight":
                    await on_event("pick_flight", fn_args)
                elif fn_name == "pick_hotel":
                    await on_event("pick_hotel", fn_args)
                elif fn_name == "replace_activity":
                    await on_event("replace_activity", fn_args)

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

            elapsed_ms = int((asyncio.get_event_loop().time() - t0) * 1000)
            logger.info("Tool done: %s — %dms", fn_name, elapsed_ms)
            # Log the full tool result to llm_events.jsonl — not emitted via
            # SSE (too large for streaming), but essential for debugging wrong
            # itinerary data, failed geocoding, bad direction results, etc.
            if sid:
                from app.event_log import log_event as _log_event
                _log_event(sid, call_role, "tool_result", {
                    "name": fn_name,
                    "result": tool_result,
                    "elapsed_ms": elapsed_ms,
                })
            if on_event is not None:
                # Emit a partial_itinerary snapshot immediately so the
                # frontend can show flights/hotels while the LLM is still
                # generating its closing text.
                if isinstance(tool_result, dict):
                    partial = _map_partial(fn_name, fn_args, tool_result)
                    if partial:
                        partial["_emitted_at"] = int(time.time() * 1000)
                        logger.info("Partial itinerary emitted: %s", fn_name)
                        await on_event("partial_itinerary", partial)
                await on_event("tool_end", {"name": fn_name, "elapsed_ms": elapsed_ms})

            return {
                "role": "tool",
                "tool_call_id": tc.id,
                "content": json.dumps(tool_result, default=str),
            }

        # If request_input is in this batch, execute ONLY request_input and
        # break immediately. Running search_flights or navigate_menu alongside
        # request_input causes confusing UI state — the user hasn't answered
        # yet so the LLM must wait. Filtering here prevents the LLM from
        # sneaking through a search+navigate in the same tool-call batch.
        has_request_input = any(
            tc.function.name == "request_input" for tc in msg.tool_calls
        )
        calls_to_run = (
            [tc for tc in msg.tool_calls if tc.function.name == "request_input"]
            if has_request_input
            else list(msg.tool_calls)
        )
        tool_results = await asyncio.gather(*(_run_one(tc) for tc in calls_to_run))
        full_messages.extend(tool_results)

        if has_request_input:
            # Frontend already received the request_input SSE event and is
            # displaying the input form. Stop here — next message is the user's answer.
            break

        _is_reasoning = "reasoning" in active_model and "non-reasoning" not in active_model
        keep_rounds = 3 if _is_reasoning else 2
        full_messages = _prune_tool_results(full_messages, keep_recent_rounds=keep_rounds)
    else:
        logger.warning("Hit MAX_TOOL_ROUNDS=%d without final reply", MAX_TOOL_ROUNDS)

    # Debug: dump raw LLM text when DUMP_LLM=1 so we can record golden
    # fixtures for schema validation tests (P1 of the testing plan).
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
    bench_eval: bool = False,
    preferred_model: str | None = None,
    call_role: str | None = None,
) -> dict:
    """Run the LLM with a tool-call loop and return the final response.

    Args:
        messages: prior conversation history [{role, content}, ...]
        preferences: optional user profile dict
        user_location: optional {city, country, lat, lng} from browser GPS
        trip_dates: optional {start, end} ISO dates picked by the user
        bench_eval: if True, append addendum instructing the model to collapse
            all planning turns into one response for accurate benchmark scoring
        preferred_model: override the default LLM_MODEL for this request

    Returns:
        {reply: str, itinerary: dict | None, tool_calls_made: list[str]}
    """
    return await _run_loop(
        messages,
        preferences=preferences,
        user_location=user_location,
        trip_dates=trip_dates,
        on_event=None,
        bench_eval=bench_eval,
        preferred_model=preferred_model,
        call_role=call_role,
    )


async def chat_stream(
    messages: list[dict],
    preferences: dict | None = None,
    user_location: dict | None = None,
    trip_dates: dict | None = None,
    bench_eval: bool = False,
    preferred_model: str | None = None,
    call_role: str | None = None,
    sid: str | None = None,
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
    _t0 = time.monotonic()

    # Import lazily so tests that don't need the log file don't create it.
    from app.event_log import log_event as _log_event

    async def emit(event_type: str, payload: dict) -> None:
        # Inject a server-side timestamp (ms since this request started) into
        # every event so the bench script can build a precise waterfall without
        # relying on client-side clock skew.
        payload["t"] = int((time.monotonic() - _t0) * 1000)
        await queue.put({"type": event_type, "data": payload})
        # Mirror every SSE event to the structured JSONL log for debugging.
        if sid:
            _log_event(sid, call_role, event_type, payload)

    async def run() -> None:
        try:
            result = await _run_loop(
                messages,
                preferences=preferences,
                user_location=user_location,
                trip_dates=trip_dates,
                on_event=emit,
                bench_eval=bench_eval,
                preferred_model=preferred_model,
                call_role=call_role,
                sid=sid,
            )
            await queue.put({"type": "done", "data": result})
            # Log the final reply text + full itinerary — this is the most
            # important entry for debugging bad TTS output or wrong JSON.
            if sid:
                _log_event(sid, call_role, "done", result)
        except RuntimeError as e:
            # Missing API key — surface as error event so the SSE stream
            # can close gracefully instead of dropping the connection.
            await queue.put({"type": "error", "data": {"status": 503, "message": str(e)}})
            if sid:
                _log_event(sid, call_role, "error", {"status": 503, "message": str(e)})
        except Exception as e:
            logger.exception("chat_stream failed")
            await queue.put({"type": "error", "data": {"status": 500, "message": str(e)}})
            if sid:
                _log_event(sid, call_role, "error", {"status": 500, "message": str(e)})
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
