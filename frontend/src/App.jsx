import { Suspense, lazy, useCallback, useEffect, useMemo, useState } from "react";
import ErrorBanner from "./components/ErrorBanner";
import MenuShell from "./components/MenuShell";
import Subtitle from "./components/Subtitle";
import ChatPopover from "./components/ChatPopover";
import PanelHome from "./components/panels/PanelHome";
import PanelTrip from "./components/panels/PanelTrip";
import PanelSettings from "./components/panels/PanelSettings";
import PanelFlights from "./components/panels/PanelFlights";
import PanelHotels from "./components/panels/PanelHotels";
import PanelDays from "./components/panels/PanelDays";
import PanelHistory from "./components/panels/PanelHistory";
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
  const tripDates = loadTripDates(); // edited via PanelProfile in the future
  const { location: userLocation, requestPermission } = useGeolocation();
  const menu = useMenuState();
  const subtitles = useSubtitleQueue({ muted });
  const cues = useAudioCues({ muted });

  // Compute the size of the active panel's left list so the keyboard
  // hook can clamp ↑/↓ navigation.
  const listSize = useMemo(() => {
    switch (menu.state.panel) {
      case "TRIP":
        return 6; // destination, start, end, transport, party, interests
      case "FLIGHTS":
        return currentItinerary?.flight?.options?.length || 0;
      case "HOTELS":
        return currentItinerary?.hotels?.length || 0;
      case "DAYS":
        return currentItinerary?.days?.length || 0;
      case "SETTINGS":
        return 8; // 5 prefs + mute + clear + globe-stars
      default:
        return 0;
    }
  }, [menu.state.panel, currentItinerary]);

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

  // Document-level hotkeys
  useKeyboard({
    state: menu.state,
    setPanel: setPanelWithCue,
    setListIndex: setListIndexWithCue,
    setScope: menu.setScope,
    listSize,
    onOpenChat: () => {
      cues.select();
      setChatPopoverOpen(true);
    },
    onActivate: () => {
      cues.select();
    },
    onBack: () => {
      if (chatPopoverOpen) {
        setChatPopoverOpen(false);
      } else if (menu.state.scope === "list") {
        menu.setScope("tabs");
      }
    },
    onToggleMute: () => setMuted((m) => !m),
  });

  // Persist messages + itinerary
  useEffect(() => {
    saveState(messages, currentItinerary);
  }, [messages, currentItinerary]);

  const handleSend = useCallback(
    async (text) => {
      const userMsg = { role: "user", content: text };
      const history = messages.map((m) => ({ role: m.role, content: m.content }));

      setMessages((prev) => [...prev, userMsg]);
      setIsLoading(true);
      setError(null);

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
            } else if (type === "navigate") {
              menu.navigate(payload);
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
      } catch (err) {
        setError(err);
        cues.error();
      } finally {
        setIsLoading(false);
      }
    },
    [messages, preferences, userLocation, tripDates, subtitles, menu, cues],
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

      {/* NieR-style menu shell */}
      <MenuShell state={menu.state} onTabClick={setPanelWithCue} muted={muted}>
        {menu.state.panel === "HOME" && (
          <PanelHome
            itinerary={currentItinerary}
            userLocation={userLocation}
            onJumpTo={setPanelWithCue}
          />
        )}
        {menu.state.panel === "TRIP" && (
          <PanelTrip
            itinerary={currentItinerary}
            userLocation={userLocation}
            listIndex={menu.state.listIndex}
            isLoading={isLoading}
            onPlan={handleSend}
          />
        )}
        {menu.state.panel === "SETTINGS" && (
          <PanelSettings
            listIndex={menu.state.listIndex}
            onChange={setPreferences}
            onSelect={selectListItem}
          />
        )}
        {menu.state.panel === "FLIGHTS" && (
          <PanelFlights
            itinerary={currentItinerary}
            listIndex={menu.state.listIndex}
            onSelect={selectListItem}
          />
        )}
        {menu.state.panel === "HOTELS" && (
          <PanelHotels
            itinerary={currentItinerary}
            listIndex={menu.state.listIndex}
            onSelect={selectListItem}
          />
        )}
        {menu.state.panel === "DAYS" && (
          <PanelDays
            itinerary={currentItinerary}
            listIndex={menu.state.listIndex}
            onSelect={selectListItem}
          />
        )}
        {menu.state.panel === "HISTORY" && (
          <PanelHistory messages={messages} listIndex={menu.state.listIndex} />
        )}
      </MenuShell>

      {/* Bottom-center subtitle bar with auto-TTS */}
      <Subtitle text={subtitles.current} />

      {/* Chat popover (opens on Enter / Cmd+K) */}
      <ChatPopover
        open={chatPopoverOpen}
        onSend={handleSend}
        onClose={() => setChatPopoverOpen(false)}
        isLoading={isLoading}
      />
    </div>
  );
}

export default App;
