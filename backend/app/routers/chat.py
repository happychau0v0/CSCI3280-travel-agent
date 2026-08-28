"""POST /chat — main entry point for the travel agent."""
from __future__ import annotations

import json
import logging
import secrets

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from app import llm

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/chat", tags=["chat"])


class Message(BaseModel):
    role: str
    content: str


ALLOWED_MODELS = {
    "grok-4.20-0309-non-reasoning",
    "grok-4.20-0309-reasoning",
    # "grok-4.20-multi-agent-0309" removed — xAI rejects this variant on
    # the chat completions endpoint with "Multi Agent requests are not allowed".
    "gemini-3.1-pro-preview",
    # FALLBACK_CHAIN entries — exposed so users can manually pick them
    # via Settings overlay even outside an outage. They route through
    # OpenRouter (requires OPENROUTER_PROXY).
    "moonshotai/kimi-k2-0905",
    "minimax/minimax-m2.7",
}

ALLOWED_ROLES = {None, "plan", "hotels", "days", "chat", "replace", "day_themes", "day_detail"}


class ChatRequest(BaseModel):
    message: str
    history: list[Message] = Field(default_factory=list)
    preferences: dict | None = None
    user_location: dict | None = None
    trip_dates: dict | None = None
    local_form: dict | None = None
    bench_eval: bool = False
    preferred_model: str | None = None
    call_role: str | None = None


class ChatResponse(BaseModel):
    reply: str
    itinerary: dict | None = None
    tool_calls_made: list[str] = Field(default_factory=list)


@router.post("", response_model=ChatResponse)
async def post_chat(req: ChatRequest) -> ChatResponse:
    """Run the LLM with the user's message and conversation history."""
    messages = [m.model_dump() for m in req.history] + [
        {"role": "user", "content": req.message}
    ]

    if req.preferred_model and req.preferred_model not in ALLOWED_MODELS:
        raise HTTPException(status_code=400, detail=f"Unknown model: {req.preferred_model}")
    if req.call_role not in ALLOWED_ROLES:
        raise HTTPException(status_code=400, detail=f"Unknown call_role: {req.call_role}")

    try:
        result = await llm.chat(
            messages,
            preferences=req.preferences,
            user_location=req.user_location,
            trip_dates=req.trip_dates,
            local_form=req.local_form,
            bench_eval=req.bench_eval,
            preferred_model=req.preferred_model,
            call_role=req.call_role,
        )
    except RuntimeError as e:
        # Missing API key — surface as 503 Service Unavailable
        raise HTTPException(status_code=503, detail=str(e)) from e
    except Exception as e:
        logger.exception("LLM call failed")
        raise HTTPException(status_code=500, detail=f"LLM error: {e}") from e

    return ChatResponse(**result)


def _format_sse(event: dict) -> str:
    """Format a single event as SSE wire format.

    Each event becomes::

        event: tool_start
        data: {"name": "search_flights", ...}

        (blank line terminator)
    """
    event_type = event.get("type", "message")
    payload = json.dumps(event.get("data", {}), default=str)
    return f"event: {event_type}\ndata: {payload}\n\n"


@router.post("/stream")
async def post_chat_stream(req: ChatRequest):
    """Stream the LLM response as Server-Sent Events.

    Emits ``tool_start`` and ``tool_end`` events as tools fire, then a
    final ``done`` event with the same shape as POST /chat. Use ``error``
    to detect missing keys (status 503) or LLM failures (status 500)
    instead of HTTP error codes — the SSE stream is always 200.
    """
    messages = [m.model_dump() for m in req.history] + [
        {"role": "user", "content": req.message}
    ]

    if req.preferred_model and req.preferred_model not in ALLOWED_MODELS:
        raise HTTPException(status_code=400, detail=f"Unknown model: {req.preferred_model}")
    if req.call_role not in ALLOWED_ROLES:
        raise HTTPException(status_code=400, detail=f"Unknown call_role: {req.call_role}")

    sid = secrets.token_hex(4)  # 8-char hex — unique per request, correlates all events

    async def event_generator():
        async for event in llm.chat_stream(
            messages,
            preferences=req.preferences,
            user_location=req.user_location,
            trip_dates=req.trip_dates,
            local_form=req.local_form,
            bench_eval=req.bench_eval,
            preferred_model=req.preferred_model,
            call_role=req.call_role,
            sid=sid,
        ):
            yield _format_sse(event)

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",  # disable buffering for nginx if proxied
        },
    )
