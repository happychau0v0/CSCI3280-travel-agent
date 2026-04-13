import os

from dotenv import load_dotenv

load_dotenv()

# LLM via OpenRouter (OpenAI SDK compatible)
OPENROUTER_API_KEY = os.getenv("OPENROUTER_API_KEY", "")
LLM_MODEL = os.getenv("LLM_MODEL", "x-ai/grok-4.20")
OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1"

# Google Maps Platform — single key for Places, Routes, Weather, Geocoding, Time Zone
GOOGLE_MAPS_API_KEY = os.getenv("GOOGLE_MAPS_API_KEY", "")


def check_key(value: str) -> bool:
    """Return True if a key looks set (non-empty and not a placeholder)."""
    if not value:
        return False
    placeholders = ("sk-or-v1-...", "AIzaSy-...", "your-")
    return not any(value.startswith(p) for p in placeholders)
