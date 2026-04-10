# API Reference

The backend exposes a small REST API at `http://localhost:8000`. All
endpoints accept and return JSON unless noted. CORS is wide open in
development (`allow_origins=["*"]`).

---

## `GET /health`

Sanity check.

```bash
curl http://localhost:8000/health
```

```json
{"status": "ok"}
```

---

## `POST /chat`

The main entry point. Runs the LLM with a tool-call loop and returns
the assistant's reply plus any structured itinerary it produced.

### Request

```json
{
  "message": "Plan a 2-day trip to Hong Kong with history and food.",
  "history": [
    {"role": "user", "content": "Hi, can you help me plan a trip?"},
    {"role": "assistant", "content": "Of course! Where would you like to go?"}
  ],
  "preferences": {
    "interests": ["history", "ramen"],
    "dislikes": ["crowds"],
    "dietary": "vegetarian",
    "budget": "$$",
    "travel_style": "relaxed"
  }
}
```

`history` and `preferences` are optional. The frontend sends `history`
on every request because the backend is stateless. `preferences` come
from the `ProfilePanel` localStorage — if non-empty, they're injected
into the system prompt as a USER PROFILE block.

### Response

```json
{
  "reply": "Here's your 2-day Hong Kong itinerary...\n\n```json\n{...}\n```\n\nA warm summary for TTS.",
  "itinerary": {
    "title": "2 Days in Hong Kong",
    "destination": "Hong Kong",
    "days": [
      {
        "day": 1,
        "date": "2026-04-15",
        "theme": "Historic Hong Kong",
        "weather": {"condition": "Partly cloudy", "temp_c": 22, "icon": "partly-cloudy"},
        "activities": [
          {
            "time": "10:00",
            "name": "Man Mo Temple",
            "address": "124-130 Hollywood Rd, Sheung Wan",
            "duration_min": 60,
            "description": "Atmospheric historic temple...",
            "place_id": "ChIJ...",
            "photo_url": "/photo/places/ChIJ.../photos/Ae...",
            "lat": 22.2841,
            "lng": 114.1503,
            "transport_to_next": {
              "mode": "WALK",
              "duration": "8 min",
              "distance": "0.6 km",
              "polyline": "encoded_polyline_string"
            }
          }
        ]
      }
    ]
  },
  "tool_calls_made": ["get_weather", "search_places", "get_directions"]
}
```

`itinerary` is null if the model didn't produce a structured itinerary
(e.g. for a quick info question like "what's the weather in Tokyo?").

### Errors

| Status | Meaning |
|---|---|
| `503` | `OPENROUTER_API_KEY` missing — add it to `.env` and restart |
| `500` | LLM call failed — see backend logs for the underlying exception |

```bash
curl -s -X POST http://localhost:8000/chat \
  -H "Content-Type: application/json" \
  -d '{"message": "What should I do in Hong Kong tomorrow?"}'
```

---

## `POST /itinerary`

Save a structured itinerary in memory and return its short ID. The
store is in-memory only — restarting the server clears it.

### Request

```json
{
  "itinerary": {
    "title": "Test Trip",
    "destination": "Test City",
    "days": []
  }
}
```

### Response

```json
{"id": "a1b2c3d4"}
```

---

## `GET /itinerary/{id}`

Retrieve a previously-saved itinerary.

```bash
curl http://localhost:8000/itinerary/a1b2c3d4
```

Returns the full itinerary object that was saved, or 404 if the ID
doesn't exist.

---

## `POST /itinerary/optimize`

Reorder a list of activities for shortest total travel distance using
nearest-neighbor + 2-opt (see `backend/app/optimize.py`). Each activity
must have `lat` and `lng`.

### Request

```json
{
  "activities": [
    {"name": "Central", "lat": 22.2819, "lng": 114.1577, "extra": {"time": "09:00"}},
    {"name": "Shek O", "lat": 22.2298, "lng": 114.2519, "extra": {"time": "12:00"}},
    {"name": "Wan Chai", "lat": 22.2783, "lng": 114.1747, "extra": {"time": "14:00"}}
  ]
}
```

The `extra` dict is a free-form passthrough — anything you put in it
comes back in the response unchanged. Use it to attach `time`,
`address`, `photo_url`, `description`, etc. so you don't have to look
up activities by name after the call.

### Response

```json
{
  "ordered": [
    {"name": "Central", "lat": 22.2819, "lng": 114.1577, "time": "09:00"},
    {"name": "Wan Chai", "lat": 22.2783, "lng": 114.1747, "time": "14:00"},
    {"name": "Shek O", "lat": 22.2298, "lng": 114.2519, "time": "12:00"}
  ],
  "distance_km_before": 32.4,
  "distance_km_after": 19.8,
  "savings_pct": 38.9
}
```

### Errors

| Status | Meaning |
|---|---|
| `400` | Fewer than 2 activities supplied |

---

## `GET /photo/{photo_name:path}`

Streams a Google Places photo through the backend so the API key never
reaches the browser. `photo_name` is a Places API resource path like
`places/ChIJ.../photos/Ae...` (it can contain slashes — the `:path`
converter accepts them).

```bash
curl -o ramen.jpg \
  "http://localhost:8000/photo/places/ChIJabc/photos/AeXyz?max_width=800"
```

### Query parameters

| Name | Type | Default | Description |
|---|---|---|---|
| `max_width` | int | `800` | Max width in pixels (Google supports up to 4800) |

### Response

`200 OK` with `Content-Type: image/jpeg` (or whatever Google returns)
and a `Cache-Control: public, max-age=86400` header. The image bytes
are streamed.

### Errors

| Status | Meaning |
|---|---|
| `503` | `GOOGLE_MAPS_API_KEY` missing |
| `502` | Upstream Google fetch failed |
| `4xx` | Whatever code Google returned upstream (forwarded as-is) |
