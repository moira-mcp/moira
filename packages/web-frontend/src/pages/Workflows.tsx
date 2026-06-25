/**
 * Workflows home — an origin-organized view of every workflow the user can run.
 *
 * Tabs follow the agent's library origins:
 *   - Mine   → full management (WorkflowExplorer: getWorkflows) + publish/unpublish.
 *   - Added  → flows added by reference from the public catalog (getMyLibrary origin=added).
 *   - Shared → flows shared with the user (origin=shared).
 *   - Core   → built-in flows (origin=core).
 *
 * The active tab lives in the URL (`?origin=mine|added|shared|core`, default `mine`) so it
 * is linkable and survives reloads. This unifies the old standalone "Workflows" view and the
 * marketplace "My Library"; the latter route now redirects here.
 */

import React, { useState, useEffect, useCallback, useMemo } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { ExternalLink } from "lucide-react";
import { WorkflowFileInfo } from "types";
import { WorkflowExplorer } from "../components/workflow/WorkflowExplorer";
import { apiClient } from "../services/api-client";
import { ROUTES } from "../constants/routes";
import { publicCatalogPath } from "./marketplace/components";
import { OriginLibraryList } from "../components/workflow/OriginLibraryList";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../components/ui/tabs";
import { Badge } from "../components/ui/badge";
import { ConfirmDialog } from "../components/confirm-dialog";
import { PageShell } from "../components/PageShell";
import type { MarketplaceLibraryItem, MarketplaceListing } from "../types/api-types";
import { toast } from "sonner";

type OriginTab = "mine" | "added" | "shared" | "core";
const ORIGIN_TABS: OriginTab[] = ["mine", "added", "shared", "core"];

function parseOrigin(value: string | null): OriginTab {
  return ORIGIN_TABS.includes(value as OriginTab) ? (value as OriginTab) : "mine";
}

export const Workflows: React.FC = () => {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const [searchParams, setSearchParams] = useSearchParams();
  const activeTab = parseOrigin(searchParams.get("origin"));

  const [currentUserHandle, setCurrentUserHandle] = useState<string | undefined>();
  const [isAdmin, setIsAdmin] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; name: string } | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  // Library (added/shared/core) + the user's listings (to mark which own flows are published).
  const [library, setLibrary] = useState<MarketplaceLibraryItem[] | null>(null);
  const [listings, setListings] = useState<MarketplaceListing[]>([]);
  const [libraryLoading, setLibraryLoading] = useState(true);
  const [libraryError, setLibraryError] = useState<string | null>(null);

  useEffect(() => {
    const fetchUserInfo = async () => {
      try {
        const userInfo = await apiClient.getUserInfo();
        setCurrentUserHandle(userInfo.handle || undefined);
        setIsAdmin(userInfo.isAdmin);
      } catch {
        // Ignore errors - user info is optional for delete button visibility
      }
    };
    fetchUserInfo();
  }, []);

  const loadLibrary = useCallback(() => {
    setLibraryLoading(true);
    setLibraryError(null);
    Promise.all([apiClient.getMyLibrary(), apiClient.getMyListings().catch(() => [])])
      .then(([items, myListings]) => {
        setLibrary(items);
        setListings(myListings);
      })
      .catch((e: unknown) =>
        setLibraryError(e instanceof Error ? e.message : t("pages.workflows.home.loadFailed")),
      )
      .finally(() => setLibraryLoading(false));
  }, [t]);

  useEffect(() => loadLibrary(), [loadLibrary, refreshKey]);

  const setActiveTab = useCallback(
    (origin: OriginTab) => {
      const next = new URLSearchParams(searchParams);
      next.set("origin", origin);
      setSearchParams(next, { replace: true });
    },
    [searchParams, setSearchParams],
  );

  const handleWorkflowSelect = useCallback(
    (workflow: WorkflowFileInfo) => {
      navigate(`${ROUTES.WORKFLOWS}/${workflow.ownerHandle}/${workflow.slug}`);
    },
    [navigate],
  );

  const handleDeleteWorkflow = useCallback((workflowId: string, workflowName: string) => {
    setDeleteTarget({ id: workflowId, name: workflowName });
  }, []);

  const handleConfirmDelete = async () => {
    if (!deleteTarget) return;
    try {
      await apiClient.deleteWorkflow(deleteTarget.id);
      setRefreshKey((k) => k + 1);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : t("common.errors.failedToDelete");
      toast.error(message);
    }
  };

  // Publish-from-management: map own workflowId → its active listing (for unpublish + the
  // public "View on marketplace" link). Listings carry the listing id and the source
  // workflow id; the public handle/slug come from the workflow row itself in the Mine tab.
  const listingByWorkflowId = useMemo(() => {
    const map = new Map<string, MarketplaceListing>();
    for (const listing of listings) map.set(listing.workflowId, listing);
    return map;
  }, [listings]);

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

  const added = useMemo(() => (library ?? []).filter((item) => item.origin === "added"), [library]);
  const shared = useMemo(
    () => (library ?? []).filter((item) => item.origin === "shared"),
    [library],
  );
  const core = useMemo(() => (library ?? []).filter((item) => item.origin === "core"), [library]);

  // Per-tab count badge. Mine has no cheap count (paginated server list), so it is omitted.
  const counts: Partial<Record<OriginTab, number>> = library
    ? { added: added.length, shared: shared.length, core: core.length }
    : {};

  const renderTabLabel = (origin: OriginTab) => {
    const count = counts[origin];
    return (
      <span className="flex items-center gap-1.5">
        {t(`pages.workflows.home.tab.${origin}`)}
        {count !== undefined && (
          <Badge variant="secondary" className="px-1.5 py-0 text-[10px]">
            {count}
          </Badge>
        )}
      </span>
    );
  };

  return (
    <PageShell
      title={t("pages.workflows.title")}
      description={t("pages.workflows.subtitle")}
      actions={
        <a
          href={publicCatalogPath()}
          className="inline-flex items-center gap-1 text-sm text-primary hover:underline"
        >
          {t("pages.workflows.home.browseCatalog")}
          <ExternalLink className="h-3.5 w-3.5" />
        </a>
      }
    >
      <Tabs
        value={activeTab}
        onValueChange={(v) => setActiveTab(parseOrigin(v))}
        className="flex flex-col flex-1 min-h-0"
      >
        <TabsList variant="line" className="mb-4 self-start">
          {ORIGIN_TABS.map((origin) => (
            <TabsTrigger key={origin} value={origin} data-testid={`origin-tab-${origin}`}>
              {renderTabLabel(origin)}
            </TabsTrigger>
          ))}
        </TabsList>

        <TabsContent value="mine" className="flex flex-col flex-1 min-h-0">
          <WorkflowExplorer
            key={refreshKey}
            onWorkflowSelect={handleWorkflowSelect}
            onDelete={handleDeleteWorkflow}
            currentUserHandle={currentUserHandle}
            isAdmin={isAdmin}
            listingByWorkflowId={listingByWorkflowId}
            onPublish={handlePublish}
            onUnpublish={handleUnpublish}
            ownedOnly
          />
        </TabsContent>

        <TabsContent value="added">
          <OriginLibraryList
            origin="added"
            items={added}
            loading={libraryLoading}
            error={libraryError}
          />
        </TabsContent>

        <TabsContent value="shared">
          <OriginLibraryList
            origin="shared"
            items={shared}
            loading={libraryLoading}
            error={libraryError}
          />
        </TabsContent>

        <TabsContent value="core">
          <OriginLibraryList
            origin="core"
            items={core}
            loading={libraryLoading}
            error={libraryError}
          />
        </TabsContent>
      </Tabs>

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
