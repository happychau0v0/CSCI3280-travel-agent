"""Text-to-speech endpoint.

Uses Google Cloud Text-to-Speech API (Neural2 voices) for natural-sounding
output. The same GOOGLE_MAPS_API_KEY is used — it works if the Cloud TTS API
is enabled on the same GCP project. Falls back gracefully with 503 so the
frontend can degrade to browser SpeechSynthesis.
"""
import base64
import logging
import re

import httpx
from fastapi import APIRouter
from fastapi.responses import Response
from pydantic import BaseModel

from app.config import GOOGLE_MAPS_API_KEY, check_key

router = APIRouter(prefix="/speech", tags=["speech"])
logger = logging.getLogger(__name__)

# OpenAI voice alias → Google Neural2 voice name.
# Neural2 voices are trained on human speech and sound very natural.
_VOICE_MAP = {
    "nova":    "en-US-Neural2-H",   # warm female
    "shimmer": "en-US-Neural2-E",   # bright female
    "alloy":   "en-US-Neural2-D",   # neutral male
    "echo":    "en-US-Neural2-A",   # deep male
    "onyx":    "en-US-Neural2-J",   # authoritative male
    "fable":   "en-GB-Neural2-B",   # British female
}
_DEFAULT_VOICE = "en-US-Neural2-H"


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
    """Convert text to speech via Google Cloud Text-to-Speech (Neural2).

    Returns an MP3 audio blob. Falls back to 503 if the API key is not
    configured or if TTS API is not enabled, so the frontend can degrade
    gracefully to browser SpeechSynthesis.
    """
    if not check_key(GOOGLE_MAPS_API_KEY):
        return Response(
            content=b"",
            status_code=503,
            media_type="text/plain",
            headers={"X-TTS-Error": "GOOGLE_MAPS_API_KEY not configured"},
        )

    spoken = _clean(req.text)
    if not spoken:
        return Response(content=b"", status_code=204)

    google_voice = _VOICE_MAP.get(req.voice or "nova", _DEFAULT_VOICE)
    language_code = google_voice[:5]  # e.g. "en-US" or "en-GB"

    payload = {
        "input": {"text": spoken},
        "voice": {"languageCode": language_code, "name": google_voice},
        "audioConfig": {
            "audioEncoding": "MP3",
            "speakingRate": 1.1,   # slightly faster, more energetic
            "pitch": 2.0,          # +2 semitones — warmer, more animated
            "effectsProfileId": ["headphone-class-device"],
        },
    }

    try:
        # trust_env=False prevents httpx from routing through a local SOCKS
        # proxy (Clash, Shadowsocks) that would crash with "socksio not installed".
        async with httpx.AsyncClient(trust_env=False, timeout=12.0) as client:
            resp = await client.post(
                "https://texttospeech.googleapis.com/v1/text:synthesize",
                params={"key": GOOGLE_MAPS_API_KEY},
                json=payload,
            )

        if resp.status_code != 200:
            logger.warning(
                "Google TTS returned %d: %s", resp.status_code, resp.text[:200]
            )
            return Response(
                content=resp.text.encode(),
                status_code=503,
                media_type="text/plain",
                headers={"X-TTS-Error": f"Google TTS {resp.status_code}"},
            )

        audio_b64 = resp.json()["audioContent"]
        audio_bytes = base64.b64decode(audio_b64)
        logger.info("TTS (%s) generated %d bytes for %d chars",
                    google_voice, len(audio_bytes), len(spoken))
        return Response(content=audio_bytes, media_type="audio/mpeg")

    except Exception as e:
        logger.warning("TTS failed: %s", e)
        return Response(
            content=str(e).encode(),
            status_code=503,
            media_type="text/plain",
        )
