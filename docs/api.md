# API Reference

The backend exposes a REST + SSE API at `http://localhost:8000`. All
endpoints accept and return JSON unless noted. CORS is wide open in
development (`allow_origins=["*"]`).

Router prefixes (see `backend/app/main.py`):

| Prefix | Module |
|---|---|
| `/chat` | `routers/chat.py` |
| `/itinerary` | `routers/itinerary.py` |
| `/photo` | `routers/photo.py` |
| `/geo` | `routers/geo.py` |
| `/speech` | `routers/speech.py` |
| `/status` (no prefix, path is `/status`) | `routers/status.py` |
| `/api/directions` | `routers/directions.py` |
| `/visa` | `routers/visa.py` |
| `/airports` | `routers/airports.py` |
| `/export` | `routers/export.py` |

Top-level (defined directly on `app` in `main.py`):

- `GET /health` → `{"status": "ok"}` (liveness probe)

---

## `POST /chat`

Runs the LLM tool-call loop and returns the final reply plus any
structured itinerary the model produced. One-shot — blocks until the
loop terminates. For progressive output use `/chat/stream` (below).

### Request

```json
{
  "message": "Plan a 3-day trip to Tokyo from Hong Kong.",
  "history": [
    {"role": "user", "content": "..."},
    {"role": "assistant", "content": "..."}
  ],
  "preferences": {
    "interests": ["food", "temples"],
    "dislikes": ["crowds"],
    "dietary": "vegetarian",
    "budget": "$$",
    "travel_style": "relaxed"
  },
  "call_role": "plan",
  "user_location": {"city": "Hong Kong", "country": "HK", "lat": 22.3, "lng": 114.2},
  "trip_dates": {"start": "2026-05-15", "end": "2026-05-17"},
  "local_form": {"destination": "NRT", "origin": "HKG", "party_size": 2}
}
```

`history`, `preferences`, `user_location`, `trip_dates`, and
`local_form` are optional. `call_role` selects one of the scoped
system prompts (`plan` / `hotels` / `days` / `chat` / `day_themes` /
`day_detail`); omit for the full `SYSTEM_PROMPT`.

### Response

```json
{
  "reply": "I have 3 flight options for you... ```json\n{...}\n```",
  "itinerary": { "destination": "Tokyo", "flight": { "options": [...] }, "days": [...] },
  "tool_calls_made": ["search_flights", "geocode_city", "get_day_windows"]
}
```

`itinerary` is `null` if the model did not emit a fenced ```json
block.

### Errors

| Status | Meaning |
|---|---|
| `503` | `XAI_API_KEY` missing (no Gemini fallback available either) |
| `500` | LLM call failed — see backend logs |

---

## `POST /chat/stream`

Server-Sent Events version of `/chat`. Same request body. The stream
emits four event types as the tool-call loop runs:

| Event | Payload | When |
|---|---|---|
| `tool_start` | `{name, args}` | About to dispatch a tool |
| `tool_end` | `{name, ok, error?}` | Tool returned / raised |
| `partial_itinerary` | `{itinerary}` | Model emitted an interim JSON block (e.g. flight options before the full itinerary lands) |
| `done` | same shape as `POST /chat` response | Loop exhausted or final text produced |

Clients consume this for the live "AGENT WORKING" subtitle ticker
and to render flight options ~7 s before the full response (see
`docs/perf/streaming-benchmark.md`).

---

## `POST /itinerary`

Save an itinerary in-memory and return a short ID. The store is
process-local — a restart clears it.

**Request:** `{"itinerary": {...}}`  **Response:** `{"id": "a1b2c3d4"}`

## `GET /itinerary/{id}`

Retrieve a previously-saved itinerary, or `404` if the ID is unknown.

## `POST /itinerary/optimize`

Reorder activities for shortest total travel distance using
haversine + nearest-neighbor + 2-opt (see `backend/app/optimize.py`).
Each activity must have `lat` and `lng`.

**Request**

```json
{
  "activities": [
    {"name": "Central", "lat": 22.28, "lng": 114.16, "extra": {"time": "09:00"}},
    {"name": "Shek O",  "lat": 22.23, "lng": 114.25, "extra": {"time": "12:00"}}
  ]
}
```

**Response**

```json
{
  "ordered": [...],
  "distance_km_before": 32.4,
  "distance_km_after": 19.8,
  "savings_pct": 38.9
}
```

Returns `400` if fewer than 2 activities are supplied.

---

## `GET /photo/{photo_name:path}`

Streams a Google Places photo through the backend so the API key
never reaches the browser. `photo_name` is a Places resource path
like `places/ChIJ.../photos/Ae...`.

Query: `max_width` (int, default `800`, Google supports up to 4800).

Response: `200` with `Content-Type: image/jpeg` and
`Cache-Control: public, max-age=86400`, or `503` / `502` / forwarded
Google status on failure.

---

## `GET /geo/reverse`

Reverse-geocode a `lat,lng` pair into `{city, country, country_code}`
via Google Geocoding API. Query: `lat=...&lng=...`. Used by the
browser geolocation flow so the LLM can prefill an origin city.

---

## `POST /api/directions`

Thin proxy around the `get_directions` tool for one-off frontend
requests outside the LLM loop (e.g. re-routing a day after a manual
reorder). Body: `{origin, destination, mode}`. Returns
`{duration, distance, polyline, steps}`.

---

## `POST /speech/tts`

Generate speech audio from text using Google Cloud TTS Neural2.
Response is `audio/mpeg` bytes if TTS is configured, `503` if no
service-account credentials, or `204` if the text is empty after
sanitisation. The frontend falls back to the browser
`SpeechSynthesis` API on `503` / `204`.

---

## `GET /status`

Service-status dashboard endpoint. Returns the health of every
upstream provider we depend on:

```json
{
  "llm_primary":   {"ok": true,  "model": "grok-4.20-0309-non-reasoning"},
  "llm_fallback":  {"ok": true,  "model": "gemini-3.1-pro-preview"},
  "google_maps":   {"ok": true,  "places": true, "routes": true, "weather": true},
  "flights":       {"ok": true,  "provider": "fast-flights"},
  "tts":           {"ok": false, "reason": "GOOGLE_TTS_CREDENTIALS not set"}
}
```

Rendered by the `ServiceStatusOverlay` (press `C` in the UI).

---

## `GET /visa/check`

Look up visa / entry-policy requirements from the static dataset in
`backend/app/data/visa_hk.json` (curated for HK SAR passport
holders; extendable via `visa_mock.json`). Query:
`destination=<iso-3-or-country-name>`. Returns
`{required, visa_on_arrival, eta, duration_days, notes}` or `null`
if the destination is not in the dataset.

---

## `GET /airports/search`

Search the bundled airport database (`backend/app/data/airports.json`)
by name, city, country, or IATA code. Query:
`query=Tokyo&limit=5`. Returns up to `limit` matching airports with
IATA code + city + country; used by the `AirportCombobox` UI and
the LLM `search_airports` tool.

---

## `POST /export/pdf`

Render a printable PDF of the current itinerary using weasyprint
against the Jinja2 template in `backend/app/templates/itinerary.html`.
Body: `{itinerary, visa?}`. Response: `application/pdf` bytes with a
`Content-Disposition: attachment; filename=itinerary-<dest>.pdf`
header.

See `frontend/src/utils/exportKml.js` for the companion KML exporter
(runs entirely in the browser — no backend round-trip needed).
