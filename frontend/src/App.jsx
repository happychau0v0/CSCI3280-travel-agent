import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from "react";
import ChatWindow from "./components/ChatWindow";
import InputDock from "./components/InputDock";
import ItineraryDrawer from "./components/ItineraryDrawer";
import ProfilePanel from "./components/ProfilePanel";
import ErrorBanner from "./components/ErrorBanner";
import LiveTicker from "./components/LiveTicker";
import FullscreenButton from "./components/FullscreenButton";
import TripDateModal from "./components/TripDateModal";
import { streamChat } from "./api/client";
import { useGeolocation } from "./hooks/useGeolocation";
import "./App.css";

const TRIP_DATES_KEY = "travel-trip-dates";
const TRIP_INTENT_REGEX =
  /\b(trip|visit|travel|plan a|go to|fly to|holiday in|vacation in|tour of)\b/i;

function loadTripDates() {
  try {
    const raw = localStorage.getItem(TRIP_DATES_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function saveTripDates(dates) {
  try {
    if (dates) localStorage.setItem(TRIP_DATES_KEY, JSON.stringify(dates));
    else localStorage.removeItem(TRIP_DATES_KEY);
  } catch {
    // ignore
  }
}

// Lazy-load the globe so the Three.js bundle doesn't block first paint.
const GlobeView = lazy(() => import("./components/GlobeView"));

const STORAGE_KEY = "travel-chat-state";

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
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
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ messages, itinerary }));
  } catch {
    // Storage may be unavailable; fail silently
  }
}

function App() {
  const initial = loadState();
  const [messages, setMessages] = useState(initial.messages);
  const [currentItinerary, setCurrentItinerary] = useState(initial.itinerary);
  const [isLoading, setIsLoading] = useState(false);
  const [preferences, setPreferences] = useState(null);
  const [error, setError] = useState(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [lastAction, setLastAction] = useState("");
  const [currentTool, setCurrentTool] = useState(null);
  const [tripDates, setTripDates] = useState(() => loadTripDates());
  const [dateModalOpen, setDateModalOpen] = useState(false);
  const pendingMessageRef = useRef(null); // message waiting for date confirmation
  const { location: userLocation, requestPermission } = useGeolocation();

  // Persist on every change
  useEffect(() => {
    saveState(messages, currentItinerary);
  }, [messages, currentItinerary]);

  // Auto-open the drawer the first time an itinerary lands
  useEffect(() => {
    if (currentItinerary && !drawerOpen) {
      setDrawerOpen(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentItinerary?.title, currentItinerary?.destination]);

  const handleSend = useCallback(
    async (text) => {
      // Trip-intent gate: if the message looks like a trip request and we
      // don't have dates yet, intercept and pop the date modal first.
      if (!tripDates && TRIP_INTENT_REGEX.test(text)) {
        pendingMessageRef.current = text;
        setDateModalOpen(true);
        return;
      }

      const userMsg = { role: "user", content: text };
      const history = messages.map((m) => ({ role: m.role, content: m.content }));

      setMessages((prev) => [...prev, userMsg]);
      setIsLoading(true);
      setError(null);

      try {
        setLastAction("Thinking…");
        setCurrentTool(null);
        const data = await streamChat({
          message: text,
          history,
          preferences,
          userLocation,
          tripDates,
          onEvent: ({ type, data: payload }) => {
            if (type === "tool_start") {
              setCurrentTool(payload.name);
              setLastAction(`Calling ${payload.name}`);
            } else if (type === "tool_end") {
              setCurrentTool(null);
              setLastAction(`Finished ${payload.name}`);
            } else if (type === "done") {
              setCurrentTool(null);
            }
          },
        });
        if (!data) throw new Error("Stream ended without a response");
        const assistantMsg = { role: "assistant", content: data.reply };
        setMessages((prev) => [...prev, assistantMsg]);
        if (data.itinerary) {
          setCurrentItinerary(data.itinerary);
        }
        setLastAction("Ready");
      } catch (err) {
        setError(err);
        setLastAction("Error");
        setCurrentTool(null);
      } finally {
        setIsLoading(false);
      }
    },
    [messages, preferences, userLocation, tripDates],
  );

  // Modal callbacks
  const handleDatesConfirmed = useCallback(
    (dates) => {
      setTripDates(dates);
      saveTripDates(dates);
      setDateModalOpen(false);
      const pending = pendingMessageRef.current;
      pendingMessageRef.current = null;
      if (pending) {
        // Now that dates are set, replay the original message — handleSend
        // will skip the gate this time because tripDates is non-null.
        // We can't call handleSend directly (the closure has the old
        // tripDates), so re-trigger via a microtask.
        queueMicrotask(() => handleSendWithDates(pending, dates));
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const handleDatesSkipped = useCallback(() => {
    setDateModalOpen(false);
    const pending = pendingMessageRef.current;
    pendingMessageRef.current = null;
    if (pending) {
      // Mark dates as null-but-asked so we don't loop the modal forever
      saveTripDates({ start: null, end: null });
      setTripDates({ start: null, end: null });
      queueMicrotask(() => handleSendWithDates(pending, null));
    }
  }, []);

  // Internal helper that bypasses the trip-intent gate (used after the
  // modal resolves so we don't re-prompt on the same message).
  const handleSendWithDates = useCallback(
    async (text, dates) => {
      const userMsg = { role: "user", content: text };
      const history = messages.map((m) => ({ role: m.role, content: m.content }));

      setMessages((prev) => [...prev, userMsg]);
      setIsLoading(true);
      setError(null);

      try {
        setLastAction("Thinking…");
        setCurrentTool(null);
        const data = await streamChat({
          message: text,
          history,
          preferences,
          userLocation,
          tripDates: dates,
          onEvent: ({ type, data: payload }) => {
            if (type === "tool_start") {
              setCurrentTool(payload.name);
              setLastAction(`Calling ${payload.name}`);
            } else if (type === "tool_end") {
              setCurrentTool(null);
              setLastAction(`Finished ${payload.name}`);
            } else if (type === "done") {
              setCurrentTool(null);
            }
          },
        });
        if (!data) throw new Error("Stream ended without a response");
        const assistantMsg = { role: "assistant", content: data.reply };
        setMessages((prev) => [...prev, assistantMsg]);
        if (data.itinerary) setCurrentItinerary(data.itinerary);
        setLastAction("Ready");
      } catch (err) {
        setError(err);
        setLastAction("Error");
        setCurrentTool(null);
      } finally {
        setIsLoading(false);
      }
    },
    [messages, preferences, userLocation],
  );

  // Trigger the GPS prompt on the first user gesture so browsers don't
  // reject it as unsolicited.
  useEffect(() => {
    if (userLocation) return;
    const onFirstGesture = () => {
      requestPermission();
      window.removeEventListener("pointerdown", onFirstGesture);
    };
    window.addEventListener("pointerdown", onFirstGesture, { once: true });
    return () => window.removeEventListener("pointerdown", onFirstGesture);
  }, [userLocation, requestPermission]);

  // Keyboard shortcuts: Cmd/Ctrl+K focuses input, Esc stops TTS
  useEffect(() => {
    const handleKey = (e) => {
      const key = e.key?.toLowerCase();
      if ((e.metaKey || e.ctrlKey) && key === "k") {
        e.preventDefault();
        document.querySelector('.input-dock input[type="text"]')?.focus();
      } else if (key === "escape") {
        if (window.speechSynthesis?.speaking) {
          window.speechSynthesis.cancel();
        }
      }
    };
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, []);

  const handleClear = useCallback(() => {
    setMessages([]);
    setCurrentItinerary(null);
    setDrawerOpen(false);
    setTripDates(null);
    saveTripDates(null);
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      // ignore
    }
  }, []);

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

    // Activity dots
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

    // Hotel dots
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

      {/* Background globe — always rendered */}
      <Suspense fallback={<div className="globe-loading">Loading globe…</div>}>
        <GlobeView
          userLocation={userLocation}
          arcs={arcs}
          points={points}
          drawerOpen={drawerOpen}
        />
      </Suspense>

      {/* Top-left LIVE ticker */}
      <LiveTicker
        userLocation={userLocation}
        isLoading={isLoading}
        lastAction={lastAction}
        currentTool={currentTool}
      />

      {/* Top-right controls */}
      <div className="top-right-controls">
        {(messages.length > 0 || currentItinerary) && (
          <button
            type="button"
            className="clear-btn"
            onClick={handleClear}
            title="Clear chat history"
          >
            Clear
          </button>
        )}
        <ProfilePanel onChange={setPreferences} />
      </div>

      {/* Chat overlay */}
      <ChatWindow messages={messages} isLoading={isLoading} />

      {/* Bottom-left input dock + fullscreen toggle */}
      <InputDock
        onSend={handleSend}
        isLoading={isLoading}
        userLocation={userLocation}
      />
      <FullscreenButton />

      {/* Slide-in itinerary drawer */}
      <ItineraryDrawer
        itinerary={currentItinerary}
        isOpen={drawerOpen}
        onOpen={() => setDrawerOpen(true)}
        onClose={() => setDrawerOpen(false)}
        onItineraryUpdate={setCurrentItinerary}
      />

      {/* Trip date modal — pops on first trip request */}
      <TripDateModal
        open={dateModalOpen}
        onConfirm={handleDatesConfirmed}
        onCancel={handleDatesSkipped}
      />
    </div>
  );
}

export default App;
