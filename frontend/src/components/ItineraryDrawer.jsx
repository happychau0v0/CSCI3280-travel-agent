import { useEffect } from "react";
import ItineraryCard from "./ItineraryCard";

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
  const hotelCount = (itinerary.hotels || []).length;

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
          {/* Flight, hotels, and per-day activities. The FlightCard and
              HotelCard components are added in the next commit; for now we
              fall back to the existing ItineraryCard which handles days. */}
          <ItineraryCard
            itinerary={itinerary}
            onItineraryUpdate={onItineraryUpdate}
          />
          {hotelCount > 0 && (
            <p className="drawer-hint">{hotelCount} hotel options available — see details in the next commit.</p>
          )}
        </div>
      </aside>
    </>
  );
}
