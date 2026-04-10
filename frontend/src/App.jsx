import { useCallback, useState } from "react";
import ChatWindow from "./components/ChatWindow";
import ItineraryCard from "./components/ItineraryCard";
import { postChat } from "./api/client";
import "./App.css";

function App() {
  const [messages, setMessages] = useState([]);
  const [currentItinerary, setCurrentItinerary] = useState(null);
  const [isLoading, setIsLoading] = useState(false);

  const handleSend = useCallback(
    async (text) => {
      const userMsg = { role: "user", content: text };
      // Build history from current messages BEFORE adding the new user message
      const history = messages.map((m) => ({ role: m.role, content: m.content }));

      setMessages((prev) => [...prev, userMsg]);
      setIsLoading(true);

      try {
        const data = await postChat(text, history);
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
    [messages]
  );

  return (
    <div className="app">
      <header className="app-header">
        <h1>AI Travel Agent</h1>
        <span className="tagline">Plan trips with real data, not hallucinations</span>
      </header>
      <div className="app-body">
        <ChatWindow
          messages={messages}
          onSend={handleSend}
          isLoading={isLoading}
        />
        {currentItinerary && (
          <aside className="sidebar">
            <ItineraryCard itinerary={currentItinerary} />
          </aside>
        )}
      </div>
    </div>
  );
}

export default App;
