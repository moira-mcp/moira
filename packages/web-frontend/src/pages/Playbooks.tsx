/* eslint-disable no-console */
/**
 * Playbooks page.
 *
 * A playbook is named, reusable behaviour text a workflow node references by name instead of
 * carrying it. This screen is where that text is written, read, versioned and published; the
 * version history is the same component notes and global settings use.
 *
 * Note: console.error is used for browser debugging of API errors, as elsewhere in this app.
 */

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useSearchParams } from "react-router-dom";
import { useSession } from "../auth/better-auth-client";
import { BookOpen, FilePlus, Plus } from "lucide-react";
import { apiClient, type Playbook, type PlaybookSummary } from "../services/api-client";
import { Button } from "../components/ui/button";
import { PageShell } from "../components/PageShell";
import { FilterBar } from "../components/FilterBar";
import { DataListView } from "../components/DataListView";
import { ConfirmDialog } from "../components/confirm-dialog";
import { useDebounce } from "../hooks/useDebounce";
import { useListPageSize } from "../hooks/useListPageSize";
import { useLatestRequest } from "../hooks/useLatestRequest";
import { PlaybookEditor } from "../components/playbooks/PlaybookEditor";
import {
  RevisionHistoryDialog,
  type RevisionHistorySource,
} from "../components/history/RevisionHistoryDialog";
import { PlaybookCard } from "../components/cards";
import { VisibilityToggle } from "../components/access/VisibilityToggle";
import { X } from "lucide-react";

/**
 * A playbook a link from a workflow node points at.
 *
 * Your own opens in the editor; somebody else's published one is shown read-only, because this
 * page lists only what you own and the reference is still worth reading where it leads.
 */
type LinkedPlaybook =
  | { state: "own"; slug: string }
  | { state: "foreign"; playbook: Playbook; owner: string }
  | { state: "missing"; name: string; owner?: string };

export const Playbooks: React.FC = () => {
  const { t } = useTranslation();
  const { pageSize, containerRef, onViewModeChange } = useListPageSize(() => setCurrentPage(1));

  const [playbooks, setPlaybooks] = useState<PlaybookSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [searchQuery, setSearchQuery] = useState("");
  const [currentPage, setCurrentPage] = useState(1);
  const debouncedSearch = useDebounce(searchQuery, 300);

  // null = nothing open, "__NEW__" = creating, otherwise the slug being edited.
  const [editing, setEditing] = useState<string | null>(null);
  const [historySlug, setHistorySlug] = useState<string | null>(null);
  const [deleteSlug, setDeleteSlug] = useState<string | null>(null);

  // `?name=` (and `?owner=`) arrive from a node's reference on the flow page.
  const [searchParams, setSearchParams] = useSearchParams();
  const { data: session } = useSession();
  const [linked, setLinked] = useState<LinkedPlaybook | null>(null);

  useEffect(() => {
    setCurrentPage(1);
  }, [debouncedSearch]);

  useEffect(() => {
    const name = searchParams.get("name");
    if (!name) return;
    const owner = searchParams.get("owner") ?? undefined;
    const userId = session?.user?.id;
    if (!userId) return;
    let cancelled = false;
    apiClient
      .getPlaybook(name, owner ? { owner } : {})
      .then((playbook) => {
        if (cancelled) return;
        if (playbook.ownerId === userId) {
          // Yours: the editor, above the list — the list is one page of many and may not hold it.
          setLinked({ state: "own", slug: playbook.slug });
        } else {
          setLinked({ state: "foreign", playbook, owner: owner ?? playbook.ownerId });
        }
      })
      .catch(() => {
        if (!cancelled) setLinked({ state: "missing", name, owner });
      });
    return () => {
      cancelled = true;
    };
  }, [searchParams, session?.user?.id, setSearchParams]);

  const closeLinked = () => {
    setLinked(null);
    setSearchParams({}, { replace: true });
  };

  // One editor at a time: opening one from the list closes a landing slot that may still be open.
  const startEditing = (slug: string) => {
    if (linked) closeLinked();
    setEditing(slug);
  };

  const beginRequest = useLatestRequest();
  const load = useCallback(async () => {
    const isCurrent = beginRequest();
    try {
      setLoading(true);
      const result = await apiClient.getPlaybooks({
        search: debouncedSearch || undefined,
        limit: pageSize,
        offset: (currentPage - 1) * pageSize,
      });
      if (!isCurrent()) return;
      setPlaybooks(result.playbooks);
      setTotal(result.total);
      setError(null);
    } catch (err) {
      if (!isCurrent()) return;
      setError(err instanceof Error ? err.message : t("common.errors.failedToLoad"));
    } finally {
      if (isCurrent()) setLoading(false);
    }
  }, [beginRequest, debouncedSearch, currentPage, pageSize, t]);

  useEffect(() => {
    load();
  }, [load]);

  const historySource = useMemo<RevisionHistorySource | null>(() => {
    if (!historySlug) return null;
    return {
      label: t("pages.playbooks.history.subject", {
        name: historySlug,
        defaultValue: historySlug,
      }),
      listRevisions: () => apiClient.getPlaybookHistory(historySlug),
      readRevision: async (revision) =>
        (await apiClient.getPlaybook(historySlug, { revision })).content,
      readCurrent: async () => (await apiClient.getPlaybook(historySlug)).content,
      restore: (revision) => apiClient.restorePlaybookRevision(historySlug, revision),
    };
  }, [historySlug, t]);

  const handleDelete = useCallback(async () => {
    if (!deleteSlug) return;
    try {
      await apiClient.deletePlaybook(deleteSlug);
      setDeleteSlug(null);
      load();
    } catch (err) {
      console.error("Failed to delete playbook:", err);
    }
  }, [deleteSlug, load]);

  const totalPages = Math.ceil(total / pageSize);

  if (loading && playbooks.length === 0) {
    return <PageShell title={t("pages.playbooks.title")} loading />;
  }

  if (error) {
    return <PageShell title={t("pages.playbooks.title")} error={error} onRetry={load} />;
  }

  return (
    <PageShell title={t("pages.playbooks.title")}>
      <FilterBar
        search={searchQuery}
        onSearchChange={setSearchQuery}
        searchPlaceholder={t("pages.playbooks.searchPlaceholder")}
        searchTestId="playbooks-search"
        onReset={() => {
          setSearchQuery("");
          setCurrentPage(1);
        }}
        actions={
          <Button onClick={() => startEditing("__NEW__")} data-testid="create-playbook-button">
            <Plus className="h-4 w-4 mr-2" />
            {t("pages.playbooks.actions.create")}
          </Button>
        }
      />

      {linked?.state === "own" && (
        <div className="mb-4" data-testid="linked-playbook-editor">
          <PlaybookEditor
            slug={linked.slug}
            onClose={(saved) => {
              closeLinked();
              if (saved) load();
            }}
          />
        </div>
      )}

      {linked?.state === "foreign" && (
        <div className="mb-4 border rounded-lg p-4 space-y-3" data-testid="linked-playbook">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <div className="font-medium truncate">
                {linked.playbook.name || linked.playbook.slug}
              </div>
              <code className="text-xs text-muted-foreground">
                {`{{playbook:${linked.owner}/${linked.playbook.slug}}}`}
              </code>
            </div>
            <div className="flex items-center gap-2">
              <VisibilityToggle
                visibility={linked.playbook.visibility}
                testId="linked-playbook-visibility"
              />
              <Button
                variant="ghost"
                size="icon"
                onClick={closeLinked}
                aria-label={t("common.close")}
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
          </div>
          <p className="text-xs text-muted-foreground">{t("pages.playbooks.linked.readOnly")}</p>
          <pre
            className="text-sm font-mono whitespace-pre-wrap break-words rounded-md bg-muted p-3"
            data-testid="linked-playbook-content"
          >
            {linked.playbook.content}
          </pre>
        </div>
      )}

      {linked?.state === "missing" && (
        <div
          className="mb-4 flex items-center justify-between gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm"
          data-testid="linked-playbook-missing"
        >
          <span>
            {t("pages.playbooks.linked.missing", {
              reference: linked.owner ? `${linked.owner}/${linked.name}` : linked.name,
            })}
          </span>
          <Button variant="ghost" size="sm" onClick={closeLinked}>
            {t("common.close")}
          </Button>
        </div>
      )}

      {editing === "__NEW__" ? (
        <div className="mb-4" data-testid="new-playbook-editor">
          <PlaybookEditor
            slug={null}
            onClose={(saved) => {
              setEditing(null);
              if (saved) load();
            }}
          />
        </div>
      ) : (
        <button
          className="w-full mb-4 p-4 border-2 border-dashed border-muted-foreground/25 rounded-lg hover:border-primary/40 hover:bg-accent/50 transition-colors flex items-center gap-3 text-muted-foreground hover:text-foreground"
          onClick={() => startEditing("__NEW__")}
          data-testid="new-playbook-card"
        >
          <FilePlus className="h-5 w-5" />
          <div className="text-left">
            <div className="text-sm font-medium">{t("pages.playbooks.newCard")}</div>
            <div className="text-xs">{t("pages.playbooks.newCardHint")}</div>
          </div>
        </button>
      )}

      <DataListView
        onViewModeChange={onViewModeChange}
        items={playbooks}
        renderCard={(playbook, viewMode) =>
          editing === playbook.slug ? (
            <PlaybookEditor
              slug={playbook.slug}
              onClose={(saved) => {
                setEditing(null);
                if (saved) load();
              }}
            />
          ) : (
            <PlaybookCard
              playbook={playbook}
              compact={viewMode === "grid"}
              onClick={() => startEditing(playbook.slug)}
              onEdit={() => startEditing(playbook.slug)}
              onHistory={() => setHistorySlug(playbook.slug)}
              onDelete={() => setDeleteSlug(playbook.slug)}
            />
          )
        }
        keyExtractor={(p) => p.slug}
        storageKey="playbooks-view-mode"
        loading={loading}
        emptyIcon={BookOpen}
        emptyTitle={
          debouncedSearch ? t("pages.playbooks.noResults") : t("pages.playbooks.noPlaybooks")
        }
        containerRef={containerRef}
        pagination={{
          mode: "total",
          currentPage,
          totalPages,
          totalItems: total,
          pageSize,
          onPageChange: setCurrentPage,
        }}
        className="flex-1 min-h-0 flex flex-col"
      />

      <RevisionHistoryDialog
        open={historySlug !== null}
        onClose={(restored) => {
          setHistorySlug(null);
          if (restored) load();
        }}
        source={historySource}
      />

      <ConfirmDialog
        open={deleteSlug !== null}
        onOpenChange={(open) => !open && setDeleteSlug(null)}
        title={t("pages.playbooks.delete.title")}
        description={t("pages.playbooks.delete.description", { name: deleteSlug })}
        confirmLabel={t("common.delete")}
        cancelLabel={t("common.cancel")}
        variant="destructive"
        onConfirm={handleDelete}
      />
    </PageShell>
  );
};
