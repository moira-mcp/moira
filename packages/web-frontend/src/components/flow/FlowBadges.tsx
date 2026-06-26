/**
 * Shared, presentational flow badges.
 *
 * These are presentational (only `useTranslation` + props) and shared across the in-app
 * SPA surfaces (the library home and, in Step 21, the SPA marketplace views). They render
 * small shadcn `Badge`s with an i18n label. NOTE: the server-rendered public storefront is
 * a separate, deliberately-isolated package (`@mcp-moira/marketplace-render`, no
 * react-i18next/shadcn) — it mirrors this SAME visual language with its own prop-based
 * badge rather than importing these (which would pull the whole SPA into the SSR bundle).
 *
 *   - {@link OfficialBadge} — owner-based "Official" mark for flows owned by an official
 *     system account (`MarketplaceLibraryItem.official === true`).
 *   - {@link VerifiedBadge} — moderation "Verified" mark for marketplace listings. Lives
 *     here (moved from `pages/marketplace/components`) so both badges share one home;
 *     `pages/marketplace/components` re-exports it for the existing import sites.
 */

import { useTranslation } from "react-i18next";
import { Badge } from "../ui/badge";

/** "Official" badge — rendered for flows owned by an official system account. */
export function OfficialBadge() {
  const { t } = useTranslation();
  return (
    <Badge variant="secondary" className="gap-1" data-testid="official-badge">
      {t("pages.workflows.home.official")} ✓
    </Badge>
  );
}

/** "Verified" badge — rendered for moderator-verified marketplace listings. */
export function VerifiedBadge() {
  const { t } = useTranslation();
  return (
    <Badge variant="secondary" className="gap-1" data-testid="verified-badge">
      ✓ {t("pages.marketplace.verified")}
    </Badge>
  );
}
