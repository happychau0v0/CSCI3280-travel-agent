import os

from dotenv import load_dotenv

load_dotenv()

# ── LLM provider ────────────────────────────────────────────────────────────
# Supports two OpenAI-SDK-compatible providers:
#
#   provider=openrouter  (default)
#     Base URL : https://openrouter.ai/api/v1
#     Key env  : OPENROUTER_API_KEY
#     Models   : x-ai/grok-4.20, openai/gpt-4o-mini, google/gemini-2.5-flash …
#
#   provider=google
#     Base URL : https://generativelanguage.googleapis.com/v1beta/openai
#     Key env  : GOOGLE_AI_API_KEY  (Google AI Studio key — free tier available)
#     Models   : gemini-2.5-flash, gemini-2.0-flash, gemini-2.5-pro …
#     Get key  : https://aistudio.google.com/apikey
#
# Switch provider by setting LLM_PROVIDER=google in .env.

LLM_PROVIDER = os.getenv("LLM_PROVIDER", "openrouter")  # "openrouter" | "google"

# OpenRouter
OPENROUTER_API_KEY = os.getenv("OPENROUTER_API_KEY", "")
OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1"

# Google AI Studio (OpenAI-compatible endpoint)
GOOGLE_AI_API_KEY = os.getenv("GOOGLE_AI_API_KEY", "")
GOOGLE_AI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/openai"

# Resolved at startup based on LLM_PROVIDER
if LLM_PROVIDER == "google":
    LLM_API_KEY = GOOGLE_AI_API_KEY
    LLM_BASE_URL = GOOGLE_AI_BASE_URL
    _default_model = "gemini-2.5-flash"
else:
    LLM_API_KEY = OPENROUTER_API_KEY
    LLM_BASE_URL = OPENROUTER_BASE_URL
    _default_model = "x-ai/grok-4.20"

LLM_MODEL = os.getenv("LLM_MODEL", _default_model)

# Fallback model when primary is geo-restricted or unavailable.
# Google provider: gemini-2.0-flash is a safe global fallback.
# OpenRouter: gpt-4o-mini works globally.
_default_fallback = "gemini-2.0-flash" if LLM_PROVIDER == "google" else "openai/gpt-4o-mini"
FALLBACK_LLM_MODEL = os.getenv("FALLBACK_LLM_MODEL", _default_fallback)

# Optional proxy for LLM calls (needed when backend is outside the US and the
# primary model is geo-restricted). All Google Maps tool clients use
# trust_env=False so they bypass the proxy and hit Google directly.
# Example: OPENROUTER_PROXY=http://127.0.0.1:7897  (Clash mixed port)
OPENROUTER_PROXY = os.getenv("OPENROUTER_PROXY", "")

# Google Maps Platform — single key for Places, Routes, Weather, Geocoding, Time Zone
GOOGLE_MAPS_API_KEY = os.getenv("GOOGLE_MAPS_API_KEY", "")


def check_key(value: str) -> bool:
    """Return True if a key looks set (non-empty and not a placeholder)."""
    if not value:
        return False
    placeholders = ("sk-or-v1-...", "AIzaSy-...", "your-", "AI...")
    return not any(value.startswith(p) for p in placeholders)
