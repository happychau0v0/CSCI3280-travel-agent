"""get_day_windows — compute flight-aware activity windows per day.

The LLM's raw day plans used to start every day at 09:00 and end at
21:00 regardless of the flight schedule. That falls apart when the
flight lands at 19:00 on day 1 (activities would start before the
user has even landed) or when the departure flight leaves at 10:00
on the last day (activities would be planned hours after the user
has left for the airport).

This tool gives the LLM an authoritative list of valid time windows,
one per day, so it can lay out activities that make sense relative
to the actual flight schedule.

Logic:

    Arrival day (day 1):
      start_time = arrival + 90 min buffer (baggage/transit/check-in)
      If arrival is very late (>=20:00), the window is "hotel + one
      nearby dinner" only — start_time = arrival + 90, end_time = 23:00.
      If arrival is early (<=13:00), it's close to a full day — start
      from the buffer, end at 21:00.
      Otherwise mid-afternoon: start from buffer, end at 22:00.

    Departure day (last day):
      end_time = departure - 180 min (airport check-in buffer)
      If departure is before 12:00, start is just hotel check-out +
      airport transit; end_time = departure - 180.
      If departure is after 18:00, full day with early check-out;
      start 09:00, end = departure - 180.
      Otherwise mid-day: start 09:00, end = departure - 180.

    Middle days (day 2 .. day N-1):
      Full days, 09:00 .. 21:00.

Times are HH:MM strings. Dates are ISO (YYYY-MM-DD). The LLM passes
in the flight dict (from search_flights → selected option) and the
number of trip days. Returns a list sorted by day number.
"""
from __future__ import annotations

from datetime import date as _date, datetime, timedelta


# Buffers in minutes — these are "sensible defaults" not truth.
ARRIVAL_BUFFER_MIN = 90       # baggage + transit to hotel + check-in
DEPARTURE_BUFFER_MIN = 180    # international check-in + security + transit
LATE_ARRIVAL_THRESHOLD = "20:00"
EARLY_ARRIVAL_THRESHOLD = "13:00"
EARLY_DEPARTURE_THRESHOLD = "12:00"
LATE_DEPARTURE_THRESHOLD = "18:00"
DEFAULT_MORNING_START = "09:00"
DEFAULT_EVENING_END = "21:00"
LATE_NIGHT_END = "23:00"
EXTENDED_EVENING_END = "22:00"


def _parse_time(hhmm: str | None) -> datetime | None:
    """Parse 'HH:MM' or ISO datetime into a datetime with today's date."""
    if not hhmm:
        return None
    hhmm = str(hhmm).strip()
    # ISO datetime
    if "T" in hhmm or " " in hhmm:
        try:
            return datetime.fromisoformat(hhmm.replace("Z", "+00:00"))
        except ValueError:
            pass
    # Plain HH:MM — anchor to a neutral date so arithmetic works
    try:
        h, m = hhmm.split(":")
        return datetime(2000, 1, 1, int(h), int(m))
    except (ValueError, AttributeError):
        return None


def _fmt_time(dt: datetime) -> str:
    return dt.strftime("%H:%M")


def _add_minutes(hhmm: str, minutes: int) -> str:
    dt = _parse_time(hhmm)
    if not dt:
        return hhmm
    return _fmt_time(dt + timedelta(minutes=minutes))


def _cmp_time(a: str, b: str) -> int:
    """Compare two HH:MM strings. Returns -1 / 0 / +1."""
    ta = _parse_time(a)
    tb = _parse_time(b)
    if ta is None or tb is None:
        return 0
    if ta < tb:
        return -1
    if ta > tb:
        return 1
    return 0


def _date_plus(start_date: str | None, days: int) -> str | None:
    if not start_date:
        return None
    try:
        d = _date.fromisoformat(start_date)
    except ValueError:
        return None
    return (d + timedelta(days=days)).isoformat()


def _arrival_day_window(arrival_time: str | None) -> tuple[str, str, str]:
    """Return (start, end, notes) for day 1 given arrival HH:MM."""
    if not arrival_time:
        return (DEFAULT_MORNING_START, DEFAULT_EVENING_END, "Full day — arrival time unknown")
    start = _add_minutes(arrival_time, ARRIVAL_BUFFER_MIN)
    if _cmp_time(arrival_time, LATE_ARRIVAL_THRESHOLD) >= 0:
        return (
            start,
            LATE_NIGHT_END,
            "Late arrival — hotel check-in and one nearby dinner only",
        )
    if _cmp_time(arrival_time, EARLY_ARRIVAL_THRESHOLD) <= 0:
        return (
            start,
            DEFAULT_EVENING_END,
            "Early arrival — near-full day after check-in",
        )
    return (
        start,
        EXTENDED_EVENING_END,
        "Mid-afternoon arrival — partial day after check-in",
    )


def _departure_day_window(departure_time: str | None) -> tuple[str, str, str]:
    """Return (start, end, notes) for the last day given departure HH:MM."""
    if not departure_time:
        return (DEFAULT_MORNING_START, DEFAULT_EVENING_END, "Full day — departure time unknown")
    end = _add_minutes(departure_time, -DEPARTURE_BUFFER_MIN)
    if _cmp_time(departure_time, EARLY_DEPARTURE_THRESHOLD) <= 0:
        return (
            DEFAULT_MORNING_START,
            end,
            "Early departure — hotel check-out and airport transit only",
        )
    if _cmp_time(departure_time, LATE_DEPARTURE_THRESHOLD) >= 0:
        return (
            DEFAULT_MORNING_START,
            end,
            "Late departure — near-full day before airport transit",
        )
    return (
        DEFAULT_MORNING_START,
        end,
        "Mid-day departure — partial day before airport transit",
    )


async def get_day_windows(
    flight: dict | None = None,
    trip_days: int = 3,
    start_date: str | None = None,
) -> list[dict]:
    """Compute per-day activity windows accounting for flight times.

    Args:
        flight: the SELECTED flight option dict, with arrival_time,
                departure_time (HH:MM), and optionally a date.
                When None or missing fields, the function returns
                default full-day windows.
        trip_days: total number of days in the trip (≥1).
        start_date: ISO start date (YYYY-MM-DD). Used to populate the
                    date on each returned window. Optional.

    Returns:
        [
          {"day": 1, "date": "2026-06-01", "start_time": "19:30",
           "end_time": "23:00", "notes": "..."},
          ...
        ]
    """
    trip_days = max(1, int(trip_days or 1))
    arrival_time = None
    departure_time = None
    if isinstance(flight, dict):
        arrival_time = flight.get("arrival_time") or flight.get("arrival")
        departure_time = flight.get("departure_time") or flight.get("departure")
        # The LLM sometimes passes the whole flight object with options;
        # fall back to the first option's times if top-level is missing.
        if (arrival_time is None or departure_time is None) and isinstance(flight.get("options"), list):
            for opt in flight["options"]:
                if isinstance(opt, dict):
                    arrival_time = arrival_time or opt.get("arrival_time") or opt.get("arrival")
                    departure_time = departure_time or opt.get("departure_time") or opt.get("departure")
                    if arrival_time and departure_time:
                        break

    windows: list[dict] = []
    for day_idx in range(trip_days):
        day_num = day_idx + 1
        date_str = _date_plus(start_date, day_idx)

        if trip_days == 1:
            # Single-day trip: constrained on both ends
            start = DEFAULT_MORNING_START
            end = DEFAULT_EVENING_END
            notes = "Single day"
            if arrival_time:
                start = _add_minutes(arrival_time, ARRIVAL_BUFFER_MIN)
            if departure_time:
                end = _add_minutes(departure_time, -DEPARTURE_BUFFER_MIN)
            if _cmp_time(end, start) <= 0:
                notes = "Very short day — tight flight window"
        elif day_num == 1:
            start, end, notes = _arrival_day_window(arrival_time)
        elif day_num == trip_days:
            start, end, notes = _departure_day_window(departure_time)
        else:
            start = DEFAULT_MORNING_START
            end = DEFAULT_EVENING_END
            notes = "Full day"

        windows.append(
            {
                "day": day_num,
                "date": date_str,
                "start_time": start,
                "end_time": end,
                "notes": notes,
            }
        )

    return windows
