# Opus Benchmark Review — Recommendations

Reviewed: `scripts/benchmark-models.py`, `backend/app/prompts.py` (`SYSTEM_PROMPT`, `SYSTEM_PROMPT_PLAN`, `SYSTEM_PROMPT_HOTELS`, `SYSTEM_PROMPT_DAYS`, `BENCH_EVAL_ADDENDUM`), validation result `docs/bench-2026-04-25.md`.

The 50/100 ceiling is not just a missing-second-message bug. It exposes a **structural mismatch between what the benchmark exercises and what production actually runs.** The proposed `BENCH_EVAL_ADDENDUM` patches the symptom but does not fix the mismatch, and most rubric items will still collapse after the fix. Below is a concrete recommendation per decision.

---

## Q1 — Fix approach: single-call override vs. simulated 3-turn

**Recommend (b): simulated 3-turn flow using the role-scoped prompts.**

Why the addendum is the wrong shape:

1. **It contradicts the surrounding prompt.** `SYSTEM_PROMPT` lines 60–67 explicitly say "Each step is a separate chat turn. You only produce the data for the CURRENT step." Then the addendum says "produce ALL three planning turns at once." A well-aligned model will resolve this by following the more specific guidance and ignoring the less specific one — and which one wins is itself a model-quality signal you don't want to score on.
2. **It doesn't test the production code path.** Production routes by stage (`prompts.py:610-615` — `prompt_for_stage`), so the LLM never sees the monolithic prompt in the real app. The benchmark would optimize for behaviour the production system never invokes.
3. **It tests instruction-override compliance.** Models with stronger steerability (e.g. Sonnet) will obey the override; models that anchor on the leading prompt will half-comply. That is a real capability difference but it is not the capability we want to rank for "is this a good travel agent."

**Simulated 3-turn loop (production-faithful):**

```python
# Turn 1 — flights
msgs = [{"role": "system", "content": SYSTEM_PROMPT_PLAN}, user_prompt]
turn1 = run_tool_loop(model, msgs)   # extract itinerary; expect flight.options + days stubs

# Turn 2 — hotels (inject deterministic flight pick)
picked_flight = turn1["flight"]["options"][0]
msgs += [assistant(turn1_text),
         {"role": "user", "content": f"Selected flight: {picked_flight['airline']} "
                                     f"{picked_flight['departure_time']}→"
                                     f"{picked_flight['arrival_time']}, "
                                     f"${picked_flight['price_low']}."}]
msgs[0] = {"role": "system", "content": SYSTEM_PROMPT_HOTELS}
turn2 = run_tool_loop(model, msgs)   # expect hotels[] + selected_hotel=null

# Turn 3 — days (inject deterministic hotel pick)
picked_hotel = turn2["hotels"][0]
msgs += [assistant(turn2_text),
         {"role": "user", "content": f"Set {picked_hotel['name']} as the base hotel."}]
msgs[0] = {"role": "system", "content": SYSTEM_PROMPT_DAYS}
turn3 = run_tool_loop(model, msgs)   # expect days[] + selected_hotel populated

merged = merge_itineraries(turn1, turn2, turn3)
score = score_v3(merged, prompt_meta, turn1, turn2, turn3)
```

**Cost:** ~3× calls per cell. With the trimmed 6-model list (Q4) and 6 prompts × 3 runs, you go from 162 calls to ~486 calls. At validation cost (`$0.05`/call median × 486) ≈ **$24 total**. Fine.

**Bonus:** lets you score *per-stage* failures separately ("Stage 2 failed" is more actionable than "score=50").

---

## Q2 — Rubric items that still collapse after the fix

Even with the fix, MOCK_TOOLS returning fixed fixtures means several criteria cannot discriminate:

| Item | Collapse risk | Reason |
|---|---|---|
| Schema (15) | **High** — all working frontier models pass | `Itinerary` only requires title+destination |
| Flight count (15) | **High** — fixture returns 5; everyone copies | `flight.options` is "copy verbatim" instruction |
| Phrasebook (5) | **High** — fixture is constant | Binary "did you call get_phrasebook" |
| Time realism (5) | **High** — examples stay in 08–22 | Binary, easy to satisfy |
| Time gaps (5) | **Medium** — depends on activity count | Vacuously true with 0 activities (current bug) |
| selected_hotel=null (5) | **Inverted** — see Q3 |
| Hotel count (15) | **Low** — partial credit, real discriminator |
| Day count (10) | **Low** — lazy models truncate to 3 |
| Activity density (15) | **Low** — strongest current discriminator |
| Directions (5) | **Low** — many models skip `transport_to_next` |
| P3 flight suppression (15) | **Low** — genuine instruction-following test |

**~45/100 worth of points cannot differentiate models** under the current rubric. Replace them.

**Recommended replacements (rubric v3):**

1. **Drop "Schema (15)" → "Strict schema (10)"** — pass = all of: every activity with `place_id` has lat+lng, every Day's activity times are strictly monotonic, no fabricated fields outside the Pydantic model. Many models skip the lat/lng on copied places, which currently passes Pydantic only because the validator at `prompts.py:663-674` raises but isn't always hit (depends on whether `place_id` is set).
2. **Drop "Flight count (15)" → "Flight fidelity (10)"** — checks structured details that require *actually parsing* the fixture: (a) all 5 options copied verbatim from the tool result (count + price equality), (b) `stop_cities` populated for 1-stop options (per `prompts.py:93`), (c) for round-trip prompts (P1, P4), `return_options` non-empty AND `return_date` set. This rewards reading the prompt instead of producing 5 fakes.
3. **Drop "Phrasebook (5)" → "Phrasebook fidelity (3)"** — the phrasebook fixture is non-empty AND `language_code` matches destination (e.g. "ja" for Japan), AND for P3 (domestic) the phrasebook is correctly *omitted*. Discriminator: did the model think about whether a phrasebook is even relevant?
4. **Drop "Time realism (5)" → "Day-1 anchor + Last-day anchor (8)"** — Day 1 first activity name contains the arrival airport IATA; Day 1 second activity is the chosen hotel; last day last activity is departure airport. Production explicitly mandates this (`prompts.py:141-162`). It's the cleanest test of "did the model understand the day-building rules."
5. **Drop "Time gaps (5)" → "Activity diversity (5)"** — penalize >2 consecutive activities of the same kind (museum/museum/museum, café/café/café). Naive models stack identical place types.
6. **Add "Description grounding (4)"** — fraction of activities with non-empty `description` AND the description came from `get_place_details` (track tool calls, fail if model fabricated). Currently invisible in scoring; a major real-world failure mode.
7. **Add "Tool-call efficiency (5)"** — penalize `>1.5×` the minimum needed tool calls for the prompt (e.g. P1 minimum ≈ 2 + 1 + (n_days × 1) + (n_legs × 1) ≈ 12). Captures both runaway loops and lazy under-calling. **This is what differentiates `minimax-m2`'s 30-call runaway from a tight `kimi` run** — currently invisible.
8. **Keep & strengthen P3 flight suppression (15)** — split into 5pts for omitting flights and 10pts for producing days even without flights. P3 is the single best probe in the suite.

Total still 100. Roughly 70 points become genuine discriminators (vs ~30 today).

---

## Q3 — `selected_hotel` contradiction

**Recommend: split into two checks under the 3-turn fix; remove entirely if you stay single-call.**

Under the 3-turn simulation:

- **Turn 2 result must have `selected_hotel == null`** (3pts) — proves the hotel finder is deferring the pick.
- **Turn 3 result must have `selected_hotel` matching the injected pick** (3pts) — `selected_hotel.place_id == picked_hotel.place_id`. Proves the day planner anchors on the right hotel (a real production bug — see `prompts.py:317-321`).

Under single-call mode this criterion is incoherent and should be removed; the merged itinerary cannot satisfy "null AND populated" simultaneously.

---

## Q4 — Model list cleanup

**Recommend: drop 3, retest 1, finalize at 6 models.**

| Slug | Action | Reason |
|---|---|---|
| `x-ai/grok-4.20` | Keep | Validated working |
| `x-ai/grok-4.20:thinking` | **Drop** | 404 confirmed — not on OpenRouter |
| `anthropic/claude-sonnet-4.6` | Keep | Validated, anchor for "frontier" tier |
| `google/gemini-3.1-pro-preview` | Keep | Validated, broad-knowledge anchor |
| `deepseek/deepseek-v3.2` | **Retest** after fix | 6 tool calls + 0 itinerary suggests it didn't recognize the JSON-emit step in the long monolithic prompt. Role-scoped prompt (`SYSTEM_PROMPT_PLAN`, ~60 lines vs 240) is much more likely to succeed. **Reassign verdict only after one re-run with the 3-turn fix.** Keep slug; if it still fails at Turn 1 emission, drop. |
| `deepseek/deepseek-v3.2-speciale` | **Drop** | 404 — no tool-use endpoints, structural |
| `moonshotai/kimi-k2-0905` | Keep | Validated, "value tier" |
| `minimax/minimax-m2` | **Drop** | 30-call runaway is a stop-condition pathology, not something to score |
| `minimax/minimax-m2.7` | Keep | Validated, "value tier" |

**Optional add (1 model):** a smaller/cheaper model from the same families to surface cost-efficiency tradeoffs (e.g. `anthropic/claude-haiku-4.5` if available — validate the slug first via dry-run). Without it, the report has no strong "you can pay 5× less for 90% of the score" story.

**Final list (6 confirmed + 1 conditional):**
```
grok-4.20, claude-sonnet-4.6, gemini-3.1-pro-preview,
kimi-k2-0905, minimax-m2.7, [haiku-4.5 if validated],
deepseek-v3.2 (conditional on retest passing)
```

---

## Q5 — Prompt diversity

The current 6 are **structurally diverse** (durations, party types, train-only, dietary) but **geographically narrow** — every destination is Asia-Pacific. Two model-ranking distortions follow:

1. **Training-data bias.** Sonnet/Gemini have stronger Western-destination knowledge in some evals; Tokyo/Bangkok/Seoul play to *all* models' strong suits and may compress the spread.
2. **Phrasebook signal is weak** — Japanese/Thai/Korean phrasebooks are well-represented in training, so even weak models produce passable fixtures.

**Recommend: keep 4 of the 6, swap 2.**

| Drop | Replace with | Tests |
|---|---|---|
| P5 (Seoul/Tokyo, similar to P1) | **P5': 4-day Lisbon from London**, family of 3, mid-budget, Portuguese phrasebook | Non-Asian destination; Portuguese is less-trained; family-mid-budget is a different optimization target than P4 (couple/business class) |
| P6 (Taipei/HK, similar to P1) | **P6': "Plan a 7-day trip to somewhere warm in Europe in October"**, 2 travelers, no specific city | Tests `request_input` for missing destination AND tests longer trip (7 days exposes activity-density floors) |

This keeps East-Asia coverage (P1, P2, P3, P4) but adds two genuine spread-creators. **6 prompts is enough** if they discriminate; the issue today is that P1 alone returned identical scores from all 5 working models — adding more prompts *without* fixing the rubric will not help.

---

## Q6 (implicit) — Order of operations

Don't run the 162-call (or 486-call) full sweep until you've done all of:

1. **Implement the 3-turn loop** in `benchmark-models.py`. Verify it produces a complete merged itinerary on `grok-4.20` × P1 × 1 run.
2. **Implement rubric v3.** Reuse v2 helpers; add the 4 new criteria.
3. **Run a 1-cell sanity probe** per surviving model (6 models × P1 × 1 run = 6 calls, ~$1). Confirm that scores actually spread (target: ≥15-point spread between best and worst). If they still cluster, the rubric is still wrong — iterate before scaling.
4. **Run the full sweep.** 6 models × 6 prompts × 3 runs × 3 turns = 324 calls. ~$15-25.

The single most important signal for the report is **score spread**, not absolute numbers. If all models still score within 5 points after the fix, the benchmark has nothing to say.

---

## Decision summary

| Decision | Recommendation |
|---|---|
| Fix approach | Simulated 3-turn flow with role-scoped prompts |
| Rubric | v3 — replace ~45pts of collapsed criteria with 4 new discriminators (efficiency, fidelity, anchor-day, description-grounding) |
| `selected_hotel` | Split into Turn 2 null check + Turn 3 match check |
| Flight count | Replace with flight-fidelity (verbatim copy + stop_cities + return_options) |
| Model list | 6 confirmed + 1 conditional retest of `deepseek-v3.2` |
| Prompt diversity | Keep P1/P2/P3/P4, swap P5+P6 for non-Asian + open-ended-destination |
| Sequencing | Sanity-probe (6 calls) before full sweep |
