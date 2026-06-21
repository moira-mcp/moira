/**
 * Deleted Workflows Management Page
 * Admin panel for restoring or permanently deleting workflows at /admin/deleted-workflows
 */

import React, { useState, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { GitBranch } from "lucide-react";
import { apiClient } from "../services/api-client";
import { useDynamicPageSize } from "../hooks/useDynamicPageSize";
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
  const [workflows, setWorkflows] = useState<DeletedWorkflowCardData[]>([]);
  const [total, setTotal] = useState(0);
  const [currentPage, setCurrentPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState("");
  const debouncedSearch = useDebounce(searchTerm, 300);
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [dialogState, setDialogState] = useState<DialogState>(initialDialogState);

  const { pageSize, containerRef } = useDynamicPageSize();

  // Reset page when filters change
  useEffect(() => {
    setCurrentPage(1);
  }, [debouncedSearch]);

  const loadDeletedWorkflows = useCallback(async () => {
    setLoading(true);
    try {
      const offset = (currentPage - 1) * pageSize;
      const data = await apiClient.getDeletedWorkflows({
        search: debouncedSearch || undefined,
        limit: pageSize,
        offset,
      });
      setWorkflows(data.workflows);
      setTotal(data.total);
      setError(null);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : t("common.errors.failedToLoad");
      setError(message);
    } finally {
      setLoading(false);
    }
  }, [currentPage, pageSize, debouncedSearch, t]);

  useEffect(() => {
    loadDeletedWorkflows();
  }, [loadDeletedWorkflows]);

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
    closeDialog();

    if (type === "restore") {
      try {
        await apiClient.restoreWorkflow(workflowId);
        toast.success(t("admin.deletedWorkflows.actions.restore"));
        await loadDeletedWorkflows();
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : "Failed to restore workflow";
        toast.error(message);
      }
    } else {
      try {
        await apiClient.hardDeleteWorkflow(workflowId);
        toast.success(t("admin.deletedWorkflows.actions.permanentDelete"));
        await loadDeletedWorkflows();
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : "Failed to delete workflow";
        toast.error(message);
      }
    }
  };

  // Client-side date filtering (dates not sent to server)
  const filteredWorkflows = workflows.filter((wf) => {
    if (wf.deletedAt && (dateFrom || dateTo)) {
      const deletedDate = new Date(wf.deletedAt);
      if (dateFrom && deletedDate < new Date(dateFrom)) return false;
      if (dateTo && deletedDate > new Date(dateTo + "T23:59:59")) return false;
    }
    return true;
  });

  const totalPages = Math.ceil(total / pageSize);

  if (loading && workflows.length === 0) {
    return <PageShell title={t("admin.deletedWorkflows.title")} loading />;
  }

  if (error) {
    return (
      <PageShell
        title={t("admin.deletedWorkflows.title")}
        error={error}
        onRetry={loadDeletedWorkflows}
      />
    );
  }

  return (
    <PageShell title={t("admin.deletedWorkflows.title")}>
      <FilterBar
        search={searchTerm}
        onSearchChange={setSearchTerm}
        searchPlaceholder={t("admin.deletedWorkflows.searchPlaceholder")}
        searchTestId="deleted-workflows-search"
        onReset={() => {
          setSearchTerm("");
          setDateFrom("");
          setDateTo("");
          setCurrentPage(1);
        }}
        filters={
          <>
            <LabeledFilter label={t("common.filters.dateFrom")}>
              <Input
                type="date"
                value={dateFrom}
                onChange={(e) => setDateFrom(e.target.value)}
                className="w-[160px]"
                placeholder={t("admin.deletedWorkflows.filters.from")}
              />
            </LabeledFilter>
            <LabeledFilter label={t("common.filters.dateTo")}>
              <Input
                type="date"
                value={dateTo}
                onChange={(e) => setDateTo(e.target.value)}
                className="w-[160px]"
                placeholder={t("admin.deletedWorkflows.filters.to")}
              />
            </LabeledFilter>
          </>
        }
      />

      <DataListView
        items={filteredWorkflows}
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
        emptyTitle={
          searchTerm || dateFrom || dateTo
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
