import { useEffect } from "react";
import ItineraryCard from "./ItineraryCard";
import FlightCard from "./FlightCard";
import HotelCard from "./HotelCard";

/**
 * Persistent itinerary sidebar on the right edge.
 *
 * Once an itinerary exists this is always visible — no backdrop dim,
 * no modal behavior. The user can still minimize it to a thin strip
 * via the – button so they can see the full globe, or restore it via
 * the + button.
 *
 * Props:
 *   itinerary: the current Itinerary object | null
 *   isOpen:    bool — controlled by parent (false = minimized, not hidden)
 *   onOpen:    () => void — restore from minimized state
 *   onClose:   () => void — collapse to minimized strip
 *   onItineraryUpdate: (newItinerary) => void
 */
export default function ItineraryDrawer({
  itinerary,
  isOpen,
  onOpen,
  onClose,
  onItineraryUpdate,
}) {
  // Esc minimizes the sidebar (no longer hides it entirely)
  useEffect(() => {
    if (!isOpen) return;
    const handleKey = (e) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [isOpen, onClose]);

  if (!itinerary) return null;

  const dayCount = (itinerary.days || []).length;
  const hotels = itinerary.hotels || [];

  // Minimized strip mode — vertical bar on the right edge
  if (!isOpen) {
    return (
      <button
        type="button"
        className="drawer-strip"
        onClick={onOpen}
        title="Expand itinerary"
      >
        <span className="drawer-strip-icon">+</span>
        <span className="drawer-strip-label">
          {dayCount} day{dayCount !== 1 ? "s" : ""} · {itinerary.destination}
        </span>
      </button>
    );
  }

  return (
    <aside className="itinerary-drawer open">
      <header className="drawer-header">
        <div>
          <h2>{itinerary.title || itinerary.destination}</h2>
          {itinerary.origin && (
            <p className="drawer-route">
              {itinerary.origin} → {itinerary.destination}
            </p>
          )}
        </div>
        <button
          type="button"
          className="drawer-close"
          onClick={onClose}
          aria-label="Minimize itinerary"
          title="Minimize"
        >
          –
        </button>
      </header>

      <div className="drawer-body">
        {itinerary.flight && <FlightCard flight={itinerary.flight} />}

        {hotels.length > 0 && (
          <section className="hotels-section">
            <h3 className="section-heading">Hotel options</h3>
            <div className="hotels-list">
              {hotels.map((h, i) => (
                <HotelCard key={h.place_id || i} hotel={h} />
              ))}
            </div>
          </section>
        )}

        {itinerary.local_transport_mode && (
          <p className="transport-mode">
            Getting around: <strong>{itinerary.local_transport_mode}</strong>
          </p>
        )}

        <ItineraryCard
          itinerary={itinerary}
          onItineraryUpdate={onItineraryUpdate}
        />
      </div>
    </aside>
  );
}
