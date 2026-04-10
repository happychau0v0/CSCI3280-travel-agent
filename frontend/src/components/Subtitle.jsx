import HighlightedText from "./HighlightedText";

/**
 * Bottom-of-screen subtitle bar — displays one sentence at a time
 * synced with the auto-TTS subtitle queue. Inspired by NieR's
 * single-line dialogue subtitles. Important entities (places, prices,
 * dates, IATA codes) get inline highlights via HighlightedText.
 */
export default function Subtitle({ text }) {
  return (
    <div className={`subtitle${text ? " visible" : ""}`} aria-live="polite">
      {text && <HighlightedText text={text} className="subtitle-text" />}
    </div>
  );
}
