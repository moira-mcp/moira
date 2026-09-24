/**
 * Workflow Explorer - workflow list with filtering, sorting, and pagination
 * Uses shared design system: FilterBar + DataListView for consistency with other pages.
 * Tabs say whose flows are listed — all, mine, shared with me, the public catalog — each one
 * server query, so sort and pages hold inside it. The search is always in view; status,
 * visibility and sort are optional and fold behind the FilterBar's "Filters" button until the
 * reader opens it or one of them is in effect.
 */

import React, { useState, useMemo, useCallback, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Folder } from "lucide-react";
import { WorkflowFileInfo, WorkflowListRequest } from "types";
import { useWorkflowList } from "../../hooks/useWorkflowData";
import { DataListView } from "@/components/DataListView";
import { FilterBar } from "@/components/FilterBar";
import { LabeledFilter } from "@/components/LabeledFilter";
import { SortSelect, makeSortValue, parseSortValue } from "@/components/SortSelect";
import { useDebounce } from "../../hooks/useDebounce";
import { useDynamicPageSize } from "../../hooks/useDynamicPageSize";
import { WorkflowCard } from "./WorkflowCard";
import { GRID_ITEM_HEIGHT, LIST_ITEM_HEIGHT } from "../cards/CardShell";
import type { ViewMode } from "@/components/DataListView";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

/** Whose flows the list shows; each is one server query. */
const SCOPES = ["all", "mine", "shared", "catalog"] as const;
type Scope = (typeof SCOPES)[number];

interface WorkflowExplorerProps {
  selectedWorkflowId?: string;
  onWorkflowSelect: (workflow: WorkflowFileInfo) => void;
  onDelete?: (workflowId: string, workflowName: string) => void;
  currentUserHandle?: string;
  isAdmin?: boolean;
}

export const WorkflowExplorer: React.FC<WorkflowExplorerProps> = ({
  selectedWorkflowId,
  onWorkflowSelect,
  onDelete,
  currentUserHandle,
  isAdmin,
}) => {
  const { t } = useTranslation();
  const [viewMode, setViewMode] = useState<ViewMode>("list");
  const { pageSize, containerRef } = useDynamicPageSize(
    viewMode === "grid" ? GRID_ITEM_HEIGHT : LIST_ITEM_HEIGHT,
  );
  const { workflows, loading, error, loadWorkflows, isAuthenticated } = useWorkflowList();

  const hasLoadedOnce = useRef(false);

  // Filter state
  const [searchQuery, setSearchQuery] = useState("");
  const [access, setAccess] = useState<Scope>("all");
  const [statusFilter, setStatusFilter] = useState<"all" | "valid" | "invalid" | "unknown">("all");
  const [visibilityFilter, setVisibilityFilter] = useState<"all" | "public" | "private">("all");
  const [sortBy, setSortBy] = useState<"createdAt" | "name">("createdAt");
  const [sortOrder, setSortOrder] = useState<"asc" | "desc">("desc");
  const [currentPage, setCurrentPage] = useState(1);

  const sortValue = makeSortValue(sortBy, sortOrder);
  const handleSortChange = (value: string) => {
    const { field, direction } = parseSortValue<"createdAt" | "name">(value);
    setSortBy(field);
    setSortOrder(direction);
    setCurrentPage(1);
  };

  const handleReset = () => {
    setSearchQuery("");
    setStatusFilter("all");
    setVisibilityFilter("all");
    setSortBy("createdAt");
    setSortOrder("desc");
    setCurrentPage(1);
  };

  const debouncedSearch = useDebounce(searchQuery, 300);
  const activeFilters =
    (statusFilter !== "all" ? 1 : 0) +
    (visibilityFilter !== "all" ? 1 : 0) +
    (sortBy !== "createdAt" || sortOrder !== "desc" ? 1 : 0);

  // Reset page on filter changes
  useEffect(() => {
    setCurrentPage(1);
  }, [debouncedSearch, statusFilter, visibilityFilter, access]);

  // Build request params
  const requestParams = useMemo((): WorkflowListRequest => {
    return {
      search: debouncedSearch || undefined,
      visibility: visibilityFilter === "all" ? undefined : visibilityFilter,
      access,
      validationStatus: statusFilter === "all" ? undefined : statusFilter,
      sort: sortBy,
      sortOrder,
      limit: pageSize,
      offset: (currentPage - 1) * pageSize,
    };
  }, [
    debouncedSearch,
    visibilityFilter,
    access,
    statusFilter,
    sortBy,
    sortOrder,
    currentPage,
    pageSize,
  ]);

  useEffect(() => {
    if (!isAuthenticated) return;
    loadWorkflows(requestParams);
  }, [isAuthenticated, requestParams, loadWorkflows]);

  useEffect(() => {
    if (workflows) hasLoadedOnce.current = true;
  }, [workflows]);

  const handleWorkflowSelect = useCallback(
    (workflow: WorkflowFileInfo) => {
      onWorkflowSelect(workflow);
    },
    [onWorkflowSelect],
  );

  const totalPages = useMemo(() => {
    if (!workflows) return 0;
    return Math.ceil(workflows.totalWorkflows / pageSize);
  }, [workflows, pageSize]);

  const displayedWorkflows = workflows?.workflows || [];
  const totalWorkflows = workflows?.totalWorkflows || 0;

  // Expose loading/error for parent PageShell
  if (loading && !hasLoadedOnce.current) {
    return null; // Parent handles loading state via PageShell
  }

  if (error) {
    return null; // Parent handles error state via PageShell
  }

  return (
    <div className="flex flex-col flex-1 min-h-0" data-testid="workflow-explorer">
      <Tabs value={access} onValueChange={(value) => setAccess(value as Scope)} className="mb-3">
        <TabsList data-testid="workflow-scopes">
          {SCOPES.map((scope) => (
            <TabsTrigger key={scope} value={scope} data-testid={`workflow-scope-${scope}`}>
              {t(`pages.workflows.scopes.${scope}`)}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
      <FilterBar
        search={searchQuery}
        onSearchChange={setSearchQuery}
        searchPlaceholder={t("components.searchFilters.searchPlaceholder")}
        onReset={handleReset}
        foldFilters={{ activeCount: activeFilters }}
        filters={
          <>
            <LabeledFilter label={t("common.filters.status")}>
              <Select
                value={statusFilter}
                onValueChange={(v) => setStatusFilter(v as typeof statusFilter)}
              >
                <SelectTrigger className="w-[150px]" data-testid="status-filter">
                  <SelectValue placeholder={t("components.searchFilters.status")} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">{t("components.searchFilters.all")}</SelectItem>
                  <SelectItem value="valid">{t("components.searchFilters.valid")}</SelectItem>
                  <SelectItem value="invalid">{t("components.searchFilters.invalid")}</SelectItem>
                  <SelectItem value="unknown">{t("components.searchFilters.unknown")}</SelectItem>
                </SelectContent>
              </Select>
            </LabeledFilter>

            <LabeledFilter label={t("common.filters.visibility")}>
              <Select
                value={visibilityFilter}
                onValueChange={(v) => setVisibilityFilter(v as typeof visibilityFilter)}
              >
                <SelectTrigger className="w-[150px]" data-testid="visibility-filter">
                  <SelectValue placeholder={t("components.searchFilters.visibility")} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">{t("components.searchFilters.all")}</SelectItem>
                  <SelectItem value="public">{t("components.searchFilters.public")}</SelectItem>
                  <SelectItem value="private">{t("components.searchFilters.private")}</SelectItem>
                </SelectContent>
              </Select>
            </LabeledFilter>

            <SortSelect
              value={sortValue}
              onChange={handleSortChange}
              label={t("common.filters.sort")}
              options={[
                {
                  value: "createdAt-desc",
                  label: `${t("components.searchFilters.sortByDate")} ↓`,
                },
                {
                  value: "createdAt-asc",
                  label: `${t("components.searchFilters.sortByDate")} ↑`,
                },
                {
                  value: "name-asc",
                  label: `${t("components.searchFilters.sortByName")} ↑`,
                },
                {
                  value: "name-desc",
                  label: `${t("components.searchFilters.sortByName")} ↓`,
                },
              ]}
              testId="sort-select"
            />
          </>
        }
      />

      <DataListView
        items={displayedWorkflows}
        renderCard={(workflow, viewMode) => (
          <WorkflowCard
            workflow={workflow}
            isSelected={selectedWorkflowId === workflow.id}
            onClick={handleWorkflowSelect}
            onDelete={onDelete}
            currentUserHandle={currentUserHandle}
            isAdmin={isAdmin}
            compact={viewMode === "grid"}
          />
        )}
        keyExtractor={(w) => w.id}
        storageKey="workflows-view-mode"
        loading={loading}
        emptyIcon={Folder}
        emptyTitle={
          debouncedSearch ||
          statusFilter !== "all" ||
          visibilityFilter !== "all" ||
          access !== "all"
            ? t("pages.workflows.explorer.noMatch")
            : t("pages.workflows.explorer.noWorkflows")
        }
        containerRef={containerRef}
        pagination={{
          mode: "total",
          currentPage,
          totalPages,
          totalItems: totalWorkflows,
          pageSize,
          onPageChange: setCurrentPage,
        }}
        className="flex-1 min-h-0 flex flex-col"
        onViewModeChange={setViewMode}
      />
    </div>
  );
};
