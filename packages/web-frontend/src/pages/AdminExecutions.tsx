/**
 * Admin Executions Page
 * View all user executions with server-side pagination and filters
 */

import React, { useState, useEffect, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Play } from "lucide-react";
import { apiClient } from "../services/api-client";
import { ROUTES } from "../constants/routes";
import { useDynamicPageSize } from "../hooks/useDynamicPageSize";
import { useDebounce } from "../hooks/useDebounce";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { SearchableSelect } from "@/components/SearchableSelect";
import { PageShell } from "@/components/PageShell";
import { FilterBar } from "@/components/FilterBar";
import { LabeledFilter } from "@/components/LabeledFilter";
import { DataListView } from "@/components/DataListView";
import { ExecutionCard, normalizeExecution } from "@/components/cards";
import { LockedExecutionsWidget } from "@/components/LockedExecutionsWidget";

interface AdminExecution {
  executionId: string;
  workflowId: string;
  workflowName?: string | null;
  userId: string;
  userEmail: string;
  userName: string | null;
  status: string;
  currentNodeId: string | null;
  createdAt?: number;
  updatedAt?: number;
  completedAt?: number;
  error?: string;
  hasActiveLock?: boolean;
}

interface User {
  id: string;
  email: string;
  name: string | null;
}

const ALL_FILTER = "__all__";

export const AdminExecutions: React.FC = () => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [executions, setExecutions] = useState<AdminExecution[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [total, setTotal] = useState(0);
  const [currentPage, setCurrentPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [selectedUserId, setSelectedUserId] = useState<string>("");
  const [selectedStatus, setSelectedStatus] = useState<string>("");
  const [searchQuery, setSearchQuery] = useState<string>("");
  const debouncedSearch = useDebounce(searchQuery, 300);

  const { pageSize, containerRef } = useDynamicPageSize();

  // Reset page when filters change
  useEffect(() => {
    setCurrentPage(1);
  }, [selectedUserId, selectedStatus, debouncedSearch]);

  const loadData = useCallback(async () => {
    try {
      setLoading(true);
      const offset = (currentPage - 1) * pageSize;

      const [executionsData, usersData] = await Promise.all([
        apiClient.getAdminExecutions({
          userId: selectedUserId || undefined,
          status: selectedStatus || undefined,
          search: debouncedSearch || undefined,
          limit: pageSize,
          offset,
        }),
        apiClient.getAdminUsers({ limit: 100 }),
      ]);

      setExecutions(executionsData.executions);
      setTotal(executionsData.total);
      setUsers(usersData.users.map((u) => ({ id: u.id, email: u.email, name: u.name })));
      setError(null);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : t("common.errors.failedToLoad");
      setError(message);
    } finally {
      setLoading(false);
    }
  }, [selectedUserId, selectedStatus, debouncedSearch, currentPage, pageSize, t]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const clearFilters = () => {
    setSelectedUserId("");
    setSelectedStatus("");
    setSearchQuery("");
  };

  const totalPages = Math.ceil(total / pageSize);

  if (loading && executions.length === 0) {
    return (
      <PageShell
        title={t("admin.executions.title")}
        description={t("admin.executions.subtitle")}
        loading
      />
    );
  }

  if (error) {
    return (
      <PageShell
        title={t("admin.executions.title")}
        error={error}
        onRetry={loadData}
        retryLabel={t("admin.executions.retry")}
      />
    );
  }

  return (
    <PageShell title={t("admin.executions.title")} description={t("admin.executions.subtitle")}>
      <FilterBar
        search={searchQuery}
        onSearchChange={setSearchQuery}
        searchPlaceholder={t("admin.executions.filters.searchPlaceholder")}
        searchTestId="admin-executions-search"
        onReset={clearFilters}
        filters={
          <>
            <LabeledFilter label={t("common.filters.user")}>
              <SearchableSelect
                value={selectedUserId || ALL_FILTER}
                onValueChange={(val) => setSelectedUserId(val === ALL_FILTER ? "" : val)}
                options={[
                  { value: ALL_FILTER, label: t("admin.executions.filters.allUsers") },
                  ...users.map((user) => ({ value: user.id, label: user.email })),
                ]}
                placeholder={t("admin.executions.filters.allUsers")}
                searchPlaceholder={t("common.filters.search")}
                testId="user-filter"
              />
            </LabeledFilter>

            <LabeledFilter label={t("common.filters.status")}>
              <Select
                value={selectedStatus || ALL_FILTER}
                onValueChange={(val) => setSelectedStatus(val === ALL_FILTER ? "" : val)}
              >
                <SelectTrigger className="w-[160px]" data-testid="status-filter">
                  <SelectValue placeholder={t("admin.executions.filters.allStatuses")} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL_FILTER}>
                    {t("admin.executions.filters.allStatuses")}
                  </SelectItem>
                  <SelectItem value="running">{t("admin.executions.filters.running")}</SelectItem>
                  <SelectItem value="locked">{t("common.status.locked", "Locked")}</SelectItem>
                  <SelectItem value="waiting">{t("admin.executions.filters.waiting")}</SelectItem>
                  <SelectItem value="completed">
                    {t("admin.executions.filters.completed")}
                  </SelectItem>
                  <SelectItem value="failed">{t("admin.executions.filters.failed")}</SelectItem>
                </SelectContent>
              </Select>
            </LabeledFilter>
          </>
        }
      />

      <LockedExecutionsWidget admin />

      <DataListView
        items={executions}
        renderCard={(execution, viewMode) => (
          <ExecutionCard
            execution={normalizeExecution(execution)}
            compact={viewMode === "grid"}
            onClick={() => navigate(`${ROUTES.ADMIN_EXECUTIONS}/${execution.executionId}`)}
          />
        )}
        keyExtractor={(e) => e.executionId}
        storageKey="admin-executions-view-mode"
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
        emptyIcon={Play}
        emptyTitle={t("admin.executions.noExecutions")}
        className="flex-1 min-h-0 flex flex-col"
      />
    </PageShell>
  );
};
