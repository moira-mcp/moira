/**
 * Workflows home — a SINGLE unified "Your library" surface for every workflow the user
 * can run, driven by the filterable library read (`getMyLibrary`).
 *
 * The old origin tabs (Mine/Added/Shared/Core) are gone. Instead a lightweight chip row
 * (All / Official / Added / Mine / Shared) filters one client-side list of {@link FlowCard}s:
 *   - own    → full management: export, publish/unpublish + a public listing link, edit, delete.
 *   - added  → a link to the source listing on the PUBLIC catalog (root `/w/:handle/:slug`).
 *   - shared → the MCP-first run hint only.
 * Every item carries an Official badge when it is owned by an official system account.
 *
 * The active filter lives in the URL (`?filter=all|official|added|mine|shared`, default
 * `all`) so it is linkable and survives reloads. Legacy `?origin=mine|added|shared|core`
 * links are redirected to their `?filter=` equivalent (core → all).
 *
 * MCP-FIRST: this view never executes workflows or shows `start(...)` code — workflows are
 * authored by the user's agent (via MCP) or adopted from the catalog / imported from a file.
 */

import React, { useState, useEffect, useCallback, useMemo } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { ExternalLink, Upload, Download, Store, Pencil, Trash2 } from "lucide-react";
import { Button } from "../components/ui/button";
import { Badge } from "../components/ui/badge";
import { Input } from "../components/ui/input";
import { apiClient } from "../services/api-client";
import { ROUTES } from "../constants/routes";
import { publicCatalogPath, publicFlowPath } from "./marketplace/components";
import { useFeatures } from "../hooks/useFeatures";
import { useDebounce } from "../hooks/useDebounce";
import { FlowCard } from "../components/flow/FlowCard";
import { LibraryFilterChips } from "../components/flow/LibraryFilterChips";
import { ConfirmDialog } from "../components/confirm-dialog";
import { PageShell } from "../components/PageShell";
import { PageLoader } from "../components/page-loader";
import { InlineError } from "../components/inline-error";
import { EmptyState } from "../components/empty-state";
import type {
  LibrarySourceFilter,
  MarketplaceLibraryItem,
  MarketplaceListing,
} from "../types/api-types";
import { toast } from "sonner";

const FILTERS: readonly LibrarySourceFilter[] = ["all", "official", "added", "mine", "shared"];

function parseFilter(value: string | null): LibrarySourceFilter {
  return FILTERS.includes(value as LibrarySourceFilter) ? (value as LibrarySourceFilter) : "all";
}

/** Legacy `?origin=` value → its `?filter=` equivalent (core had no chip → folds into all). */
const ORIGIN_TO_FILTER: Record<string, LibrarySourceFilter> = {
  mine: "mine",
  added: "added",
  shared: "shared",
  core: "all",
};

/** Mirror of the backend `filterLibrary`: scope the library to the active chip. */
function applyFilter(
  items: MarketplaceLibraryItem[],
  source: LibrarySourceFilter,
): MarketplaceLibraryItem[] {
  switch (source) {
    case "all":
      return items;
    case "official":
      return items.filter((item) => item.official);
    case "added":
      return items.filter((item) => item.origin === "added");
    case "mine":
      return items.filter((item) => item.origin === "own");
    case "shared":
      return items.filter((item) => item.origin === "shared");
  }
}

export const Workflows: React.FC = () => {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const { publicStore, isEnabled } = useFeatures();
  const importInputRef = React.useRef<HTMLInputElement>(null);
  const [importing, setImporting] = useState(false);
  const [searchParams, setSearchParams] = useSearchParams();
  const marketplaceEnabled = isEnabled("marketplace");

  // Redirect legacy `?origin=` links to their `?filter=` equivalent (replace, so the back
  // button is unaffected). Runs before the filter is read below.
  const legacyOrigin = searchParams.get("origin");
  useEffect(() => {
    if (legacyOrigin === null) return;
    const next = new URLSearchParams(searchParams);
    next.delete("origin");
    next.set("filter", ORIGIN_TO_FILTER[legacyOrigin] ?? "all");
    setSearchParams(next, { replace: true });
  }, [legacyOrigin, searchParams, setSearchParams]);

  const activeFilter = parseFilter(searchParams.get("filter"));

  const [search, setSearch] = useState("");
  const debouncedSearch = useDebounce(search.trim(), 250);

  // The catalog promo affordance: point at the public hosted store when this instance
  // promotes it (growth funnel, gated only by deployment topology), otherwise fall back to
  // the local catalog.
  const promoteStore = publicStore.promotionEnabled && !!publicStore.url;
  const catalogHref = promoteStore ? publicStore.url : publicCatalogPath();

  const [deleteTarget, setDeleteTarget] = useState<{ id: string; name: string } | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  // The whole library (own/added/shared) + the user's listings (to mark which own flows
  // are published). One fetch; the chips filter client-side.
  const [library, setLibrary] = useState<MarketplaceLibraryItem[] | null>(null);
  const [listings, setListings] = useState<MarketplaceListing[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadLibrary = useCallback(() => {
    setLoading(true);
    setError(null);
    Promise.all([apiClient.getMyLibrary(), apiClient.getMyListings().catch(() => [])])
      .then(([items, myListings]) => {
        setLibrary(items);
        setListings(myListings);
      })
      .catch((e: unknown) =>
        setError(e instanceof Error ? e.message : t("pages.workflows.home.loadFailed")),
      )
      .finally(() => setLoading(false));
  }, [t]);

  useEffect(() => loadLibrary(), [loadLibrary, refreshKey]);

  const setActiveFilter = useCallback(
    (filter: LibrarySourceFilter) => {
      const next = new URLSearchParams(searchParams);
      next.set("filter", filter);
      setSearchParams(next, { replace: true });
    },
    [searchParams, setSearchParams],
  );

  // own workflowId → its active marketplace listing (for unpublish + the public "View on
  // marketplace" link).
  const listingByWorkflowId = useMemo(() => {
    const map = new Map<string, MarketplaceListing>();
    for (const listing of listings) map.set(listing.workflowId, listing);
    return map;
  }, [listings]);

  const counts = useMemo((): Partial<Record<LibrarySourceFilter, number>> => {
    if (!library) return {};
    return {
      all: library.length,
      official: library.filter((i) => i.official).length,
      added: library.filter((i) => i.origin === "added").length,
      mine: library.filter((i) => i.origin === "own").length,
      shared: library.filter((i) => i.origin === "shared").length,
    };
  }, [library]);

  const visibleItems = useMemo(() => {
    const byFilter = applyFilter(library ?? [], activeFilter);
    if (!debouncedSearch) return byFilter;
    const needle = debouncedSearch.toLowerCase();
    return byFilter.filter((item) => item.name.toLowerCase().includes(needle));
  }, [library, activeFilter, debouncedSearch]);

  const handleExport = useCallback(
    async (workflowId: string, slug: string): Promise<void> => {
      try {
        const blob = await apiClient.exportWorkflow(workflowId);
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `${slug || workflowId}.moira.json`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
      } catch {
        toast.error(t("pages.workflows.home.exportError"));
      }
    },
    [t],
  );

  const handlePublish = useCallback(
    (workflowId: string) => {
      navigate(`${ROUTES.MARKETPLACE}/publish?workflowId=${encodeURIComponent(workflowId)}`);
    },
    [navigate],
  );

  const handleUnpublish = useCallback(
    async (listingId: string) => {
      try {
        await apiClient.unpublishListing(listingId);
        toast.success(t("pages.workflows.home.unpublished"));
        setRefreshKey((k) => k + 1);
      } catch (err: unknown) {
        toast.error(err instanceof Error ? err.message : t("pages.workflows.home.unpublishFailed"));
      }
    },
    [t],
  );

  const handleConfirmDelete = async () => {
    if (!deleteTarget) return;
    try {
      await apiClient.deleteWorkflow(deleteTarget.id);
      setRefreshKey((k) => k + 1);
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : t("common.errors.failedToDelete"));
    }
  };

  // Import-from-file: the offline adoption path (no cloud call). Reads a workflow JSON file
  // and posts it to the gated import endpoint; the imported copy lands under Mine.
  const handleImportFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ""; // reset so the same file can be re-selected
    if (!file) return;
    setImporting(true);
    try {
      const result = await apiClient.importWorkflowFile(file);
      toast.success(t("pages.workflows.home.importSuccess", { name: result.name }));
      setRefreshKey((k) => k + 1);
      setActiveFilter("mine");
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : t("pages.workflows.home.importError"));
    } finally {
      setImporting(false);
    }
  };

  /** Origin-specific action controls + badges for a library item. */
  const renderCard = (item: MarketplaceLibraryItem) => {
    const key = `${item.origin}:${item.workflowId ?? item.slug}`;

    if (item.origin === "own" && item.workflowId) {
      const workflowId = item.workflowId;
      const listing = listingByWorkflowId.get(workflowId);
      const badges = listing ? (
        <Badge
          variant="outline"
          className="gap-1 border-primary/30 text-primary bg-primary/10"
          data-testid="listed-badge"
        >
          <Store className="h-3 w-3" />
          <span className="hidden sm:inline">{t("pages.workflows.home.listed")}</span>
        </Badge>
      ) : undefined;

      const actions = (
        <>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 text-muted-foreground hover:text-foreground"
            title={t("pages.workflows.home.export")}
            aria-label={t("pages.workflows.home.export")}
            data-testid="export-workflow"
            onClick={() => handleExport(workflowId, item.slug)}
          >
            <Download className="h-3.5 w-3.5" />
          </Button>
          {listing ? (
            <>
              {item.ownerHandle && (
                <Button
                  variant="ghost"
                  size="icon"
                  asChild
                  className="h-7 w-7 text-primary hover:text-primary"
                  title={t("pages.workflows.home.viewOnMarketplace")}
                  aria-label={t("pages.workflows.home.viewOnMarketplace")}
                >
                  <a
                    href={publicFlowPath(item.ownerHandle, item.slug)}
                    data-testid="view-on-marketplace"
                  >
                    <ExternalLink className="h-3.5 w-3.5" />
                  </a>
                </Button>
              )}
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 text-muted-foreground hover:text-foreground"
                title={t("pages.workflows.home.unpublish")}
                aria-label={t("pages.workflows.home.unpublish")}
                data-testid="unpublish-workflow"
                onClick={() => handleUnpublish(listing.id)}
              >
                <Store className="h-3.5 w-3.5" />
              </Button>
            </>
          ) : (
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 text-muted-foreground hover:text-primary"
              title={t("pages.workflows.home.publish")}
              aria-label={t("pages.workflows.home.publish")}
              data-testid="publish-workflow"
              onClick={() => handlePublish(workflowId)}
            >
              <Upload className="h-3.5 w-3.5" />
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 text-muted-foreground hover:text-foreground"
            title={t("pages.workflows.home.edit")}
            aria-label={t("pages.workflows.home.edit")}
            data-testid="edit-workflow"
            onClick={() =>
              // Prefer the readable handle/slug route; fall back to the unambiguous
              // /workflows/:id route when an own flow has no handle (avoids a broken link).
              navigate(
                item.ownerHandle
                  ? `${ROUTES.WORKFLOWS}/${item.ownerHandle}/${item.slug}`
                  : `${ROUTES.WORKFLOWS}/${workflowId}`,
              )
            }
          >
            <Pencil className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 text-destructive hover:text-destructive"
            title={t("common.delete", { defaultValue: "Delete" })}
            aria-label={t("common.delete", { defaultValue: "Delete" })}
            data-testid="delete-workflow"
            onClick={() => setDeleteTarget({ id: workflowId, name: item.name })}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </>
      );

      return (
        <FlowCard
          key={key}
          name={item.name}
          official={item.official}
          badges={badges}
          actions={actions}
        />
      );
    }

    if (item.origin === "added") {
      const actions = item.ownerHandle ? (
        <a
          href={publicFlowPath(item.ownerHandle, item.slug)}
          className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
          data-testid="added-source-link"
        >
          {t("pages.workflows.home.viewSource")}
          <ExternalLink className="h-3 w-3" />
        </a>
      ) : undefined;
      return (
        <FlowCard
          key={key}
          name={item.name}
          official={item.official}
          ownerHandle={item.ownerHandle}
          actions={actions}
        />
      );
    }

    // shared — run hint only.
    return (
      <FlowCard
        key={key}
        name={item.name}
        official={item.official}
        ownerHandle={item.ownerHandle}
      />
    );
  };

  const renderEmpty = () => {
    // A search with no matches is distinct from an empty filter.
    if (debouncedSearch) {
      return (
        <EmptyState
          title={t("pages.workflows.home.empty.search.title")}
          description={t("pages.workflows.home.empty.search.desc", { query: debouncedSearch })}
        />
      );
    }
    // The Mine filter can be empty for a new user (their agent has authored nothing yet);
    // offer the adoption affordances (import + browse the catalog).
    const action =
      activeFilter === "mine" ? (
        <div className="flex items-center gap-2">
          {marketplaceEnabled && (
            <Button
              variant="outline"
              size="sm"
              disabled={importing}
              onClick={() => importInputRef.current?.click()}
            >
              <Upload className="h-3.5 w-3.5" />
              {t("pages.workflows.home.import")}
            </Button>
          )}
          <Button variant="outline" size="sm" asChild>
            <a
              href={catalogHref}
              target={promoteStore ? "_blank" : undefined}
              rel={promoteStore ? "noopener noreferrer" : undefined}
            >
              {t("pages.workflows.home.browseCatalog")}
              <ExternalLink className="h-3.5 w-3.5" />
            </a>
          </Button>
        </div>
      ) : undefined;
    return (
      <EmptyState
        title={t(`pages.workflows.home.empty.${activeFilter}.title`)}
        description={t(`pages.workflows.home.empty.${activeFilter}.desc`)}
        action={action}
      />
    );
  };

  return (
    <PageShell
      title={t("pages.workflows.title")}
      description={t("pages.workflows.subtitle")}
      actions={
        <div className="flex items-center gap-4">
          {marketplaceEnabled && (
            <>
              <input
                ref={importInputRef}
                type="file"
                accept="application/json,.json"
                className="hidden"
                data-testid="import-workflow-input"
                onChange={handleImportFile}
              />
              <Button
                variant="outline"
                size="sm"
                disabled={importing}
                onClick={() => importInputRef.current?.click()}
                data-testid="import-workflow-button"
              >
                <Upload className="h-3.5 w-3.5" />
                {t("pages.workflows.home.import")}
              </Button>
            </>
          )}
          <a
            href={catalogHref}
            target={promoteStore ? "_blank" : undefined}
            rel={promoteStore ? "noopener noreferrer" : undefined}
            data-testid="browse-catalog-link"
            className="inline-flex items-center gap-1 text-sm text-primary hover:underline"
          >
            {t("pages.workflows.home.browseCatalog")}
            <ExternalLink className="h-3.5 w-3.5" />
          </a>
        </div>
      }
    >
      <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
        <LibraryFilterChips value={activeFilter} onChange={setActiveFilter} counts={counts} />
        <Input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t("pages.workflows.home.searchPlaceholder")}
          aria-label={t("pages.workflows.home.searchPlaceholder")}
          className="w-full sm:w-64"
          data-testid="library-search"
        />
      </div>

      {loading && !library ? (
        <PageLoader />
      ) : error ? (
        <InlineError message={error} />
      ) : visibleItems.length === 0 ? (
        renderEmpty()
      ) : (
        <div className="space-y-2" data-testid="library-list">
          {visibleItems.map(renderCard)}
        </div>
      )}

      <ConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
        title={t("pages.workflows.confirmDeleteTitle", { defaultValue: "Delete workflow" })}
        description={t("pages.workflows.confirmDelete", { name: deleteTarget?.name ?? "" })}
        confirmLabel={t("common.delete", { defaultValue: "Delete" })}
        cancelLabel={t("common.cancel", { defaultValue: "Cancel" })}
        variant="destructive"
        onConfirm={handleConfirmDelete}
      />
    </PageShell>
  );
};
