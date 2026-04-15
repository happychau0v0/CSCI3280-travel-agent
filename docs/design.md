# Design Spec: Button-First Interaction Model

> Last updated: 2026-04-15 (added visa alert feature)

---

## Purpose

This document defines the intended interaction model, user flow, and LLM
scoping strategy for the AI Travel Agent. It supersedes the chat-centric
description in `docs/architecture.md`.

The core principle: **buttons are the primary interface; chat is a UI
control agent.** A user should be able to plan a complete trip — flights,
hotel, daily itinerary — without ever opening the chat popover. Chat exists
so a user can say "change my destination to Osaka" and have the agent update
the form and trigger planning on their behalf.

---

## User Flow

```
┌─────────────────────────────────────────────────────────────────┐
│  PLAN panel                                                     │
│                                                                 │
│  [ORIGIN        ] [DESTINATION  ] [START DATE] [END DATE]       │
│  [TRANSPORT     ] [CABIN        ] [PARTY SIZE] [INTERESTS]      │
│                                                                 │
│              [ START PLANNING → ]                               │
└────────────────────┬────────────────────────────────────────────┘
                     │ fires Scoped Call A
                     ▼
┌─────────────────────────────────────────────────────────────────┐
│  FLIGHTS panel                                                  │
│                                                                 │
│  [ OUTBOUND ] [ RETURN ]  ← tabs appear for round trips          │
│  ┌──────────────────────────┐  Outbound options from LLM        │
│  │ ✈ CX 543  07:30→12:00   │  (sorted by price / duration)     │
│  │   HK$1,240 · 4h 30m     │                                   │
│  └──────────────────────────┘                                   │
│                                                                 │
│  One-way: [ PICK & FIND HOTELS → ]                              │
│  Round-trip outbound: [ PICK OUTBOUND → ] → auto-switch tab     │
│  Round-trip return:   [ PICK RETURN & FIND HOTELS → ]           │
└────────────────────┬────────────────────────────────────────────┘
                     │ fires Scoped Call B (after BOTH legs picked for round trips)
                     ▼
┌─────────────────────────────────────────────────────────────────┐
│  HOTELS panel                                                   │
│                                                                 │
│  ┌──────────────────────────┐  Hotel options from LLM           │
│  │ Park Hyatt Tokyo ★4.8   │  (map on right, photos)           │
│  │ ¥42,000/night           │                                   │
│  └──────────────────────────┘                                   │
│                                                                 │
│              [ PICK & PLAN DAYS → ]                             │
└────────────────────┬────────────────────────────────────────────┘
                     │ fires Scoped Call C
                     ▼
┌─────────────────────────────────────────────────────────────────┐
│  DAYS panel                                                     │
│                                                                 │
│  Day 1 · 2026-06-01                                             │
│  ├── 09:00 Senso-ji Temple     [REPLACE] [REMOVE] [★]          │
│  ├── 12:00 Tsukiji Market      [REPLACE] [REMOVE] [★]          │
│  └── 19:00 Park Hyatt (hotel)  [REPLACE] [REMOVE] [★]          │
│                                                                 │
│  Day 2 · 2026-06-02 ...                                         │
└─────────────────────────────────────────────────────────────────┘
```

Each arrow is a **single, scoped, non-conversational LLM call**. The call
receives exactly the inputs it needs, runs a fixed set of tools, and returns
a fixed output shape. It does not ask questions. It does not navigate panels.
It does not reuse earlier conversation context.

---

## The Three Scoped Calls

### Call A — Flight Search (`handlePlan`)

**Trigger:** User clicks `START PLANNING →` in the PLAN panel.

**Input payload (built by `buildPrompt()` in `PanelHome.jsx`):**
```
Plan a 3-day trip from Hong Kong to Tokyo.
START DATE: 2026-06-01. END DATE: 2026-06-03.
Transport: plane. Party: 2 people. Interests: food, temples.
Flight cabin: economy. Use search_flights with seat_class="economy".
```

**LLM role:** Flight & route finder.

| Tool | Required? |
|------|-----------|
| `search_flights` | **MUST** call |
| `geocode_city` | **MUST** call (for map centering) |
| `get_day_windows` | MAY call (trip length calculation) |
| `get_phrasebook` | MAY call (language tips) |
| `search_places` | **MUST NOT** call |
| `get_weather` | **MUST NOT** call |
| `navigate_menu` | **MUST NOT** call |
| `request_input` | Only if START DATE or END DATE is `[not set]` — then STOP |

**Expected output shape:**
```json
{
  "itinerary": {
    "origin": "Hong Kong",
    "destination": "Tokyo",
    "flight": {
      "options": [...],
      "from_lat": 22.32, "from_lng": 114.17,
      "to_lat": 35.68, "to_lng": 139.69
    },
    "days": [{"date": "2026-06-01"}, {"date": "2026-06-02"}, {"date": "2026-06-03"}],
    "party_size": 2
  }
}
```

**Post-call UI:** Frontend navigates to FLIGHTS automatically when
`partial_itinerary` SSE carries `flight.options`.

**Round-trip:** For round trips, `search_flights` is called twice in one batch — outbound and return (swapped origin↔destination). The return call includes `return_date=<outbound_date>` so the Google Flights deep link generates a round-trip URL. Results land in `flight.options` (outbound) and `flight.return_options` (return). The FLIGHTS panel shows an OUTBOUND / RETURN tab strip when `return_options` is non-empty.

---

### Call B — Hotel Search (`onPick` on FLIGHTS panel)

**Trigger (one-way):** User clicks `PICK & FIND HOTELS →` on the outbound flight.

**Trigger (round-trip):** User first picks the outbound flight (tab auto-advances to RETURN), then clicks `PICK RETURN & FIND HOTELS →`. Both picks must be made before Call B fires.

**Input payload (built in `App.jsx` `onPick` handler):**
```
Selected outbound flight: CX 543, 07:30→12:00, HK$1,240.
Selected return flight: JL 72, 18:00→21:30, HK$1,480. (round-trip only)
Destination: Tokyo (35.68N, 139.69E). Dates: 2026-06-01 to 2026-06-03.
Party: 2. Interests: food, temples. Budget: moderate.
Find hotels near the city centre.
```

**LLM role:** Hotel finder.

| Tool | Required? |
|------|-----------|
| `search_places` (hotels query) | **MUST** call |
| `get_place_details` | SHOULD call for top 3–5 results |
| `get_weather` | MAY call (forecast strip) |
| `search_flights` | **MUST NOT** call |
| `get_directions` | **MUST NOT** call |
| `navigate_menu` | **MUST NOT** call |
| `request_input` | **MUST NOT** call |

**Expected output shape:**
```json
{
  "itinerary": {
    "hotels": [
      {
        "name": "Park Hyatt Tokyo",
        "lat": 35.69, "lng": 139.69,
        "rating": 4.8,
        "price_level": "PRICE_LEVEL_VERY_EXPENSIVE",
        "address": "...",
        "photo_url": "...",
        "place_id": "..."
      }
    ],
    "weather": { "forecast": [...] }
  }
}
```

**Post-call UI:** Frontend navigates to HOTELS when `partial_itinerary` SSE
carries `hotels`.

---

### Call C — Day Planning (`onPick` on HOTELS panel)

**Trigger:** User clicks `PICK & PLAN DAYS →` on a selected hotel.

**Input payload:**
```
Base hotel: Park Hyatt Tokyo (Shinjuku, 35.69N, 139.69E).
Trip: Hong Kong → Tokyo, 2026-06-01 to 2026-06-03, 2 people.
Interests: food, temples. Local transport: transit.
Plan the full day-by-day itinerary with activities, meals, and walking
directions between each stop. Every activity must come from a real
search_places call.
```

**LLM role:** Day planner & activity sequencer.

| Tool | Required? |
|------|-----------|
| `search_places` (activities) | **MUST** call per day/category |
| `get_place_details` | **MUST** call per chosen activity |
| `get_directions` | **MUST** call between consecutive activities |
| `get_weather` | MAY call per day |
| `search_flights` | **MUST NOT** call |
| `search_places` (hotels query) | **MUST NOT** call |
| `navigate_menu` | **MUST NOT** call |
| `request_input` | **MUST NOT** call |

**Expected output shape:** Full itinerary with `days[].activities[]` populated;
each activity has `lat`, `lng`, `address`, `photo_url`, `directions_from_prev`.

**Post-call UI:** Frontend navigates to DAYS when `done` SSE arrives with
`itinerary.days[].activities`.

---

## Chat — The UI Agent

The chat popover (T key / Enter) runs under a **separate LLM role** from the
three planning calls. Its purpose is to interpret what the user wants to
change and translate that into UI actions — not to do planning itself.

**Design principle: chat has full button parity.** Everything a user can do by
clicking a button, the chat agent can do on their behalf. This means the chat
LLM has access to `pick_flight`, `pick_hotel`, and `replace_activity` — the same
actions as the PICK buttons — in addition to the form and navigation tools.

**What it does:**
1. Fill in form fields via `request_input` or `submit_trip_form`
2. Navigate to a panel via `navigate_menu`
3. Trigger Call A by calling `submit_trip_form`
4. Select a flight via `pick_flight(label?, index?)` — same effect as PICK button
5. Select a hotel via `pick_hotel(name?, index?)` — same effect as PICK button
6. Replace a day activity via `replace_activity(day, activity_name, query?)` — triggers Call C

**What it does NOT do:**
- Call `search_flights`, `search_places`, `get_directions`, `get_weather`, or
  `get_place_details` directly. Planning is always delegated back to the button
  pipeline.

**Examples:**

> *"find me flights to Kyoto next weekend"* → `submit_trip_form(destination="Kyoto", ...)` → triggers Call A

> *"pick the cheapest flight"* → `pick_flight(index=0)` → selects first option, triggers Call B

> *"book the Park Hyatt"* → `pick_hotel(name="Park Hyatt")` → selects hotel, triggers Call C

> *"replace the temple visit on day 2 with a food market"* → `replace_activity(day=2, activity_name="...", query="food market")` → triggers Call C

**Chained call sequencing:**
`pick_flight`, `pick_hotel`, and `replace_activity` fire SSE events mid-stream.
The frontend queues the chained planning call (`pick_flight` → Call B,
`pick_hotel` / `replace_activity` → Call C) in a `pendingChainedSendRef` and
flushes it 50ms **after** the chat stream's `done` event. This prevents
concurrent-request races where the planning call would start while the chat
stream is still live.

**`submit_trip_form` fills only — user must confirm:**
As of the Task 1 UX change, `submit_trip_form` pre-fills the PLAN form and navigates to the PLAN panel, but does **not** auto-start planning. The `onFormPrefilled` callback in `App.jsx` no longer calls `handleSend`; instead the user reviews the pre-filled values and clicks START PLANNING themselves. This prevents the agent from silently firing expensive LLM calls without the user's explicit intent.

**System prompt for chat role:**
```
You are a UI control agent for a travel planning app. Your job is to
interpret what the user wants to change and update the interface —
not to do the research yourself.

Available UI actions:
  request_input(field, prompt)                  — highlight and focus a form field
  submit_trip_form(fields...)                   — pre-fill the form and start planning
  navigate_menu(panel)                          — switch to PLAN/FLIGHTS/HOTELS/DAYS
  toggle_setting(key, value)                    — change a user preference
  pick_flight(label?, index?)                   — select a flight option
  pick_hotel(name?, index?)                     — select a hotel
  replace_activity(day, activity_name, query?)  — replace a day activity

You MUST NOT call search_flights, search_places, get_directions,
get_weather, or get_place_details. Leave all data fetching to the
planning pipeline triggered by submit_trip_form or the pick/replace actions.
```

---

## Agent Status Bar — Tool Timing Display

The status bar shows which tools the agent called and how long each took.
It has two states: **collapsed** (chips strip at the bottom of the status
bar) and **expanded** (full waterfall on the status bar, visible when the
agent is working or just finished).

### Deduplication rule

A tool that is called multiple times in the same agent turn (e.g.
`search_places` called 3 times for restaurants, temples, and hotels) MUST be
shown as **one entry**, not one entry per invocation. Both views apply the
same dedup:

- **Key:** tool name
- **Value shown:** the last (most recent) `elapsed_ms` for that tool
- **Order:** descending by elapsed_ms, so the slowest tool appears first

This prevents visual noise like "Looking up places 230ms / Looking up places
180ms / Looking up places 210ms" collapsing into the 4-chip strip.

### Pending vs. complete

A tool that has fired `tool_start` but not yet `tool_end` shows `…` instead
of a time. At most one tool is ever in this state (the currently executing
one), because the backend runs tools sequentially within a single turn.

### Reset

`toolTimings` is reset to `[]` at the start of every `handleSend` call,
including chained calls (`pick_flight → Call B`, `pick_hotel → Call C`).
Each agent turn therefore shows only its own tool timings — prior turns'
tools are not shown alongside the current turn's.

### Example (correct collapsed view after Call C with 3 × search_places)

```
search_places 2.1s   get_place_details 1.4s   get_directions 0.8s   get_weather 0.3s
```

Not:
```
search_places 2.1s   search_places 1.8s   search_places 2.0s   get_place_details 1.4s
```

---

## State Model

State accumulates in a single `currentItinerary` object that is **merged**
(not replaced) with each call's output:

```
Initial:        {}

After Call A:   { origin, destination, flight.options, days[], party_size,
                  flight.from_lat/lng, flight.to_lat/lng }

User picks:     += { selected_flight }

After Call B:   += { hotels[], weather }

User picks:     += { selected_hotel }

After Call C:   += { days[].activities[], directions }
```

Each scoped call receives only the fields relevant to its task in the input
prompt — it does **not** receive the full `currentItinerary` as JSON. This
prevents the LLM from being confused by prior turns' tool results. The
structured text prompt is the interface between turns.

---

## Panel Navigation Contract

Navigation fires **once, after the agent turn completes** (`done` event).
The `partial_itinerary` SSE event updates panel *data* progressively but
never changes the *active panel* while the agent is working. This keeps the
UI stable and prevents showing a partially-loaded page during loading.

| Condition | Navigation |
|-----------|-----------|
| `done` — `flight.options` present, no day activities | → FLIGHTS |
| `done` — `hotels[]` present | → HOTELS |
| `done` — at least one `days[].activities[]` present | → DAYS |
| Chat calls `navigate_menu(panel)` | → that panel (buffered in `pendingNavigateRef`, flushed at `done`) |
| Any call returns an error | Stay on current panel, show error |

**Why not `partial_itinerary`?** Call A returns `days[]` date-stubs even
before activities are planned. Navigating on `partial_itinerary` would jump
the user to a partially-populated panel mid-stream. Checking
`days?.some(d => d.activities?.length > 0)` at `done` distinguishes real
day data (Turn 3) from empty stubs (Turn 1).

If a call returns no data (API failure, quota exhaustion), the frontend stays
on the current panel and shows an error banner. It never navigates to an
empty panel.

---

## What Currently Works vs. What Needs to Change

### ✅ Already correct

- `START PLANNING` fires `handleSend(buildPrompt(form))` — Call A shaped correctly
- `PICK outbound flight` fires `handleSend("Selected flight... Now find hotels.")` — Call B triggered
- `PICK & PLAN DAYS` fires `handleSend("Set hotel X as base. Plan day-by-day...")` — Call C triggered
- `partial_itinerary` SSE fires immediately on `search_flights` / `search_places` completion (data only — no panel change)
- Frontend navigates at `done` event: FLIGHTS if `flight.options` present, HOTELS if `hotels[]`, DAYS if any `days[].activities[]`
- Chat has `navigate_menu`, `request_input`, `submit_trip_form` tools wired up

### ❌ Gaps to address

| # | Gap | Fix |
|---|-----|-----|
| 1 | Single monolithic system prompt covers all roles | Split into 4 role-specific prompts: `PLAN`, `HOTELS`, `DAYS`, `CHAT` |
| 2 | No tool allow-list per call — Call A can accidentally call `search_places` | Add `allowed_tools: list[str] \| None` param to `_run_loop`; filter `TOOL_DEFINITIONS` |
| 3 | All calls share conversation history — Call B sees Call A's tool results | Each scoped call sends an empty history; only the structured prompt goes in |
| 4 | Chat LLM has access to planning tools | Restrict chat's `allowed_tools` to UI-control tools only |
| 5 | Return flight pick fires no LLM call | Update the Call B prompt to include return flight info when present |
| 6 | No guard if required state is missing | `onPick` handlers check destination lat/lng exists before firing Call B |

---

## Files Affected

| File | Change |
|------|--------|
| `backend/app/prompts.py` | Split `SYSTEM_PROMPT` into `SYSTEM_PROMPT_PLAN`, `SYSTEM_PROMPT_HOTELS`, `SYSTEM_PROMPT_DAYS`, `SYSTEM_PROMPT_CHAT` |
| `backend/app/llm.py` | Add `allowed_tools` and `call_role` params to `_run_loop` / `chat_stream`; filter tool definitions; pass empty history for scoped calls |
| `backend/app/routers/chat.py` | Accept `call_role` in POST body; pass through to `chat_stream` |
| `frontend/src/api/client.js` | Add `callRole` field to `streamChat` request body |
| `frontend/src/App.jsx` | Pass `callRole` (`"plan"` / `"hotels"` / `"days"` / `"chat"`) from each `handleSend` invocation |

---

## Verification Checklist

After the split is implemented, run these checks:

1. **Call A tool isolation:** Fill form, click START PLANNING. Waterfall must
   show only `search_flights`, `geocode_city`, `get_day_windows`, `get_phrasebook`.
   `search_places` must be absent.

2. **Call B tool isolation:** Pick a flight. Waterfall must show only
   `search_places` (hotels), `get_place_details`, optionally `get_weather`.
   `search_flights` must be absent.

3. **Call C tool isolation:** Pick a hotel. Waterfall must show only
   `search_places` (activities), `get_place_details`, `get_directions`,
   optionally `get_weather`. `search_flights` must be absent.

4. **Chat UI-agent isolation:** Open chat (T), type "change destination to
   Kyoto". Chat must call `submit_trip_form`, which triggers Call A.
   Chat must NOT call `search_flights` directly.

5. **Empty-history isolation:** Inspect the messages sent to the LLM for
   Call B. The history array must be empty — only the system prompt and
   the single user message (the hotel-search prompt) are sent.

6. **Error stays on panel:** Disconnect the backend mid-Call B. Frontend
   must stay on FLIGHTS panel with an error banner — not navigate to HOTELS.

---

## Visa Alert Feature

### What it does

When a user advances to the FLIGHTS panel, a persistent visa status badge appears
inline in the panel header next to the route label (e.g. `✈ FLIGHT · HKG → NRT`).
The badge shows the traveller's visa requirement for the destination country based
on their passport.

### When it triggers

The badge is computed once when `menu.state.panel === "FLIGHTS"` and
`currentItinerary.flight.to_iata` is set. It re-fires if the destination airport
changes (new plan). It does NOT appear if the destination country matches the
passport country (same-country trips).

### Badge states

| Status | Color | Label |
|--------|-------|-------|
| `visa_free` | Green | `VISA FREE · 90D` |
| `visa_on_arrival` | Amber | `VISA ON ARRIVAL · 30D` |
| `visa_required` | Red | `VISA REQUIRED` |
| `unknown` | Grey | `VISA ?` |

Hover over the badge to see extended notes (e.g. "eTA required; apply at immi.homeaffairs.gov.au").

### Data source

Static JSON files in `backend/app/data/`:
- `visa_hk.json` — real HKSAR passport data for ~150 countries, keyed by ISO 3166-1 alpha-2 code
- `visa_mock.json` — placeholder response (`status: "unknown"`) for all other passports

Loaded once at process start; no network request per check. To add a new passport,
create `visa_{iso2_lower}.json` and add a branch in `backend/app/routers/visa.py`.

### API

```
GET /visa/check?destination=JP&passport=HK
→ { destination: "JP", passport: "HK", status: "visa_free", free_days: 90 }
```

### How nationality propagates

1. User sets PASSPORT in `SettingsOverlay` → stored in `localStorage["travel-prefs"].passport_country`
2. `preferencesForApi()` includes `passport_country` in the preferences dict
3. `App.jsx` reads `preferences.passport_country` (defaults to `"HK"`) in the visa check effect
4. The IATA code `flight.to_iata` is converted to ISO-2 via `IATA_TO_ISO2` map in `frontend/src/data/countries.js`
5. `GET /visa/check` is called; result stored in `visaAlert` state → passed to `PanelFlights` → rendered by `VisaAlertBanner`

### Files

| File | Role |
|------|------|
| `backend/app/data/visa_hk.json` | HK passport visa data |
| `backend/app/data/visa_mock.json` | Placeholder for other passports |
| `backend/app/routers/visa.py` | `/visa/check` endpoint |
| `frontend/src/data/countries.js` | `COUNTRIES` list, `IATA_TO_ISO2`, `COUNTRY_NAME_TO_ISO2` |
| `frontend/src/components/VisaAlertBanner.jsx` | Pill badge component |
| `frontend/src/components/panels/PanelFlights.jsx` | Renders the badge |
| `frontend/src/App.jsx` | `visaAlert` state + fetch effect |
| `frontend/src/components/SettingsOverlay.jsx` | PASSPORT field in prefs |

---

## Export Tab (Round: Export)

A dedicated 5th panel for exporting the trip as a PDF document or Google Maps KML file.

### Panel

`5 EXPORT` appears in the TabStrip after `4 DAYS`. It is disabled (greyed out, `cursor: not-allowed`) until `currentItinerary.days.length > 0`. Pressing `5` on the keyboard navigates to it (same number-key convention as other panels). The former `P`-key → PrintView shortcut now navigates to this tab instead.

### PDF Export

**Flow:** User clicks "Download PDF" → frontend calls `POST /export/pdf` → backend renders a Jinja2 HTML template with weasyprint → returns a binary PDF blob → browser triggers file download as `itinerary-{destination}.pdf`.

**PDF sections (in order):**
1. Trip header (title, route, dates, local transport)
2. Visa requirements (status, free days, notes — sourced from `visaAlert` state)
3. Flight details (outbound + return; selected or top 3 options if none picked)
4. Hotel (selected or first option)
5. Day-by-day itinerary (date, theme, weather, activities with times/addresses/descriptions/transport)
6. Pre-trip checklist (items from `TripChecklist` localStorage state, with ☑/☐ markers)
7. Phrasebook (language + phrase table, if present in itinerary)

**Backend endpoint:** `POST /export/pdf`  
Request: `{ itinerary: object, visa_data: object|null, checklist_items: [{key, label, critical, checked}] }`  
Response: `application/pdf` blob with `Content-Disposition: attachment`

**Library:** weasyprint 68+ (HTML→PDF). Requires system libs: pango, cairo (available via Homebrew on macOS).

**Template files:**
- `backend/app/templates/itinerary.html` — Jinja2 HTML
- `backend/app/templates/itinerary.css` — Clean B&W print CSS (inlined by the router)

### Google Maps KML Export

**Flow:** User clicks "Download KML" → client-side `generateKml(itinerary)` builds KML 2.2 XML string → browser downloads as `itinerary-{destination}.kml`. No backend call.

**KML structure:**
- Folder: Airports (origin + destination pins, labeled with IATA + city)
- Folder: Hotel (1 pin)
- Folder per day: "Day N — Theme" (activity pins with lat/lng, only those with coordinates)

**Import into Google My Maps:** `mymaps.google.com → Create map → Import → select .kml`

### Checklist data source

Checklist items are read from `localStorage["travel-checklist"]` keyed by destination string. `PanelExport` reads this directly via `JSON.parse` to avoid prop-drilling through `TripChecklist`.

### Files

| File | Role |
|------|------|
| `backend/app/routers/export.py` | `POST /export/pdf` endpoint |
| `backend/app/templates/itinerary.html` | Jinja2 PDF template |
| `backend/app/templates/itinerary.css` | Print CSS (inlined) |
| `frontend/src/components/panels/PanelExport.jsx` | 5th panel UI (two export cards) |
| `frontend/src/utils/exportKml.js` | Client-side KML generator + download trigger |
| `frontend/src/api/client.js` | `exportPdf()` function |
| `frontend/src/hooks/useMenuState.js` | `"EXPORT"` added to PANELS array |
| `frontend/src/components/TabStrip.jsx` | `exportEnabled` prop + disabled tab styling |
| `frontend/src/components/MenuShell.jsx` | `exportEnabled` prop forwarded to TabStrip |
