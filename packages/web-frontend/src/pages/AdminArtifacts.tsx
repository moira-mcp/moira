/**
 * Admin Artifacts Page
 * Admin view for managing all user artifacts with filters and quota management
 */

import React, { useState, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { FileCode, BarChart3 } from "lucide-react";
import { Card, CardContent } from "../components/ui/card";
import { useDynamicPageSize } from "../hooks/useDynamicPageSize";
import { useDebounce } from "@/hooks/useDebounce";
import { Checkbox } from "../components/ui/checkbox";
import { toast } from "sonner";
import { formatSize } from "@/components/cards/format-utils";
import { PageShell } from "@/components/PageShell";
import { FilterBar } from "@/components/FilterBar";
import { DataListView } from "@/components/DataListView";
import { ArtifactCard, type ArtifactCardData } from "@/components/cards";
import { ConfirmDialog } from "@/components/confirm-dialog";

interface AdminArtifactItem {
  id: string;
  uuid: string;
  userId: string;
  url: string;
  name: string;
  size: number;
  mimeType: string;
  executionId: string | null;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
  deleted: boolean;
  userEmail: string;
  userName: string | null;
  userHandle: string | null;
}

interface AdminArtifactStats {
  totalArtifacts: number;
  totalSize: number;
  totalUsers: number;
  expiredArtifacts: number;
  deletedArtifacts: number;
}

function toArtifactCardData(item: AdminArtifactItem): ArtifactCardData {
  return {
    uuid: item.uuid,
    url: item.url,
    name: item.name,
    size: item.size,
    mimeType: item.mimeType,
    executionId: item.executionId,
    expiresAt: item.expiresAt,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    userDisplay: item.userName || item.userEmail,
    deleted: item.deleted,
  };
}

export const AdminArtifacts: React.FC = () => {
  const { t } = useTranslation();
  const { pageSize, containerRef } = useDynamicPageSize();

  const [artifacts, setArtifacts] = useState<AdminArtifactItem[]>([]);
  const [stats, setStats] = useState<AdminArtifactStats | null>(null);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [currentPage, setCurrentPage] = useState(1);

  const [userSearchInput, setUserSearchInput] = useState("");
  const debouncedUserSearch = useDebounce(userSearchInput, 400);
  const [includeExpired, setIncludeExpired] = useState(false);
  const [includeDeleted, setIncludeDeleted] = useState(false);

  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [selectedArtifact, setSelectedArtifact] = useState<AdminArtifactItem | null>(null);

  const loadStats = useCallback(async () => {
    try {
      const response = await fetch("/api/admin/artifacts/stats", {
        credentials: "include",
      });
      if (response.ok) {
        const result = await response.json();
        setStats(result.data);
      }
    } catch {
      // Stats are non-critical
    }
  }, []);

  const loadArtifacts = useCallback(async () => {
    try {
      setLoading(true);

      const params = new URLSearchParams();
      params.append("limit", pageSize.toString());
      params.append("offset", ((currentPage - 1) * pageSize).toString());
      const trimmedSearch = debouncedUserSearch.trim();
      if (trimmedSearch) params.append("userId", trimmedSearch);
      if (includeExpired) params.append("includeExpired", "true");
      if (includeDeleted) params.append("includeDeleted", "true");

      const response = await fetch(`/api/admin/artifacts?${params.toString()}`, {
        credentials: "include",
      });

      if (!response.ok) {
        throw new Error(t("admin.artifacts.errors.loadFailed"));
      }

      const result = await response.json();
      setArtifacts(result.data.artifacts);
      setTotal(result.data.total);
      setError(null);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : t("admin.artifacts.errors.loadFailed");
      setError(message);
    } finally {
      setLoading(false);
    }
  }, [currentPage, debouncedUserSearch, includeExpired, includeDeleted, pageSize, t]);

  useEffect(() => {
    loadArtifacts();
    loadStats();
  }, [loadArtifacts, loadStats]);

  useEffect(() => {
    setCurrentPage(1);
  }, [debouncedUserSearch]);

  const handleDeleteClick = (artifact: ArtifactCardData) => {
    const adminArtifact = artifacts.find((a) => a.uuid === artifact.uuid);
    if (adminArtifact) {
      setSelectedArtifact(adminArtifact);
      setDeleteDialogOpen(true);
    }
  };

  const handleDeleteConfirm = async () => {
    if (!selectedArtifact) return;

    try {
      const response = await fetch(`/api/admin/artifacts/${selectedArtifact.uuid}`, {
        method: "DELETE",
        credentials: "include",
      });

      if (!response.ok) {
        throw new Error(t("admin.artifacts.errors.deleteFailed"));
      }

      setDeleteDialogOpen(false);
      setSelectedArtifact(null);
      loadArtifacts();
      loadStats();
    } catch (err) {
      const message = err instanceof Error ? err.message : t("admin.artifacts.errors.deleteFailed");
      toast.error(message);
    }
  };

  const handleClearFilters = () => {
    setUserSearchInput("");
    setIncludeExpired(false);
    setIncludeDeleted(false);
    setCurrentPage(1);
  };

  const totalPages = Math.ceil(total / pageSize);

  if (loading && artifacts.length === 0) {
    return (
      <PageShell
        title={t("admin.artifacts.title")}
        description={t("admin.artifacts.subtitle")}
        loading
      />
    );
  }

  if (error && artifacts.length === 0) {
    return (
      <PageShell
        title={t("admin.artifacts.title")}
        error={error}
        onRetry={loadArtifacts}
        retryLabel={t("admin.artifacts.retry")}
      />
    );
  }

  return (
    <PageShell title={t("admin.artifacts.title")} description={t("admin.artifacts.subtitle")}>
      {/* Stats Cards */}
      {stats && (
        <div className="grid grid-cols-1 md:grid-cols-5 gap-4 mb-6">
          <Card>
            <CardContent className="pt-4 pb-4">
              <div className="flex items-center gap-2">
                <BarChart3 className="h-4 w-4 text-muted-foreground" />
                <span className="text-sm text-muted-foreground">
                  {t("admin.artifacts.stats.totalArtifacts")}
                </span>
              </div>
              <div className="text-2xl font-bold mt-1">{stats.totalArtifacts}</div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-4 pb-4">
              <div className="text-sm text-muted-foreground">
                {t("admin.artifacts.stats.totalSize")}
              </div>
              <div className="text-2xl font-bold mt-1">{formatSize(stats.totalSize)}</div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-4 pb-4">
              <div className="text-sm text-muted-foreground">
                {t("admin.artifacts.stats.totalUsers")}
              </div>
              <div className="text-2xl font-bold mt-1">{stats.totalUsers}</div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-4 pb-4">
              <div className="text-sm text-muted-foreground">
                {t("admin.artifacts.stats.expiredArtifacts")}
              </div>
              <div className="text-2xl font-bold mt-1 text-warning">{stats.expiredArtifacts}</div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-4 pb-4">
              <div className="text-sm text-muted-foreground">
                {t("admin.artifacts.stats.deletedArtifacts")}
              </div>
              <div className="text-2xl font-bold mt-1 text-destructive">
                {stats.deletedArtifacts}
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      <FilterBar
        search={userSearchInput}
        onSearchChange={setUserSearchInput}
        searchPlaceholder={t("admin.artifacts.filters.userPlaceholder")}
        searchTestId="user-search-input"
        onReset={handleClearFilters}
        filters={
          <>
            <label className="flex items-center gap-2 cursor-pointer self-end h-9">
              <Checkbox
                checked={includeExpired}
                onCheckedChange={(checked) => {
                  setIncludeExpired(checked === true);
                  setCurrentPage(1);
                }}
                data-testid="include-expired-checkbox"
              />
              <span className="text-sm">{t("admin.artifacts.filters.includeExpired")}</span>
            </label>

            <label className="flex items-center gap-2 cursor-pointer self-end h-9">
              <Checkbox
                checked={includeDeleted}
                onCheckedChange={(checked) => {
                  setIncludeDeleted(checked === true);
                  setCurrentPage(1);
                }}
                data-testid="include-deleted-checkbox"
              />
              <span className="text-sm">{t("admin.artifacts.filters.includeDeleted")}</span>
            </label>
          </>
        }
      />

      <DataListView
        items={artifacts}
        renderCard={(artifact, viewMode) => (
          <ArtifactCard
            artifact={toArtifactCardData(artifact)}
            compact={viewMode === "grid"}
            onOpen={(a) => window.open(a.url, "_blank")}
            onDelete={!artifact.deleted ? handleDeleteClick : undefined}
          />
        )}
        keyExtractor={(a) => a.uuid}
        storageKey="admin-artifacts-view-mode"
        loading={loading}
        containerRef={containerRef}
        emptyIcon={FileCode}
        emptyTitle={t("admin.artifacts.noArtifacts")}
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

      <ConfirmDialog
        open={deleteDialogOpen}
        onOpenChange={setDeleteDialogOpen}
        title={t("admin.artifacts.delete.title")}
        description={t("admin.artifacts.delete.description", {
          name: selectedArtifact?.name,
          user: selectedArtifact?.userEmail,
        })}
        confirmLabel={t("admin.artifacts.actions.delete")}
        cancelLabel={t("common.cancel")}
        variant="destructive"
        onConfirm={handleDeleteConfirm}
      />
    </PageShell>
  );
};
