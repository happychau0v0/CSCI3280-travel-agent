import { useEffect, useState } from "react";

/**
 * Top-left LIVE chip — mirrors the "LIVE / Today's order highlights"
 * element from the Shopify Liveview reference. Shows the user's city,
 * a pulsing red dot, and a one-line status of the agent's last action.
 *
 * Props:
 *   userLocation: {city, country, lat, lng} | null
 *   isLoading:    bool — agent currently working?
 *   lastAction:   string — short status like "Searching flights HKG → NRT"
 */
export default function LiveTicker({ userLocation, isLoading, lastAction }) {
  // Cycle through a few "thinking" phrases when isLoading and there's no
  // explicit lastAction, so the chip never sits silent during a long
  // tool-call loop.
  const [thinkingDots, setThinkingDots] = useState(".");
  useEffect(() => {
    if (!isLoading) return;
    const id = setInterval(() => {
      setThinkingDots((d) => (d.length >= 3 ? "." : d + "."));
    }, 400);
    return () => clearInterval(id);
  }, [isLoading]);

  const status = isLoading
    ? lastAction || `Working${thinkingDots}`
    : lastAction || "Ready";

  return (
    <div className="live-ticker">
      <div className="live-row">
        <span className="live-dot" />
        <span className="live-label">LIVE</span>
        {userLocation?.city && (
          <span className="live-city">— {userLocation.city}</span>
        )}
      </div>
      <div className={`live-status${isLoading ? " working" : ""}`}>{status}</div>
    </div>
  );
}
