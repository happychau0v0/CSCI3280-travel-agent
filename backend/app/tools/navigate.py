"""navigate_menu — a no-op tool the LLM can call to drive the frontend menu.

This tool exists purely for its side effect on the SSE stream. When the LLM
calls it, the backend emits a special ``navigate`` event before the (no-op)
"execution" finishes. The frontend's ``streamChat`` consumer listens for that
event and updates its menu state machine — switching the active panel,
moving the list cursor, applying a sort filter.

The tool itself just echoes its arguments so the LLM gets a clean confirmation
back as the "tool result", which it can include in the conversation history.
"""
from __future__ import annotations

VALID_PANELS = {"FLIGHTS", "HOTELS", "DAYS"}


async def navigate_menu(
    panel: str,
    item: str | None = None,
    filter: dict | None = None,
) -> dict:
    """Move the user's menu cursor to a specific panel/item.

    Args:
        panel: one of FLIGHTS, HOTELS, DAYS
        item: optional identifier — for FLIGHTS pass a type ("non-stop"),
              for HOTELS pass a hotel name, for DAYS pass a day number
        filter: optional sort/filter dict, e.g. {"sort": "price_asc"}

    Returns:
        {"navigated": True, "panel": ..., "item": ..., "filter": ...}
        or {"error": "..."} if the panel name is unknown.
    """
    panel_upper = (panel or "").strip().upper()
    if panel_upper not in VALID_PANELS:
        return {
            "error": (
                f"Unknown panel '{panel}'. Valid panels: "
                + ", ".join(sorted(VALID_PANELS))
            )
        }
    return {
        "navigated": True,
        "panel": panel_upper,
        "item": item,
        "filter": filter,
    }
