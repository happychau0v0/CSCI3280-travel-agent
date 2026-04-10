# TASKS.md — Ordered Backlog

## MVP (60% — Basic Functionality)

All three modules (ASR, LLM, TTS) must work together end-to-end.

### Backend Core

- [ ] Fix `config.py` to use `OPENROUTER_API_KEY` + `LLM_MODEL` instead of `OPENAI_API_KEY`
- [ ] Implement LLM orchestrator in `llm.py` — OpenAI SDK chat completions with tool-call loop via OpenRouter
- [ ] Write system prompt in `prompts.py` — travel agent persona, tool usage rules, structured itinerary output schema
- [ ] Implement `POST /chat` endpoint in `routers/chat.py` — accepts message, returns agent response + itinerary JSON

### Tool Wrappers (The Hands)

- [ ] `tools/places.py` — `search_places(query, location?, radius_km?)` and `get_place_details(place_id)` via Google Places API
- [ ] `tools/directions.py` — `get_directions(origin, destination, mode)` via Google Maps Directions API
- [ ] `tools/weather.py` — `get_weather(city, date?)` via Google Weather API (geocode → weather lookup)
- [ ] `tools/search.py` — `web_search(query)` fallback via SerpAPI or Tavily
- [ ] Register all tools as OpenAI function definitions for the LLM tool-call loop

### Frontend Chat UI

- [ ] Replace Vite scaffold in `App.jsx` with chat-based layout
- [ ] Implement `ChatWindow.jsx` — message list, input box, send button
- [ ] Wire `api/client.js` to `POST /chat` and render responses

### Voice (Modality)

- [ ] `VoiceRecorder.jsx` — Web Speech API for speech-to-text input
- [ ] `AudioPlayer.jsx` — Browser SpeechSynthesis API for TTS output
- [ ] Both voice and text feed into the same `/chat` pipeline

### Itinerary Rendering

- [ ] Define itinerary JSON schema (day-by-day, time slots, places, transport)
- [ ] `ItineraryCard.jsx` — render structured itinerary from JSON response
- [ ] `GET /itinerary/:id` endpoint for retrieving saved itineraries

### Integration & Testing

- [ ] End-to-end smoke test: text input → tool calls → structured response → rendered UI
- [ ] `test_tools.py` — unit tests for each tool wrapper
- [ ] `test_chat.py` — integration test for chat endpoint with mocked tools

---

## A+ Features (20% — Extended Functionality)

Pick 2–3 and implement well.

### Weather-Aware Planning
- [ ] Integrate weather forecast into itinerary generation
- [ ] Swap outdoor activities to clear-weather days when rain is predicted
- [ ] Show weather indicators on itinerary cards

### Visual Output — Attraction Photos
- [ ] Fetch and display Google Places photos in itinerary cards and chat
- [ ] Photo carousel or hero images for recommended attractions

### Route Optimization
- [ ] TSP approximation to optimize visit order across attractions
- [ ] Display optimized route on map with time/distance savings

### User Preference Memory
- [ ] Store user preferences across sessions (interests, dislikes, budget)
- [ ] Use stored preferences to personalize itinerary generation

---

## Polish & Deliverables

- [ ] `MapView.jsx` — display directions polyline on embedded map
- [ ] Loading states, error handling, and empty states in UI
- [ ] Speech endpoints (`POST /stt`, `POST /tts`) if upgrading to server-side Whisper/TTS
- [ ] Demo prep — Cloudflare Tunnel for live presentation
- [ ] 4-page report (architecture, integration, challenges, contributions)
- [ ] 8-minute presentation slides
