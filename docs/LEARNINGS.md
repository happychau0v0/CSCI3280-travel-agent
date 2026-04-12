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
documented in CLAUDE.md as a mandatory 9-step checklist.

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

## 8. Feature Rounds in This Project

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
