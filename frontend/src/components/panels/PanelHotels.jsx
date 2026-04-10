import { photoSrc } from "../../api/client";

/**
 * HOTELS panel — left list of hotel options, right detail with photo,
 * rating, address, and Google Maps link for the selected one.
 */

const PRICE_LEVEL_LABELS = {
  PRICE_LEVEL_FREE: "Free",
  PRICE_LEVEL_INEXPENSIVE: "$",
  PRICE_LEVEL_MODERATE: "$$",
  PRICE_LEVEL_EXPENSIVE: "$$$",
  PRICE_LEVEL_VERY_EXPENSIVE: "$$$$",
};

export default function PanelHotels({ itinerary, listIndex }) {
  const hotels = itinerary?.hotels || [];

  if (hotels.length === 0) {
    return (
      <section className="panel panel-list" aria-label="Hotels">
        <div className="panel-empty">
          <h2>NO HOTELS YET</h2>
          <p>Press Enter and ask the agent to find accommodation.</p>
        </div>
      </section>
    );
  }

  const selectedIdx = Math.min(listIndex, hotels.length - 1);
  const selected = hotels[selectedIdx];
  const photo = photoSrc(selected?.photo_url);
  const priceLabel = PRICE_LEVEL_LABELS[selected?.price_level] || "";
  const mapsUrl = selected?.place_id
    ? `https://www.google.com/maps/place/?q=place_id:${selected.place_id}`
    : selected?.name
      ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(selected.name)}`
      : null;

  return (
    <section className="panel panel-list" aria-label="Hotels">
      <ul className="panel-list-items">
        {hotels.map((h, i) => (
          <li
            key={h.place_id || i}
            className={`panel-list-item${i === selectedIdx ? " active" : ""}`}
          >
            <span className="panel-list-label">
              {h.rating ? `★ ${h.rating.toFixed(1)}` : ""}
              {PRICE_LEVEL_LABELS[h.price_level] && ` · ${PRICE_LEVEL_LABELS[h.price_level]}`}
            </span>
            <span className="panel-list-value">{h.name}</span>
          </li>
        ))}
      </ul>
      <div className="panel-detail">
        {selected && (
          <>
            {photo && (
              <img
                src={photo}
                alt={selected.name}
                style={{
                  width: "100%",
                  height: 200,
                  objectFit: "cover",
                  marginBottom: 16,
                  border: "1px solid var(--border)",
                }}
                onError={(e) => {
                  e.currentTarget.style.display = "none";
                }}
              />
            )}
            <div style={{ fontSize: 22, fontWeight: 700, color: "var(--text-h)", marginBottom: 4 }}>
              {selected.name}
            </div>
            <div style={{ fontSize: 13, color: "var(--text)", marginBottom: 12 }}>
              {selected.rating != null && (
                <span style={{ color: "#fbbf24", marginRight: 8 }}>
                  ★ {selected.rating.toFixed(1)}
                </span>
              )}
              {priceLabel && (
                <span style={{ color: "var(--accent)", marginRight: 8 }}>{priceLabel}</span>
              )}
            </div>
            <div style={{ fontSize: 12, color: "var(--text-dim)", marginBottom: 16 }}>
              {selected.address}
            </div>
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
      </div>
    </section>
  );
}
