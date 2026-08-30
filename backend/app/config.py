import os
from typing import Union

import httpx
from dotenv import load_dotenv

load_dotenv()


def parse_cors_origins(value: str | None) -> list[str]:
    """Parse a comma-separated CORS allow-list with safe local defaults."""
    if value is None:
        return ["http://localhost:5173", "http://127.0.0.1:5173"]
    return [origin.strip() for origin in value.split(",") if origin.strip()]


# Local Vite development needs cross-origin requests. Docker uses the Nginx
# same-origin proxy, while shared deployments must set their explicit origin.
CORS_ORIGINS = parse_cors_origins(os.getenv("CORS_ORIGINS"))

# xAI direct API — OpenAI SDK compatible, no proxy/VPN needed (accessible from HK)
XAI_API_KEY = os.getenv("XAI_API_KEY", "")
XAI_BASE_URL = "https://api.x.ai/v1"

# Active model — defaults to grok-4.20 non-reasoning (fast, ~3-5s per round)
# Switch to grok-4.20-0309-reasoning via Settings page or LLM_MODEL env var
# for extended thinking (~30-60s per round, better complex multi-step reasoning)
LLM_MODEL = os.getenv("LLM_MODEL", "grok-4.20-0309-non-reasoning")

# Fallback providers — tried in order on any-round provider outage,
# region restriction, or timeout. Each provider needs its own key (and
# OpenRouter additionally requires OPENROUTER_PROXY to avoid bans).
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "")
GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/openai/"

# OpenRouter routes to Kimi / MiniMax for the score-tier fallbacks.
# OPENROUTER_PROXY is REQUIRED — direct OpenRouter calls have historically
# resulted in account bans; entries depending on it are skipped silently
# when the proxy is unset.
OPENROUTER_API_KEY = os.getenv("OPENROUTER_API_KEY", "")
OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1"
OPENROUTER_PROXY = os.getenv("OPENROUTER_PROXY", "")

# Score-ordered fallback chain. Each entry is tried in order on any
# provider outage / region error / timeout. Entries whose provider key
# (or proxy, for OpenRouter) is unconfigured are skipped silently, so
# the chain degrades gracefully on minimal deployments.
# Scores are mean across 6 prompts × 3 runs from the v3 benchmark
# (docs/bench-2026-04-26.md).
FALLBACK_CHAIN: list[dict] = [
    {"model": "moonshotai/kimi-k2-0905", "provider": "openrouter", "score": 70.2},
    {"model": "minimax/minimax-m2.7",    "provider": "openrouter", "score": 63.4},
    {"model": "gemini-3.1-pro-preview",  "provider": "google",     "score": 32.6},
]

# Backwards-compat alias for the previous single-fallback API surface
# (read by eval_runner.py and patched directly by test_llm_loop.py).
# Defaults to the last (most-available) chain entry — Gemini, which
# does not depend on OpenRouter.
FALLBACK_LLM_MODEL = os.getenv(
    "FALLBACK_LLM_MODEL", FALLBACK_CHAIN[-1]["model"]
)

# Context pruning: how many recent tool rounds to keep in full.
# Reasoning models need more historical context (geocode + flight data referenced
# in later rounds) so they get 3; non-reasoning batches aggressively and only needs 2.
_model_lower = (LLM_MODEL or "").lower()
PRUNE_KEEP_ROUNDS: int = 3 if ("reasoning" in _model_lower and "non-reasoning" not in _model_lower) else 2

# Google Maps Platform — single key for Places, Routes, Weather, Geocoding, Time Zone
GOOGLE_MAPS_API_KEY = os.getenv("GOOGLE_MAPS_API_KEY", "")

# Local VPN/proxy for routing external API calls (e.g. Clash on port 7897).
# Leave empty to connect directly.
HTTPS_PROXY: str = os.getenv("HTTPS_PROXY", "")


def make_http_client(
    timeout: Union[float, httpx.Timeout] = 15.0, **extra,
) -> httpx.AsyncClient:
    """Return an AsyncClient with the configured proxy (if any).

    All callers set trust_env=False, so the proxy must be passed explicitly.
    Extra kwargs (e.g. follow_redirects) are forwarded to httpx.AsyncClient.
    """
    kwargs: dict = {"timeout": timeout, "trust_env": False, **extra}
    if HTTPS_PROXY:
        kwargs["proxy"] = HTTPS_PROXY
    return httpx.AsyncClient(**kwargs)


def check_key(value: str) -> bool:
    """Return True if a key looks set (non-empty and not a placeholder)."""
    if not value:
        return False
    placeholders = ("sk-or-v1-...", "AIzaSy-...", "xai-...", "your-")
    return not any(value.startswith(p) for p in placeholders)
