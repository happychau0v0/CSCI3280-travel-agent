# User Flow — AI Travel Agent

## Normal Happy Path

```
User fills PLAN form (origin, destination, dates, transport, party, interests)
         │
         ▼
[START PLANNING] → handleSend(prompt, { reset: true, callRole: "plan" })
         │
         ▼ backend: SYSTEM_PROMPT_PLAN
         │  tools: search_flights, geocode_city, get_day_windows, get_phrasebook
         │  output: itinerary.flight (full options array) + navigate_menu("FLIGHTS")
         │
         ▼ frontend navigates to FLIGHTS panel
User sees flight options → clicks [PICK]
         │
         ▼ handleSend("Selected flight: {label}. Now find hotels.", { callRole: "hotels" })
         │
         ▼ backend: SYSTEM_PROMPT_HOTELS
         │  Round 1: search_places("hotels in {city}") + get_weather (parallel)
         │  Round 2: emit itinerary.hotels (5 options) + navigate_menu("HOTELS")
         │
         ▼ frontend navigates to HOTELS panel
User sees hotel options → clicks [PICK]
         │
         ▼ handleSend("Staying at {hotel}. Build day plan.", { callRole: "days" })
         │
         ▼ backend: SYSTEM_PROMPT_DAYS
         │  Round 1: search_places for all days' activities + get_weather (parallel)
         │  Round 2: emit itinerary.days (full schedule) + navigate_menu("DAYS")
         │
         ▼ frontend navigates to DAYS panel
User reviews itinerary — done.
```

## Clarification Path (destination is a country or dates missing)

```
User types "australia" in DESTINATION (or leaves dates blank)
         │
         ▼ [START PLANNING] → handleSend(prompt, { reset: true, callRole: "plan" })
         │
         ▼ backend: SYSTEM_PROMPT_PLAN, CRITICAL check fires
         │  LLM calls: request_input("destination",
         │              "Which Australian city? (e.g. Sydney, Melbourne)")
         │  — does NOT call search_flights or emit JSON
         │
         ▼ frontend: PanelHome shows inline prompt below DESTINATION field
         │  DESTINATION field glows green, prompt text appears, SEND button shown
         │
User types "Sydney" → clicks [SEND →]
         │
         ▼ onResolveInput → handleSend("destination: Sydney", { callRole: "plan" })
         │  ← IMPORTANT: callRole:"plan" keeps this in SYSTEM_PROMPT_PLAN
         │    Without it, the full SYSTEM_PROMPT runs all 3 turns at once → jumps to DAYS
         │
         ▼ backend: SYSTEM_PROMPT_PLAN again, now destination is "Sydney"
         │  tools: search_flights(HKG, SYD, ...), geocode_city(Sydney), etc.
         │  output: flight options + navigate_menu("FLIGHTS")
         │
         ▼ (continues as normal happy path from FLIGHTS)
```

## Chat / Ad-hoc Changes

```
User presses Enter (or Cmd+K) → ChatPopover opens
         │
         ▼ handleSend(text, { callRole: "chat" })
         │
         ▼ backend: SYSTEM_PROMPT_CHAT
         │  tools: request_input, submit_trip_form, navigate_menu, toggle_setting
         │  — cannot search flights/hotels/activities
         │
Examples:
  "go to flights tab"  → navigate_menu("FLIGHTS")
  "change destination" → request_input("destination", "Where to?")
  "plan a new trip to Paris" → submit_trip_form(destination="Paris", ...)
         │                      → which triggers handleSend(prompt, { callRole: "plan" })
```

## Re-plan / Edit Flow

```
User clicks [REPLAN →] on PLAN panel with existing itinerary
         │
         ▼ handleSend(prompt, { reset: true, callRole: "plan" })
         │  reset:true clears currentItinerary + sends empty message history
         │  — starts fresh plan from scratch
         │
         ▼ (same as happy path)
```

## Key Wiring Points

| Event | callRole | System Prompt | Navigate Target |
|-------|----------|--------------|----------------|
| Start Planning button | `"plan"` | SYSTEM_PROMPT_PLAN | FLIGHTS |
| request_input resolution | `"plan"` | SYSTEM_PROMPT_PLAN | FLIGHTS |
| Flight picked | `"hotels"` | SYSTEM_PROMPT_HOTELS | HOTELS |
| Hotel picked | `"days"` | SYSTEM_PROMPT_DAYS | DAYS |
| Chat popover send | `"chat"` | SYSTEM_PROMPT_CHAT | varies |
| History overlay edit | `"chat"` | SYSTEM_PROMPT_CHAT | varies |

## Known Bugs Fixed

| Bug | Root Cause | Fix |
|-----|-----------|-----|
| Jumps to DAYS after country destination | `onResolveInput` called `handleSend` with no `callRole` → full SYSTEM_PROMPT ran all 3 turns | Pass `callRole: "plan"` in `onResolveInput` |
| LLM asks via text instead of request_input | SYSTEM_PROMPT_PLAN CRITICAL wasn't explicit enough | Added "NEVER ask via text — ALWAYS use request_input tool" |
| `[itinerary attached]` in subtitle | LLM mimicked `[itinerary data]` placeholder from history | Changed placeholder to `«itinerary»`, added strip regex |
