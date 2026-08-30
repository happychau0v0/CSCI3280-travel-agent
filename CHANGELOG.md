# Changelog

All notable changes to the AI Travel Agent project, grouped by development
round. Rounds map roughly to one iteration cycle: design → implement → test →
Playwright walkthrough → commit.

---

## Round 21 (2026-04-17) — Model benchmarking & LLM-judge evals

- Added automated LLM-judge harness (`backend/app/evals/`) with a registry of
  40+ rubric criteria spanning grounding, tool-call correctness, narration
  quality, replace-activity fidelity, and output schema shape
- Added `bench_models.py` / `bench_chat.py` scoring pipeline: runs multiple
  prompt types against configurable models, scores with `score_itinerary()`,
  outputs a markdown report
- Established `BENCH_EVAL_ADDENDUM` mode: a single-shot prompt that produces a
  complete itinerary (flights + hotels + days) for automated scoring without
  human interaction
- Added `ROLE_MAX_ROUNDS` per-role round cap (initially 2, widened to 3) to
  prevent infinite tool-call loops in scoped planners
- Switched eval judge from xAI to Gemini after discovering xAI self-rates its
  own output leniently

## Round 20 (2026-04-15) — Visa support & passport-index dataset

- Expanded `/visa/check` from HK-only to 199 passports using the imorte
  passport-index-data dataset (MIT licence, updated Feb 2026)
- HK passport continues to use manually-verified `visa_hk.json` (richer notes,
  hand-corrected entries for RU, KR, AU, AZ, IL)
- Added `backend/app/data/passport-index.json`
- Added stop-city extraction from Google Flights embedded JavaScript: regex
  pipeline mines `[DUR,"IATA","IATA",[flags],"airport","city"]` blocks from the
  page's JS, keyed by `(airline_code, dep_hhmm)` to annotate each multi-stop
  flight with real layover city names

## Round 19 (2026-04-14) — LLM spec, role scoping, performance

- Wrote `docs/llm-spec.md`: 65+ numbered requirements (R-G-*, R-PLAN-*,
  R-HOTELS-*, R-DAYS-*, R-CHAT-*, R-REPLACE-*, R-THEMES-*, R-DETAIL-*)
- Refactored `llm.py` to enforce per-role tool allow-lists (`ROLE_ALLOWED_TOOLS`)
  — PLAN role can only call flight/geo tools; HOTELS/DAYS roles have separate
  allow-lists
- Added `bench_models.py` initial version: benchmarked grok-4.20 non-reasoning
  vs reasoning vs Gemini; selected `grok-4.20-0309-non-reasoning` based on
  TTFT, score, and cost
- Added context pruning: tool results > 8 000 tokens are truncated before being
  appended to the message history

## Round 18 (2026-04-13) — Chat agent (UI tool calls)

- Added `ChatPopover` component: T / ⌘K shortcut, voice input via VoiceRecorder,
  message history recall (↑), choice buttons for `request_input` options
- Added CHAT role (`SYSTEM_PROMPT_CHAT`) with separate tool allow-list:
  `pick_flight`, `pick_hotel`, `replace_activity`, `submit_trip_form`,
  `navigate_menu`, `request_input`, `toggle_setting`
- `pick_flight` / `pick_hotel` highlight a suggestion row — user must click PICK
  to confirm (no auto-pick; preserves user authority — R-G-016)
- `replace_activity` shows a preview card; user clicks CONFIRM to apply
- `submit_trip_form` fills the form only — user clicks START PLANNING (not
  auto-triggered)

## Round 17 (2026-04-12) — Export panel (PDF + KML)

- Added `PanelExport` with PDF download (via `weasyprint` + Jinja2 template) and
  KML download (built client-side from `exportKml.js`)
- PDF includes: cover (destination, dates, party), flight summary, hotel card,
  day-by-day schedule with activity descriptions and directions
- KML includes placemarks for all activities + hotel, coloured by day
- Progress UX: three-phase loading animation (generating → rendering → ready)

## Round 16 (2026-04-11) — Currency, settings persistence, and undo/redo

- Added currency selector (HKD / USD / EUR / JPY / GBP / CNY) to SettingsOverlay
- All prices displayed via `formatDisplayPrice(hkd, currency)` — conversion is
  client-side with hardcoded rates; backend always returns HKD
- Added undo/redo for flight and hotel picks (`Ctrl+Z` / `Ctrl+Y`), backed by
  ref stacks of `{selected_flight, selected_hotel}` snapshots (max 20)
- Settings now persist to localStorage on every change and are restored on load

## Round 15 (2026-04-10) — Two-phase day planning

- Replaced single-shot day planner with two-phase pipeline:
  1. **Theme pass** (`SYSTEM_PROMPT_DAY_THEMES`): assigns one thematic focus per
     day using only the hotel and flight as context — one round, no tools
  2. **Detail pass** (`SYSTEM_PROMPT_DAY_DETAIL`): per-day parallel queries
     (CONCURRENCY=7) with `search_places` + `get_directions` + `get_weather`
- Added `planDaysActivities()` in App.jsx: sliding-window parallel executor
  with per-day status (`dayStatuses`), elapsed timers, and retry button on error
- Day 1 first activity is always the arrival airport; last-day last activity is
  always the departure airport — enforced by prompt examples

## Round 14 (2026-04-09) — Globe, undo, and NieR-style UI polish

- Added `GlobeView` (react-globe.gl) as background to HOME/FLIGHTS panels with
  flight arc animation — arc drawn from origin to destination IATA coordinates
- Added Q long-press (2 s) new-trip reset with globe "deep-space zoom-in" reveal
  animation (`explodeTrigger`)
- Added `TabStrip` with agent spinner (pulsing dot during `agentState="working"`)
  and elapsed-time display per tool call (`toolTimings`)
- Added `SubtitleQueue` (TTS word-by-word display with prefetch lookahead)

## Round 13 (2026-04-08) — Overlays and hotkey system

- Added six overlays: History (H), Settings (S), Help (?), Checklist (L),
  Favorites (F), Service Status (C)
- `useKeyboard.js` scope model: disabled during overlay open; suppressed during
  input focus; per-panel ↑/↓ list navigation; Tab toggles left/right focus column
- `FavoritesOverlay`: star any activity from DAYS panel; grouped by destination;
  persisted to `travel-favorites` in localStorage
- `TripChecklist`: 12-item pre-trip checklist keyed by destination; critical vs
  nice-to-have split; persisted to `travel-checklist`

## Round 12 (2026-04-07) — Hotels panel + Leaflet map

- Added `PanelHotels` with price/rating filter chips and `HotelsMap` (Leaflet)
  showing hotel pins + airport reference pin
- Auto-replan toggle: if enabled, picking a hotel immediately triggers day
  planning without a separate user action
- `PhotoGallery` shows hero image + thumbnail strip from Google Places photo
  references (proxied through `/photo`)
- Added `VisaAlertBanner` on FLIGHTS: checks `/visa/check` for the destination
  and passport country from settings; shows status badge inline

## Round 11 (2026-04-06) — Flight panel and estimator improvements

- Added outbound/return tab strip in `PanelFlights` (auto-advances to RETURN tab
  after outbound is picked)
- Padded flight option list from 6 to 8 by including departure time in the
  dedupe key — previously two same-airline same-price different-time flights
  collapsed into one
- Estimator now always returns ≥ 3 options for short-haul routes (was 1)
- Added `flight_number` display (extracted from fast-flights `f.name` via
  `_split_airline_and_code`) and `next_day_arrival` indicator (`+1` superscript)

## Round 10 (2026-04-05) — Plan history and localStorage persistence

- Added `PlanHistoryPanel` on HOME right column: shows last 20 saved trips,
  click to restore; drag a `.json` plan onto it to import from another device
- Plan history serialised to `travel-history` in localStorage after every
  completed planning session
- Added current itinerary auto-save to `travel-itinerary` — survives page reload

## Round 9 (2026-04-04) — Day-window and phrasebook tools

- Added `get_day_windows(arrival_time, departure_time, num_days)` — returns per-
  day activity windows anchored to flight times (avoids planning activities
  after departure)
- Added `get_phrasebook(destination)` — pure in-memory lookup of 10 essential
  phrases for 8 languages; result embedded in itinerary as `phrasebook` field
- DAYS panel now renders the phrasebook as a phrase table at the bottom of the
  day list

## Round 8 (2026-04-03) — Routing and weather

- Added client-side route fetch on activity selection (`ac18646`): `DayMiniMap`
  fetches `/directions` on demand, caches by `(from, to, mode)`, draws polyline
- Added `get_weather` tool (Google Weather API) — forecast embedded per activity
  if available
- Transit directions expand into step-by-step detail (line name, platform) when
  transport mode is TRANSIT

## Round 7 (2026-04-02) — SSE streaming pipeline

- Rewrote backend LLM loop to emit Server-Sent Events:
  `token`, `thinking`, `tool_start`, `tool_end`, `navigate`, `partial_itinerary`, `done`, `error`
- Frontend processes events via `EventSource` with `ReadableStream` fallback
- `partial_itinerary` events allow FLIGHTS panel to render flight options ~7 s
  before the full response completes (see `docs/perf/streaming-benchmark.md`)
- Added `navigate_menu` tool: LLM signals the frontend to switch panels at the
  end of each planning phase

## Round 6 (2026-04-01) — Role-scoped system prompts

- Split monolithic system prompt into three scoped prompts:
  `SYSTEM_PROMPT_PLAN`, `SYSTEM_PROMPT_HOTELS`, `SYSTEM_PROMPT_DAYS`
- Each role has its own tool allow-list; attempting a forbidden tool raises a
  validation error rather than silently succeeding
- Added `callRole()` in App.jsx: sends a fresh context (no prior tool results)
  to each scoped prompt, preventing cross-stage leakage

## Round 5 (2026-03-30) — NieR menu shell + panel grid

- Replaced flat chat layout with NieR: Automata-inspired tabbed shell:
  five numbered panels, keyboard navigation (1–5, Tab, ↑/↓)
- Three-column `panel-grid` CSS grid: left list, center globe/map, right detail
- `MenuShell` and `FooterHints` provide the outer chrome and context-aware hints
- Hotkeys: 1–5 (panels), Esc (close overlay), Space (activate)

## Round 4 (2026-03-28) — Google Maps Platform integration

- Wired `search_places` → Google Places New API (POST `/v1/places:searchText`)
- Wired `get_directions` → Google Routes API
- Added `/photo` proxy endpoint to serve Google Places photo references without
  exposing the API key to the browser
- Added `get_weather` tool using Google Weather API

## Round 3 (2026-03-26) — Tool-call loop + fast-flights

- Implemented LLM orchestrator (`llm.py`) with multi-round tool-call loop:
  parse JSON tool call → dispatch → append result → re-query
- Added `search_flights` tool backed by `fast-flights` library (Google Flights
  scraper) with deterministic haversine estimator fallback
- Added `geocode_city` and `airports` tools (IATA database + Google Geocoding)
- Parallel tool execution via `asyncio.gather` within each LLM round

## Round 2 (2026-03-24) — Frontend scaffold + voice UI

- React 19 + Vite 8 scaffold
- `VoiceRecorder` (Web Speech API push-to-talk)
- TTS via `SpeechSynthesis` with xAI "ara" neural voice fallback
- Basic `ChatWindow` rendering assistant markdown with `**bold**` support

## Round 1 (2026-03-22) — Project scaffolding

- FastAPI backend skeleton with `/chat`, `/health` endpoints
- Python venv + `requirements.txt`, `uvicorn` dev server
- Contributor conventions, `scripts/dev.sh` + `scripts/smoke-test.sh`
- `.env.example` with all required API key slots
