import os

from dotenv import load_dotenv

load_dotenv()

# xAI direct API — OpenAI SDK compatible, no proxy/VPN needed (accessible from HK)
XAI_API_KEY = os.getenv("XAI_API_KEY", "")
XAI_BASE_URL = "https://api.x.ai/v1"

# Active model — defaults to grok-4.20 non-reasoning (fast, cost-efficient)
# Other options: grok-4.20-0309-reasoning, grok-4.20-multi-agent-0309
LLM_MODEL = os.getenv("LLM_MODEL", "grok-4.20-0309-non-reasoning")
FALLBACK_LLM_MODEL = os.getenv("FALLBACK_LLM_MODEL", "grok-4.20-0309-non-reasoning")

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
