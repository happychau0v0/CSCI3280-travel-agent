# CLAUDE.md — AI Travel Agent (CSCI3280)

## Project Overview

Multimodal AI travel planning agent for CSCI3280 final project. Users speak or type travel requests; the agent fetches real data via tool calls and returns structured itineraries with voice output.

## Tech Stack

| Layer | Technology |
|-------|-----------|
| LLM | OpenRouter API (OpenAI SDK compatible) — `google/gemini-3.1-flash-lite-preview` default, swap via `LLM_MODEL` env var |
| STT | Browser Web Speech API (MVP) → OpenAI Whisper (upgrade) |
| TTS | Browser SpeechSynthesis API (MVP) → OpenAI TTS (upgrade) |
| Location & Weather | Google Maps Platform — Places (New), Routes, Weather, Geocoding, Time Zone (one API key) |
| Backend | Python FastAPI (async) |
| Frontend | React 19 + Vite 8 |

## Dev Commands

```bash
# Start both backend + frontend
./scripts/dev.sh

# Backend only
cd backend && source .venv/bin/activate && uvicorn app.main:app --reload --port 8000

# Frontend only
cd frontend && npm run dev

# Tests
cd backend && pytest

# Lint
cd backend && ruff check .
cd frontend && npm run lint

# Smoke test
./scripts/smoke-test.sh
```

## Architecture

```
User ──► Web Speech API (STT) ──► POST /chat ──► LLM (OpenRouter)
                                                    │
                                              Tool calls:
                                              ├── search_places (Google Places New)
                                              ├── get_place_details (Google Places New)
                                              ├── get_directions (Google Routes API)
                                              ├── get_weather (Google Weather API)
                                              └── web_search (stub for now)
                                                    │
                                              Structured JSON itinerary
                                                    │
User ◄── SpeechSynthesis (TTS) ◄── Response ◄──────┘
```

## Key Conventions

- **No hallucination:** Every place name, address, rating, and hour MUST come from a tool call
- **Tool-first:** Call `search_places` before recommending any place; call `get_directions` before suggesting transport
- **Structured output:** Itineraries are JSON that the frontend renders as cards; also provide a natural language summary for TTS
- **Clarify ambiguity:** Ask users about trip duration, budget, interests when the request is vague
- **OpenRouter, not OpenAI direct:** Use `OPENROUTER_API_KEY` with OpenAI SDK's `base_url` override

## Claude Code Plugins

These plugins are enabled and should be used during development:

- **context7** — Fetch up-to-date docs for any library (FastAPI, OpenAI SDK, React, Google Maps, etc.). Use instead of guessing API syntax.
- **playwright** — Browser automation for end-to-end testing of the frontend (chat flow, voice UI, itinerary rendering).
- **frontend-design** — Design guidance when building UI components. Use when creating or redesigning chat UI, itinerary cards, and map views.

## Environment Setup

1. Copy `.env.example` to `.env` and fill in API keys
2. Backend: `cd backend && python -m venv .venv && source .venv/bin/activate && pip install -r requirements.txt`
3. Frontend: `cd frontend && npm install`
4. Run: `./scripts/dev.sh`

## Project Structure

- `backend/app/main.py` — FastAPI entrypoint
- `backend/app/config.py` — env loading
- `backend/app/llm.py` — LLM orchestrator + tool-call loop
- `backend/app/prompts.py` — system prompt + output schemas
- `backend/app/routers/` — chat, speech, itinerary endpoints
- `backend/app/tools/` — API wrappers (places, directions, weather, search)
- `frontend/src/App.jsx` — main app component
- `frontend/src/components/` — ChatWindow, VoiceRecorder, AudioPlayer, ItineraryCard, MapView
- `frontend/src/api/client.js` — backend API client

## Mandatory Playwright Walkthrough (Before Declaring Any Round Complete)

Every implementation round MUST end with a real-browser walkthrough using the Playwright MCP plugin BEFORE the final commit. This is NOT optional — mocked tests verify code correctness, but only a real browser session catches the bugs users actually hit.

### The Walkthrough Checklist

1. **Navigate to `http://localhost:5173`** using `browser_navigate`
2. **Screenshot the PLAN panel** at both 1440×900 AND 1024×600 viewports
   - Verify: all 8 form rows visible, START PLANNING button not clipped below fold
   - Verify: PLAN HISTORY card renders in right column
   - Verify: NEXT TRIP summary shows destination after a plan exists
3. **Fill the form and click START PLANNING** — wait for agent idle
   - Verify: status bar shows "AGENT WORKING" during loading
   - Verify: panel auto-navigates to FLIGHTS after done (not HOTELS)
4. **Screenshot FLIGHTS panel**
   - Verify: ≥3 flight options listed with visible departure→arrival times
   - Verify: prices show in the user's selected currency
   - Verify: PICK button is clickable, text not truncated
5. **Click PICK → auto-advance to HOTELS**
   - Verify: Leaflet map renders with hotel pins + airport pin
   - Verify: hotel names NOT truncated in the left column
   - Verify: filter chips (PRICE / RATING) are functional
   - Verify: photo gallery loads on the right detail card
6. **Click a hotel PICK → advance to DAYS**
   - Verify: DayMiniMap renders with numbered pins + polylines
   - Verify: Day 1 first activity is the arrival airport
   - Verify: each activity row has REPLACE/REMOVE/★ buttons
   - Verify: forecast strip renders if weather data exists
7. **Test overlays**: press `?` (help), `P` (print), `L` (checklist), `S` (settings), `H` (history), `F` (favorites)
   - Verify: each opens and Esc closes it
8. **Check console** via `browser_evaluate` for uncaught errors
9. **Test at small viewport** (1024×600) — nothing should overflow or become inaccessible

### What This Catches That Mocked Tests Don't

- CSS overflow / clipping at real viewport sizes
- Text truncation in flex containers
- Leaflet map rendering failures (tile loading, pin placement)
- Globe zoom animation timing issues
- LLM output format mismatches (example-driven truncation)
- Real fast-flights data edge cases (partial results, missing fields)
- Geolocation failures in headless browsers
- Cross-component state leaks between panels

### When to Run

- After EVERY implementation round, before the final test commit
- After ANY change to: App.css grid layout, PanelHome form fields, prompts.py OUTPUT FORMAT example, flights.py option pipeline, DayMiniMap/HotelsMap
- Before declaring a PR ship-ready

## Commit Discipline

- **Commit in focused chunks** — one concern per commit, never bundle unrelated changes
- **Conventional prefixes:** `feat:`, `fix:`, `chore:`, `docs:`, `test:`, `refactor:`
- **Working state always:** every commit should leave the project startable and tests passing
- **Don't batch:** if you've made changes touching backend tools, the LLM, and the frontend, that's three commits, not one
- **Commit messages explain why,** not just what — the diff already shows what
