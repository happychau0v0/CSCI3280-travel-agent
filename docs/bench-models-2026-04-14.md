# Model Bake-off Report — 2026-04-14

**Models:** `grok-4.20-0309-non-reasoning` vs `grok-4.20-0309-reasoning`  
**Prompts:** 5 (greeting, weather, flight-search, 3day-plan, 5day-foodie)  
**Outer timeout:** 90s  
**Errors / timeouts:** 0

---

## Per-Prompt Results

### greeting

| metric | non-reasoning | reasoning |
|---|---|---|
| done | 997ms | 650ms |
| first partial | — | — |
| tool rounds | 0 | 0 |
| tool count | 0 | 0 |
| itin score | 0/100 | 0/100 |
| itin features | — | — |
| missing tools | — | — |
| forbidden hit | — | — |
| reply words | 14 | 14 |
| accuracy | ✅ | ✅ |

> non-reasoning: "Hey! I'm doing great—tell me where you'd like to go and I'll start planning."  
> reasoning: "Hey! I'm great. Tell me where you'd like to go and I'll start planning."

---

### weather

| metric | non-reasoning | reasoning |
|---|---|---|
| done | 4421ms | 3157ms |
| first partial | — | — |
| tool rounds | 1 | 1 |
| tool count | 1 | 1 |
| itin score | 0/100 | 0/100 |
| itin features | — | — |
| missing tools | — | — |
| forbidden hit | — | — |
| reply words | 6 | 6 |
| accuracy | ✅ | ✅ |

> non-reasoning: "Weather in Tokyo is currently unavailable."  
> reasoning: "Tokyo's weather data is currently unavailable."

---

### flight-search

| metric | non-reasoning | reasoning |
|---|---|---|
| done | 8024ms | 6479ms |
| first partial | 3226ms | 2805ms |
| tool rounds | 2 | 2 |
| tool count | 4 | 4 |
| itin score | 20/100 | 20/100 |
| itin features | 5 flights, phrasebook | 5 flights, phrasebook |
| missing tools | — | — |
| forbidden hit | — | — |
| reply words | 275 | 274 |
| accuracy | ⚠ | ⚠ |

---

### 3day-plan

| metric | non-reasoning | reasoning |
|---|---|---|
| done | 13844ms | **8897ms** |
| first partial | 3813ms | **2949ms** |
| tool rounds | 3 | 3 |
| tool count | 6 | 5 |
| itin score | **0/100** | **20/100** |
| itin features | — | 5 flights, phrasebook |
| missing tools | — | — |
| forbidden hit | — | — |
| reply words | 15 | 265 |
| accuracy | ⚠ | ✅ |

> non-reasoning returned a 15-word text stub instead of a structured JSON itinerary (score 0/100).  
> reasoning returned a complete itinerary with flights and phrasebook.

---

### 5day-foodie

| metric | non-reasoning | reasoning |
|---|---|---|
| done | 25954ms | **15816ms** |
| first partial | 3949ms | **2922ms** |
| tool rounds | 4 | 4 |
| tool count | 15 | 16 |
| itin score | 19/100 | 19/100 |
| itin features | 3 flights, rt, phrasebook | 3 flights, rt, phrasebook |
| missing tools | — | — |
| forbidden hit | — | — |
| reply words | 306 | 295 |
| accuracy | ✅ | ✅ |

---

## Aggregate

| metric | non-reasoning | reasoning |
|---|---|---|
| total wall-clock | 53.2s | **35.0s** |
| total tool calls | 26 | 26 |
| accuracy passes | 3/5 | **4/5** |
| avg itin score (where expected) | 9 | **19** |
| errors | 0 | 0 |

---

## Analysis

### Latency
Reasoning won every single prompt — counterintuitive given its name. Biggest deltas on heavy plans:

- `3day-plan`: 13.8s → 8.9s (**–36%**)
- `5day-foodie`: 26.0s → 15.8s (**–39%**)
- Total wall-clock: 53.2s → 35.0s (**–34%**)

### Accuracy
Reasoning 4/5 vs non-reasoning 3/5. The differentiator was `3day-plan`: non-reasoning returned a plain-text stub (15 words, score 0) instead of a structured itinerary. Both correctly suppressed tool calls on `greeting`. The shared ⚠ on `flight-search` is a partial-JSON completeness threshold, not a tool-routing error.

### Completeness
Average itinerary score 19 vs 9 — more than double. Gap driven entirely by `3day-plan` (0 vs 20); `5day-foodie` tied at 19.

### Stability
Zero errors, zero outer-timeout hits on either model.

---

## Recommendation

**Set `LLM_MODEL=grok-4.20-0309-reasoning` as the default.**

Reasoning was faster on every prompt (34% lower total wall-clock), more accurate (4/5 vs 3/5), and produced more complete itineraries (avg score 19 vs 9). Non-reasoning dropped a full itinerary on the most common use case (`3day-plan`), returning a plain-text stub — a user-facing regression. No stability tradeoff: both models were error-free with no timeouts.
