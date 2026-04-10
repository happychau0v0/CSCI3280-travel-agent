import { useState } from "react";
import VoiceRecorder from "./VoiceRecorder";

/**
 * Bottom-left fixed input dock — replaces the in-chat input form.
 * Frosted-glass pill with voice button, text input, and send button.
 */
export default function InputDock({ onSend, isLoading, userLocation }) {
  const [input, setInput] = useState("");

  const handleSubmit = (e) => {
    e.preventDefault();
    const trimmed = input.trim();
    if (!trimmed || isLoading) return;
    onSend(trimmed);
    setInput("");
  };

  const handleVoiceResult = (transcript) => {
    if (transcript?.trim()) onSend(transcript.trim());
  };

  return (
    <form className="input-dock" onSubmit={handleSubmit}>
      <VoiceRecorder onResult={handleVoiceResult} disabled={isLoading} />
      <input
        type="text"
        value={input}
        onChange={(e) => setInput(e.target.value)}
        placeholder={
          userLocation?.city
            ? `Plan a trip from ${userLocation.city}…`
            : "Plan a 3-day trip to Tokyo…"
        }
        disabled={isLoading}
      />
      <button type="submit" disabled={!input.trim() || isLoading}>
        {isLoading ? "…" : "→"}
      </button>
    </form>
  );
}
