"""POST /chat — main entry point for the travel agent."""
from __future__ import annotations

import logging

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from app import llm

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/chat", tags=["chat"])


class Message(BaseModel):
    role: str
    content: str


class ChatRequest(BaseModel):
    message: str
    history: list[Message] = Field(default_factory=list)


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

    try:
        result = await llm.chat(messages)
    except RuntimeError as e:
        # Missing API key — surface as 503 Service Unavailable
        raise HTTPException(status_code=503, detail=str(e)) from e
    except Exception as e:
        logger.exception("LLM call failed")
        raise HTTPException(status_code=500, detail=f"LLM error: {e}") from e

    return ChatResponse(**result)
