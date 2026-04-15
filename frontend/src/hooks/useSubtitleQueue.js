import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { API_BASE } from "../api/client";

/**
 * Split a paragraph into sentences for subtitle display.
 * Splits on .!? followed by whitespace; preserves the punctuation.
 */
export function splitSentences(text) {
  if (!text) return [];
  // Pre-clean: strip code fences, bold, entire heading lines, em-dashes
  const clean = text
    .replace(/```[\s\S]*?```/g, "")
    .replace(/\*\*/g, "")
    .replace(/^#{1,6}\s.*$/gm, "")    // strip entire heading lines (including their text)
    .replace(/\s—\s/g, ", ")           // em-dash: " — " → ", "
    .replace(/\s+/g, " ")
    .trim();
  if (!clean) return [];
  // Split on sentence boundaries; lookbehind keeps the punctuation.
  // Then strip list prefixes per-sentence so "- item" and "2. item"
  // work whether the marker is at string start or mid-sentence position.
  return clean
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.replace(/^([-•*]|\d+[.)])\s*/, "").trim())
    .filter(Boolean);
}

/**
 * Fetch a sentence from the backend TTS endpoint.
 * Returns { url: string } (blob URL) on success, or null to trigger
 * browser SpeechSynthesis fallback (503 / 204 / network error).
 * Caller must call URL.revokeObjectURL(url) when done.
 */
async function fetchTTS(text, signal) {
  try {
    const res = await fetch(`${API_BASE}/speech/tts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
      signal,
    });
    if (res.status === 503 || res.status === 204 || !res.ok) return null;
    const blob = await res.blob();
    return { url: URL.createObjectURL(blob) };
  } catch (err) {
    if (err.name === "AbortError") throw err; // let caller handle abort
    return null; // network / other error → fallback
  }
}

/**
 * FIFO subtitle queue with backend TTS (xAI "ara" voice) and browser
 * SpeechSynthesis fallback.
 *
 * Each queued item is an object { text, spoken } where `spoken: false`
 * means the text displays as a subtitle but is NOT read aloud.
 *
 * Audio advance is driven by HTMLAudioElement.onended so pacing matches
 * actual speech duration. A 15-second safety timer fires if onended
 * never arrives (browser bug, 0-duration audio).
 *
 * When the backend returns 503 (key missing / rate-limited), the queue
 * silently falls back to window.speechSynthesis for that sentence and
 * uses a displayMs timer instead of onended.
 *
 * A 1-sentence lookahead fetch hides the ~300–500ms backend TTS latency:
 * while sentence N plays, sentence N+1 is already being fetched.
 *
 * The backend voice ("ara") and browser fallback voice/rate are fixed —
 * no user-configurable TTS settings beyond mute.
 */
export function useSubtitleQueue({
  muted = false,
} = {}) {
  const [current, setCurrent] = useState(null);
  const [history, setHistory] = useState([]);
  const currentRef = useRef(null);
  const queueRef = useRef([]);
  const safetyTimerRef = useRef(null);
  const safetyDelayRef = useRef(0);
  const speakingRef = useRef(false);
  const mutedRef = useRef(muted);
  const pausedRef = useRef(false);

  // New refs for async audio management
  const pendingFetchRef = useRef(null);  // AbortController for current fetch
  const lookaheadRef = useRef(null);     // { text, controller, promise }
  const currentAudioRef = useRef(null);  // playing HTMLAudioElement

  const setCurrentBoth = useCallback((v) => {
    currentRef.current = v;
    setCurrent(v);
  }, []);

  // Keep refs in sync with props
  useEffect(() => {
    mutedRef.current = muted;
    if (muted) {
      currentAudioRef.current?.pause();
      if (typeof window !== "undefined" && window.speechSynthesis) {
        window.speechSynthesis.cancel();
      }
    }
  }, [muted]);
  // Pick the best available browser voice for the fallback path.
  // Auto-select the best available English browser voice.
  // Priority: Google Neural Female > any Google > Samantha/Karen/named > first English.
  const pickVoice = useCallback(() => {
    if (typeof window === "undefined" || !window.speechSynthesis) return null;
    try {
      const voices = window.speechSynthesis.getVoices() || [];
      if (voices.length === 0) return null;
      const en = voices.filter((v) => /^en[-_]/i.test(v.lang));
      if (en.length === 0) return voices[0];
      const googleNeural = en.find((v) => /Google (US|UK) English Female/i.test(v.name));
      if (googleNeural) return googleNeural;
      const googleAny = en.find((v) => /Google/i.test(v.name));
      if (googleAny) return googleAny;
      const named = en.find((v) =>
        /Samantha|Karen|Moira|Tessa|Fiona|Microsoft Zira|Microsoft David/i.test(v.name)
      );
      if (named) return named;
      return en[0];
    } catch {
      return null;
    }
  }, []);

  // Browser SpeechSynthesis fallback — fire-and-forget (no onend hook to
  // avoid cascade on headless browsers where events fire synchronously).
  const speakBrowserFallback = useCallback((text) => {
    if (typeof window === "undefined" || !window.speechSynthesis) return;
    try {
      window.speechSynthesis.cancel();
      const utter = new SpeechSynthesisUtterance(text);
      utter.rate = 1.0;
      utter.pitch = 1.0;
      const voice = pickVoice();
      if (voice) utter.voice = voice;
      window.speechSynthesis.speak(utter);
    } catch {
      // ignore TTS errors — display still works
    }
  }, [pickVoice]);

  // advance is defined via ref so it can be called from audio event handlers
  // without stale closure issues.
  const advanceRef = useRef(null);

  const advance = useCallback(async () => {
    // Clear any pending safety timer
    if (safetyTimerRef.current) {
      clearTimeout(safetyTimerRef.current);
      safetyTimerRef.current = null;
    }

    // Stop currently playing audio
    if (currentAudioRef.current) {
      currentAudioRef.current.onended = null;
      currentAudioRef.current.onerror = null;
      currentAudioRef.current.pause();
      currentAudioRef.current = null;
    }

    // Cancel any in-flight fetch for the previous sentence
    if (pendingFetchRef.current) {
      pendingFetchRef.current.abort();
      pendingFetchRef.current = null;
    }

    const next = queueRef.current.shift();
    if (!next) {
      setCurrentBoth(null);
      speakingRef.current = false;
      return;
    }

    const { text, spoken } = next;

    // Show subtitle immediately — don't wait for audio fetch
    setCurrentBoth(text);

    // Track subtitle history (exclude user echoes)
    if (spoken !== false) {
      setHistory((prev) => {
        const next2 = [...prev, text];
        return next2.length > 20 ? next2.slice(-20) : next2;
      });
    }

    const speak = spoken && !mutedRef.current &&
      typeof window !== "undefined";

    // Display duration for fallback timer (~60ms/char, clamped 2.5–6s)
    const displayMs = Math.max(2500, Math.min(text.length * 60, 6000));
    safetyDelayRef.current = displayMs;

    if (!speak) {
      if (!pausedRef.current) {
        safetyTimerRef.current = setTimeout(() => advanceRef.current?.(), displayMs);
      }
      return;
    }

    // --- Fetch audio from backend ---

    let audioResult = null;

    // Check if the lookahead already prefetched this sentence
    if (lookaheadRef.current && lookaheadRef.current.text === text) {
      try {
        audioResult = await lookaheadRef.current.promise;
      } catch {
        audioResult = null;
      }
      lookaheadRef.current = null;
    } else {
      // Cancel stale lookahead (queue order changed)
      if (lookaheadRef.current) {
        lookaheadRef.current.controller.abort();
        lookaheadRef.current = null;
      }
      // Fetch current sentence
      const controller = new AbortController();
      pendingFetchRef.current = controller;
      try {
        audioResult = await fetchTTS(text, controller.signal);
      } catch (err) {
        if (err.name === "AbortError") return; // clear() was called mid-fetch
        audioResult = null;
      }
      pendingFetchRef.current = null;
    }

    // Kick off lookahead fetch for the next queued sentence
    const nextItem = queueRef.current[0];
    if (nextItem && nextItem.spoken !== false && !mutedRef.current) {
      const lac = new AbortController();
      const laPromise = fetchTTS(nextItem.text, lac.signal).catch(() => null);
      lookaheadRef.current = { text: nextItem.text, controller: lac, promise: laPromise };
    }

    // --- Fallback to browser TTS if backend returned null ---
    if (audioResult === null) {
      speakBrowserFallback(text);
      if (!pausedRef.current) {
        safetyTimerRef.current = setTimeout(() => advanceRef.current?.(), displayMs);
      }
      return;
    }

    // --- Play audio from backend ---
    const { url } = audioResult;
    const audio = new Audio(url);
    currentAudioRef.current = audio;

    // Safety timer: if onended never fires (browser bug, 0-duration)
    const safetyMs = Math.max(15000, text.length * 80);
    safetyTimerRef.current = setTimeout(() => {
      URL.revokeObjectURL(url);
      currentAudioRef.current = null;
      advanceRef.current?.();
    }, safetyMs);

    audio.onended = () => {
      clearTimeout(safetyTimerRef.current);
      safetyTimerRef.current = null;
      URL.revokeObjectURL(url);
      currentAudioRef.current = null;
      if (!pausedRef.current) advanceRef.current?.();
    };

    audio.onerror = () => {
      clearTimeout(safetyTimerRef.current);
      safetyTimerRef.current = null;
      URL.revokeObjectURL(url);
      currentAudioRef.current = null;
      // Audio decode error → fall back to browser TTS for this sentence
      speakBrowserFallback(text);
      if (!pausedRef.current) {
        safetyTimerRef.current = setTimeout(() => advanceRef.current?.(), displayMs);
      }
    };

    if (!pausedRef.current) {
      audio.play().catch(() => {
        // play() rejected (autoplay policy, etc.) → fall back
        clearTimeout(safetyTimerRef.current);
        safetyTimerRef.current = null;
        URL.revokeObjectURL(url);
        currentAudioRef.current = null;
        speakBrowserFallback(text);
        if (!pausedRef.current) {
          safetyTimerRef.current = setTimeout(() => advanceRef.current?.(), displayMs);
        }
      });
    }
  }, [setCurrentBoth, speakBrowserFallback]);

  // Keep advanceRef current so audio event handlers always call the latest version
  useEffect(() => {
    advanceRef.current = advance;
  }, [advance]);

  const pause = useCallback(() => {
    pausedRef.current = true;
    if (safetyTimerRef.current) {
      clearTimeout(safetyTimerRef.current);
      safetyTimerRef.current = null;
    }
    currentAudioRef.current?.pause();
    if (typeof window !== "undefined" && window.speechSynthesis) {
      try { window.speechSynthesis.pause?.(); } catch { /* ignore */ }
    }
  }, []);

  const resume = useCallback(() => {
    if (!pausedRef.current) return;
    pausedRef.current = false;

    if (currentAudioRef.current) {
      // Resume backend audio — onended will call advance() when done
      currentAudioRef.current.play().catch(() => {
        currentAudioRef.current = null;
        advance();
      });
      return;
    }

    // Browser TTS fallback path or silent item — use timer
    if (typeof window !== "undefined" && window.speechSynthesis) {
      try { window.speechSynthesis.resume?.(); } catch { /* ignore */ }
    }
    if (currentRef.current && !safetyTimerRef.current) {
      const remaining = Math.max(1000, safetyDelayRef.current || 2500);
      safetyTimerRef.current = setTimeout(() => advanceRef.current?.(), remaining);
    }
  }, [advance]);

  const push = useCallback(
    (text, opts = {}) => {
      if (!text) return;
      const spoken = opts.spoken !== false; // default true
      queueRef.current.push({ text, spoken });
      if (!currentRef.current && !speakingRef.current) {
        speakingRef.current = true;
        advance();
      }
    },
    [advance],
  );

  const pushParagraph = useCallback(
    (paragraph, opts = {}) => {
      const sentences = splitSentences(paragraph);
      for (const s of sentences) push(s, opts);
    },
    [push],
  );

  const clear = useCallback(() => {
    queueRef.current = [];

    // Cancel in-flight fetch
    pendingFetchRef.current?.abort();
    pendingFetchRef.current = null;

    // Cancel lookahead fetch
    lookaheadRef.current?.controller?.abort();
    lookaheadRef.current = null;

    // Stop playing audio
    if (currentAudioRef.current) {
      currentAudioRef.current.onended = null;
      currentAudioRef.current.onerror = null;
      currentAudioRef.current.pause();
      currentAudioRef.current = null;
    }

    if (safetyTimerRef.current) {
      clearTimeout(safetyTimerRef.current);
      safetyTimerRef.current = null;
    }
    setCurrentBoth(null);
    speakingRef.current = false;
    if (typeof window !== "undefined" && window.speechSynthesis) {
      window.speechSynthesis.cancel();
    }
  }, [setCurrentBoth]);

  // Cleanup on unmount
  useEffect(() => {
    return () => { clear(); };
  }, [clear]);

  const clearHistory = useCallback(() => setHistory([]), []);

  return useMemo(
    () => ({ current, history, push, pushParagraph, clear, clearHistory, pause, resume }),
    [current, history, push, pushParagraph, clear, clearHistory, pause, resume],
  );
}
