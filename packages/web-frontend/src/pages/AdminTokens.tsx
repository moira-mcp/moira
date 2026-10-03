/**
 * Admin Tokens Page
 * View all API tokens across all users with server-side pagination and filters
 */

import React, { useState, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { KeyRound } from "lucide-react";
import { toast } from "sonner";
import { apiClient } from "../services/api-client";
import { useListPageSize } from "../hooks/useListPageSize";
import { useLatestRequest } from "../hooks/useLatestRequest";
import { useDebounce } from "../hooks/useDebounce";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { PageShell } from "@/components/PageShell";
import { FilterBar } from "@/components/FilterBar";
import { LabeledFilter } from "@/components/LabeledFilter";
import { DataListView } from "@/components/DataListView";
import { TokenCard } from "@/components/cards/TokenCard";
import { ConfirmDialog } from "@/components/confirm-dialog";

interface AdminToken {
  id: string;
  name: string;
  tokenPrefix: string;
  scopes: string[] | null;
  userId: string;
  userEmail: string;
  userName: string | null;
  expiresAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
  revokedAt: string | null;
  isExpired: boolean;
  isRevoked: boolean;
}

const ALL_FILTER = "__all__";

export const AdminTokens: React.FC = () => {
  const { t } = useTranslation();
  const [accepted, setAccepted] = useState<{
    tokens: AdminToken[];
    total: number;
    page: number;
    pageSize: number;
    search: string;
    status: string;
  } | null>(null);
  const tokens = accepted?.tokens ?? [];
  const total = accepted?.total ?? 0;
  const [currentPage, setCurrentPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [selectedStatus, setSelectedStatus] = useState<string>("");
  const [searchQuery, setSearchQuery] = useState<string>("");
  const debouncedSearch = useDebounce(searchQuery, 300);

  const [revokeTarget, setRevokeTarget] = useState<AdminToken | null>(null);

  const { pageSize, containerRef, onViewModeChange } = useListPageSize(() => setCurrentPage(1));

  // Reset page when filters change
  useEffect(() => {
    setCurrentPage(1);
  }, [selectedStatus, debouncedSearch]);

  const beginRequest = useLatestRequest();
  const loadData = useCallback(async () => {
    const isCurrent = beginRequest();
    try {
      setLoading(true);
      const offset = (currentPage - 1) * pageSize;

      const data = await apiClient.getAdminTokens({
        status: selectedStatus || undefined,
        search: debouncedSearch || undefined,
        limit: pageSize,
        offset,
      });

      if (!isCurrent()) return;
      setAccepted({
        tokens: data.tokens,
        total: data.total,
        page: currentPage,
        pageSize,
        search: debouncedSearch,
        status: selectedStatus,
      });
      setError(null);
    } catch (err: unknown) {
      if (!isCurrent()) return;
      const message = err instanceof Error ? err.message : t("common.errors.failedToLoad");
      setError(message);
    } finally {
      if (isCurrent()) setLoading(false);
    }
  }, [beginRequest, selectedStatus, debouncedSearch, currentPage, pageSize, t]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const handleRevoke = async () => {
    if (!revokeTarget) return;
    try {
      await apiClient.revokeAdminToken(revokeTarget.id);
      toast.success(t("admin.tokens.revokeSuccess"));
      setRevokeTarget(null);
      loadData();
    } catch (error) {
      toast.error(t("admin.tokens.revokeError"));
      throw error;
    }
  };

  const clearFilters = () => {
    setSelectedStatus("");
    setSearchQuery("");
  };

  const totalPages = Math.ceil(total / (accepted?.pageSize ?? pageSize));

  return (
    <PageShell title={t("admin.tokens.title")} description={t("admin.tokens.subtitle")}>
      <FilterBar
        search={searchQuery}
        onSearchChange={setSearchQuery}
        searchPlaceholder={t("admin.tokens.searchPlaceholder")}
        searchTestId="admin-tokens-search"
        onReset={clearFilters}
        filters={
          <LabeledFilter label={t("common.filters.status")}>
            <Select
              value={selectedStatus || ALL_FILTER}
              onValueChange={(val) => setSelectedStatus(val === ALL_FILTER ? "" : val)}
            >
              <SelectTrigger className="w-[160px]" data-testid="status-filter">
                <SelectValue placeholder={t("admin.tokens.allStatuses")} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL_FILTER}>{t("admin.tokens.allStatuses")}</SelectItem>
                <SelectItem value="active">{t("admin.tokens.statusActive")}</SelectItem>
                <SelectItem value="expired">{t("admin.tokens.statusExpired")}</SelectItem>
                <SelectItem value="revoked">{t("admin.tokens.statusRevoked")}</SelectItem>
              </SelectContent>
            </Select>
          </LabeledFilter>
        }
      />

      <DataListView
        onViewModeChange={onViewModeChange}
        items={tokens}
        renderCard={(token, viewMode) => (
          <TokenCard
            token={token}
            compact={viewMode === "grid"}
            onRevoke={() => setRevokeTarget(token)}
          />
        )}
        keyExtractor={(t) => t.id}
        storageKey="admin-tokens-view-mode"
        loading={loading}
        hasResult={accepted !== null}
        error={error}
        onRetry={loadData}
        onRefresh={loadData}
        resultScope={
          accepted && (
            <span>
              {t("common.pagination.page", {
                current: accepted.page,
                total: Math.max(1, totalPages),
              })}
              {accepted.search && ` · ${t("common.filters.search")}: ${accepted.search}`}
              {accepted.status &&
                ` · ${t("common.filters.status")}: ${t(`admin.tokens.status${accepted.status[0].toUpperCase()}${accepted.status.slice(1)}`)}`}
            </span>
          )
        }
        containerRef={containerRef}
        pagination={{
          mode: "total",
          currentPage: accepted?.page ?? currentPage,
          totalPages,
          pageSize: accepted?.pageSize ?? pageSize,
          totalItems: total,
          onPageChange: setCurrentPage,
        }}
        emptyIcon={KeyRound}
        emptyTitle={t("admin.tokens.noTokens")}
        className="flex-1 min-h-0 flex flex-col"
      />

      <ConfirmDialog
        open={!!revokeTarget}
        onOpenChange={(open) => !open && setRevokeTarget(null)}
        title={t("admin.tokens.revokeConfirmTitle")}
        description={
          revokeTarget
            ? t("admin.tokens.revokeConfirmDescription", {
                name: revokeTarget.name,
                email: revokeTarget.userEmail,
              })
            : ""
        }
        confirmLabel={t("admin.tokens.revoke")}
        variant="destructive"
        onConfirm={handleRevoke}
      />
    </PageShell>
  );
};
