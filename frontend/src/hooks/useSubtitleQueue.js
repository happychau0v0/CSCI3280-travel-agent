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
  const currentRef = useRef(null);
  const queueRef = useRef([]);
  const safetyTimerRef = useRef(null);
  const speakingRef = useRef(false);
  const mutedRef = useRef(muted);
  const rateRef = useRef(rate);
  const voiceNameRef = useRef(voiceName);

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

    const speak = spoken && !mutedRef.current &&
      typeof window !== "undefined" && window.speechSynthesis;

    if (speak) {
      try {
        window.speechSynthesis.cancel();
        const utter = new SpeechSynthesisUtterance(text);
        utter.rate = rateRef.current || 1.15;
        utter.pitch = 1.0;
        const voice = findVoice(voiceNameRef.current);
        if (voice) utter.voice = voice;
        // Advance via onend so long items are spoken fully and the
        // display holds until the speech actually finishes. If the
        // queue is empty when onend fires we just go back to idle.
        utter.onend = () => advance();
        utter.onerror = () => advance();
        window.speechSynthesis.speak(utter);
        // Safety net: if the browser never fires onend (known issue
        // on some Chrome builds), force-advance after 15s.
        safetyTimerRef.current = setTimeout(() => advance(), 15000);
      } catch {
        // ignore TTS errors — display still works
        safetyTimerRef.current = setTimeout(() => advance(), 4000);
      }
    } else {
      // Silent item (e.g. the user's own "▸" echo). Hold the
      // subtitle for a short fixed duration then advance. Long
      // narration labels don't loop because their 4-6s hold covers
      // the usual tool-call gap.
      const ms = Math.max(2500, Math.min(text.length * 60, 6000));
      safetyTimerRef.current = setTimeout(() => advance(), ms);
    }
  }, [setCurrentBoth, findVoice]);

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

  return useMemo(
    () => ({ current, push, pushParagraph, clear }),
    [current, push, pushParagraph, clear],
  );
}
