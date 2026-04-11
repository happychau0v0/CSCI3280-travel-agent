import { photoSrc } from "../../api/client";
import PhotoGallery from "../PhotoGallery";

/**
 * HOTELS panel — shares the .panel-grid layout with HOME/FLIGHTS/DAYS.
 * Left column: vertical list of hotels with a small thumbnail.
 * Center: reserved for the globe (background) — hotel pins live on
 *         the globe via App.jsx's points memo.
 * Right column: detail card for the focused hotel — photo gallery,
 *         rating, price, address, PICK & REPLAN button, Maps link.
 * Top band: summary "HOTELS · N near {destination}".
 */

const PRICE_LEVEL_LABELS = {
  PRICE_LEVEL_FREE: "Free",
  PRICE_LEVEL_INEXPENSIVE: "$",
  PRICE_LEVEL_MODERATE: "$$",
  PRICE_LEVEL_EXPENSIVE: "$$$",
  PRICE_LEVEL_VERY_EXPENSIVE: "$$$$",
};

export default function PanelHotels({ itinerary, listIndex, onSelect, onPick }) {
  const hotels = itinerary?.hotels || [];

  if (hotels.length === 0) {
    return (
      <section className="panel panel-grid panel-hotels" aria-label="Hotels">
        <div className="panel-grid-empty">
          <h2>NO HOTELS YET</h2>
          <p>Press T and ask the agent to find accommodation.</p>
        </div>
      </section>
    );
  }

  const selectedIdx = Math.min(Math.max(0, listIndex), hotels.length - 1);
  const selected = hotels[selectedIdx];
  const picked = itinerary?.selected_hotel;
  const pickedIdx = picked
    ? hotels.findIndex(
        (h) =>
          (picked.place_id && h.place_id === picked.place_id) ||
          h.name === picked.name,
      )
    : -1;

  const priceLabel = PRICE_LEVEL_LABELS[selected?.price_level] || "";
  const mapsUrl = selected?.place_id
    ? `https://www.google.com/maps/place/?q=place_id:${selected.place_id}`
    : selected?.name
      ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(selected.name)}`
      : null;

  // Prefer the new photos[] gallery from round 9; fall back to the
  // single photo_url for older itineraries.
  const gallery =
    selected?.photos?.length > 0
      ? selected.photos
      : selected?.photo_url
        ? [selected.photo_url]
        : [];

  return (
    <section className="panel panel-grid panel-hotels" aria-label="Hotels">
      {/* TOP band — summary */}
      <header className="panel-grid-top-band home-summary-top">
        <div className="home-card-label">
          🏨 HOTELS · {hotels.length} near {itinerary?.destination || "destination"}
        </div>
        <div className="home-summary-line">
          {pickedIdx >= 0 ? (
            <>
              picked <strong>{hotels[pickedIdx].name}</strong>
            </>
          ) : (
            <span className="home-summary-meta">Click PICK & REPLAN to lock in a hotel</span>
          )}
        </div>
      </header>

      {/* LEFT — hotels list with thumbnails */}
      <div className="panel-grid-left panel-grid-scroll">
        <ul className="panel-list-items">
          {hotels.map((h, i) => {
            const thumbSrc = photoSrc(h.photos?.[0] || h.photo_url);
            return (
              <li
                key={h.place_id || i}
                className={
                  `panel-list-item hotel-option-row` +
                  (i === selectedIdx ? " active" : "") +
                  (i === pickedIdx ? " picked" : "")
                }
                onClick={() => onSelect?.(i)}
                data-testid={`hotel-option-${i}`}
              >
                {thumbSrc && (
                  <img
                    src={thumbSrc}
                    alt=""
                    className="hotel-option-thumb"
                    onError={(e) => {
                      e.currentTarget.style.display = "none";
                    }}
                  />
                )}
                <div className="hotel-option-body">
                  <div className="hotel-option-name">
                    {h.name}
                    {i === pickedIdx && (
                      <span className="panel-list-picked-tag"> ✓ PICKED</span>
                    )}
                  </div>
                  <div className="hotel-option-meta">
                    {h.rating != null && <>★ {h.rating.toFixed(1)}</>}
                    {PRICE_LEVEL_LABELS[h.price_level] && (
                      <> · {PRICE_LEVEL_LABELS[h.price_level]}</>
                    )}
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      </div>

      {/* RIGHT — detail card */}
      <aside className="panel-grid-right panel-grid-scroll hotel-detail-card">
        {selected && (
          <>
            <PhotoGallery photos={gallery} altPrefix={selected.name} />
            <div className="hotel-detail-name">{selected.name}</div>
            <div className="hotel-detail-meta">
              {selected.rating != null && (
                <span style={{ color: "#fbbf24", marginRight: 8 }}>
                  ★ {selected.rating.toFixed(1)}
                </span>
              )}
              {priceLabel && (
                <span style={{ color: "var(--accent)", marginRight: 8 }}>
                  {priceLabel}
                </span>
              )}
            </div>
            <div className="hotel-detail-address">{selected.address}</div>

            <button
              type="button"
              className="trip-plan-btn"
              onClick={() => onPick?.(selectedIdx)}
              disabled={selectedIdx === pickedIdx}
              data-testid="hotel-pick-btn"
              style={{ marginTop: 16, marginBottom: 12 }}
            >
              {selectedIdx === pickedIdx ? "✓ PICKED · REPLANNING…" : "PICK & REPLAN DAYS →"}
            </button>

            {mapsUrl && (
              <a
                href={mapsUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="flight-cta"
              >
                Open in Google Maps ↗
              </a>
            )}
          </>
        )}
      </aside>
    </section>
  );
}
