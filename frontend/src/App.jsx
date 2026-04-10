import { useCallback, useEffect, useState } from "react";
import ChatWindow from "./components/ChatWindow";
import ItineraryCard from "./components/ItineraryCard";
import ProfilePanel from "./components/ProfilePanel";
import ErrorBanner from "./components/ErrorBanner";
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
  const [error, setError] = useState(null);

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

      setError(null);
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
        setError(err);
      } finally {
        setIsLoading(false);
      }
    },
    [messages, preferences],
  );

  // Keyboard shortcuts: Cmd/Ctrl+K focuses input, Esc stops TTS + voice
  useEffect(() => {
    const handleKey = (e) => {
      const key = e.key?.toLowerCase();
      if ((e.metaKey || e.ctrlKey) && key === "k") {
        e.preventDefault();
        const input = document.querySelector('.chat-input-form input[type="text"]');
        input?.focus();
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
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      // ignore
    }
  }, []);

  return (
    <div className="app">
      <ErrorBanner error={error} onDismiss={() => setError(null)} />
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
            <ItineraryCard
              itinerary={currentItinerary}
              onItineraryUpdate={setCurrentItinerary}
            />
          </aside>
        )}
      </div>
    </div>
  );
}

export default App;
