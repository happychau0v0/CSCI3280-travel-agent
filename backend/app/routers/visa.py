"""
Visa requirements endpoint.

Returns visa status for a given destination country based on the traveller's
passport. Currently only HK (HKSAR) passport has real data; all other passports
return a placeholder "unknown" response.

Data is loaded once at module import time and cached for the process lifetime.
To add a new passport, create backend/app/data/visa_{iso2_lower}.json with the
same schema as visa_hk.json and add a branch in check_visa().
"""

import json
import pathlib

from fastapi import APIRouter, Query

router = APIRouter()

_DATA_DIR = pathlib.Path(__file__).parent.parent / "data"

with open(_DATA_DIR / "visa_hk.json", encoding="utf-8") as _f:
    _VISA_HK: dict = json.load(_f)

with open(_DATA_DIR / "visa_mock.json", encoding="utf-8") as _f:
    _VISA_MOCK: dict = json.load(_f)


@router.get("/check")
async def check_visa(
    destination: str = Query(..., description="ISO 3166-1 alpha-2 destination country code (e.g. JP, TH, GB)"),
    passport: str = Query("HK", description="ISO 3166-1 alpha-2 passport country code (e.g. HK, US, GB)"),
):
    """
    Check visa requirements for travelling to `destination` with `passport`.

    Returns a JSON object with at minimum a `status` field:
    - `visa_free`       — no visa needed for up to `free_days` days
    - `visa_on_arrival` — visa obtainable on arrival; `free_days` is stay limit
    - `visa_required`   — must obtain visa before travel
    - `unknown`         — no data available for this passport/destination pair

    Optional fields: `free_days` (int), `notes` (str).
    """
    passport_upper = passport.upper()
    destination_upper = destination.upper()

    if passport_upper == "HK":
        # Skip the internal comment key
        entry = {
            k: v for k, v in _VISA_HK.get(
                destination_upper,
                {"status": "unknown", "notes": "Country not found in HK visa database"},
            ).items()
            if not k.startswith("_")
        }
    else:
        entry = dict(_VISA_MOCK)

    return {"destination": destination_upper, "passport": passport_upper, **entry}
