# AI Travel Agent — Comprehensive Reference

> **Audience:** Developers maintaining or extending the codebase.
> **Scope:** User workflows, LLM response modes, tool contracts, business logic, SSE event stream,
> TTS pipeline, hotkey system. This document captures rules baked into `llm.py`, `prompts.py`,
> the frontend state machine, and the tool wrappers — things not derivable from reading one file alone.

---

## Table of Contents

1. [User Workflows](#1-user-workflows)
   - 1.1 Happy Path (new trip)
   - 1.2 Clarification Flow
   - 1.3 Chat Mode (freeform)
   - 1.4 Replan (edit existing itinerary)
2. [LLM Response Modes](#2-llm-response-modes)
   - Mode table
   - Per-mode rules
   - Context window strategy
   - Model fallback routing
3. [Tool Calling Reference](#3-tool-calling-reference)
   - Data-fetching tools (6)
   - UI tools (4)
   - Utility tools (2)
4. [Business Logic](#4-business-logic)
   - Itinerary construction rules
   - Flight search pipeline
   - JSON extraction pipeline
   - Itinerary merge strategy (frontend)
   - Context pruning
   - `request_input` hard-stop rule
   - Photo proxy
   - Route optimization (TSP)
5. [SSE Event Stream Reference](#5-sse-event-stream-reference)
6. [TTS Pipeline](#6-tts-pipeline)
7. [Hotkey System](#7-hotkey-system)
   - Design philosophy
   - Scope model (tabs / list / detail)
   - Full hotkey reference
   - Adding new hotkeys
8. [Service Status Overlay](#8-service-status-overlay)
9. [Data Schemas](#9-data-schemas)
10. [Known Limitations & Gaps](#10-known-limitations--gaps)

---

## 1. User Workflows

### 1.1 Happy Path (new trip)

The three-turn planning pipeline where each turn produces one panel of data.

```
User fills PanelHome form
  → destination, origin, start_date, end_date, transport,
    seat_class, party_size, interests

User clicks START PLANNING
  → App.handleSend(prompt, { callRole: "plan", reset: true })
  → isLoading=true, AgentStatusBar shows "AGENT WORKING"
  → POST /chat/stream opens SSE stream

── TURN 1: PLAN ──────────────────────────────────────────
Backend (callRole:"plan", SYSTEM_PROMPT_PLAN):
  Round 1: geocode_city + search_flights + get_day_windows + get_phrasebook (parallel)
  Round 2: LLM emits itinerary JSON block (flight + phrasebook) + navigate_menu("FLIGHTS")

Frontend receives SSE events:
  partial_itinerary  → preview flight options, auto-navigate to FLIGHTS panel
  tool_start/end     → AgentStatusBar shows tool names + timings
  navigate           → buffered in pendingNavigateRef
  done               → merge flight + phrasebook into currentItinerary
                        flush pendingNavigateRef → MenuShell switches to FLIGHTS

User reviews FLIGHTS panel (outbound options, optionally return options)
User clicks PICK on a flight option
  → pushPickSnapshot() for undo
  → App.handleSend("I'll take [flight]", { callRole: "hotels" })

── TURN 2: HOTELS ────────────────────────────────────────
Backend (callRole:"hotels", SYSTEM_PROMPT_HOTELS):
  Round 1: search_places("hotels near [destination]") + get_weather (parallel)
  Round 2: LLM emits itinerary JSON block (hotels array) + navigate_menu("HOTELS")

Frontend:
  done → merge hotels (additive, flight preserved), switch to HOTELS

User reviews HOTELS panel (filter by price/rating, view photos, Leaflet map)
User clicks PICK (optionally PICK & REPLAN if autoReplan=off)
  → pushPickSnapshot() for undo
  → App.handleSend("I'll stay at [hotel]", { callRole: "days" })
     (if autoReplan=true, picking a hotel also calls callRole:"days" automatically)

── TURN 3: DAYS ──────────────────────────────────────────
Backend (callRole:"days", SYSTEM_PROMPT_DAYS):
  Round 1: search_places per day + get_weather + get_directions (first+last transitions, parallel)
  Round 2: LLM emits itinerary JSON block (days array) + navigate_menu("DAYS")

Frontend:
  done → merge days (flight + hotel preserved), switch to DAYS

User reviews DAYS panel:
  - Drag activities to reorder (hotel/airport anchors are immutable)
  - Click REPLACE → App.handleSend("Replace [activity] with something else", { callRole: "days" })
  - Click REMOVE → remove activity from local state (no LLM call)
  - Click ☆ → add to favorites
  - Click activity → DayMiniMap fetches live polyline from /api/directions (debounced 400ms)
  - Edit time / name inline (click to edit)
  - Add personal notes (user_note field, never sent to LLM)
```

**Undo/Redo:**
- `pushPickSnapshot()` called before each PICK — saves {flight, hotels, selected_hotel, days} snapshot
- Ctrl+Z / Cmd+Z → `handleUndoPick()` pops snapshot, restores state
- Ctrl+Shift+Z / Cmd+Y → `handleRedoPick()` re-applies
- Stack max depth: 20

---

### 1.2 Clarification Flow

Fires when the LLM determines it cannot proceed without more information from the user.

```
User submits form with destination="Australia" (country, not city)
OR user submits without start_date / end_date

Backend (callRole:"plan"):
  Round 1: LLM calls request_input(field="destination",
           prompt="Which city in Australia? (e.g., Sydney, Melbourne, Brisbane)")
  → request_input hard-stops the loop (no other tools run)
  → SSE event: { type:"request_input", data:{ field, prompt, options? } }

Frontend:
  onEvent("request_input"):
    → switch to HOME panel (TRIP tab)
    → focus the relevant field
    → display prompt text near the field
    → store pendingInputRequestRef = { field, prompt, callRole:"plan" }

User types an answer (e.g., "Sydney") into the focused field
  → handleSend("Sydney", { callRole: "plan" })   ← callRole preserved from ref
  → backend runs SYSTEM_PROMPT_PLAN again, now destination is a city
  → proceeds to search_flights normally
```

**Key rule:** The `callRole` is preserved across the clarification round. If `callRole:"plan"` was
active when `request_input` fired, the next message also uses `callRole:"plan"` — not the full
monolithic SYSTEM_PROMPT. Without this, the LLM would run all 3 turns in one go and jump to DAYS.

---

### 1.3 Chat Mode (freeform)

User opens the ChatPopover (T or Cmd+K) at any point and types a freeform request.

```
User presses T / Cmd+K → ChatPopover opens
User types: "Change the currency to USD" or "Navigate to hotels"
  → App.handleSend(text, { callRole: "chat" })

Backend (callRole:"chat", SYSTEM_PROMPT_CHAT):
  LLM uses UI-action tools to navigate and perform the same actions as the buttons:
    navigate_menu    → switch to a panel
    pick_flight      → select a flight option (same as clicking PICK in PanelFlights)
    pick_hotel       → select a hotel (same as clicking PICK in PanelHotels)
    replace_activity → replace or remove a day activity (same as clicking REPLACE)
    request_input    → ask user for a missing field
    toggle_setting   → change a setting (currency, theme, tts, etc.)
    submit_trip_form → prefill the PLAN form and start planning

Frontend:
  SSE events for pick_flight / pick_hotel / replace_activity are handled identically
  to the corresponding button clicks (same state updates and follow-on LLM calls).
```

**Design principle — chat has the same permissions as the UI:**
A user typing "pick the Cathay Pacific flight" must produce the exact same result as
clicking the PICK button on that row. Chat is not a limited text interface layered on top
of the UI — it is an alternative input method with identical authority.

- `pick_flight` → selects `selected_flight`, then frontend fires `callRole:"hotels"`
- `pick_hotel` → selects `selected_hotel`, then frontend fires `callRole:"days"` (if autoReplan)
- `replace_activity` → frontend fires `callRole:"days"` with a replacement instruction
- `submit_trip_form` (already exists) → starts planning from scratch
- `navigate_menu` (already exists) → moves user to any panel

`pick_flight`, `pick_hotel`, and `replace_activity` are not yet implemented — see §10.

---

### 1.4 Replan (edit existing itinerary)

Triggered when the user picks a different hotel, or asks to change days after one already exists.

```
User changes hotel selection (autoReplan=true, the default):
  → App picks hotel, immediately fires handleSend("Replanning days for [hotel]", { callRole: "days" })
  → Backend runs SYSTEM_PROMPT_DAYS with new hotel context
  → days merged (flight + hotel selection preserved)

User asks via chat to replace an activity (current limitation — chat can't do this directly):
  → Workaround: click REPLACE button on the activity row in PanelDays
  → App.handleSend("Replace [activity] at [time] with a better option", { callRole: "days" })
  → Backend runs SYSTEM_PROMPT_DAYS, emits new days array
  → Frontend merges additively

autoReplan toggle (top of HOTELS panel):
  ON (default): picking a hotel immediately replans days
  OFF: picking a hotel only updates selected_hotel, no day replan; user must click REPLAN button
```

---

## 2. LLM Response Modes

### Mode Table

| `callRole` | System Prompt | Allowed Tools | JSON Output | Navigates To | Context Sent |
|-----------|--------------|---------------|-------------|-------------|--------------|
| `"plan"` | `SYSTEM_PROMPT_PLAN` | search_flights, geocode_city, get_day_windows, get_phrasebook, request_input, navigate_menu | `flight` + `phrasebook` blocks | FLIGHTS | system + last user msg only |
| `"hotels"` | `SYSTEM_PROMPT_HOTELS` | search_places, get_weather, navigate_menu | `hotels` array | HOTELS | system + last user msg only |
| `"days"` | `SYSTEM_PROMPT_DAYS` | search_places, get_directions, get_weather, navigate_menu | `days` array | DAYS | system + last user msg only |
| `"chat"` | `SYSTEM_PROMPT_CHAT` | request_input, submit_trip_form, navigate_menu, toggle_setting | None (text only) | — | Full conversation history |
| `null` (legacy) | `SYSTEM_PROMPT` | All 12 tools | Full itinerary (all 3 turns) | Auto per turn | Full conversation history |

### Per-Mode Rules

**`"plan"` (SYSTEM_PROMPT_PLAN)**
- Before calling `search_flights`, LLM MUST verify destination is a city (not country) and dates are provided. If either is missing or ambiguous, call `request_input` first and stop.
- Call `geocode_city`, `search_flights`, `get_day_windows`, `get_phrasebook` in the SAME round (parallel).
- Call `navigate_menu("FLIGHTS")` exactly ONCE, at the very end (last tool call before emitting JSON). Never mid-stream.
- Output JSON must include `flight` object with `options` array (3–8 options). Copy options verbatim from `search_flights` result — no summarizing.
- If round-trip: call `search_flights` twice (outbound + return); populate both `options` and `return_options`.
- Forbidden: `search_places`, `get_weather`, `get_directions`, `get_place_details`.

**`"hotels"` (SYSTEM_PROMPT_HOTELS)**
- 2 rounds maximum.
- Round 1: `search_places("hotels near [city]")` + `get_weather` in parallel.
- Round 2: Emit JSON with exactly 5 hotels. Do NOT call `get_place_details` between rounds.
- Each hotel: copy `photo_url` (first photo only) from `search_places` result. Do NOT embed a `photos` array.
- Set `selected_hotel: null` in output (user has not picked yet).
- Forbidden: `get_place_details`, `search_flights`, `get_directions`, `request_input`.

**`"days"` (SYSTEM_PROMPT_DAYS)**
- 2 rounds maximum.
- Round 1: `search_places` queries per day + `get_weather` + `get_directions` (max 2 per day: first and last transitions only) — all in parallel.
- Round 2: Emit JSON with `days` array. Do NOT call `get_place_details` (use descriptions from `search_places`).
- Write activity descriptions from own knowledge (10–15 words). Do not copy full editorial summaries.
- Day 1: first activity MUST be the arrival airport (from `get_day_windows` `arrival_airport` field), time = arrival + 90 min.
- Last day: last activity MUST be the departure airport, timed 180 min before departure.
- Middle days: ≥5 real activities, ≥2 meal stops, 09:00–21:00 window.
- Weather required for every day.
- Forbidden: `get_place_details`, `search_flights`, `request_input`.

**`"chat"` (SYSTEM_PROMPT_CHAT)**
- No data-fetching tools. Only controls UI state.
- Responds with short conversational text; no JSON blocks.
- Uses full conversation history (not fresh call).
- See §1.3 for known gap re: intended full permissions.

**`null` (SYSTEM_PROMPT — legacy monolithic)**
- Full multi-turn logic: CONVERSATION mode (smalltalk, greetings) vs PLANNING mode (trip signals detected).
- PLANNING mode runs all 3 turns sequentially in one call chain.
- Not used in current UI-driven flow. Active only when `callRole` is omitted (e.g., early testing, bench eval).
- `bench_eval=true` appends `BENCH_EVAL_ADDENDUM` which forces a single all-in-one response.

### Context Window Strategy

**Scoped calls** (`plan`, `hotels`, `days`):
- Fresh call — only the relevant system prompt + the single triggering user message.
- No conversation history. This prevents stale context from earlier turns contaminating the tool round.

**`chat` and `null`:**
- Full conversation history preserved (all prior messages).
- Itinerary JSON is stripped from history before sending (replaced with `«itinerary»` placeholder) to save tokens.

**Context pruning** (`_prune_tool_results` in `llm.py`):
- As the tool-call loop accumulates rounds, older `role=tool` messages are truncated to `[tool result omitted]`.
- Keeps the most recent N rounds intact: N=3 for reasoning models, N=2 for non-reasoning.
- Round boundaries detected by `role=assistant` messages.

### Model Fallback Routing

```
Primary:  xAI (grok-4.20-0309-non-reasoning, default)
Fallback: Gemini (gemini-3.1-pro-preview)

On round 0 only:
  → xAI returns 500 (InternalServerError)  → provider outage
  → xAI returns 403 / "region not available" / "not supported" / "geo" / "country"
                                           → geo-restriction
  → transparent retry with Gemini client
  → emit SSE { type:"model_fallback", data:{ reason:"outage"|"region_restricted" } }

On round 1+:
  → re-raise (can't switch mid-stream without confusing state)

Manual override:
  → User selects Gemini in Settings → preferred_model is set
  → llm.py routes to _get_fallback_client() regardless of primary status
  → Gemini model names are incompatible with xAI client (different endpoint)
```

**`ROLE_DEFAULT_MODELS`:** Each role (`plan`, `hotels`, `days`, `chat`) has its own default model,
currently all set to `grok-4.20-0309-non-reasoning`. Priority: explicit user choice > role default
> global `LLM_MODEL` env var.

---

## 3. Tool Calling Reference

All tools are defined in `backend/app/tools/__init__.py` as `TOOL_DEFINITIONS` (OpenAI function-call
format) and dispatched via `TOOL_DISPATCH` dict. Tools run in parallel via `asyncio.gather` within
each LLM round.

### Data-Fetching Tools

---

#### `search_places`
**File:** `backend/app/tools/places.py`

**Purpose:** Search for real places (hotels, restaurants, attractions, etc.) using Google Places API (New).

**Parameters:**
```
query: str          — Free-text search (e.g., "temples in Kyoto" or "budget hotels near Shinjuku")
location: str|None  — Bias results toward this city/neighborhood (appended to query)
radius_km: float    — Search radius (default 5.0 km)
```

**Google API:** POST `/v1/places:searchText`

**Returns:** `list[dict]` (up to 20 results)
```json
{
  "place_id": "ChIJ...",
  "name": "Senso-ji Temple",
  "address": "2-3-1 Asakusa, Taito City, Tokyo",
  "rating": 4.6,
  "price_level": "Free",
  "photo_url": "/photo/places/ChIJ.../photos/Ae...",
  "photos": ["/photo/...", "/photo/..."],
  "lat": 35.7147651,
  "lng": 139.7966553,
  "description": "One of Tokyo's oldest and most significant Buddhist temples.",
  "hours": ["Monday: 6:00 AM – 5:00 PM", ...]
}
```

**Side effects:** None.

**Error handling:** Raises `ToolUnavailableError` if `GOOGLE_MAPS_API_KEY` is not set.
Returns empty list if Places API returns no results.

---

#### `get_place_details`
**File:** `backend/app/tools/places.py`

**Purpose:** Fetch detailed information for a known place by its `place_id`.

**Parameters:**
```
place_id: str   — Google Places ID (e.g., "ChIJ...")
```

**Google API:** GET `/v1/places/{place_id}`

**Returns:**
```json
{
  "place_id": "ChIJ...",
  "name": "Senso-ji Temple",
  "address": "...",
  "description": "Full editorial summary...",
  "hours": ["Monday: 6:00 AM – 5:00 PM", ...],
  "reviews": [{ "text": "...", "rating": 5 }, ...],
  "photos": ["/photo/...", ...],
  "price_level": "Free",
  "rating": 4.6,
  "website": "https://...",
  "lat": 35.7147651,
  "lng": 139.7966553
}
```

**Side effects:** None.

**Note:** Forbidden in `hotels` and `days` modes. The LLM must use `search_places` descriptions
instead (calling `get_place_details` in round 1 causes an extra round and blows the 2-round budget).

---

#### `get_directions`
**File:** `backend/app/tools/directions.py`

**Purpose:** Get route between two points with polyline and turn-by-turn steps.

**Parameters:**
```
origin: str       — "lat,lng" string (e.g., "35.7147,139.7966")
destination: str  — "lat,lng" string
mode: str         — DRIVE | WALK | BICYCLE | TRANSIT | TWO_WHEELER (default: TRANSIT)
```

**Google API:** POST `/directions/v2:computeRoutes`

**Returns:**
```json
{
  "duration": "25 min",
  "distance": "3.2 km",
  "steps": [
    { "instruction": "Take Ginza Line toward Shibuya", "distance": "2.8 km", "duration": "20 min" },
    ...
  ],
  "polyline": "encoded_polyline_string_here"
}
```

**Side effects:** None.

**Business rule:** In `days` mode, the LLM may call `get_directions` at most **2 times per day** —
only for the first transition (airport/hotel → first activity) and the last transition (last activity
→ hotel/airport). All other transitions omit the polyline.

**Also exposed as REST endpoint:** `POST /api/directions` — used by the frontend's DayMiniMap to
fetch live polylines when the user focuses an activity row (debounced 400ms).

---

#### `get_weather`
**File:** `backend/app/tools/weather.py`

**Purpose:** Current conditions + 5-day forecast for a city.

**Parameters:**
```
city: str         — City name (e.g., "Tokyo, Japan")
date: str|None    — ISO date hint for forecast alignment (optional)
```

**Google APIs used:**
1. Geocoding: resolve `city` → lat/lng
2. `weather.googleapis.com/v1/currentConditions:lookup` → current temp + condition
3. `weather.googleapis.com/v1/forecast/days:lookup` → 5-day forecast

**Returns:**
```json
{
  "temp": 18.5,
  "condition": "Partly cloudy",
  "humidity": 65,
  "forecast": [
    { "date": "2026-04-20", "temp_max": 22.0, "temp_min": 14.0, "condition": "Sunny" },
    ...
  ]
}
```

**Side effects:** None.

**Error handling:** Gracefully returns `{ "condition": "Weather unavailable" }` for ocean tiles,
disputed territories, or API 404. The LLM handles missing weather without halting.

---

#### `geocode_city`
**File:** `backend/app/tools/geocode.py`

**Purpose:** Resolve a city name to canonical name, country, and lat/lng.

**Parameters:**
```
query: str   — City name or "City, Country" (e.g., "Tokyo" or "Paris, France")
```

**Google API:** GET `/maps/api/geocode/json?result_type=locality|administrative_area_level_1|country`

**Returns (success):**
```json
{ "name": "Tokyo", "formatted": "Tokyo, Japan", "country": "Japan", "lat": 35.6762, "lng": 139.6503 }
```

**Returns (no match):**
```json
{ "error": "No match for 'Atlantis'" }
```

**Side effects:** None.

**Note:** Called in `plan` mode to get precise lat/lng for the destination and origin — used by
`search_flights` for IATA airport lookup and by the globe visualization for flight arc rendering.

---

#### `search_flights`
**File:** `backend/app/tools/flights.py`

**Purpose:** Get real or estimated flight options between two airports.

**Parameters:**
```
origin: str        — IATA code or city name (e.g., "HKG" or "Hong Kong")
destination: str   — IATA code or city name (e.g., "NRT" or "Tokyo")
date: str|None     — ISO date (e.g., "2026-04-20")
seat_class: str    — economy | business | first (default: economy)
```

**Strategy (two-stage):**

1. **Live data via `fast-flights`** (reverse-engineered Google Flights protobuf):
   - Attempts real flight data with 8s socket timeout.
   - Temporarily clears `HTTP_PROXY`/`HTTPS_PROXY` env vars (Google Flights blocks datacenter exits).
   - Thread-safe env mutation via `threading.Lock` (macOS `unsetenv()` deadlock prevention).
   - Deduplicates results by (airline, price, departure_time).
   - Selects diverse options: cheapest nonstop (recommended), fastest nonstop, alternative airline,
     cheap 1-stop, budget 1-stop, premium nonstop. Pads to 8 options.

2. **Fallback estimator** (if fast-flights is blocked or returns <3 options):
   - Distance bands → base price (calibrated to median fares):
     `<500km=$80, <1500km=$140, <3000km=$280, <6000km=$480, <9000km=$720, <12000km=$900, else=$1100`
   - Seasonality multiplier per month (peak: Jul/Aug/Dec 1.35; shoulder: Apr/May/Sep/Oct 1.0; low: Jan/Feb/Mar/Nov 0.85)
   - Generates 3 synthetic nonstop options (early/midday/evening) + 2–4 one-stop variants for distances >2000km
   - HKD conversion: fixed rate 7.78 HKD/USD, rounded to nearest 10 HKD

**Returns:**
```json
{
  "from_city": "Hong Kong", "from_iata": "HKG", "from_lat": 22.308, "from_lng": 113.918,
  "from_alternates": [{ "iata": "SZX", "name": "Shenzhen Bao'an", "lat": 22.639, "lng": 113.811, "km_from_primary": 48.2 }],
  "to_city": "Tokyo", "to_iata": "NRT", "to_lat": 35.764, "to_lng": 140.386,
  "to_alternates": [{ "iata": "HND", "name": "Tokyo Haneda", ... }],
  "date": "2026-04-20",
  "currency": "HKD",
  "options": [
    {
      "label": "Cathay Pacific — Non-stop (Recommended)",
      "type": "non-stop",
      "airline": "Cathay Pacific",
      "price_low": 2680, "price_high": 3120,
      "duration_min": 200,
      "stops": 0, "stop_cities": [],
      "departure_time": "09:30", "arrival_time": "14:50",
      "recommended": true,
      "seat_class": "economy", "seat_class_label": "Economy"
    },
    ...
  ],
  "return_options": [...],
  "estimate_low": 2680, "estimate_high": 5400,
  "duration_min": 200, "stops_typical": 0,
  "source": "fast-flights",
  "google_flights_url": "https://www.google.com/travel/flights/..."
}
```

**Side effects:** None.

---

#### `get_day_windows`
**File:** `backend/app/tools/day_windows.py`

**Purpose:** Calculate usable activity windows for each trip day based on flight times.

**Parameters:**
```
flight: dict|None    — The flight object from search_flights (for arrival/departure times)
trip_days: int       — Number of trip days (default 3)
start_date: str|None — ISO date of trip start (used if no flight object)
```

**Returns:** `list[dict]`
```json
[
  {
    "day": 1, "date": "2026-04-20",
    "start_time": "16:15", "end_time": "22:00",
    "notes": "Arrived 14:45 NRT — hotel check-in and one nearby dinner only",
    "arrival_airport": { "iata": "NRT", "city": "Tokyo", "lat": 35.764, "lng": 140.386, "arrival_time": "14:45" },
    "departure_airport": null
  },
  {
    "day": 2, "date": "2026-04-21",
    "start_time": "09:00", "end_time": "21:00",
    "notes": "Full day",
    "arrival_airport": null, "departure_airport": null
  },
  {
    "day": 3, "date": "2026-04-22",
    "start_time": "09:00", "end_time": "11:30",
    "notes": "Departure 14:30 NRT — check out, light morning activity, airport by 11:30",
    "arrival_airport": null,
    "departure_airport": { "iata": "NRT", "city": "Tokyo", "lat": 35.764, "lng": 140.386,
                           "departure_time": "14:30", "origin_iata": "HKG", "origin_city": "Hong Kong", ... }
  }
]
```

**Day 1 end time logic:**
- Arrival ≥ 20:00 (very late): end = 23:00
- Arrival ≤ 13:00 (early): end = 21:00
- Otherwise: end = 22:00

**Last day end time logic:**
- Departure ≤ 12:00 (early): constrained morning window
- Departure ≥ 18:00 (late): full day with 3h airport buffer
- Otherwise: partial day ending at departure - 3h

**Side effects:** None.

---

#### `get_phrasebook`
**File:** `backend/app/tools/phrasebook.py`

**Purpose:** Return useful local phrases for the destination's language.

**Parameters:**
```
destination: str   — City or country name (e.g., "Tokyo" or "Japan")
```

**Supported languages:** Japanese (`ja`), Korean (`ko`), Chinese (`zh`), French (`fr`),
Spanish (`es`), German (`de`), Italian (`it`), Thai (`th`)

**Returns (success):**
```json
{
  "language": "Japanese", "language_code": "ja",
  "phrases": [
    { "key": "hello", "english": "Hello", "romanized": "Konnichiwa", "native": "こんにちは" },
    { "key": "thank_you", "english": "Thank You", "romanized": "Arigatou gozaimasu", "native": "ありがとうございます" },
    ...
  ]
}
```

**Returns (no match):** `{ "error": "No phrasebook for 'Antarctica'" }`

**Side effects:** None. (Pure in-memory lookup — no network call.)

---

### UI Tools

These tools do NOT fetch external data. They signal the frontend to update UI state. They emit a
parallel SSE event immediately (before the tool result is returned to the LLM).

---

#### `navigate_menu`
**File:** `backend/app/tools/navigate.py`

**Purpose:** Signal the frontend to switch to a different panel.

**Parameters:**
```
panel: str         — FLIGHTS | HOTELS | DAYS (case-insensitive)
item: str|None     — Optional: select a specific item by name
filter: dict|None  — Optional: apply a filter (e.g., { "price_level": "$" })
```

**Returns:** `{ "navigated": true, "panel": "FLIGHTS", "item": null, "filter": null }`

**SSE side effect:** Emits `{ type: "navigate", data: { panel, item, filter } }` — frontend buffers
this in `pendingNavigateRef` and flushes it after `setCurrentItinerary` completes (prevents race
condition where navigate fires before new itinerary data is merged).

**Business rule:** Each scoped prompt (plan/hotels/days) must call `navigate_menu` ONCE at the very
end. Calling it mid-stream (before emitting the JSON block) causes the frontend to switch panels
before data is available.

---

#### `request_input`
**File:** `backend/app/tools/request_input.py`

**Purpose:** Ask the user to fill in a specific trip form field before planning can proceed.

**Parameters:**
```
field: str          — destination | start_date | end_date | transport | party_size | interests | origin
prompt: str         — The question to display to the user
options: list|None  — Optional dropdown choices (e.g., ["economy", "business", "first"])
```

**Returns:** `{ "requested": true, "field": "destination", "prompt": "...", "options": null }`

**SSE side effect:** Emits `{ type: "request_input", data: { field, prompt, options } }` — frontend
switches to HOME panel, focuses the named field, and displays the prompt text.

**Hard-stop rule:** If `request_input` appears in a tool batch, ALL other tools in the same batch
are dropped. The LLM loop breaks immediately after `request_input` executes. This prevents
`navigate_menu` or `search_flights` from co-firing with a pending user question.

---

#### `toggle_setting`
**File:** `backend/app/tools/ui_tools.py`

**Purpose:** Change an app setting on behalf of the user.

**Parameters:**
```
setting: str   — tts_enabled | theme | currency | subtitle_size | auto_replan
value: any     — The new value (e.g., true, "dark", "USD", "large", false)
```

**Returns:** `{ "ok": true, "setting": "currency", "value": "USD" }`

**SSE side effect:** Emits `{ type: "setting_change", data: { setting, value } }` — frontend
updates corresponding state and persists to localStorage.

---

#### `submit_trip_form`
**File:** `backend/app/tools/ui_tools.py`

**Purpose:** Pre-fill the PLAN form and optionally trigger planning automatically.

**Parameters (all optional):**
```
destination: str
origin: str
start_date: str   — ISO date
end_date: str
transport: str    — transit | drive | walk
party_size: int
interests: str
```

**Returns:** `{ "ok": true, "action": "submit_trip_form", "prefill": { ...provided fields } }`

**SSE side effect:** Emits `{ type: "submit_form", data: {...} }` — frontend switches to HOME,
populates form fields, and may auto-start planning.

---

## 4. Business Logic

### Itinerary Construction Rules

These rules are enforced by `SYSTEM_PROMPT_DAYS` and validated by the frontend:

| Rule | Detail |
|------|--------|
| Day 1 first activity | Must be arrival airport. Time = arrival_time + 90 min. From `get_day_windows.arrival_airport`. |
| Day 1 activity window | Arrival ≥20:00 → end 23:00. Arrival ≤13:00 → end 21:00. Otherwise → end 22:00. |
| Last day last activity | Must be departure airport. Time = departure_time - 180 min. |
| Middle days | 09:00–21:00 window. Min 5 real activities. Min 2 meal stops. |
| Hotel/airport anchors | Immutable — not draggable, not removable. All other activities are draggable. |
| Transport per activity | Only first and last transitions of each day get `transport_to_next` with polyline. |
| Activity descriptions | LLM writes 10–15 words from own knowledge. Does NOT call `get_place_details`. |
| Weather per day | Required. Every day object must have a `weather` field. |
| Coords required | Every activity must have `lat` and `lng` (from `search_places` result). |

---

### Flight Search Pipeline

```
1. Resolve IATA codes
   geocode_city(origin) + geocode_city(destination)
   → airports.py: nearest airport from lat/lng → IATA code

2. Attempt fast-flights (live data)
   → Patch _ff_core.fetch with 8s socket timeout
   → Clear proxy env vars (thread-safe, _env_lock)
   → Fetch from Google Flights protobuf endpoint
   → If <3 results or network error → fall through to estimator

3. Estimator fallback (deterministic)
   haversine distance → price band → base_price
   × seasonality_multiplier[month]
   → Generate 3 nonstop + 2-4 one-stop options
   → Convert to HKD (7.78 HKD/USD, round to nearest 10)

4. Deduplicate + select diverse options
   dedup by (airline, price_num, departure_time)
   pick: cheapest nonstop (recommended), fastest nonstop, alternative airline,
         cheap 1-stop, budget 1-stop, premium nonstop
   pad to 8 from remaining results

5. Attach Google Flights deep link
   google_flights_url always included for live price verification

6. Include alternate airports
   airports.py: for both origin and destination, find alternates within 100 km
```

---

### JSON Extraction Pipeline

The LLM embeds itinerary JSON inside its text reply. Extraction happens in `llm.py:_extract_itinerary()`:

```
1. Try fenced ```json block
   regex: r"```json\s*([\s\S]*?)```"
   → if found, parse contents

2. Scan for "itinerary" keyword
   find index of "itinerary" substring in reply
   walk backwards to find opening {
   use _balanced_json_object() to extract complete object

3. Sanitize backslashes
   _sanitize_json(): doubles backslashes inside JSON strings
   (Google polyline encodings contain \ that break standard JSON)

4. Parse
   try json.loads(raw)
   → if fails: try json.loads(sanitized)
   → if still fails: try json_repair(raw)  ← third-party repair lib

5. Extract
   data["itinerary"] if found, else None
```

If extraction fails entirely, `itinerary=None` is returned and the frontend shows the text reply
without rendering any panels.

---

### Itinerary Merge Strategy (Frontend)

The frontend merges incoming itinerary data **additively** — new data is spread on top of existing
state, not replaced wholesale. This preserves earlier picks when only one section changes.

```javascript
// In App.jsx, after done event:

const merged = { ...currentItinerary, ...incoming };

// Turn 1 detection: if flight arrives but hotels/days don't → clear stale data
if (incoming.flight && !incoming.hotels?.length && !incoming.days?.length) {
  merged.hotels = [];
  merged.selected_hotel = null;
  merged.days = [];
}

// String resolution: LLM sometimes sends selected_hotel as a name string
if (typeof merged.selected_hotel === "string") {
  merged.selected_hotel = merged.hotels?.find(h => h.name === merged.selected_hotel) || null;
}

setCurrentItinerary(merged);

// Navigate events are buffered and flushed AFTER setCurrentItinerary completes
if (pendingNavigateRef.current) {
  menuState.navigate(pendingNavigateRef.current);
  pendingNavigateRef.current = null;
}
```

**Why buffer navigate?** SSE events arrive in order: `navigate` fires before `done`. If the
frontend switched panels immediately on `navigate`, the panel would render with no data (the
itinerary hasn't been merged yet). The buffer ensures navigation happens after data is ready.

---

### Context Pruning

To prevent unbounded token growth across multi-round tool loops:

```python
# backend/app/llm.py: _prune_tool_results()

keep_recent_rounds = 3  # reasoning models
keep_recent_rounds = 2  # non-reasoning models

# Round boundary = role=assistant message
# Keep last N full rounds intact
# All older role=tool messages → content = "[tool result omitted]"
```

This is called after every tool-call round. For a 6-round loop with `keep=2`, rounds 1–4 are
summarized and rounds 5–6 are kept verbatim.

---

### `request_input` Hard-Stop Rule

```python
# backend/app/llm.py, inside _run_loop tool execution:

calls_to_run = tool_calls

if any(tc.function.name == "request_input" for tc in calls_to_run):
    # Drop all other tools from this batch
    calls_to_run = [tc for tc in calls_to_run if tc.function.name == "request_input"]
    # After executing, break the loop
    break_after_tools = True
```

**Why:** The LLM sometimes calls `request_input` AND `navigate_menu` or `search_flights` in the
same batch. If `navigate_menu("FLIGHTS")` ran alongside `request_input`, the UI would switch to
FLIGHTS before the user answers the question — a confusing state. Filtering to only `request_input`
and hard-stopping prevents this.

---

### Photo Proxy

All Google Places photo URLs are relative paths served through the backend proxy:

```
Frontend renders:  <img src="/photo/places/ChIJ.../photos/AeXyz..." />
                                              ↓
Backend:  GET /photo/{photo_name:path}
  → Reconstructs resource name
  → Fetches from Google Places API with GOOGLE_MAPS_API_KEY server-side
  → Streams bytes back to browser
  → Sets Cache-Control: public, max-age=86400

photoSrc() helper (api/client.js):
  → Builds absolute URL: http://{host}:8000/photo/...
  → Handles already-absolute URLs (http/https) as-is (for external sources)
```

The API key never appears in browser network logs.

---

### Route Optimization (TSP)

Exposed as `POST /itinerary/optimize`. Used optionally by the frontend's "Optimize Route" button.

```
Algorithm: Nearest-Neighbor + 2-opt

1. nearest_neighbor(points, start_idx=0)
   O(n²) greedy: from current position, visit closest unvisited next
   Returns initial order

2. two_opt_improve(points, order, max_iter=100)
   Iteratively reverse segments [i+1..j] if it shortens total tour
   Convergence: typically 5–10 iterations for 5–15 stops

3. Compare before/after
   If 2-opt result is worse (floating-point edge case), keep original

Input:  [{ name, lat, lng, extra: { time, address, photo_url, ... } }]
Output: { ordered: [...], distance_km_before, distance_km_after, savings_pct }

Hotel and airport anchors (first/last activity of day) are NOT included in the optimize request
— caller strips them before sending and re-inserts after.
```

---

## 5. SSE Event Stream Reference

`POST /chat/stream` produces Server-Sent Events. Format:
```
event: {type}\n
data: {json_payload}\n
\n
```

Every event payload includes `"t"` (milliseconds since request start) for waterfall profiling.

| Event Type | When | Payload |
|-----------|------|---------|
| `thinking` | Start of each LLM round | `{ round: int, t: int }` |
| `token` | Each streaming text chunk | `{ text: str, t: int }` |
| `tool_start` | Before a tool executes | `{ name: str, args: dict, t: int }` |
| `tool_end` | After a tool completes | `{ name: str, elapsed_ms: int, t: int }` |
| `partial_itinerary` | When search_flights or search_places (hotels) finishes | `{ flight?: {...}, hotels?: [...], _emitted_at: int, t: int }` |
| `navigate` | When `navigate_menu` tool executes | `{ panel: str, item: str|null, filter: dict|null, t: int }` |
| `request_input` | When `request_input` tool executes | `{ field: str, prompt: str, options: list|null, t: int }` |
| `setting_change` | When `toggle_setting` tool executes | `{ setting: str, value: any, t: int }` |
| `submit_form` | When `submit_trip_form` tool executes | `{ destination?: str, origin?: str, ..., t: int }` |
| `model_fallback` | When LLM switches from xAI to Gemini | `{ reason: "outage"|"region_restricted", t: int }` |
| `done` | Loop complete, final response ready | `{ reply: str, itinerary: dict|null, tool_calls_made: list[str], t: int }` |
| `error` | Unrecoverable error | `{ status: int, message: str, t: int }` |

**UI tool events arrive twice:** once as `tool_start`/`tool_end` (standard), and once as a
parallel dedicated event (`navigate`, `request_input`, `setting_change`, `submit_form`). The
dedicated event fires immediately so the frontend can react without waiting for the tool result
to be fed back to the LLM.

**Partial itinerary:** The `partial_itinerary` event allows the frontend to display flight options
immediately after `search_flights` completes — before the LLM has finished emitting the full
JSON block. This means the user sees FLIGHTS populate during the streaming phase, not after `done`.

---

## 9. Data Schemas

### Itinerary (canonical shape)

```typescript
interface Itinerary {
  title: string;
  destination: string;
  origin?: string;
  local_transport_mode?: string;   // "TRANSIT" | "DRIVE" | etc.

  flight?: Flight;
  selected_flight?: FlightOption;
  selected_return_flight?: FlightOption;

  hotels?: Hotel[];
  selected_hotel?: Hotel | null;

  days?: Day[];
  phrasebook?: Phrasebook;
}

interface Flight {
  from_city: string;   from_iata: string;   from_lat?: number;   from_lng?: number;
  from_alternates: AlternateAirport[];
  to_city: string;     to_iata: string;     to_lat?: number;     to_lng?: number;
  to_alternates: AlternateAirport[];
  date?: string;               // ISO YYYY-MM-DD
  return_date?: string;
  options: FlightOption[];
  return_options: FlightOption[];
  source: "fast-flights" | "estimator";
  google_flights_url?: string;
  estimate_low?: number;        // in destination currency
  estimate_high?: number;
  duration_min?: number;
  stops_typical?: number;
}

interface FlightOption {
  label?: string;
  type?: string;                 // "non-stop" | "1-stop" | "1-stop budget"
  airline?: string;
  price_low?: number;
  price_high?: number;
  duration_min?: number;
  stops?: number;
  stop_cities?: string[];        // ["BKK"] for 1 stop
  departure_time?: string;       // "HH:MM"
  arrival_time?: string;
  recommended?: boolean;
  seat_class?: string;
  seat_class_label?: string;
}

interface Hotel {
  name: string;
  address: string;
  rating?: number;
  price_level?: string;          // "$" | "$$" | "$$$" | "$$$$" | "Free"
  photo_url?: string;            // Relative path for photo proxy
  lat?: number;
  lng?: number;
  place_id?: string;
}

interface Day {
  day: number;
  date?: string;                 // ISO YYYY-MM-DD
  theme?: string;
  weather?: Weather;
  activities: Activity[];
}

interface Activity {
  time: string;                  // "HH:MM"
  name: string;
  address: string;
  duration_min?: number;
  description?: string;
  place_id?: string;
  photo_url?: string;
  lat?: number;
  lng?: number;
  transport_to_next?: TransportStep;
  user_note?: string;            // User-authored, never from LLM
}

interface TransportStep {
  mode: string;                  // TRANSIT | DRIVE | WALK | BICYCLE
  duration: string;              // "25 min"
  distance: string;              // "3.2 km"
  polyline?: string;             // Encoded polyline for map rendering
  steps?: RouteStep[];
}

interface Weather {
  temp?: number;                 // Celsius
  condition: string;
  humidity?: number;
  forecast?: ForecastDay[];
}

interface ForecastDay {
  date: string;
  temp_max?: number;
  temp_min?: number;
  condition: string;
}
```

### Message (conversation history)

```typescript
interface Message {
  role: "user" | "assistant";
  content: string;               // For assistant: may contain ```json itinerary block
}
```

### Plan History Entry (localStorage)

```typescript
interface PlanHistoryEntry {
  id: string;                    // 8-char hex
  created_at: number;            // Unix timestamp ms
  destination: string;
  origin?: string;
  start_date?: string;
  end_date?: string;
  day_count?: number;
  itinerary: Itinerary;
  messages: Message[];
}
```

---

## 6. TTS Pipeline

The subtitle/TTS system converts LLM reply text into spoken narration displayed in the
bottom subtitle bar. It is implemented in `frontend/src/hooks/useSubtitleQueue.js`.

### Architecture

```
LLM reply text
    ↓
splitSentences()           — strip markdown, split on .!? boundaries
    ↓
FIFO queue (queueRef)      — sentences enqueued; display starts immediately
    ↓
advance()                  — dequeues next sentence, shows subtitle, fetches audio

Primary path:  POST /speech/tts (xAI "ara" neural voice, MP3)
               ↓ on 503 / 204 / network error
Fallback path: window.speechSynthesis (best available English voice, rate 1.0×)
               ↓ on audio.onerror or play() rejection
Same fallback

Audio advance: HTMLAudioElement.onended → advance()   (real speech duration)
Safety timer:  max(15000ms, text.length × 80ms)       (guards against onended never firing)
Display timer: max(2500ms, min(text.length × 60ms, 6000ms))  (for fallback / muted items)
```

### Text Cleaning (`splitSentences` + backend `_clean`)

Both the frontend splitter and the backend TTS `_clean()` function apply the same
transformations so the same spoken text is clean regardless of which path is taken:

| Pattern | Replacement |
|---------|-------------|
| ` ``` json ... ``` ` (code fences) | removed |
| `**bold**` | `**` stripped |
| `## Heading` lines | entire line removed |
| `- item` / `• item` / `* item` | list marker stripped |
| `1. item` / `2) item` | numbered marker stripped |
| ` — ` (em-dash with spaces) | `, ` (comma) |
| multiple whitespace | collapsed to single space |

Sentences are split on `.`, `!`, `?` followed by whitespace (lookbehind preserves
the punctuation). Empty fragments after stripping are discarded.

### 1-Sentence Lookahead

While sentence N is playing, the queue pre-fetches sentence N+1 from the backend.
This hides the ~300–500ms xAI TTS latency so consecutive sentences play without
a noticeable gap.

```
Sentence 1 playing
    └─ lookahead: fetch sentence 2 → stored in lookaheadRef

Sentence 1 ends → advance()
    └─ sentence 2 already in lookaheadRef → plays immediately
    └─ lookahead: fetch sentence 3
```

If the queue order changes (e.g., `clear()` is called), the stale lookahead is
aborted via `AbortController`.

### Fallback Voice Selection Priority

When the backend returns 503 (key missing, rate-limited) or the audio fails to decode:

1. `Google (US|UK) English Female` — Chrome Neural voice
2. Any `Google` voice
3. `Samantha`, `Karen`, `Moira`, `Tessa`, `Fiona`, `Microsoft Zira`, `Microsoft David`
4. First English voice (`lang` starts with `en-` or `en_`)
5. First available voice (any language)

Rate is fixed at `1.0×`. Voice and rate are **not user-configurable** — the only
TTS setting exposed to users is MUTE (M hotkey or Settings toggle).

### Pause / Resume

`pause()` / `resume()` are exposed by the hook and called by `Subtitle.jsx` on
hover (so users can mouse-over the subtitle bar to freeze playback and read).

- `pause()`: sets `pausedRef`, clears safety timer, pauses `HTMLAudioElement`,
  calls `speechSynthesis.pause()`
- `resume()`: clears `pausedRef`, resumes audio element or re-arms safety timer

### Mute Behaviour

When `muted=true` is passed to the hook:
- `mutedRef` is updated synchronously
- Currently-playing audio is paused immediately
- `speechSynthesis.cancel()` is called
- Queued items still display as subtitles (text shown, no audio)
- Lookahead fetches are skipped

### Backend: `POST /speech/tts`

**File:** `backend/app/routers/speech.py`

```
Request:  { text: str, voice: str = "ara" }
Response: MP3 bytes (audio/mpeg) on success
          HTTP 503 with X-TTS-Error header on key missing / API error
          HTTP 204 on empty text after cleaning
```

Available voices (xAI): `ara` (default), `sal`, `eve`, `rex`, `leo`

The backend `_clean()` strips the same patterns as `splitSentences` — code fences,
markdown bold, headings, list markers, em-dashes — ensuring the text-to-speech
receives clean prose even if the raw LLM reply still contains formatting.

Returns HTTP 503 (not 500) so the frontend can distinguish "TTS unavailable →
use browser fallback" from a genuine server error.

---

## 7. Hotkey System

### Design Philosophy

The hotkey system follows a set of principles that govern all current and future key
assignments. Understanding these avoids inconsistency when adding new features.

**1. Hotkeys open; Esc closes. Hotkeys are not toggles.**

Pressing `H` opens History. Pressing `H` again while History is open does nothing —
the keyboard hook is disabled whenever any overlay is open (`enabled` flag in
`useKeyboard`). Esc is the single, universal close key across all overlays.

*Rationale:* Toggles require the user to remember "is it open or closed?" before
pressing. Esc is unambiguous — it always means "go back / close." This matches
every major UI convention (browser DevTools, modal dialogs, VS Code panels).

**2. Only one overlay at a time.**

`enabled: !historyOpen && !settingsOpen && !helpOpen && !printOpen && !checklistOpen && !favoritesOpen && !statusOpen`

When any overlay is open, the global keyboard hook is fully disabled. This prevents
hotkeys from accidentally opening a second overlay behind the first. Each overlay
manages its own internal key handling (Esc to close, and any overlay-specific keys
like `R` to refresh in Service Status).

**3. Modifier keys gate system vs. app actions.**

Bare letter keys (`H`, `S`, `T`, `M`, `C`, etc.) trigger app-level overlay and
navigation actions. `Cmd/Ctrl+key` is reserved for system-level or standard OS
shortcuts (`Cmd+K` for command palette, `Cmd+Z`/`Y` for undo/redo). Never assign
a bare letter key to something a modifier key already owns (e.g., don't use `P`
for something different from print, since `Cmd+P` is the browser print shortcut
and the bare `P` is already claimed for the print view).

**4. Tab advances panels. Arrow keys move the list cursor only.**

`Tab` cycles forward through panels (PLAN → FLIGHTS → HOTELS → DAYS → PLAN).
`↑/↓` always move the list cursor on list-bearing panels.
`←/→` are not used for panel navigation — they are reserved for sub-components
that may need them (photo gallery, date pickers). `1–4` provide direct panel jumps.
Having two separate mechanisms for panel switching (arrows + Tab) creates confusion
and bugs (arrow keys can get swallowed by focused elements); Tab is unambiguous.

**5. ↑/↓ always move the list cursor.**

`↑/↓` move the cursor on any list-bearing panel regardless of what else has focus.
The action is always unambiguous — there is no panel-level element where ↑/↓ means
something other than "move cursor up/down in the list."

**6. Space activates the focused list item on FLIGHTS and HOTELS.**

`Space` picks the currently highlighted flight or hotel — the same as clicking their
PICK button. It does not activate anything on HOME or DAYS (no PICK button there).
No scope check is needed; the activation handler checks `panel` directly.

**7. When the cursor reaches a boundary, native scroll takes over.**

`ArrowUp` at `listIndex=0` does not call `preventDefault()`, allowing the browser
to scroll the list container up naturally. Same for `ArrowDown` at the last item.
This makes keyboard navigation feel continuous rather than stuck.

**8. Inputs suppress all hotkeys except Esc.**

While the user is typing in any `INPUT`, `TEXTAREA`, or `contentEditable` element,
all hotkeys are suppressed. Esc blurs the input and re-activates hotkeys. This
prevents accidental overlay opens while filling in the trip form.

---

### Full Hotkey Reference

#### Navigation

| Key | Condition | Action |
|-----|-----------|--------|
| `Tab` | always | Advance to next panel (wraps: PLAN→FLIGHTS→HOTELS→DAYS→PLAN) |
| `1` | always | Jump to PLAN |
| `2` | always | Jump to FLIGHTS |
| `3` | always | Jump to HOTELS |
| `4` | always | Jump to DAYS |
| `↑` | list panel, `listIndex>0` | Move list cursor up |
| `↓` | list panel, `listIndex<max` | Move list cursor down |

#### Actions

| Key | Condition | Action |
|-----|-----------|--------|
| `Space` | FLIGHTS or HOTELS panel | Activate focused item (pick flight / hotel) |
| `T` | not modifier | Open chat popover (`ChatPopover`) |
| `Cmd/Ctrl+K` | modifier | Open chat popover (command-palette convention) |
| `Cmd/Ctrl+Z` | modifier | Undo last flight/hotel pick |
| `Cmd/Ctrl+Shift+Z` | modifier | Redo |
| `Cmd/Ctrl+Y` | modifier | Redo (Windows convention) |
| `M` | not modifier | Toggle mute (TTS audio on/off) |
| `Esc` | overlay open | Handled internally by each overlay (close) |
| `Esc` | chat popover open | Close chat popover |

#### Overlays (all open-only; close via Esc or backdrop click)

| Key | Opens | Internal keys |
|-----|-------|---------------|
| `?` | Help overlay | `Esc` close |
| `H` | History overlay | `↑/↓` navigate turns, `E` edit turn, `Esc` close |
| `S` | Settings overlay | `↑/↓` row, `Space` activate, `Esc` close |
| `P` | Print view | `Esc` close |
| `L` | Trip checklist | `Esc` close |
| `F` | Favorites overlay | `Esc` close |
| `C` | Service status overlay | `R` re-probe all services, `Esc` close |

---

### Adding New Hotkeys

Checklist for adding a new hotkey:

1. **Pick an unambiguous letter.** Check the full reference above. Avoid letters
   already used by the OS or browser at the modifier level (e.g., `Cmd+P` = print,
   `Cmd+S` = save — using bare `P`/`S` is fine since modifiers are separate).

2. **Decide: action or overlay?**
   - Action (mute, undo, chat): add a `case` to the `switch` in `useKeyboard.js`.
     Use `!e.metaKey && !e.ctrlKey` guard for bare-letter actions.
   - Overlay: add `const [xyzOpen, setXyzOpen] = useState(false)` in `App.jsx`,
     wire an `onOpenXyz` callback into the `useKeyboard` call (`setXyzOpen(true)`),
     add the new state to the `enabled` condition, and add an `Esc` + backdrop-click
     handler inside the overlay component.

3. **Never make it a toggle.** The callback should call `setState(true)` only.
   Esc / backdrop click owns the close path.

4. **Suppress in inputs.** The global `isTypingField` guard already covers this —
   no extra work needed.

5. **Add to FooterHints.** Update `FooterHints.jsx` to show the new key hint in
   the relevant panel context. Keep hints terse (3–5 chars label).

6. **Document it here** in the Full Hotkey Reference table.

---

## 8. Service Status Overlay

**Triggered by:** `C` hotkey  
**Component:** `frontend/src/components/ServiceStatusOverlay.jsx`  
**Backend:** `GET /status` (`backend/app/routers/status.py`)

### What It Shows

One row per external service, each probed concurrently (5s timeout each):

| Service ID | Label | Probe method |
|-----------|-------|-------------|
| `xai_llm` | xAI LLM (grok-4.20) | `GET {XAI_BASE_URL}/models` with bearer auth |
| `xai_tts` | xAI TTS (ara) | Same probe as LLM (shares key/endpoint) |
| `google_maps` | Google Maps Platform | `GET /maps/api/geocode/json?address=London` |

Each row displays:
- Coloured status dot (green / amber / red / grey)
- Status badge: **OK** / **SLOW** / **ERROR** / **NO KEY**
- Latency in ms (hidden for `unconfigured`)
- Detail string (e.g., `"XAI_API_KEY not set"`, `"HTTP 403"`) on non-OK rows

### Status Logic

```python
"ok"           — probe returned 200 AND latency < 2000ms
"degraded"     — probe returned 200 BUT latency >= 2000ms  → badge: SLOW
"error"        — non-200 HTTP response or network exception → badge: ERROR
"unconfigured" — API key not set or is a placeholder value  → badge: NO KEY
```

Overall status is `"ok"` only if all three services are `"ok"`. Otherwise `"degraded"`.

### Response Shape

```json
{
  "overall": "ok" | "degraded",
  "checked_at": "2026-04-15T14:52:30.123Z",
  "services": [
    { "id": "xai_llm",    "label": "xAI LLM (grok-4.20)",  "status": "ok",           "latency_ms": 312.4, "detail": null },
    { "id": "xai_tts",    "label": "xAI TTS (ara)",         "status": "ok",           "latency_ms": 298.1, "detail": null },
    { "id": "google_maps","label": "Google Maps Platform",  "status": "unconfigured", "latency_ms": 0.0,   "detail": "GOOGLE_MAPS_API_KEY not set" }
  ]
}
```

### Overlay Behaviour

- **Opens on `C`:** `useKeyboard` calls `onOpenStatus` → `setStatusOpen(true)`
- **Fetch on open:** `useEffect` triggers `fetchStatus()` immediately when `open` becomes `true`
- **Loading state:** pulsing spinner + "PROBING SERVICES…" while fetch is in-flight
- **R to re-probe:** internal `keydown` handler calls `fetchStatus()` again
- **Esc to close:** internal `keydown` handler calls `onClose()`
- **Backdrop click:** `onClick={onClose}` on the backdrop `div`
- **Focus management:** saves `document.activeElement` on open, restores it on close
  (consistent with all other overlays)

---

## 10. Known Limitations & Gaps

| # | Area | Description |
|---|------|-------------|
| 1 | Chat mode — pick/replace tools not yet implemented | `pick_flight`, `pick_hotel`, and `replace_activity` tools are designed (§1.3) but not yet built. Until they exist, chat cannot pick flights/hotels or replace activities — user must use the UI buttons. Backend tools needed: `pick_flight(label_or_index)`, `pick_hotel(name_or_index)`, `replace_activity(day, activity_name, query)`. Each emits an SSE event; frontend handles it identically to the corresponding button click. |
| 2 | fast-flights reliability | Google Flights blocks datacenter IPs. In production/cloud deployments, `search_flights` will almost always fall back to the estimator. Prices are reasonable estimates but not live fares. |
| 3 | Reasoning model latency | `grok-4.20-0309-reasoning` TTFT is 26–33s (vs 7–16s non-reasoning). Use non-reasoning for all 3 planning turns unless the trip is unusually complex. |
| 4 | Output token volume | Hotels and days prompts generate large JSON. This — not inference speed — is the primary latency bottleneck. `SYSTEM_PROMPT_HOTELS` was trimmed 73% and `SYSTEM_PROMPT_DAYS` 76% in round 21 to address this. |
| 5 | No real session persistence | All state is localStorage. Multi-device sync and sharing require the `/itinerary` save/retrieve endpoints, but there's no UI to generate/share a link. |
| 6 | Single-city itineraries only | Multi-city trips (HKG → TYO → OSA → HKG) are not supported. The `days` structure assumes one destination. |
| 7 | get_place_details underused | The tool exists but is forbidden in hotels/days prompts for latency reasons. Place detail quality (descriptions, hours) relies on `search_places` editorialSummary which is often short. |
| 8 | Weather API geo-coverage | Google Weather API returns 404 for ocean tiles and some disputed territories. The graceful fallback returns `"condition": "Weather unavailable"` but the frontend weather strip goes blank. |
