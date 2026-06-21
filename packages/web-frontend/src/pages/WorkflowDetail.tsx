/**
 * Workflow Detail Page
 * Detailed view for single workflow at /workflows/:id
 *
 * Side-by-side layout: graph (left) + persistent sidebar (right).
 * Sidebar shows workflow info when no node selected, node details on selection.
 * Delete/visibility buttons hidden for non-owned workflows.
 */

import React, { useState, useCallback } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import {
  Globe,
  Lock,
  Copy,
  Share2,
  Users,
  ArrowLeft,
  Trash2,
  MoreHorizontal,
  PanelRightClose,
  PanelRightOpen,
} from "lucide-react";
import { Node } from "@xyflow/react";
import { toast } from "sonner";
import { WorkflowGraph } from "../components/workflow/WorkflowGraph";
import { WorkflowSidebar } from "../components/workflow/WorkflowSidebar";
import WorkflowBreadcrumbComponent from "../components/workflow/WorkflowBreadcrumb";
import { ShareDialog } from "../components/workflow/ShareDialog";
import { ConfirmDialog } from "../components/confirm-dialog";
import { PageLoader } from "../components/page-loader";
import { InlineError } from "../components/inline-error";
import { useWorkflowApp } from "../hooks/useWorkflowData";
import { useSession } from "../auth/better-auth-client";
import { apiClient } from "../services/api-client";
import { ROUTES } from "../constants/routes";
import { Button } from "../components/ui/button";
import { Badge } from "../components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../components/ui/dropdown-menu";

export const WorkflowDetail: React.FC = () => {
  // Support both /workflows/:id and /workflows/:handle/:slug routes
  const { id, handle, slug } = useParams<{ id?: string; handle?: string; slug?: string }>();
  const navigate = useNavigate();
  const { t } = useTranslation();
  const { data: session } = useSession();
  const { breadcrumbs, selectWorkflow, clearBreadcrumbs, workflowDetail } = useWorkflowApp();
  const [visibilityUpdating, setVisibilityUpdating] = useState(false);
  const [copying, setCopying] = useState(false);
  const [shareDialogOpen, setShareDialogOpen] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [sidebarVisible, setSidebarVisible] = useState(true);

  // Selected node state for sidebar
  const [selectedNode, setSelectedNode] = useState<Node | null>(null);
  const [nodeConnections, setNodeConnections] = useState<{
    incoming: Array<{ id: string; label: string }>;
    outgoing: Array<{ id: string; label: string; connectionType: string }>;
  }>({ incoming: [], outgoing: [] });

  // Compute workflow identifier: handle/slug format or just id
  const workflowIdentifier = handle && slug ? `${handle}/${slug}` : id;

  // Load workflow by identifier on mount
  React.useEffect(() => {
    if (workflowIdentifier) {
      selectWorkflow(workflowIdentifier);
    }
  }, [workflowIdentifier, selectWorkflow]);

  const handleBack = () => {
    clearBreadcrumbs();
    navigate(ROUTES.WORKFLOWS);
  };

  const handleNavigate = (workflowId: string) => {
    navigate(`${ROUTES.WORKFLOWS}/${workflowId}`);
  };

  const handleDeleteWorkflow = useCallback(async () => {
    if (!workflowIdentifier) return;

    try {
      await apiClient.deleteWorkflow(workflowIdentifier);
      navigate(ROUTES.WORKFLOWS);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : t("common.errors.failedToDelete");
      toast.error(message);
    }
  }, [workflowIdentifier, navigate, t]);

  const handleToggleVisibility = useCallback(async () => {
    if (!workflowIdentifier || !workflowDetail.workflow?.fileInfo) return;

    const currentVisibility = workflowDetail.workflow.fileInfo.visibility;
    const newVisibility = currentVisibility === "public" ? "private" : "public";

    setVisibilityUpdating(true);
    try {
      await apiClient.updateWorkflowVisibility(workflowIdentifier, newVisibility);
      workflowDetail.refreshWorkflow();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : t("common.errors.failedToUpdate");
      toast.error(message);
    } finally {
      setVisibilityUpdating(false);
    }
  }, [workflowIdentifier, workflowDetail, t]);

  const handleCopyWorkflow = useCallback(async () => {
    if (!workflowIdentifier) return;

    setCopying(true);
    try {
      const result = await apiClient.copyWorkflow(workflowIdentifier);
      navigate(`${ROUTES.WORKFLOWS}/${result.workflowId}`);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : t("common.errors.failedToCreate");
      toast.error(message);
    } finally {
      setCopying(false);
    }
  }, [workflowIdentifier, navigate, t]);

  // Check if current user is the owner using accessType from API
  const fileInfo = workflowDetail.workflow?.fileInfo;
  const isOwner = fileInfo?.accessType === "owner";

  // Handle node selection from graph
  const handleNodeSelect = useCallback(
    (
      node: Node | null,
      connections: {
        incoming: Array<{ id: string; label: string }>;
        outgoing: Array<{ id: string; label: string; connectionType: string }>;
      },
    ) => {
      setSelectedNode(node);
      setNodeConnections(connections);
    },
    [],
  );

  const handleClearSelection = useCallback(() => {
    setSelectedNode(null);
    setNodeConnections({ incoming: [], outgoing: [] });
  }, []);

  return (
    <div className="h-full flex flex-col">
      {/* Compact responsive toolbar */}
      <div className="border-b border-border p-2 flex justify-between items-center gap-2">
        <Button variant="ghost" size="sm" onClick={handleBack} className="gap-1.5">
          <ArrowLeft className="w-4 h-4" />
          <span className="hidden sm:inline">{t("pages.workflowDetail.backToWorkflows")}</span>
        </Button>

        {/* Desktop toolbar */}
        <div className="hidden md:flex items-center gap-2">
          {fileInfo?.visibility === "public" && session?.user && (
            <Button
              variant="outline"
              size="sm"
              onClick={handleCopyWorkflow}
              disabled={copying}
              className="gap-1.5"
            >
              <Copy className="w-3.5 h-3.5" />
              {copying
                ? t("pages.workflowDetail.copyingWorkflow")
                : t("pages.workflowDetail.useAsTemplate")}
            </Button>
          )}
          {isOwner && fileInfo && (
            <Button
              variant="outline"
              size="sm"
              onClick={handleToggleVisibility}
              disabled={visibilityUpdating}
              className="gap-1.5"
            >
              {fileInfo.visibility === "public" ? (
                <>
                  <Globe className="w-3.5 h-3.5" />
                  {t("components.workflowCard.public")}
                </>
              ) : (
                <>
                  <Lock className="w-3.5 h-3.5" />
                  {t("components.workflowCard.private")}
                </>
              )}
            </Button>
          )}
          {fileInfo?.accessType === "shared" && (
            <Badge variant="secondary" className="gap-1.5" data-testid="shared-with-you-indicator">
              <Users className="w-3.5 h-3.5" />
              {t("components.workflowCard.sharedWithYou")}
            </Badge>
          )}
          {isOwner && workflowIdentifier && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setShareDialogOpen(true)}
              className="gap-1.5"
              data-testid="share-workflow-button"
            >
              <Share2 className="w-3.5 h-3.5" />
              {t("pages.workflowDetail.share")}
            </Button>
          )}
          {isOwner && (
            <Button
              variant="destructive"
              size="sm"
              onClick={() => setDeleteDialogOpen(true)}
              className="gap-1.5"
            >
              <Trash2 className="w-3.5 h-3.5" />
              {t("pages.workflowDetail.deleteWorkflow")}
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setSidebarVisible(!sidebarVisible)}
            className="gap-1.5"
            title={
              sidebarVisible
                ? t("pages.workflowDetail.hideSidebar")
                : t("pages.workflowDetail.showSidebar")
            }
          >
            {sidebarVisible ? (
              <PanelRightClose className="w-3.5 h-3.5" />
            ) : (
              <PanelRightOpen className="w-3.5 h-3.5" />
            )}
          </Button>
        </div>

        {/* Mobile dropdown */}
        <div className="md:hidden">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                aria-label={t("common.actions", { defaultValue: "Actions" })}
              >
                <MoreHorizontal className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {fileInfo?.visibility === "public" && session?.user && (
                <DropdownMenuItem onClick={handleCopyWorkflow} disabled={copying}>
                  <Copy className="mr-2 h-4 w-4" />
                  {t("pages.workflowDetail.useAsTemplate")}
                </DropdownMenuItem>
              )}
              {isOwner && fileInfo && (
                <DropdownMenuItem onClick={handleToggleVisibility} disabled={visibilityUpdating}>
                  {fileInfo.visibility === "public" ? (
                    <Globe className="mr-2 h-4 w-4" />
                  ) : (
                    <Lock className="mr-2 h-4 w-4" />
                  )}
                  {t("pages.workflowDetail.toggleVisibility")}
                </DropdownMenuItem>
              )}
              {isOwner && workflowIdentifier && (
                <DropdownMenuItem onClick={() => setShareDialogOpen(true)}>
                  <Share2 className="mr-2 h-4 w-4" />
                  {t("pages.workflowDetail.share")}
                </DropdownMenuItem>
              )}
              <DropdownMenuItem onClick={() => setSidebarVisible(!sidebarVisible)}>
                {sidebarVisible ? (
                  <PanelRightClose className="mr-2 h-4 w-4" />
                ) : (
                  <PanelRightOpen className="mr-2 h-4 w-4" />
                )}
                {sidebarVisible
                  ? t("pages.workflowDetail.hideSidebar")
                  : t("pages.workflowDetail.showSidebar")}
              </DropdownMenuItem>
              {isOwner && (
                <DropdownMenuItem
                  onClick={() => setDeleteDialogOpen(true)}
                  className="text-destructive focus:text-destructive"
                >
                  <Trash2 className="mr-2 h-4 w-4" />
                  {t("pages.workflowDetail.deleteWorkflow")}
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {/* Breadcrumbs */}
      {breadcrumbs.length > 0 && (
        <WorkflowBreadcrumbComponent
          breadcrumbs={breadcrumbs}
          onNavigate={handleNavigate}
          onClear={clearBreadcrumbs}
        />
      )}

      {/* Workflow Graph + Sidebar */}
      <div className="flex-1 overflow-hidden flex">
        {/* Graph area */}
        <div className="flex-1 min-w-0">
          {workflowDetail.loading ? (
            <PageLoader />
          ) : workflowDetail.error ? (
            <div className="flex items-center justify-center h-full">
              <InlineError
                message={workflowDetail.error}
                onRetry={() => workflowIdentifier && selectWorkflow(workflowIdentifier)}
              />
            </div>
          ) : workflowDetail.workflow?.workflow ? (
            <WorkflowGraph
              workflow={workflowDetail.workflow.workflow}
              validation={workflowDetail.workflow.validation}
              onWorkflowNavigate={handleNavigate}
              onNodeSelect={handleNodeSelect}
              showNodeDetails={false}
              showControls={true}
              showMinimap={true}
            />
          ) : (
            <div className="flex items-center justify-center h-full">
              <p className="text-muted-foreground">{t("pages.workflowDetail.selectWorkflow")}</p>
            </div>
          )}
        </div>

        {/* Persistent sidebar */}
        {sidebarVisible && workflowDetail.workflow?.workflow && (
          <WorkflowSidebar
            workflow={workflowDetail.workflow.workflow}
            selectedNode={selectedNode}
            incomingNodes={nodeConnections.incoming}
            outgoingNodes={nodeConnections.outgoing}
            onClearSelection={handleClearSelection}
            className="w-[340px] lg:w-[400px] shrink-0 hidden md:flex"
          />
        )}
      </div>

      {/* Share Dialog */}
      {workflowIdentifier && (
        <ShareDialog
          open={shareDialogOpen}
          onClose={() => setShareDialogOpen(false)}
          workflowId={workflowIdentifier}
        />
      )}

      {/* Delete Confirm Dialog */}
      <ConfirmDialog
        open={deleteDialogOpen}
        onOpenChange={setDeleteDialogOpen}
        title={t("pages.workflowDetail.deleteWorkflow")}
        description={t("pages.workflowDetail.confirmDelete")}
        confirmLabel={t("common.delete")}
        variant="destructive"
        onConfirm={handleDeleteWorkflow}
      />
    </div>
  );
};
