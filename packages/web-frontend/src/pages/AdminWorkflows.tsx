/**
 * Admin Workflows Page
 * View all workflows across all users with server-side pagination and filters
 */

import React, { useState, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { GitBranch } from "lucide-react";
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
import { Input } from "@/components/ui/input";
import { SearchableSelect } from "@/components/SearchableSelect";
import { PageShell } from "@/components/PageShell";
import { FilterBar } from "@/components/FilterBar";
import { LabeledFilter } from "@/components/LabeledFilter";
import { DataListView } from "@/components/DataListView";
import { AdminWorkflowCard, type AdminWorkflowCardData } from "@/components/cards";

interface User {
  id: string;
  email: string;
  name: string | null;
}

const ALL_FILTER = "__all__";

export const AdminWorkflows: React.FC = () => {
  const { t } = useTranslation();
  const [workflows, setWorkflows] = useState<AdminWorkflowCardData[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [total, setTotal] = useState(0);
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

  const { pageSize, containerRef } = useDynamicPageSize();

  // Reset page when filters change
  useEffect(() => {
    setCurrentPage(1);
  }, [selectedUserId, selectedVisibility, selectedValidation, debouncedSearch, fromDate, toDate]);

  const loadData = useCallback(async () => {
    try {
      setLoading(true);
      const offset = (currentPage - 1) * pageSize;

      const [workflowsData, usersData] = await Promise.all([
        apiClient.getAdminWorkflows({
          userId: selectedUserId || undefined,
          visibility: (selectedVisibility as "public" | "private" | "all") || undefined,
          isValid: (selectedValidation as "true" | "false" | "unknown") || undefined,
          search: debouncedSearch || undefined,
          fromDate: fromDate ? new Date(fromDate).getTime() : undefined,
          toDate: toDate
            ? (() => {
                const endOfDay = new Date(toDate);
                endOfDay.setHours(23, 59, 59, 999);
                return endOfDay.getTime();
              })()
            : undefined,
          sort: "updatedAt",
          sortOrder: "desc",
          limit: pageSize,
          offset,
        }),
        apiClient.getAdminUsers({ limit: 100 }),
      ]);

      setWorkflows(workflowsData.workflows);
      setTotal(workflowsData.total);
      setUsers(usersData.users.map((u) => ({ id: u.id, email: u.email, name: u.name })));
      setError(null);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : t("common.errors.failedToLoad");
      setError(message);
    } finally {
      setLoading(false);
    }
  }, [
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

  const totalPages = Math.ceil(total / pageSize);

  if (loading && workflows.length === 0) {
    return (
      <PageShell
        title={t("admin.workflows.title")}
        description={t("admin.workflows.subtitle")}
        loading
      />
    );
  }

  if (error) {
    return (
      <PageShell
        title={t("admin.workflows.title")}
        error={error}
        onRetry={loadData}
        retryLabel={t("admin.workflows.retry")}
      />
    );
  }

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
                placeholder={t("admin.workflows.filters.allUsers")}
                searchPlaceholder={t("common.filters.search")}
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

      <DataListView
        items={workflows}
        renderCard={(workflow, viewMode) => (
          <AdminWorkflowCard workflow={workflow} compact={viewMode === "grid"} />
        )}
        keyExtractor={(w) => w.id}
        storageKey="admin-workflows-view-mode"
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
        emptyIcon={GitBranch}
        emptyTitle={t("admin.workflows.noWorkflows")}
        className="flex-1 min-h-0 flex flex-col"
      />
    </PageShell>
  );
};
