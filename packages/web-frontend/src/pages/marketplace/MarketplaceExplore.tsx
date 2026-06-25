/**
 * Marketplace gallery (in-app, authenticated SPA route). The crawlable/no-JS version
 * is the server-rendered /explore page (Step 7); this is the interactive variant with
 * live search + sort + the user's library/listings entry points.
 */

import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { apiClient } from "../../services/api-client";
import { ROUTES } from "../../constants/routes";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select";
import { EmptyState } from "../../components/empty-state";
import { ListingCard } from "./components";
import type { MarketplaceGalleryItem, MarketplaceSort } from "../../types/api-types";

export function MarketplaceExplore() {
  const { t } = useTranslation();
  const [items, setItems] = useState<MarketplaceGalleryItem[]>([]);
  const [total, setTotal] = useState(0);
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<MarketplaceSort>("recent");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const page = await apiClient.getMarketplaceGallery({
        search: search.trim() || undefined,
        sort,
        limit: 60,
      });
      setItems(page.items);
      setTotal(page.total);
    } catch (e) {
      setError(e instanceof Error ? e.message : t("pages.marketplace.loadFailed"));
    } finally {
      setLoading(false);
    }
  }, [search, sort, t]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="container mx-auto max-w-5xl px-4 py-6">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold">{t("pages.marketplace.title")}</h1>
          <p className="text-muted-foreground text-sm">{t("pages.marketplace.subtitle")}</p>
        </div>
        <div className="flex gap-2">
          <Button asChild variant="outline">
            <Link to={`${ROUTES.WORKFLOWS}?origin=added`}>{t("pages.marketplace.navLibrary")}</Link>
          </Button>
          <Button asChild variant="outline">
            <Link to={`${ROUTES.MARKETPLACE}/my-listings`}>
              {t("pages.marketplace.navListings")}
            </Link>
          </Button>
          <Button asChild>
            <Link to={`${ROUTES.MARKETPLACE}/publish`}>{t("pages.marketplace.navPublish")}</Link>
          </Button>
        </div>
      </div>

      <form
        className="mt-5 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void load();
        }}
      >
        <Input
          placeholder={t("pages.marketplace.searchPlaceholder")}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          aria-label={t("pages.marketplace.searchAria")}
        />
        <Select value={sort} onValueChange={(v) => setSort(v as MarketplaceSort)}>
          <SelectTrigger className="w-40" aria-label={t("pages.marketplace.sortAria")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="recent">{t("pages.marketplace.sortRecent")}</SelectItem>
            <SelectItem value="rating">{t("pages.marketplace.sortRating")}</SelectItem>
            <SelectItem value="installs">{t("pages.marketplace.sortInstalls")}</SelectItem>
            <SelectItem value="trending">{t("pages.marketplace.sortTrending")}</SelectItem>
          </SelectContent>
        </Select>
        <Button type="submit" variant="secondary">
          {t("pages.marketplace.searchButton")}
        </Button>
      </form>

      <div className="mt-6">
        {loading ? (
          <p className="text-muted-foreground">{t("pages.marketplace.loading")}</p>
        ) : error ? (
          <EmptyState title={t("pages.marketplace.unavailable")} description={error} />
        ) : items.length === 0 ? (
          <EmptyState
            title={t("pages.marketplace.emptyTitle")}
            description={t("pages.marketplace.emptyDesc")}
          />
        ) : (
          <>
            <p className="text-xs text-muted-foreground mb-3">
              {t("pages.marketplace.publishedCount", { count: total })}
            </p>
            <div className="grid gap-3 sm:grid-cols-2">
              {items.map((item) => (
                <ListingCard key={item.id} item={item} />
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
