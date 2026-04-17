# LLM Role & Behavior Spec

> Source of truth for **what the LLM is expected to do** in the AI Travel
> Agent, extracted from `CLAUDE.md`, `backend/app/prompts.py`, and
> `docs/design.md`. Every requirement has a stable ID and a verification
> pointer (or is flagged GAP) so we can audit coverage at a glance.
>
> Last updated: 2026-04-17 — §6 contradictions resolved; Tier A+C+F verification pass complete.

---

## 1. Overview

**Persona:** Expert AI travel planning agent driving a NieR-style menu UI with
four tabs: PLAN → FLIGHTS → HOTELS → DAYS. Voice-first; every reply is read
aloud and shown as one short subtitle.
Source: `prompts.py:7`.

**Model:** OpenRouter-compatible. Default `x-ai/grok-4.20`; swap via
`LLM_MODEL` env var. Gemini fallback on region error (`llm.py` region-swap
logic).

**Two operating modes** (`prompts.py:9-30`):
- **CONVERSATION** — no tools, no JSON, one plain sentence. For greetings,
  smalltalk, vague curiosity with no concrete trip signal, meta questions
  about the app.
- **PLANNING** — tools + structured JSON, follows the 4-stage pipeline.
  Entered only when the user gives a concrete trip signal (specific
  destination, explicit action verb, follow-up to an existing trip).

**Pipeline (Call A → Call B → Call C):** `design.md:22-76`.
Each stage is a **single scoped LLM call** with its own system prompt, its
own tool allow-list, and an **empty conversation history** (only the one
structured user message goes in). This prevents cross-stage context leakage.
Chat is a **separate UI-control role** that never does data fetching itself.

---

## 2. Global Conventions (apply to every role)

Shorthand: `R-G-NNN` = global requirement.

| ID | Requirement | Source |
|---|---|---|
| R-G-001 | **No hallucination.** Never invent place names, addresses, ratings, opening hours, or prices. Always call a tool first. | `prompts.py:51`; `CLAUDE.md` "Key Conventions" |
| R-G-002 | **Tool-first for transport.** Never suggest transport between places without calling `get_directions` first. | `prompts.py:52` |
| R-G-003 | **Tool-first for weather.** Never state weather conditions without calling `get_weather` first. | `prompts.py:53` |
| R-G-004 | **Every reply has spoken text outside JSON.** Never reply with only a JSON block; the subtitle is what the user hears. | `prompts.py:42`, `:247`, `:312`, `:347`, `:493`, `:502`, `:536` |
| R-G-005 | **No markdown in reply text.** No bold / italic / backtick in the subtitle. | `prompts.py:46`, `:248`, `:313`, `:348`, `:494`, `:503`, `:537` |
| R-G-006 | **No bullet lists / paragraphs in reply text.** Details belong in the JSON; reply text is one short subtitle. | `prompts.py:45` |
| R-G-007 | **Do not narrate tool calls.** User doesn't need "Let me search for flights now…"; build silently. | `prompts.py:41`, `:245`, `:310`, `:345`, `:534` |
| R-G-008 | **`navigate_menu` at most once per turn, at the very end.** Never mid-stream. Turn 1 → `"FLIGHTS"`, Turn 2 → `"HOTELS"`, Turn 3 → `"DAYS"`. | `prompts.py:47`, `:231`, `:272`, `:324`, `:359` |
| R-G-009 | **Batch independent tool calls in one assistant message.** Tool loop caps at 20 rounds; batching halves wall-clock time. | `prompts.py:32-38`, `:242` |
| R-G-010 | **Honor injected USER LOCATION block** — treat as trip origin; never re-ask "where are you". | `prompts.py:55` |
| R-G-011 | **Honor injected TRIP DATES block** — use as flight date + per-day date; never re-ask "when?". | `prompts.py:56` |
| R-G-012 | **Honor injected USER PROFILE block** — incorporate interests, dislikes, dietary restrictions, budget into every recommendation. | `prompts.py:57` |
| R-G-013 | **Honor injected UI FORM STATE block** — do not call `request_input` for fields already filled unless the user asks to change them. | `prompts.py:226-228` |
| R-G-014 | **Prefer `request_input` over text questions** when a discrete value is needed (transport, destination, dates, party size, interests). | `prompts.py:48` |
| R-G-015 | **Subtitle length ≈ 10-25 words.** Punchy but informative. | `prompts.py:43-44`, `:246`, `:311`, `:346`, `:501`, `:535` |
| R-G-016 | **User-authority parity / no privilege escalation.** The LLM operates at the *same edit level as the user* — it assists by filling, suggesting, and navigating, but it **never commits an action on the user's behalf that requires a manual click in the UI**. Concretely: an LLM must not trigger a flight / hotel / day search without the user clicking the corresponding button. See the four sub-rules below. | design principle — enumerated in R-G-016a…d |
| R-G-016a | **Form pre-fill, not submit.** `submit_trip_form` pre-fills the PLAN form and navigates to HOME; it does **not** call `handleSend` or start Call A. The user clicks `START PLANNING` themselves. | `design.md:261`; `App.jsx:1764-1768` (`onFormPrefilled` only clears state and navigates) |
| R-G-016b | **Flight / hotel suggest, not select.** `pick_flight` / `pick_hotel` highlight a row with a "✦ Suggested" badge and navigate to FLIGHTS / HOTELS; they do **not** set `selected_flight` / `selected_hotel` or chain Call B / Call C. The user clicks `PICK`. | `design.md:260-261`; `App.jsx:1247-1272` (only `setSuggestedFlightIdx` / `setSuggestedHotelIdx` + navigate) |
| R-G-016c | **Activity replace preview, not commit.** `replace_activity` shows a CONFIRM / CANCEL inline preview via `pendingReplacement`; the replacement is applied only on user confirm. | `design.md:261`; `App.jsx:285` (`pendingReplacement` state), `:1273-1288` (queues replacement with user review) |
| R-G-016d | **Chat role cannot bypass the form.** Chat role's `ALLOWED_TOOLS_CHAT` excludes `search_flights`, `search_places`, `get_directions`, `get_weather`, `get_place_details`. Direct data-fetch is always delegated to the button pipeline. | `prompts.py:596-599`; system-prompt statement at `:419`; runtime filter at `llm.py:346-353` |

**Allowed direct actions** (these do NOT violate R-G-016 because the user
explicitly asked — "change currency to USD"): `toggle_setting`,
`navigate_menu`, `request_input`, `search_airports`. These are trivial UI
actions or read-only lookups the user can immediately reverse.

---

## 3. Per-Role Specs

The orchestrator dispatches to one of 7 role prompts via `call_role`. Each
role enforces its own tool allow-list (filtered in `llm.py:346-353`) and
drops prior conversation history (`llm.py:358-363`, except `chat`).

### 3.1 Role `plan` — Flight & route finder

**System prompt:** `SYSTEM_PROMPT_PLAN` (`prompts.py:240-299`).
**Tool allow-list (`ALLOWED_TOOLS_PLAN`, `prompts.py:586-589`):**
`search_flights`, `geocode_city`, `get_day_windows`, `get_phrasebook`,
`request_input`, `navigate_menu`.
**Trigger:** user clicks `START PLANNING` on PLAN panel (`design.md:82-105`).

| ID | Requirement | Source |
|---|---|---|
| R-PLAN-001 | If START DATE or END DATE is `[not set]`, call `request_input("start_date", …)` or `request_input("end_date", …)` and **STOP immediately** — no other tool calls, no JSON, no `navigate_menu`. | `prompts.py:251-264` |
| R-PLAN-002 | If destination is a country/region (Australia, Japan, UK, USA, Europe, Southeast Asia, China, …) or vague/missing, call `request_input("destination", …)` and STOP. A country is **never** a valid flight destination. | `prompts.py:255-259` |
| R-PLAN-003 | Never ask for missing info via reply text — always use `request_input`. | `prompts.py:260` |
| R-PLAN-004 | **MUST call** `search_flights(origin, destination, date, seat_class)` and `geocode_city(destination)`. | `prompts.py:267-268` |
| R-PLAN-005 | **MUST NOT call** `search_places`, `get_weather`, `get_place_details`. | `prompts.py:271` |
| R-PLAN-006 | **Origin / destination parsing:** extract only the IATA code from the `"Airport Name (IATA)"` label — pass just the 3-letter code to `search_flights`. | `prompts.py:82-86` |
| R-PLAN-007 | **Round-trip:** call `search_flights` **twice** in one batch — outbound with `return_date=end_date`, return with swapped origin/destination and `return_date=start_date`. Place outbound in `flight.options`, return in `flight.return_options`, set `flight.return_date`. | `prompts.py:274-282` |
| R-PLAN-008 | **Copy the entire `options` array verbatim** from `search_flights` — do not truncate or pick. | `prompts.py:284` |
| R-PLAN-009 | **Day-stub count:** emit exactly `(end_date − start_date).days + 1` day stubs. `days` array length MUST equal trip days — do not cap at 3. | `prompts.py:286-290` |
| R-PLAN-010 | **Output:** JSON block with `itinerary.origin`, `.destination`, `.local_transport_mode`, `.flight` (full options + coords + `return_options` if round-trip), `.days` (date stubs with `day` + `date`), `.party_size`, `.phrasebook`. | `prompts.py:292` |
| R-PLAN-011 | End with exactly one `navigate_menu("FLIGHTS")` call. | `prompts.py:272` |

### 3.2 Role `hotels` — Hotel finder

**System prompt:** `SYSTEM_PROMPT_HOTELS` (`prompts.py:301-335`).
**Tool allow-list (`ALLOWED_TOOLS_HOTELS`, `prompts.py:590-592`):**
`search_places`, `get_place_details`, `get_weather`, `navigate_menu`.
**Trigger:** user clicks `PICK` on FLIGHTS panel (`design.md:131-156`).

| ID | Requirement | Source |
|---|---|---|
| R-HOTELS-001 | **2 rounds only.** Round 1: `search_places + get_weather` batched. Round 2: final JSON + `navigate_menu`. Do NOT add a `get_place_details` round. | `prompts.py:303-307` |
| R-HOTELS-002 | **Destination must be the actual flight.to_city** — never the example city (Tokyo). Query: `search_places("hotels in <actual_destination_city>", location=<flight.to_lat>,<flight.to_lng>)`. | `prompts.py:316-321` |
| R-HOTELS-003 | **MUST call** `search_places` for hotels. | `prompts.py:321` |
| R-HOTELS-004 | **MUST NOT call** `get_place_details`, `search_flights`, `get_directions`, `request_input`. | `prompts.py:323` |
| R-HOTELS-005 | **Pick exactly 5 hotels** spanning price levels AND neighborhoods; only include `photo_url` (first photo), not the full photos array. | `prompts.py:326` |
| R-HOTELS-006 | **Output:** `itinerary.hotels[5]` with `photo_url`, `rating`, `price_level`, `lat`/`lng`, `place_id`; `itinerary.selected_hotel = null`; `itinerary.weather`. Do NOT re-emit `flight` or `days`. | `prompts.py:328` |
| R-HOTELS-007 | End with exactly one `navigate_menu("HOTELS")` call. | `prompts.py:324` |

### 3.3 Role `days` — Day planner & activity sequencer

**System prompt:** `SYSTEM_PROMPT_DAYS` (`prompts.py:337-405`).
**Tool allow-list (`ALLOWED_TOOLS_DAYS`, `prompts.py:593-595`):**
`search_places`, `get_place_details`, `get_directions`, `get_weather`,
`navigate_menu`.
**Trigger:** user clicks `PICK` on HOTELS panel (`design.md:183-214`).

| ID | Requirement | Source |
|---|---|---|
| R-DAYS-001 | **2 rounds only.** Round 1: batch ALL `search_places` + ALL `get_directions` + `get_weather`. Round 2: final JSON + `navigate_menu("DAYS")`. Do NOT add a 3rd round. | `prompts.py:339-342` |
| R-DAYS-002 | **MUST call** `search_places` per day, `get_directions` for every consecutive activity pair. | `prompts.py:351-356` |
| R-DAYS-003 | **MUST NOT call** `get_place_details`, `search_flights`, `request_input`. | `prompts.py:357-358` |
| R-DAYS-004 | **Time formula:** `next_start = current_start + current_duration_min + transit_duration_min`. Derive `transit_duration_min` from `get_directions` — never guess. Times strictly monotonic. | `prompts.py:361-365` |
| R-DAYS-005 | **Day 1 uses actual flight arrival_time** from conversation history — never the example `"11:35"`. Hotel check-in ≥ `arrival_time + 90 min`. | `prompts.py:367-372` |
| R-DAYS-006 | **Day 1 structure:** (1) `"{to_iata} Airport · Arrival"` at arrival_time (60 min); (2) hotel check-in ≥ arrival+90min (30 min); (3+) real activities; last: hotel return with `transport_to_next=null`. | `prompts.py:374-378` |
| R-DAYS-007 | **Last-day structure:** (1) hotel check-out 09:00 (30 min); (2+) real activities; last: `"{departure_iata} Airport · Departure"` (180 min). | `prompts.py:380-383` |
| R-DAYS-008 | **Middle days:** 09:00-21:00 window, pattern `[hotel depart, breakfast, sight, lunch, sight, dinner, hotel return]`, ≥3-4 real non-hotel activities including 1-2 meals, strictly monotonic times. | `prompts.py:385-387` |
| R-DAYS-009 | **Every non-hotel/airport activity** MUST have `place_id`, `lat`, `lng`, `address`, `photo_url` copied verbatim from `search_places`. Do NOT include the full `photos` array. | `prompts.py:390` |
| R-DAYS-010 | **Per-day weather required:** `{"temp": 22, "condition": "…", "humidity": 65}`. `temp` is a plain number — no degree symbol, no `"°C"` string. | `prompts.py:392` |
| R-DAYS-011 | **Activity descriptions** are 10-15 words, written from the LLM's own knowledge (conflicts with monolithic prompt R-MONO-002 below — see §6 "Contradictions"). | `prompts.py:391` |
| R-DAYS-012 | **Output:** `itinerary.selected_hotel` (the chosen hotel object) + `itinerary.days` (full days). Do NOT re-emit `flight` or `hotels`. | `prompts.py:395` |
| R-DAYS-013 | **Single-activity replacement:** still emit the COMPLETE `days` array with ALL days; only the affected day's activities change. | `prompts.py:396` |
| R-DAYS-014 | End with exactly one `navigate_menu("DAYS")` call. | `prompts.py:359` |

### 3.4 Role `chat` — UI control agent

**System prompt:** `SYSTEM_PROMPT_CHAT` (`prompts.py:407-473`).
**Tool allow-list (`ALLOWED_TOOLS_CHAT`, `prompts.py:596-599`):**
`request_input`, `submit_trip_form`, `navigate_menu`, `toggle_setting`,
`pick_flight`, `pick_hotel`, `replace_activity`, `search_airports`.
**Trigger:** user opens chat popover (T / Enter) (`design.md:218-281`).

| ID | Requirement | Source |
|---|---|---|
| R-CHAT-001 | **MUST NOT call** `search_flights`, `search_places`, `get_directions`, `get_weather`, `get_place_details`. Planning is always delegated to the button pipeline. | `prompts.py:419`; `design.md:237-240` |
| R-CHAT-002 | **Multi-airport cities** (Tokyo→NRT/HND, London→LHR/LGW/STN, NY→JFK/EWR/LGA): call `search_airports(query)` first, then `request_input("destination", …, options=[…])` with 2-4 top airports in `"Name (IATA)"` format. Extract the IATA from the trailing `"(XYZ)"`. Pass only the 3-letter code to `submit_trip_form`. | `prompts.py:422-430` |
| R-CHAT-003 | **Single-airport cities** (HKG, SIN, BKK, DXB, …): skip disambiguation, call `submit_trip_form` directly. | `prompts.py:432-433` |
| R-CHAT-004 | **All trips are round-trip.** No one-way mode. If the user has no return date and it's not in UI FORM STATE, call `request_input("end_date", …)` before `submit_trip_form`. | `prompts.py:435-438` |
| R-CHAT-005 | **`submit_trip_form` requires all four of** `destination` (IATA), `start_date` (YYYY-MM-DD), `end_date` (YYYY-MM-DD), `transport`. Check UI FORM STATE first; `request_input` for any missing. | `prompts.py:440-444` |
| R-CHAT-006 | **Relative dates MUST be computed from TODAY'S DATE.** "this Sunday", "next Friday", "in 3 days" → ISO dates. "N-day trip" → `end_date = start_date + (N-1)` days. Only `request_input` when the user gives NO date info. | `prompts.py:446-451` |
| R-CHAT-007 | **Suggest, don't execute** — `pick_flight`/`pick_hotel`/`replace_activity`/`submit_trip_form` highlight/pre-fill; the user still clicks PICK or START PLANNING. | `design.md:260-261` |
| R-CHAT-008 | Reply text is ONE short friendly sentence, no JSON, no markdown. | `prompts.py:472` |

### 3.5 Role `replace` — Single-activity replacer

**System prompt:** `SYSTEM_PROMPT_REPLACE` (`prompts.py:475-495`).
**Tool allow-list (`ALLOWED_TOOLS_REPLACE`, `prompts.py:600-602`):**
`search_places`.

| ID | Requirement | Source |
|---|---|---|
| R-REPLACE-001 | Call `search_places` **once** to find the replacement, passing the destination city as `location`. | `prompts.py:479` |
| R-REPLACE-002 | Pick the single best result; copy `place_id`, `lat`, `lng`, `address`, `photo_url` verbatim. | `prompts.py:480`, `:483` |
| R-REPLACE-003 | Use the **same** `time` and `duration_min` as the original activity unless the replacement is fundamentally different in type. If `duration_min` must change, keep the same start `time`. | `prompts.py:481-482` |
| R-REPLACE-004 | **MUST NOT** touch other activities, days, hotels, flights. **MUST NOT** call `navigate_menu`. | `prompts.py:485-486` |
| R-REPLACE-005 | **Output:** `{"itinerary": {"replace": {"day": N, "old_name": "...", "activity": {...}}}}` — single replace block, not a full `days` array. | `prompts.py:488-491` |
| R-REPLACE-006 | Short 10-15 word description written by the LLM (self-authored, not from a tool). | `prompts.py:484` |

### 3.6 Role `day_themes` — Trip theme planner (no tools)

**System prompt:** `SYSTEM_PROMPT_DAY_THEMES` (`prompts.py:497-525`).
**Tool allow-list:** `ALLOWED_TOOLS_DAY_THEMES = frozenset()` (empty;
`prompts.py:603`).

| ID | Requirement | Source |
|---|---|---|
| R-THEMES-001 | **No tools allowed.** Use own knowledge to assign themes + neighborhoods. | `prompts.py:497`, `:603` |
| R-THEMES-002 | **`days` array length MUST equal total trip days** stated in the prompt. | `prompts.py:506` |
| R-THEMES-003 | Each day's `suggested_areas` must be **geographically distinct** — no area name repeated across days. | `prompts.py:507` |
| R-THEMES-004 | Day 1 theme reflects limited afternoon time if arrival time given; last-day theme fits activities before departure if departure time given. | `prompts.py:508-509` |
| R-THEMES-005 | `key_constraints` only on days with a flight event. | `prompts.py:510` |
| R-THEMES-006 | `suggested_areas` = 3-5 specific neighborhood/district names — NOT generic ("downtown", "city center"). No hotels or airports. | `prompts.py:511-512` |

### 3.7 Role `day_detail` — Single-day activity planner

**System prompt:** `SYSTEM_PROMPT_DAY_DETAIL` (`prompts.py:527-582`).
**Tool allow-list (`ALLOWED_TOOLS_DAY_DETAIL`, `prompts.py:604-606`):**
`search_places`, `get_directions`, `get_weather`.

| ID | Requirement | Source |
|---|---|---|
| R-DETAIL-001 | **2 rounds only.** Round 1: batch ALL `search_places` (one per suggested area) + ALL `get_directions` (every consecutive pair) + `get_weather`. Round 2: final single-day JSON. | `prompts.py:529-531` |
| R-DETAIL-002 | **MUST call** `search_places` for EACH suggested area, `get_directions` for every consecutive activity pair. | `prompts.py:540-541` |
| R-DETAIL-003 | **`get_directions` `mode` MUST match transport mode** stated in the prompt: `transit → TRANSIT`, `driving → DRIVE`, `walking → WALK`, `mixed → TRANSIT`. Never omit `mode`. | `prompts.py:543-545` |
| R-DETAIL-004 | **MUST NOT** call `get_place_details`, `search_flights`, `request_input`, `navigate_menu`. | `prompts.py:547` |
| R-DETAIL-005 | Same time-formula, Day-1 / Last-day / Middle-day structure, activity-field, and weather rules as role `days` (R-DAYS-004 through R-DAYS-010). | `prompts.py:549-573` |
| R-DETAIL-006 | **Output:** exactly ONE day object in `itinerary.days`. | `prompts.py:575` |

### 3.8 Monolithic `SYSTEM_PROMPT` (legacy / fallback)

`SYSTEM_PROMPT` (`prompts.py:7-238`) is the pre-split single prompt that
covers all three planning turns. Kept for backwards compatibility when
`call_role` is not set. Notable legacy rules NOT repeated in the scoped
prompts:

| ID | Requirement | Source |
|---|---|---|
| R-MONO-001 | **Multi-stop flights:** fill `stop_cities` with intermediate IATA codes (e.g. `["BKK"]` for HKG→BKK→NRT). Leave `[]` for non-stop. | `prompts.py:93-95` |
| R-MONO-002 | **Activity descriptions MUST come from `get_place_details`** — never fabricated. If `get_place_details` returns no description, omit the field. (Conflicts with R-DAYS-011 which says the LLM writes from its own knowledge.) | `prompts.py:174-177` |
| R-MONO-003 | **Weather per day required** in monolithic path (same as R-DAYS-010). | `prompts.py:180-184` |
| R-MONO-004 | **Follow-up edits:** only re-emit the `days` array; preserve all unmodified days exactly; call `navigate_menu("DAYS")` at end. | `prompts.py:190-196` |

### 3.9 `BENCH_EVAL_ADDENDUM` (benchmark mode only)

Appended to the system content when `bench_eval=True` (`llm.py:343-344`,
`prompts.py:629-634`): LLM must produce a **single-response** itinerary with
flights + hotels + days combined; no `navigate_menu`, no `request_input`.

---

## 4. Pipeline Flow

```
USER FORM (PLAN panel)
       │  buildPrompt(form)  —  plain text w/ START DATE / END DATE / TRANSPORT / PARTY / INTERESTS / CABIN
       ▼
Scoped Call A   —  role="plan"    —  returns flight.options + day stubs           →  frontend navigates to FLIGHTS
       │  User picks outbound (and return for round-trip)
       ▼
Scoped Call B   —  role="hotels"  —  returns hotels[5] + weather                  →  frontend navigates to HOTELS
       │  User picks a hotel
       ▼
Scoped Call C   —  role="days"    —  returns selected_hotel + days[].activities    →  frontend navigates to DAYS
```

**Chat** runs in parallel to the above (role=`chat`), triggering these same
calls via `submit_trip_form` / `pick_flight` / `pick_hotel` /
`replace_activity`. It never performs data fetching itself.

**Runtime enforcement (shared across all scoped roles):**
- Tool allow-list filter: `llm.py:346-353` — scopes `TOOL_DEFINITIONS` to
  `ROLE_ALLOWED_TOOLS[call_role]`.
- Fresh context: `llm.py:358-363` — for `plan` / `hotels` / `days` /
  `day_themes` / `day_detail`, the LLM receives exactly 2 messages
  (system + one structured user message). `chat` keeps full history.
- `request_input` stopping rule: `llm.py:620-638` — if the batch includes
  `request_input`, only `request_input` + `submit_trip_form` run, then the
  loop breaks immediately; any concurrent `search_flights` / `navigate_menu`
  is dropped.
- Max loop rounds: `MAX_TOOL_ROUNDS = 20` (`llm.py`).

---

## 5. Output Schemas

Pydantic models in `prompts.py:637-812` validate every itinerary coming
back from the LLM. Key models:

| Model | Lines | Key fields |
|---|---|---|
| `TransportStep` | 640-644 | `mode`, `duration`, `distance` (polyline is fetched client-side, intentionally omitted) |
| `Activity` | 647-660 | `time`, `name`, `address`, `duration_min`, `description`, `place_id`, `photo_url`, `lat`, `lng`, `transport_to_next`, `user_note` (frontend-only) |
| `Weather` / `ForecastDay` | 679-700 | `temp` accepts float/int from API or `"22°C"` string from LLM (stripped via `_coerce_temp` at `:663-676`) |
| `Day` | 703-708 | `day`, `date`, `theme`, `weather`, `activities[]` |
| `FlightOption` | 711-731 | `stops`, `airline`, `flight_number`, `price_low/high`, `duration_min`, `departure_time`, `arrival_time`, `stop_cities[]` |
| `Flight` | 742-773 | `options[]`, `return_options[]`, `return_date`, `from_iata`/`to_iata`, coords, `seat_class` |
| `Hotel` | 776-784 | `name`, `address`, `rating`, `price_level`, `photo_url`, `lat`/`lng`, `place_id` |
| `Phrasebook` / `PhrasebookEntry` | 787-797 | `language`, `language_code`, `phrases[]` |
| `Itinerary` | 800-811 | top-level merge target — frontend merges additively |

Schema violations at extraction time are caught by `_extract_itinerary`
(`llm.py`) + Pydantic validation in the golden-output tests (§6).

---

## 6. Contradictions — all resolved (2026-04-17)

All four contradictions below were resolved via the decisions recorded
here. Kept for audit history; the current prompts / allow-lists reflect
these choices.

1. **Activity descriptions source (D1 → self-written).**
   Scoped prompts win: LLM writes 10-15 words from own knowledge
   (R-DAYS-011, R-DETAIL-005). Core facts (name / address / photo_url /
   coordinates) are still verbatim from `search_places`, so the
   no-hallucination rule (R-G-001) is preserved for every field the UI
   renders. R-MONO-002 (descriptions must come from `get_place_details`)
   applies only to the legacy monolithic path used by bench eval.

2. **`days` + `hotels` role `get_place_details` contradiction (D2 → tighten allow-list).**
   Removed `"get_place_details"` from both `ALLOWED_TOOLS_HOTELS` and
   `ALLOWED_TOOLS_DAYS` (`prompts.py:590-595`). Runtime filter now
   enforces what the scoped prompts already state. `design.md:151`
   updated to match. Rationale: `search_places` already returns
   `description`, `hours`, and `photos[]` (see `tools/places.py:93-126`);
   `get_place_details` uniquely adds only `reviews` and `website`, neither
   of which any Pydantic model (`Hotel`, `Activity`) accepts.

3. **Hotel count (D3 → 5-8).**
   `SYSTEM_PROMPT_HOTELS` updated from "exactly 5" to "5-8" at `:326` and
   `:328` output spec, matching the monolithic `SYSTEM_PROMPT:118`.

4. **`temp` format (D4 → plain number).**
   `SYSTEM_PROMPT:182` example fixed to `"temp": 22` (was `"22°C"`).
   Scoped prompts already emit a number. `_coerce_temp` at
   `prompts.py:663-676` retained as defensive fallback for legacy
   fixtures / replies.

---

## 7. Verification Coverage

Legend: **COVERED** = a test / runtime check asserts the requirement.
**PARTIAL** = partially covered (e.g., one role tested, others by parity but
not explicitly). **GAP** = no existing verification.

| ID | Status | Verified by |
|---|---|---|
| R-G-001 No hallucination | GAP | No test asserts the LLM doesn't invent places. Enforceable only via an LLM-judge eval or fact-check against tool results. |
| R-G-002 `get_directions` before transport | GAP | No test asserts `transport_to_next` only appears when a `get_directions` call was made. |
| R-G-003 `get_weather` before weather claim | GAP | Similar — no pre-condition test. |
| R-G-004 Spoken text outside JSON | GAP | No test asserts the reply contains non-JSON prose. |
| R-G-005 No markdown in reply | GAP | No test asserts reply is markdown-free. |
| R-G-006 No bullets/paragraphs in reply | GAP | — |
| R-G-007 Don't narrate tool calls | GAP | — |
| R-G-008 `navigate_menu` once, at end | PARTIAL | Runtime: `llm.py:556-557` emits `navigate` event; no test caps count or position. Playwright walkthrough step 3 observes the panel actually advances to FLIGHTS after START PLANNING (`CLAUDE.md:114-115`). |
| R-G-009 Batch tool calls | COVERED | `test_llm_loop.py::test_tools_run_in_parallel_via_gather` (`:44`). |
| R-G-010 Honor USER LOCATION | COVERED (by construction) | `llm.py` injects the block; `test_chat.py::test_format_preferences_renders_user_profile_block` checks injection. No test asserts the LLM doesn't re-ask. |
| R-G-011 Honor TRIP DATES | GAP | — |
| R-G-012 Honor USER PROFILE | PARTIAL | Injection verified by `test_chat.py::test_format_preferences_renders_user_profile_block`; LLM behavior not asserted. |
| R-G-013 Honor UI FORM STATE | PARTIAL | Injection in `llm.py:226-228`; LLM behavior not asserted. |
| R-G-014 Prefer `request_input` | GAP | — |
| R-G-015 Subtitle length ≈ 10-25 words | GAP | — |
| R-G-016 User-authority parity (umbrella) | PARTIAL | Enforced by construction via the four sub-rules below. No single test asserts the umbrella principle. |
| R-G-016a `submit_trip_form` pre-fills only | COVERED (by construction) | `App.jsx:1764-1768` — `onFormPrefilled` calls `setPendingFormPrefill(null)` + `menu.setPanel("HOME")`; does NOT call `handleSend`. **No regression test** — GAP on test. |
| R-G-016b `pick_flight` / `pick_hotel` suggest only | COVERED (by construction) | `App.jsx:1247-1260` / `:1261-1272` — only `setSuggested{Flight,Hotel}Idx` + navigate; does NOT mutate `selected_flight` / `selected_hotel` or chain Call B/C. **No regression test** — GAP on test. |
| R-G-016c `replace_activity` requires user confirm | COVERED (by construction) | `App.jsx:285` + `:903-904` + `:1273-1288` — replacement held in `pendingReplacement`; applied only on user accept. **No regression test** — GAP on test. |
| R-G-016d Chat cannot call data-fetch tools | COVERED | `test_role_allow_lists.py::test_role_uses_correct_tool_allow_list[chat]` asserts the 8-tool allow-list exactly; `search_flights`, `search_places`, `get_directions`, `get_weather`, `get_place_details` all absent. |
| R-PLAN-001 Missing-date → `request_input` + STOP | COVERED (runtime) | `test_request_input_stops.py::test_request_input_in_batch_skips_concurrent_tools` asserts the loop breaks and concurrent `search_flights` / `navigate_menu` are dropped when `request_input` is in the batch. Behavioral half (LLM chooses `request_input`) is still GAP. |
| R-PLAN-002 Country → `request_input` | GAP | — |
| R-PLAN-003 No text questions | GAP | — |
| R-PLAN-004 MUST call `search_flights` + `geocode_city` | GAP | No test asserts both fire. |
| R-PLAN-005 MUST NOT call `search_places` / `get_weather` / `get_place_details` | COVERED | `test_role_allow_lists.py::test_role_uses_correct_tool_allow_list[plan]` asserts the exact allow-list. |
| R-PLAN-006 IATA extraction | GAP | — |
| R-PLAN-007 Round-trip: two `search_flights` calls | COVERED (golden) | `test_itinerary_schema.py::TestGoldenTokyoFull` validates `flight.options` has ≥3 options with prices/times; no explicit round-trip golden fixture. **Round-trip-specific assertions = GAP.** |
| R-PLAN-008 Copy options verbatim | PARTIAL | `TestGoldenTokyoFull::test_flight_has_enough_options` (≥3) and `test_flight_options_have_prices` / `_have_times` cover fidelity indirectly. |
| R-PLAN-009 `days` count = trip_days | PARTIAL | `TestGoldenTaipeiSparse::test_days_match_trip_length` asserts length == 2 for a 2-day trip. Only one fixture; not exhaustive. |
| R-PLAN-010 Output shape | COVERED | `TestGoldenTokyoFull::test_pydantic_validates` + `_has_title_and_destination` + `_has_multiple_days` + `_phrasebook_present`. |
| R-PLAN-011 `navigate_menu("FLIGHTS")` at end | PARTIAL | Playwright walkthrough step 3 (`CLAUDE.md:115`) — real browser observes panel change. No unit test. |
| R-HOTELS-001 2-round cap | GAP | No test counts LLM rounds per role. |
| R-HOTELS-002 Destination = actual flight city | GAP | — |
| R-HOTELS-003 MUST call `search_places` | GAP | — |
| R-HOTELS-004 Allow-list (post-D2: `search_places`, `get_weather`, `navigate_menu`) | COVERED | `test_role_allow_lists.py::test_role_uses_correct_tool_allow_list[hotels]` + `test_hotels_allow_list_excludes_get_place_details`. |
| R-HOTELS-005 5-8 hotels (post-D3) | PARTIAL | `TestGoldenTokyoFull::test_has_enough_hotels` (≥3); upper bound 8 not asserted. GAP on neighborhood diversity. |
| R-HOTELS-006 Output shape | COVERED | `TestGoldenTokyoFull::test_hotels_have_required_fields`. |
| R-HOTELS-007 `navigate_menu("HOTELS")` | PARTIAL | Playwright step 5 (`CLAUDE.md:121`). |
| R-DAYS-001 2-round cap | GAP | — |
| R-DAYS-002 `search_places` + `get_directions` each pair | PARTIAL | `TestGoldenTokyoFull::test_middle_days_have_enough_activities` (≥4 mid-day) and indirectly `_activity_times_monotonic`. `get_directions` call count not asserted. |
| R-DAYS-003 Allow-list (post-D2: `search_places`, `get_directions`, `get_weather`, `navigate_menu`) | COVERED | `test_role_allow_lists.py::test_role_uses_correct_tool_allow_list[days]` + `test_days_allow_list_excludes_get_place_details`. |
| R-DAYS-004 Time formula + monotonic | COVERED (shape-level) | Pydantic `Day._activity_times_monotonic` validator (`prompts.py`) rejects any day with out-of-order activity times — blocks ingest of non-monotonic LLM output at parse time. `TestGoldenTokyoFull::test_activity_times_monotonic` covers the behavioral half. Transit-duration arithmetic still GAP. |
| R-DAYS-005 Day 1 actual arrival_time | GAP | No fixture pins a non-example arrival_time. |
| R-DAYS-006 Day 1 structure | GAP | — |
| R-DAYS-007 Last-day structure | GAP | — |
| R-DAYS-008 Middle-day pattern | PARTIAL | `test_middle_days_have_enough_activities` (≥4). Meal count / pattern order not asserted. |
| R-DAYS-009 Activity required fields | PARTIAL | Pydantic `Activity._place_fields_consistent` validator rejects any activity with `place_id` set but missing `lat`/`lng`. `photo_url` is not yet required — still GAP on that field. |
| R-DAYS-010 Weather shape | COVERED | Pydantic `Weather` model validates shape (`:691-700`); `_coerce_temp` handles both number and `"22°C"` string. |
| R-DAYS-011 Self-written description | GAP | — |
| R-DAYS-012 Output shape (no re-emit flight/hotels) | GAP | No test asserts absence. |
| R-DAYS-013 Complete `days[]` on single replace | GAP | Frontend-handled per `test_day_planning_roles.py:193-196` comment; no backend test. |
| R-DAYS-014 `navigate_menu("DAYS")` | PARTIAL | Playwright step 6 (`CLAUDE.md:128`). |
| R-CHAT-001 No planning tools | COVERED | `test_role_allow_lists.py::test_role_uses_correct_tool_allow_list[chat]` asserts the exact 8-tool allow-list; no data-fetch tools. |
| R-CHAT-002 Airport disambiguation | GAP | — |
| R-CHAT-003 Single-airport shortcut | GAP | — |
| R-CHAT-004 Always round-trip | GAP | — |
| R-CHAT-005 4 fields for `submit_trip_form` | GAP | — |
| R-CHAT-006 Relative date computation | GAP | — |
| R-CHAT-007 Suggest, don't execute | PARTIAL | `design.md:260-261` documents; frontend state vars (`suggestedFlightIdx` etc.) would need UI tests. Playwright walkthrough covers via PICK button flow. |
| R-CHAT-008 One-sentence reply | GAP | — |
| R-REPLACE-001 Single `search_places` call | PARTIAL | `test_role_allow_lists.py::test_role_uses_correct_tool_allow_list[replace]` asserts allow-list is exactly `{search_places}` — any other tool call is impossible at runtime. Call count (≤1 round) still not asserted. |
| R-REPLACE-002 Copy fields verbatim | GAP | — |
| R-REPLACE-003 Preserve `time` / `duration_min` | GAP | — |
| R-REPLACE-004 No navigate_menu | COVERED | `test_role_allow_lists.py::test_role_uses_correct_tool_allow_list[replace]` asserts allow-list excludes `navigate_menu`. |
| R-REPLACE-005 `replace` output shape | GAP | No golden fixture for replace output. |
| R-REPLACE-006 10-15 word description | GAP | — |
| R-THEMES-001 No tools | COVERED | `test_prompts_roles.py::test_day_themes_has_no_tools` + `test_day_planning_roles.py::test_day_themes_uses_empty_tool_list`. |
| R-THEMES-002 Day count matches trip | GAP | — |
| R-THEMES-003 Geographically distinct areas | GAP | — |
| R-THEMES-004 Day 1 / last-day theming | GAP | — |
| R-THEMES-005 `key_constraints` only on flight days | GAP | — |
| R-THEMES-006 Specific neighborhood names | GAP | — |
| R-DETAIL-001 2-round cap | GAP | — |
| R-DETAIL-002 search_places per area, directions per pair | GAP | — |
| R-DETAIL-003 Mode matches transport | GAP | — |
| R-DETAIL-004 Allow-list | COVERED | `test_prompts_roles.py::test_day_detail_allowed_tools` + `test_prompts_roles.py::test_day_detail_does_not_allow_navigate_menu` + `test_day_planning_roles.py::test_day_detail_allowed_tools`. |
| R-DETAIL-005 Day/time structure (inherits R-DAYS-*) | PARTIAL | Inherits R-DAYS-004 / R-DAYS-010 coverage. |
| R-DETAIL-006 Exactly one day in output | GAP | — |
| R-MONO-001 `stop_cities` for stops | GAP | — |
| R-MONO-002 Descriptions from `get_place_details` | GAP | Conflicts with R-DAYS-011 — see §6. |
| R-MONO-003 Per-day weather | COVERED | Via R-DAYS-010 Pydantic model coverage. |
| R-MONO-004 Follow-up edits preserve days | GAP | — |

**Cross-cutting runtime enforcement (not tied to a single requirement):**

| Mechanism | Lines | Covered by |
|---|---|---|
| Role-based tool filtering | `llm.py:346-353` | `test_role_allow_lists.py::test_role_uses_correct_tool_allow_list[*]` covers all 7 roles (plan / hotels / days / chat / replace / day_themes / day_detail). COVERED. |
| Fresh-context for scoped calls | `llm.py:358-363` | `test_role_allow_lists.py::test_scoped_role_drops_conversation_history[*]` covers all 5 scoped roles; `test_chat_role_preserves_full_history` covers the chat exception. COVERED. |
| `request_input` stopping rule | `llm.py:620-638` | `test_request_input_stops.py::test_request_input_in_batch_skips_concurrent_tools` + `::test_request_input_plus_submit_trip_form_both_run`. COVERED. |
| `MAX_TOOL_ROUNDS = 20` halt | `llm.py` | `test_llm_loop.py::test_max_tool_rounds_halts_runaway_loop`. |
| Region-error fallback to Gemini | `llm.py` | `test_llm_loop.py::test_region_error_swaps_to_fallback_model_on_round_zero`, `::test_is_region_error_recognises_common_phrasings`. |
| Gemini `thought_signature` preservation | `llm.py` | `test_llm_loop.py::test_gemini_thought_signature_is_preserved_in_history`, `::test_thought_signature_absent_when_not_in_model_extra`. |
| Itinerary extraction (fenced / bare / sanitized) | `_extract_itinerary`, `_sanitize_json` | `test_llm_loop.py::test_extract_itinerary_from_*`, `test_itinerary_schema.py::TestBadEscapes`, `::TestSanitizeJson`, `::TestExtractItineraryEdgeCases`. |
| Role default model override precedence | `llm.py` | `test_llm_loop.py::test_role_default_model_applies_when_no_preferred_model`, `::test_explicit_preferred_model_overrides_role_default`, `::test_role_default_overrides_global_llm_model`. |
| Bench-eval addendum injection | `llm.py:343-344` | `test_bench_eval.py` (per exploration). |

**Playwright real-browser walkthrough** (`CLAUDE.md:103-160`) covers the
observable end-to-end: PLAN form → FLIGHTS panel → HOTELS panel → DAYS
panel, plus overlay hotkeys and viewport overflow. It validates navigation
+ data rendering but does not assert prompt-level rules.

### Summary counts

After Tier A + C + F pass on 2026-04-17:

- **Total numbered requirements:** 69 (64 + R-G-016 umbrella + 4 sub-rules)
- **COVERED (explicit assertion):** 16 — R-G-009, R-PLAN-001 (runtime), R-PLAN-005, R-PLAN-010, R-HOTELS-004, R-HOTELS-006, R-DAYS-003, R-DAYS-004, R-DAYS-010, R-CHAT-001, R-REPLACE-004, R-THEMES-001, R-DETAIL-004, R-G-016d, R-MONO-003 — plus all 3 cross-cutting runtime mechanisms (tool filter, fresh-context, request_input stop).
- **PARTIAL:** ~18 — held by construction (R-G-016a/b/c frontend invariants), golden-fixture shape checks, or one-half-of-two-halves (R-DAYS-009 coord check but not photo_url).
- **GAP:** ~35 — dominated by behavioral prompt-following rules (no-hallucination, no-markdown, no-narration, relative-date math, airport disambiguation). These need Tier B (golden fixtures) or Tier E (LLM-judge eval).

**Remaining highest-leverage gaps** (in priority order):

1. **Round-trip golden fixture** (Tier B) — LLM output with `flight.return_options` populated + assertion that `len(flight.return_options) ≥ 2` and `flight.return_date` is set. Closes R-PLAN-007.
2. **Day-1 arrival & last-day departure fixtures** (Tier B) — one fixture each with non-example `arrival_time` / `departure_time`; assert `activities[0].name` ends with "Airport · Arrival" AND times line up with the flight schedule. Closes R-DAYS-005/006/007.
3. **R-G-016a/b/c regression tests** (Tier D) — frontend component tests that `onFormPrefilled` doesn't call `handleSend`, `pick_flight` SSE leaves `selected_flight` untouched, `replace_activity` routes through `pendingReplacement`. The invariant is held by easily-broken bits of `App.jsx`.
4. **`day_themes` output fixture** (Tier B) — covers R-THEMES-002/003/005/006 with a validator that asserts distinct areas, `len(days) == trip_days`, `key_constraints` only where arrival_time/departure_time present.
5. **LLM-judge eval harness** (Tier E) — needed for R-G-001 (no hallucination: every place name must appear in a tool result), R-G-004/005/006/007 (narration / markdown / subtitle rules), R-CHAT-002/003/004/005/006 (chat behavioral rules). Biggest infra commitment.
