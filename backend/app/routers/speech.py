"""Text-to-speech endpoint.

Uses OpenRouter's gpt-4o-audio-preview model via streaming chat completions
to generate natural-sounding speech. The same OPENROUTER_API_KEY used for
the main LLM is reused — no extra key needed.

Falls back gracefully with 503 so the frontend degrades to browser
SpeechSynthesis if the key is missing or the model is unavailable.
"""
import base64
import json
import logging
import re

import httpx
from fastapi import APIRouter
from fastapi.responses import Response
from pydantic import BaseModel

from app.config import OPENROUTER_API_KEY, OPENROUTER_BASE_URL, check_key

router = APIRouter(prefix="/speech", tags=["speech"])
logger = logging.getLogger(__name__)


def _clean(text: str) -> str:
    """Strip markdown/JSON so TTS only speaks the narrative text."""
    t = text or ""
    t = re.sub(r"```json[\s\S]*?```", "", t)
    t = re.sub(r"```[\s\S]*?```", "", t)
    t = re.sub(r"\*\*", "", t)
    t = re.sub(r"^#{1,6}\s+", "", t, flags=re.MULTILINE)
    t = re.sub(r"\s+", " ", t).strip()
    return t


class TTSRequest(BaseModel):
    text: str
    voice: str = "nova"  # nova / alloy / echo / fable / onyx / shimmer


@router.post("/tts")
async def text_to_speech(req: TTSRequest):
    """Convert text to speech via OpenRouter gpt-4o-audio-preview.

    Uses streaming chat completions with modalities=["text","audio"]. Each
    SSE chunk carries a base64 audio fragment in choices[0].delta.audio.data;
    fragments are concatenated and decoded to MP3 bytes.

    Returns an MP3 audio blob, or 503 so the frontend falls back to browser
    SpeechSynthesis.
    """
    if not check_key(OPENROUTER_API_KEY):
        return Response(
            content=b"",
            status_code=503,
            media_type="text/plain",
            headers={"X-TTS-Error": "OPENROUTER_API_KEY not configured"},
        )

    spoken = _clean(req.text)
    if not spoken:
        return Response(content=b"", status_code=204)

    payload = {
        "model": "openai/gpt-4o-audio-preview",
        "messages": [{"role": "user", "content": spoken}],
        "modalities": ["text", "audio"],
        "audio": {"voice": req.voice or "nova", "format": "mp3"},
        "stream": True,
    }

    audio_chunks: list[str] = []
    try:
        # trust_env=False prevents httpx from routing through a local SOCKS
        # proxy (Clash, Shadowsocks) that would crash with "socksio not installed".
        async with httpx.AsyncClient(trust_env=False, timeout=30.0) as client:
            async with client.stream(
                "POST",
                f"{OPENROUTER_BASE_URL}/chat/completions",
                json=payload,
                headers={
                    "Authorization": f"Bearer {OPENROUTER_API_KEY}",
                    "Content-Type": "application/json",
                },
            ) as resp:
                if resp.status_code != 200:
                    body = await resp.aread()
                    logger.warning(
                        "OpenRouter TTS %d: %s", resp.status_code, body[:200]
                    )
                    return Response(
                        content=body,
                        status_code=503,
                        media_type="text/plain",
                        headers={"X-TTS-Error": f"OpenRouter {resp.status_code}"},
                    )

                async for line in resp.aiter_lines():
                    if not line.startswith("data: "):
                        continue
                    raw = line[6:]
                    if raw == "[DONE]":
                        break
                    try:
                        chunk = json.loads(raw)
                        audio = chunk["choices"][0]["delta"].get("audio", {})
                        if audio.get("data"):
                            audio_chunks.append(audio["data"])
                    except (json.JSONDecodeError, KeyError, IndexError):
                        continue

        if not audio_chunks:
            logger.warning("TTS: no audio chunks received from OpenRouter")
            return Response(
                content=b"No audio data returned",
                status_code=503,
                media_type="text/plain",
                headers={"X-TTS-Error": "empty audio stream"},
            )

        audio_bytes = base64.b64decode("".join(audio_chunks))
        logger.info(
            "TTS (gpt-4o-audio, %s) %d bytes for %d chars",
            req.voice, len(audio_bytes), len(spoken),
        )
        return Response(content=audio_bytes, media_type="audio/mpeg")

    except Exception as e:
        logger.warning("TTS failed: %s", e)
        return Response(
            content=str(e).encode(),
            status_code=503,
            media_type="text/plain",
        )
