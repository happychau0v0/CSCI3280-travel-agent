# CSCI3280 Final Project — AI Travel Agent

---

## 1. Project Vision

Build a multimodal AI travel planning agent that goes beyond a simple ChatGPT text wrapper. It should be an active, intelligent agent that users can talk to directly (voice), and that speaks back naturally (TTS), while actively searching, routing, and creating actionable plans.

The contrast:
- **Traditional planning:** Scattered tabs, overwhelming information, stressful manual scheduling across multiple apps.
- **Your AI agent:** A unified, clean voice interface that generates structured, personalized itineraries instantly.

---

## 2. MVP Requirements (The Pass Line — 60% of Grade)

These are mandatory. All three must work together.

### Requirement 1: Modality (Speech & Text)

| Feature | Detail |
|---------|--------|
| Voice input recognition | User speaks → system transcribes to text |
| Text-to-speech output | Agent response → spoken audio back to user |
| UI for text fallback | Standard chat interface for typing when voice isn't convenient |

Both input modes (voice and text) must feed into the same pipeline and produce the same quality of output.

### Requirement 2: Live Search (No Hallucination)

| Feature | Detail |
|---------|--------|
| No pure LLM hallucination | Every place name, address, opening hour must come from a real API |
| Live location data integration | Connect to search APIs for real-time place data |
| Dynamic API fetching | Tools are called on-demand based on user queries |

The agent must use tool/function calling to fetch real data. It cannot make up places or details.

### Requirement 3: Core Functions (Full Trip Lifecycle)

| Function | Detail |
|----------|--------|
| **Plan** | Generate a destination itinerary (day-by-day, with time slots) |
| **Introduce** | Provide detailed information about specific attractions |
| **Route** | Plan transport between locations (mode, duration, cost) |

---

## 3. A+ Features (20% Extended Functionality)

Pick 2–3 of these and implement them well. You don't need all of them.

### Visual Input/Output
Enhance the experience by displaying relevant, high-quality photos of attractions. Or allow the user to upload an image of a landmark and plan the trip based on it.

### Advance Route Planning
Optimize the visit order across all attractions using shortest-distance algorithms (TSP approximation).

### Weather-Aware Planning
Implement dynamic routing that adapts the itinerary based on real-time and forecasted weather conditions. If rain is predicted, swap outdoor activities to another day.

### User Profiling (Memory)
Remember user preferences across sessions (e.g., "I hate crowded places", "I love historical museums"). Use stored preferences to personalize every itinerary.

### Other Useful Functions/Features
Any creative feature that adds genuine value: budget tracking, multi-language voice, restaurant booking, currency conversion, etc.

---

## 4. Architecture (from lecture)

```
                    ┌─────────────────────────┐
                    │   The Hands (Tool Call)  │
                    │  Search APIs, Weather,   │
                    │        Maps              │
                    └───────────┬─────────────┘
                                │
User ──► The Interface ──► The Brain ──► The Interface ──► User
         (Whisper STT)    (LLM: OpenAI   (Google/OpenAI     (Audio
          Voice Input      / Gemini)        TTS)             Output)
```

- **The Interface (Input):** Whisper STT — converts user speech to text
- **The Brain:** LLM (OpenAI / Gemini) — reasons about the request, calls tools, generates structured responses
- **The Hands:** Tool calling — Search APIs, Weather APIs, Maps APIs — fetches real data
- **The Interface (Output):** TTS — converts agent text response back to speech

---

## 5. Grading Breakdown

| Category | Weight | What's Evaluated |
|----------|--------|------------------|
| Basic Functionality | 60% | ASR, LLM, and TTS modules working together |
| Extended Functionality | 20% | Useful features, novel design, better UI, low latency |
| Presentation | 20% | Clear, fluent presentation with live demo (~8 min per group) |

---

## 6. Deliverables

### Report (max 4 pages, academic conference style)
- System architecture description
- How all modules are integrated
- Technical approach and challenges faced
- Introduction and adaptation to your target domain
- Code comments and explanations
- Specific contributions of each team member

### Presentation (~8 minutes)
- Clear, structured explanation of the system
- Live demonstration of the running travel planning agent
- Held during lectures in the last week of term

### Code Submission
- All source code of the project
- Well-organized, commented, and executable

---

## 7. Team
- Maximum 4 members per team
- Registration deadline was 28 Feb (already done)

---

## 8. Resources (from course)
- Upcoming Tutorial 1: Prompting for agents, structuring reliable JSON outputs from LLMs
- Upcoming Tutorial 2: Tool calling fundamentals, STT/TTS integration
- Starter code, API wrappers, and token quotas provided by the course

---

## 9. Our Tech Stack Decisions

| Component | Choice | Reason |
|-----------|--------|--------|
| LLM | OpenRouter API (`openai/gpt-4o-mini` for dev, `gpt-4o` for demo) | One key, many models, OpenAI SDK compatible, full tool calling |
| STT | Browser Web Speech API (MVP) → OpenAI Whisper (upgrade) | Free for MVP, quality upgrade later |
| TTS | Browser SpeechSynthesis API (MVP) → OpenAI TTS (upgrade) | Free for MVP, quality upgrade later |
| Places/Directions | Google Maps Platform API | 10K free requests/month, best data quality |
| Weather | OpenWeatherMap free tier (5-day forecast) | Free, no credit card needed |
| Backend | Python FastAPI | Async, easy OpenAI SDK integration |
| Frontend | React + Vite | Fast dev, component-based |
| Deployment | Local dev server (Cloudflare Tunnel later for demo) | Keep it simple for now |

---

## 10. Our Tool Definitions (for LLM function calling)

| Tool Name | Parameters | Returns | API |
|-----------|-----------|---------|-----|
| `search_places` | query, location?, radius_km? | Array of {name, address, rating, photo_url, place_id} | Google Places |
| `get_place_details` | place_id | {name, description, hours, reviews, photos, price_level} | Google Places |
| `get_directions` | origin, destination, mode | {duration, distance, steps[], polyline} | Google Maps |
| `get_weather` | city, date? | {temp, condition, humidity, forecast[]} | OpenWeatherMap |

---

## 11. Project Structure

```
travel-agent/
├── CLAUDE.md
├── TASKS.md
├── PROGRESS.md
├── README.md
├── .gitignore
├── .env.example
│
├── backend/
│   ├── requirements.txt
│   ├── pyproject.toml
│   ├── app/
│   │   ├── __init__.py
│   │   ├── main.py              # FastAPI entrypoint
│   │   ├── config.py            # Env loading
│   │   ├── llm.py               # LLM orchestrator + tool-call loop
│   │   ├── prompts.py           # System prompt + output schemas
│   │   ├── routers/
│   │   │   ├── chat.py          # POST /chat
│   │   │   ├── speech.py        # POST /stt, POST /tts
│   │   │   └── itinerary.py     # GET /itinerary/:id
│   │   └── tools/
│   │       ├── places.py        # Google Places wrapper
│   │       ├── directions.py    # Google Directions wrapper
│   │       ├── weather.py       # OpenWeatherMap wrapper
│   │       └── search.py        # Web search fallback
│   └── tests/
│       ├── test_smoke.py
│       ├── test_tools.py
│       └── test_chat.py
│
├── frontend/
│   ├── package.json
│   ├── vite.config.js
│   └── src/
│       ├── App.jsx
│       ├── components/
│       │   ├── ChatWindow.jsx
│       │   ├── VoiceRecorder.jsx
│       │   ├── ItineraryCard.jsx
│       │   └── MapView.jsx
│       └── api/
│           └── client.js
│
├── scripts/
│   ├── dev.sh
│   ├── smoke-test.sh
│   └── run-iteration.sh
│
└── docs/
    ├── architecture.md
    └── api.md
```

---

## 12. Environment Variables

```
OPENROUTER_API_KEY=sk-or-v1-...
LLM_MODEL=openai/gpt-4o-mini
GOOGLE_MAPS_API_KEY=AIzaSy-...
OPENWEATHERMAP_API_KEY=...
# OPENAI_API_KEY=sk-...          # Only if using Whisper/TTS directly
```

---

## 13. Suggested Work Division (4 Members)

| Role | Responsibilities |
|------|-----------------|
| **Frontend Lead** | Chat UI, voice recorder, itinerary cards, map view, responsive design |
| **Backend / LLM Lead** | FastAPI server, LLM orchestration, system prompt, tool-call dispatcher, session state |
| **Integration / API Lead** | All external API wrappers (Places, Directions, Weather, Search), error handling, caching |
| **Voice / UX Lead** | STT pipeline, TTS pipeline, audio streaming, user profiling/memory, demo prep |

Everyone rotates on report writing. Everyone must understand the full system for Q&A.

---

## 14. Key Rules for the Agent

1. Every place name, address, rating, and opening hour MUST come from a tool call — never hallucinated
2. Before recommending any place, call `search_places` first
3. Before suggesting transport, call `get_directions` first
4. Itinerary output must be structured JSON that the frontend can render as cards
5. Also provide a natural language summary for TTS playback
6. Ask clarifying questions when the request is vague (how many days? budget? interests?)
