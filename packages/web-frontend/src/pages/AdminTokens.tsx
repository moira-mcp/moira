/**
 * Admin Tokens Page
 * View all API tokens across all users with server-side pagination and filters
 */

import React, { useState, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { KeyRound, User } from "lucide-react";
import { toast } from "sonner";
import { apiClient } from "../services/api-client";
import { useDynamicPageSize } from "../hooks/useDynamicPageSize";
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
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
  const [tokens, setTokens] = useState<AdminToken[]>([]);
  const [total, setTotal] = useState(0);
  const [currentPage, setCurrentPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [selectedStatus, setSelectedStatus] = useState<string>("");
  const [searchQuery, setSearchQuery] = useState<string>("");
  const debouncedSearch = useDebounce(searchQuery, 300);

  const [revokeTarget, setRevokeTarget] = useState<AdminToken | null>(null);

  const { pageSize, containerRef } = useDynamicPageSize();

  // Reset page when filters change
  useEffect(() => {
    setCurrentPage(1);
  }, [selectedStatus, debouncedSearch]);

  const loadData = useCallback(async () => {
    try {
      setLoading(true);
      const offset = (currentPage - 1) * pageSize;

      const data = await apiClient.getAdminTokens({
        status: selectedStatus || undefined,
        search: debouncedSearch || undefined,
        limit: pageSize,
        offset,
      });

      setTokens(data.tokens);
      setTotal(data.total);
      setError(null);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : t("common.errors.failedToLoad");
      setError(message);
    } finally {
      setLoading(false);
    }
  }, [selectedStatus, debouncedSearch, currentPage, pageSize, t]);

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
    } catch {
      toast.error(t("admin.tokens.revokeError"));
    }
  };

  const clearFilters = () => {
    setSelectedStatus("");
    setSearchQuery("");
  };

  const totalPages = Math.ceil(total / pageSize);

  const getStatusBadge = (token: AdminToken) => {
    if (token.isRevoked) {
      return <Badge variant="destructive">{t("admin.tokens.statusRevoked")}</Badge>;
    }
    if (token.isExpired) {
      return (
        <Badge variant="secondary" className="text-orange-600 dark:text-orange-400">
          {t("admin.tokens.statusExpired")}
        </Badge>
      );
    }
    return (
      <Badge variant="outline" className="text-chart-2 border-chart-2/30">
        {t("admin.tokens.statusActive")}
      </Badge>
    );
  };

  const formatDate = (date: string | null) => {
    if (!date) return "—";
    return new Date(date).toLocaleDateString();
  };

  if (loading && tokens.length === 0) {
    return (
      <PageShell title={t("admin.tokens.title")} description={t("admin.tokens.subtitle")} loading />
    );
  }

  if (error) {
    return (
      <PageShell
        title={t("admin.tokens.title")}
        error={error}
        onRetry={loadData}
        retryLabel={t("admin.tokens.retry")}
      />
    );
  }

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
        items={tokens}
        renderCard={(token) => (
          <Card key={token.id} data-testid={`token-row-${token.id}`}>
            <CardContent className="flex items-start justify-between p-4">
              <div className="flex-1 space-y-1">
                <div className="flex items-center gap-2">
                  <KeyRound className="h-4 w-4 text-muted-foreground" />
                  <span className="font-medium text-sm" data-testid="token-name">
                    {token.name}
                  </span>
                  {getStatusBadge(token)}
                </div>
                <div className="flex items-center gap-4 text-sm text-muted-foreground">
                  <code
                    className="text-xs bg-muted px-1.5 py-0.5 rounded font-mono"
                    data-testid="token-prefix"
                  >
                    {token.tokenPrefix}...
                  </code>
                </div>
                <div className="flex items-center gap-1 text-xs text-muted-foreground">
                  <User className="h-3 w-3" />
                  <span data-testid="token-user">{token.userEmail}</span>
                  {token.userName && (
                    <span className="text-muted-foreground/60">({token.userName})</span>
                  )}
                </div>
                <div className="text-xs text-muted-foreground">
                  {t("admin.tokens.created")}: {formatDate(token.createdAt)}
                  {token.expiresAt && (
                    <>
                      {" · "}
                      {t("admin.tokens.expires")}: {formatDate(token.expiresAt)}
                    </>
                  )}
                  {token.lastUsedAt && (
                    <>
                      {" · "}
                      {t("admin.tokens.lastUsed")}: {formatDate(token.lastUsedAt)}
                    </>
                  )}
                </div>
              </div>
              {!token.isRevoked && (
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={() => setRevokeTarget(token)}
                  data-testid={`revoke-token-${token.id}`}
                >
                  {t("admin.tokens.revoke")}
                </Button>
              )}
            </CardContent>
          </Card>
        )}
        keyExtractor={(t) => t.id}
        storageKey="admin-tokens-view-mode"
        loading={loading}
        containerRef={containerRef}
        pagination={{
          mode: "total",
          currentPage,
          totalPages,
          pageSize,
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
