import os

from dotenv import load_dotenv

load_dotenv()

# xAI direct API — OpenAI SDK compatible, no proxy/VPN needed (accessible from HK)
XAI_API_KEY = os.getenv("XAI_API_KEY", "")
XAI_BASE_URL = "https://api.x.ai/v1"

# Active model — defaults to grok-4.20 non-reasoning (fast, ~3-5s per round)
# Switch to grok-4.20-0309-reasoning via Settings page or LLM_MODEL env var
# for extended thinking (~30-60s per round, better complex multi-step reasoning)
LLM_MODEL = os.getenv("LLM_MODEL", "grok-4.20-0309-non-reasoning")

# Fallback model used when xAI is down (outage) or geo-restricted.
# Points to Gemini on Google's OpenAI-compatible endpoint — different
# provider entirely so it stays up when xAI is having an outage.
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "")
GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/openai/"
FALLBACK_LLM_MODEL = os.getenv("FALLBACK_LLM_MODEL", "gemini-3.1-pro-preview")

# Context pruning: how many recent tool rounds to keep in full.
# Reasoning models need more historical context (geocode + flight data referenced
# in later rounds) so they get 3; non-reasoning batches aggressively and only needs 2.
_model_lower = (LLM_MODEL or "").lower()
PRUNE_KEEP_ROUNDS: int = 3 if ("reasoning" in _model_lower and "non-reasoning" not in _model_lower) else 2

# OpenRouter kept for reference — not used by default (account banned)
OPENROUTER_API_KEY = os.getenv("OPENROUTER_API_KEY", "")
OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1"
OPENROUTER_PROXY = os.getenv("OPENROUTER_PROXY", "")

# Google Maps Platform — single key for Places, Routes, Weather, Geocoding, Time Zone
GOOGLE_MAPS_API_KEY = os.getenv("GOOGLE_MAPS_API_KEY", "")


def check_key(value: str) -> bool:
    """Return True if a key looks set (non-empty and not a placeholder)."""
    if not value:
        return False
    placeholders = ("sk-or-v1-...", "AIzaSy-...", "xai-...", "your-")
    return not any(value.startswith(p) for p in placeholders)
