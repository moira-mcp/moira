/**
 * "My Listings" — workflows the user has published to the marketplace, with the
 * ability to unpublish (unlist). Verified/featured status is shown read-only.
 */

import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { apiClient } from "../../services/api-client";
import { ROUTES } from "../../constants/routes";
import { Button } from "../../components/ui/button";
import { Badge } from "../../components/ui/badge";
import { Card, CardContent } from "../../components/ui/card";
import { EmptyState } from "../../components/empty-state";
import { RatingStars, VerifiedBadge } from "./components";
import type { MarketplaceListing } from "../../types/api-types";

export function MyListings() {
  const { t } = useTranslation();
  const [listings, setListings] = useState<MarketplaceListing[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    apiClient
      .getMyListings()
      .then(setListings)
      .catch((e) =>
        setError(e instanceof Error ? e.message : t("pages.marketplace.listings.loadFailed")),
      )
      .finally(() => setLoading(false));
  }, [t]);

  useEffect(() => load(), [load]);

  const unpublish = async (id: string) => {
    setBusyId(id);
    try {
      await apiClient.unpublishListing(id);
      toast.success(t("pages.marketplace.listings.unpublished"));
      setListings((prev) => prev.filter((l) => l.id !== id));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t("pages.marketplace.listings.failed"));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="container mx-auto max-w-3xl px-4 py-6">
      <Link to={ROUTES.MARKETPLACE} className="text-primary hover:underline text-sm">
        ← {t("pages.marketplace.back")}
      </Link>
      <div className="mt-3 flex items-center justify-between">
        <h1 className="text-2xl font-semibold">{t("pages.marketplace.listings.title")}</h1>
        <Button asChild size="sm">
          <Link to={`${ROUTES.MARKETPLACE}/publish`}>
            {t("pages.marketplace.listings.publishAnother")}
          </Link>
        </Button>
      </div>

      <div className="mt-5 space-y-2">
        {loading ? (
          <p className="text-muted-foreground">{t("pages.marketplace.loading")}</p>
        ) : error ? (
          <EmptyState title={t("pages.marketplace.listings.unavailable")} description={error} />
        ) : listings.length === 0 ? (
          <EmptyState
            title={t("pages.marketplace.listings.emptyTitle")}
            description={t("pages.marketplace.listings.emptyDesc")}
          />
        ) : (
          listings.map((l) => (
            <Card key={l.id}>
              <CardContent className="pt-4 flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="font-medium truncate flex items-center gap-2">
                    {l.title}
                    {l.verified && <VerifiedBadge />}
                  </div>
                  <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
                    <Badge variant="outline">{l.category}</Badge>
                    <Badge variant="secondary">{l.status}</Badge>
                    <RatingStars avg={l.ratingAvg} count={l.ratingCount} />
                    <span>{t("pages.marketplace.installs", { count: l.installCount })}</span>
                  </div>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busyId === l.id}
                  onClick={() => unpublish(l.id)}
                >
                  {t("pages.marketplace.listings.unpublish")}
                </Button>
              </CardContent>
            </Card>
          ))
        )}
      </div>
    </div>
  );
}
