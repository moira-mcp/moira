/**
 * Deleted Workflows Management Page
 * Admin panel for restoring or permanently deleting workflows at /admin/deleted-workflows
 */

import React, { useState } from "react";
import { useTranslation } from "react-i18next";
import { GitBranch, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { apiClient } from "../services/api-client";
import { useListPageSize } from "../hooks/useListPageSize";
import { useResource } from "../hooks/useResource";
import { useReadOwnerGuard } from "../auth/ReadScopeBoundary";
import { localDayRange } from "@/lib/local-date-range";
import { useDebounce } from "../hooks/useDebounce";
import { Input } from "@/components/ui/input";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { PageShell } from "@/components/PageShell";
import { FilterBar } from "@/components/FilterBar";
import { LabeledFilter } from "@/components/LabeledFilter";
import { DataListView } from "@/components/DataListView";
import { DeletedWorkflowCard, type DeletedWorkflowCardData } from "@/components/cards";
import { toast } from "sonner";

interface DialogState {
  open: boolean;
  type: "restore" | "delete";
  workflowId: string;
  workflowName: string;
}

const initialDialogState: DialogState = {
  open: false,
  type: "restore",
  workflowId: "",
  workflowName: "",
};

export const DeletedWorkflows: React.FC = () => {
  const { t } = useTranslation();
  const [query, setQuery] = useState({ page: 1, dateFrom: "", dateTo: "" });
  const { dateFrom, dateTo } = query;
  const [searchTerm, setSearchTerm] = useState("");
  const debouncedSearch = useDebounce(searchTerm, 300);
  const [dialogState, setDialogState] = useState<DialogState>(initialDialogState);

  const { pageSize, containerRef, onViewModeChange } = useListPageSize(() =>
    setQuery((value) => ({ ...value, page: 1 })),
  );
  const guardOwner = useReadOwnerGuard();
  const resource = useResource(
    JSON.stringify({ ...query, search: debouncedSearch, pageSize }),
    async (key) => {
      const requested = JSON.parse(key) as typeof query & { search: string; pageSize: number };
      const data = await apiClient.getDeletedWorkflows({
        search: requested.search || undefined,
        ...localDayRange(requested.dateFrom, requested.dateTo),
        limit: requested.pageSize,
        offset: (requested.page - 1) * requested.pageSize,
      });
      const lastPage = Math.max(1, Math.ceil(data.total / requested.pageSize));
      if (requested.page > lastPage) {
        const corrected = await apiClient.getDeletedWorkflows({
          search: requested.search || undefined,
          ...localDayRange(requested.dateFrom, requested.dateTo),
          limit: requested.pageSize,
          offset: (lastPage - 1) * requested.pageSize,
        });
        return { ...corrected, query: { ...requested, page: lastPage } };
      }
      return { ...data, query: requested };
    },
  );
  const accepted = resource.data;
  const workflows = accepted?.workflows ?? [];
  const total = accepted?.total ?? 0;
  const currentPage = accepted?.query.page ?? 1;
  const acceptedPageSize = accepted?.query.pageSize ?? pageSize;

  const openRestoreDialog = (workflow: DeletedWorkflowCardData) => {
    setDialogState({
      open: true,
      type: "restore",
      workflowId: workflow.id,
      workflowName: workflow.name,
    });
  };

  const openDeleteDialog = (workflow: DeletedWorkflowCardData) => {
    setDialogState({
      open: true,
      type: "delete",
      workflowId: workflow.id,
      workflowName: workflow.name,
    });
  };

  const closeDialog = () => {
    setDialogState(initialDialogState);
  };

  const handleConfirmAction = async () => {
    const { type, workflowId } = dialogState;
    const isCurrentOwner = guardOwner();

    if (type === "restore") {
      try {
        await apiClient.restoreWorkflow(workflowId);
        if (!isCurrentOwner()) return;
        toast.success(t("admin.deletedWorkflows.actions.restore"));
        await resource.refresh();
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : "Failed to restore workflow";
        if (isCurrentOwner()) toast.error(message);
        throw err;
      }
    } else {
      try {
        await apiClient.hardDeleteWorkflow(workflowId);
        if (!isCurrentOwner()) return;
        toast.success(t("admin.deletedWorkflows.actions.permanentDelete"));
        await resource.refresh();
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : "Failed to delete workflow";
        if (isCurrentOwner()) toast.error(message);
        throw err;
      }
    }
  };

  const totalPages = Math.ceil(total / acceptedPageSize);

  return (
    <PageShell title={t("admin.deletedWorkflows.title")}>
      <FilterBar
        actions={
          <Button variant="outline" size="sm" onClick={() => void resource.refresh()}>
            <RotateCcw className="size-4" />
            {t("common.dataRegion.refresh")}
          </Button>
        }
        search={searchTerm}
        onSearchChange={(value) => {
          setSearchTerm(value);
          setQuery((previous) => ({ ...previous, page: 1 }));
        }}
        searchPlaceholder={t("admin.deletedWorkflows.searchPlaceholder")}
        searchTestId="deleted-workflows-search"
        onReset={() => {
          setSearchTerm("");
          setQuery({ page: 1, dateFrom: "", dateTo: "" });
        }}
        filters={
          <>
            <LabeledFilter label={t("common.filters.dateFrom")}>
              <Input
                type="date"
                aria-label={t("common.filters.dateFrom")}
                value={dateFrom}
                onChange={(e) => {
                  const value = e.currentTarget.value;
                  setQuery((previous) => ({ ...previous, dateFrom: value, page: 1 }));
                }}
                className="w-[160px]"
                placeholder={t("admin.deletedWorkflows.filters.from")}
              />
            </LabeledFilter>
            <LabeledFilter label={t("common.filters.dateTo")}>
              <Input
                type="date"
                aria-label={t("common.filters.dateTo")}
                value={dateTo}
                onChange={(e) => {
                  const value = e.currentTarget.value;
                  setQuery((previous) => ({ ...previous, dateTo: value, page: 1 }));
                }}
                className="w-[160px]"
                placeholder={t("admin.deletedWorkflows.filters.to")}
              />
            </LabeledFilter>
          </>
        }
      />

      <DataListView
        onViewModeChange={onViewModeChange}
        items={workflows}
        hasResult={accepted !== undefined}
        error={resource.error}
        onRetry={resource.refresh}
        resultScope={
          accepted && (
            <span>
              {t("common.filters.search")}: {accepted.query.search || "—"} ·{" "}
              {t("common.filters.dateFrom")}: {accepted.query.dateFrom || "—"} ·{" "}
              {t("common.filters.dateTo")}: {accepted.query.dateTo || "—"}
            </span>
          )
        }
        renderCard={(workflow, viewMode) => (
          <DeletedWorkflowCard
            workflow={workflow}
            compact={viewMode === "grid"}
            onRestore={openRestoreDialog}
            onPermanentDelete={openDeleteDialog}
          />
        )}
        keyExtractor={(wf) => wf.id}
        storageKey="deleted-workflows-view-mode"
        loading={resource.pending}
        containerRef={containerRef}
        pagination={{
          mode: "total",
          currentPage,
          totalPages,
          pageSize: acceptedPageSize,
          totalItems: total,
          onPageChange: (page) => setQuery((previous) => ({ ...previous, page })),
        }}
        emptyIcon={GitBranch}
        emptyTitle={
          accepted && (accepted.query.search || accepted.query.dateFrom || accepted.query.dateTo)
            ? t("admin.deletedWorkflows.noMatchingWorkflows")
            : t("admin.deletedWorkflows.noDeletedWorkflows")
        }
        className="flex-1 min-h-0 flex flex-col"
      />

      <ConfirmDialog
        open={dialogState.open}
        onOpenChange={(open) => !open && closeDialog()}
        title={
          dialogState.type === "restore"
            ? t("admin.deletedWorkflows.actions.restore")
            : t("admin.deletedWorkflows.actions.permanentDelete")
        }
        description={
          dialogState.type === "restore"
            ? t("admin.deletedWorkflows.confirmRestore", { name: dialogState.workflowName })
            : t("admin.deletedWorkflows.confirmPermanentDelete", {
                name: dialogState.workflowName,
              })
        }
        confirmLabel={
          dialogState.type === "restore"
            ? t("admin.deletedWorkflows.actions.restore")
            : t("admin.deletedWorkflows.actions.permanentDelete")
        }
        cancelLabel={t("common.cancel", { defaultValue: "Cancel" })}
        variant={dialogState.type === "delete" ? "destructive" : "default"}
        onConfirm={handleConfirmAction}
      />
    </PageShell>
  );
};
