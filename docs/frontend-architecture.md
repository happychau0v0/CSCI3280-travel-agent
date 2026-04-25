# Frontend Architecture

> **Audience:** Developers maintaining or extending the frontend.  
> **Scope:** Component tree, data-flow, state management, and where to find
> things. For the backend contract (SSE events, tool calls, JSON schema) see
> [`docs/api.md`](api.md) and [`docs/reference.md`](reference.md).

---

## Directory layout

```
frontend/src/
├── App.jsx              # Root state-machine (2 200+ lines) — owns all
│                        # persistent state and wires every component
├── App.css              # Global layout: NieR-grid, panel-grid, overlays
├── index.css            # CSS variables (--bg, --accent, --text-dim, …)
├── main.jsx             # React 19 root render
│
├── api/
│   └── client.js        # fetch wrappers for /chat/stream, /status, /export, …
│
├── assets/              # Static assets (fonts, icons)
│
├── components/
│   ├── panels/          # Five full-screen panels (one per tab)
│   │   ├── PanelHome.jsx
│   │   ├── PanelFlights.jsx
│   │   ├── PanelHotels.jsx
│   │   ├── PanelDays.jsx
│   │   └── PanelExport.jsx
│   │
│   ├── AirportCombobox.jsx      # Searchable airport dropdown (IATA)
│   ├── ChatPopover.jsx          # Floating chat / voice input
│   ├── DayMiniMap.jsx           # Per-day Leaflet route map
│   ├── ErrorBanner.jsx          # Sticky dismissible error strip
│   ├── FavoritesOverlay.jsx     # Starred activities (F key)
│   ├── FooterHints.jsx          # Context-aware hotkey hints strip
│   ├── GlobeView.jsx            # 3-D globe (react-globe.gl) with arcs
│   ├── HelpOverlay.jsx          # Keyboard reference modal (? key)
│   ├── HighlightedText.jsx      # Substring-highlight utility
│   ├── HistoryOverlay.jsx       # Chat-turn history (H key)
│   ├── HotelsMap.jsx            # Leaflet hotel pin map
│   ├── MenuShell.jsx            # NieR outer chrome: tabs + footer
│   ├── PhotoGallery.jsx         # Hero + thumbnail carousel
│   ├── PlanHistoryPanel.jsx     # Right-column saved-trip list on HOME
│   ├── ServiceStatusOverlay.jsx # Service health (C key)
│   ├── SettingsOverlay.jsx      # Settings modal (S key)
│   ├── Subtitle.jsx             # TTS transcript strip
│   ├── TabStrip.jsx             # 1–5 panel tabs + agent spinner
│   ├── TripChecklist.jsx        # Pre-trip checklist (L key)
│   ├── VisaAlertBanner.jsx      # Inline visa warning on FLIGHTS
│   └── VoiceRecorder.jsx        # Web Speech API push-to-talk
│
├── hooks/
│   ├── useAudioCues.js          # Sound feedback (click, error, done)
│   ├── useGeolocation.js        # One-shot browser geolocation
│   ├── useKeyboard.js           # Global keydown router (scope-aware)
│   ├── useMenuState.js          # Tab + list index + side focus state
│   └── useSubtitleQueue.js      # TTS word-by-word subtitle queue
│
├── utils/
│   ├── cascadeTimes.js          # Re-derive activity start times after edits
│   └── exportKml.js             # Build KML string from itinerary
│
└── data/                        # (empty — static data lives in backend)
```

---

## Tab → panel mapping

| Tab key | Index | Panel component | Purpose |
|---------|-------|-----------------|---------|
| `1` | 0 | `PanelHome` | Trip form + plan history |
| `2` | 1 | `PanelFlights` | Flight selection |
| `3` | 2 | `PanelHotels` | Hotel selection + map |
| `4` | 3 | `PanelDays` | Day-by-day itinerary |
| `5` | 4 | `PanelExport` | PDF / KML export |

---

## Root state (`App.jsx`)

`App.jsx` is a single-file state machine. It owns every piece of state and
passes callbacks down via props — there is no global context or external store.

### Conversation state

| Variable | Type | Purpose |
|----------|------|---------|
| `messages` | `Message[]` | Full chat history sent to `/chat/stream` |
| `currentItinerary` | `Itinerary \| null` | Live planning result; merged incrementally as SSE events arrive |

### Planning phase state

| Variable | Type | Purpose |
|----------|------|---------|
| `agentState` | `"idle" \| "working" \| "done" \| "error"` | Controls spinner and button disabling |
| `dayStatuses` | `{[dayNum]: "pending"\|"loading"\|"done"\|"error"}` | Per-day progress in DAYS panel |
| `dayStartTimes` | `{[dayNum]: timestamp}` | Elapsed timer origin for each day query |

### Pending SSE-driven actions

When the LLM emits a tool call via SSE, App.jsx buffers the intent instead of
acting immediately — this prevents race conditions where the UI switches panels
before the itinerary data is merged:

| Variable | Triggered by SSE | Effect when consumed |
|----------|-----------------|---------------------|
| `pendingInputRequest` | `request_input` | Opens ChatPopover with the LLM's question |
| `pendingFormPrefill` | `submit_trip_form` | Shows prefill banner on HOME panel |
| `suggestedFlightIdx` | `pick_flight` | Highlights the suggested row in FLIGHTS |
| `suggestedHotelIdx` | `pick_hotel` | Highlights the suggested row in HOTELS |
| `pendingReplacement` | `replace_activity` | Shows preview card in DAYS before confirm |

### Persistence (localStorage)

| Key | Content | Read |
|-----|---------|------|
| `travel-itinerary` | Current itinerary JSON | On load |
| `travel-history` | `Itinerary[]` (max 20) | On load |
| `travel-favorites` | `FavoriteActivity[]` | On load |
| `travel-checklist` | `{dest: {item: bool}}` | Per open |
| `travel-currency` | `"HKD"\|"USD"\|…` | On load |
| `travel-theme` | `"dark"\|"light"` | On load |
| `travel-subtitle-size` | `"small"\|"medium"\|"large"` | On load |
| `travel-llm-model` | Model string | On load |
| `travel-prefs` | `Preferences` JSON | On load |
| `travel-muted` | `"true"\|"false"` | On load |

### Undo / redo

`undoStackRef` and `redoStackRef` are React refs (not state) holding up to 20
snapshots of `{selected_flight, selected_hotel}`. `pushPickSnapshot()` is
called before any pick action. `Ctrl+Z` / `Cmd+Z` pops undo; `Ctrl+Y` /
`Cmd+Shift+Z` pops redo. The counts are mirrored as state (`undoCount`,
`redoCount`) so the UI can re-render the undo/redo hint text.

---

## SSE streaming flow

```
POST /chat/stream
  │
  ├─ token           → streamingText (throttled 5/s via ref)
  ├─ thinking        → currentTool = "_thinking"
  ├─ tool_start      → currentTool = name; subtitle pushed
  ├─ tool_end        → toolTimings appended
  ├─ navigate        → buffered in pendingNavigateRef
  ├─ request_input   → pendingInputRequest; ChatPopover opens
  ├─ setting_change  → applies to state + localStorage
  ├─ submit_form     → pendingFormPrefill; navigate HOME
  ├─ pick_flight     → suggestedFlightIdx; navigate FLIGHTS
  ├─ pick_hotel      → suggestedHotelIdx; navigate HOTELS
  ├─ replace_activity→ queued in pendingChainedSendRef
  ├─ partial_itinerary→ currentItinerary merged (preview)
  └─ done            → finalize itinerary → flush navigate
                       → fallback navigate → save history
                       → agentState "done" → 1500ms → "idle"
```

---

## Panel layouts (`.panel-grid`)

Every panel uses a three-column CSS grid defined in `App.css`:

```
┌──────────────────────────────────────────────────┐
│                  TOP BAND                        │
├──────────────┬───────────────────┬───────────────┤
│  LEFT        │    CENTER         │  RIGHT        │
│  (list /     │  (globe / map /   │  (detail /    │
│   form)      │   background)     │   card)       │
├──────────────┴───────────────────┴───────────────┤
│                  BOTTOM BAND                     │
└──────────────────────────────────────────────────┘
```

The center column is usually occupied by `GlobeView` (rendered behind in
`App.jsx`) or by `HotelsMap` / `DayMiniMap` inside the panel itself.

`side` prop (`"left"` | `"right"`) reflects keyboard focus — the active
column gets `.side-focus-left` / `.side-focus-right` for highlight styling.

---

## Hotkey system

All hotkeys are wired through `useKeyboard.js`. The hook is disabled when any
overlay is open (`enabled` flag) and suppressed during text-input focus
(`isTypingField` guard).

### Global keys (always active when no overlay open)

| Key | Action |
|-----|--------|
| `1`–`5` | Navigate to panel 0–4 |
| `T`, `⌘K` | Open ChatPopover |
| `M` | Toggle TTS mute |
| `Q` (2 s hold) | Start new trip (reset + navigate HOME) |
| `Ctrl+Z` / `⌘Z` | Undo last pick |
| `Ctrl+Y` / `⌘⇧Z` | Redo pick |

### Overlay keys

| Key | Opens | Inner keys |
|-----|-------|------------|
| `H` | HistoryOverlay | `E` edit turn, `Esc` close |
| `S` | SettingsOverlay | `Esc` close |
| `?` | HelpOverlay | `Esc` close |
| `L` | TripChecklist | `Esc` close |
| `F` | FavoritesOverlay | `Esc` close |
| `C` | ServiceStatusOverlay | `R` re-probe, `Esc` close |

### In-panel keys

| Key | Action |
|-----|--------|
| `Tab` | Toggle left ↔ right focus column |
| `↑` / `↓` | Move list cursor |
| `Space` | Activate focused item |
| `Enter` | Confirm (pick / send) |

---

## Key components — props summary

### `PanelHome`

| Prop | Type | Purpose |
|------|------|---------|
| `value` | `FormState` | Controlled form values |
| `resetKey` | `number` | Increment to force form reset |
| `onPlan` | `(FormState) → void` | Called on START PLANNING |
| `pendingFormPrefill` | `FormState \| null` | LLM-suggested values; shows banner |
| `onAcceptPrefill` | `() → void` | User confirms prefill |

### `PanelFlights`

| Prop | Type | Purpose |
|------|------|---------|
| `itinerary` | `Itinerary` | Source of `flight.options` / `return_options` |
| `listIndex` | `number` | Currently highlighted row (controlled) |
| `currency` | `string` | Display currency — prices converted client-side |
| `visaAlert` | `VisaAlert \| null` | Rendered as inline banner in header |
| `suggestedIdx` | `number \| null` | Row highlighted by chat agent |
| `onPick` | `(idx, tab) → void` | User confirmed a flight |

### `PanelHotels`

| Prop | Type | Purpose |
|------|------|---------|
| `itinerary` | `Itinerary` | Source of `hotels[]` |
| `autoReplan` | `boolean` | If true, picking hotel immediately re-plans days |
| `onToggleAutoReplan` | `() → void` | Wired to `A` toggle in panel |
| `suggestedIdx` | `number \| null` | Row highlighted by chat agent |
| `onPick` | `(idx) → void` | User confirmed a hotel |

### `PanelDays`

| Prop | Type | Purpose |
|------|------|---------|
| `itinerary` | `Itinerary` | Source of `days[]`, `selected_hotel` |
| `favoriteKeys` | `Set<string>` | Starred activity keys (for ★ toggle) |
| `onToggleFavorite` | `(act) → void` | Save/remove from favorites |
| `pendingReplacement` | `ReplacementPreview \| null` | Chat-suggested swap |
| `onConfirmReplacement` | `() → void` | Apply pending replacement |
| `onCancelReplacement` | `() → void` | Dismiss pending replacement |

### `ChatPopover`

| Prop | Type | Purpose |
|------|------|---------|
| `open` | `boolean` | Visibility |
| `onSend` | `(text) → void` | Submit text to chat role |
| `options` | `string[]` | Quick-reply chips (from `request_input`) |
| `promptLabel` | `string \| null` | LLM question shown above input |
| `initialText` | `string` | Pre-filled text (e.g. from voice) |

---

## Currency conversion

Prices from the backend are always in **HKD**. The frontend converts at display
time using hardcoded rates in `SettingsOverlay.jsx`:

```js
const CURRENCY_TO_HKD = { HKD: 1, USD: 7.8, EUR: 8.4, JPY: 0.052, GBP: 9.9, CNY: 1.1 }
```

`formatDisplayPrice(hkdAmount, currency)` is exported from `SettingsOverlay`
and imported by every panel that shows a price. The rates are intentionally
static — they move < 2 % week-over-week and the flight estimator already has
a ±30 % confidence band that swallows any FX drift.

---

## Testing

| Layer | Command | Count | Coverage |
|-------|---------|-------|---------|
| Vitest unit | `npm test` | 57 tests | `cascadeTimes`, `useSubtitleQueue`, `mapUtils`, `useKeyboard` authority guards |
| Playwright E2E | `npm run test:e2e` | 5 spec files | Happy path, keyboard nav, overlays, small viewport, settings persistence |

Frontend tests live in `src/**/*.test.{js,jsx}`.  
E2E tests live in `e2e/*.spec.js` and run against `http://localhost:5173`.
