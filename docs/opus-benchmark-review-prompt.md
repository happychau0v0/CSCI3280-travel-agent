# Opus Benchmark Review — Round 2

You are reviewing the **revised** benchmarking methodology for the CSCI3280
travel-agent project. Round 1 found that all working models tied at 50/100
because the script was running a single-call benchmark against the
production multi-turn LLM, scoring on criteria that mostly collapsed under
deterministic mock fixtures. Round-1 review and recommendations are in
`docs/opus-benchmark-review.md` (read this first).

The script has been rewritten in line with those recommendations. Your job
is to scrutinise the new design, identify residual flaws, and decide
whether it is ready for the full sweep — or what still needs to change.

---

## 1. What changed since round 1

### 1.1 Single-call → 3-turn simulated flow

`scripts/benchmark-models.py` now runs each cell as **three sequential chat
completions** matching production stages, each with its role-scoped system
prompt:

| Turn | System prompt          | User message                                       |
|------|------------------------|----------------------------------------------------|
| 1    | `SYSTEM_PROMPT_PLAN`   | the prompt text (e.g. "Plan a 3-day trip to Tokyo…") |
| 2    | `SYSTEM_PROMPT_HOTELS` | `"Selected flight: <airline time→time $price>. Now find hotels in <dest>."` + original prompt |
| 3    | `SYSTEM_PROMPT_DAYS`   | `"Set <hotel> as the base hotel. Build the day-by-day plan."` + hotel/flight/dates context |

Picks injected between turns:
- After Turn 1: `flight.options[0]` (the cheapest non-stop in MOCK_TOOLS fixture)
- After Turn 2: `hotels[0]`

For P3 (train-only), Turn 2's user message is `"No flight needed — using
ground transport. Now find hotels in <dest>."` — same shape as the
production skip-flight path in `frontend/src/App.jsx:1848-1851`.

Each turn is a **fresh chat completion** with no prior assistant history
carried across, matching the production scoped-call shape in
`backend/app/llm.py:373` ("Scoped calls (plan/hotels/days) must NOT see
prior conversation history").

Per-turn round caps mirror production (`app/llm.py:89-93`):
`{plan: 6, hotels: 3, days: 3}`. The 6-round plan cap is more generous
than production's 20 default; runaway behaviour is captured by the
efficiency criterion (§1.3) instead.

### 1.2 BENCH_EVAL_ADDENDUM is no longer used by the script

The addendum still exists in `prompts.py` for backwards compatibility
with any other tests, but the benchmark no longer appends it. The
production-faithful 3-turn flow makes the override unnecessary.

### 1.3 Rubric v3 (replaces v2)

| #  | Criterion | Pts | Why it discriminates |
|----|-----------|-----|----------------------|
| 1  | Strict schema (Pydantic + place_id↔lat/lng) | 10 | Production-correctness invariant; weak models drop lat/lng on copied places |
| 2  | Flight fidelity / Train suppression | 15 | Verbatim copy of 5 options + `stop_cities` for 1-stops + `return_options` for round-trip; for P3, flights must be omitted **and** days produced anyway |
| 3  | Hotel count + price diversity | 10 | 5-8 hotels spanning ≥3 price levels — naive models pick all expensive |
| 4  | Day count matches expected | 8 | Lazy models truncate at 3 |
| 5  | `selected_hotel == null` in Turn 2 | 2 | Stage discipline check |
| 6  | `selected_hotel` matches picked in Turn 3 | 2 | Day planner anchors on right hotel |
| 7  | Activity density (avg ≥4 real/day) | 12 | Strongest current discriminator; "real" = not bookend |
| 8  | Day-1 anchor (airport→hotel for flight prompts; first activity for train) | 5 | Tests reading prompt 145 of `SYSTEM_PROMPT_DAYS` |
| 9  | Last-day anchor (departure airport last) | 5 | Same |
| 10 | Activity diversity (no 3+ same category in a row) | 6 | Naive models stack museum/museum/museum |
| 11 | Description grounding (place_id→description from `get_place_details`) | 6 | Catches models that fabricate descriptions |
| 12 | Directions on every consecutive pair | 6 | `transport_to_next` populated except final activity |
| 13 | Phrasebook fidelity (present for foreign, omitted for P3) | 5 | Genuine instruction-following test on P3 |
| 14 | Tool-call efficiency (within 1.5× expected → full; >3× → 0) | 8 | Catches `minimax-m2`-style runaway loops AND undercalls |

Total = **100**. Bonus signals (rounds_used per stage, which turns
produced an itinerary, errors per turn) are logged in run records but
not scored — useful for the report's failure-mode analysis.

Categorisation uses **word-boundary regex matching** (not substring) so
e.g. `tea` does not match `teamLab`. Bookend detection includes the
hotel-name set (so `Park Hyatt Tokyo` resolves to bookend even though it
contains no literal "hotel" token).

### 1.4 Model list trimmed from 9 to 6

```python
MODELS = [
    "x-ai/grok-4.20",
    "anthropic/claude-sonnet-4.6",
    "google/gemini-3.1-pro-preview",
    "deepseek/deepseek-v3.2",         # CONDITIONAL — retest required
    "moonshotai/kimi-k2-0905",
    "minimax/minimax-m2.7",
]
```

Removed (round-1 confirmed broken):
- `x-ai/grok-4.20:thinking`         — 404
- `deepseek/deepseek-v3.2-speciale` — no tool-use endpoints
- `minimax/minimax-m2`              — 30-call runaway loops

`deepseek-v3.2` is kept conditionally: round 1 saw 0/100 (6 tool calls,
no JSON emission). The hypothesis is that it lost track in the 240-line
monolithic prompt; the role-scoped prompts here are ~60 lines each. The
sanity probe (§3.1) settles whether it stays or goes.

### 1.5 Prompts: P5 and P6 swapped for non-Asian destinations

P1–P4 retained. P5 (Seoul) and P6 (Taipei) replaced because they merely
duplicated P1's East-Asia coverage and provided no spread.

| ID | New prompt | Probes |
|----|-----------|--------|
| P5 | 4-day Lisbon from London, family of 3, mid-budget, tile museums + Fado + pastéis de nata + tram rides | Non-Asian destination, family-with-child party type, Portuguese phrasebook (less-trained than ja/ko/th) |
| P6 | 7-day Marrakech from Paris, couple, mid-budget, souks + hammams + riads + Atlas Mountains day trip | Non-Asian destination, longest trip in suite (stresses activity-density floors), Arabic phrasebook, day-trip-out-of-city subgoal |

`expected_lang_code` is now per-prompt metadata so the phrasebook check
can verify the right language was returned (where MOCK_TOOLS allows —
the mock always returns Japanese, so the rubric currently only checks
"phrasebook present" / "phrasebook omitted for P3").

---

## 2. Verification done so far

- **Imports clean** under `MOCK_TOOLS=1` (verified by direct import).
- **Synthetic perfect P1** scores **90/100**. The 10-point loss is
  legitimate (synthetic test data was missing required `Flight.from_city`
  field; real fixture provides it).
- **Synthetic perfect P3** (train-only, 2-day Kyoto) scores **92/100**.
- **Round-1 failure mode (Turn-1-only output)** now scores **36/100**, down
  from the v2 ceiling of 50. Lost points: hotels (10), Turn 2/3
  selected_hotel (4), activity density (12), anchors (10), grounding (6),
  directions (6), efficiency (6).
- **Categorisation** verified: `Park Hyatt Tokyo` → bookend (via hotel-name
  match), `teamLab Borderless` → other (no false-positive on `tea`),
  `Tea Ceremony` → sight, `Atlas Mountains Day Trip` → nature.

**No real API calls have been made yet.** The script is ready for the
sanity probe but has not been validated end-to-end against any model.

---

## 3. The proposed run plan

### 3.1 Sanity probe (~6 calls × 3 turns = 18 chat completions, ~$1)

Before scaling: `MOCK_TOOLS=1 python scripts/benchmark-models.py
--prompts P1 --runs 1`. Run all 6 models on P1 only, once. Confirm:

1. Score spread between best and worst is ≥15 points.
2. `deepseek-v3.2` produces a valid itinerary on Turn 1 (drop the model if not).
3. No model triggers a >3× efficiency penalty (would indicate a tool-loop pathology that needs investigating before the full sweep).

If any of these fail, iterate on the rubric/prompts/model list before
scaling. **Do not run the full sweep until the sanity probe passes.**

### 3.2 Full sweep (~324 calls, ~$15-25)

`MOCK_TOOLS=1 python scripts/benchmark-models.py` — 6 models × 6 prompts ×
3 runs × 3 turns. Output: `docs/bench-<date>.md` and
`docs/benchmark-results.json`.

---

## 4. Questions for round-2 review

### Q1 — Is the 3-turn injection faithful enough?

The Turn-2/Turn-3 user messages are constructed strings, not the exact
shape the frontend sends. Specifically:

- **Turn 2** sends `"Selected flight: <airline> <dep>→<arr> $<price>. Now find hotels in <dest>.\n\nOriginal request: <prompt>"`. Production sends only the first sentence (App.jsx:1831). Including the "Original request" appends context the production system *doesn't* provide via user message — it's in the form fields (USER LOCATION, TRIP DATES, USER PROFILE blocks injected by `_format_*` helpers in `app/llm.py:343-349`).
- **Turn 3** is more divergent: production injects the picked hotel via the day-themes pre-pass + day-detail per-day calls, not as one consolidated message to `SYSTEM_PROMPT_DAYS`. The benchmark uses the unified `SYSTEM_PROMPT_DAYS` because it's the simpler shape — but it tests a code path that production uses only as a fallback / single-shot mode.

**Question:** Is this divergence acceptable, or should the benchmark
- (a) wire up the per-day `day_themes` + `day_detail` cascade to mirror production exactly, or
- (b) construct the user message more minimally (drop the "Original request" appendix) to match the frontend more closely?

(a) is faithful but adds 1 + N day_detail calls per cell, ballooning the sweep cost significantly.

### Q2 — MOCK_TOOLS limitations bleeding into the rubric

Several rubric criteria can only be partially verified because mocks
return constant fixtures:

- **`mock_search_places`** always returns Tokyo place names ("Senso-ji Temple", "Park Hyatt Tokyo") regardless of destination. Models that follow the "copy verbatim" rule will produce Tokyo places for the Marrakech prompt. The rubric currently doesn't check destination-place consistency.
- **`mock_get_phrasebook`** always returns Japanese (`ja`) regardless of destination. The rubric only checks "phrasebook present (or omitted for P3)" — it cannot verify `language_code` matches the expected destination.
- **`mock_get_place_details`** returns one fixture description ("A wonderful mock place for testing.") for *every* place_id. The "description grounding" check verifies a description exists; it cannot verify the description is *appropriate* to the place.

**Question:** Should we
- (a) extend the mocks to return destination-specific fixtures (Bangkok prompts get Bangkok places, Marrakech prompts get Marrakech places, P5 gets pt phrases, P6 gets ar phrases), or
- (b) accept that some criteria are weakened and rely on cross-prompt aggregation, or
- (c) run a small subset (1-2 prompts) with **MOCK_TOOLS=0** against real APIs to validate the destination-fidelity dimension?

(a) is the right answer for benchmark quality but is meaningful work. (c) costs ~$5 in real API calls and adds API-flake variance.

### Q3 — The placeholder fallback masks genuine Turn-1 failures

If Turn 1 produces no `flight.options`, `run_three_turns` falls back to
`picked_flight = None` and proceeds to Turn 2 with the
"No flight needed" message — which is the exact same path as P3
(train-only). Turn 2 sees the same input it would for P3, but the
*prompt* still says "Plan a 3-day trip to Tokyo from Hong Kong" with
flight intent. Models may correctly produce hotels anyway, but the
benchmark cannot tell whether a model failed Turn 1 (silent fallback)
vs. correctly chose train mode (P3 only).

The current rubric does flag this via the `flight` criterion (a
flight-required prompt with empty `flight.options` loses the bulk of 15
points). But the placeholder hotel injection in Turn 3 (`Placeholder
Hotel (<destination>)`) is a more troubling fallback — it lets Turn 3
produce a valid-looking days plan even when both prior turns failed.

**Question:** Should `run_three_turns` instead **skip** Turns 2 and 3
when prerequisites are missing (and have the rubric score those skipped
turns as 0), or is the silent-fallback-with-rubric-penalty design
better because it surfaces partial competence?

### Q4 — Tool-call efficiency expected-counts

`_expected_tool_calls(prompt_meta)` returns:
- P1 (3-day RT): 22  | P2 (5-day RT): 32  | P3 (2-day, train): 15
- P4 (5-day RT): 32  | P5 (4-day RT): 27  | P6 (7-day RT): 42

These are lower-bound estimates assuming 1 search_places per day +
4 directions per day + n_days place_details. The 1.5× tolerance gives
P6 a budget of 63 calls. P6 is also the only 7-day prompt — does the
expected-count formula scale correctly here, or are 7-day plans
*structurally* tool-heavier than the 4×n_days assumption admits?

**Question:** Is the per-prompt expected-count formula correct, or
should it be calibrated empirically from the sanity probe (run 1 cell
per prompt, take the median tool count among models that produced a
high-scoring itinerary, set 1.5× of that as the threshold)?

### Q5 — Per-turn capture for selected_hotel checks

`turns[<stage>].itinerary` now stores the per-turn itinerary so the
Turn-2-null and Turn-3-match checks work correctly. But the JSON dump
will be ~3× larger than before (full per-turn itineraries × 3 stages
× 3 runs × 6 prompts × 6 models = ~324 itineraries stored). This is
fine for now (a few MB) but might be unwieldy if the suite grows.

**Question:** Worth introducing a "lite" output mode that dumps only
top-level scoring breakdowns by default, with full per-turn itineraries
in a separate file behind a flag? Not blocking — file a TODO.

### Q6 — Day-1 anchor scoring nuance

The Day-1 anchor check awards 3 points if the first activity is the
arrival airport, +2 points if the second is the picked hotel.
`SYSTEM_PROMPT_DAYS:141-148` actually specifies that on Day 1 the order
is `airport → hotel-check-in → activities → hotel-return`. So a model
that produces `[airport, real activity, hotel, real activity, hotel]`
(skipping the early hotel check-in) loses anchor points but isn't
necessarily wrong — it just deferred check-in. Conversely, a model that
puts the hotel as Day 1 activity 1 (skipping the arrival airport
entirely) gets 0 points, which is correct.

**Question:** Is the second-activity-must-be-hotel rule too rigid? An
alternative is "hotel appears in positions 1 or 2" (3pts) without
requiring exactly position 1.

### Q7 — Are 6 prompts enough now?

With the swap, the suite now spans:
- East Asia (P1, P2, P3, P4): Tokyo, Bangkok, Kyoto, Bali
- Europe (P5): Lisbon
- MENA (P6): Marrakech

Trip durations: 2, 3, 4, 5, 5, 7 days.
Party types: 2 adults, solo (×2), couple (×2), family.

But: the Marrakech prompt is the only mid-budget couple, the Lisbon
prompt is the only family-of-3, etc. There's no replication for
distinguishing "model is bad at Marrakech" from "model is bad at MENA
in general" or "model is bad at couples" — each new dimension is
tested only once. Cross-prompt patterns will be hard to read.

**Question:** Is 6 prompts × 3 runs sufficient, or should we add 2 more
prompts (e.g. a Western-Europe non-family + a long Asia trip) to give
each new dimension at least one redundant test? Cost: 2 × 3 × 3 = 18
extra chat completions per model.

### Q8 — What's still missing?

Open-ended: scan the rubric and the run plan for any failure mode you'd
expect to see in production that isn't currently scored. Suggested
candidates to consider:
- Dietary constraints (P5 has "mid-budget", P2 has "budget", but no prompt enforces vegetarian — the original P5 had it)
- Currency consistency (does the model emit prices in the user's currency?)
- Subtitle/spoken-text quality (the production system requires a 10-25 word spoken sentence after the JSON; the benchmark currently ignores it)
- Polyline / map fields (any leakage of `polyline` strings into JSON would break frontend rendering)

---

## 5. Summary of decisions needed in round 2

1. **3-turn faithfulness:** accept the current shape, mirror production's day_themes/day_detail cascade, or simplify the user messages?
2. **MOCK_TOOLS extensions:** destination-specific fixtures, real-API spot-check, or status quo?
3. **Failure-fallback semantics:** placeholder injection or skip-turn-on-failure?
4. **Efficiency thresholds:** keep formula-based, switch to empirical calibration after sanity probe, or both?
5. **Day-1 anchor strictness:** position-strict or position-flexible (1 or 2)?
6. **Prompt count:** 6 (current) or expand to 8?
7. **Missing criteria:** what's still un-scored that should be scored?

For each, please give a recommendation with rationale, then advise
whether to (a) run the sanity probe immediately, (b) iterate further
before any real API calls, or (c) ship the current state to the full
sweep without a probe.
