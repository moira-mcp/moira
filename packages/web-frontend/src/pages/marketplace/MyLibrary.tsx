/**
 * "My Library" — workflows the user can run: core (built-in), their own, added
 * references, and shared. This is the in-app view of what `list()` returns to an agent.
 */

import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { apiClient } from "../../services/api-client";
import { ROUTES } from "../../constants/routes";
import { Badge } from "../../components/ui/badge";
import { Card, CardContent } from "../../components/ui/card";
import { EmptyState } from "../../components/empty-state";
import type { MarketplaceLibraryItem } from "../../types/api-types";

const ORIGIN_KEY: Record<string, string> = {
  core: "pages.marketplace.library.originCore",
  own: "pages.marketplace.library.originOwn",
  added: "pages.marketplace.library.originAdded",
  shared: "pages.marketplace.library.originShared",
};

export function MyLibrary() {
  const { t } = useTranslation();
  const [items, setItems] = useState<MarketplaceLibraryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiClient
      .getMyLibrary()
      .then(setItems)
      .catch((e) =>
        setError(e instanceof Error ? e.message : t("pages.marketplace.library.loadFailed")),
      )
      .finally(() => setLoading(false));
  }, [t]);

  return (
    <div className="container mx-auto max-w-3xl px-4 py-6">
      <Link to={ROUTES.MARKETPLACE} className="text-primary hover:underline text-sm">
        ← {t("pages.marketplace.back")}
      </Link>
      <h1 className="mt-3 text-2xl font-semibold">{t("pages.marketplace.library.title")}</h1>
      <p className="text-sm text-muted-foreground">{t("pages.marketplace.library.subtitle")}</p>

      <div className="mt-5 space-y-2">
        {loading ? (
          <p className="text-muted-foreground">{t("pages.marketplace.loading")}</p>
        ) : error ? (
          <EmptyState title={t("pages.marketplace.library.unavailable")} description={error} />
        ) : items.length === 0 ? (
          <EmptyState
            title={t("pages.marketplace.library.emptyTitle")}
            description={t("pages.marketplace.library.emptyDesc")}
          />
        ) : (
          items.map((item) => (
            <Card key={`${item.origin}:${item.workflowId ?? item.slug}`}>
              <CardContent className="pt-4 flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="font-medium truncate">{item.name}</div>
                  <code className="text-xs text-muted-foreground">
                    {`start("${item.ownerHandle ? `${item.ownerHandle}/${item.slug}` : item.slug}")`}
                  </code>
                </div>
                <div className="flex gap-1 shrink-0">
                  <Badge variant="secondary">
                    {t(ORIGIN_KEY[item.origin] ?? item.origin)}
                  </Badge>
                  {item.kind && <Badge variant="outline">{item.kind}</Badge>}
                </div>
              </CardContent>
            </Card>
          ))
        )}
      </div>
    </div>
  );
}
