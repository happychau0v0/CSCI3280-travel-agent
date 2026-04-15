import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from "react";
import ErrorBanner from "./components/ErrorBanner";
import MenuShell from "./components/MenuShell";
import Subtitle from "./components/Subtitle";
import ChatPopover from "./components/ChatPopover";
import HistoryOverlay from "./components/HistoryOverlay";
import SettingsOverlay, {
  loadTheme,
  applyTheme,
  loadCurrency,
  loadSubtitleSize,
  applySubtitleSize,
  loadLlmModel,
} from "./components/SettingsOverlay";

import HelpOverlay from "./components/HelpOverlay";
import TripChecklist from "./components/TripChecklist";
import FavoritesOverlay from "./components/FavoritesOverlay";
import ServiceStatusOverlay from "./components/ServiceStatusOverlay";
import PanelHome from "./components/panels/PanelHome";
import PanelFlights from "./components/panels/PanelFlights";
import PanelHotels from "./components/panels/PanelHotels";
import PanelDays from "./components/panels/PanelDays";
import PanelExport from "./components/panels/PanelExport";
import { IATA_TO_ISO2 } from "./data/countries";
import { streamChat, API_BASE } from "./api/client";
import { useGeolocation } from "./hooks/useGeolocation";
import { useMenuState } from "./hooks/useMenuState";
import { useKeyboard } from "./hooks/useKeyboard";
import { useSubtitleQueue } from "./hooks/useSubtitleQueue";
import { useAudioCues } from "./hooks/useAudioCues";
import "./App.css";

// Lazy-load the globe so the Three.js bundle doesn't block first paint.
const GlobeView = lazy(() => import("./components/GlobeView"));

// IATA → [lat, lng] for resolving stop cities on the globe.
// Derived from backend/app/tools/airports.py.
const IATA_COORDS = {
  AMS: [52.3105, 4.7683],  ATH: [37.9364, 23.9445],  ATL: [33.6407, -84.4277],
  AUH: [24.4330, 54.6511], BKK: [13.6900, 100.7501],  BOM: [19.0896, 72.8656],
  BOS: [42.3656, -71.0096], CDG: [49.0097, 2.5479],   CGK: [-6.1256, 106.6558],
  CPH: [55.6181, 12.6561], DEL: [28.5562, 77.1000],   DEN: [39.8561, -104.6737],
  DFW: [32.8998, -97.0403], DOH: [25.2731, 51.6080],  DXB: [25.2532, 55.3657],
  EWR: [40.6925, -74.1687], FCO: [41.8003, 12.2389],  FRA: [50.0379, 8.5622],
  GRU: [-23.4356, -46.4731], HEL: [60.3172, 24.9633], HKG: [22.3080, 113.9185],
  HND: [35.5494, 139.7798], IAD: [38.9531, -77.4565], IAH: [29.9844, -95.3414],
  ICN: [37.4602, 126.4407], IST: [41.2753, 28.7519],  JFK: [40.6413, -73.7781],
  KIX: [34.4347, 135.2440], KUL: [2.7456, 101.7099],  LAX: [33.9416, -118.4085],
  LHR: [51.4700, -0.4543],  LIM: [-12.0219, -77.1143], LIS: [38.7813, -9.1359],
  MAD: [40.4719, -3.5626],  MEX: [19.4361, -99.0719],  MIA: [25.7959, -80.2870],
  MNL: [14.5086, 121.0194], MUC: [48.3538, 11.7861],  MXP: [45.6306, 8.7281],
  NBO: [-1.3192, 36.9278],  NRT: [35.7720, 140.3929],  ORD: [41.9742, -87.9073],
  OSL: [60.1939, 11.1004],  PEK: [40.0801, 116.5846],  PVG: [31.1443, 121.8083],
  SEA: [47.4502, -122.3088], SFO: [37.6213, -122.3790], SGN: [10.8188, 106.6519],
  SIN: [1.3644, 103.9915],  SVO: [55.9726, 37.4146],   SYD: [-33.9399, 151.1753],
  TPE: [25.0777, 121.2328], VIE: [48.1102, 16.5697],   YVR: [49.1967, -123.1815],
  YYZ: [43.6777, -79.6248], ZRH: [47.4647, 8.5492],
};

const STATE_KEY = "travel-chat-state";
const TRIP_DATES_KEY = "travel-trip-dates";
const PLAN_HISTORY_KEY = "travel-plan-history";
const PLAN_HISTORY_MAX = 20;
const FAVORITES_KEY = "travel-favorites";
const AUTO_REPLAN_KEY = "travel-auto-replan";

// Subtitle-line narration for each tool the LLM can call. Pushed onto
// the subtitle queue when a tool_start event arrives so the user sees
// concrete progress instead of a frozen "working" indicator.
const TOOL_NARRATIONS = {
  search_flights: "Searching flights…",
  search_places: "Looking up places…",
  get_place_details: "Fetching place details…",
  get_directions: "Routing the next leg…",
  get_weather: "Checking the weather…",
  geocode_city: "Locating the city…",
  navigate_menu: "Switching panels…",
  request_input: "Awaiting your input…",
  web_search: "Searching the web…",
};

function loadState() {
  try {
    const raw = localStorage.getItem(STATE_KEY);
    if (!raw) return { messages: [], itinerary: null };
    const parsed = JSON.parse(raw);
    return {
      messages: Array.isArray(parsed.messages) ? parsed.messages : [],
      itinerary: parsed.itinerary || null,
    };
  } catch {
    return { messages: [], itinerary: null };
  }
}

function saveState(messages, itinerary) {
  try {
    localStorage.setItem(STATE_KEY, JSON.stringify({ messages, itinerary }));
  } catch {
    /* ignore */
  }
}

function loadTripDates() {
  try {
    const raw = localStorage.getItem(TRIP_DATES_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function loadFormDates() {
  try {
    const raw = localStorage.getItem("travel-trip-form");
    if (!raw) return null;
    const p = JSON.parse(raw);
    return p.start_date && p.end_date ? { start_date: p.start_date, end_date: p.end_date } : null;
  } catch {
    return null;
  }
}

function loadFavorites() {
  try {
    const raw = localStorage.getItem(FAVORITES_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveFavorites(favorites) {
  try {
    localStorage.setItem(FAVORITES_KEY, JSON.stringify(favorites));
  } catch {
    /* ignore */
  }
}

function loadPlanHistory() {
  try {
    const raw = localStorage.getItem(PLAN_HISTORY_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function savePlanHistory(history) {
  try {
    localStorage.setItem(PLAN_HISTORY_KEY, JSON.stringify(history));
  } catch {
    /* ignore — quota exceeded, stale state still in memory */
  }
}

// Build a lightweight plan history entry from a finished itinerary.
// Returns null if the itinerary is missing essential fields (destination).
function buildHistoryEntry(itinerary, messages) {
  if (!itinerary?.destination) return null;
  const days = itinerary.days || [];
  return {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    created_at: Date.now(),
    destination: itinerary.destination,
    origin: itinerary.origin || null,
    start_date: itinerary.flight?.date || days[0]?.date || null,
    end_date: days[days.length - 1]?.date || null,
    day_count: days.length,
    itinerary,
    messages: Array.isArray(messages) ? messages : [],
  };
}

// ---------------------------------------------------------------------------
// Activity time cascade helpers — imported from utils/cascadeTimes.js
// ---------------------------------------------------------------------------
import { cascadeActivityTimes } from "./utils/cascadeTimes";

// ---------------------------------------------------------------------------

function App() {
  const initial = loadState();
  const [messages, setMessages] = useState(initial.messages);
  const [currentItinerary, setCurrentItinerary] = useState(initial.itinerary);
  // dayStatuses tracks loading/error state per day number during two-phase planning.
  // Key: day number (1-based), Value: "pending" | "loading" | "done" | "error"
  const [dayStatuses, setDayStatuses] = useState({});
  const setDayStatus = (dayNum, status) =>
    setDayStatuses((prev) => ({ ...prev, [dayNum]: status }));
  const [planHistory, setPlanHistory] = useState(() => loadPlanHistory());
  const [favorites, setFavorites] = useState(() => loadFavorites());
  const favoriteKeys = useMemo(() => new Set(favorites.map((f) => f.key)), [favorites]);
  const [isLoading, setIsLoading] = useState(false);
  const [preferences, setPreferences] = useState(null);
  const [error, setError] = useState(null);
  const [muted, setMuted] = useState(false);
  // Auto-replan toggle: when ON (default), picking a hotel triggers
  // an LLM day-replan. When OFF, the pick is purely local — useful
  // for users who want to manually plan their days.
  const [autoReplan, setAutoReplan] = useState(() => {
    try {
      const raw = localStorage.getItem(AUTO_REPLAN_KEY);
      return raw === null ? true : raw === "true";
    } catch {
      return true;
    }
  });
  const toggleAutoReplan = useCallback(() => {
    setAutoReplan((prev) => {
      const next = !prev;
      try { localStorage.setItem(AUTO_REPLAN_KEY, String(next)); } catch { /* quota or private-mode — ignore */ }
      return next;
    });
  }, []);
  const [chatPopoverOpen, setChatPopoverOpen] = useState(false);
  const [chatPopoverInitial, setChatPopoverInitial] = useState("");
  const [chatPopoverPromptLabel, setChatPopoverPromptLabel] = useState("");
  const [chatPopoverOptions, setChatPopoverOptions] = useState(null);
  // Streaming text: accumulates LLM tokens as they arrive so the user sees
  // text within ~200ms of the first token, not after the full LLM round.
  const [streamingText, setStreamingText] = useState("");
  const streamTokenBufRef = useRef("");   // raw token accumulator
  const streamDisplayTimerRef = useRef(null); // throttle timer (max 5 updates/s)
  // Overlay state — HISTORY (H key) and SETTINGS (S key) replace the
  // dedicated tabs in the round-8.5 redesign.
  const [historyOpen, setHistoryOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [checklistOpen, setChecklistOpen] = useState(false);
  const [favoritesOpen, setFavoritesOpen] = useState(false);
  const [statusOpen, setStatusOpen] = useState(false);
  // Visa alert — fetched from /visa/check when the user reaches FLIGHTS panel.
  const [visaAlert, setVisaAlert] = useState(null);
  // Activity cursor for DAYS right-side keyboard navigation.
  // Resets to 0 when the selected day changes.
  const [activityIndex, setActivityIndex] = useState(0);
  // Agent status — drives the TabStrip indicator and isLoading guard
  const [agentState, setAgentState] = useState("idle"); // idle|working|done|error
  const [currentTool, setCurrentTool] = useState(null);
  // Per-request tool timing data collected from tool_end SSE events
  const [toolTimings, setToolTimings] = useState([]); // [{name, elapsed_ms}]
  const requestStartedAtRef = useRef(null); // Date.now() when request begins
  const [pendingInputRequest, _setPendingInputRequest] = useState(null);
  // OBJ3 — LLM can pre-fill the trip form and auto-trigger planning
  const [pendingFormPrefill, setPendingFormPrefill] = useState(null);
  // Tracks the in-flight done→idle setTimeout so a new request can
  // cancel it before it overwrites the new "working" state (B6).
  const idleTimerRef = useRef(null);
  // Tracked setTimeout for auto-reopen-chat-on-question so a new
  // request (or a re-edit) cancels the pending reopen before it
  // fires. Without this, pressing PLAN again while an auto-reopen
  // is queued would briefly pop the popover then slam it shut.
  const autoReopenTimerRef = useRef(null);
  // Round 11 — buffer the LLM's navigate_menu target until the
  // `done` event fires with the final itinerary. Without this,
  // the backend fires the navigate event mid-stream (during the
  // navigate_menu tool_start), which yanks the user to an empty
  // HOTELS panel before the itinerary data has landed.
  const pendingNavigateRef = useRef(null);
  // Chained send queued by pick_flight/pick_hotel/replace_activity SSE handlers.
  // Fired AFTER the current stream's done event to avoid concurrent-request races.
  const pendingChainedSendRef = useRef(null);
  // Set to true when hotel search is started in the background while the user is
  // still picking their return flight. Prevents the done event from auto-navigating
  // to HOTELS until the return flight has been picked.
  const suppressHotelNavRef = useRef(false);
  // Replace-activity context: set when user clicks REPLACE, consumed by ChatPopover onSend.
  const pendingReplaceRef = useRef(null);
  // Guard against double-invocation of planDaysActivities (e.g. hotel pick fires
  // while a previous planning run is still in-flight).
  const isPlanningDaysRef = useRef(false);
  // Round 12 — undo / redo stacks for user-driven picks
  // (selected_flight and selected_hotel only). Each entry is a
  // {selected_flight, selected_hotel} snapshot taken BEFORE a pick
  // is applied, so Ctrl+Z reverts to the previous state.
  const undoStackRef = useRef([]);
  const redoStackRef = useRef([]);
  const [undoCount, setUndoCount] = useState(0);
  const [redoCount, setRedoCount] = useState(0);
  // Per-panel imperative handle: panels with actionable rows expose
  // an `activateRow(index)` method via ref. App.jsx's onActivate
  // (Space hotkey) reads the current panel's ref and invokes it.
  const activeRowDispatchRef = useRef(null);
  // Ref mirror so handleSend's running invocation can read the
  // post-stream value of pendingInputRequest without being trapped
  // by its useCallback closure (B4). Updated SYNCHRONOUSLY inside
  // the setter wrapper, NOT via a useEffect — the effect would only
  // run after React commits, which is too late for code that reads
  // the ref later in the same synchronous tick (e.g. the auto-reopen
  // check that fires immediately after a request_input event sets
  // the value mid-stream).
  // Ref that always holds the latest itinerary so handleSend can read a
  // fresh value without adding currentItinerary to its dep array (which
  // would cause the callback to be recreated on every streaming token).
  const currentItineraryRef = useRef(currentItinerary);
  useEffect(() => { currentItineraryRef.current = currentItinerary; }, [currentItinerary]);

  const pendingInputRequestRef = useRef(null);
  const setPendingInputRequest = useCallback((value) => {
    pendingInputRequestRef.current = value;
    _setPendingInputRequest(value);
  }, []);
  const tripDates = loadTripDates(); // edited via PanelProfile in the future
  const { location: userLocation, requestPermission } = useGeolocation();
  const menu = useMenuState();
  const [currency, setCurrency] = useState(() => loadCurrency());
  const [llmModel, setLlmModel] = useState(() => loadLlmModel());
  const [theme, setTheme] = useState(() => loadTheme());
  const subtitles = useSubtitleQueue({ muted });
  const cues = useAudioCues({ muted });

  // Compute the size of the active panel's left list so the keyboard
  // hook can clamp ↑/↓ navigation.
  const listSize = useMemo(() => {
    switch (menu.state.panel) {
      case "HOME":
        return 7; // origin, destination, start, end, transport, party, interests
      case "FLIGHTS":
        return currentItinerary?.flight?.options?.length || 0;
      case "HOTELS":
        return currentItinerary?.hotels?.length || 0;
      case "DAYS":
        return currentItinerary?.days?.length || 0;
      default:
        return 0;
    }
  }, [menu.state.panel, currentItinerary]);

  // Find the most recent user message text (used by E hotkey + ↑ recall)
  const lastUserMessage = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "user") return messages[i].content;
    }
    return null;
  }, [messages]);

  // HISTORY overlay's E shortcut: edit a specific turn. Stash the
  // target index so handleSend's truncateBefore option can do the
  // truncation atomically with the new send (avoids the double-
  // truncation bug where pre-truncating + editLast=true would drop
  // additional turns).
  const editTurnIdxRef = useRef(null);
  // Tracks the last tool narration spoken so we don't repeat the same
  // status line ("Looking up places…") on consecutive calls to the same tool.
  const lastSpokenToolLabelRef = useRef(null);
  const handleEditTurn = useCallback((idx, text) => {
    if (idx < 0) return;
    editTurnIdxRef.current = idx;
    setChatPopoverInitial(text);
    setHistoryOpen(false);
    setChatPopoverOpen(true);
  }, []);

  // SETTINGS → "clear all data" handler. Wipes conversation, itinerary
  // and trip form, leaves preferences alone.
  const handleClearAll = useCallback(() => {
    try {
      localStorage.removeItem(STATE_KEY);
      localStorage.removeItem(TRIP_DATES_KEY);
      localStorage.removeItem("travel-trip-form");
      localStorage.removeItem(PLAN_HISTORY_KEY);
    } catch {
      /* ignore */
    }
    setMessages([]);
    setCurrentItinerary(null);
    setError(null);
    setPlanHistory([]);
    menu.reset();
  }, [menu]);

  // Round 12 — undo/redo helpers for flight + hotel picks. Declared
  // BEFORE useKeyboard so the hook's deps array doesn't TDZ on them.
  // Only user-driven selections are tracked; LLM replans don't push a
  // new undo entry.
  const pushPickSnapshot = useCallback(() => {
    const snap = {
      selected_flight: currentItinerary?.selected_flight || null,
      selected_hotel: currentItinerary?.selected_hotel || null,
    };
    undoStackRef.current.push(snap);
    if (undoStackRef.current.length > 20) undoStackRef.current.shift();
    redoStackRef.current = [];
    setUndoCount(undoStackRef.current.length);
    setRedoCount(0);
  }, [currentItinerary]);

  const handleUndoPick = useCallback(() => {
    if (undoStackRef.current.length === 0) return;
    const current = {
      selected_flight: currentItinerary?.selected_flight || null,
      selected_hotel: currentItinerary?.selected_hotel || null,
    };
    const prev = undoStackRef.current.pop();
    redoStackRef.current.push(current);
    setUndoCount(undoStackRef.current.length);
    setRedoCount(redoStackRef.current.length);
    setCurrentItinerary((ci) => (ci ? { ...ci, ...prev } : ci));
    cues.tick?.();
  }, [currentItinerary, cues]);

  const handleRedoPick = useCallback(() => {
    if (redoStackRef.current.length === 0) return;
    const current = {
      selected_flight: currentItinerary?.selected_flight || null,
      selected_hotel: currentItinerary?.selected_hotel || null,
    };
    const next = redoStackRef.current.pop();
    undoStackRef.current.push(current);
    setUndoCount(undoStackRef.current.length);
    setRedoCount(redoStackRef.current.length);
    setCurrentItinerary((ci) => (ci ? { ...ci, ...next } : ci));
    cues.tick?.();
  }, [currentItinerary, cues]);

  // Cue audio on cursor moves and tab switches
  const setPanelWithCue = useCallback(
    (panel) => {
      cues.select();
      menu.setPanel(panel);
    },
    [cues, menu],
  );
  const setListIndexWithCue = useCallback(
    (index) => {
      cues.tick();
      menu.setListIndex(index);
    },
    [cues, menu],
  );
  // Mouse click on a list item: move the cursor to the clicked row.
  const selectListItem = useCallback(
    (index) => {
      cues.tick();
      menu.setListIndex(index);
    },
    [cues, menu],
  );

  // Document-level hotkeys. Disabled while an overlay is open so the
  // overlay can own its own keyboard handling without leaking events.
  useKeyboard({
    state: menu.state,
    setPanel: setPanelWithCue,
    setListIndex: setListIndexWithCue,
    setSide: menu.setSide,
    listSize,
    activityListSize: currentItinerary?.days?.[menu.state.listIndex]?.activities?.length || 0,
    activityIndex,
    setActivityIndex,
    onOpenChat: () => {
      cues.select();
      setChatPopoverInitial("");
      setChatPopoverPromptLabel("");
      setChatPopoverOptions(null);
      setChatPopoverOpen(true);
    },
    onActivate: () => {
      cues.select();
      if (isLoading) return;
      const panel = menu.state.panel;
      const idx = menu.state.listIndex;
      // Space key activates the current row — pick flight or hotel
      if (panel === "FLIGHTS") {
        const opt = currentItinerary?.flight?.options?.[idx];
        const alreadyPicked = currentItinerary?.selected_flight &&
          (currentItinerary.selected_flight === opt ||
           currentItinerary.selected_flight?.airline === opt?.airline);
        if (opt && !alreadyPicked) {
          pushPickSnapshot();
          setCurrentItinerary({
            ...currentItinerary,
            selected_flight: opt,
            hotels: undefined,
            selected_hotel: null,
            days: undefined,
          });
          cues.chime();
          const label = [
            opt.airline,
            opt.departure_time && opt.arrival_time
              ? `${opt.departure_time}→${opt.arrival_time}` : null,
            opt.price_low ? `HK$${opt.price_low}` : null,
          ].filter(Boolean).join(", ");
          handleSend(`Selected flight: ${label}. Now find hotels in ${currentItinerary?.destination}.`);
        }
        return;
      }
      if (panel === "HOTELS") {
        const hotel = currentItinerary?.hotels?.[idx];
        if (hotel) {
          pushPickSnapshot();
          setCurrentItinerary({ ...currentItinerary, selected_hotel: hotel, days: undefined });
          cues.chime();
          handleSend(
            `Set "${hotel.name}" as the base hotel in ${currentItinerary?.destination}. ` +
            `Flight arrives ${currentItinerary?.flight?.arrival_time} at ${currentItinerary?.flight?.to_iata} on ${currentItinerary?.flight?.date}. ` +
            `Plan the day-by-day itinerary with activities, meals, and directions.`,
          );
        }
        return;
      }
      // Fallback: dispatch to panel's row activator (HOME form rows)
      const dispatch = activeRowDispatchRef.current;
      if (dispatch) dispatch(idx);
    },
    onBack: () => {
      if (chatPopoverOpen) {
        setChatPopoverOpen(false);
      }
    },
    onToggleMute: () => setMuted((m) => !m),
    onOpenHistory: () => {
      cues.select();
      setHistoryOpen(true);
    },
    onOpenSettings: () => {
      cues.select();
      setSettingsOpen(true);
    },
    onUndo: handleUndoPick,
    onRedo: handleRedoPick,
    onOpenHelp: () => setHelpOpen(true),
    onOpenPrint: () => menu.setPanel("EXPORT"),
    onOpenChecklist: () => setChecklistOpen(true),
    onOpenFavorites: () => setFavoritesOpen(true),
    onOpenStatus: () => { cues.select(); setStatusOpen(true); },
    enabled: !historyOpen && !settingsOpen && !helpOpen && !checklistOpen && !favoritesOpen && !statusOpen,
  });

  // Persist messages + itinerary
  useEffect(() => {
    saveState(messages, currentItinerary);
  }, [messages, currentItinerary]);

  // Reset activity cursor when the selected day changes on the DAYS panel.
  useEffect(() => {
    setActivityIndex(0);
  }, [menu.state.listIndex]);

  // Visa alert — check visa requirements when the user reaches the FLIGHTS panel.
  // Uses IATA_TO_ISO2 to convert the destination airport code to a country ISO-2,
  // then calls /visa/check with the user's passport (from preferences, default HK).
  // Clears whenever the destination airport changes (new plan).
  useEffect(() => {
    if (menu.state.panel !== "FLIGHTS") return;
    const toIata = currentItinerary?.flight?.to_iata;
    if (!toIata) { setVisaAlert(null); return; }

    const destIso2 = IATA_TO_ISO2[toIata];
    if (!destIso2) { setVisaAlert(null); return; }

    const passport = preferences?.passport_country || "HK";

    // Same country as passport — no alert needed
    if (destIso2 === passport) { setVisaAlert(null); return; }

    fetch(`${API_BASE}/visa/check?destination=${destIso2}&passport=${passport}`)
      .then((r) => r.json())
      .then((data) => setVisaAlert(data))
      .catch(() => setVisaAlert(null));
  }, [menu.state.panel, currentItinerary?.flight?.to_iata, preferences?.passport_country]);

  // Round 12 — apply the persisted theme on mount so the page
  // opens in the user's last-chosen palette without a flash.
  // Round 17 — same for subtitle size.
  useEffect(() => {
    applyTheme(loadTheme());
    applySubtitleSize(loadSubtitleSize());
  }, []);

  // Round 16 — check for a #plan=… hash on first mount; if one is
  // present, decode the base64 JSON and import it into history +
  // load it as the current itinerary so shared links "just work".
  useEffect(() => {
    try {
      const hash = window.location.hash || "";
      const match = hash.match(/plan=([^&]+)/);
      if (!match) return;
      const b64 = decodeURIComponent(match[1]);
      const json = decodeURIComponent(escape(atob(b64)));
      const parsed = JSON.parse(json);
      if (!parsed?.itinerary?.destination) return;
      // Strip the hash so a reload doesn't re-import
      window.history.replaceState(null, "", window.location.pathname + window.location.search);
      const fresh = {
        id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        created_at: Date.now(),
        destination: parsed.destination,
        origin: parsed.origin,
        start_date: parsed.start_date,
        end_date: parsed.end_date,
        day_count: parsed.day_count,
        itinerary: parsed.itinerary,
        messages: [],
      };
      setPlanHistory((prev) => {
        const next = [fresh, ...prev].slice(0, PLAN_HISTORY_MAX);
        savePlanHistory(next);
        return next;
      });
      setCurrentItinerary(fresh.itinerary);
    } catch {
      /* ignore malformed hashes */
    }
  }, []);

  // Expose internal state to a window-level debug object so the
  // Playwright test can probe state without relying on CSS class
  // heuristics. Updated on every render via a tiny effect. No-op
  // in production builds (the test uses dev server).
  useEffect(() => {
    if (typeof window === "undefined") return;
    window.__debug = {
      menuState: menu.state,
      agentState,
      currentTool,
      pendingInputRequest,
      historyOpen,
      settingsOpen,
      helpOpen,
      checklistOpen,
      favoritesOpen,
      favorites,
      chatPopoverOpen,
      muted,
      messages,
      itinerary: currentItinerary,
      selectedFlight: currentItinerary?.selected_flight || null,
      selectedHotel: currentItinerary?.selected_hotel || null,
      subtitleCurrent: subtitles.current,
      // idleTimerRef.current is a setTimeout id (number) when the
      // 1500ms done→idle countdown is queued, and null otherwise.
      // The hardened test reads this to verify B6: a new request
      // should clear the previous timer (idleTimerActive flips false
      // at the start of the next handleSend).
      idleTimerActive: idleTimerRef.current != null,
      // Round 10 — Playwright probes this after HOTELS/DAYS panel
      // switches to confirm the globe was told to fly in toward
      // the destination. null on HOME/FLIGHTS, {lat, lng, altitude}
      // otherwise.
      globeFocus,
      planHistory,
      undoCount,
      redoCount,
    };
  });

  // Round 11 — plan history handlers.
  // Save whenever the LLM emits an itinerary that meaningfully
  // differs from the last snapshot (destination changed OR the
  // last save was more than 10 minutes ago).
  const saveCurrentPlanToHistory = useCallback(
    (itinerary, msgSnapshot) => {
      const entry = buildHistoryEntry(itinerary, msgSnapshot);
      if (!entry) return;
      setPlanHistory((prev) => {
        const last = prev[0];
        const DEDUPE_WINDOW_MS = 10 * 60 * 1000;
        if (
          last &&
          last.destination === entry.destination &&
          Date.now() - last.created_at < DEDUPE_WINDOW_MS
        ) {
          // Replace the most recent entry instead of adding a new
          // one — this happens during replan round-trips on the
          // same trip.
          const next = [entry, ...prev.slice(1)].slice(0, PLAN_HISTORY_MAX);
          savePlanHistory(next);
          return next;
        }
        const next = [entry, ...prev].slice(0, PLAN_HISTORY_MAX);
        savePlanHistory(next);
        return next;
      });
    },
    [],
  );

  const loadPlanFromHistory = useCallback(
    (id) => {
      setPlanHistory((prev) => {
        const entry = prev.find((p) => p.id === id);
        if (!entry) return prev;
        setCurrentItinerary(entry.itinerary);
        setMessages(entry.messages || []);
        return prev;
      });
    },
    [],
  );

  const deletePlanFromHistory = useCallback((id) => {
    setPlanHistory((prev) => {
      const next = prev.filter((p) => p.id !== id);
      savePlanHistory(next);
      return next;
    });
  }, []);

  // Round 13 — accept a plan entry imported from a .json file drop.
  // The file is parsed in PlanHistoryPanel and passed here as the
  // already-validated entry object.
  const importPlanEntry = useCallback((entry) => {
    if (!entry?.itinerary?.destination) return;
    // Rewrite id + created_at so imports don't collide with the
    // user's existing local plans and always sort to the top.
    const fresh = {
      ...entry,
      id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      created_at: Date.now(),
    };
    setPlanHistory((prev) => {
      const next = [fresh, ...prev].slice(0, PLAN_HISTORY_MAX);
      savePlanHistory(next);
      return next;
    });
  }, []);

  function buildThemeMessage(itinerary) {
    const { destination, flight, days } = itinerary;
    const totalDays = days?.length ?? 0;
    const arrivalTime = itinerary.selected_flight?.arrival_time ?? "unknown";
    const arrivalIata = flight?.to_iata ?? "";
    const returnFlight = flight?.return_options?.[0];
    const departureTime = returnFlight?.departure_time ?? null;
    const departureIata = flight?.from_iata ?? arrivalIata;
    const lastDate = days?.[totalDays - 1]?.date ?? "";

    let msg = `Plan themes for a ${totalDays}-day trip to ${destination}. `;
    msg += `Day 1 (${days?.[0]?.date ?? ""}): flight arrives at ${arrivalTime} at ${arrivalIata}. `;
    if (departureTime) {
      msg += `Day ${totalDays} (${lastDate}): flight departs at ${departureTime} from ${departureIata}. `;
    } else {
      msg += `Day ${totalDays} (${lastDate}): departure day — plan a morning before the airport. `;
    }
    msg += `Assign each day a distinct geographic theme and 3-5 specific neighborhood names to focus on.`;
    return msg;
  }

  function buildDayDetailMessage(day, itinerary) {
    const { destination, selected_hotel, days } = itinerary;
    const totalDays = days?.length ?? 0;
    const hotel = selected_hotel;
    const areas = day.suggested_areas?.join(", ") ?? destination;

    let msg = `Plan activities for Day ${day.day} of ${totalDays} (${day.date}) in ${destination}. `;
    msg += `Theme: ${day.theme}. Focus areas: ${areas}. `;
    msg += `Base hotel: ${hotel?.name} at lat ${hotel?.lat}, lng ${hotel?.lng}. `;

    if (day.key_constraints?.arrival_time) {
      msg += `Flight arrives at ${day.key_constraints.airport_iata} at ${day.key_constraints.arrival_time} — first activity must be airport arrival. `;
    }
    if (day.key_constraints?.departure_time) {
      msg += `Flight departs ${day.key_constraints.airport_iata} at ${day.key_constraints.departure_time} — plan to finish activities 3 hours before. `;
    }
    return msg.trim();
  }

  async function planOneDayDetail(day, itinerary) {
    setDayStatus(day.day, "loading");
    const message = buildDayDetailMessage(day, itinerary);
    let delay = 2000;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const result = await streamChat({
          message,
          preferences,
          userLocation,
          tripDates,
          llmModel,
          callRole: "day_detail",
        });
        if (result?.itinerary?.days?.length) {
          setCurrentItinerary((prev) => {
            if (!prev) return prev;
            const incoming = result.itinerary.days;
            const updatedMap = new Map(incoming.map((d) => [d.day, d]));
            const merged = (prev.days ?? []).map((d) => updatedMap.get(d.day) ?? d);
            return { ...prev, days: merged };
          });
          setDayStatus(day.day, "done");
          return;
        }
      } catch (err) {
        if (err?.message?.includes("429") && attempt < 2) {
          await new Promise((r) => setTimeout(r, delay));
          delay *= 2;
          continue;
        }
      }
      break;
    }
    setDayStatus(day.day, "error");
  }

  function handleRetryDay(day) {
    const snap = currentItineraryRef.current;
    if (snap) planOneDayDetail(day, snap);
  }

  async function planDaysActivities(itinerary) {
    if (isPlanningDaysRef.current) return;
    isPlanningDaysRef.current = true;
    try {
      // Reset all day statuses to pending before starting.
      const initial = {};
      (itinerary.days ?? []).forEach((d) => { initial[d.day] = "pending"; });
      setDayStatuses(initial);

      // Phase 1: theme pass — assign each day a theme + suggested areas.
      let themedItinerary = itinerary;
      try {
        const themesResult = await streamChat({
          message: buildThemeMessage(itinerary),
          preferences,
          userLocation,
          tripDates,
          llmModel,
          callRole: "day_themes",
        });
        if (themesResult?.itinerary?.days?.length) {
          const themeMap = new Map(
            (themesResult.itinerary.days ?? []).map((d) => [d.day, d])
          );
          setCurrentItinerary((prev) => {
            const merged = (prev?.days ?? []).map((d) => ({
              ...d,
              ...(themeMap.get(d.day) ?? {}),
            }));
            return { ...(prev ?? {}), days: merged };
          });
          themedItinerary = {
            ...itinerary,
            days: (itinerary.days ?? []).map((d) => ({
              ...d,
              ...(themeMap.get(d.day) ?? {}),
            })),
          };
        }
      } catch {
        // Theme pass failed — continue without themes (detail queries use destination only).
      }

      // Phase 2: per-day detail queries, sliding window of CONCURRENCY=7.
      // Requests dispatched in day order so earlier days display first.
      const days = themedItinerary.days ?? [];
      const CONCURRENCY = 7;
      const promises = [];
      for (let i = 0; i < days.length; i++) {
        if (i >= CONCURRENCY) await promises[i - CONCURRENCY];
        promises.push(planOneDayDetail(days[i], themedItinerary));
      }
      await Promise.all(promises);

      setPanelWithCue("DAYS");
    } finally {
      isPlanningDaysRef.current = false;
    }
  }

  const handleSend = useCallback(
    async (text, { editLast = false, truncateBefore = null, reset = false, callRole = null } = {}) => {
      const userMsg = { role: "user", content: text };

      // New trip from the PLAN page: wipe the previous itinerary and
      // conversation so stale Busan/wherever data doesn't bleed into the
      // new Taipei trip while the agent is working.
      if (reset) {
        setCurrentItinerary(null);
      }

      // Edit-and-rerun: truncate the conversation back to before a
      // specific turn (truncateBefore) or before the most recent user
      // turn (editLast) so the agent responds to the edited prompt as
      // if the original never happened. truncateBefore wins when both
      // are set — it's used by the HISTORY overlay's per-turn edit.
      let baseMessages = reset ? [] : messages;
      if (truncateBefore != null && truncateBefore >= 0) {
        baseMessages = messages.slice(0, truncateBefore);
      } else if (editLast) {
        let idx = -1;
        for (let i = messages.length - 1; i >= 0; i--) {
          if (messages[i].role === "user") {
            idx = i;
            break;
          }
        }
        if (idx >= 0) baseMessages = messages.slice(0, idx);
      }
      // Strip ```json…``` itinerary blocks from assistant messages before
      // sending history to the LLM. A full 3-day itinerary can be 5,000+
      // tokens — re-sending it on every follow-up turn inflates the context
      // window and adds 10-20s of LLM inference time compared to the
      // benchmark (which always starts with empty history). The LLM's system
      // prompt already tells it to emit only the current turn's fields and
      // that the frontend merges additively, so it doesn't need to re-read
      // its own JSON output from prior turns. The short narrative sentence
      // after the JSON (the spoken subtitle) is preserved for context.
      const history = baseMessages.map((m) => {
        if (m.role !== "assistant") return { role: m.role, content: m.content };
        const trimmed = m.content.replace(/```json[\s\S]*?```/g, "«itinerary»");
        return { role: m.role, content: trimmed };
      });

      setMessages([...baseMessages, userMsg]);
      setIsLoading(true);
      setError(null);

      // ── Immediate "received" feedback. The user sees something
      // happening within ~16ms of pressing send, which is the most
      // important responsiveness fix in round 8. The status bar
      // appears, the subtitle confirms what was sent, and a tick
      // cue plays.
      // Cancel any stale done→idle timer from a previous request so it
      // doesn't fire mid-stream and flicker the banner back to idle (B6).
      if (idleTimerRef.current) {
        clearTimeout(idleTimerRef.current);
        idleTimerRef.current = null;
      }
      // Also cancel any pending auto-reopen-chat timer so a rapid
      // second send doesn't re-pop the popover mid-flight.
      if (autoReopenTimerRef.current) {
        clearTimeout(autoReopenTimerRef.current);
        autoReopenTimerRef.current = null;
      }
      setAgentState("working");
      setCurrentTool(null);
      requestStartedAtRef.current = Date.now();
      setToolTimings([]);
      subtitles.clear();
      // Reset streaming text state for this request.
      streamTokenBufRef.current = "";
      clearTimeout(streamDisplayTimerRef.current);
      streamDisplayTimerRef.current = null;
      setStreamingText("");
      lastSpokenToolLabelRef.current = null; // reset dedup on every new request
      const preview = text.length > 60 ? text.slice(0, 57) + "…" : text;
      // Echo the user's own message as a visible subtitle but DO NOT
      // read it back via TTS (R9-A2). `spoken: false` displays the
      // line without triggering speechSynthesis.speak().
      subtitles.push(`▸ ${preview}`, { spoken: false });
      cues.tick();

      try {
        const data = await streamChat({
          message: text,
          history,
          preferences,
          userLocation,
          tripDates,
          llmModel,
          callRole,
          onEvent: ({ type, data: payload }) => {
            if (type === "token") {
              // Accumulate tokens; throttle React state update to max 5/s so
              // we don't trigger hundreds of re-renders during fast generation.
              streamTokenBufRef.current += payload.text || "";
              if (!streamDisplayTimerRef.current) {
                streamDisplayTimerRef.current = setTimeout(() => {
                  streamDisplayTimerRef.current = null;
                  // Strip JSON fences before displaying — the LLM emits the
                  // itinerary block first, subtitle sentence after. Without
                  // stripping, raw JSON scrolls through the subtitle bar live.
                  // Two passes: first removes closed fences, second removes
                  // an open fence that's still being generated (no closing ```).
                  const buf = streamTokenBufRef.current
                    .replace(/```json[\s\S]*?```/g, "")
                    .replace(/```json[\s\S]*/g, "")
                    .trim();
                  setStreamingText(buf.length > 150 ? "…" + buf.slice(-147) : buf);
                }, 200);
              }
            } else if (type === "thinking") {
              // LLM is about to generate — clear the previous tool name so
              // the status bar shows "AGENT WORKING · Thinking…" during the
              // silent pre-token phase (can be 3-5s for Grok-4.20).
              setCurrentTool("_thinking");
            } else if (type === "tool_start") {
              cues.bloop();
              const tool = payload?.name || payload?.tool;
              if (tool) {
                setCurrentTool(tool);
                // Push a friendly narration so the user sees progress
                // in the subtitle bar in addition to the status banner.
                const label = TOOL_NARRATIONS[tool];
                if (label) {
                  // Speak the narration the first time this label appears;
                  // subsequent identical labels (same tool called again) are
                  // display-only so the voice doesn't loop "Looking up places…".
                  const alreadySpoken = lastSpokenToolLabelRef.current === label;
                  if (!alreadySpoken) lastSpokenToolLabelRef.current = label;
                  subtitles.push(label, { spoken: !alreadySpoken });
                }
              }
            } else if (type === "tool_end") {
              const name = payload?.name || payload?.tool;
              const elapsed = payload?.elapsed_ms;
              if (name && elapsed != null) {
                setToolTimings(prev => [...prev, { name, elapsed_ms: elapsed }]);
              }
            } else if (type === "navigate") {
              // Round 11 — buffer instead of applying immediately.
              // The backend fires this during the navigate_menu
              // tool_start, which arrives BEFORE the `done` event
              // with the final itinerary. If we applied the nav
              // here, the user would land on an empty HOTELS
              // panel during loading. Flush in the done branch.
              pendingNavigateRef.current = payload;
            } else if (type === "request_input") {
              // The LLM is asking for a clarifying question. Flag the
              // pending request for PanelHome field tracking, then open
              // ChatPopover with the question visible — keeping the user
              // on their current panel instead of force-navigating to HOME.
              setPendingInputRequest(payload);
              if (payload?.prompt) {
                setChatPopoverPromptLabel(payload.prompt);
                setChatPopoverOptions(payload.options?.length ? payload.options : null);
                setChatPopoverInitial("");
                setChatPopoverOpen(true);
                subtitles.push(payload.prompt);
              }
              cues.select();
            } else if (type === "setting_change") {
              // OBJ3 — LLM toggled a UI setting directly.
              const { setting, value } = payload || {};
              if (setting === "tts_enabled") {
                // muted is the inverse of tts_enabled
                setMuted(!value);
              } else if (setting === "theme") {
                applyTheme(value);
                try { localStorage.setItem("travel-theme", value); } catch { /**/ }
              } else if (setting === "currency") {
                setCurrency(value);
                try { localStorage.setItem("travel-currency", value); } catch { /**/ }
              } else if (setting === "subtitle_size") {
                applySubtitleSize(value);
                try { localStorage.setItem("travel-subtitle-size", value); } catch { /**/ }
              } else if (setting === "auto_replan") {
                setAutoReplan(value);
              }
              subtitles.push(`Setting "${setting}" updated.`);
            } else if (type === "submit_form") {
              // OBJ3 — LLM wants to pre-fill the trip form and start planning.
              // Always switch to HOME so the user sees the form being filled.
              if (menu.state.panel !== "HOME") menu.setPanel("HOME");
              const prefill = payload?.prefill || {};
              if (Object.keys(prefill).length > 0) {
                setPendingFormPrefill(prefill);
              }
              subtitles.push("Filling in your trip details...");
            } else if (type === "pick_flight") {
              // Chat mode — LLM picked a flight on the user's behalf.
              // Queue the hotels replan to fire AFTER this stream's done event
              // to avoid concurrent-request races.
              const { label, index } = payload || {};
              const opts = currentItineraryRef.current?.flight?.options;
              const opt = label
                ? opts?.find(
                    (o) =>
                      o.label === label ||
                      o.airline?.toLowerCase() === label?.toLowerCase(),
                  )
                : opts?.[index ?? 0];
              if (opt) {
                pushPickSnapshot();
                setCurrentItinerary((prev) => ({ ...prev, selected_flight: opt }));
                cues.chime();
                const lbl = [
                  opt.airline,
                  opt.departure_time && opt.arrival_time
                    ? `${opt.departure_time}→${opt.arrival_time}`
                    : null,
                  opt.price_low ? `HK$${opt.price_low}` : null,
                ]
                  .filter(Boolean)
                  .join(", ");
                pendingChainedSendRef.current = {
                  text: `Selected flight: ${lbl}. Now find hotels in ${currentItineraryRef.current?.destination}.`,
                  opts: { callRole: "hotels" },
                };
              }
            } else if (type === "pick_hotel") {
              // Chat mode — LLM picked a hotel on the user's behalf.
              // Queue the days replan to fire AFTER this stream's done event.
              const { name, index } = payload || {};
              const hotels = currentItineraryRef.current?.hotels;
              const hotel = name
                ? hotels?.find(
                    (h) => h.name?.toLowerCase() === name?.toLowerCase(),
                  )
                : hotels?.[index ?? 0];
              if (hotel) {
                pushPickSnapshot();
                setCurrentItinerary((prev) => ({
                  ...prev,
                  selected_hotel: hotel,
                }));
                cues.chime();
                // Trigger two-phase day planning after this stream completes.
                pendingChainedSendRef.current = {
                  __planDays: true,
                  hotel,
                };
              }
            } else if (type === "replace_activity") {
              // Chat mode — LLM wants to replace a day activity.
              // Queue the days replan to fire AFTER this stream's done event.
              const { day, activity_name, query } = payload || {};
              const dest = currentItineraryRef.current?.destination || "the destination";
              // Look up the original activity to pass its timing to the LLM.
              const origDay = currentItineraryRef.current?.days?.find((d) => d.day === day);
              const origAct = origDay?.activities?.find((a) => a.name === activity_name);
              const timeContext =
                origAct?.time
                  ? ` Original activity time: ${origAct.time}, duration: ${origAct.duration_min ?? 60} min. Keep the same start time and duration unless the replacement logically requires otherwise.`
                  : "";
              const q = query
                ? `Day ${day}, replace "${activity_name}" with: ${query}. Destination city: ${dest}.${timeContext}`
                : `Day ${day}, replace "${activity_name}" with a different but similar place in ${dest}.${timeContext}`;
              pendingChainedSendRef.current = { text: q, opts: { callRole: "replace" } };
            } else if (type === "partial_itinerary") {
              // Progressive disclosure — show raw tool results before the LLM
              // finishes generating its closing text. The `done` event's final
              // itinerary will overwrite these previews seamlessly.
              setCurrentItinerary((prev) => {
                const next = { ...(prev || {}) };
                if (payload.flight) {
                  next.flight = { ...(prev?.flight || {}), ...payload.flight };
                }
                if (payload.hotels) {
                  // Keep LLM-confirmed hotels (no _preview flag); append fresh previews
                  const confirmed = (prev?.hotels || []).filter((h) => !h._preview);
                  const ids = new Set(confirmed.map((h) => h.place_id).filter(Boolean));
                  const fresh = payload.hotels.filter((h) => !ids.has(h.place_id));
                  next.hotels = [...confirmed, ...fresh];
                }
                return next;
              });
              // Intentionally no panel navigation here — partial_itinerary
              // updates data progressively but never changes the active panel
              // while the agent is working. Navigation fires once, at done.
            }
          },
        });
        if (!data) throw new Error("Stream ended without a response");
        // Clear streaming display — the subtitle queue takes over with TTS.
        clearTimeout(streamDisplayTimerRef.current);
        streamDisplayTimerRef.current = null;
        streamTokenBufRef.current = "";
        setStreamingText("");
        const assistantMsg = { role: "assistant", content: data.reply };
        setMessages((prev) => [...prev, assistantMsg]);
        if (data.itinerary) {
          // Surgical single-activity replacement: the replace role emits
          // {"replace": {"day": N, "old_name": "...", "activity": {...}}}
          // instead of the full days array. Swap only the matching activity.
          if (data.itinerary.replace) {
            const { day: dayNum, old_name, activity: newAct } = data.itinerary.replace;
            setCurrentItinerary((prev) => {
              if (!prev?.days) return prev;
              const days = prev.days.map((d) => {
                if (d.day !== dayNum) return d;
                let activities = d.activities.map((a) =>
                  a.name === old_name
                    ? { ...a, ...newAct, time: newAct.time ?? a.time, duration_min: newAct.duration_min ?? a.duration_min }
                    : a
                );
                // Cascade start times for activities after the replaced one
                // so downstream times stay consistent if duration changed.
                const changedIdx = activities.findIndex(
                  (a) => a.name === (newAct.name ?? old_name)
                );
                if (changedIdx >= 0) {
                  activities = cascadeActivityTimes(activities, changedIdx);
                }
                return { ...d, activities };
              });
              return { ...prev, days };
            });
            cues.chime();
          } else {
          // Multi-turn additive merge: each LLM turn only emits fields
          // for its step (Turn 1: flight, Turn 2: hotels, Turn 3: days).
          // We spread the new data ON TOP of the LATEST state (via
          // functional updater to avoid stale closure) so earlier
          // picks are preserved.
          const newData = data.itinerary;

          setCurrentItinerary((prev) => {
            const prevSnapshot = prev || {};

            // If LLM returned selected_hotel as a string, resolve it
            if (newData.selected_hotel && typeof newData.selected_hotel === "string") {
              const name = newData.selected_hotel;
              const hotels = newData.hotels || prevSnapshot.hotels || [];
              const match = hotels.find(
                (h) => h.name?.toLowerCase() === name.toLowerCase(),
              );
              newData.selected_hotel = match || prevSnapshot.selected_hotel || null;
            }

            // Turn 1 indicator: flight arrived but no hotels yet. Clear
            // stale hotels/days/picks from a previous trip so they don't
            // bleed through into the new plan. Hotels and days will be
            // populated fresh in Turn 2 and Turn 3 respectively.
            let base = { ...prevSnapshot };
            if (newData.flight && !newData.hotels?.length && !newData.days?.length) {
              delete base.hotels;
              delete base.days;
              delete base.selected_hotel;
              delete base.selected_flight;
            }

            // Smart days merge: if the LLM returned a partial days array
            // (e.g. only the changed day during a replace_activity replan),
            // preserve the unchanged days instead of wiping them.
            let mergedData = newData;
            if (newData.days && base.days?.length && newData.days.length < base.days.length) {
              const updatedMap = new Map(newData.days.map((d) => [d.day, d]));
              mergedData = { ...newData, days: base.days.map((d) => updatedMap.get(d.day) ?? d) };
            }

            return { ...base, ...mergedData };
          });
          cues.chime();
          // Persist to history. Use currentItinerary spread with newData
          // as a best-effort snapshot — the functional updater above is
          // the authoritative state, but this is close enough for history.
          saveCurrentPlanToHistory(
            { ...(currentItineraryRef.current || {}), ...data.itinerary },
            [...baseMessages, userMsg, assistantMsg],
          );
          } // end else (non-replace itinerary update)
        }

        // Round 11 — flush any buffered navigate_menu target now
        // that the itinerary has landed. Honor the LLM's target
        // verbatim so explicit navigation (including HOTELS / DAYS
        // on replans) still works. If the LLM DIDN'T navigate at
        // all but this turn produced a brand-new itinerary with
        // flights, fall back to FLIGHTS so the sequential flow
        // starts at the first pick step.
        {
          const pending = pendingNavigateRef.current;
          pendingNavigateRef.current = null;
          if (pending && pending.panel) {
            menu.navigate(pending);
            cues.select();
          } else if (data.itinerary) {
            // Fallback: detect which turn just completed by what data
            // was returned, and navigate to the appropriate panel.
            // IMPORTANT: Call A returns days[] date-stubs like [{date:"..."}]
            // with no activities — checking days?.length would incorrectly
            // navigate to DAYS. Only go to DAYS if at least one day has
            // real activities.
            const hasActivities = data.itinerary.days?.some(
              (d) => d.activities?.length > 0
            );
            if (hasActivities) {
              menu.setPanel("DAYS");        // Turn 3 or follow-up edit
            } else if (data.itinerary.hotels?.length) {
              // Suppress navigation to HOTELS while user is still picking
              // their return flight (background hotel search optimization).
              if (!suppressHotelNavRef.current) {
                menu.setPanel("HOTELS");    // Turn 2
              }
            } else if (data.itinerary.flight?.options?.length) {
              menu.setPanel("FLIGHTS");     // Turn 1
            }
            cues.select();
          }
        }
        // Strip ```json ... ``` fences before display — the raw LLM text
        // includes the structured itinerary block which must not be read
        // aloud or shown as subtitle text. Same regex as the history filter
        // at line 690.
        subtitles.pushParagraph(
          (data.reply || "")
            .replace(/```json[\s\S]*?```/g, "")
            .replace(/\[itinerary[^\]]*\]/gi, "")
            .trim()
        );
        // ── Done state: brief ✓ READY flash, then collapse to idle
        setCurrentTool(null);
        setAgentState("done");
        idleTimerRef.current = setTimeout(() => {
          setAgentState("idle");
          idleTimerRef.current = null;
        }, 1500);

        // Flush any pick_flight / pick_hotel / replace_activity chained send.
        // These are queued (not fired immediately) to avoid concurrent-request
        // races where the chained handleSend would start while this stream is
        // still running, causing message-state collisions.
        if (pendingChainedSendRef.current) {
          const pending = pendingChainedSendRef.current;
          pendingChainedSendRef.current = null;
          if (pending.__planDays) {
            const snap = currentItineraryRef.current;
            if (snap) planDaysActivities({ ...snap, selected_hotel: pending.hotel });
          } else {
            // Small delay so the done-state UI settles before the next agent turn.
            setTimeout(() => handleSend(pending.text, pending.opts), 50);
          }
        }

        // Auto-reopen the chat popover on a follow-up question. If the
        // LLM's reply ends with "?", schedule the popover to pop after
        // a short delay so the TTS finishes first. Skipped when a
        // request_input was just set during this same stream — that
        // takes precedence and drives the user to the TRIP form. Read
        // via the ref so we see the fresh value, not the closure.
        const trimmedReply = (data.reply || "").trim();
        if (trimmedReply.endsWith("?") && !pendingInputRequestRef.current) {
          autoReopenTimerRef.current = setTimeout(() => {
            setChatPopoverPromptLabel("");
            setChatPopoverOptions(null);
            setChatPopoverOpen(true);
            autoReopenTimerRef.current = null;
          }, 2000);
        }
      } catch (err) {
        setError(err);
        setAgentState("error");
        setCurrentTool(null);
        cues.error();
      } finally {
        setIsLoading(false);
      }
    },
    [
      messages,
      preferences,
      userLocation,
      tripDates,
      subtitles,
      menu,
      cues,
      llmModel,
      saveCurrentPlanToHistory,
      setPendingInputRequest,
      pushPickSnapshot,
    ],
  );

  // Trigger the GPS prompt on the first user gesture
  useEffect(() => {
    if (userLocation) return;
    const onFirstGesture = () => {
      requestPermission();
      window.removeEventListener("pointerdown", onFirstGesture);
    };
    window.addEventListener("pointerdown", onFirstGesture, { once: true });
    return () => window.removeEventListener("pointerdown", onFirstGesture);
  }, [userLocation, requestPermission]);

  // Derive globe arcs and points from the current itinerary + user location.
  // OBJ6: when on FLIGHTS panel, use the selected option's stops count to
  // show 1 arc (non-stop) or 2 arcs via a visual midpoint (1-stop).
  const { arcs, points } = useMemo(() => {
    const arcs = [];
    const points = [];

    if (userLocation?.lat != null && userLocation?.lng != null) {
      points.push({
        lat: userLocation.lat,
        lng: userLocation.lng,
        size: 0.6,
        color: "#5eead4",
        label: `You are here: ${userLocation.city || ""}`,
        ring: true,
      });
    }

    const flight = currentItinerary?.flight;
    if (flight?.from_lat != null && flight?.to_lat != null) {
      // OBJ6: check which flight option is selected (by listIndex on FLIGHTS panel)
      const options = flight.options || [];
      const selIdx = menu.state.panel === "FLIGHTS" ? menu.state.listIndex : -1;
      const selOpt = selIdx >= 0 ? options[selIdx] : null;
      const stops = selOpt?.stops ?? 0;
      const stopCities = selOpt?.stop_cities || [];

      // Resolve stop city IATA codes to coordinates
      const resolvedStops = stopCities
        .map((iata) => {
          const c = IATA_COORDS[iata];
          return c ? { iata, lat: c[0], lng: c[1] } : null;
        })
        .filter(Boolean);

      if (stops >= 1 && resolvedStops.length > 0) {
        // Multi-segment arcs through actual stop airports
        const waypoints = [
          { iata: flight.from_iata, lat: flight.from_lat, lng: flight.from_lng },
          ...resolvedStops,
          { iata: flight.to_iata, lat: flight.to_lat, lng: flight.to_lng },
        ];
        for (let wi = 0; wi < waypoints.length - 1; wi++) {
          const from = waypoints[wi];
          const to = waypoints[wi + 1];
          arcs.push({
            startLat: from.lat, startLng: from.lng,
            endLat: to.lat, endLng: to.lng,
            color: ["#00d9ff", "#5eead4"],
            label: `${from.iata} → ${to.iata}`,
          });
        }
        // Layover pins
        for (const stop of resolvedStops) {
          points.push({ lat: stop.lat, lng: stop.lng, size: 0.4, color: "#fbbf24", label: `${stop.iata} (layover)` });
        }
      } else if (stops >= 1) {
        // Geometric midpoint fallback when stop IATA not in lookup table
        const midLat = (flight.from_lat + flight.to_lat) / 2;
        const midLng = (flight.from_lng + flight.to_lng) / 2;
        arcs.push({
          startLat: flight.from_lat, startLng: flight.from_lng,
          endLat: midLat, endLng: midLng,
          color: ["#00d9ff", "#5eead4"],
          label: `${flight.from_iata} → layover`,
        });
        arcs.push({
          startLat: midLat, startLng: midLng,
          endLat: flight.to_lat, endLng: flight.to_lng,
          color: ["#5eead4", "#00d9ff"],
          label: `layover → ${flight.to_iata}`,
        });
        points.push({ lat: midLat, lng: midLng, size: 0.4, color: "#fbbf24", label: "Layover" });
      } else {
        // Non-stop: single arc
        arcs.push({
          startLat: flight.from_lat,
          startLng: flight.from_lng,
          endLat: flight.to_lat,
          endLng: flight.to_lng,
          color: ["#00d9ff", "#5eead4"],
          label: `${flight.from_iata} → ${flight.to_iata}`,
        });
      }

      // Return arc — gold color to distinguish from outbound
      if (flight.return_options?.length > 0) {
        arcs.push({
          startLat: flight.to_lat,
          startLng: flight.to_lng,
          endLat: flight.from_lat,
          endLng: flight.from_lng,
          color: ["#fbbf24", "#f59e0b"],
          label: `${flight.to_iata} → ${flight.from_iata} (return)`,
        });
      }

      points.push({
        lat: flight.to_lat,
        lng: flight.to_lng,
        size: 0.8,
        color: "#00d9ff",
        label: flight.to_city,
        ring: true,
      });
    }

    for (const day of currentItinerary?.days || []) {
      for (const a of day.activities || []) {
        if (a.lat != null && a.lng != null) {
          points.push({
            lat: a.lat,
            lng: a.lng,
            size: 0.25,
            color: "rgba(0, 217, 255, 0.7)",
            label: a.name,
          });
        }
      }
    }

    for (const h of currentItinerary?.hotels || []) {
      if (h.lat != null && h.lng != null) {
        points.push({
          lat: h.lat,
          lng: h.lng,
          size: 0.3,
          color: "#fbbf24",
          label: `${h.name} (hotel)`,
        });
      }
    }

    return { arcs, points };
  }, [currentItinerary, userLocation, menu.state.panel, menu.state.listIndex]);

  // Round 10 — when the user switches to HOTELS or DAYS, zoom the globe
  // in toward the destination so the subsequent Leaflet map overlay
  // feels like a camera zoom-in rather than a cut. Returns null for
  // HOME/FLIGHTS so the existing arc-midpoint flight stays in charge.
  //
  // Round 11 — altitudes dropped from 0.35/0.25 to 0.08/0.05 so the
  // globe actually lands close to street level before the Leaflet
  // map takes over. Combined with GlobeView's 2200ms flight and the
  // .panel-grid-center scale-in keyframe, this reads as a continuous
  // zoom rather than two disjoint animations.
  const globeFocus = useMemo(() => {
    const dest = currentItinerary?.flight;
    if (dest?.to_lat == null || dest?.to_lng == null) return null;
    if (menu.state.panel === "HOTELS") {
      return { lat: dest.to_lat, lng: dest.to_lng, altitude: 0.08 };
    }
    if (menu.state.panel === "DAYS" || menu.state.panel === "EXPORT") {
      return { lat: dest.to_lat, lng: dest.to_lng, altitude: 0.05 };
    }
    return null;
  }, [menu.state.panel, currentItinerary]);


  // F2b: Globe fade-out timeline. When user is on HOTELS/DAYS, set
  // data-landed="true" on the globe canvas after a short delay so the
  // CSS opacity transition kicks in. The Leaflet map fading in
  // simultaneously creates a "landed on the map" effect.
  useEffect(() => {
    const isMapPanel = menu.state.panel === "HOTELS" || menu.state.panel === "DAYS" || menu.state.panel === "EXPORT";
    const canvas = document.querySelector(".globe-canvas");
    if (!canvas) return;
    if (isMapPanel) {
      const t = setTimeout(() => {
        canvas.setAttribute("data-landed", "true");
      }, 1500);
      return () => clearTimeout(t);
    } else {
      canvas.setAttribute("data-landed", "false");
    }
  }, [menu.state.panel]);

  return (
    <div className={`app panel-active-${menu.state.panel.toLowerCase()}`}>
      <ErrorBanner error={error} onDismiss={() => setError(null)} />

      {/* Background globe */}
      <Suspense fallback={<div className="globe-loading">Loading globe…</div>}>
        <GlobeView
          userLocation={userLocation}
          arcs={arcs}
          points={points}
          drawerOpen={false}
          focus={globeFocus}
          theme={theme}
        />
      </Suspense>

      {/* NieR-style menu shell */}
      <MenuShell
        state={menu.state}
        onTabClick={setPanelWithCue}
        muted={muted}
        overlay={historyOpen ? "history" : settingsOpen ? "settings" : null}
        agentState={agentState}
        toolTimings={toolTimings}
        requestStartedAt={requestStartedAtRef}
        exportEnabled={!!(currentItinerary?.days?.length > 0)}
      >
        {menu.state.panel === "HOME" && (
          <PanelHome
            itinerary={currentItinerary}
            userLocation={userLocation}
            listIndex={menu.state.listIndex}
            isLoading={isLoading}
            pendingInputRequest={pendingInputRequest}
            planHistory={planHistory}
            currency={currency}
            onLoadPlan={(id) => {
              loadPlanFromHistory(id);
              setPanelWithCue("FLIGHTS");
            }}
            onDeletePlan={deletePlanFromHistory}
            onImportPlan={importPlanEntry}
            onJumpTo={(panel, fieldIdx) => {
              if (panel === "HOME" && typeof fieldIdx === "number") {
                // Click on a HOME form field row → enter list scope
                selectListItem(fieldIdx);
              } else {
                setPanelWithCue(panel);
              }
            }}
            onPlan={(prompt) => handleSend(prompt, { reset: true, callRole: "plan" })}
            onResolveInput={(field, value, fieldIdx) => {
              if (typeof fieldIdx === "number" && fieldIdx >= 0) {
                menu.setListIndex(fieldIdx);
              }
              setPendingInputRequest(null);
              // Always use callRole:"plan" — request_input is only ever called
              // when the LLM needs trip details to start planning. Using the
              // full SYSTEM_PROMPT here causes the LLM to run all 3 turns at
              // once (flights → hotels → days) and jump straight to DAYS.
              handleSend(`${field}: ${value}`, { callRole: "plan" });
            }}
            rowDispatchRef={activeRowDispatchRef}
            formPrefill={pendingFormPrefill}
            onFormPrefilled={(prompt) => {
              setPendingFormPrefill(null);
              // Guard: only fire planning if dates are set. submit_trip_form
              // from chat sometimes omits dates; [not set] in the prompt means
              // the LLM should have asked via request_input first.
              if (prompt.includes("[not set]")) return;
              handleSend(prompt, { callRole: "plan" });
            }}
            side={menu.state.side}
          />
        )}
        {menu.state.panel === "FLIGHTS" && (
          <PanelFlights
            itinerary={currentItinerary}
            listIndex={menu.state.listIndex}
            currency={currency}
            visaAlert={visaAlert}
            side={menu.state.side}
            isLoading={isLoading}
            onSelect={selectListItem}
            onPick={(i, tab) => {
              const isReturn = tab === "return";
              const opts = isReturn
                ? currentItinerary?.flight?.return_options
                : currentItinerary?.flight?.options;
              const opt = opts?.[i];
              if (!opt) return;
              const hasReturnOptions = (currentItinerary?.flight?.return_options?.length ?? 0) > 0;
              if (!isReturn && (!currentItinerary?.flight?.to_lat || !currentItinerary?.flight?.to_lng)) {
                setError("No destination coordinates available. Please re-run START PLANNING first.");
                return;
              }
              pushPickSnapshot();
              const flightLabel = (f) => f ? [
                f.airline,
                f.departure_time && f.arrival_time ? `${f.departure_time}→${f.arrival_time}` : null,
                f.price_low ? `HK$${f.price_low}` : null,
              ].filter(Boolean).join(", ") : null;
              // Helper: strip downstream data that must be regenerated after
              // a new flight is picked — hotels/days/picks are now stale.
              const itinWithNewFlight = (extra = {}) => ({
                ...currentItinerary,
                hotels: undefined,
                selected_hotel: null,
                days: undefined,
                ...extra,
              });
              if (isReturn) {
                // Return pick → save return flight, clear background suppression.
                // Hotels/days were already cleared when the outbound was picked;
                // just update the return flight here.
                setCurrentItinerary({ ...currentItinerary, selected_return_flight: opt });
                cues.chime();
                suppressHotelNavRef.current = false;
                if (currentItinerary?.hotels?.length) {
                  menu.setPanel("HOTELS");
                  cues.select();
                }
                // If agentState is still "working", navigation happens in done event.
              } else if (hasReturnOptions) {
                // Outbound pick with return options → start hotel search in background
                // immediately, but suppress navigation until return flight is picked.
                // PanelFlights useEffect auto-switches to RETURN tab.
                setCurrentItinerary(itinWithNewFlight({ selected_flight: opt }));
                cues.chime();
                suppressHotelNavRef.current = true;
                handleSend(
                  `Selected flight: ${flightLabel(opt)}. Now find hotels in ${currentItinerary?.destination}.`,
                  { callRole: "hotels" },
                );
              } else {
                // One-way trip → save + fire hotel search immediately
                setCurrentItinerary(itinWithNewFlight({ selected_flight: opt }));
                cues.chime();
                handleSend(
                  `Selected flight: ${flightLabel(opt)}. Now find hotels in ${currentItinerary?.destination}.`,
                  { callRole: "hotels" },
                );
              }
            }}
            onSkipFlight={() => {
              pushPickSnapshot();
              setCurrentItinerary({ ...currentItinerary, selected_flight: null, flight: null });
              cues.chime();
              handleSend(
                `No flight needed — using ground transport. Now find hotels in ${currentItinerary?.destination}.`,
                { callRole: "hotels" },
              );
            }}
          />
        )}
        {menu.state.panel === "HOTELS" && (
          <PanelHotels
            itinerary={currentItinerary}
            listIndex={menu.state.listIndex}
            onSelect={selectListItem}
            autoReplan={autoReplan}
            onToggleAutoReplan={toggleAutoReplan}
            onPick={(i) => {
              const hotel = currentItinerary?.hotels?.[i];
              if (!hotel) return;
              if (!currentItinerary?.hotels?.length) {
                setError("No hotel data available. Please re-run hotel search first.");
                return;
              }
              pushPickSnapshot();
              // Stamp the hotel pick locally and clear stale days —
              // a new days plan will be generated for this hotel.
              setCurrentItinerary({
                ...currentItinerary,
                selected_hotel: hotel,
                days: undefined,
              });
              cues.chime();
              if (autoReplan) {
                // Fire two-phase day planning so the LLM builds days around this hotel
                planDaysActivities({
                  ...currentItinerary,
                  selected_hotel: hotel,
                });
              } else {
                // Manual mode — just advance to DAYS panel
                setPanelWithCue("DAYS");
              }
            }}
            side={menu.state.side}
            theme={theme}
          />
        )}
        {menu.state.panel === "DAYS" && (
          <PanelDays
            itinerary={currentItinerary}
            dayStatuses={dayStatuses}
            onRetryDay={handleRetryDay}
            listIndex={menu.state.listIndex}
            side={menu.state.side}
            activityIndex={activityIndex}
            onSelect={selectListItem}
            onReorderActivities={(dayIdx, fromIdx, toIdx) => {
              // Round 13 — reorder activities within one day in
              // place. Does not re-query the LLM; times stay the
              // same (the user is saying "visit these in a
              // different order", not "replan").
              setCurrentItinerary((prev) => {
                if (!prev?.days?.[dayIdx]?.activities) return prev;
                const day = prev.days[dayIdx];
                const acts = [...day.activities];
                const [moved] = acts.splice(fromIdx, 1);
                if (!moved) return prev;
                const insertAt = toIdx > fromIdx ? toIdx - 1 : toIdx;
                acts.splice(insertAt, 0, moved);
                const days = [...prev.days];
                days[dayIdx] = { ...day, activities: acts };
                return { ...prev, days };
              });
              cues.tick?.();
            }}
            onRemoveActivity={(dayIdx, actIdx) => {
              // Round 13 — remove a single activity without firing a
              // replan. Purely local.
              setCurrentItinerary((prev) => {
                if (!prev?.days?.[dayIdx]?.activities) return prev;
                const day = prev.days[dayIdx];
                const acts = day.activities.filter((_, i) => i !== actIdx);
                const days = [...prev.days];
                days[dayIdx] = { ...day, activities: acts };
                return { ...prev, days };
              });
              cues.tick?.();
            }}
            onReplaceActivity={(dayIdx, actIdx) => {
              // Ask the user what they want to replace the activity with
              // before sending to the LLM — opens ChatPopover with context.
              const day = currentItinerary?.days?.[dayIdx];
              const act = day?.activities?.[actIdx];
              if (!act) return;
              const dest = currentItinerary?.destination || "the destination";
              pendingReplaceRef.current = {
                actName: act.name,
                dayNum: day.day,
                dest,
                actTime: act.time,
                actDuration: act.duration_min,
              };
              setChatPopoverPromptLabel(
                `What would you like to replace "${act.name}" with? (Leave empty for a similar alternative)`
              );
              setChatPopoverInitial("");
              setChatPopoverOpen(true);
            }}
            onSetActivityNote={(dayIdx, actIdx, note) => {
              // Round 16 — attach a personal note to an activity.
              // Purely local; persists via the travel-chat-state
              // auto-save hook.
              setCurrentItinerary((prev) => {
                if (!prev?.days?.[dayIdx]?.activities) return prev;
                const day = prev.days[dayIdx];
                const acts = day.activities.map((a, i) =>
                  i === actIdx ? { ...a, user_note: note.trim() || undefined } : a,
                );
                const days = [...prev.days];
                days[dayIdx] = { ...day, activities: acts };
                return { ...prev, days };
              });
            }}
            onEditActivityField={(dayIdx, actIdx, field, value) => {
              // Manual edit — purely local, no LLM call.
              setCurrentItinerary((prev) => {
                if (!prev?.days?.[dayIdx]?.activities) return prev;
                const day = prev.days[dayIdx];
                const acts = day.activities.map((a, i) =>
                  i === actIdx ? { ...a, [field]: value, source: a.source || "manual" } : a,
                );
                const days = [...prev.days];
                days[dayIdx] = { ...day, activities: acts };
                return { ...prev, days };
              });
              cues.tick?.();
            }}
            onAddActivity={(dayIdx, newAct) => {
              // Manual add — inserts at correct position by time.
              setCurrentItinerary((prev) => {
                if (!prev?.days?.[dayIdx]) return prev;
                const day = prev.days[dayIdx];
                const acts = [...(day.activities || []), newAct];
                // Sort by time for natural ordering
                acts.sort((a, b) => (a.time || "").localeCompare(b.time || ""));
                const days = [...prev.days];
                days[dayIdx] = { ...day, activities: acts };
                return { ...prev, days };
              });
              cues.chime?.();
            }}
            onAddDay={(() => {
              // Disable Add Day when the trip dates are fixed (start + end date
              // both set in the planning form), and we already have all the days.
              const formDates = loadFormDates();
              const expectedDays = formDates
                ? Math.round(
                    (new Date(formDates.end_date) - new Date(formDates.start_date)) / 86400000
                  ) + 1
                : null;
              const currentDayCount = currentItinerary?.days?.length ?? 0;
              const canAdd = !expectedDays || currentDayCount < expectedDays;
              if (!canAdd) return undefined;
              return () => {
                // Append a new empty day.
                setCurrentItinerary((prev) => {
                  if (!prev) return prev;
                  const days = prev.days || [];
                  const lastDay = days[days.length - 1];
                  const nextDayNum = (lastDay?.day || 0) + 1;
                  let nextDate = "";
                  if (lastDay?.date) {
                    try {
                      const d = new Date(lastDay.date);
                      d.setDate(d.getDate() + 1);
                      nextDate = d.toISOString().slice(0, 10);
                    } catch { /* ignore */ }
                  }
                  const newDay = {
                    day: nextDayNum,
                    date: nextDate,
                    theme: "Custom Day",
                    activities: [],
                    source: "manual",
                  };
                  return { ...prev, days: [...days, newDay] };
                });
                cues.chime?.();
              };
            })()}
            onRemoveDay={(dayIdx) => {
              setCurrentItinerary((prev) => {
                if (!prev?.days || prev.days.length <= 1) return prev;
                const days = prev.days.filter((_, i) => i !== dayIdx);
                // Renumber days to keep them sequential
                const renumbered = days.map((d, i) => ({ ...d, day: i + 1 }));
                return { ...prev, days: renumbered };
              });
              cues.tick?.();
            }}
            favoriteKeys={favoriteKeys}
            onToggleFavorite={(dayIdx, actIdx) => {
              // Round 19 — toggle a favorite entry keyed by place_id
              // or name. Favorites are global (not per-plan) so users
              // can build a wishlist across trips.
              const day = currentItinerary?.days?.[dayIdx];
              const act = day?.activities?.[actIdx];
              if (!act) return;
              const key = act.place_id || act.name;
              if (!key) return;
              setFavorites((prev) => {
                const exists = prev.some((f) => f.key === key);
                let next;
                if (exists) {
                  next = prev.filter((f) => f.key !== key);
                } else {
                  next = [
                    {
                      key,
                      name: act.name,
                      address: act.address,
                      place_id: act.place_id,
                      lat: act.lat,
                      lng: act.lng,
                      photo_url: act.photo_url,
                      destination: currentItinerary?.destination,
                      saved_at: Date.now(),
                    },
                    ...prev,
                  ].slice(0, 100);
                }
                saveFavorites(next);
                return next;
              });
              cues.tick?.();
            }}
            theme={theme}
          />
        )}
        {menu.state.panel === "EXPORT" && (
          <PanelExport
            itinerary={currentItinerary}
            visaAlert={visaAlert}
          />
        )}
      </MenuShell>

      {/* HISTORY overlay (H key) */}
      <HistoryOverlay
        open={historyOpen}
        messages={messages}
        onClose={() => setHistoryOpen(false)}
        onEditTurn={handleEditTurn}
      />

      {/* SETTINGS overlay (S key) */}
      <SettingsOverlay
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        onChange={setPreferences}
        onCurrencyChange={setCurrency}
        onLlmModelChange={setLlmModel}
        onThemeChange={setTheme}
        muted={muted}
        onToggleMute={() => setMuted((m) => !m)}
        onClearAll={handleClearAll}
      />

      <HelpOverlay open={helpOpen} onClose={() => setHelpOpen(false)} />
      <TripChecklist
        open={checklistOpen}
        destinationKey={currentItinerary?.destination || "default"}
        onClose={() => setChecklistOpen(false)}
      />
      <FavoritesOverlay
        open={favoritesOpen}
        favorites={favorites}
        onClose={() => setFavoritesOpen(false)}
        onRemove={(key) => {
          setFavorites((prev) => {
            const next = prev.filter((f) => f.key !== key);
            saveFavorites(next);
            return next;
          });
        }}
      />

      <ServiceStatusOverlay
        open={statusOpen}
        onClose={() => setStatusOpen(false)}
      />

      {/* Bottom-center subtitle bar with auto-TTS + R16 history */}
      <Subtitle
        text={streamingText || subtitles.current}
        history={subtitles.history || []}
        onPause={subtitles.pause}
        onResume={subtitles.resume}
      />

      {/* Chat popover (opens on Enter / Cmd+K) */}
      <ChatPopover
        open={chatPopoverOpen}
        onSend={(text, opts) => {
          // If a HISTORY overlay turn-edit is in flight, route through
          // handleSend with truncateBefore so the conversation is cut
          // exactly at the edited turn (not at the most recent user
          // message). This avoids the double-truncation bug.
          const idx = editTurnIdxRef.current;
          editTurnIdxRef.current = null;
          const replaceCtx = pendingReplaceRef.current;
          pendingReplaceRef.current = null;
          if (idx != null) {
            handleSend(text, { truncateBefore: idx, callRole: "chat" });
          } else if (replaceCtx) {
            // User answered the "replace with what?" question — use the
            // lightweight replace role (1 search_places call, surgical swap).
            const { actName, dayNum, dest, actTime, actDuration } = replaceCtx;
            const preference = text.trim();
            const timeContext =
              actTime
                ? ` Original activity time: ${actTime}, duration: ${actDuration ?? 60} min. Keep the same start time and duration unless the replacement logically requires otherwise.`
                : "";
            const msg = preference
              ? `Day ${dayNum}, replace "${actName}" with: ${preference}. Destination city: ${dest}.${timeContext}`
              : `Day ${dayNum}, replace "${actName}" with a different but similar place in ${dest}.${timeContext}`;
            handleSend(msg, { callRole: "replace" });
          } else if (pendingInputRequestRef.current) {
            // User answered a request_input question (e.g., clicked an airport option).
            // Mirror onResolveInput: clear the request and send with the plan role.
            const req = pendingInputRequestRef.current;
            setPendingInputRequest(null);
            handleSend(`${req.field}: ${text}`, { callRole: "plan" });
          } else {
            handleSend(text, { ...opts, callRole: "chat" });
          }
        }}
        onClose={() => {
          setChatPopoverOpen(false);
          setChatPopoverInitial("");
          setChatPopoverPromptLabel("");
          setChatPopoverOptions(null);
          editTurnIdxRef.current = null;
          pendingReplaceRef.current = null;
          setPendingInputRequest(null);
        }}
        isLoading={isLoading}
        initialText={chatPopoverInitial}
        promptLabel={chatPopoverPromptLabel}
        options={chatPopoverOptions}
        onRecallLast={() => lastUserMessage}
      />
    </div>
  );
}

export default App;
