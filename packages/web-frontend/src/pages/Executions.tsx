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
import { useDynamicPageSize } from "../hooks/useDynamicPageSize";
import { ExecutionCard, normalizeExecution } from "../components/cards";
import { DataListView } from "../components/DataListView";
import { LockedExecutionsWidget } from "../components/LockedExecutionsWidget";

interface ExecutionListItem {
  executionId: string;
  workflowId: string;
  workflowName?: string | null; // Issue #421: Workflow name from API
  userId: string;
  status: string;
  currentNodeId: string | null;
  note?: string;
  createdAt?: number;
  updatedAt?: number;
  completedAt?: number;
  error?: string;
  errorCount?: number; // Issue #386: Error count for badge display
}

interface WorkflowInfo {
  id: string;
  name: string;
}

export const Executions: React.FC = () => {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const { pageSize, containerRef } = useDynamicPageSize();

  // Data state
  const [executions, setExecutions] = useState<ExecutionListItem[]>([]);
  const [workflows, setWorkflows] = useState<WorkflowInfo[]>([]);
  const [total, setTotal] = useState(0);
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

  // Load workflows for filter dropdown
  useEffect(() => {
    const loadWorkflows = async () => {
      try {
        const response = await apiClient.getWorkflows();
        setWorkflows(
          response.workflows.map((w) => ({
            id: w.id,
            name: w.metadata?.name || w.id,
          })),
        );
      } catch {
        // Non-critical, just don't show workflow filter options
      }
    };
    loadWorkflows();
  }, []);

  const loadExecutions = useCallback(async () => {
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

      setExecutions(result.executions);
      setTotal(result.total);
      setError(null);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : t("common.errors.failedToLoad");
      setError(message);
    } finally {
      setLoading(false);
    }
  }, [statusFilter, workflowFilter, debouncedSearch, sortBy, sortOrder, currentPage, pageSize, t]);

  useEffect(() => {
    loadExecutions();
  }, [loadExecutions]);

  const handleExecutionClick = (executionId: string) => {
    navigate(`${ROUTES.EXECUTIONS}/${executionId}`);
  };

  const totalPages = Math.ceil(total / pageSize);

  if (loading && executions.length === 0) {
    return (
      <PageShell
        title={t("pages.executions.title")}
        description={t("pages.executions.subtitle")}
        loading
      />
    );
  }

  if (error) {
    return (
      <PageShell
        title={t("pages.executions.title")}
        error={error}
        onRetry={loadExecutions}
        retryLabel={t("pages.executions.retry")}
      />
    );
  }

  return (
    <PageShell title={t("pages.executions.title")} description={t("pages.executions.subtitle")}>
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
                <SelectTrigger className="w-[150px]" data-testid="status-filter">
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

            {workflows.length > 0 && (
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
                  placeholder={t("pages.executions.filters.workflow")}
                  searchPlaceholder={t("common.filters.search")}
                  testId="workflow-filter"
                />
              </LabeledFilter>
            )}

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

      <LockedExecutionsWidget />

      <DataListView
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
        loading={loading}
        emptyIcon={Play}
        emptyTitle={
          debouncedSearch || statusFilter !== "all" || workflowFilter !== "all"
            ? t("pages.executions.noResults")
            : t("pages.executions.noExecutions")
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
    </PageShell>
  );
};
