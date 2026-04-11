import { useEffect } from "react";
import { photoSrc } from "../api/client";

/**
 * Round 20 — favorites overlay. Opens via F hotkey. Shows every
 * starred activity across all plans so users can browse their
 * wishlist between trips. Click any card to unfavorite.
 */
function formatAgo(ts) {
  if (!ts) return "";
  const diff = Date.now() - ts;
  const day = Math.round(diff / 86400000);
  if (day < 1) return "today";
  if (day < 30) return `${day}d ago`;
  const month = Math.round(day / 30);
  return `${month}mo ago`;
}

export default function FavoritesOverlay({ open, favorites = [], onClose, onRemove }) {
  useEffect(() => {
    if (!open) return undefined;
    const handler = (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose?.();
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [open, onClose]);

  if (!open) return null;

  // Group by destination so the user sees "Tokyo: 3 favorites" etc.
  const byDest = new Map();
  for (const f of favorites) {
    const key = f.destination || "Other";
    if (!byDest.has(key)) byDest.set(key, []);
    byDest.get(key).push(f);
  }

  return (
    <div
      className="favorites-overlay-backdrop"
      onClick={onClose}
      data-testid="favorites-overlay"
    >
      <div
        className="favorites-overlay"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Favorite activities"
      >
        <div className="favorites-overlay-header">
          <span className="favorites-overlay-chevron">◢</span>
          <span className="favorites-overlay-title">
            FAVORITES · {favorites.length}
          </span>
          <span className="favorites-overlay-close-hint">Esc to close</span>
        </div>
        {favorites.length === 0 ? (
          <div className="favorites-overlay-empty">
            <p>No favorites yet.</p>
            <p className="favorites-overlay-hint">
              Press ☆ on any activity in the DAYS panel to add it to your
              wishlist. Favorites are kept across plans and destinations.
            </p>
          </div>
        ) : (
          <div className="favorites-overlay-body">
            {Array.from(byDest.entries()).map(([dest, items]) => (
              <section key={dest} className="favorites-group">
                <h3 className="favorites-group-title">
                  {dest} · {items.length}
                </h3>
                <ul className="favorites-group-list">
                  {items.map((f) => {
                    const thumb = f.photo_url ? photoSrc(f.photo_url) : null;
                    return (
                      <li
                        key={f.key}
                        className="favorites-card"
                        data-testid={`favorites-card-${f.key}`}
                      >
                        {thumb && (
                          <img
                            src={thumb}
                            alt=""
                            className="favorites-card-thumb"
                            onError={(e) => {
                              e.currentTarget.style.display = "none";
                            }}
                          />
                        )}
                        <div className="favorites-card-body">
                          <strong className="favorites-card-name">{f.name}</strong>
                          {f.address && (
                            <p className="favorites-card-addr">{f.address}</p>
                          )}
                          <span className="favorites-card-age">
                            {formatAgo(f.saved_at)}
                          </span>
                        </div>
                        <button
                          type="button"
                          className="favorites-card-remove"
                          onClick={() => onRemove?.(f.key)}
                          aria-label={`Unfavorite ${f.name}`}
                          title="Unfavorite"
                        >
                          ★
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </section>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
