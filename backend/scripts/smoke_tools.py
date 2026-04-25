#!/usr/bin/env python3
"""Live smoke harness for every tool in TOOL_DISPATCH.

Runs each tool once against the real APIs, prints a pass/fail + latency
row, and exits non-zero if any tool hard-fails. ⚠ (warn) is reserved for
"tool didn't raise but fell back to a degraded path" — search_flights
is the main example when live scraping times out.

Usage:
    cd backend && .venv/bin/python scripts/smoke_tools.py
"""
from __future__ import annotations

import asyncio
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

# Let this script run from anywhere under backend/.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.tools import TOOL_DISPATCH  # noqa: E402


# ─── per-tool assertions ──────────────────────────────────────────────────


def check_geocode(r):
    if not isinstance(r, dict) or "lat" not in r or "lng" not in r:
        return "❌", f"bad shape: {type(r).__name__}"
    if abs(r["lat"] - 35.68) > 1.0:
        return "❌", f"lat {r['lat']} not near Tokyo"
    return "✅", f"lat={r['lat']:.4f} lng={r['lng']:.4f}"


def check_places(r):
    if not isinstance(r, list):
        return "❌", f"expected list, got {type(r).__name__}"
    if len(r) < 3:
        return "❌", f"only {len(r)} places"
    first = r[0]
    if not first.get("place_id") or first.get("lat") is None:
        return "❌", "first place missing place_id or lat"
    return "✅", f"{len(r)} places, first={first.get('name', '?')[:30]}"


def check_details(r):
    if not isinstance(r, dict):
        return "❌", f"expected dict, got {type(r).__name__}"
    # Details can legitimately be thin; just require the id echo
    if not r.get("place_id") and not r.get("name"):
        return "❌", "no place_id or name in details"
    reviews = len(r.get("reviews") or [])
    photos = len(r.get("photos") or [])
    return "✅", f"{reviews} reviews, {photos} photos"


def check_directions(r):
    if not isinstance(r, dict):
        return "❌", f"expected dict, got {type(r).__name__}"
    if not r.get("duration") or not r.get("distance"):
        return "❌", f"empty duration/distance: {r}"
    return "✅", f"{r['duration']}, {r['distance']}"


def check_weather(r):
    if not isinstance(r, dict) or r.get("error"):
        return "❌", str(r)[:80]
    if "temp" not in r or "forecast" not in r:
        return "❌", f"missing keys: {list(r.keys())}"
    temp = r.get("temp")
    forecast = r.get("forecast") or []
    return "✅", f"temp={temp}, {len(forecast)}-day forecast"


def check_flights(r):
    if not isinstance(r, dict):
        return "❌", f"expected dict, got {type(r).__name__}"
    if r.get("error"):
        return "❌", r["error"]
    opts = r.get("options") or []
    if len(opts) < 3:
        return "❌", f"only {len(opts)} options"
    src = r.get("source", "?")
    status = "⚠" if src == "estimator" else "✅"
    detail = f"{len(opts)} options, source={src}"
    return status, detail


def check_day_windows(r):
    if not isinstance(r, list):
        return "❌", f"expected list, got {type(r).__name__}"
    if len(r) != 3:
        return "❌", f"got {len(r)} windows, expected 3"
    for w in r:
        if not w.get("start_time") or not w.get("end_time"):
            return "❌", f"window missing times: {w}"
    return "✅", f"{len(r)} windows, day1 {r[0]['start_time']}-{r[0]['end_time']}"


def check_phrasebook(r):
    if not isinstance(r, dict) or r.get("error"):
        return "❌", str(r)[:80]
    phrases = r.get("phrases") or []
    if len(phrases) < 5:
        return "❌", f"only {len(phrases)} phrases"
    return "✅", f"{len(phrases)} phrases, lang={r.get('language_code', '?')}"


def check_ack(r):
    if not isinstance(r, dict):
        return "❌", f"expected dict, got {type(r).__name__}"
    if r.get("ok") is False or r.get("error"):
        return "❌", str(r)[:80]
    return "✅", "ack"


# ─── cases ────────────────────────────────────────────────────────────────

FUTURE_DATE = (datetime.now(timezone.utc) + timedelta(days=30)).date().isoformat()


def build_cases(place_id_holder):
    """Build the case list. `place_id_holder` is a 1-item list we mutate
    after search_places runs so get_place_details uses a live id."""
    return [
        ("geocode_city", {"query": "Tokyo, Japan"}, check_geocode),
        ("search_places", {"query": "ramen", "location": "Tokyo"}, check_places),
        ("get_place_details", place_id_holder, check_details),  # resolved later
        ("get_directions", {"origin": "Shibuya Station, Tokyo",
                             "destination": "Tokyo Station",
                             "mode": "TRANSIT"}, check_directions),
        ("get_weather", {"city": "Tokyo"}, check_weather),
        ("search_flights", {"origin": "Hong Kong", "destination": "Tokyo",
                             "date": FUTURE_DATE}, check_flights),
        ("get_day_windows", {
            "trip_days": 3,
            "start_date": FUTURE_DATE,
            "flight": {"arrival": "14:30", "departure": "18:00",
                        "to_lat": 35.76, "to_lng": 140.39, "to_iata": "NRT",
                        "to_city": "Tokyo"},
        }, check_day_windows),
        ("get_phrasebook", {"destination": "Tokyo"}, check_phrasebook),
        ("navigate_menu", {"panel": "HOTELS"}, check_ack),
        ("toggle_setting", {"setting": "theme", "value": "light"}, check_ack),
        ("submit_trip_form", {"destination": "Tokyo"}, check_ack),
        ("request_input", {"field": "destination", "prompt": "Where?"}, check_ack),
    ]


async def run_one(name, args, check):
    fn = TOOL_DISPATCH.get(name)
    if fn is None:
        return (name, "❌", 0, "not in TOOL_DISPATCH")
    t0 = time.perf_counter()
    try:
        result = await fn(**args)
        elapsed = (time.perf_counter() - t0) * 1000
        status, detail = check(result)
        return (name, status, elapsed, detail)
    except Exception as e:
        elapsed = (time.perf_counter() - t0) * 1000
        return (name, "❌", elapsed, f"{type(e).__name__}: {e}")


async def main() -> int:
    # search_places must run before get_place_details so we have a real
    # place_id. Run the first two sequentially, then the rest in parallel.
    places_case = ("search_places", {"query": "ramen", "location": "Tokyo"}, check_places)
    places_result = await run_one(*places_case)

    # Extract the first place_id for details, if places succeeded
    place_id = None
    if places_result[1] == "✅":
        fn = TOOL_DISPATCH["search_places"]
        try:
            raw = await fn(**places_case[1])
            if isinstance(raw, list) and raw:
                place_id = raw[0].get("place_id")
        except Exception:
            pass

    details_args = {"place_id": place_id} if place_id else {"place_id": "ChIJ_dummy"}

    cases = [
        ("geocode_city", {"query": "Tokyo, Japan"}, check_geocode),
        ("get_place_details", details_args, check_details),
        ("get_directions", {"origin": "Shibuya Station, Tokyo",
                             "destination": "Tokyo Station",
                             "mode": "TRANSIT"}, check_directions),
        ("get_weather", {"city": "Tokyo"}, check_weather),
        ("search_flights", {"origin": "Hong Kong", "destination": "Tokyo",
                             "date": FUTURE_DATE}, check_flights),
        ("get_day_windows", {
            "trip_days": 3,
            "start_date": FUTURE_DATE,
            "flight": {"arrival": "14:30", "departure": "18:00",
                        "to_lat": 35.76, "to_lng": 140.39, "to_iata": "NRT",
                        "to_city": "Tokyo"},
        }, check_day_windows),
        ("get_phrasebook", {"destination": "Tokyo"}, check_phrasebook),
        ("navigate_menu", {"panel": "HOTELS"}, check_ack),
        ("toggle_setting", {"setting": "theme", "value": "light"}, check_ack),
        ("submit_trip_form", {"destination": "Tokyo"}, check_ack),
        ("request_input", {"field": "destination", "prompt": "Where?"}, check_ack),
    ]

    results = await asyncio.gather(*(run_one(*c) for c in cases))
    results = [places_result] + list(results)

    # Pretty print
    total_ms = 0
    counts = {"✅": 0, "⚠": 0, "❌": 0}
    print()
    for name, status, ms, detail in results:
        print(f"{status} {name:<24} {int(ms):>5}ms   {detail}")
        total_ms += ms
        counts[status] = counts.get(status, 0) + 1
    print()
    print(f"{counts['✅']}/{len(results)} ✅   {counts['⚠']} ⚠   {counts['❌']} ❌"
          f"   total {int(total_ms)}ms")

    return 1 if counts["❌"] else 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
