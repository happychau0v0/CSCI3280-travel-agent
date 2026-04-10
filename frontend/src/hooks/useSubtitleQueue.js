import { useCallback, useEffect, useRef, useState } from "react";

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
 * FIFO subtitle queue with auto-TTS.
 *
 * Each item is shown for `Math.max(2500, text.length * 60)` ms then
 * dequeued. While displayed, the text is also spoken via SpeechSynthesis
 * (unless `muted` is true).
 *
 * Returns:
 *   {
 *     current,    // string | null — currently displayed sentence
 *     push(text), // enqueue a single sentence
 *     pushParagraph(text), // split into sentences and enqueue all
 *     clear(),    // empty the queue and stop speaking
 *   }
 */
export function useSubtitleQueue({ muted = false } = {}) {
  const [current, setCurrent] = useState(null);
  // currentRef mirrors `current` so that callbacks which run in the
  // same synchronous tick as a state update (e.g. clear() followed by
  // push() inside handleSend) see the fresh value instead of the
  // stale closure-captured one. This fixes B3: the "▸ preview" echo
  // was silently dropping on every request after the first because
  // push's useCallback closure saw the previous sentence as `current`
  // and the `!current` guard returned false, so advance() was never
  // called.
  const currentRef = useRef(null);
  const queueRef = useRef([]);
  const timerRef = useRef(null);
  const speakingRef = useRef(false);
  const mutedRef = useRef(muted);

  const setCurrentBoth = useCallback((v) => {
    currentRef.current = v;
    setCurrent(v);
  }, []);

  // Keep mutedRef in sync so the queue advancer reads the latest value
  useEffect(() => {
    mutedRef.current = muted;
    if (muted && typeof window !== "undefined" && window.speechSynthesis) {
      window.speechSynthesis.cancel();
    }
  }, [muted]);

  const advance = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    const next = queueRef.current.shift();
    if (!next) {
      setCurrentBoth(null);
      speakingRef.current = false;
      return;
    }
    setCurrentBoth(next);

    // Speak if not muted
    if (!mutedRef.current && typeof window !== "undefined" && window.speechSynthesis) {
      try {
        window.speechSynthesis.cancel();
        const utter = new SpeechSynthesisUtterance(next);
        utter.rate = 1.05;
        utter.pitch = 1.0;
        window.speechSynthesis.speak(utter);
      } catch {
        // ignore TTS errors — display still works
      }
    }

    // Compute display duration: ~60ms per char, min 2.5s
    const ms = Math.max(2500, next.length * 60);
    timerRef.current = setTimeout(advance, ms);
  }, [setCurrentBoth]);

  const push = useCallback(
    (text) => {
      if (!text) return;
      queueRef.current.push(text);
      // Read `current` from currentRef so that a push() called in the
      // same tick as a clear() sees the already-cleared value, not the
      // stale state closure. Without this, the first push after clear
      // silently fails to kick off advance().
      if (!currentRef.current && !speakingRef.current) {
        speakingRef.current = true;
        advance();
      }
    },
    [advance],
  );

  const pushParagraph = useCallback(
    (paragraph) => {
      const sentences = splitSentences(paragraph);
      for (const s of sentences) push(s);
    },
    [push],
  );

  const clear = useCallback(() => {
    queueRef.current = [];
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
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

  return { current, push, pushParagraph, clear };
}
