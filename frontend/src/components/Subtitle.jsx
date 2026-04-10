/**
 * Bottom-of-screen subtitle bar — displays one sentence at a time
 * synced with the auto-TTS subtitle queue. Inspired by NieR's
 * single-line dialogue subtitles.
 */
export default function Subtitle({ text }) {
  return (
    <div className={`subtitle${text ? " visible" : ""}`} aria-live="polite">
      {text && <span className="subtitle-text">{text}</span>}
    </div>
  );
}
