"""
Visa requirements endpoint.

Returns visa status for a given destination country based on the traveller's
passport.

Data sources (loaded once at import, cached for the process lifetime):
- visa_hk.json        — manually verified HK passport data with detailed notes
- passport-index.json — imorte/passport-index-data dataset covering 199 passports
                        (MIT licence, updated Feb 2026)

Status values returned:
  visa_free       — no visa needed for up to free_days days
  visa_on_arrival — visa obtainable on arrival; free_days is the stay limit
  e_visa          — electronic visa required before travel
  eta             — Electronic Travel Authorization required before departure
  visa_required   — must obtain visa before travel
  unknown         — no data for this passport/destination pair
"""

import json
import pathlib

from fastapi import APIRouter, Query

router = APIRouter()

_DATA_DIR = pathlib.Path(__file__).parent.parent / "data"

with open(_DATA_DIR / "visa_hk.json", encoding="utf-8") as _f:
    _VISA_HK: dict = json.load(_f)

with open(_DATA_DIR / "passport-index.json", encoding="utf-8") as _f:
    _PASSPORT_INDEX: dict = json.load(_f)

# Map imorte dataset status strings → our internal status values + optional notes
_STATUS_MAP: dict[str, dict] = {
    "visa free":        {"status": "visa_free"},
    "visa on arrival":  {"status": "visa_on_arrival"},
    "visa required":    {"status": "visa_required"},
    "e-visa":           {"status": "e_visa",
                         "notes": "Electronic visa (e-visa) required — apply online before travel."},
    "eta":              {"status": "eta",
                         "notes": "Electronic Travel Authorization (ETA) required before departure."},
    "no admission":     {"status": "visa_required",
                         "notes": "Entry is not permitted with this passport."},
}


def _from_index(passport: str, destination: str) -> dict:
    """Look up a passport/destination pair from the global passport-index dataset."""
    passport_data = _PASSPORT_INDEX.get(passport)
    if not passport_data:
        return {"status": "unknown", "notes": f"No visa data available for {passport} passport."}

    raw = passport_data.get(destination)
    if not raw:
        return {"status": "unknown", "notes": f"No visa data for {passport}→{destination}."}

    entry = dict(_STATUS_MAP.get(raw.get("status", ""), {"status": "unknown"}))
    if "days" in raw:
        entry["free_days"] = raw["days"]
    return entry


@router.get("/check")
async def check_visa(
    destination: str = Query(..., description="ISO 3166-1 alpha-2 destination country code (e.g. JP, TH, GB)"),
    passport: str = Query("HK", description="ISO 3166-1 alpha-2 passport country code (e.g. HK, US, CN)"),
):
    """
    Check visa requirements for travelling to `destination` with `passport`.

    Returns a JSON object with at minimum a `status` field.
    Optional fields: `free_days` (int), `notes` (str).
    """
    passport_upper = passport.upper()
    destination_upper = destination.upper()

    if passport_upper == "HK":
        # HK passport: use our manually-verified dataset (richer notes)
        entry = {
            k: v for k, v in _VISA_HK.get(
                destination_upper,
                {"status": "unknown", "notes": "Country not found in HK visa database."},
            ).items()
            if not k.startswith("_")
        }
    else:
        entry = _from_index(passport_upper, destination_upper)

    return {"destination": destination_upper, "passport": passport_upper, **entry}
