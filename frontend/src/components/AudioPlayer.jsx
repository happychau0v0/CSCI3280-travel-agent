import { useEffect, useRef, useState } from "react";

/** Strip markdown/JSON from text before TTS. */
function cleanText(raw) {
  return (raw || "")
    .replace(/```json[\s\S]*?```/g, "")
    .replace(/```[\s\S]*?```/g, "")
    .replace(/\*\*/g, "")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Pick the best available browser voice.
 * Priority: Google neural > Google any > high-quality system voices > default.
 * On Chrome, "Google US English" / "Google UK English Female" are neural-quality.
 * On macOS Safari, "Samantha" and "Karen" are high quality.
 */
function pickBestVoice(voices) {
  if (!voices || voices.length === 0) return null;

  const en = voices.filter((v) => /^en[-_]/i.test(v.lang));
  if (en.length === 0) return voices[0];

  // 1. Google neural voices on Chrome
  const googleNeural = en.find((v) =>
    /Google (US|UK) English Female/i.test(v.name)
  );
  if (googleNeural) return googleNeural;

  // 2. Any Google voice
  const googleAny = en.find((v) => /Google/i.test(v.name));
  if (googleAny) return googleAny;

  // 3. High-quality named system voices (macOS / Windows)
  const named = en.find((v) =>
    /Samantha|Karen|Moira|Tessa|Fiona|Microsoft Zira|Microsoft David/i.test(v.name)
  );
  if (named) return named;

  // 4. First English voice
  return en[0];
}

/**
 * Speak text aloud. Tries the backend /speech/tts endpoint first (Google Cloud
 * TTS Neural2 — sounds like a real human). Falls back to browser
 * SpeechSynthesis with the best available voice if the backend returns 503.
 */
export default function AudioPlayer({ text }) {
  const [state, setState] = useState("idle"); // "idle" | "loading" | "playing"
  const audioRef = useRef(null);
  const voicesRef = useRef(null);

  // Pre-load voices list (Chrome requires a non-empty getVoices() call after
  // the voiceschanged event to populate the list).
  useEffect(() => {
    const load = () => {
      voicesRef.current = window.speechSynthesis?.getVoices() || [];
    };
    load();
    window.speechSynthesis?.addEventListener("voiceschanged", load);
    return () => {
      window.speechSynthesis?.removeEventListener("voiceschanged", load);
    };
  }, []);

  // Stop audio on unmount
  useEffect(() => {
    return () => {
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current = null;
      }
      window.speechSynthesis?.cancel();
    };
  }, []);

  const speakBrowser = (spoken) => {
    if (!window.speechSynthesis) return;
    const utterance = new SpeechSynthesisUtterance(spoken);
    utterance.rate = 1.0;
    utterance.pitch = 0.0;
    // Use best available voice
    const best = pickBestVoice(voicesRef.current);
    if (best) utterance.voice = best;
    utterance.onend = () => setState("idle");
    utterance.onerror = () => setState("idle");
    window.speechSynthesis.speak(utterance);
    setState("playing");
  };

  const handleClick = async () => {
    if (state === "playing") {
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current = null;
      }
      window.speechSynthesis?.cancel();
      setState("idle");
      return;
    }

    const spoken = cleanText(text);
    if (!spoken) return;

    setState("loading");

    try {
      const res = await fetch("/speech/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: spoken }),
      });

      if (res.status === 503 || res.status === 204) {
        // TTS API not available — fall back to browser
        speakBrowser(spoken);
        return;
      }
      if (!res.ok) throw new Error(`TTS HTTP ${res.status}`);

      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      audioRef.current = audio;

      audio.onended = () => {
        URL.revokeObjectURL(url);
        audioRef.current = null;
        setState("idle");
      };
      audio.onerror = () => {
        URL.revokeObjectURL(url);
        audioRef.current = null;
        setState("idle");
      };

      setState("playing");
      audio.play();
    } catch {
      // Network error — fall back to browser
      speakBrowser(spoken);
    }
  };

  return (
    <button
      type="button"
      className={`audio-btn${state !== "idle" ? " speaking" : ""}`}
      onClick={handleClick}
      title={state === "playing" ? "Stop" : state === "loading" ? "Loading…" : "Listen"}
      aria-label={state === "playing" ? "Stop speaking" : "Read aloud"}
      disabled={state === "loading"}
    >
      {state === "loading" ? "…" : state === "playing" ? "■" : "🔊"}
    </button>
  );
}
