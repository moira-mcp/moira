/**
 * Admin Executions Page
 * View all user executions with server-side pagination and filters
 */

import React, { useState, useEffect, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Play } from "lucide-react";
import { apiClient, type ExecutionSummary } from "../services/api-client";
import { ExecutionStopProvider } from "../components/execution/ExecutionStop";
import { ROUTES } from "../constants/routes";
import { useListPageSize } from "../hooks/useListPageSize";
import { useLatestRequest } from "../hooks/useLatestRequest";
import { useDebounce } from "../hooks/useDebounce";
import { useResource } from "../hooks/useResource";
import { DataRegion } from "@/components/DataRegion";
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

type AdminExecution = ExecutionSummary;

const ALL_FILTER = "__all__";

export const AdminExecutions: React.FC = () => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [accepted, setAccepted] = useState<{
    executions: AdminExecution[];
    total: number;
    page: number;
    pageSize: number;
    search: string;
    userId: string;
    status: string;
  } | null>(null);
  const executions = accepted?.executions ?? [];
  const total = accepted?.total ?? 0;
  const choices = useResource("admin-user-choices", () =>
    apiClient.getAdminUserChoices({ limit: 100 }),
  );
  const users = choices.data?.users ?? [];
  const [currentPage, setCurrentPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [stopRefresh, setStopRefresh] = useState(0);
  const [selectedUserId, setSelectedUserId] = useState<string>("");
  const [selectedStatus, setSelectedStatus] = useState<string>("");
  const [searchQuery, setSearchQuery] = useState<string>("");
  const debouncedSearch = useDebounce(searchQuery, 300);

  const { pageSize, containerRef, onViewModeChange } = useListPageSize(() => setCurrentPage(1));

  // Reset page when filters change
  useEffect(() => {
    setCurrentPage(1);
  }, [selectedUserId, selectedStatus, debouncedSearch]);

  const beginRequest = useLatestRequest();
  const loadData = useCallback(async () => {
    const isCurrent = beginRequest();
    try {
      setLoading(true);
      const offset = (currentPage - 1) * pageSize;

      const executionsData = await apiClient.getAdminExecutions({
        userId: selectedUserId || undefined,
        status: selectedStatus || undefined,
        search: debouncedSearch || undefined,
        limit: pageSize,
        offset,
      });

      if (!isCurrent()) return;
      setAccepted({
        executions: executionsData.executions,
        total: executionsData.total,
        page: currentPage,
        pageSize,
        search: debouncedSearch,
        userId: selectedUserId,
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
  }, [beginRequest, selectedUserId, selectedStatus, debouncedSearch, currentPage, pageSize, t]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const clearFilters = () => {
    setSelectedUserId("");
    setSelectedStatus("");
    setSearchQuery("");
  };

  const totalPages = Math.ceil(total / (accepted?.pageSize ?? pageSize));

  return (
    <ExecutionStopProvider
      onStopped={async () => {
        await loadData();
        setStopRefresh((value) => value + 1);
      }}
    >
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
                  placeholder={selectedUserId || t("admin.executions.filters.allUsers")}
                  searchPlaceholder={t("common.filters.search")}
                  emptyMessage={t("admin.userManagement.noSearchResults")}
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
                    <SelectItem value="stopped">{t("pages.overview.runStatus.stopped")}</SelectItem>
                    <SelectItem value="failed">{t("admin.executions.filters.failed")}</SelectItem>
                  </SelectContent>
                </Select>
              </LabeledFilter>
            </>
          }
        />

        <DataRegion
          hasResult={choices.data !== undefined}
          pending={choices.pending}
          error={choices.error}
          onRetry={choices.refresh}
          testId="admin-user-choices-region"
        />

        <LockedExecutionsWidget admin refreshKey={stopRefresh} />

        <DataListView
          onViewModeChange={onViewModeChange}
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
                {accepted.userId &&
                  ` · ${t("common.filters.user")}: ${users.find((u) => u.id === accepted.userId)?.email ?? accepted.userId}`}
                {accepted.status &&
                  ` · ${t("common.filters.status")}: ${t(accepted.status === "stopped" ? "pages.overview.runStatus.stopped" : accepted.status === "locked" ? "common.status.locked" : `admin.executions.filters.${accepted.status}`)}`}
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
          emptyIcon={Play}
          emptyTitle={t("admin.executions.noExecutions")}
          className="flex-1 min-h-0 flex flex-col"
        />
      </PageShell>
    </ExecutionStopProvider>
  );
};
