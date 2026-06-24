/**
 * VerifiedBadge — a small "verified" pill shown on verified listings. SSR-safe
 * (pure, no browser APIs). Returns null when the listing is not verified so callers
 * can render it unconditionally.
 */

import React from "react";

export interface VerifiedBadgeProps {
  verified: boolean;
  /** Localized label (e.g. "Verified" / "Проверено"); caller supplies the locale text. */
  label: string;
}

export function VerifiedBadge({ verified, label }: VerifiedBadgeProps): React.ReactElement | null {
  if (!verified) {
    return null;
  }
  return (
    <span className="mp-badge mp-badge-verified" data-mp="verified">
      {label}
    </span>
  );
}
