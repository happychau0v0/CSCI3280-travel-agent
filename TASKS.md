# TASKS.md — Ordered Backlog

## MVP (60% — Basic Functionality) ✅ Complete

All three modules (ASR, LLM, TTS) work together end-to-end. Verified by 25 backend tests + 30 Playwright browser checks.

### Backend Core

- [x] Fix `config.py` to use `OPENROUTER_API_KEY` + `LLM_MODEL` instead of `OPENAI_API_KEY`
- [x] Implement LLM orchestrator in `llm.py` — OpenAI SDK chat completions with tool-call loop via OpenRouter
- [x] Write system prompt in `prompts.py` — travel agent persona, tool usage rules, structured itinerary output schema
- [x] Implement `POST /chat` endpoint in `routers/chat.py` — accepts message, returns agent response + itinerary JSON

### Tool Wrappers (The Hands)

- [x] `tools/places.py` — `search_places(query, location?, radius_km?)` and `get_place_details(place_id)` via Google Places API (New)
- [x] `tools/directions.py` — `get_directions(origin, destination, mode)` via Google Routes API
- [x] `tools/weather.py` — `get_weather(city, date?)` via Google Weather API (geocode → weather lookup)
- [x] `tools/search.py` — `web_search(query)` stub (SerpAPI/Tavily intentionally deferred)
- [x] Register all tools as OpenAI function definitions for the LLM tool-call loop

### Frontend Chat UI

- [x] Replace Vite scaffold in `App.jsx` with chat-based layout
- [x] Implement `ChatWindow.jsx` — message list, input box, send button, loading dots
- [x] Wire `api/client.js` to `POST /chat` and render responses

### Voice (Modality)

- [x] `VoiceRecorder.jsx` — Web Speech API for speech-to-text input
- [x] `AudioPlayer.jsx` — Browser SpeechSynthesis API for TTS output
- [x] Both voice and text feed into the same `/chat` pipeline

### Itinerary Rendering

- [x] Define itinerary JSON schema (day-by-day, time slots, places, transport, weather, photos)
- [x] `ItineraryCard.jsx` — render structured itinerary from JSON response
- [x] `GET /itinerary/:id` endpoint for retrieving saved itineraries

### Integration & Testing

- [x] End-to-end smoke test: text input → tool calls → structured response → rendered UI (`/tmp/verify-frontend.mjs`)
- [x] `test_tools.py` — unit tests for each tool wrapper (mocked httpx)
- [x] `test_chat.py` — integration tests for chat endpoint with mocked LLM

---

## A+ Features (20% — Extended Functionality) ✅ All 4 done

### Visual Output — Attraction Photos
- [x] Backend `/photo/{name}` proxy so the API key never reaches the browser
- [x] Fetch and display Google Places photos in itinerary cards

### Weather-Aware Planning
- [x] Integrate weather forecast into itinerary generation via `get_weather` tool
- [x] System prompt instructs LLM to swap outdoor activities to indoor on rainy days
- [x] Weather indicators (icon + temp) on itinerary day cards

### User Preference Memory
- [x] `ProfilePanel.jsx` collapsible drawer with interests, dislikes, dietary, budget, travel style
- [x] localStorage persistence
- [x] Backend injects preferences into system prompt as USER PROFILE block

### Route Optimization
- [x] `optimize.py` — haversine + nearest-neighbor + 2-opt heuristic
- [x] `POST /itinerary/optimize` endpoint
- [x] One-click "Optimize" button per day with savings badge
- [x] MapView re-renders with the new order automatically

---

## Polish ✅ Complete

- [x] `MapView.jsx` — Leaflet with numbered pins + decoded polylines (no API key needed, OSM tiles)
- [x] Loading states (bouncing dots), empty state, friendly error banner
- [x] Persistent chat history + clear button
- [x] Keyboard shortcuts: Cmd/Ctrl+K focus input, Esc stops TTS
- [x] Markdown bold rendering in assistant messages
- [x] Robust JSON extractor with brace balancing + escape sanitizing
- [x] Inline code comments for the report's grading criteria
- [x] Browser-verified demo screenshots in `docs/screenshots/`

---

## What's Left for the Team (deferred to humans)

These items the team must drive — they need authentication, design judgment, or team contributions:

- [ ] **Demo deployment via Cloudflare Tunnel** — needs `cloudflared login` (interactive)
- [ ] **4-page academic report** — system architecture, integration, challenges, target domain, code explanations, team contributions per the TA brief
- [ ] **8-minute presentation slides** — last week of term, with live demo of the running agent
- [ ] **Team table in README.md** — add member names + roles

Optional engineering items if there's appetite:
- [ ] Image upload for landmark identification (Visual INPUT, the OR alternative to photo display we already do)
- [ ] Multi-language voice (1-line change to `recognition.lang`)
- [ ] Server-side Whisper STT / OpenAI TTS upgrade (current browser APIs work fine, this is a fallback option for the demo)
