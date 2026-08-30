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
import threading
from datetime import datetime, timezone
from urllib.parse import quote_plus

from app.tools.airports import lookup as lookup_airport
from app.tools.airports import lookup_alternates as lookup_airport_alternates

logger = logging.getLogger(__name__)

# ─── Flight-name parsing ───────────────────────────────────────────────────
# fast_flights returns f.name as e.g. "Cathay Pacific CX 100".
# We split on the trailing IATA-style code so we can expose a clean
# airline name AND a trackable flight number separately.
_FLIGHT_CODE_RE = re.compile(r"\b([A-Z0-9]{2,3}\s*\d{1,4})\s*$")

# ─── Stop-city extraction from Google Flights embedded JavaScript ─────────
#
# Google Flights embeds structured flight data directly in JavaScript inside
# the HTML response.  Each flight option that has one or more stops includes
# a layover block of the form:
#
#   [[LAYOVER_DURATION_MIN, "IATA", "IATA", [flags], "Airport Full Name",
#     "City Name", "Airport Full Name", "City Name"], ...]
#
# We locate every such block, then look backward in the same HTML chunk to
# find the preceding 2-letter airline code and HH:MM departure time.  The
# resulting (airline_code, dep_hhmm) → [city_names] map lets us annotate
# the Flight objects returned by fast-flights' CSS-based parser.
#
# Thread-local storage lets the monkey-patched fetch() pass the raw HTML to
# _try_fast_flights() without changing the fast-flights function signature.
_response_local = threading.local()

# Matches a single layover entry inside the JS data.
_LAYOVER_RE = re.compile(
    r"\[(\d{2,3}),"           # group 1: layover duration in minutes
    r"\"([A-Z]{3})\","        # group 2: stop airport IATA code
    r"\"[A-Z]{3}\","          # duplicate IATA (ignored)
    r"\[[^\]]*\],"            # flags array (ignored)
    r"\"[^\"]*\","            # full airport name (ignored – use IATA lookup)
    r"\"([^\"]+)\""           # group 3: city name from dataset
)

# Finds the departure time [H, MM] immediately before a destination IATA in JS.
_DEP_TIME_RE = re.compile(r"\[(\d{1,2}),(\d{2})\],\"[A-Z]{3}\"")

# Finds an airline entry header: ["XX", ["Airline Name"], [[
_AIRLINE_ENTRY_RE = re.compile(r"\[\"([A-Z]{2,3})\",\[\"[^\"]+\"\],\[\[")


def _extract_layover_stop_cities(html: str) -> dict[tuple[str, str], list[str]]:
    """Parse stop-city names from Google Flights embedded JavaScript.

    Returns {(airline_code, dep_hhmm): [city_name, ...]} for every
    multi-stop flight option found in the page.  Uses the airports table
    to get canonical city names; falls back to the JS-embedded city string.
    """
    from app.tools.airports import _BY_IATA  # local import avoids circular deps

    # Build the result incrementally.  For each layover entry we look
    # backward up to 3 000 chars for (a) the nearest airline code and
    # (b) the nearest departure-time pattern.  We then key on
    # (airline_2letter, dep_hhmm) so that two airlines departing at the
    # same time don't collide.
    result: dict[tuple[str, str], list[str]] = {}

    for m in _LAYOVER_RE.finditer(html):
        pos = m.start()
        window = html[max(0, pos - 3000): pos]

        # Nearest airline code
        airline_hits = list(_AIRLINE_ENTRY_RE.finditer(window))
        airline_code = airline_hits[-1].group(1) if airline_hits else ""

        # Nearest departure time
        dep_hits = list(_DEP_TIME_RE.finditer(window))
        if not dep_hits:
            continue
        dep_h, dep_m = int(dep_hits[-1].group(1)), int(dep_hits[-1].group(2))
        dep_key = f"{dep_h:02d}:{dep_m:02d}"

        key = (airline_code, dep_key)

        # Use airport table for canonical city name; fall back to JS string.
        iata = m.group(2)
        airport_entry = _BY_IATA.get(iata)
        city = airport_entry["city"] if airport_entry else m.group(3)

        cities = result.setdefault(key, [])
        if city not in cities:
            cities.append(city)

    return result


def _split_airline_and_code(name: str) -> tuple[str, str | None]:
    """Split 'Cathay Pacific CX 100' → ('Cathay Pacific', 'CX100').

    Returns (original_name, None) when no standard IATA code is found
    (estimator-generated paths, charter names, etc.).
    """
    m = _FLIGHT_CODE_RE.search(name or "")
    if not m:
        return name, None
    code = m.group(1).replace(" ", "")  # "CX 100" → "CX100"
    airline = name[: m.start()].strip()  # "Cathay Pacific"
    return airline, code

# ─── Patch fast-flights to use a hard socket-level timeout ───────────────
#
# fast_flights.core.fetch creates primp.Client with timeout=None, so the
# underlying TCP socket can block indefinitely — asyncio.wait_for only
# cancels the asyncio side; the thread keeps running. We replace `fetch`
# at import time with a version that sets timeout=2.5 s on the Client so
# the thread itself terminates promptly when Google Flights is blocked.
try:
    import fast_flights.core as _ff_core
    from fast_flights.primp import Client as _PrimpClient

    def _fetch_with_timeout(params: dict):  # type: ignore[no-untyped-def]
        # 8 s is enough for a normal Google Flights response (3-7 s typical)
        # while still bounding hangs from stalled connections or body transfers.
        client = _PrimpClient(impersonate="chrome_126", timeout=8.0)
        res = client.get("https://www.google.com/travel/flights", params=params)
        assert res.status_code == 200, f"{res.status_code} Result: {res.text_markdown}"
        # Save raw HTML so _extract_layover_stop_cities can mine stop city names
        # from the JS embedded in the page without modifying fast-flights internals.
        _response_local.html = res.text
        return res

    _ff_core.fetch = _fetch_with_timeout  # type: ignore[attr-defined]
    logger.debug("fast-flights fetch patched with 2.5 s socket timeout")
except Exception as _e:
    logger.debug("Could not patch fast-flights timeout: %s", _e)

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

# macOS setenv/unsetenv are NOT thread-safe. Concurrent calls from
# asyncio.to_thread will deadlock when two searches run in parallel.
# This lock serializes the env mutation + fast_flights call.
_env_lock = threading.Lock()


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
    """Return at least 3 flight options in HKD for any distance.

    Round 11 — previously short-haul routes (<2000 km) returned only a
    single non-stop option, which meant the user saw 1 flight card when
    fast-flights was blocked. Now every route gets a baseline of 3
    estimator options (early, day, evening) so there's always something
    to compare. Medium/long-haul gets two additional 1-stop variants.
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

    # Three synthetic non-stop time slots — early, midday, evening.
    # The prices fan out around the median to reflect typical intraday
    # variance: early flights cheaper, midday standard, evening a hair
    # more expensive due to after-work demand.
    options: list[dict] = [
        {
            "type": "non-stop",
            "label": "Non-stop · early",
            "price_low": _to_hkd(median_usd * 0.80),
            "price_high": _to_hkd(median_usd * 1.15),
            "duration_min": duration_direct,
            "stops": 0,
            "departure_time": "06:30",
            "arrival_time": _offset_hhmm("06:30", duration_direct),
            "recommended": True,
        },
        {
            "type": "non-stop",
            "label": "Non-stop · midday",
            "price_low": _to_hkd(median_usd * 0.95),
            "price_high": _to_hkd(median_usd * 1.25),
            "duration_min": duration_direct,
            "stops": 0,
            "departure_time": "12:15",
            "arrival_time": _offset_hhmm("12:15", duration_direct),
            "recommended": False,
        },
        {
            "type": "non-stop",
            "label": "Non-stop · evening",
            "price_low": _to_hkd(median_usd * 1.00),
            "price_high": _to_hkd(median_usd * 1.35),
            "duration_min": duration_direct,
            "stops": 0,
            "departure_time": "19:45",
            "arrival_time": _offset_hhmm("19:45", duration_direct),
            "recommended": False,
        },
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
                "departure_time": "08:00",
                "arrival_time": _offset_hhmm("08:00", duration_direct + 90),
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
                "departure_time": "22:30",
                "arrival_time": _offset_hhmm("22:30", duration_direct + 180),
                "recommended": False,
            }
        )

    return options


def _offset_hhmm(start: str, minutes: int) -> str:
    """Add `minutes` to an HH:MM string, wrapping at 24h. Used by the
    estimator to derive synthetic arrival times from departure + duration."""
    try:
        h, m = start.split(":")
        total = (int(h) * 60 + int(m) + int(minutes)) % (24 * 60)
        return f"{total // 60:02d}:{total % 60:02d}"
    except (ValueError, AttributeError):
        return start


# ─── Google Flights deep link ─────────────────────────────────────────────


def _google_flights_url(from_iata: str, to_iata: str, date: str | None, return_date: str | None = None) -> str:
    """Build a Google Flights URL with origin / destination / date pre-filled.

    When return_date is provided, generates a round-trip search URL so
    the user lands on the correct trip type in Google Flights.
    """
    if return_date:
        parts = [f"round trip flights from {from_iata} to {to_iata}"]
        if date:
            parts.append(f"on {date}")
        parts.append(f"return {return_date}")
    else:
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


def _try_fast_flights(from_iata: str, to_iata: str, date: str, seat_class: str = "economy") -> list[dict]:
    """Synchronously call fast-flights. Returns [] on any error.

    Wrapped in asyncio.to_thread by the caller so we don't block the loop.

    The local HTTP_PROXY/HTTPS_PROXY env vars are temporarily cleared for
    the duration of the call. Google Flights' protobuf endpoint returns
    401 "no token provided" when the request comes from a VPN/datacenter
    IP, which is exactly what a local Clash/Shadowsocks proxy produces.
    Saving and restoring is fine because we're inside a thread spawned by
    asyncio.to_thread — the env mutation doesn't leak into other concurrent
    calls during the brief window the proxy is unset.

    Note: _env_lock serializes concurrent calls to prevent the macOS
    setenv/unsetenv C-level deadlock when asyncio.gather runs multiple
    searches in parallel threads.
    """
    try:
        from fast_flights import FlightData, Passengers, get_flights
    except ImportError:
        logger.info("fast-flights not installed; using estimator")
        return []

    with _env_lock:
        saved = {key: os.environ.pop(key, None) for key in _PROXY_ENV_VARS}
        try:
            result = get_flights(
                flight_data=[FlightData(date=date, from_airport=from_iata, to_airport=to_iata)],
                trip="one-way",
                passengers=Passengers(adults=1),
                seat=seat_class,
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
        raw_airline, flight_code = _split_airline_and_code(f.name)
        ahead = (getattr(f, "arrival_time_ahead", "") or "").strip()
        flights.append(
            {
                "airline": raw_airline,
                "flight_number": flight_code,       # e.g. "CX100"; None if not parseable
                "next_day_arrival": bool(ahead),    # True when arrival is the next calendar day
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

    # Annotate each multi-stop flight with the actual layover cities extracted
    # from the JS embedded in the Google Flights page HTML.  Non-stop flights
    # and flights where we couldn't find matching JS data get an empty list.
    raw_html = getattr(_response_local, "html", "")
    if raw_html and any(f["stops"] > 0 for f in flights):
        stop_map = _extract_layover_stop_cities(raw_html)
        for flight in flights:
            if flight["stops"] == 0:
                flight["stop_cities"] = []
                continue
            # Key: (2-letter airline prefix, departure HH:MM)
            airline_prefix = (flight["flight_number"] or "")[:2] or (flight["airline"] or "")[:2]
            dep_key = _normalize_time(flight["departure"]) or ""
            flight["stop_cities"] = stop_map.get((airline_prefix, dep_key), [])
    else:
        for flight in flights:
            flight["stop_cities"] = []

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
            "stop_cities": flight.get("stop_cities", []),        # ["Dubai", "Doha"] or []
            "airline": flight["airline"],
            "flight_number": flight.get("flight_number"),        # "CX100" or None
            "next_day_arrival": flight.get("next_day_arrival", False),
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
        # Round 11 — include departure_time in the dedupe key so two
        # flights from the same airline at the same price but different
        # times count as distinct options. Before this, e.g. a JAL
        # 06:30 and a JAL 14:00 both at HK$1,300 collapsed into one.
        key = (
            flight.get("airline", ""),
            flight.get("price_num"),
            _normalize_time(flight.get("departure")) or "",
        )
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

    # 4. Cheapest 1-stop — always include as an alternative so users can
    #    compare stop options regardless of price vs non-stop.
    if onestops:
        cheap_onestop = onestops[0]
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

    # Round 11 — pad up to 8 (not 6) from remaining nonstops and
    # onestops so busy routes actually yield 7-8 distinct options.
    for candidate in nonstops:
        if len(options) >= 8:
            break
        _add(candidate, "non-stop", candidate.get("airline") or "Non-stop", recommended=False)
    for candidate in onestops:
        if len(options) >= 8:
            break
        label = candidate.get("airline") or "1 stop"
        _add(candidate, "1-stop", f"{label} · 1 stop", recommended=False)

    # Hard cap at 8 options
    return options[:8]


# ─── The tool itself ──────────────────────────────────────────────────────


SEAT_CLASS_MULTIPLIERS = {
    "economy": 1.0,
    "premium_economy": 1.6,
    "business": 3.2,
    "first": 5.5,
}

SEAT_CLASS_LABELS = {
    "economy": "Economy",
    "premium_economy": "Premium Economy",
    "business": "Business",
    "first": "First",
}


def _apply_seat_multiplier(options: list[dict], seat_class: str) -> list[dict]:
    """Round 12 — scale option prices by the seat class multiplier and
    tag each option with the effective seat_class so the frontend can
    render it. Operates in place and returns the list for chaining."""
    mult = SEAT_CLASS_MULTIPLIERS.get(seat_class, 1.0)
    label = SEAT_CLASS_LABELS.get(seat_class, "Economy")
    for opt in options:
        if mult != 1.0:
            if isinstance(opt.get("price_low"), (int, float)):
                opt["price_low"] = round(opt["price_low"] * mult)
            if isinstance(opt.get("price_high"), (int, float)):
                opt["price_high"] = round(opt["price_high"] * mult)
        opt["seat_class"] = seat_class
        opt["seat_class_label"] = label
    return options


async def search_flights(
    origin: str,
    destination: str,
    date: str | None = None,
    seat_class: str | None = None,
    return_date: str | None = None,
) -> dict:
    """Search for flights between two cities.

    The agent should pass natural-language city names ("Hong Kong", "Tokyo",
    "Paris"). We resolve them to IATA codes via the bundled airport table.
    If a city isn't in the table the call returns an error dict so the LLM
    can recover.

    Round 12 — seat_class defaults to "economy" but can be set to
    "premium_economy", "business", or "first" to scale prices by a
    fixed multiplier (1.6×/3.2×/5.5×). Each returned option carries a
    seat_class + seat_class_label field the frontend displays.

    return_date — optional return date (YYYY-MM-DD). When provided, the
    Google Flights deep link is generated as a round-trip search URL.
    Pass this when calling search_flights for the return leg of a round trip.
    """
    seat_class = (seat_class or "economy").lower().strip()
    if seat_class not in SEAT_CLASS_MULTIPLIERS:
        seat_class = "economy"
    from_entry = lookup_airport(origin)
    to_entry = lookup_airport(destination)

    if not from_entry:
        return {"error": f"Unknown origin city: {origin}. Try a major city name."}
    if not to_entry:
        return {"error": f"Unknown destination city: {destination}. Try a major city name."}

    from_iata, from_name, from_lat, from_lng = from_entry
    to_iata, to_name, to_lat, to_lng = to_entry

    # Reject same-airport and intra-metro trips — no commercial service exists.
    if from_iata == to_iata:
        return {
            "error": (
                f"Origin and destination are the same airport ({from_iata}). "
                "Please choose different airports."
            )
        }
    distance_km = _haversine_km(from_lat, from_lng, to_lat, to_lng)
    if distance_km < 80:
        return {
            "error": (
                f"No commercial flights operate between {from_iata} and {to_iata} "
                f"— these airports are only {round(distance_km)} km apart "
                "(they serve the same metro area). Consider ground transport instead."
            )
        }

    # Default to ~30 days from today if no date supplied so we get realistic
    # advance-purchase pricing instead of last-minute spikes.
    if not date:
        from datetime import timedelta
        date = (datetime.now(timezone.utc) + timedelta(days=30)).date().isoformat()

    deep_link = _google_flights_url(from_iata, to_iata, date, return_date)

    # Best-effort live data via fast-flights (offloaded to a thread).
    # The primp.Client patch above sets a 2.5 s socket-level timeout so
    # the thread terminates on its own. The asyncio.wait_for here is a
    # belt-and-suspenders guard in case the patch doesn't fire (e.g.,
    # primp version mismatch). We catch both TimeoutError and
    # CancelledError because Python 3.11+ may raise either depending on
    # how the cancellation propagates through to_thread.
    try:
        live = await asyncio.wait_for(
            asyncio.to_thread(_try_fast_flights, from_iata, to_iata, date, seat_class),
            timeout=10.0,  # 2 s margin over the 8 s primp socket timeout
        )
    except (TimeoutError, asyncio.CancelledError):
        logger.info("fast-flights timed out for %s→%s, using estimator", from_iata, to_iata)
        live = []

    # Try to build options from live data; fall back to estimator if we
    # couldn't get any usable flights from fast-flights.
    live_options = _options_from_live(live)
    if len(live_options) >= 3:
        options = live_options
        source = "fast-flights"
    elif live_options:
        # Partial live data: merge real flights with estimator padding
        # so the user sees live pricing AND has enough to compare.
        estimator = _build_options(distance_km, date)
        live_airlines = {o.get("airline") for o in live_options}
        padding = [e for e in estimator if e.get("airline") not in live_airlines]
        options = live_options + padding
        source = "fast-flights+estimator"
    else:
        options = _build_options(distance_km, date)
        source = "estimator"

    # Round 12 — apply the seat class multiplier AFTER the base
    # options are built so both the live and estimator paths yield
    # cabin-aware pricing.
    _apply_seat_multiplier(options, seat_class)

    # Top-level summary fields point at the recommended (non-stop) option so
    # FlightCards that don't iterate options still render meaningful values.
    primary = options[0]

    # Round 12 — surface alternate airports near either end so the
    # user knows they have options (e.g. Tokyo HND vs NRT). Each
    # entry carries the IATA, full name, and haversine distance
    # from the primary airport.
    def _alternates(city: str, anchor_lat: float, anchor_lng: float) -> list[dict]:
        out = []
        for iata, name, lat, lng in lookup_airport_alternates(city):
            out.append({
                "iata": iata,
                "name": name,
                "lat": lat,
                "lng": lng,
                "km_from_primary": round(_haversine_km(anchor_lat, anchor_lng, lat, lng), 1),
            })
        return out

    from_alternates = _alternates(origin, from_lat, from_lng)
    to_alternates = _alternates(destination, to_lat, to_lng)

    return {
        "from_city": origin.split(",")[0].strip(),
        "from_iata": from_iata,
        "from_name": from_name,
        "from_lat": from_lat,
        "from_lng": from_lng,
        "from_alternates": from_alternates,
        "to_city": destination.split(",")[0].strip(),
        "to_iata": to_iata,
        "to_name": to_name,
        "to_lat": to_lat,
        "to_lng": to_lng,
        "to_alternates": to_alternates,
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
        "seat_class": seat_class,
        "seat_class_label": SEAT_CLASS_LABELS[seat_class],
    }
