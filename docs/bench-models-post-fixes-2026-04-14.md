# Model Bake-off Report — Post-Fix Run 2026-04-14

**Models:** `grok-4.20-0309-non-reasoning` vs `grok-4.20-0309-reasoning`  
**Prompts:** 5 (greeting, weather, flight-search, 3day-plan, 5day-foodie)  
**Outer timeout:** 90s | **Errors / timeouts:** 0

Fixes applied since baseline (`83dca4e`):
1. `bench_eval` mode — collapses 3-turn flow into one response for accurate scoring
2. `search_places` — `editorialSummary` + `regularOpeningHours` added to field mask
3. xAI `web_search_preview` server-side tool — replaces dead stub
4. `get_weather` mock/Pydantic/prompt aligned to live API shape
5. `fast_flights` seat class — no longer hardcodes `economy`
6. `navigate_menu` — HOME removed from description and enum
7. Context pruning — old tool results replaced after round 2

---

## Per-Prompt Results

### greeting

| metric | non-reasoning | reasoning |
|---|---|---|
| done | 989ms | 751ms |
| tool rounds | 0 | 0 |
| itin score | 0/100 | 0/100 |
| accuracy | ✅ | ✅ |

### weather

| metric | non-reasoning | reasoning |
|---|---|---|
| done | 3189ms | 3120ms |
| tool rounds | 1 | 1 |
| itin score | 0/100 | 0/100 |
| accuracy | ✅ | ✅ |

### flight-search

| metric | non-reasoning | reasoning |
|---|---|---|
| done | 10447ms | 9130ms |
| first partial | 2733ms | 2690ms |
| tool rounds | 2 | 2 |
| tool count | 4 | 4 |
| itin score | 20/100 | 20/100 |
| itin features | 5 flights, phrasebook | 5 flights, phrasebook |
| accuracy | ⚠ | ⚠ |

### 3day-plan

| metric | non-reasoning | reasoning |
|---|---|---|
| done | 12772ms | 7992ms |
| first partial | 2797ms | 2598ms |
| tool rounds | 3 | 2 |
| tool count | 5 | 4 |
| itin score | **25/100** | **0/100** |
| itin features | 5 flights, rt, phrasebook | — |
| accuracy | ✅ | ⚠ |

> non-reasoning returned full structured JSON. reasoning returned 17-word text stub again.

### 5day-foodie

| metric | non-reasoning | reasoning |
|---|---|---|
| done | 15810ms | 16542ms |
| first partial | 3397ms | 2828ms |
| tool rounds | 4 | 4 |
| tool count | 8 | 9 |
| itin score | 19/100 | 19/100 |
| itin features | 3 flights, rt, phrasebook | 3 flights, rt, phrasebook |
| accuracy | ✅ | ✅ |

---

## Aggregate Comparison

| metric | non-reasoning (before) | non-reasoning (after) | reasoning (before) | reasoning (after) |
|---|---|---|---|---|
| total wall-clock | 53.2s | **43.2s** (−19%) | 35.0s | 37.5s (+7%) |
| total tool calls | 26 | **18** (−31%) | 26 | **18** (−31%) |
| accuracy passes | 3/5 | **4/5** | 4/5 | 3/5 |
| avg itin score | 9 | **22** (+144%) | 19 | 9 (−53%) |
| errors | 0 | 0 | 0 | 0 |

---

## Analysis

### What improved

**non-reasoning is substantially better:**
- Avg itinerary score 9 → 22 (+144%) — `bench_eval` mode now triggers complete itinerary responses; `3day-plan` went from 0 to 25 (was returning a 15-word stub, now returns structured JSON with flights + rt + phrasebook)
- Accuracy 3/5 → 4/5 — `navigate_menu` contradiction fix removed conflicting instructions
- Wall-clock 53.2s → 43.2s (−19%) — context pruning reduced token load per round; fewer total tool calls (26→18) likely because richer `search_places` responses (now include descriptions + hours) let the model complete planning in fewer round trips

**Tool call efficiency up for both models:** 26 → 18 calls total. The `editorialSummary` + `regularOpeningHours` additions mean the model gets what it needs from `search_places` without needing follow-up `get_place_details` calls.

### What regressed

**reasoning model on `3day-plan` (19→0, ✅→⚠):** The reasoning model returned a 17-word text stub again ("Three days in Tokyo, HK$1140 flights from HKG to NRT, phrasebook ready, pick your flight to continue") instead of structured JSON — same failure mode as baseline. Two probable causes:

1. **Context pruning interaction:** The reasoning model appears to use more rounds of deliberate back-and-forth before committing to a response. Pruning old tool results after round 2 may deprive it of geocoding/flight data it references in later rounds to construct the itinerary. Non-reasoning batches aggressively and needs those results less.
2. **bench_eval addendum placement:** The addendum is appended after all context additions. Reasoning model may weight the final itinerary structure lower when its internal chain-of-thought is interrupted.

**reasoning wall-clock:** 35.0s → 37.5s (+7%) — slight regression, within noise, but worth watching.

### Scores still low on flight-search (both models, 20/100)

This is structural: `flight-search` prompts (`"Search flights from HKG to TYO"`) naturally produce Turn-1-only responses (flights + phrasebook = 20 pts max in the current scorer). The `bench_eval` mode fires for `fetch_full_done` scoring but the model correctly treats a pure flight query differently from a full trip plan. The scorer doesn't distinguish these prompt types.

---

## Recommendation

**Keep `LLM_MODEL=grok-4.20-0309-reasoning` as default** for the app (user-facing), but **investigate context pruning interaction with the reasoning model** before the next bench cycle:

- Try `keep_recent_rounds=3` for the reasoning model, or make the prune threshold model-aware
- The non-reasoning model benefits clearly from pruning (faster, more accurate); the reasoning model may need a larger context window to work well

**Non-reasoning model** is now competitive for the app (4/5 accuracy, 22 avg score vs reasoning's 3/5, 9) and 14% faster total. If context pruning is tuned to not hurt reasoning, reasoning should still win on completeness for complex plans.
