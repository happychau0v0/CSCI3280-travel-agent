import { photoSrc } from "../api/client";

/**
 * Compact hotel option card for the itinerary drawer.
 * Photo, name, rating, address, price level, and an "Open in Maps" link.
 */
const PRICE_LEVEL_LABELS = {
  PRICE_LEVEL_FREE: "Free",
  PRICE_LEVEL_INEXPENSIVE: "$",
  PRICE_LEVEL_MODERATE: "$$",
  PRICE_LEVEL_EXPENSIVE: "$$$",
  PRICE_LEVEL_VERY_EXPENSIVE: "$$$$",
};

export default function HotelCard({ hotel }) {
  if (!hotel) return null;
  const photo = photoSrc(hotel.photo_url);
  const priceLabel = PRICE_LEVEL_LABELS[hotel.price_level] || "";
  const mapsUrl = hotel.place_id
    ? `https://www.google.com/maps/place/?q=place_id:${hotel.place_id}`
    : `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(hotel.name)}`;

  return (
    <a
      href={mapsUrl}
      target="_blank"
      rel="noopener noreferrer"
      className="hotel-card"
    >
      {photo && (
        <img
          src={photo}
          alt={hotel.name}
          className="hotel-photo"
          onError={(e) => {
            e.currentTarget.style.display = "none";
          }}
        />
      )}
      <div className="hotel-body">
        <div className="hotel-title-row">
          <strong className="hotel-name">{hotel.name}</strong>
          {priceLabel && <span className="hotel-price">{priceLabel}</span>}
        </div>
        {hotel.rating != null && (
          <div className="hotel-rating">
            <span className="rating-star">★</span> {hotel.rating.toFixed(1)}
          </div>
        )}
        <p className="hotel-address">{hotel.address}</p>
      </div>
    </a>
  );
}
