import { useEffect, useState } from "react";
import { photoSrc } from "../api/client";

/**
 * PhotoGallery — a grid of small square thumbnails with click-to-
 * cycle. Drops the round-8 banner-aspect letterbox crops.
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
 *   - Clicking the hero advances to the next photo
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

  // Reset to first photo when the photo set changes (e.g. user clicks
  // a different hotel). Without this, activeIdx stays stale and the
  // hero shows the wrong image or a broken URL.
  useEffect(() => {
    setActiveIdx(0);
  }, [validPhotos.length, validPhotos[0]]);

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
        onClick={() => setActiveIdx((i) => (i + 1) % validPhotos.length)}
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
    </div>
  );
}
