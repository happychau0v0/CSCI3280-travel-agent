import { useCallback, useEffect, useState } from "react";
import ChatWindow from "./components/ChatWindow";
import ItineraryCard from "./components/ItineraryCard";
import MapView from "./components/MapView";
import ProfilePanel from "./components/ProfilePanel";
import { postChat } from "./api/client";
import "./App.css";

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
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ messages, itinerary }),
    );
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

  // Persist on every change
  useEffect(() => {
    saveState(messages, currentItinerary);
  }, [messages, currentItinerary]);

  const handleSend = useCallback(
    async (text) => {
      const userMsg = { role: "user", content: text };
      const history = messages.map((m) => ({ role: m.role, content: m.content }));

      setMessages((prev) => [...prev, userMsg]);
      setIsLoading(true);

      try {
        const data = await postChat(text, history, preferences);
        const assistantMsg = {
          role: "assistant",
          content: data.reply,
        };
        setMessages((prev) => [...prev, assistantMsg]);
        if (data.itinerary) {
          setCurrentItinerary(data.itinerary);
        }
      } catch (err) {
        setMessages((prev) => [
          ...prev,
          { role: "assistant", content: `⚠ ${err.message}` },
        ]);
      } finally {
        setIsLoading(false);
      }
    },
    [messages, preferences],
  );

  const handleClear = useCallback(() => {
    setMessages([]);
    setCurrentItinerary(null);
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      // ignore
    }
  }, []);

  return (
    <div className="app">
      <header className="app-header">
        <h1>AI Travel Agent</h1>
        <span className="tagline">Plan trips with real data, not hallucinations</span>
        <div className="header-spacer" />
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
      </header>
      <div className="app-body">
        <ChatWindow
          messages={messages}
          onSend={handleSend}
          isLoading={isLoading}
        />
        {currentItinerary && (
          <aside className="sidebar">
            <MapView itinerary={currentItinerary} />
            <ItineraryCard itinerary={currentItinerary} />
          </aside>
        )}
      </div>
    </div>
  );
}

export default App;
