import { useEffect, useState } from "react";
import { photoSrc } from "../api/client";

/**
 * PhotoGallery — a grid of small square thumbnails with click-to-
 * enlarge. Drops the round-8 banner-aspect letterbox crops.
 *
 * Props:
 *   photos: array of relative photo URL paths (from places.py's
 *           photos[] field, e.g. "/photo/places/.../photos/Ae...").
 *   maxCount: optional cap on thumbnails shown (default 5).
 *   altPrefix: screen reader label prefix for each photo.
 *
 * Layout:
 *   - First photo is the "hero" at ~3:2 aspect
 *   - Remaining photos are 80×80 square thumbs in a flex row
 *   - Clicking any thumbnail swaps it into the hero slot
 *   - Clicking the hero opens a full-screen lightbox modal
 *
 * Falls back to a placeholder when photos is empty/null. Also guards
 * against broken image URLs via onError.
 */
export default function PhotoGallery({
  photos = [],
  maxCount = 10,
  altPrefix = "",
}) {
  const validPhotos = (photos || []).filter(Boolean).slice(0, maxCount);
  const [activeIdx, setActiveIdx] = useState(0);
  const [lightboxOpen, setLightboxOpen] = useState(false);

  // Reset to first photo when the photo set changes (e.g. user clicks
  // a different hotel). Without this, activeIdx stays stale and the
  // hero shows the wrong image or a broken URL.
  useEffect(() => {
    setActiveIdx(0);
  }, [validPhotos.length, validPhotos[0]]);

  // Round 20 — arrow key navigation while the lightbox is open.
  useEffect(() => {
    if (!lightboxOpen) return undefined;
    const handler = (e) => {
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        e.stopPropagation();
        setActiveIdx((i) => (i - 1 + validPhotos.length) % validPhotos.length);
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        e.stopPropagation();
        setActiveIdx((i) => (i + 1) % validPhotos.length);
      } else if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        setLightboxOpen(false);
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [lightboxOpen, validPhotos.length]);

  if (validPhotos.length === 0) {
    return (
      <div className="photo-gallery photo-gallery-empty" aria-label="No photos">
        <div className="photo-gallery-placeholder">No photos</div>
      </div>
    );
  }

  const heroIdx = Math.min(activeIdx, validPhotos.length - 1);
  const heroSrc = photoSrc(validPhotos[heroIdx]);

  return (
    <div className="photo-gallery" data-testid="photo-gallery">
      <button
        type="button"
        className="photo-gallery-hero"
        onClick={() => setLightboxOpen(true)}
        aria-label={`${altPrefix} photo ${heroIdx + 1} of ${validPhotos.length}`}
      >
        <img
          src={heroSrc}
          alt={`${altPrefix} ${heroIdx + 1}`}
          onError={(e) => {
            e.currentTarget.style.visibility = "hidden";
          }}
        />
      </button>
      {validPhotos.length > 1 && (
        <div className="photo-gallery-thumbs">
          {validPhotos.map((url, i) => (
            <button
              key={i}
              type="button"
              className={
                `photo-gallery-thumb` + (i === heroIdx ? " active" : "")
              }
              onClick={() => setActiveIdx(i)}
              aria-label={`View photo ${i + 1}`}
              data-testid={`photo-gallery-thumb-${i}`}
            >
              <img
                src={photoSrc(url)}
                alt=""
                onError={(e) => {
                  e.currentTarget.style.visibility = "hidden";
                }}
              />
            </button>
          ))}
        </div>
      )}
      {lightboxOpen && (
        <div
          className="photo-gallery-lightbox"
          onClick={() => setLightboxOpen(false)}
          role="dialog"
          aria-label="Photo lightbox"
          data-testid="photo-lightbox"
        >
          <img src={heroSrc} alt={`${altPrefix} ${heroIdx + 1}`} />
          {validPhotos.length > 1 && (
            <>
              <button
                type="button"
                className="photo-gallery-lightbox-nav prev"
                onClick={(e) => {
                  e.stopPropagation();
                  setActiveIdx((i) => (i - 1 + validPhotos.length) % validPhotos.length);
                }}
                aria-label="Previous photo"
                data-testid="photo-lightbox-prev"
              >
                ‹
              </button>
              <button
                type="button"
                className="photo-gallery-lightbox-nav next"
                onClick={(e) => {
                  e.stopPropagation();
                  setActiveIdx((i) => (i + 1) % validPhotos.length);
                }}
                aria-label="Next photo"
                data-testid="photo-lightbox-next"
              >
                ›
              </button>
              <div className="photo-gallery-lightbox-count">
                {heroIdx + 1} / {validPhotos.length}
              </div>
            </>
          )}
          <button
            type="button"
            className="photo-gallery-lightbox-close"
            onClick={(e) => {
              e.stopPropagation();
              setLightboxOpen(false);
            }}
            aria-label="Close lightbox"
          >
            ✕
          </button>
        </div>
      )}
    </div>
  );
}
