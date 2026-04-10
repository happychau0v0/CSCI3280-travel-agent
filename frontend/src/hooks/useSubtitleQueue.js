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
  const queueRef = useRef([]);
  const timerRef = useRef(null);
  const speakingRef = useRef(false);
  const mutedRef = useRef(muted);

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
      setCurrent(null);
      speakingRef.current = false;
      return;
    }
    setCurrent(next);

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
  }, []);

  const push = useCallback(
    (text) => {
      if (!text) return;
      queueRef.current.push(text);
      // If nothing is currently showing, kick off the queue
      if (!current && !speakingRef.current) {
        speakingRef.current = true;
        advance();
      }
    },
    [current, advance],
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
    setCurrent(null);
    speakingRef.current = false;
    if (typeof window !== "undefined" && window.speechSynthesis) {
      window.speechSynthesis.cancel();
    }
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      clear();
    };
  }, [clear]);

  return { current, push, pushParagraph, clear };
}
