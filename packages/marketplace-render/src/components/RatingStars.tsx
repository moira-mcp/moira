/**
 * RatingStars — a read-only rating summary (average + localized rating count, or an
 * "unrated" hint). SSR-safe and JS-free; interactivity (clickable stars) is added by
 * the hydration layer in a later step, not here.
 */

import React from "react";

export interface RatingStarsProps {
  ratingAvg: number;
  ratingCount: number;
  /** Localized "<n> ratings" string (built by the caller via formatMarketplaceCount). */
  ratingCountLabel: string;
  /** Localized "Unrated" label for listings with no ratings yet. */
  unratedLabel: string;
}

export function RatingStars({
  ratingAvg,
  ratingCount,
  ratingCountLabel,
  unratedLabel,
}: RatingStarsProps): React.ReactElement {
  if (ratingCount <= 0) {
    return (
      <span className="mp-rating mp-rating-empty" data-mp="rating">
        {unratedLabel}
      </span>
    );
  }
  return (
    <span className="mp-rating" data-mp="rating">
      <span aria-hidden="true">★</span> {ratingAvg.toFixed(1)} ({ratingCountLabel})
    </span>
  );
}
