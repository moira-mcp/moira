/**
 * Admin Workflows Page
 * View all workflows across all users with server-side pagination and filters
 */

import React, { useState, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { GitBranch } from "lucide-react";
import { apiClient } from "../services/api-client";
import { useListPageSize } from "../hooks/useListPageSize";
import { useLatestRequest } from "../hooks/useLatestRequest";
import { useDebounce } from "../hooks/useDebounce";
import { useResource } from "../hooks/useResource";
import { DataRegion } from "@/components/DataRegion";
import { localDayRange } from "@/lib/local-date-range";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { SearchableSelect } from "@/components/SearchableSelect";
import { PageShell } from "@/components/PageShell";
import { FilterBar } from "@/components/FilterBar";
import { LabeledFilter } from "@/components/LabeledFilter";
import { DataListView } from "@/components/DataListView";
import { AdminWorkflowCard, type AdminWorkflowCardData } from "@/components/cards";

const ALL_FILTER = "__all__";

export const AdminWorkflows: React.FC = () => {
  const { t } = useTranslation();
  const [accepted, setAccepted] = useState<{
    workflows: AdminWorkflowCardData[];
    total: number;
    page: number;
    pageSize: number;
    search: string;
    userId: string;
    visibility: string;
    validation: string;
    from: string;
    to: string;
  } | null>(null);
  const workflows = accepted?.workflows ?? [];
  const total = accepted?.total ?? 0;
  const choices = useResource("admin-user-choices", () =>
    apiClient.getAdminUserChoices({ limit: 100 }),
  );
  const users = choices.data?.users ?? [];
  const [currentPage, setCurrentPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [selectedUserId, setSelectedUserId] = useState<string>("");
  const [selectedVisibility, setSelectedVisibility] = useState<string>("");
  const [selectedValidation, setSelectedValidation] = useState<string>("");
  const [searchQuery, setSearchQuery] = useState<string>("");
  const [fromDate, setFromDate] = useState<string>("");
  const [toDate, setToDate] = useState<string>("");
  const debouncedSearch = useDebounce(searchQuery, 300);

  const { pageSize, containerRef, onViewModeChange } = useListPageSize(() => setCurrentPage(1));

  // Reset page when filters change
  useEffect(() => {
    setCurrentPage(1);
  }, [selectedUserId, selectedVisibility, selectedValidation, debouncedSearch, fromDate, toDate]);

  const beginRequest = useLatestRequest();
  const loadData = useCallback(async () => {
    const isCurrent = beginRequest();
    try {
      setLoading(true);
      const offset = (currentPage - 1) * pageSize;

      const workflowsData = await apiClient.getAdminWorkflows({
        userId: selectedUserId || undefined,
        visibility: (selectedVisibility as "public" | "private" | "all") || undefined,
        isValid: (selectedValidation as "true" | "false" | "unknown") || undefined,
        search: debouncedSearch || undefined,
        ...localDayRange(fromDate, toDate),
        sort: "updatedAt",
        sortOrder: "desc",
        limit: pageSize,
        offset,
      });

      if (!isCurrent()) return;
      setAccepted({
        workflows: workflowsData.workflows,
        total: workflowsData.total,
        page: currentPage,
        pageSize,
        search: debouncedSearch,
        userId: selectedUserId,
        visibility: selectedVisibility,
        validation: selectedValidation,
        from: fromDate,
        to: toDate,
      });
      setError(null);
    } catch (err: unknown) {
      if (!isCurrent()) return;
      const message = err instanceof Error ? err.message : t("common.errors.failedToLoad");
      setError(message);
    } finally {
      if (isCurrent()) setLoading(false);
    }
  }, [
    beginRequest,
    selectedUserId,
    selectedVisibility,
    selectedValidation,
    debouncedSearch,
    fromDate,
    toDate,
    currentPage,
    pageSize,
    t,
  ]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const clearFilters = () => {
    setSelectedUserId("");
    setSelectedVisibility("");
    setSelectedValidation("");
    setSearchQuery("");
    setFromDate("");
    setToDate("");
  };

  const totalPages = Math.ceil(total / (accepted?.pageSize ?? pageSize));

  return (
    <PageShell title={t("admin.workflows.title")} description={t("admin.workflows.subtitle")}>
      <FilterBar
        search={searchQuery}
        onSearchChange={setSearchQuery}
        searchPlaceholder={t("admin.workflows.filters.searchPlaceholder")}
        searchTestId="admin-workflows-search"
        onReset={clearFilters}
        filters={
          <>
            <LabeledFilter label={t("common.filters.user")}>
              <SearchableSelect
                value={selectedUserId || ALL_FILTER}
                onValueChange={(val) => setSelectedUserId(val === ALL_FILTER ? "" : val)}
                options={[
                  { value: ALL_FILTER, label: t("admin.workflows.filters.allUsers") },
                  ...users.map((user) => ({ value: user.id, label: user.email })),
                ]}
                placeholder={selectedUserId || t("admin.workflows.filters.allUsers")}
                searchPlaceholder={t("common.filters.search")}
                emptyMessage={t("admin.userManagement.noSearchResults")}
                testId="user-filter"
              />
            </LabeledFilter>

            <LabeledFilter label={t("admin.workflows.filters.visibility")}>
              <Select
                value={selectedVisibility || ALL_FILTER}
                onValueChange={(val) => setSelectedVisibility(val === ALL_FILTER ? "" : val)}
              >
                <SelectTrigger className="w-[140px]" data-testid="visibility-filter">
                  <SelectValue placeholder={t("admin.workflows.filters.allVisibility")} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL_FILTER}>
                    {t("admin.workflows.filters.allVisibility")}
                  </SelectItem>
                  <SelectItem value="public">{t("admin.workflows.public")}</SelectItem>
                  <SelectItem value="private">{t("admin.workflows.private")}</SelectItem>
                </SelectContent>
              </Select>
            </LabeledFilter>

            <LabeledFilter label={t("admin.workflows.filters.validation")}>
              <Select
                value={selectedValidation || ALL_FILTER}
                onValueChange={(val) => setSelectedValidation(val === ALL_FILTER ? "" : val)}
              >
                <SelectTrigger className="w-[140px]" data-testid="validation-filter">
                  <SelectValue placeholder={t("admin.workflows.filters.allValidation")} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL_FILTER}>
                    {t("admin.workflows.filters.allValidation")}
                  </SelectItem>
                  <SelectItem value="true">{t("admin.workflows.filters.valid")}</SelectItem>
                  <SelectItem value="false">{t("admin.workflows.filters.invalid")}</SelectItem>
                  <SelectItem value="unknown">{t("admin.workflows.filters.unknown")}</SelectItem>
                </SelectContent>
              </Select>
            </LabeledFilter>

            <LabeledFilter label={t("common.filters.dateFrom")}>
              <Input
                type="date"
                value={fromDate}
                onChange={(e) => {
                  setFromDate(e.target.value);
                  setCurrentPage(1);
                }}
                className="w-[160px]"
                data-testid="from-date-filter"
              />
            </LabeledFilter>
            <LabeledFilter label={t("common.filters.dateTo")}>
              <Input
                type="date"
                value={toDate}
                onChange={(e) => {
                  setToDate(e.target.value);
                  setCurrentPage(1);
                }}
                className="w-[160px]"
                data-testid="to-date-filter"
              />
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

      <DataListView
        onViewModeChange={onViewModeChange}
        items={workflows}
        renderCard={(workflow, viewMode) => (
          <AdminWorkflowCard workflow={workflow} compact={viewMode === "grid"} />
        )}
        keyExtractor={(w) => w.id}
        storageKey="admin-workflows-view-mode"
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
              {accepted.visibility &&
                ` · ${t("admin.workflows.filters.visibility")}: ${t(`admin.workflows.${accepted.visibility}`)}`}
              {accepted.validation &&
                ` · ${t("admin.workflows.filters.validation")}: ${t(`admin.workflows.filters.${accepted.validation === "true" ? "valid" : accepted.validation === "false" ? "invalid" : "unknown"}`)}`}
              {accepted.from && ` · ${t("common.filters.dateFrom")}: ${accepted.from}`}
              {accepted.to && ` · ${t("common.filters.dateTo")}: ${accepted.to}`}
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
        emptyIcon={GitBranch}
        emptyTitle={t("admin.workflows.noWorkflows")}
        className="flex-1 min-h-0 flex flex-col"
      />
    </PageShell>
  );
};
