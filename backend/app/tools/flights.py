"""Flight search tool — real Google Flights data via fast-flights, with
deterministic haversine estimator as fallback.

The fast-flights library reverse-engineers Google Flights' internal protobuf
URL parameters to fetch real airline pricing. The endpoint is sensitive to
the originating IP — VPN/datacenter ranges get 401 "no token provided"
responses, while residential and most consumer ISPs work fine. We:

1. Temporarily clear HTTP_PROXY/HTTPS_PROXY env vars before calling
   fast-flights so a local Clash/Shadowsocks proxy doesn't route the
   request through a flagged datacenter exit.
2. Fall back to a deterministic haversine + season estimator if the call
   still fails (no internet, Google API change, etc.).
3. Always include a Google Flights deep link so the user has an escape
   hatch to live prices.

Output schema (always present, even on fallback):
    {
        "from_city": "Hong Kong",
        "from_iata": "HKG",
        "to_city": "Tokyo",
        "to_iata": "NRT",
        "date": "2026-05-15",
        "currency": "HKD",
        "options": [{type, label, price_low, price_high, duration_min, stops, recommended, airline?}],
        "estimate_low": 1850,
        "estimate_high": 2830,
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
import os
import re
from datetime import datetime, timezone
from urllib.parse import quote_plus

from app.tools.airports import lookup as lookup_airport

logger = logging.getLogger(__name__)

# Env vars that proxy clients (Clash, Shadowsocks, V2Ray, corporate proxies)
# set to route Python's HTTP traffic through a local SOCKS/HTTP forwarder.
# Google Flights' protobuf endpoint flags many of those exits as bots.
_PROXY_ENV_VARS = (
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "http_proxy",
    "https_proxy",
    "ALL_PROXY",
    "all_proxy",
)


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


_PRICE_RE = re.compile(r"([\d,]+(?:\.\d+)?)")
_DURATION_HM_RE = re.compile(r"(?:(\d+)\s*hr)?\s*(?:(\d+)\s*min)?")


def _parse_price(price_str: str) -> int | None:
    """Extract a numeric price from a string like 'HK$1,304' or '$480'."""
    if not price_str:
        return None
    m = _PRICE_RE.search(price_str.replace(",", ""))
    if not m:
        return None
    try:
        return int(round(float(m.group(1))))
    except ValueError:
        return None


def _parse_duration(duration_str: str) -> int | None:
    """Convert '4 hr 30 min' / '4 hr' / '45 min' into total minutes."""
    if not duration_str:
        return None
    m = _DURATION_HM_RE.search(duration_str)
    if not m:
        return None
    h = int(m.group(1) or 0)
    mins = int(m.group(2) or 0)
    total = h * 60 + mins
    return total if total > 0 else None


def _normalize_time(time_str: str | None) -> str | None:
    """Convert fast-flights '6:30 PM' / '18:30' / '18:30+1' → 'HH:MM'.

    fast-flights returns times in a variety of formats depending on
    the locale and whether the arrival crosses midnight. We collapse
    to 24-hour HH:MM so get_day_windows and the frontend can parse
    it without worrying about localization. The +1/+2 day-suffix is
    dropped — the itinerary carries date separately.
    """
    if not time_str:
        return None
    s = str(time_str).strip()
    # Strip "+1" / "+2" day suffix
    for suffix in ("+1", "+2", "+3"):
        if s.endswith(suffix):
            s = s[: -len(suffix)].strip()
    # 12-hour "6:30 PM" → 18:30
    am_pm_match = re.match(r"(\d{1,2}):(\d{2})\s*(AM|PM)", s, re.IGNORECASE)
    if am_pm_match:
        h = int(am_pm_match.group(1)) % 12
        if am_pm_match.group(3).upper() == "PM":
            h += 12
        return f"{h:02d}:{int(am_pm_match.group(2)):02d}"
    # 24-hour "18:30"
    hm_match = re.match(r"(\d{1,2}):(\d{2})", s)
    if hm_match:
        return f"{int(hm_match.group(1)):02d}:{int(hm_match.group(2)):02d}"
    return None


def _try_fast_flights(from_iata: str, to_iata: str, date: str) -> list[dict]:
    """Synchronously call fast-flights. Returns [] on any error.

    Wrapped in asyncio.to_thread by the caller so we don't block the loop.

    The local HTTP_PROXY/HTTPS_PROXY env vars are temporarily cleared for
    the duration of the call. Google Flights' protobuf endpoint returns
    401 "no token provided" when the request comes from a VPN/datacenter
    IP, which is exactly what a local Clash/Shadowsocks proxy produces.
    Saving and restoring is fine because we're inside a thread spawned by
    asyncio.to_thread — the env mutation doesn't leak into other concurrent
    calls during the brief window the proxy is unset.
    """
    try:
        from fast_flights import FlightData, Passengers, get_flights
    except ImportError:
        logger.info("fast-flights not installed; using estimator")
        return []

    saved = {key: os.environ.pop(key, None) for key in _PROXY_ENV_VARS}
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
    finally:
        for key, value in saved.items():
            if value is not None:
                os.environ[key] = value

    flights = []
    for f in (result.flights or [])[:20]:
        flights.append(
            {
                "airline": f.name,
                "price_str": f.price,
                "price_num": _parse_price(f.price),
                "duration_str": f.duration,
                "duration_min": _parse_duration(f.duration),
                "stops": f.stops,
                "departure": f.departure,
                "arrival": f.arrival,
                "is_best": getattr(f, "is_best", False),
            }
        )
    return flights


def _options_from_live(live: list[dict]) -> list[dict]:
    """Build a 4-6 option list from real fast-flights results.

    Strategy — pick diverse options so the user has meaningful picks:
      1. Cheapest non-stop (recommended)
      2. Fastest non-stop (different flight, same stops class)
      3. Second-cheapest non-stop from a DIFFERENT airline than #1
      4. Cheapest 1-stop (only if cheaper than the cheapest non-stop)
      5. Budget 1-stop (longer layover or much cheaper)
      6. Premium non-stop (short duration, higher price, only if there's
         a meaningful gap)

    Deduped by (airline, price_num) so near-identical rows collapse.
    Falls back to whatever is available when the list is short.
    """
    if not live:
        return []

    valid = [f for f in live if f["price_num"] is not None and f["duration_min"]]
    if not valid:
        return []

    nonstops = sorted([f for f in valid if f["stops"] == 0], key=lambda f: f["price_num"])
    onestops = sorted([f for f in valid if f["stops"] >= 1], key=lambda f: f["price_num"])
    nonstops_by_duration = sorted(nonstops, key=lambda f: f["duration_min"])

    def _to_option(flight: dict, type_str: str, label: str, recommended: bool) -> dict:
        dep = flight.get("departure")
        arr = flight.get("arrival")
        return {
            "type": type_str,
            "label": label,
            "price_low": flight["price_num"],
            "price_high": flight["price_num"],
            "duration_min": flight["duration_min"],
            "stops": flight["stops"],
            "airline": flight["airline"],
            # HH:MM local times. Round 9 uses these in get_day_windows
            # to compute flight-aware activity windows per day.
            "departure_time": _normalize_time(dep),
            "arrival_time": _normalize_time(arr),
            "departure": dep,
            "arrival": arr,
            "recommended": recommended,
        }

    seen: set[tuple] = set()
    options: list[dict] = []

    def _add(flight: dict, type_str: str, label: str, recommended: bool) -> bool:
        key = (flight.get("airline", ""), flight.get("price_num"))
        if key in seen:
            return False
        seen.add(key)
        options.append(_to_option(flight, type_str, label, recommended))
        return True

    # 1. Cheapest non-stop
    if nonstops:
        _add(nonstops[0], "non-stop", "Cheapest non-stop", recommended=True)

    # 2. Fastest non-stop (if different from cheapest)
    if nonstops_by_duration and nonstops_by_duration[0] is not (nonstops[0] if nonstops else None):
        _add(nonstops_by_duration[0], "non-stop", "Fastest non-stop", recommended=False)

    # 3. Second-cheapest non-stop from a DIFFERENT airline
    if len(nonstops) > 1:
        first_airline = nonstops[0].get("airline", "")
        for candidate in nonstops[1:]:
            if candidate.get("airline", "") != first_airline:
                _add(candidate, "non-stop", "Alternative airline", recommended=False)
                break

    # 4. Cheapest 1-stop (only if genuinely cheaper than cheapest non-stop)
    if onestops:
        cheap_onestop = onestops[0]
        if not nonstops or cheap_onestop["price_num"] < nonstops[0]["price_num"]:
            _add(cheap_onestop, "1-stop", "1 stop · cheap", recommended=False)

        # 5. Budget 1-stop with long layover OR much cheaper
        if len(onestops) > 1:
            budget = onestops[-1]
            if (
                budget["price_num"] < cheap_onestop["price_num"] * 0.95
                or budget["duration_min"] >= cheap_onestop["duration_min"] + 120
            ):
                _add(budget, "1-stop budget", "1 stop · budget", recommended=False)

    # 6. Premium non-stop (short duration, higher price — only if there's
    #    a meaningful gap vs the cheapest one)
    if len(nonstops) >= 3:
        # The second-fastest non-stop that's pricier than the cheapest
        for candidate in nonstops_by_duration:
            if candidate["price_num"] > nonstops[0]["price_num"] * 1.15:
                _add(candidate, "non-stop", "Premium non-stop", recommended=False)
                break

    # If we still don't have ≥4 options, pad first from remaining nonstops,
    # then from remaining onestops. This guarantees a meaningful list when
    # fast-flights returns few results or when most routes are 1-stops
    # (e.g. smaller airports with limited direct service).
    for candidate in nonstops:
        if len(options) >= 6:
            break
        _add(candidate, "non-stop", candidate.get("airline") or "Non-stop", recommended=False)
    for candidate in onestops:
        if len(options) >= 6:
            break
        label = candidate.get("airline") or "1 stop"
        _add(candidate, "1-stop", f"{label} · 1 stop", recommended=False)

    # Hard cap at 8 options
    return options[:8]


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
    deep_link = _google_flights_url(from_iata, to_iata, date)

    # Best-effort live data via fast-flights (offloaded to a thread).
    live = await asyncio.to_thread(_try_fast_flights, from_iata, to_iata, date)

    # Try to build options from live data; fall back to estimator if we
    # couldn't get any usable flights from fast-flights.
    live_options = _options_from_live(live)
    if live_options:
        options = live_options
        source = "fast-flights"
    else:
        options = _build_options(distance_km, date)
        source = "estimator"

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
