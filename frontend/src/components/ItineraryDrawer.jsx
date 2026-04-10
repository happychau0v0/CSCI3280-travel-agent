import { useEffect } from "react";
import ItineraryCard from "./ItineraryCard";
import FlightCard from "./FlightCard";
import HotelCard from "./HotelCard";

/**
 * Slide-in itinerary drawer from the right edge.
 *
 * Shows nothing visible until `currentItinerary` exists. Once one
 * arrives, a small handle on the right edge becomes clickable; the
 * drawer slides over the right portion of the globe.
 */
export default function ItineraryDrawer({
  itinerary,
  isOpen,
  onOpen,
  onClose,
  onItineraryUpdate,
}) {
  // Esc closes the drawer
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

  return (
    <>
      {/* Persistent handle on the right edge */}
      {!isOpen && (
        <button
          type="button"
          className="drawer-handle"
          onClick={onOpen}
          title="Show itinerary"
        >
          <span className="drawer-handle-icon">✦</span>
          <span className="drawer-handle-label">
            {dayCount} day{dayCount !== 1 ? "s" : ""} · {itinerary.destination}
          </span>
        </button>
      )}

      {/* Backdrop */}
      {isOpen && <div className="drawer-backdrop" onClick={onClose} />}

      {/* The drawer itself */}
      <aside className={`itinerary-drawer${isOpen ? " open" : ""}`} aria-hidden={!isOpen}>
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
            aria-label="Close itinerary"
          >
            ×
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
    </>
  );
}
