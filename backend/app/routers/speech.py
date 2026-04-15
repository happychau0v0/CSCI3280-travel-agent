"""Text-to-speech endpoint.

Uses xAI's TTS API (POST /v1/tts) to generate natural-sounding speech.
Reuses the same XAI_API_KEY as the main LLM — no extra key needed.

Falls back gracefully with 503 so the frontend degrades to browser
SpeechSynthesis if the key is missing or the API is unavailable.
"""
import logging
import re

import httpx
from fastapi import APIRouter
from fastapi.responses import Response
from pydantic import BaseModel

from app.config import XAI_API_KEY, XAI_BASE_URL, check_key

router = APIRouter(prefix="/speech", tags=["speech"])
logger = logging.getLogger(__name__)


def _clean(text: str) -> str:
    """Strip markdown/JSON so TTS only speaks the narrative text."""
    t = text or ""
    t = re.sub(r"```json[\s\S]*?```", "", t)
    t = re.sub(r"```[\s\S]*?```", "", t)
    t = re.sub(r"\*\*", "", t)
    t = re.sub(r"^#{1,6}\s+", "", t, flags=re.MULTILINE)
    t = re.sub(r"^[-•*]\s+", "", t, flags=re.MULTILINE)   # strip list markers
    t = re.sub(r"^\d+\.\s+", "", t, flags=re.MULTILINE)   # strip numbered lists
    t = re.sub(r"\s—\s", ", ", t)                          # em-dash → comma
    t = re.sub(r"\s+", " ", t).strip()
    return t


class TTSRequest(BaseModel):
    text: str
    voice: str = "ara"  # ara / sal / eve / rex / leo


@router.post("/tts")
async def text_to_speech(req: TTSRequest):
    """Convert text to speech via xAI TTS API.

    POSTs to /v1/tts with voice_id and returns the raw MP3 bytes.
    Returns 503 so the frontend falls back to browser SpeechSynthesis
    if the key is missing or the API is unavailable.
    """
    if not check_key(XAI_API_KEY):
        return Response(
            content=b"",
            status_code=503,
            media_type="text/plain",
            headers={"X-TTS-Error": "XAI_API_KEY not configured"},
        )

    spoken = _clean(req.text)
    if not spoken:
        return Response(content=b"", status_code=204)

    payload = {
        "text": spoken,
        "voice_id": req.voice or "ara",
        "language": "en",
        "output_format": {
            "codec": "mp3",
            "sample_rate": 24000,
            "bit_rate": 128000,
        },
    }

    try:
        async with httpx.AsyncClient(trust_env=False, timeout=30.0) as client:
            resp = await client.post(
                f"{XAI_BASE_URL}/tts",
                json=payload,
                headers={
                    "Authorization": f"Bearer {XAI_API_KEY}",
                    "Content-Type": "application/json",
                },
            )

        if resp.status_code != 200:
            logger.warning("xAI TTS %d: %s", resp.status_code, resp.content[:200])
            return Response(
                content=resp.content,
                status_code=503,
                media_type="text/plain",
                headers={"X-TTS-Error": f"xAI TTS {resp.status_code}"},
            )

        logger.info(
            "TTS (xAI %s) %d bytes for %d chars",
            req.voice, len(resp.content), len(spoken),
        )
        return Response(content=resp.content, media_type="audio/mpeg")

    except Exception as e:
        logger.warning("TTS failed: %s", e)
        return Response(
            content=str(e).encode(),
            status_code=503,
            media_type="text/plain",
        )
