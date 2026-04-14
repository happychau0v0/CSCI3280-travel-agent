import os

from dotenv import load_dotenv

load_dotenv()

# LLM via OpenRouter (OpenAI SDK compatible)
OPENROUTER_API_KEY = os.getenv("OPENROUTER_API_KEY", "")
LLM_MODEL = os.getenv("LLM_MODEL", "x-ai/grok-4.20")
# Fallback model used when the primary model is unavailable in the
# backend's region (e.g. grok-4.20 is US-only; users outside the US
# accessing via Tailscale hit a geo-restriction error).
FALLBACK_LLM_MODEL = os.getenv("FALLBACK_LLM_MODEL", "openai/gpt-4o-mini")
# Optional proxy for OpenRouter LLM calls. Set this when the backend
# runs outside the US and needs to reach geo-restricted models.
# Example: OPENROUTER_PROXY=http://127.0.0.1:7897  (Clash mixed port)
#          OPENROUTER_PROXY=socks5://127.0.0.1:7897
OPENROUTER_PROXY = os.getenv("OPENROUTER_PROXY", "")
OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1"

# Google Maps Platform — single key for Places, Routes, Weather, Geocoding, Time Zone
GOOGLE_MAPS_API_KEY = os.getenv("GOOGLE_MAPS_API_KEY", "")


def check_key(value: str) -> bool:
    """Return True if a key looks set (non-empty and not a placeholder)."""
    if not value:
        return False
    placeholders = ("sk-or-v1-...", "AIzaSy-...", "your-")
    return not any(value.startswith(p) for p in placeholders)
