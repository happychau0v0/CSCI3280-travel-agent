import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from "react";
import ErrorBanner from "./components/ErrorBanner";
import MenuShell from "./components/MenuShell";
import Subtitle from "./components/Subtitle";
import ChatPopover from "./components/ChatPopover";
import AgentStatusBar from "./components/AgentStatusBar";
import HistoryOverlay from "./components/HistoryOverlay";
import SettingsOverlay from "./components/SettingsOverlay";
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

function App() {
  const initial = loadState();
  const [messages, setMessages] = useState(initial.messages);
  const [currentItinerary, setCurrentItinerary] = useState(initial.itinerary);
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
  // Agent status state used by the AgentStatusBar — addresses the
  // round-7 "feels unresponsive" complaint with overlapping indicators.
  const [agentState, setAgentState] = useState("idle"); // idle|working|done|error
  const [currentTool, setCurrentTool] = useState(null);
  const [requestStartedAt, setRequestStartedAt] = useState(null);
  const [pendingInputRequest, setPendingInputRequest] = useState(null);
  // Tracks the in-flight done→idle setTimeout so a new request can
  // cancel it before it overwrites the new "working" state (B6).
  const idleTimerRef = useRef(null);
  // Per-panel imperative handle: panels with actionable rows expose
  // an `activateRow(index)` method via ref. App.jsx's onActivate
  // (Space hotkey) reads the current panel's ref and invokes it.
  const activeRowDispatchRef = useRef(null);
  // Ref mirror so handleSend's running invocation can read the
  // post-stream value of pendingInputRequest without being trapped
  // by its useCallback closure (B4). Keep in sync via a tiny effect.
  const pendingInputRequestRef = useRef(null);
  useEffect(() => {
    pendingInputRequestRef.current = pendingInputRequest;
  }, [pendingInputRequest]);
  const tripDates = loadTripDates(); // edited via PanelProfile in the future
  const { location: userLocation, requestPermission } = useGeolocation();
  const menu = useMenuState();
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

  // HISTORY overlay's E shortcut: edit a specific turn. Truncates the
  // message history to before the turn at idx and opens the chat
  // popover prefilled with the turn's text. Closes the overlay.
  const handleEditTurn = useCallback(
    (idx, text) => {
      if (idx < 0 || idx >= messages.length) return;
      // Truncate to before this turn — we'll re-add as a new user
      // message via handleSend's editLast path. The popover only
      // truncates if isEditSession is true (B5 fix).
      setMessages(messages.slice(0, idx));
      setChatPopoverInitial(text);
      setHistoryOpen(false);
      setChatPopoverOpen(true);
    },
    [messages],
  );

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
    enabled: !historyOpen && !settingsOpen,
  });

  // Persist messages + itinerary
  useEffect(() => {
    saveState(messages, currentItinerary);
  }, [messages, currentItinerary]);

  const handleSend = useCallback(
    async (text, { editLast = false } = {}) => {
      const userMsg = { role: "user", content: text };

      // Edit-and-rerun: truncate the conversation back to before the
      // most recent user message so the agent responds to the edited
      // prompt as if the original never happened.
      let baseMessages = messages;
      if (editLast) {
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
      const startedAt = Date.now();
      setRequestStartedAt(startedAt);
      setAgentState("working");
      setCurrentTool(null);
      subtitles.clear();
      const preview = text.length > 60 ? text.slice(0, 57) + "…" : text;
      subtitles.push(`▸ ${preview}`);
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
              menu.navigate(payload);
              cues.select();
            } else if (type === "request_input") {
              // The LLM is asking for a single structured value via
              // the TRIP form. Switch to TRIP, focus the field, and
              // surface the prompt as a subtitle so it's spoken.
              setPendingInputRequest(payload);
              menu.setPanel("TRIP");
              if (payload?.prompt) subtitles.push(payload.prompt);
              cues.select();
            }
          },
        });
        if (!data) throw new Error("Stream ended without a response");
        const assistantMsg = { role: "assistant", content: data.reply };
        setMessages((prev) => [...prev, assistantMsg]);
        if (data.itinerary) {
          setCurrentItinerary(data.itinerary);
          cues.chime();
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
          setTimeout(() => setChatPopoverOpen(true), 2000);
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
            onSelect={selectListItem}
            onPick={(i) => {
              const opt = currentItinerary?.flight?.options?.[i];
              if (!opt) return;
              setCurrentItinerary({ ...currentItinerary, selected_flight: opt });
              cues.chime();
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
              // Stamp the pick locally so the HOME card and the .picked
              // class update immediately without waiting for the agent.
              setCurrentItinerary({
                ...currentItinerary,
                selected_hotel: hotel,
              });
              cues.chime();
              // Auto-fire a replan chat. The backend SYSTEM_PROMPT
              // (R3b) instructs the LLM to anchor each day at this
              // hotel.
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
        muted={muted}
        onToggleMute={() => setMuted((m) => !m)}
        onClearAll={handleClearAll}
      />

      {/* Bottom-center subtitle bar with auto-TTS */}
      <Subtitle text={subtitles.current} />

      {/* Chat popover (opens on Enter / Cmd+K) */}
      <ChatPopover
        open={chatPopoverOpen}
        onSend={(text, opts) => handleSend(text, opts)}
        onClose={() => {
          setChatPopoverOpen(false);
          setChatPopoverInitial("");
        }}
        isLoading={isLoading}
        initialText={chatPopoverInitial}
        onRecallLast={() => lastUserMessage}
      />
    </div>
  );
}

export default App;
