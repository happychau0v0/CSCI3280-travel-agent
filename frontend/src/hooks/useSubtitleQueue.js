import { useCallback, useEffect, useMemo, useRef, useState } from "react";

/**
 * Split a paragraph into sentences for subtitle display.
 * Splits on .!? followed by whitespace; preserves the punctuation.
 */
export function splitSentences(text) {
  if (!text) return [];
  // Strip markdown bold/code blocks first
  const clean = text
    .replace(/```[\s\S]*?```/g, "")
    .replace(/\*\*/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!clean) return [];
  // Split on sentence boundaries; lookbehind keeps the punctuation
  return clean
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * FIFO subtitle queue with optional auto-TTS.
 *
 * Each queued item is an object { text, spoken } where `spoken: false`
 * means the text displays as a subtitle but is NOT read aloud. The echo
 * of the user's own message ("▸ Sent: …") uses `spoken: false` so the
 * user doesn't hear their own typing read back (R9-A2).
 *
 * Advance is driven by the speechSynthesis `onend` event rather than
 * a fixed setTimeout, so long tool waits hold the current subtitle
 * silently instead of looping the narration every 2.5s (R9-D). A
 * safety timer (15s for spoken, 6s for silent) still fires if onend
 * never arrives (e.g. TTS unsupported, or an empty-queue state).
 *
 * `rate` and `voiceName` are passed in from App.jsx (sourced from the
 * user's SETTINGS overlay choices) and apply per-utterance. Both are
 * mirrored into refs so the advance loop reads fresh values without
 * being re-memoized on every keystroke (R9-C / B5).
 *
 * Returns:
 *   {
 *     current,                  // string | null — currently displayed sentence
 *     push(text, opts),         // enqueue a single sentence { spoken=true }
 *     pushParagraph(text, opts),// split into sentences and enqueue all
 *     clear(),                  // empty the queue and stop speaking
 *   }
 */
export function useSubtitleQueue({
  muted = false,
  rate = 1.15,
  voiceName = null,
} = {}) {
  const [current, setCurrent] = useState(null);
  const [history, setHistory] = useState([]);
  const currentRef = useRef(null);
  const queueRef = useRef([]);
  const safetyTimerRef = useRef(null);
  const safetyDelayRef = useRef(0);
  const speakingRef = useRef(false);
  const mutedRef = useRef(muted);
  const rateRef = useRef(rate);
  const voiceNameRef = useRef(voiceName);
  // Round 18 — pause state. While paused, the advance timer is
  // cleared and the current line stays visible indefinitely. On
  // resume, a fresh timer is scheduled for the remaining time.
  const pausedRef = useRef(false);

  const setCurrentBoth = useCallback((v) => {
    currentRef.current = v;
    setCurrent(v);
  }, []);

  // Keep mutedRef / rateRef / voiceNameRef in sync so the advance loop
  // reads the latest values without needing to re-memoize.
  useEffect(() => {
    mutedRef.current = muted;
    if (muted && typeof window !== "undefined" && window.speechSynthesis) {
      window.speechSynthesis.cancel();
    }
  }, [muted]);
  useEffect(() => {
    rateRef.current = rate;
  }, [rate]);
  useEffect(() => {
    voiceNameRef.current = voiceName;
  }, [voiceName]);

  // Look up a voice by name from speechSynthesis.getVoices(). Returns
  // null if unsupported or not found, letting the browser pick the
  // default. The list is sometimes async-loaded (Chrome), so we read
  // it fresh on every utterance.
  const findVoice = useCallback((name) => {
    if (!name) return null;
    if (typeof window === "undefined" || !window.speechSynthesis) return null;
    try {
      const voices = window.speechSynthesis.getVoices() || [];
      return voices.find((v) => v.name === name) || null;
    } catch {
      return null;
    }
  }, []);

  const advance = useCallback(() => {
    if (safetyTimerRef.current) {
      clearTimeout(safetyTimerRef.current);
      safetyTimerRef.current = null;
    }
    const next = queueRef.current.shift();
    if (!next) {
      setCurrentBoth(null);
      speakingRef.current = false;
      return;
    }
    const { text, spoken } = next;
    setCurrentBoth(text);
    // Round 16 — track the last ~20 subtitles so the user can scroll
    // back through missed narration via the Subtitle history popover.
    // User echoes (spoken=false) are excluded from history since
    // they're just the prompt preview.
    if (spoken !== false) {
      setHistory((prev) => {
        const next2 = [...prev, text];
        return next2.length > 20 ? next2.slice(-20) : next2;
      });
    }

    const speak = spoken && !mutedRef.current &&
      typeof window !== "undefined" && window.speechSynthesis;

    // Display duration for the subtitle: ~60ms/char, clamped to a
    // 2.5-6s window. Short enough not to stall the queue in
    // headless browsers where TTS isn't wired; long enough that
    // normal replies aren't chopped. Long tool-call gaps don't
    // cause re-speaking because this is a SINGLE timer per item,
    // not a loop-back.
    const displayMs = Math.max(2500, Math.min(text.length * 60, 6000));

    if (speak) {
      try {
        window.speechSynthesis.cancel();
        const utter = new SpeechSynthesisUtterance(text);
        utter.rate = rateRef.current || 1.15;
        utter.pitch = 1.2; // slightly elevated for a warmer, more enthusiastic tone
        const voice = findVoice(voiceNameRef.current);
        if (voice) utter.voice = voice;
        // Fire-and-forget — we DON'T hook onend/onerror because on
        // some browsers (headless Chromium, voice-less environments)
        // the event fires synchronously during speak() which would
        // cascade advance() calls and burn the whole queue in a few
        // milliseconds. The setTimeout below is the single source of
        // advance timing.
        window.speechSynthesis.speak(utter);
      } catch {
        // ignore TTS errors — display still works
      }
    }

    // Single setTimeout per item drives advance. No re-speak loop
    // because each item only schedules ONE timer, and the next
    // push will clear it via clear() or via advance() popping the
    // queue. Round 18 — if paused (mouse hover), delay scheduling
    // the timer until resume.
    safetyDelayRef.current = displayMs;
    if (!pausedRef.current) {
      safetyTimerRef.current = setTimeout(() => advance(), displayMs);
    }
  }, [setCurrentBoth, findVoice]);

  const pause = useCallback(() => {
    pausedRef.current = true;
    if (safetyTimerRef.current) {
      clearTimeout(safetyTimerRef.current);
      safetyTimerRef.current = null;
    }
    if (typeof window !== "undefined" && window.speechSynthesis) {
      try {
        window.speechSynthesis.pause?.();
      } catch {
        /* ignore */
      }
    }
  }, []);

  const resume = useCallback(() => {
    if (!pausedRef.current) return;
    pausedRef.current = false;
    if (typeof window !== "undefined" && window.speechSynthesis) {
      try {
        window.speechSynthesis.resume?.();
      } catch {
        /* ignore */
      }
    }
    // Schedule the advance timer with a small residual window so
    // the subtitle doesn't immediately pop.
    if (currentRef.current && !safetyTimerRef.current) {
      const remaining = Math.max(1000, safetyDelayRef.current || 2500);
      safetyTimerRef.current = setTimeout(() => advance(), remaining);
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
    return () => {
      clear();
    };
  }, [clear]);

  const clearHistory = useCallback(() => setHistory([]), []);

  return useMemo(
    () => ({ current, history, push, pushParagraph, clear, clearHistory, pause, resume }),
    [current, history, push, pushParagraph, clear, clearHistory, pause, resume],
  );
}
