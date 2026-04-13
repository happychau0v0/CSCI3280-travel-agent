# LLM Model Benchmark Report

**Date:** April 12, 2026
**Purpose:** Select the best LLM for the AI Travel Agent's tool-calling itinerary pipeline
**Course:** CSCI3280 Final Project

## Methodology

### Test Setup
- **Framework:** Custom benchmark script (`scripts/benchmark-models.py`)
- **Tool layer:** `MOCK_TOOLS=1` — all 11 tool functions return deterministic fixture data (no API keys needed). Every model receives identical tool responses, isolating LLM quality.
- **API gateway:** OpenRouter (OpenAI SDK compatible, single API key for all models)
- **Prompt:** Fixed trip request — "Plan a 3-day trip to Tokyo from Hong Kong, departing 2026-05-15, returning 2026-05-17. 2 travelers, economy class, interests: food, temples, nightlife. Use public transit."
- **System prompt:** The full production system prompt from `backend/app/prompts.py` (~300 lines) with 5-step tool-calling flow, OUTPUT FORMAT JSON example, and airport-anchored day-building rules.

### What the LLM Must Do
The LLM acts as an **orchestrator** — it does NOT generate travel data. Instead it:

1. **Calls tools** to fetch real data (flights, hotels, weather, places, directions)
2. **Assembles** the raw tool results into a structured JSON itinerary
3. **Schedules** activities chronologically within flight-aware day windows
4. **Follows** a strict output schema (Pydantic-validated `Itinerary` model)

The Google Maps APIs provide facts (real places, real routes, real weather). The LLM provides judgment (which places to search for, how to arrange them, what times to schedule).

### Scoring Criteria (0-100 points)

| Criterion | Max Points | What It Measures |
|-----------|-----------|-----------------|
| Valid Pydantic schema | 15 | Does the JSON parse without errors? |
| Flight options (≥5) | 15 | Did it copy all tool results verbatim? |
| Hotel count (≥5) | 15 | Same — no truncation of tool data |
| Day count (≥3) | 10 | Correct trip length |
| `selected_hotel` = null | 5 | Followed prompt instruction (user picks) |
| Activity density | 20 | Real activities per day (excludes hotel/airport bookends) |
| No time gaps >3h | 5 | Realistic scheduling without dead time |
| Phrasebook included | 5 | Called `get_phrasebook` tool |
| Directions included | 5 | Called `get_directions` for transit routing |
| Zero issues bonus | 5 | No warnings at all |

### How to Reproduce

```bash
# From project root:
cd backend && source .venv/bin/activate
export OPENROUTER_API_KEY=sk-or-v1-...

# Run with default models:
MOCK_TOOLS=1 python ../scripts/benchmark-models.py

# Run with custom models:
MOCK_TOOLS=1 python ../scripts/benchmark-models.py x-ai/grok-4.20 google/gemini-2.5-flash moonshotai/kimi-k2.5
```

## Results

### Summary Table

| Model | Score | Latency | Flights | Hotels | Activities (D1/D2/D3) | Phrasebook | Directions | Gaps |
|-------|------:|--------:|--------:|-------:|-----------------------|:----------:|:----------:|-----:|
| **x-ai/grok-4.20** | **100%** | **25.5s** | 5 | 5 | **5 / 8 / 3** | Yes | Yes | 0 |
| moonshotai/kimi-k2.5 | 100% | 463.1s | 5 | 5 | 4 / 7 / 2 | Yes | Yes | 0 |
| x-ai/grok-3-mini | 96% | 106.6s | 5 | 5 | 3 / 5 / 2 | Yes | Yes | 0 |
| google/gemini-2.5-flash | 83% | 21.7s | 5 | 5 | 4 / 5 / 2 | No | Yes | 1 |
| google/gemini-3.1-flash-lite | ~60%* | ~15s | 2-5 | 1-5 | 1 / 2 / 1 | No | Sometimes | 2-3 |
| google/gemini-3.1-pro-preview | 0% | 14.6s | — | — | — | — | — | — |
| anthropic/claude-sonnet-4 | 0% | 67.5s | — | — | — | — | — | — |
| z-ai/glm-5.1 | 0% | 1104.4s | — | — | — | — | — | — |

*gemini-3.1-flash-lite score estimated from prior rounds (not formally benchmarked with this script — quality varied per run).

### Why Three Models Scored 0%

- **Gemini 3.1 Pro Preview:** Made tool calls but did not emit the itinerary JSON in the expected `{"itinerary": {...}}` wrapper format. The `_extract_itinerary` parser could not find a valid JSON block.
- **Claude Sonnet 4:** Failed during the tool-calling loop — likely an incompatibility with OpenRouter's tool calling format for Anthropic models (works via the direct Anthropic API but not reliably through OpenRouter's proxy).
- **GLM 5.1:** Took 18 minutes and did not produce a parseable itinerary. Despite high SWE-bench scores, its tool-calling behavior did not conform to the OpenAI-compatible function calling protocol used by our pipeline.

These models may work with prompt/format adjustments, but out-of-the-box compatibility with our existing system prompt was the selection criterion.

### Detailed Analysis: Grok 4.20 (Winner)

**Day-by-day breakdown:**

| Day | Theme | Total Activities | Real Activities | Schedule |
|-----|-------|:----------------:|:---------------:|----------|
| 1 | Arrival & Exploration | 6 | 5 | Airport → Hotel → Temple → Market → Dinner → Hotel |
| 2 | Full Day Sightseeing | 8 | 8 | Tsukiji → Senso-ji → Lunch → teamLab → Shrine → Shopping → Dinner → Nightlife |
| 3 | Final Morning & Departure | 4 | 3 | Hotel → Market → Lunch → Airport |

**Strengths:**
- Highest activity density (8 real activities on day 2 — no dead time)
- Called `get_phrasebook` for Japanese phrases
- Called `get_directions` for every activity pair (transit routing)
- Correct `selected_hotel: null` (follows our "user picks" instruction)
- 5 flight options and 5 hotels copied verbatim from tool responses
- 25.5s total latency — acceptable for real-time UX with SSE streaming

**Compared to previous default (gemini-3.1-flash-lite):**
- 3-5x more activities per day
- No hallucinated data (all places from tool calls)
- Follows output format instructions faithfully (flash-lite copied example structure literally)
- Correct JSON types (flash-lite returned `selected_hotel` as a string)

## Decision

**Selected model:** `x-ai/grok-4.20`

**Rationale:**
1. Perfect quality score (100%) — only model to achieve this alongside Kimi K2.5
2. 18x faster than Kimi K2.5 (25s vs 463s) with identical quality
3. Reliable tool calling — 16 calls across 5 rounds, all successful
4. Correct schema compliance — proper JSON types, null where expected
5. Dense itineraries — 8 real activities on a full day vs 2 with the previous model

**Fallback:** `google/gemini-2.5-flash` for cost-sensitive deployments (83% quality, 22s, cheapest per token). Set via `LLM_MODEL=google/gemini-2.5-flash` in `.env`.

## Cost Comparison

| Model | Input (per 1M tokens) | Output (per 1M tokens) | Est. cost per trip |
|-------|----------------------:|----------------------:|-------------------:|
| x-ai/grok-4.20 | $2.00 | $8.00 | ~$0.08 |
| google/gemini-2.5-flash | $0.15 | $0.60 | ~$0.01 |
| moonshotai/kimi-k2.5 | $0.38 | $1.72 | ~$0.02 |
| google/gemini-3.1-flash-lite | $0.25 | $1.50 | ~$0.01 |

*Estimated per trip assuming ~8K input tokens (system prompt + tool results) and ~4K output tokens (itinerary JSON).*
