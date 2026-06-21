/**
 * Workflows Page
 * Workflow list and explorer - click workflow to navigate to /workflows/:handle/:slug
 */

import React, { useState, useEffect, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { WorkflowFileInfo } from "types";
import { WorkflowExplorer } from "../components/workflow/WorkflowExplorer";
import { apiClient } from "../services/api-client";
import { ROUTES } from "../constants/routes";
import { ConfirmDialog } from "../components/confirm-dialog";
import { PageShell } from "../components/PageShell";
import { toast } from "sonner";

export const Workflows: React.FC = () => {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const [currentUserHandle, setCurrentUserHandle] = useState<string | undefined>();
  const [isAdmin, setIsAdmin] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; name: string } | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    const fetchUserInfo = async () => {
      try {
        const userInfo = await apiClient.getUserInfo();
        setCurrentUserHandle(userInfo.handle || undefined);
        setIsAdmin(userInfo.isAdmin);
      } catch {
        // Ignore errors - user info is optional for delete button visibility
      }
    };
    fetchUserInfo();
  }, []);

  const handleWorkflowSelect = useCallback(
    (workflow: WorkflowFileInfo) => {
      navigate(`${ROUTES.WORKFLOWS}/${workflow.ownerHandle}/${workflow.slug}`);
    },
    [navigate],
  );

  const handleDeleteWorkflow = useCallback((workflowId: string, workflowName: string) => {
    setDeleteTarget({ id: workflowId, name: workflowName });
  }, []);

  const handleConfirmDelete = async () => {
    if (!deleteTarget) return;
    try {
      await apiClient.deleteWorkflow(deleteTarget.id);
      setRefreshKey((k) => k + 1);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : t("common.errors.failedToDelete");
      toast.error(message);
    }
  };

  return (
    <PageShell title={t("pages.workflows.title")} description={t("pages.workflows.subtitle")}>
      <WorkflowExplorer
        key={refreshKey}
        onWorkflowSelect={handleWorkflowSelect}
        onDelete={handleDeleteWorkflow}
        currentUserHandle={currentUserHandle}
        isAdmin={isAdmin}
      />
      <ConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
        title={t("pages.workflows.confirmDeleteTitle", { defaultValue: "Delete workflow" })}
        description={t("pages.workflows.confirmDelete", { name: deleteTarget?.name ?? "" })}
        confirmLabel={t("common.delete", { defaultValue: "Delete" })}
        cancelLabel={t("common.cancel", { defaultValue: "Cancel" })}
        variant="destructive"
        onConfirm={handleConfirmDelete}
      />
    </PageShell>
  );
};
