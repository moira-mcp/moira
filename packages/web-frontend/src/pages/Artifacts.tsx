/* eslint-disable no-console */
/**
 * Artifacts Page
 * User artifacts management with list, upload, edit, and quota indicator
 *
 * Note: console.error used for browser debugging of API errors
 */

import React, { useState, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { Plus, FileCode } from "lucide-react";
import { apiClient } from "../services/api-client";
import { Button } from "../components/ui/button";
import { Progress } from "../components/ui/progress";
import { PageShell } from "../components/PageShell";
import { FilterBar } from "../components/FilterBar";
import { useListPageSize } from "../hooks/useListPageSize";
import { useLatestRequest } from "../hooks/useLatestRequest";
import { ArtifactCard } from "../components/cards";
import { formatSize } from "../components/cards/format-utils";
import type { ArtifactCardData } from "../components/cards";
import { DataListView } from "../components/DataListView";
import { ConfirmDialog } from "../components/confirm-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Textarea } from "../components/ui/textarea";
import { guideAnchor } from "@/guides/anchors";
import { DataRegion } from "@/components/DataRegion";
import { useResource } from "@/hooks/useResource";
import { InlineError } from "@/components/inline-error";

interface ArtifactListItem {
  uuid: string;
  url: string;
  name: string;
  size: number;
  mimeType: string;
  executionId: string | null;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
}

interface ArtifactStats {
  totalArtifacts: number;
  totalSize: number;
  storageLimit: number;
  countLimit: number;
  storageUsedPercent: number;
  countUsedPercent: number;
}

export const Artifacts: React.FC = () => {
  const { t } = useTranslation();
  const { pageSize, containerRef, onViewModeChange } = useListPageSize(() => setCurrentPage(1));

  // Data state
  const [accepted, setAccepted] = useState<{
    artifacts: ArtifactListItem[];
    total: number;
    page: number;
    pageSize: number;
  } | null>(null);
  const artifacts = accepted?.artifacts ?? [];
  const total = accepted?.total ?? 0;
  const statsResource = useResource<ArtifactStats>("artifact-stats", () =>
    apiClient.getArtifactStats(),
  );
  const stats = statsResource.data;
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Pagination state
  const [currentPage, setCurrentPage] = useState(1);

  // Dialog state
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [selectedArtifact, setSelectedArtifact] = useState<ArtifactListItem | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [_copiedUuid, setCopiedUuid] = useState<string | null>(null);

  // Create form state
  const [newArtifactName, setNewArtifactName] = useState("");
  const [newArtifactContent, setNewArtifactContent] = useState("");
  const [createError, setCreateError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  // Edit form state
  const [editArtifactContent, setEditArtifactContent] = useState("");
  const [editError, setEditError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [loadingContent, setLoadingContent] = useState(false);

  // Load artifacts
  const beginRequest = useLatestRequest();
  const loadArtifacts = useCallback(async () => {
    const isCurrent = beginRequest();
    try {
      setLoading(true);

      const result = await apiClient.getArtifacts({
        limit: pageSize,
        offset: (currentPage - 1) * pageSize,
      });

      if (!isCurrent()) return;
      setAccepted({
        artifacts: result.artifacts,
        total: result.total,
        page: currentPage,
        pageSize,
      });
      setError(null);
    } catch (err: unknown) {
      if (!isCurrent()) return;
      const message = err instanceof Error ? err.message : t("common.errors.failedToLoad");
      setError(message);
    } finally {
      if (isCurrent()) setLoading(false);
    }
  }, [beginRequest, currentPage, pageSize, t]);

  useEffect(() => {
    loadArtifacts();
  }, [loadArtifacts]);

  const handleCopyUrl = async (artifact: ArtifactListItem) => {
    try {
      await navigator.clipboard.writeText(artifact.url);
      setCopiedUuid(artifact.uuid);
      setTimeout(() => setCopiedUuid(null), 2000);
    } catch (err) {
      console.error("Failed to copy URL:", err);
    }
  };

  const handleDeleteClick = (artifact: ArtifactListItem) => {
    setDeleteError(null);
    setSelectedArtifact(artifact);
    setDeleteDialogOpen(true);
  };

  const handleDeleteConfirm = async () => {
    if (!selectedArtifact) return;
    setDeleteError(null);
    try {
      await apiClient.deleteArtifact(selectedArtifact.uuid);
      setDeleteDialogOpen(false);
      setSelectedArtifact(null);
      loadArtifacts();
      void statsResource.refresh();
    } catch (err) {
      console.error("Failed to delete artifact:", err);
      setDeleteError(err instanceof Error ? err.message : t("common.errors.failedToDelete"));
      throw err;
    }
  };

  const handleEditClick = async (artifact: ArtifactListItem) => {
    setSelectedArtifact(artifact);
    setEditError(null);
    setEditDialogOpen(true);
    setLoadingContent(true);

    try {
      // Fetch artifact content via public URL
      const response = await fetch(artifact.url);
      if (!response.ok) {
        throw new Error("Failed to fetch artifact content");
      }
      const content = await response.text();
      setEditArtifactContent(content);
    } catch (err) {
      console.error("Failed to load artifact content:", err);
      setEditError(t("pages.artifacts.editor.loadError"));
    } finally {
      setLoadingContent(false);
    }
  };

  const handleEditSubmit = async () => {
    if (!selectedArtifact) return;

    if (!editArtifactContent.trim()) {
      setEditError(t("pages.artifacts.editor.contentRequired"));
      return;
    }

    if (!editArtifactContent.toLowerCase().includes("<html")) {
      setEditError(t("pages.artifacts.editor.mustContainHtml"));
      return;
    }

    try {
      setEditing(true);
      setEditError(null);
      await apiClient.updateArtifact(selectedArtifact.uuid, {
        content: editArtifactContent,
      });
      setEditDialogOpen(false);
      setSelectedArtifact(null);
      setEditArtifactContent("");
      loadArtifacts();
      void statsResource.refresh();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : t("common.errors.failedToSave");
      setEditError(message);
    } finally {
      setEditing(false);
    }
  };

  const handleCreateArtifact = async () => {
    if (!newArtifactName.trim() || !newArtifactContent.trim()) {
      setCreateError(t("pages.artifacts.editor.nameAndContentRequired"));
      return;
    }

    // Validate HTML content
    if (!newArtifactContent.toLowerCase().includes("<html")) {
      setCreateError(t("pages.artifacts.editor.mustContainHtml"));
      return;
    }

    try {
      setCreating(true);
      setCreateError(null);
      await apiClient.createArtifact({
        name: newArtifactName.trim(),
        content: newArtifactContent,
      });
      setCreateDialogOpen(false);
      setNewArtifactName("");
      setNewArtifactContent("");
      loadArtifacts();
      void statsResource.refresh();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : t("common.errors.failedToSave");
      setCreateError(message);
    } finally {
      setCreating(false);
    }
  };

  const totalPages = Math.ceil(total / (accepted?.pageSize ?? pageSize));

  return (
    <PageShell title={t("pages.artifacts.title")} guide={guideAnchor("artifacts.header")}>
      <FilterBar
        filters={
          <DataRegion
            hasResult={stats !== undefined}
            pending={statsResource.pending}
            error={statsResource.error}
            onRetry={statsResource.refresh}
            testId="artifact-stats-region"
          >
            {stats && (
              <div
                className="w-64"
                data-testid="quota-indicator"
                {...guideAnchor("artifacts.quota")}
              >
                <div className="flex justify-between text-sm text-muted-foreground mb-1">
                  <span>{t("pages.artifacts.quota.storage")}</span>
                  <span>
                    {formatSize(stats.totalSize)} / {formatSize(stats.storageLimit)}
                  </span>
                </div>
                <Progress value={stats.storageUsedPercent} className="h-2" />
                <div className="flex justify-between text-xs text-muted-foreground mt-1">
                  <span>
                    {stats.totalArtifacts} / {stats.countLimit}{" "}
                    {t("pages.artifacts.quota.artifacts")}
                  </span>
                  <span>{stats.storageUsedPercent.toFixed(1)}%</span>
                </div>
              </div>
            )}
          </DataRegion>
        }
        actions={
          <Button
            onClick={() => setCreateDialogOpen(true)}
            data-testid="create-artifact-button"
            {...guideAnchor("artifacts.create")}
          >
            <Plus className="h-4 w-4 mr-2" />
            {t("pages.artifacts.actions.create")}
          </Button>
        }
      />

      <DataListView
        onViewModeChange={onViewModeChange}
        items={artifacts}
        renderCard={(artifact, viewMode) => (
          <ArtifactCard
            artifact={artifact as ArtifactCardData}
            compact={viewMode === "grid"}
            onCopyUrl={(a) => handleCopyUrl(a as ArtifactListItem)}
            onEdit={(a) => handleEditClick(a as ArtifactListItem)}
            onOpen={(a) => window.open(a.url, "_blank")}
            onDelete={(a) => handleDeleteClick(a as ArtifactListItem)}
          />
        )}
        keyExtractor={(a) => a.uuid}
        storageKey="artifacts-view-mode"
        guide={guideAnchor("artifacts.list")}
        loading={loading}
        hasResult={accepted !== null}
        error={error}
        onRetry={loadArtifacts}
        onRefresh={loadArtifacts}
        resultScope={
          accepted &&
          t("common.pagination.page", { current: accepted.page, total: Math.max(1, totalPages) })
        }
        emptyIcon={FileCode}
        emptyTitle={t("pages.artifacts.noArtifacts")}
        containerRef={containerRef}
        pagination={{
          mode: "total",
          currentPage: accepted?.page ?? currentPage,
          totalPages,
          totalItems: total,
          pageSize: accepted?.pageSize ?? pageSize,
          onPageChange: setCurrentPage,
        }}
        className="flex-1 min-h-0 flex flex-col"
      />

      {/* Create Artifact Dialog */}
      <Dialog open={createDialogOpen} onOpenChange={setCreateDialogOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{t("pages.artifacts.editor.titleCreate")}</DialogTitle>
            <DialogDescription>{t("pages.artifacts.editor.descriptionCreate")}</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="artifact-name">{t("pages.artifacts.editor.name")}</Label>
              <Input
                id="artifact-name"
                placeholder={t("pages.artifacts.editor.namePlaceholder")}
                value={newArtifactName}
                onChange={(e) => setNewArtifactName(e.target.value)}
                data-testid="artifact-name-input"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="artifact-content">{t("pages.artifacts.editor.content")}</Label>
              <Textarea
                id="artifact-content"
                className="h-64 resize-none font-mono"
                placeholder={t("pages.artifacts.editor.contentPlaceholder")}
                value={newArtifactContent}
                onChange={(e) => setNewArtifactContent(e.target.value)}
                data-testid="artifact-content-input"
              />
              <p className="text-xs text-muted-foreground">
                {t("pages.artifacts.editor.contentHint")}
              </p>
            </div>
            {createError && <div className="text-sm text-destructive">{createError}</div>}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateDialogOpen(false)}>
              {t("common.cancel")}
            </Button>
            <Button onClick={handleCreateArtifact} disabled={creating} data-testid="create-submit">
              {creating ? t("common.saving") : t("pages.artifacts.actions.create")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit Artifact Dialog */}
      <Dialog open={editDialogOpen} onOpenChange={setEditDialogOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{t("pages.artifacts.editor.titleEdit")}</DialogTitle>
            <DialogDescription>
              {t("pages.artifacts.editor.descriptionEdit", { name: selectedArtifact?.name })}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="edit-artifact-name">{t("pages.artifacts.editor.name")}</Label>
              <Input
                id="edit-artifact-name"
                value={selectedArtifact?.name || ""}
                disabled
                className="bg-muted"
                data-testid="edit-artifact-name-input"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="edit-artifact-content">{t("pages.artifacts.editor.content")}</Label>
              {loadingContent ? (
                <div className="w-full h-64 flex items-center justify-center border rounded-md bg-muted">
                  <span className="text-muted-foreground">
                    {t("pages.artifacts.editor.loadingContent")}
                  </span>
                </div>
              ) : (
                <Textarea
                  id="edit-artifact-content"
                  className="h-64 resize-none font-mono"
                  value={editArtifactContent}
                  onChange={(e) => setEditArtifactContent(e.target.value)}
                  data-testid="edit-artifact-content-input"
                />
              )}
              <p className="text-xs text-muted-foreground">
                {t("pages.artifacts.editor.contentHint")}
              </p>
            </div>
            {editError && <div className="text-sm text-destructive">{editError}</div>}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditDialogOpen(false)}>
              {t("common.cancel")}
            </Button>
            <Button
              onClick={handleEditSubmit}
              disabled={editing || loadingContent}
              data-testid="edit-submit"
            >
              {editing ? t("common.saving") : t("common.save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation Dialog */}
      <ConfirmDialog
        open={deleteDialogOpen}
        onOpenChange={setDeleteDialogOpen}
        title={t("pages.artifacts.delete.title")}
        description={t("pages.artifacts.delete.description", { name: selectedArtifact?.name })}
        confirmLabel={t("pages.artifacts.actions.delete")}
        cancelLabel={t("common.cancel")}
        variant="destructive"
        onConfirm={handleDeleteConfirm}
      >
        {deleteError && (
          <InlineError title={t("common.errors.failedToDelete")} message={deleteError} />
        )}
      </ConfirmDialog>
    </PageShell>
  );
};
