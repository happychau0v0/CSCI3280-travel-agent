# Architecture

This document describes the AI Travel Agent's system architecture, the
data flow for a typical request, and the key design decisions behind it.

## High-level diagram

```
┌──────────────────────────────────────────────────────────────────────┐
│                              FRONTEND                                │
│                       (React 19 + Vite 8, port 5173)                 │
│                                                                      │
│   VoiceRecorder ──────┐                              ┌── AudioPlayer │
│   (Web Speech STT)    │                              │  (Speech-     │
│                       ▼                              │   Synthesis)  │
│                  ChatWindow ◄──────────── messages ──┤               │
│                       │                              │               │
│                       │ postChat(text, history,      │               │
│                       │          preferences)        │               │
│                       │                              │               │
│                       │   ┌──────────────┐           │               │
│                       │   │ ProfilePanel │ prefs ───►│               │
│                       │   │ (localStorage)│          │               │
│                       │   └──────────────┘           │               │
│                       │                              │               │
│                       ▼                              ▼               │
│                                                                      │
│                    Sidebar: MapView (Leaflet) + ItineraryCard        │
│                                       ▲                              │
│                                       │ photos via /photo proxy      │
└───────────────────────────────────────┼──────────────────────────────┘
                                        │
                          POST /chat    │   GET /photo/{name}
                                        │   POST /itinerary/optimize
                                        ▼
┌──────────────────────────────────────────────────────────────────────┐
│                              BACKEND                                 │
│                         (FastAPI, port 8000)                         │
│                                                                      │
│   /chat ──► llm.chat() ──► tool-call loop ──┐                        │
│                                              │                       │
│   /photo ──► photo proxy ──► Google Places   │                       │
│                                              ▼                       │
│                                       TOOL_DISPATCH                  │
│                                              │                       │
│         ┌────────────────┬───────────────────┼────────────┐          │
│         ▼                ▼                   ▼            ▼          │
│   places.py        directions.py        weather.py     search.py     │
│   (Places API)     (Routes API)         (Weather API)  (stub)        │
│                                                                      │
│   /itinerary/optimize ──► optimize.py (haversine + NN + 2-opt)       │
└──────────────────────────────────────────────────────────────────────┘
                                        │
                                        ▼
┌──────────────────────────────────────────────────────────────────────┐
│                          EXTERNAL APIs                               │
│                                                                      │
│   OpenRouter ◄── LLM (google/gemini-3.1-flash-lite-preview)          │
│                                                                      │
│   Google Maps Platform (one API key for all):                        │
│     • Places API (New)        — search & details                     │
│     • Routes API              — directions + polyline                │
│     • Weather API             — current + 5-day forecast             │
│     • Geocoding API           — city → lat/lng                       │
└──────────────────────────────────────────────────────────────────────┘
```

This matches the TA brief's "Brain → Hands → Interface" model:

- **The Interface (input)** — Web Speech API in `VoiceRecorder.jsx`
  transcribes the user's voice, or they type into `ChatWindow.jsx`.
- **The Brain** — `backend/app/llm.py` runs the OpenAI SDK against
  OpenRouter, with a tool-call loop that executes tools and feeds the
  results back to the model.
- **The Hands** — the four tool wrappers in `backend/app/tools/` that
  call Google Maps Platform.
- **The Interface (output)** — `AudioPlayer.jsx` reads the natural-
  language summary aloud via SpeechSynthesis; `ItineraryCard.jsx` and
  `MapView.jsx` render the structured JSON itinerary.

## Data flow for a typical request

1. **User speaks or types** "Plan a 2-day trip to Hong Kong with history
   and food, partly cloudy weather preferred."
2. `VoiceRecorder` transcribes (if speech) or `ChatWindow` captures the
   text. Both call `App.handleSend(text)`.
3. `App.handleSend` calls `postChat(text, history, preferences)` with
   the conversation history and any preferences from `ProfilePanel`.
4. **Backend `/chat` endpoint** (`routers/chat.py`) accepts the request,
   builds the message list, calls `llm.chat(messages, preferences=...)`.
5. `llm.chat` prepends the system prompt (with the USER PROFILE block
   from preferences) and enters the tool-call loop:
   - Send all messages + tool definitions to OpenRouter.
   - If the model returns tool calls, execute them via `TOOL_DISPATCH`,
     append the results as `role=tool` messages, loop again.
   - If the model returns plain text, exit the loop.
6. **Tools fire in sequence:**
   - `get_weather("Hong Kong")` — geocodes the city via Google Geocoding
     API, then fetches current + 5-day forecast from Google Weather API.
   - `search_places("history museums Hong Kong")` — text search via
     Google Places API (New) with a field mask covering name, address,
     rating, photos, location.
   - `get_directions(origin, destination)` — Google Routes API returns
     duration, distance, and an encoded polyline.
7. **Model produces a final reply** containing a fenced ```json
   itinerary block followed by a TTS-friendly summary paragraph.
8. `llm._extract_itinerary` walks the reply with a brace-balancing
   parser (with backslash-escape sanitization for polylines) and pulls
   out the structured itinerary.
9. **Response goes back to the frontend** as
   `{reply, itinerary, tool_calls_made}`.
10. `App.handleSend` updates `messages` and `currentItinerary`. The
    sidebar appears with `MapView` (Leaflet pins + decoded polylines)
    and `ItineraryCard` (photos via `/photo` proxy, weather indicator,
    activity timeline).
11. `AudioPlayer` reads the summary aloud via SpeechSynthesis.
12. State persists to localStorage for the next page load.

## Key design decisions

### LLM via OpenRouter (OpenAI SDK compatible)

Single API key, swap models with one env var. We use
`google/gemini-3.1-flash-lite-preview` for development and can switch to
`gpt-4o` or `gemini-2.5-pro` for the demo without code changes. The
OpenAI SDK works as-is — only `base_url` is overridden.

### Google Maps Platform consolidation

One API key serves Places (New), Routes, Weather, and Geocoding. This
eliminates the need for separate billing/auth flows for each service.
The TA brief's example architecture shows OpenWeatherMap; we replaced
it with Google Weather API to keep all location data behind one key.

### Backend photo proxy

Google Places photo URLs embed the API key as a query parameter. If we
sent those URLs to the frontend, every `<img>` tag would expose the key
in the page source. The `/photo/{photo_name:path}` endpoint
(`backend/app/routers/photo.py`) fetches the photo with the server-side
key and streams it back, so the browser only ever sees relative paths.

### Leaflet over Google Maps JS

Same key-exposure concern. Leaflet uses free OpenStreetMap tiles, no
auth needed, and the React-Leaflet wrapper integrates cleanly. We
decode the Google encoded polylines from `get_directions` with a
~30-line inline decoder so we don't need a separate npm dependency.

### Browser STT/TTS over Whisper

The TA brief's example architecture diagram shows Whisper STT and
Google/OpenAI TTS. We use the browser Web Speech API and
SpeechSynthesis instead because:

- **Zero cost** — no API calls per minute of audio.
- **Zero latency** — STT runs in the browser, no network round trip.
- **Zero key exposure** — no extra credential to ship.
- **Functionally equivalent** — both satisfy the MVP requirements
  ("voice input recognition" and "text-to-speech output").

The trade-off is browser support: Chrome, Edge, and Safari work; older
Firefox does not. For the demo this is fine.

### localStorage over backend session storage

The chat is stateless on the server side — every request includes the
full conversation history. This simplifies the backend (no session
table, no auth, no expiry logic) and lets the frontend fully control
persistence. A future multi-device version would need a real session
store.

### Brace-balancing JSON extractor

The first naïve extractor was a regex `\{.*?\}` (non-greedy), which
captured the smallest possible brace span — typically just the
innermost `{}` instead of the full nested itinerary. The second
attempt was a greedy `\{.*\}`, which extended past the closing brace
into trailing text. Neither works for nested JSON.

The current implementation (`_balanced_json_object` in `llm.py`) walks
the string character by character, tracks brace depth, and respects
string literals so braces inside string values don't throw off the
count. We also pre-process invalid backslash escapes (`_sanitize_json`)
because Google encoded polylines contain `\` characters that the LLM
copies verbatim into JSON string values, breaking strict parsing.

This bug was caught only by running the actual app in a browser via
Playwright — unit tests with mocked LLM responses missed it because
the test fixtures didn't contain real polylines. Lesson: browser-level
verification > "the build compiles."

## File structure

```
backend/
  app/
    main.py              FastAPI app + CORS + router registration
    config.py            env loading (OPENROUTER_API_KEY, GOOGLE_MAPS_API_KEY)
    llm.py               tool-call loop + JSON extractor
    prompts.py           system prompt + Pydantic itinerary models
    optimize.py          haversine + nearest-neighbor + 2-opt for /optimize
    routers/
      chat.py            POST /chat
      itinerary.py       POST /itinerary, GET /itinerary/{id}, POST /optimize
      photo.py           GET /photo/{name:path} — proxies Google Places photos
      speech.py          (placeholder for optional Whisper/TTS upgrade)
    tools/
      __init__.py        TOOL_DEFINITIONS + TOOL_DISPATCH
      errors.py          ToolUnavailableError
      places.py          Google Places API (New) — search + details
      directions.py      Google Routes API
      weather.py         Google Weather API + Geocoding
      search.py          stub (no SerpAPI key configured)
  tests/
    test_smoke.py        /health
    test_tools.py        mocked httpx for each tool
    test_chat.py         mocked llm.chat + itinerary endpoints + optimize

frontend/
  src/
    App.jsx              main shell, state, persistence
    api/client.js        postChat, optimizeRoute, photoSrc, etc.
    components/
      ChatWindow.jsx     message list + input form + markdown rendering
      VoiceRecorder.jsx  Web Speech API STT
      AudioPlayer.jsx    SpeechSynthesis TTS
      ItineraryCard.jsx  day cards + photos + weather + optimize button
      MapView.jsx        Leaflet pins + polyline decoder
      ProfilePanel.jsx   collapsible preferences drawer
      ErrorBanner.jsx    top banner for 503/500/network errors
```
