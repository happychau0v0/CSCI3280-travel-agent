import { useRef, useState } from "react";

/**
 * Voice input via the browser Web Speech API.
 * Calls onResult(transcript) when speech is recognized.
 */
export default function VoiceRecorder({ onResult, disabled = false }) {
  const [isListening, setIsListening] = useState(false);
  const recognitionRef = useRef(null);

  const supported =
    typeof window !== "undefined" &&
    (window.SpeechRecognition || window.webkitSpeechRecognition);

  const toggleListening = () => {
    if (!supported) {
      alert("Speech recognition is not supported in this browser. Try Chrome or Edge.");
      return;
    }

    if (isListening) {
      recognitionRef.current?.stop();
      setIsListening(false);
      return;
    }

    const SpeechRecognition =
      window.SpeechRecognition || window.webkitSpeechRecognition;
    const recognition = new SpeechRecognition();
    recognition.lang = "en-US";
    recognition.interimResults = false;
    recognition.maxAlternatives = 1;

    recognition.onresult = (event) => {
      const transcript = event.results[0][0].transcript;
      onResult?.(transcript);
      setIsListening(false);
    };
    recognition.onerror = () => setIsListening(false);
    recognition.onend = () => setIsListening(false);

    recognitionRef.current = recognition;
    recognition.start();
    setIsListening(true);
  };

  return (
    <button
      type="button"
      className={`voice-btn${isListening ? " listening" : ""}`}
      onClick={toggleListening}
      disabled={disabled}
      title={isListening ? "Stop listening" : "Speak"}
      aria-label={isListening ? "Stop listening" : "Start voice input"}
    >
      {isListening ? "■" : "🎤"}
    </button>
  );
}
