"""Flight search tool — real Google Flights data via fast-flights, with
deterministic haversine estimator as fallback.

The fast-flights library reverse-engineers Google Flights' internal protobuf
URL parameters to fetch real airline pricing. It works most of the time but
occasionally returns 401 "no token provided" when Google rotates auth — for
those moments we fall back to a deterministic price band derived from the
great-circle distance and the time of year. The user always sees a Google
Flights deep link they can click to verify live prices.

Output schema (always present, even on fallback):
    {
        "from_city": "Hong Kong",
        "from_iata": "HKG",
        "to_city": "Tokyo",
        "to_iata": "NRT",
        "date": "2026-05-15",
        "currency": "USD",
        "results": [...],          # empty list if fallback
        "estimate_low": 380,
        "estimate_high": 650,
        "duration_min": 235,
        "stops_typical": 0,
        "source": "fast-flights" | "estimator",
        "google_flights_url": "https://www.google.com/travel/flights?q=...",
    }
"""
from __future__ import annotations

import asyncio
import logging
import math
from datetime import datetime, timezone
from urllib.parse import quote_plus

from app.tools.airports import lookup as lookup_airport

logger = logging.getLogger(__name__)


# ─── Estimator ────────────────────────────────────────────────────────────


def _haversine_km(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    """Great-circle distance in kilometers."""
    r = 6371.0
    phi1 = math.radians(lat1)
    phi2 = math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlambda = math.radians(lng2 - lng1)
    a = math.sin(dphi / 2) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(dlambda / 2) ** 2
    return r * 2 * math.asin(math.sqrt(a))


# Per-month seasonality multiplier — high in northern-hemisphere summer and
# December holidays, lower in shoulder months. Calibrated against Google
# Flights medians for HKG-NRT, NYC-LON, SFO-LAX over a year.
_SEASON_MULT = {
    1: 0.95, 2: 0.90, 3: 0.95, 4: 1.00, 5: 1.05, 6: 1.20,
    7: 1.30, 8: 1.30, 9: 1.05, 10: 1.00, 11: 0.95, 12: 1.25,
}


# Fixed currency conversion for the demo. A live FX feed would be nicer but
# adds yet another flaky dependency; the rate moves <2% week-over-week so
# the estimator's ±30% confidence band swallows any drift.
HKD_PER_USD = 7.78


def _to_hkd(usd: float) -> int:
    """Convert USD to a whole HKD amount, rounded to the nearest 10 HKD."""
    hkd = usd * HKD_PER_USD
    return int(round(hkd / 10) * 10)


def _base_price_usd(distance_km: float) -> float:
    """Piecewise base price by distance band, calibrated to median fares."""
    if distance_km < 500:
        return 80
    if distance_km < 1500:
        return 140
    if distance_km < 4000:
        return 280
    if distance_km < 8000:
        return 520
    if distance_km < 12000:
        return 780
    return 1100


def _typical_duration_min(distance_km: float) -> int:
    """Average wheels-up to wheels-down for a non-stop, including taxi."""
    cruise_kmh = 850
    overhead_min = 30  # taxi + climb + descent
    return int((distance_km / cruise_kmh) * 60 + overhead_min)


def _build_options(distance_km: float, when: str | None) -> list[dict]:
    """Return 1-3 flight options (non-stop, 1-stop, 1-stop budget) in HKD.

    Short hops (< 2000 km) only get the non-stop option since connecting
    flights would take longer than driving and don't make economic sense.
    Medium and long-haul routes get all three options so the user can
    compare convenience vs price.
    """
    base_usd = _base_price_usd(distance_km)
    month = datetime.now(timezone.utc).month
    if when:
        try:
            month = datetime.fromisoformat(when).month
        except ValueError:
            pass
    mult = _SEASON_MULT.get(month, 1.0)
    median_usd = base_usd * mult
    duration_direct = _typical_duration_min(distance_km)

    # Non-stop is always present.
    options = [
        {
            "type": "non-stop",
            "label": "Non-stop",
            "price_low": _to_hkd(median_usd * 0.85),
            "price_high": _to_hkd(median_usd * 1.30),
            "duration_min": duration_direct,
            "stops": 0,
            "recommended": True,
        }
    ]

    if distance_km >= 2000:
        # 1-stop "convenient" — slightly cheaper, longer due to layover
        options.append(
            {
                "type": "1-stop",
                "label": "1 stop",
                "price_low": _to_hkd(median_usd * 0.65),
                "price_high": _to_hkd(median_usd * 1.05),
                "duration_min": duration_direct + 90,
                "stops": 1,
                "recommended": False,
            }
        )
        # 1-stop "budget" — cheapest, longest layover
        options.append(
            {
                "type": "1-stop budget",
                "label": "1 stop · budget",
                "price_low": _to_hkd(median_usd * 0.50),
                "price_high": _to_hkd(median_usd * 0.85),
                "duration_min": duration_direct + 180,
                "stops": 1,
                "recommended": False,
            }
        )

    return options


# ─── Google Flights deep link ─────────────────────────────────────────────


def _google_flights_url(from_iata: str, to_iata: str, date: str | None) -> str:
    """Build a Google Flights URL with origin / destination / date pre-filled."""
    parts = [f"Flights from {from_iata} to {to_iata}"]
    if date:
        parts.append(f"on {date}")
    q = quote_plus(" ".join(parts))
    return f"https://www.google.com/travel/flights?q={q}"


# ─── fast-flights call (best-effort) ──────────────────────────────────────


def _try_fast_flights(from_iata: str, to_iata: str, date: str) -> list[dict]:
    """Synchronously call fast-flights. Returns [] on any error.

    Wrapped in asyncio.to_thread by the caller so we don't block the loop.
    """
    try:
        from fast_flights import FlightData, Passengers, get_flights
    except ImportError:
        logger.info("fast-flights not installed; using estimator")
        return []

    try:
        result = get_flights(
            flight_data=[FlightData(date=date, from_airport=from_iata, to_airport=to_iata)],
            trip="one-way",
            passengers=Passengers(adults=1),
            seat="economy",
            fetch_mode="common",
        )
    except Exception as e:
        logger.info("fast-flights failed: %s", e)
        return []

    flights = []
    for f in (result.flights or [])[:5]:
        flights.append(
            {
                "airline": f.name,
                "price": f.price,
                "duration": f.duration,
                "stops": f.stops,
                "departure": f.departure,
                "arrival": f.arrival,
                "is_best": getattr(f, "is_best", False),
            }
        )
    return flights


# ─── The tool itself ──────────────────────────────────────────────────────


async def search_flights(
    origin: str,
    destination: str,
    date: str | None = None,
) -> dict:
    """Search for flights between two cities.

    The agent should pass natural-language city names ("Hong Kong", "Tokyo",
    "Paris"). We resolve them to IATA codes via the bundled airport table.
    If a city isn't in the table the call returns an error dict so the LLM
    can recover.
    """
    from_entry = lookup_airport(origin)
    to_entry = lookup_airport(destination)

    if not from_entry:
        return {"error": f"Unknown origin city: {origin}. Try a major city name."}
    if not to_entry:
        return {"error": f"Unknown destination city: {destination}. Try a major city name."}

    from_iata, from_name, from_lat, from_lng = from_entry
    to_iata, to_name, to_lat, to_lng = to_entry

    # Default to ~30 days from today if no date supplied so we get realistic
    # advance-purchase pricing instead of last-minute spikes.
    if not date:
        from datetime import timedelta
        date = (datetime.now(timezone.utc) + timedelta(days=30)).date().isoformat()

    distance_km = _haversine_km(from_lat, from_lng, to_lat, to_lng)
    options = _build_options(distance_km, date)
    deep_link = _google_flights_url(from_iata, to_iata, date)

    # Best-effort live data via fast-flights (offloaded to a thread).
    live = await asyncio.to_thread(_try_fast_flights, from_iata, to_iata, date)
    source = "fast-flights" if live else "estimator"

    # Top-level summary fields point at the recommended (non-stop) option so
    # FlightCards that don't iterate options still render meaningful values.
    primary = options[0]

    return {
        "from_city": origin.split(",")[0].strip(),
        "from_iata": from_iata,
        "from_name": from_name,
        "from_lat": from_lat,
        "from_lng": from_lng,
        "to_city": destination.split(",")[0].strip(),
        "to_iata": to_iata,
        "to_name": to_name,
        "to_lat": to_lat,
        "to_lng": to_lng,
        "date": date,
        "distance_km": round(distance_km),
        "currency": "HKD",
        "results": live,
        "options": options,
        "estimate_low": primary["price_low"],
        "estimate_high": primary["price_high"],
        "duration_min": primary["duration_min"],
        "stops_typical": primary["stops"],
        "source": source,
        "google_flights_url": deep_link,
    }
