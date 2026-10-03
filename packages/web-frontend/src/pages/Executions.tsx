/**
 * Executions Page
 * List user's workflow executions with filters, sorting, pagination and note
 */

import React, { useState, useEffect, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Play } from "lucide-react";
import { apiClient } from "../services/api-client";
import { ROUTES } from "../constants/routes";
import { PageShell } from "../components/PageShell";
import { FilterBar } from "../components/FilterBar";
import { LabeledFilter } from "../components/LabeledFilter";
import { SortSelect, makeSortValue, parseSortValue } from "../components/SortSelect";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";
import { SearchableSelect } from "../components/SearchableSelect";
import { useDebounce } from "../hooks/useDebounce";
import { useListPageSize } from "../hooks/useListPageSize";
import { useLatestRequest } from "../hooks/useLatestRequest";
import { ExecutionCard, normalizeExecution } from "../components/cards";
import { DataListView } from "../components/DataListView";
import { LockedExecutionsWidget } from "../components/LockedExecutionsWidget";
import { guideAnchor } from "@/guides/anchors";
import { useResource } from "@/hooks/useResource";
import { DataRegion } from "@/components/DataRegion";

interface ExecutionListItem {
  executionId: string;
  workflowId: string;
  workflowName?: string | null; // Issue #421: Workflow name from API
  userId: string;
  status: string;
  stopReason?: string | null;
  currentNodeId: string | null;
  note?: string;
  createdAt?: number | null;
  updatedAt?: number | null;
  completedAt?: number;
  error?: string;
  errorCount?: number; // Issue #386: Error count for badge display
}

export const Executions: React.FC = () => {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const { pageSize, containerRef, onViewModeChange } = useListPageSize(() => setCurrentPage(1));

  // Data state
  const [accepted, setAccepted] = useState<{
    executions: ExecutionListItem[];
    total: number;
    page: number;
    pageSize: number;
    search: string;
    status: string;
    workflowId: string;
    sortBy: string;
    sortOrder: string;
  } | null>(null);
  const executions = accepted?.executions ?? [];
  const total = accepted?.total ?? 0;
  const choices = useResource("execution-workflow-choices", () => apiClient.getWorkflows());
  const workflows = (choices.data?.workflows ?? []).map((w) => ({
    id: w.id,
    name: w.metadata?.name || w.id,
  }));
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Filter state
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [workflowFilter, setWorkflowFilter] = useState<string>("all");
  const [sortBy, setSortBy] = useState<"createdAt" | "updatedAt">("createdAt");
  const [sortOrder, setSortOrder] = useState<"asc" | "desc">("desc");
  const [currentPage, setCurrentPage] = useState(1);

  const sortValue = makeSortValue(sortBy, sortOrder);
  const handleSortChange = (value: string) => {
    const { field, direction } = parseSortValue<"createdAt" | "updatedAt">(value);
    setSortBy(field);
    setSortOrder(direction);
    setCurrentPage(1);
  };

  const handleReset = () => {
    setSearchQuery("");
    setStatusFilter("all");
    setWorkflowFilter("all");
    setSortBy("createdAt");
    setSortOrder("desc");
    setCurrentPage(1);
  };

  // Debounce search
  const debouncedSearch = useDebounce(searchQuery, 300);

  // Reset page on search change
  useEffect(() => {
    setCurrentPage(1);
  }, [debouncedSearch]);

  const beginRequest = useLatestRequest();
  const loadExecutions = useCallback(async () => {
    const isCurrent = beginRequest();
    try {
      setLoading(true);

      const statusList =
        statusFilter === "all"
          ? undefined
          : [statusFilter as "running" | "waiting" | "completed" | "failed"];

      const result = await apiClient.getExecutions({
        status: statusList,
        workflowId: workflowFilter === "all" ? undefined : workflowFilter,
        search: debouncedSearch || undefined,
        sort: sortBy,
        sortOrder,
        limit: pageSize,
        offset: (currentPage - 1) * pageSize,
      });

      if (!isCurrent()) return;
      setAccepted({
        executions: result.executions,
        total: result.total,
        page: currentPage,
        pageSize,
        search: debouncedSearch,
        status: statusFilter,
        workflowId: workflowFilter,
        sortBy,
        sortOrder,
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
    statusFilter,
    workflowFilter,
    debouncedSearch,
    sortBy,
    sortOrder,
    currentPage,
    pageSize,
    t,
  ]);

  useEffect(() => {
    loadExecutions();
  }, [loadExecutions]);

  const handleExecutionClick = (executionId: string) => {
    navigate(`${ROUTES.EXECUTIONS}/${executionId}`);
  };

  const totalPages = Math.ceil(total / (accepted?.pageSize ?? pageSize));

  return (
    <PageShell
      title={t("pages.executions.title")}
      guide={guideAnchor("runs.header")}
      description={t("pages.executions.subtitle")}
    >
      <FilterBar
        search={searchQuery}
        onSearchChange={setSearchQuery}
        searchPlaceholder={t("pages.executions.filters.searchPlaceholder")}
        searchTestId="executions-search"
        onReset={handleReset}
        filters={
          <>
            <LabeledFilter label={t("common.filters.status")}>
              <Select
                value={statusFilter}
                onValueChange={(value) => {
                  setStatusFilter(value);
                  setCurrentPage(1);
                }}
              >
                <SelectTrigger
                  className="w-[150px]"
                  data-testid="status-filter"
                  {...guideAnchor("runs.status")}
                >
                  <SelectValue placeholder={t("pages.executions.filters.status")} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">{t("pages.executions.filters.allStatuses")}</SelectItem>
                  <SelectItem value="running">
                    {t("pages.executions.filters.active", "Active")}
                  </SelectItem>
                  <SelectItem value="locked">{t("common.status.locked", "Locked")}</SelectItem>
                  <SelectItem value="completed">{t("common.status.completed")}</SelectItem>
                  <SelectItem value="failed">{t("common.status.failed")}</SelectItem>
                  <SelectItem value="waiting">{t("common.status.waiting")}</SelectItem>
                </SelectContent>
              </Select>
            </LabeledFilter>

            <LabeledFilter label={t("common.filters.workflow")}>
              <SearchableSelect
                value={workflowFilter}
                onValueChange={(value) => {
                  setWorkflowFilter(value);
                  setCurrentPage(1);
                }}
                options={[
                  { value: "all", label: t("pages.executions.filters.allWorkflows") },
                  ...workflows.map((wf) => ({ value: wf.id, label: wf.name })),
                ]}
                placeholder={
                  workflowFilter !== "all" ? workflowFilter : t("pages.executions.filters.workflow")
                }
                searchPlaceholder={t("common.filters.search")}
                emptyMessage={t("pages.workflows.explorer.noMatch")}
                testId="workflow-filter"
              />
            </LabeledFilter>

            <SortSelect
              value={sortValue}
              onChange={handleSortChange}
              label={t("common.filters.sort")}
              options={[
                {
                  value: "createdAt-desc",
                  label: `${t("pages.executions.filters.sortByCreated")} ↓`,
                },
                {
                  value: "createdAt-asc",
                  label: `${t("pages.executions.filters.sortByCreated")} ↑`,
                },
                {
                  value: "updatedAt-desc",
                  label: `${t("pages.executions.filters.sortByUpdated")} ↓`,
                },
                {
                  value: "updatedAt-asc",
                  label: `${t("pages.executions.filters.sortByUpdated")} ↑`,
                },
              ]}
              testId="sort-select"
            />
          </>
        }
      />
      <DataRegion
        hasResult={choices.data !== undefined}
        pending={choices.pending}
        error={choices.error}
        onRetry={choices.refresh}
        testId="execution-workflow-choices-region"
      />

      <LockedExecutionsWidget />

      <DataListView
        onViewModeChange={onViewModeChange}
        items={executions}
        renderCard={(execution, viewMode) => (
          <ExecutionCard
            execution={normalizeExecution(execution)}
            compact={viewMode === "grid"}
            onClick={() => handleExecutionClick(execution.executionId)}
          />
        )}
        keyExtractor={(e) => e.executionId}
        storageKey="executions-view-mode"
        guide={guideAnchor("runs.list")}
        loading={loading}
        hasResult={accepted !== null}
        error={error}
        onRetry={loadExecutions}
        onRefresh={loadExecutions}
        resultScope={
          accepted && (
            <span>
              {t("common.pagination.page", {
                current: accepted.page,
                total: Math.max(1, totalPages),
              })}
              {accepted.search && ` · ${t("common.filters.search")}: ${accepted.search}`}
              {accepted.status !== "all" &&
                ` · ${t("common.filters.status")}: ${t(accepted.status === "running" ? "pages.executions.filters.active" : `common.status.${accepted.status}`)}`}
              {accepted.workflowId !== "all" &&
                ` · ${t("common.filters.workflow")}: ${workflows.find((w) => w.id === accepted.workflowId)?.name ?? accepted.workflowId}`}
              {` · ${t(accepted.sortBy === "createdAt" ? "pages.executions.filters.sortByCreated" : "pages.executions.filters.sortByUpdated")} ${accepted.sortOrder === "desc" ? "↓" : "↑"}`}
            </span>
          )
        }
        emptyIcon={Play}
        emptyTitle={
          accepted?.search ||
          (accepted && accepted.status !== "all") ||
          (accepted && accepted.workflowId !== "all")
            ? t("pages.executions.noResults")
            : t("pages.executions.noExecutions")
        }
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
    </PageShell>
  );
};
