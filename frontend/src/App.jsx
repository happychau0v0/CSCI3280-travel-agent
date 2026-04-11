import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from "react";
import ErrorBanner from "./components/ErrorBanner";
import MenuShell from "./components/MenuShell";
import Subtitle from "./components/Subtitle";
import ChatPopover from "./components/ChatPopover";
import AgentStatusBar from "./components/AgentStatusBar";
import HistoryOverlay from "./components/HistoryOverlay";
import SettingsOverlay, { loadTts, loadTheme, applyTheme, loadCurrency } from "./components/SettingsOverlay";
import HelpOverlay from "./components/HelpOverlay";
import PanelHome from "./components/panels/PanelHome";
import PanelFlights from "./components/panels/PanelFlights";
import PanelHotels from "./components/panels/PanelHotels";
import PanelDays from "./components/panels/PanelDays";
import { streamChat } from "./api/client";
import { useGeolocation } from "./hooks/useGeolocation";
import { useMenuState } from "./hooks/useMenuState";
import { useKeyboard } from "./hooks/useKeyboard";
import { useSubtitleQueue } from "./hooks/useSubtitleQueue";
import { useAudioCues } from "./hooks/useAudioCues";
import "./App.css";

// Lazy-load the globe so the Three.js bundle doesn't block first paint.
const GlobeView = lazy(() => import("./components/GlobeView"));

const STATE_KEY = "travel-chat-state";
const TRIP_DATES_KEY = "travel-trip-dates";
const PLAN_HISTORY_KEY = "travel-plan-history";
const PLAN_HISTORY_MAX = 20;

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

function App() {
  const initial = loadState();
  const [messages, setMessages] = useState(initial.messages);
  const [currentItinerary, setCurrentItinerary] = useState(initial.itinerary);
  const [planHistory, setPlanHistory] = useState(() => loadPlanHistory());
  const [isLoading, setIsLoading] = useState(false);
  const [preferences, setPreferences] = useState(null);
  const [error, setError] = useState(null);
  const [muted, setMuted] = useState(false);
  const [chatPopoverOpen, setChatPopoverOpen] = useState(false);
  const [chatPopoverInitial, setChatPopoverInitial] = useState("");
  // Overlay state — HISTORY (H key) and SETTINGS (S key) replace the
  // dedicated tabs in the round-8.5 redesign.
  const [historyOpen, setHistoryOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  // Agent status state used by the AgentStatusBar — addresses the
  // round-7 "feels unresponsive" complaint with overlapping indicators.
  const [agentState, setAgentState] = useState("idle"); // idle|working|done|error
  const [currentTool, setCurrentTool] = useState(null);
  const [requestStartedAt, setRequestStartedAt] = useState(null);
  const [pendingInputRequest, _setPendingInputRequest] = useState(null);
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
  const pendingInputRequestRef = useRef(null);
  const setPendingInputRequest = useCallback((value) => {
    pendingInputRequestRef.current = value;
    _setPendingInputRequest(value);
  }, []);
  const tripDates = loadTripDates(); // edited via PanelProfile in the future
  const { location: userLocation, requestPermission } = useGeolocation();
  const menu = useMenuState();
  const [tts, setTts] = useState(() => loadTts());
  const [currency, setCurrency] = useState(() => loadCurrency());
  const subtitles = useSubtitleQueue({
    muted,
    rate: tts.rate,
    voiceName: tts.voiceName,
  });
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
    } catch {
      /* ignore */
    }
    setMessages([]);
    setCurrentItinerary(null);
    setError(null);
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
  // Mouse click on a list item: move the cursor AND enter list scope
  // explicitly. The scope flip is what makes ←/→ stop cycling tabs and
  // signals to the user that they're now "inside" the panel.
  const selectListItem = useCallback(
    (index) => {
      cues.tick();
      menu.setListIndex(index);
      menu.setScope("list");
    },
    [cues, menu],
  );

  // Document-level hotkeys. Disabled while an overlay is open so the
  // overlay can own its own keyboard handling without leaking events.
  useKeyboard({
    state: menu.state,
    setPanel: setPanelWithCue,
    setListIndex: setListIndexWithCue,
    setScope: menu.setScope,
    listSize,
    onOpenChat: () => {
      cues.select();
      setChatPopoverInitial("");
      setChatPopoverOpen(true);
    },
    onActivate: () => {
      cues.select();
      // Dispatch to the current panel's row activator if it has one.
      // Settings/HOME form rows register an activateRow handler via
      // activeRowDispatchRef. Other panels can opt in similarly.
      const dispatch = activeRowDispatchRef.current;
      if (dispatch) dispatch(menu.state.listIndex);
    },
    onBack: () => {
      if (chatPopoverOpen) {
        setChatPopoverOpen(false);
      } else if (menu.state.scope === "list") {
        menu.setScope("tabs");
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
    enabled: !historyOpen && !settingsOpen && !helpOpen,
  });

  // Persist messages + itinerary
  useEffect(() => {
    saveState(messages, currentItinerary);
  }, [messages, currentItinerary]);

  // Round 12 — apply the persisted theme on mount so the page
  // opens in the user's last-chosen palette without a flash.
  useEffect(() => {
    applyTheme(loadTheme());
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  const handleSend = useCallback(
    async (text, { editLast = false, truncateBefore = null } = {}) => {
      const userMsg = { role: "user", content: text };

      // Edit-and-rerun: truncate the conversation back to before a
      // specific turn (truncateBefore) or before the most recent user
      // turn (editLast) so the agent responds to the edited prompt as
      // if the original never happened. truncateBefore wins when both
      // are set — it's used by the HISTORY overlay's per-turn edit.
      let baseMessages = messages;
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
      const history = baseMessages.map((m) => ({ role: m.role, content: m.content }));

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
      const startedAt = Date.now();
      setRequestStartedAt(startedAt);
      setAgentState("working");
      setCurrentTool(null);
      subtitles.clear();
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
          onEvent: ({ type, data: payload }) => {
            if (type === "tool_start") {
              cues.bloop();
              const tool = payload?.name || payload?.tool;
              if (tool) {
                setCurrentTool(tool);
                // Push a friendly narration so the user sees progress
                // in the subtitle bar in addition to the status banner.
                const label = TOOL_NARRATIONS[tool];
                if (label) subtitles.push(label);
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
              // The LLM is asking for a single structured value via
              // an inline form row on HOME. Flag the pending request
              // (PanelHome's effect focuses the matching row), ensure
              // we're on HOME, and speak the prompt as a subtitle.
              setPendingInputRequest(payload);
              if (menu.state.panel !== "HOME") menu.setPanel("HOME");
              if (payload?.prompt) subtitles.push(payload.prompt);
              cues.select();
            }
          },
        });
        if (!data) throw new Error("Stream ended without a response");
        const assistantMsg = { role: "assistant", content: data.reply };
        setMessages((prev) => [...prev, assistantMsg]);
        if (data.itinerary) {
          // Merge the new itinerary with the current one so user-driven
          // selections (selected_flight, selected_hotel) are preserved
          // across replan round-trips even if the LLM forgets to echo
          // them in its response. The new itinerary still wins on
          // every OTHER field.
          const prevSnapshot = currentItinerary;
          const mergedItinerary = { ...data.itinerary };
          if (!mergedItinerary.selected_flight && prevSnapshot?.selected_flight) {
            mergedItinerary.selected_flight = prevSnapshot.selected_flight;
          }
          if (!mergedItinerary.selected_hotel && prevSnapshot?.selected_hotel) {
            mergedItinerary.selected_hotel = prevSnapshot.selected_hotel;
          }
          setCurrentItinerary(mergedItinerary);
          cues.chime();
          // Round 11 — persist the finished plan to history so the
          // user can find it again in the PLAN HISTORY card.
          saveCurrentPlanToHistory(
            mergedItinerary,
            [...baseMessages, userMsg, assistantMsg],
          );
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
          } else if (data.itinerary?.flight?.options?.length) {
            menu.setPanel("FLIGHTS");
            cues.select();
          }
        }
        subtitles.pushParagraph(data.reply);
        // ── Done state: brief ✓ READY flash, then collapse to idle
        setCurrentTool(null);
        setAgentState("done");
        idleTimerRef.current = setTimeout(() => {
          setAgentState("idle");
          idleTimerRef.current = null;
        }, 1500);

        // Auto-reopen the chat popover on a follow-up question. If the
        // LLM's reply ends with "?", schedule the popover to pop after
        // a short delay so the TTS finishes first. Skipped when a
        // request_input was just set during this same stream — that
        // takes precedence and drives the user to the TRIP form. Read
        // via the ref so we see the fresh value, not the closure.
        const trimmedReply = (data.reply || "").trim();
        if (trimmedReply.endsWith("?") && !pendingInputRequestRef.current) {
          autoReopenTimerRef.current = setTimeout(() => {
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

  // Derive globe arcs and points from the current itinerary + user location
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
      arcs.push({
        startLat: flight.from_lat,
        startLng: flight.from_lng,
        endLat: flight.to_lat,
        endLng: flight.to_lng,
        color: ["#00d9ff", "#5eead4"],
        label: `${flight.from_iata} → ${flight.to_iata}`,
      });
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
  }, [currentItinerary, userLocation]);

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
    if (menu.state.panel === "DAYS") {
      return { lat: dest.to_lat, lng: dest.to_lng, altitude: 0.05 };
    }
    return null;
  }, [menu.state.panel, currentItinerary]);

  return (
    <div className="app">
      <ErrorBanner error={error} onDismiss={() => setError(null)} />

      {/* Background globe */}
      <Suspense fallback={<div className="globe-loading">Loading globe…</div>}>
        <GlobeView
          userLocation={userLocation}
          arcs={arcs}
          points={points}
          drawerOpen={false}
          focus={globeFocus}
        />
      </Suspense>

      {/* Prominent agent-working banner — pinned below the tab strip
       *  via fixed positioning. The user's #1 round-7 complaint was
       *  "feels unresponsive", so this is impossible to miss. */}
      <AgentStatusBar
        state={agentState}
        currentTool={currentTool}
        startedAt={requestStartedAt}
        errorMessage={error?.message}
        onDismissError={() => {
          setError(null);
          setAgentState("idle");
        }}
      />

      {/* NieR-style menu shell */}
      <MenuShell
        state={menu.state}
        onTabClick={setPanelWithCue}
        muted={muted}
        overlay={historyOpen ? "history" : settingsOpen ? "settings" : null}
      >
        {menu.state.panel === "HOME" && (
          <PanelHome
            itinerary={currentItinerary}
            userLocation={userLocation}
            agentState={agentState}
            currentTool={currentTool}
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
            onPlan={handleSend}
            onResolveInput={(field, value, fieldIdx) => {
              if (typeof fieldIdx === "number" && fieldIdx >= 0) {
                menu.setListIndex(fieldIdx);
              }
              setPendingInputRequest(null);
              handleSend(`${field}: ${value}`);
            }}
            rowDispatchRef={activeRowDispatchRef}
          />
        )}
        {menu.state.panel === "FLIGHTS" && (
          <PanelFlights
            itinerary={currentItinerary}
            listIndex={menu.state.listIndex}
            currency={currency}
            onSelect={selectListItem}
            onPick={(i) => {
              const opt = currentItinerary?.flight?.options?.[i];
              if (!opt) return;
              // Round 12 — snapshot previous pick state so Ctrl+Z
              // can revert this action.
              pushPickSnapshot();
              // Round 10 — plan is already complete; a flight pick
              // just stamps the selection locally and advances the
              // panel to HOTELS so the user can pick accommodation
              // next. No backend round-trip needed.
              setCurrentItinerary({ ...currentItinerary, selected_flight: opt });
              cues.chime();
              setPanelWithCue("HOTELS");
            }}
          />
        )}
        {menu.state.panel === "HOTELS" && (
          <PanelHotels
            itinerary={currentItinerary}
            listIndex={menu.state.listIndex}
            onSelect={selectListItem}
            onPick={(i) => {
              const hotel = currentItinerary?.hotels?.[i];
              if (!hotel) return;
              // Round 12 — snapshot previous pick state so Ctrl+Z
              // can revert this action.
              pushPickSnapshot();
              // Stamp the pick locally so the detail card and the
              // .picked class update immediately without waiting
              // for the agent.
              setCurrentItinerary({
                ...currentItinerary,
                selected_hotel: hotel,
              });
              cues.chime();
              // If the user picked the hotel the LLM already pre-
              // selected, no replan is needed — just advance to
              // DAYS. Otherwise fire the replan chat so the LLM
              // re-emits the days array anchored on the new hotel.
              const prev = currentItinerary?.selected_hotel?.name;
              if (prev === hotel.name) {
                setPanelWithCue("DAYS");
                return;
              }
              const prompt =
                `Set "${hotel.name}" as the base hotel. ` +
                `Replan every day so each route starts and ends at this hotel.`;
              handleSend(prompt);
            }}
          />
        )}
        {menu.state.panel === "DAYS" && (
          <PanelDays
            itinerary={currentItinerary}
            listIndex={menu.state.listIndex}
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
              // Round 13 — ask the agent for a similar alternative.
              // Fires a chat that the LLM can respond to with a
              // replacement via replan.
              const day = currentItinerary?.days?.[dayIdx];
              const act = day?.activities?.[actIdx];
              if (!act) return;
              const dest = currentItinerary?.destination || "the destination";
              handleSend(
                `Replace "${act.name}" on Day ${day.day} with a similar but different place in ${dest}. ` +
                `Keep every other activity, keep the hotel anchor, update times if needed.`,
              );
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
        onTtsChange={setTts}
        onCurrencyChange={setCurrency}
        muted={muted}
        onToggleMute={() => setMuted((m) => !m)}
        onClearAll={handleClearAll}
      />

      <HelpOverlay open={helpOpen} onClose={() => setHelpOpen(false)} />

      {/* Bottom-center subtitle bar with auto-TTS */}
      <Subtitle text={subtitles.current} />

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
          if (idx != null) {
            handleSend(text, { truncateBefore: idx });
          } else {
            handleSend(text, opts);
          }
        }}
        onClose={() => {
          setChatPopoverOpen(false);
          setChatPopoverInitial("");
          editTurnIdxRef.current = null;
        }}
        isLoading={isLoading}
        initialText={chatPopoverInitial}
        onRecallLast={() => lastUserMessage}
      />
    </div>
  );
}

export default App;
