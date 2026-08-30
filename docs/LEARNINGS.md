# Project Learnings — AI Travel Agent (CSCI3280)

Hard-won lessons from 20+ rounds of development. These encode WHY
decisions were made, not just WHAT was built — the kind of context
that git log and code comments don't capture well.

## 1. Always Do a Playwright Browser Walkthrough Before Shipping

Mocked tests verify code logic but miss CSS layout issues, real API
edge cases, and LLM output format mismatches. Rounds 12-20 shipped
40+ features with 267/267 mocked tests passing, but a single
Playwright browser walkthrough immediately found 8+ real bugs:

- Button clipped below viewport at small screens
- Hotel names truncated by flex overflow
- Flight arrival times showing wrong day (no +1 indicator)
- Partial fast-flights data showing 1 option instead of fallback
- "✓ PICKED" badge clipped to "✓ PI"
- Geolocation "Locating…" stuck forever without fallback

**Rule:** After every round, before the final commit, use Playwright
MCP to walk through PLAN → FLIGHTS → HOTELS → DAYS at 1440×900 AND
1024×600 viewports. Check every overlay (? P L S H F). This is
documented in CONTRIBUTING.md as a required browser smoke check.

## 2. The LLM Copies the Prompt Example Literally

The Gemini Flash Lite model mirrors the OUTPUT FORMAT example
structure. If the example JSON shows 2 flight options, the LLM
emits exactly 2 — even when `search_flights` returned 8. If the
example shows 1 hotel, the LLM emits 1 — even when `search_places`
returned 20.

**Rule:** Whenever changing the minimum count for any itinerary
field (flights, hotels, activities per day), ALSO update the OUTPUT
FORMAT JSON example in `prompts.py` to show that many items. The
example is the specification the model actually follows; prose
instructions like "VERBATIM" are secondary.

**Evidence:** Round 11 fixed the hotels example (1 → 5). The same
bug for flights (2 → 5) wasn't caught until a user reported "still
getting 1 flight" weeks later.

## 3. Google Places pageSize Defaults to 1

The Google Places (New) API returns only 1 result when `pageSize`
is not included in the POST request body. Our `search_places`
wrapper had a conditional:

```python
if location:
    body["pageSize"] = 20
```

When the LLM called `search_places("hotels in Tokyo")` WITHOUT the
optional `location` parameter, `pageSize` was never set, and every
plan collapsed to 1 hotel, 1 activity, 1 restaurant.

**Rule:** Always set pagination/count parameters UNCONDITIONALLY in
API wrappers — never gate them on optional arguments. Verify with a
pytest that the request body always contains the expected field.

## 4. Merge Partial Live Data With Estimator Padding

`fast-flights` sometimes returns only 1-2 valid flights instead of
10+ (IP blocked by proxy, rate-limited, slow route). The old
fallback check `if live_options:` accepted any non-empty list, so
the user saw 1 flight option with no alternatives.

**Rule:** For any tool with a "live data" path and a "fallback"
path, require a MINIMUM viable count (≥3) before using live data
exclusively. When below that threshold, merge live results with
estimator output so users get both real pricing AND alternatives.

## 5. Prompt Contradictions Drive the LLM to the Minimum

When the system prompt contains conflicting count requirements
(e.g., Step 3 says "5-8 hotels" but FIELDS YOU MUST POPULATE says
"3 hotels"), the LLM resolves the conflict conservatively and emits
the lower number.

**Rule:** Grep the entire SYSTEM_PROMPT for count-related strings
before changing any "pick N" instruction. Use a pytest that string-
searches SYSTEM_PROMPT for known-bad patterns (e.g., "3 well-rated"
should NOT appear).

## 6. The 4-Turn LLM Flow Doesn't Work With Light Models

Round 10 attempted a strict 4-turn sequence (Turn 1 = flights only,
Turn 2 = transport ask, Turn 3 = hotels only, Turn 4 = days). The
Gemini Flash Lite model consistently conflated turns — it would skip
the flight JSON emission and jump straight to asking about transport.

**Solution:** Let the LLM plan everything in one turn (like Round 9)
and drive the step-by-step UX from the frontend instead. Flight pick
auto-advances to HOTELS; hotel pick auto-advances to DAYS. The LLM
never needs to know about the multi-step flow.

## 7. Navigate Events Arrive Before Done Events

The backend emits the `navigate` SSE event during the
`navigate_menu` tool_start, which arrives on the stream BEFORE the
`done` event carrying the final itinerary. If the frontend applies
the navigation immediately, the user lands on an empty panel.

**Rule:** Buffer navigate events in a ref during streaming; flush
only after `setCurrentItinerary` runs in the `done` handler.

## 8. macOS `setenv`/`unsetenv` Are Not Thread-Safe

`asyncio.to_thread` dispatches blocking work to a thread pool. When two
concurrent flight searches both called `os.environ.pop()` from different
threads, the underlying C `unsetenv()` function deadlocked — blocking the
entire asyncio event loop silently. The server accepted the request but
never responded, with no error or timeout in logs.

**Fix:** A single `threading.Lock` (`_env_lock`) wraps the env mutation +
`get_flights()` call in `tools/flights.py`, serializing the critical section
while still allowing all other tool calls to run in parallel.

**Symptoms of this bug:** Server appears to accept request (200 returned
immediately), but stream hangs forever. Lsof shows port 8000 open. No
exception in uvicorn logs. CPU pegged at 100% on one thread.

**Rule:** Any tool that mutates `os.environ` and may be called concurrently
MUST use a module-level `threading.Lock` around the mutation + the
side-effecting call it enables.

## 9. With Non-Reasoning Models, Output Volume Is the New Bottleneck

After switching from `grok-4.20-0309-reasoning` to `grok-4.20-0309-non-reasoning`,
TTFT dropped from 26-33s to 7-16s per round — but total E2E for hotels and
days stayed high because the LLM generates thousands of tokens of structured
JSON output (5-8 hotels × full schema; 3 days × 6+ activities × directions).

| Role | Reasoning E2E | Non-reasoning E2E | Bottleneck |
|------|--------------|-------------------|------------|
| plan | 48.6s | 36.1s | TTFT (fast now) |
| hotels | 66.3s | 65.8s | Token output volume (~42s generation in round 2) |
| days | 92.9s | 165.7s | Token output volume + tool call count (29 tools, 3 rounds) |

**Rule:** For roles that emit large JSON schemas, optimizing inference speed
gives diminishing returns after the first TTFT improvement. Future gains
require either: (a) reducing output schema size (strip redundant/optional
fields), (b) splitting output across multiple smaller responses, or (c)
streaming progressive rendering so the user sees results arrive token-by-token.

## 10. Per-Role Model Defaults Beat a Global Env Default

A single `LLM_MODEL` env var meant bench scripts, API callers, and fresh
installs all used whatever was in `.env` — often the reasoning model set
during testing. Browser users had a localStorage default that was already
correct, so they never felt the slowdown.

**Fix:** `ROLE_DEFAULT_MODELS` dict in `llm.py` maps each call_role to
`grok-4.20-0309-non-reasoning`. Model resolution order: explicit user choice
(Settings UI) > role default > global `LLM_MODEL`. This means the right
model is used regardless of `.env` unless the user explicitly overrides it.

## 12. Feature Rounds in This Project

| Round | Key Changes |
|-------|------------|
| 8-9 | 4-tab shell, inline editing, TTS, hotel-anchored days |
| 10 | PLAN rename, airport pins, globe zoom, compact form |
| 11 | pageSize fix, navigate buffer, PlanHistoryPanel |
| 12 | Seat class, alternate airports, undo/redo, theme |
| 13 | Export/import, hotel filters, drag reorder, activity swap |
| 14 | Templates, currency picker, help overlay |
| 15 | Cost summary, forecast strip, expand/collapse |
| 16 | Activity notes, shareable URLs, subtitle history |
| 17 | Print view, subtitle size, phrasebook |
| 18 | Weather hints, checklist, subtitle pause |
| 19 | ICS export, activity favorites |
| 20 | Favorites overlay, photo lightbox navigation |
| 21 | Scoped LLM calls (plan/hotels/days/chat roles), ROLE_DEFAULT_MODELS, thread-safety deadlock fix for parallel flight search, ETA progress bar |
