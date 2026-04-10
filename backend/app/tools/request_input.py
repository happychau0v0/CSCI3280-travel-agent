"""request_input — no-op tool the LLM can call to ask the user for a
structured value via the UI instead of via a voice round-trip.

When the LLM needs a single field from the user — transport mode,
destination, dates — calling ``request_input`` causes the backend to
emit a ``request_input`` SSE event. The frontend's chat stream handler
sees the event, switches to the TRIP panel, focuses the requested
field with a pulsing glow, and displays the prompt as a subtitle.
The user fills in the value, presses PLAN/Enter, and the value is
sent back as a follow-up chat message.

The tool itself just echoes its arguments — there's no real work
to do server-side. The side effect is the SSE event the LLM loop
emits before returning the (no-op) tool result.
"""
from __future__ import annotations

VALID_FIELDS = {
    "destination",
    "start_date",
    "end_date",
    "transport",
    "party_size",
    "interests",
    "origin",
}


async def request_input(
    field: str,
    prompt: str,
    options: list | None = None,
) -> dict:
    """Ask the user to fill in a specific TRIP form field via the UI.

    Args:
        field: which field to focus — one of destination, start_date,
               end_date, transport, party_size, interests, origin
        prompt: short prompt to display to the user
                ("Driving, transit, or walking?")
        options: optional list of choices for select-style fields

    Returns:
        {"requested": True, "field": ..., "prompt": ..., "options": ...}
        or {"error": "..."} if the field is unknown.
    """
    field_lower = (field or "").strip().lower()
    if field_lower not in VALID_FIELDS:
        return {
            "error": (
                f"Unknown field '{field}'. Valid fields: "
                + ", ".join(sorted(VALID_FIELDS))
            )
        }
    return {
        "requested": True,
        "field": field_lower,
        "prompt": prompt,
        "options": options,
    }
