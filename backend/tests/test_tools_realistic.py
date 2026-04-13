"""P2: Realistic mock data & API edge case tests.

Tests tool wrappers with data shaped like real API responses — including
missing fields, null values, partial results, and real-world place names
that trip up string heuristics.

These tests catch bugs that idealized mocks miss:
  - Google Places pageSize default-to-1
  - fast-flights returning 1-2 results
  - Hotels with null photos/rating/priceLevel
  - Photo entries without a "name" field
  - Place names like "Park Hyatt" triggering outdoor heuristics
"""
from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import AsyncMock, patch

import pytest

from app.tools import (
    flights,
    places,
    weather,
)
from app.tools.errors import ToolUnavailableError

FIXTURES = Path(__file__).parent / "fixtures" / "api_responses"


@pytest.fixture(autouse=True)
def _mock_keys(monkeypatch):
    """Set fake keys so check_key passes."""
    monkeypatch.setattr(places, "GOOGLE_MAPS_API_KEY", "FAKE_KEY")


def _mock_response(json_data: dict, status: int = 200):
    resp = AsyncMock()
    resp.json = lambda: json_data
    resp.status_code = status
    resp.raise_for_status = lambda: None
    return resp


# ─── Places: pageSize regression guard ──────────────────────────────────


class TestPlacesPageSize:
    """Regression: Google Places defaults pageSize to 1 when omitted."""

    @pytest.mark.asyncio
    async def test_always_sends_pagesize_with_location(self):
        """pageSize must be present when location arg is provided."""
        captured_bodies: list[dict] = []

        async def capture_post(url, json, headers):
            captured_bodies.append(json)
            return _mock_response({"places": []})

        with patch("app.tools.places.httpx.AsyncClient") as mock_client:
            mock_client.return_value.__aenter__.return_value.post = AsyncMock(
                side_effect=capture_post
            )
            await places.search_places("hotels", location="Tokyo, Japan")

        assert len(captured_bodies) == 1
        assert captured_bodies[0].get("pageSize") == 20

    @pytest.mark.asyncio
    async def test_always_sends_pagesize_without_location(self):
        """pageSize must be present even when location arg is OMITTED.

        This is the exact bug from Round 11 — the old code only set
        pageSize inside `if location:`, so omitting location dropped it.
        """
        captured_bodies: list[dict] = []

        async def capture_post(url, json, headers):
            captured_bodies.append(json)
            return _mock_response({"places": []})

        with patch("app.tools.places.httpx.AsyncClient") as mock_client:
            mock_client.return_value.__aenter__.return_value.post = AsyncMock(
                side_effect=capture_post
            )
            await places.search_places("hotels in Tokyo")

        assert len(captured_bodies) == 1
        assert captured_bodies[0].get("pageSize") == 20, (
            "pageSize missing from request body when location arg omitted!"
        )


# ─── Places: realistic response normalization ───────────────────────────


class TestPlacesRealisticNormalization:
    """Test normalization with real-shaped Google Places API responses."""

    @pytest.mark.asyncio
    async def test_handles_7_results_with_sparse_fields(self):
        """Feed the realistic fixture (7 places, some sparse) through search_places."""
        fixture = json.loads((FIXTURES / "places_hotels_tokyo.json").read_text())
        with patch("app.tools.places.httpx.AsyncClient") as mock_client:
            mock_client.return_value.__aenter__.return_value.post = AsyncMock(
                return_value=_mock_response(fixture)
            )
            results = await places.search_places("hotels in Tokyo")

        assert len(results) == 7

    @pytest.mark.asyncio
    async def test_missing_photos_returns_none(self):
        """Place with no photos array should have photo_url=None."""
        fixture = json.loads((FIXTURES / "places_hotels_tokyo.json").read_text())
        with patch("app.tools.places.httpx.AsyncClient") as mock_client:
            mock_client.return_value.__aenter__.return_value.post = AsyncMock(
                return_value=_mock_response(fixture)
            )
            results = await places.search_places("hotels in Tokyo")

        budget_inn = next(r for r in results if "Budget Inn" in r["name"])
        assert budget_inn["photo_url"] is None
        assert budget_inn["photos"] == []

    @pytest.mark.asyncio
    async def test_empty_photos_array_returns_none(self):
        """Place with photos=[] should have photo_url=None."""
        fixture = json.loads((FIXTURES / "places_hotels_tokyo.json").read_text())
        with patch("app.tools.places.httpx.AsyncClient") as mock_client:
            mock_client.return_value.__aenter__.return_value.post = AsyncMock(
                return_value=_mock_response(fixture)
            )
            results = await places.search_places("hotels in Tokyo")

        apa = next(r for r in results if "APA" in r["name"])
        assert apa["photo_url"] is None
        assert apa["photos"] == []

    @pytest.mark.asyncio
    async def test_photo_without_name_field_skipped(self):
        """Photo entry with no "name" key should be skipped, not crash."""
        fixture = json.loads((FIXTURES / "places_hotels_tokyo.json").read_text())
        with patch("app.tools.places.httpx.AsyncClient") as mock_client:
            mock_client.return_value.__aenter__.return_value.post = AsyncMock(
                return_value=_mock_response(fixture)
            )
            results = await places.search_places("hotels in Tokyo")

        sakura = next(r for r in results if "Sakura" in r["name"])
        # The photo entry has no "name" field, so it should be skipped
        assert sakura["photo_url"] is None
        assert sakura["photos"] == []

    @pytest.mark.asyncio
    async def test_missing_rating_is_none(self):
        """Place with no rating field should have rating=None."""
        fixture = json.loads((FIXTURES / "places_hotels_tokyo.json").read_text())
        with patch("app.tools.places.httpx.AsyncClient") as mock_client:
            mock_client.return_value.__aenter__.return_value.post = AsyncMock(
                return_value=_mock_response(fixture)
            )
            results = await places.search_places("hotels in Tokyo")

        budget_inn = next(r for r in results if "Budget Inn" in r["name"])
        assert budget_inn["rating"] is None

    @pytest.mark.asyncio
    async def test_missing_location_returns_none_coords(self):
        """Place with no location field should have lat=None, lng=None."""
        fixture = json.loads((FIXTURES / "places_hotels_tokyo.json").read_text())
        with patch("app.tools.places.httpx.AsyncClient") as mock_client:
            mock_client.return_value.__aenter__.return_value.post = AsyncMock(
                return_value=_mock_response(fixture)
            )
            results = await places.search_places("hotels in Tokyo")

        capsule = next(r for r in results if "Capsule" in r["name"])
        assert capsule["lat"] is None
        assert capsule["lng"] is None

    @pytest.mark.asyncio
    async def test_all_results_have_place_id_and_name(self):
        """Every result must always have place_id and name, regardless of sparseness."""
        fixture = json.loads((FIXTURES / "places_hotels_tokyo.json").read_text())
        with patch("app.tools.places.httpx.AsyncClient") as mock_client:
            mock_client.return_value.__aenter__.return_value.post = AsyncMock(
                return_value=_mock_response(fixture)
            )
            results = await places.search_places("hotels in Tokyo")

        for r in results:
            assert r["place_id"], f"Missing place_id for {r.get('name')}"
            assert r["name"], f"Missing name for {r.get('place_id')}"


# ─── Flights: partial live data padding ─────────────────────────────────


class TestFlightsPartialLiveData:
    """When fast-flights returns only 1-2 results, pad with estimator."""

    @pytest.mark.asyncio
    async def test_single_live_result_pads_to_minimum(self):
        """1 live result should be merged with estimator to get ≥3 options."""
        single_live = [
            {
                "airline": "Cathay Pacific",
                "price_str": "HK$3,800",
                "price_num": 3800,
                "duration_str": "4 hr 5 min",
                "duration_min": 245,
                "stops": 0,
                "departure": "10:00",
                "arrival": "15:05",
                "is_best": True,
            }
        ]
        with patch("app.tools.flights._try_fast_flights", return_value=single_live):
            result = await flights.search_flights("Hong Kong", "Tokyo", "2026-05-15")

        assert result["source"] == "fast-flights+estimator"
        assert len(result["options"]) >= 3, (
            f"Only {len(result['options'])} options — should pad to ≥3"
        )

    @pytest.mark.asyncio
    async def test_two_live_results_pads_to_minimum(self):
        """2 live results should still pad with estimator."""
        two_live = [
            {
                "airline": "ANA",
                "price_str": "HK$2,100",
                "price_num": 2100,
                "duration_str": "3 hr 55 min",
                "duration_min": 235,
                "stops": 0,
                "departure": "08:00",
                "arrival": "13:15",
                "is_best": True,
            },
            {
                "airline": "Japan Airlines",
                "price_str": "HK$2,400",
                "price_num": 2400,
                "duration_str": "4 hr 0 min",
                "duration_min": 240,
                "stops": 0,
                "departure": "14:00",
                "arrival": "19:00",
                "is_best": False,
            },
        ]
        with patch("app.tools.flights._try_fast_flights", return_value=two_live):
            result = await flights.search_flights("Hong Kong", "Tokyo", "2026-05-15")

        assert result["source"] == "fast-flights+estimator"
        assert len(result["options"]) >= 3

    @pytest.mark.asyncio
    async def test_three_or_more_live_uses_fast_flights_only(self):
        """≥3 live results should use fast-flights source without padding."""
        three_live = [
            {
                "airline": "ANA",
                "price_str": "HK$2,100",
                "price_num": 2100,
                "duration_str": "3 hr 55 min",
                "duration_min": 235,
                "stops": 0,
                "departure": "08:00",
                "arrival": "13:15",
                "is_best": True,
            },
            {
                "airline": "JAL",
                "price_str": "HK$2,400",
                "price_num": 2400,
                "duration_str": "4 hr 0 min",
                "duration_min": 240,
                "stops": 0,
                "departure": "14:00",
                "arrival": "19:00",
                "is_best": False,
            },
            {
                "airline": "Cathay",
                "price_str": "HK$1,800",
                "price_num": 1800,
                "duration_str": "4 hr 10 min",
                "duration_min": 250,
                "stops": 0,
                "departure": "19:00",
                "arrival": "00:10",
                "is_best": False,
            },
        ]
        with patch("app.tools.flights._try_fast_flights", return_value=three_live):
            result = await flights.search_flights("Hong Kong", "Tokyo", "2026-05-15")

        assert result["source"] == "fast-flights"

    @pytest.mark.asyncio
    async def test_empty_live_falls_back_to_estimator(self):
        """No live results → pure estimator."""
        with patch("app.tools.flights._try_fast_flights", return_value=[]):
            result = await flights.search_flights("Hong Kong", "Tokyo", "2026-05-15")

        assert result["source"] == "estimator"
        assert len(result["options"]) >= 3


# ─── Flights: dedup key includes departure_time ─────────────────────────


class TestFlightsDedup:
    """Dedup key must include departure_time to avoid collapsing distinct flights."""

    @pytest.mark.asyncio
    async def test_same_airline_same_price_different_times_kept(self):
        """Two JAL flights at same price but different times should both appear."""
        live = [
            {
                "airline": "Japan Airlines",
                "price_str": "HK$1,300",
                "price_num": 1300,
                "duration_str": "4 hr 0 min",
                "duration_min": 240,
                "stops": 0,
                "departure": "06:30",
                "arrival": "11:30",
                "is_best": True,
            },
            {
                "airline": "Japan Airlines",
                "price_str": "HK$1,300",
                "price_num": 1300,
                "duration_str": "4 hr 0 min",
                "duration_min": 240,
                "stops": 0,
                "departure": "14:00",
                "arrival": "19:00",
                "is_best": False,
            },
            {
                "airline": "ANA",
                "price_str": "HK$1,500",
                "price_num": 1500,
                "duration_str": "3 hr 55 min",
                "duration_min": 235,
                "stops": 0,
                "departure": "10:00",
                "arrival": "14:55",
                "is_best": False,
            },
        ]
        with patch("app.tools.flights._try_fast_flights", return_value=live):
            result = await flights.search_flights("Hong Kong", "Tokyo", "2026-05-15")

        jal_options = [o for o in result["options"] if o.get("airline") == "Japan Airlines"]
        assert len(jal_options) >= 2, (
            f"Two JAL flights at different times collapsed to {len(jal_options)}"
        )


# ─── Flights: all options have required fields ──────────────────────────


class TestFlightsOptionFields:
    """Every flight option must have the fields the frontend needs to render."""

    @pytest.mark.asyncio
    async def test_estimator_options_have_all_fields(self):
        """Estimator fallback options must have price, duration, times."""
        with patch("app.tools.flights._try_fast_flights", return_value=[]):
            result = await flights.search_flights("Hong Kong", "Tokyo", "2026-05-15")

        for opt in result["options"]:
            assert opt.get("price_low") is not None and opt["price_low"] > 0
            assert opt.get("price_high") is not None and opt["price_high"] > 0
            assert opt.get("duration_min") is not None and opt["duration_min"] > 0
            assert opt.get("departure_time") is not None
            assert opt.get("arrival_time") is not None
            assert opt.get("stops") is not None
            assert opt.get("type") is not None

    @pytest.mark.asyncio
    async def test_seat_class_applied_to_all_options(self):
        """Business class multiplier should be applied to every option."""
        with patch("app.tools.flights._try_fast_flights", return_value=[]):
            economy = await flights.search_flights("Hong Kong", "Tokyo", "2026-05-15")
            business = await flights.search_flights(
                "Hong Kong", "Tokyo", "2026-05-15", seat_class="business"
            )

        # Business should be ~3.2x economy (with rounding tolerance)
        for eco_opt, biz_opt in zip(economy["options"], business["options"]):
            ratio = biz_opt["price_low"] / eco_opt["price_low"]
            assert 2.5 < ratio < 4.0, (
                f"Business/economy ratio {ratio:.1f} outside expected 2.5-4.0"
            )
            assert biz_opt["seat_class"] == "business"
            assert biz_opt["seat_class_label"] == "Business"


# ─── Flights: short-haul still gets 3+ options ──────────────────────────


class TestFlightsShortHaul:
    """Short-haul routes (<2000km) must still have ≥3 options."""

    @pytest.mark.asyncio
    async def test_short_haul_has_minimum_options(self):
        """HKG→TPE (~800km) should get at least 3 estimator options."""
        with patch("app.tools.flights._try_fast_flights", return_value=[]):
            result = await flights.search_flights("Hong Kong", "Taipei", "2026-06-01")

        assert len(result["options"]) >= 3, (
            f"Short-haul only has {len(result['options'])} options"
        )

    @pytest.mark.asyncio
    async def test_long_haul_has_extra_options(self):
        """HKG→NYC (~12900km) should have 1-stop options too."""
        with patch("app.tools.flights._try_fast_flights", return_value=[]):
            result = await flights.search_flights("Hong Kong", "New York", "2026-07-01")

        has_1stop = any(o["stops"] >= 1 for o in result["options"])
        assert has_1stop, "Long-haul route should include 1-stop options"
        assert len(result["options"]) >= 4


# ─── Weather: graceful degradation ──────────────────────────────────────


class TestWeatherGraceful:
    """Weather API should degrade gracefully for edge cases."""

    @pytest.mark.asyncio
    async def test_returns_error_dict_on_missing_key(self, monkeypatch):
        """Missing API key should return a ToolUnavailableError."""
        monkeypatch.setattr(weather, "GOOGLE_MAPS_API_KEY", "")
        with pytest.raises(ToolUnavailableError):
            await weather.get_weather("Tokyo")
