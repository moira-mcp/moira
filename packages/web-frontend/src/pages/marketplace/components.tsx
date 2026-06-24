/**
 * Shared presentational components for the marketplace UI (gallery cards, rating
 * stars, verified/paid badges). Kept together so the gallery, detail, listings, and
 * library views render consistently.
 */

import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Badge } from "../../components/ui/badge";
import { Card, CardContent } from "../../components/ui/card";
import { ROUTES } from "../../constants/routes";
import type { MarketplaceGalleryItem } from "../../types/api-types";

/** Compact star rating with the count (read-only). */
export function RatingStars({ avg, count }: { avg: number; count: number }) {
  const { t } = useTranslation();
  if (count === 0)
    return <span className="text-sm text-muted-foreground">{t("pages.marketplace.unrated")}</span>;
  const full = Math.round(avg);
  return (
    <span className="text-sm" title={`${avg.toFixed(1)} / 5`}>
      <span className="text-amber-500">{"★".repeat(full)}</span>
      <span className="text-muted-foreground">{"★".repeat(5 - full)}</span>{" "}
      <span className="text-muted-foreground">
        {avg.toFixed(1)} ({count})
      </span>
    </span>
  );
}

export function VerifiedBadge() {
  const { t } = useTranslation();
  return (
    <Badge variant="secondary" className="gap-1">
      ✓ {t("pages.marketplace.verified")}
    </Badge>
  );
}

export function PaidBadge({ price, currency }: { price: number | null; currency: string | null }) {
  const { t } = useTranslation();
  const label =
    price != null
      ? `${(price / 100).toFixed(2)} ${currency ?? "USD"}`
      : t("pages.marketplace.detail.paid");
  return <Badge variant="outline">{t("pages.marketplace.paidSoon", { label })}</Badge>;
}

/** Build the in-app detail route for a gallery item. */
export function flowDetailPath(handle: string | null, slug: string): string {
  return `${ROUTES.MARKETPLACE}/flow/${handle ?? "unknown"}/${slug}`;
}

/** A single flow card for the gallery grid. */
export function ListingCard({ item }: { item: MarketplaceGalleryItem }) {
  const { t } = useTranslation();
  let tags: string[] = [];
  try {
    tags = JSON.parse(item.tags || "[]");
  } catch {
    tags = [];
  }
  return (
    <Card className="hover:border-primary/50 transition-colors">
      <CardContent className="pt-5">
        <div className="flex items-start justify-between gap-2">
          <Link
            to={flowDetailPath(item.ownerHandle, item.slug)}
            className="font-medium text-primary hover:underline"
          >
            {item.title}
          </Link>
          <div className="flex gap-1 shrink-0">
            {item.verified && <VerifiedBadge />}
            {item.isPaid && <PaidBadge price={item.price} currency={item.currency} />}
          </div>
        </div>
        {item.summary && (
          <p className="mt-1 text-sm text-muted-foreground line-clamp-2">{item.summary}</p>
        )}
        <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <Badge variant="outline">{item.category}</Badge>
          <RatingStars avg={item.ratingAvg} count={item.ratingCount} />
          <span>{t("pages.marketplace.installs", { count: item.installCount })}</span>
          {item.ownerHandle && <span>{t("pages.marketplace.by", { handle: item.ownerHandle })}</span>}
        </div>
        {tags.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1">
            {tags.slice(0, 6).map((tag) => (
              <span key={tag} className="text-xs text-muted-foreground">
                #{tag}
              </span>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
