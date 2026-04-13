import { useMemo, useState } from "react";
import { photoSrc } from "../../api/client";
import PhotoGallery from "../PhotoGallery";
import HotelsMap from "../HotelsMap";

/**
 * HOTELS panel — shares the .panel-grid layout with PLAN/FLIGHTS/DAYS.
 * Left column: vertical list of hotels with a small thumbnail.
 * Center: Leaflet map showing all hotel pins + a ✈ arrival airport
 *         reference pin, zoomed to fit. Round 10.
 * Right column: detail card for the focused hotel — photo gallery,
 *         rating, price, address, PICK & REPLAN button, Maps link.
 * Top band: summary "HOTELS · N near {destination}".
 *
 * Round 13 — top band adds filter chips (price + rating) that
 * narrow the displayed list without re-querying the LLM.
 */

const PRICE_LEVEL_LABELS = {
  PRICE_LEVEL_FREE: "Free",
  PRICE_LEVEL_INEXPENSIVE: "$",
  PRICE_LEVEL_MODERATE: "$$",
  PRICE_LEVEL_EXPENSIVE: "$$$",
  PRICE_LEVEL_VERY_EXPENSIVE: "$$$$",
};

const PRICE_LEVEL_ESTIMATES = {
  PRICE_LEVEL_FREE: "Free",
  PRICE_LEVEL_INEXPENSIVE: "~HK$400-800/night",
  PRICE_LEVEL_MODERATE: "~HK$800-1,500/night",
  PRICE_LEVEL_EXPENSIVE: "~HK$1,500-3,000/night",
  PRICE_LEVEL_VERY_EXPENSIVE: "~HK$3,000+/night",
};

const PRICE_LEVEL_RANK = {
  PRICE_LEVEL_FREE: 0,
  PRICE_LEVEL_INEXPENSIVE: 1,
  PRICE_LEVEL_MODERATE: 2,
  PRICE_LEVEL_EXPENSIVE: 3,
  PRICE_LEVEL_VERY_EXPENSIVE: 4,
};

const PRICE_FILTERS = [
  { key: "any", label: "ANY", match: () => true },
  { key: "budget", label: "$ / $$", match: (h) => (PRICE_LEVEL_RANK[h.price_level] ?? 2) <= 2 },
  { key: "premium", label: "$$$+", match: (h) => (PRICE_LEVEL_RANK[h.price_level] ?? 2) >= 3 },
];

const RATING_FILTERS = [
  { key: "any", label: "ANY", match: () => true },
  { key: "good", label: "4.0+", match: (h) => typeof h.rating === "number" && h.rating >= 4.0 },
  { key: "great", label: "4.5+", match: (h) => typeof h.rating === "number" && h.rating >= 4.5 },
];

export default function PanelHotels({ itinerary, listIndex, onSelect, onPick }) {
  const hotelsRaw = itinerary?.hotels || [];
  const [priceFilter, setPriceFilter] = useState("any");
  const [ratingFilter, setRatingFilter] = useState("any");

  const hotels = useMemo(() => {
    const priceFn = PRICE_FILTERS.find((f) => f.key === priceFilter)?.match || (() => true);
    const ratingFn = RATING_FILTERS.find((f) => f.key === ratingFilter)?.match || (() => true);
    const filtered = hotelsRaw.filter((h) => priceFn(h) && ratingFn(h));
    // If the filters eliminated everything, fall back to the raw list
    // so the panel never shows an empty map mid-session.
    return filtered.length > 0 ? filtered : hotelsRaw;
  }, [hotelsRaw, priceFilter, ratingFilter]);

  if (hotelsRaw.length === 0) {
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

  const airportPin =
    itinerary?.flight?.to_lat != null && itinerary?.flight?.to_lng != null
      ? {
          lat: itinerary.flight.to_lat,
          lng: itinerary.flight.to_lng,
          iata: itinerary.flight.to_iata,
          label: `${itinerary.flight.to_iata || ""} Airport`.trim(),
        }
      : null;

  return (
    <section className="panel panel-grid panel-hotels" aria-label="Hotels">
      {/* TOP band — summary + Round 13 filter chips */}
      <header className="panel-grid-top-band home-summary-top">
        <div className="home-card-label">
          🏨 HOTELS · {hotels.length}
          {hotels.length !== hotelsRaw.length && ` / ${hotelsRaw.length}`} near{" "}
          {itinerary?.destination || "destination"}
        </div>
        <div className="home-summary-line">
          {pickedIdx >= 0 ? (
            <>
              picked <strong>{hotels[pickedIdx]?.name}</strong>
            </>
          ) : (
            <span className="home-summary-meta">Click PICK & REPLAN to lock in a hotel</span>
          )}
        </div>
        <div className="hotel-filters" data-testid="hotel-filters">
          <span className="hotel-filter-label">PRICE</span>
          {PRICE_FILTERS.map((f) => (
            <button
              key={f.key}
              type="button"
              className={`hotel-filter-chip${priceFilter === f.key ? " active" : ""}`}
              onClick={() => setPriceFilter(f.key)}
              data-testid={`hotel-filter-price-${f.key}`}
            >
              {f.label}
            </button>
          ))}
          <span className="hotel-filter-label" style={{ marginLeft: 10 }}>
            RATING
          </span>
          {RATING_FILTERS.map((f) => (
            <button
              key={f.key}
              type="button"
              className={`hotel-filter-chip${ratingFilter === f.key ? " active" : ""}`}
              onClick={() => setRatingFilter(f.key)}
              data-testid={`hotel-filter-rating-${f.key}`}
            >
              {f.label}
            </button>
          ))}
        </div>
      </header>

      {/* CENTER — Leaflet map with hotel pins + airport reference */}
      <div className="panel-grid-center">
        <HotelsMap
          hotels={hotels}
          airport={airportPin}
          selectedIdx={selectedIdx}
        />
      </div>

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
            {selected.price_level && PRICE_LEVEL_ESTIMATES[selected.price_level] && (
              <div className="hotel-detail-estimate">
                {PRICE_LEVEL_ESTIMATES[selected.price_level]}
              </div>
            )}
            <div className="hotel-detail-address">{selected.address}</div>

            <button
              type="button"
              className="trip-plan-btn"
              onClick={() => onPick?.(selectedIdx)}
              disabled={selectedIdx === pickedIdx}
              data-testid="hotel-pick-btn"
              style={{ marginTop: 16, marginBottom: 12 }}
            >
              {selectedIdx === pickedIdx ? "✓ PICKED" : "PICK & PLAN DAYS →"}
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
