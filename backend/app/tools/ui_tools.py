"""
UI control tools — allow the LLM to change app settings and submit the trip form.

These tools don't call external APIs; they return a simple acknowledgement that
the SSE stream echoes to the frontend, which handles the actual state update.
"""

VALID_SETTINGS = {"tts_enabled", "theme", "currency", "subtitle_size", "auto_replan"}


async def toggle_setting(setting: str, value) -> dict:
    """Signal the frontend to apply a settings change."""
    if setting not in VALID_SETTINGS:
        return {"ok": False, "error": f"Unknown setting: {setting}. Valid: {sorted(VALID_SETTINGS)}"}
    return {"ok": True, "setting": setting, "value": value}


async def submit_trip_form(
    destination: str = "",
    origin: str = "",
    start_date: str = "",
    end_date: str = "",
    transport: str = "",
    party_size: int = 0,
    interests: str = "",
) -> dict:
    """Signal the frontend to pre-fill the trip form and start planning."""
    prefill = {}
    if destination:
        prefill["destination"] = destination
    if origin:
        prefill["origin"] = origin
    if start_date:
        prefill["start_date"] = start_date
    if end_date:
        prefill["end_date"] = end_date
    if transport:
        prefill["transport"] = transport
    if party_size:
        prefill["party_size"] = party_size
    if interests:
        prefill["interests"] = interests
    return {"ok": True, "action": "submit_trip_form", "prefill": prefill}
