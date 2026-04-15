"""Structured JSONL event logger for LLM session debugging.

Every SSE event emitted to the user plus tool results and the final reply
are written here so any session can be reconstructed from disk without a
live repro.

Log file: backend/logs/llm_events.jsonl
Format:   one JSON object per line
Rotation: 5 MB max, 5 backup files kept (25 MB total)

Usage:
    from app.event_log import log_event
    log_event(sid="a1b2c3d4", role="plan", event="done", data={...})
"""
from __future__ import annotations

import json
import logging
from datetime import datetime, timezone
from logging.handlers import RotatingFileHandler
from pathlib import Path

_log_dir = Path(__file__).resolve().parent.parent / "logs"
_log_dir.mkdir(exist_ok=True)

_handler = RotatingFileHandler(
    _log_dir / "llm_events.jsonl",
    maxBytes=5 * 1024 * 1024,  # 5 MB per file
    backupCount=5,
    encoding="utf-8",
)
# Formatter outputs the raw message only — the JSON line is the message.
_handler.setFormatter(logging.Formatter("%(message)s"))

_event_logger = logging.getLogger("llm_events")
_event_logger.setLevel(logging.DEBUG)
_event_logger.addHandler(_handler)
_event_logger.propagate = False  # don't bleed into app.log


def log_event(sid: str, role: str | None, event: str, data: object) -> None:
    """Append one JSON line to llm_events.jsonl.

    Args:
        sid:   8-char hex session ID — unique per /chat/stream request.
               All events from one user turn share the same sid.
        role:  call_role from the request (plan / hotels / days / chat / None).
        event: event type string (tool_start, tool_result, navigate, done, …).
        data:  arbitrary payload — serialised with json.dumps(default=str)
               so non-serialisable objects (e.g. datetimes) degrade gracefully.
    """
    record = {
        "ts": datetime.now(timezone.utc).isoformat(timespec="milliseconds"),
        "sid": sid,
        "role": role,
        "event": event,
        "data": data,
    }
    _event_logger.info(json.dumps(record, default=str))
