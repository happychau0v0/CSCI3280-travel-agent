"""Service status endpoint.

Probes all external APIs concurrently and returns latency + health for each.
Used by the frontend ServiceStatusOverlay to give users instant diagnostics.
"""
import asyncio
import logging
import time
from datetime import datetime, timezone

import httpx
from fastapi import APIRouter

from app.config import (
    GOOGLE_MAPS_API_KEY,
    XAI_API_KEY,
    XAI_BASE_URL,
    check_key,
)

router = APIRouter(tags=["status"])
logger = logging.getLogger(__name__)

_DEGRADED_THRESHOLD_MS = 2000  # latency above this → "degraded" instead of "ok"


def _make_service(
    id: str,
    label: str,
    status: str,
    latency_ms: float,
    detail: str | None = None,
) -> dict:
    return {
        "id": id,
        "label": label,
        "status": status,
        "latency_ms": round(latency_ms, 1),
        "detail": detail,
    }


async def _probe_xai_llm() -> dict:
    """Probe xAI API reachability via GET /models (proves auth + connectivity)."""
    id_ = "xai_llm"
    label = "xAI LLM (grok-4.20)"

    if not check_key(XAI_API_KEY):
        return _make_service(id_, label, "unconfigured", 0.0, "XAI_API_KEY not set")

    t0 = time.perf_counter()
    try:
        async with httpx.AsyncClient(trust_env=False, timeout=5.0) as client:
            resp = await client.get(
                f"{XAI_BASE_URL}/models",
                headers={"Authorization": f"Bearer {XAI_API_KEY}"},
            )
        latency = (time.perf_counter() - t0) * 1000
        if resp.status_code != 200:
            return _make_service(id_, label, "error", latency, f"HTTP {resp.status_code}")
        status = "degraded" if latency >= _DEGRADED_THRESHOLD_MS else "ok"
        return _make_service(id_, label, status, latency)
    except Exception as e:
        latency = (time.perf_counter() - t0) * 1000
        logger.debug("xAI LLM probe failed: %s", e)
        return _make_service(id_, label, "error", latency, str(e))


async def _probe_xai_tts() -> dict:
    """Probe xAI TTS reachability — shares same key/base URL as LLM."""
    id_ = "xai_tts"
    label = "xAI TTS (ara)"

    if not check_key(XAI_API_KEY):
        return _make_service(id_, label, "unconfigured", 0.0, "XAI_API_KEY not set")

    t0 = time.perf_counter()
    try:
        async with httpx.AsyncClient(trust_env=False, timeout=5.0) as client:
            resp = await client.get(
                f"{XAI_BASE_URL}/models",
                headers={"Authorization": f"Bearer {XAI_API_KEY}"},
            )
        latency = (time.perf_counter() - t0) * 1000
        if resp.status_code != 200:
            return _make_service(id_, label, "error", latency, f"HTTP {resp.status_code}")
        status = "degraded" if latency >= _DEGRADED_THRESHOLD_MS else "ok"
        return _make_service(id_, label, status, latency)
    except Exception as e:
        latency = (time.perf_counter() - t0) * 1000
        logger.debug("xAI TTS probe failed: %s", e)
        return _make_service(id_, label, "error", latency, str(e))


async def _probe_google_maps() -> dict:
    """Probe Google Maps via a cheap geocoding lookup."""
    id_ = "google_maps"
    label = "Google Maps Platform"

    if not check_key(GOOGLE_MAPS_API_KEY):
        return _make_service(id_, label, "unconfigured", 0.0, "GOOGLE_MAPS_API_KEY not set")

    t0 = time.perf_counter()
    try:
        async with httpx.AsyncClient(trust_env=False, timeout=5.0) as client:
            resp = await client.get(
                "https://maps.googleapis.com/maps/api/geocode/json",
                params={"address": "London", "key": GOOGLE_MAPS_API_KEY},
            )
        latency = (time.perf_counter() - t0) * 1000
        if resp.status_code != 200:
            return _make_service(id_, label, "error", latency, f"HTTP {resp.status_code}")
        body = resp.json()
        api_status = body.get("status", "")
        if api_status not in ("OK", "ZERO_RESULTS"):
            return _make_service(id_, label, "error", latency, f"API status: {api_status}")
        status = "degraded" if latency >= _DEGRADED_THRESHOLD_MS else "ok"
        return _make_service(id_, label, status, latency)
    except Exception as e:
        latency = (time.perf_counter() - t0) * 1000
        logger.debug("Google Maps probe failed: %s", e)
        return _make_service(id_, label, "error", latency, str(e))


@router.get("/status")
async def get_status():
    """Probe all external APIs concurrently and return health + latency."""
    results = await asyncio.gather(
        _probe_xai_llm(),
        _probe_xai_tts(),
        _probe_google_maps(),
    )
    overall = "ok" if all(r["status"] == "ok" for r in results) else "degraded"
    return {
        "overall": overall,
        "services": list(results),
        "checked_at": datetime.now(timezone.utc).isoformat(),
    }
