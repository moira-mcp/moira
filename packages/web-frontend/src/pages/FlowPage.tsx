/**
 * Flow page — one workflow shown as the process it declares, at /workflows/:id and
 * /workflows/:handle/:slug.
 *
 * The definition's derived process (from the server for the saved definition, re-derived in the
 * browser while there are unsaved edits) is shown through the run page's two views with no run in
 * them: the map (the process as a diagram with its contents sidebar) and the technical node graph
 * with its controls and node details. Both stay mounted once shown. The right panel carries the
 * selected block's detail — its narrative, the steps that implement it, and how long the block
 * typically takes over the viewer's completed runs of this version — and the variable registry.
 * Owners can turn on edit mode: block names and
 * descriptions, transition labels and loop explanations, which block a step belongs to, a step's
 * directive, message or expressions, and the registry are edited in place; the views re-derive at
 * once, the derivation's diagnostics appear inline, the export lists the flow-file entries that
 * would change, and the save sends the whole definition against the revision the page loaded.
 * A stale revision or an invalid graph is refused by the server and the edits stay on the page.
 * State is deep-linkable: `view`, `block`, `guide`, `edit`. A workflow without a process view
 * shows the node graph only.
 */

import React, { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import {
  AlertTriangle,
  Boxes,
  Compass,
  Copy,
  Globe,
  Loader2,
  Lock,
  MoreHorizontal,
  PencilLine,
  RotateCcw,
  Save,
  Share2,
  Trash2,
  Users,
  Variable,
} from "lucide-react";
import type { Node } from "@xyflow/react";
import { toast } from "sonner";
import { deriveProcess, type ProcessProjection } from "@mcp-moira/workflow-engine/process";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import WorkflowBreadcrumbComponent from "../components/workflow/WorkflowBreadcrumb";
import { ShareDialog } from "../components/workflow/ShareDialog";
import { ConfirmDialog } from "../components/confirm-dialog";
import { PageLoader } from "../components/page-loader";
import { PageHeader } from "../components/diagram/PageHeader";
import {
  ContentsLayout,
  ContentsToggleProvider,
  ContentsToggleSlot,
} from "../components/run/ContentsSidebar";

import { DiagramSkeleton } from "../components/route-skeleton";
import { InlineError } from "../components/inline-error";
import { useWorkflowApp } from "../hooks/useWorkflowData";
import { useResource } from "../hooks/useResource";
import { useSession } from "../auth/better-auth-client";
import { apiClient, ApiClientError } from "../services/api-client";
import type { WorkflowVersionStatistics } from "@mcp-moira/workflow-engine/progress-visual";
import { VisibilityToggle } from "../components/access/VisibilityToggle";
import { ROUTES } from "../constants/routes";
import type { WorkflowGraph } from "../types/workflow-types";
import { MapView } from "../components/run/MapView";
import { BlockDetailPanel } from "../components/run/BlockDetailPanel";
import { NodePanel } from "../components/run/NodePanel";
import { useNodeTypes } from "../hooks/useNodeTypes";
import { useStoredFlag } from "../components/diagram/useStoredFlag";
import { useRequest } from "../components/diagram/useRequest";
import { PanelRightClose, PanelRightOpen } from "lucide-react";
import { GuidanceHint } from "../components/run/Guidance";
import { Walkthrough } from "../components/run/Walkthrough";
import { DiagramGuide } from "../components/run/DiagramGuide";
import { flowGuideSteps, type FlowPanelTab } from "../components/flow/guideSteps";
import { runBlocks } from "../components/run/model";
import { RegistryPanel } from "../components/flow/RegistryPanel";
import { FLOW_MODES, resolveFlowMode, type FlowViewMode } from "../components/flow/modes";
import { definitionProgress } from "../components/flow/model";
import {
  EMPTY_EDITS,
  EditingProvider,
  applyEdits,
  countEdits,
  exportDiff,
  useFlowEdits,
} from "../components/flow/editing";

// Lazy chunk, requested on mount so the first switch to the graph view downloads nothing.
const importWorkflowGraph = () => import("../components/workflow/WorkflowGraph");
const TechnicalGraph = React.lazy(() =>
  importWorkflowGraph().then((module) => ({
    default: module.WorkflowGraph,
  })),
);

const VIEW_PARAM = "view";
const BLOCK_PARAM = "block";
const GUIDE_PARAM = "guide";
const EDIT_PARAM = "edit";

/** The slim pending state of a refetch: the content stays, this says a refresh is running. */
function PendingIndicator(): React.JSX.Element {
  const { t } = useTranslation();
  return (
    <span
      className="inline-flex items-center gap-1 text-xs text-muted-foreground"
      role="status"
      data-testid="flow-pending"
    >
      <Loader2 className="size-3 animate-spin" aria-hidden="true" />
      {t("pages.flowPage.refreshing")}
    </span>
  );
}

export const FlowPage: React.FC = () => {
  const { id, handle, slug } = useParams<{ id?: string; handle?: string; slug?: string }>();
  const navigate = useNavigate();
  const { t } = useTranslation();
  const { data: session } = useSession();
  const [searchParams, setSearchParams] = useSearchParams();
  const { breadcrumbs, selectWorkflow, clearBreadcrumbs, workflowDetail } = useWorkflowApp();

  const [visibilityUpdating, setVisibilityUpdating] = useState(false);
  const [copying, setCopying] = useState(false);
  const [shareDialogOpen, setShareDialogOpen] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [selectedNode, setSelectedNode] = useState<Node | null>(null);
  const [focusRequest, requestFocus] = useRequest<{ nodeId: string }>();
  const [chosenTab, setChosenTab] = useState<FlowPanelTab>("block");
  const [panelCollapsed, togglePanel] = useStoredFlag("moira.flow.panelCollapsed");
  const [variableHighlight, requestVariableHighlight] = useRequest<{ name: string }>();
  const goToVariable = useCallback(
    (name: string) => {
      setChosenTab("variables");
      requestVariableHighlight({ name });
    },
    [requestVariableHighlight],
  );
  const [edits, setEdits] = useFlowEdits();
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const workflowIdentifier = handle && slug ? `${handle}/${slug}` : id;

  useEffect(() => {
    if (workflowIdentifier) selectWorkflow(workflowIdentifier);
  }, [workflowIdentifier, selectWorkflow]);

  // Fetch the graph's chunk right away, so the first switch to the graph view shows no skeleton.
  useEffect(() => {
    void importWorkflowGraph();
  }, []);

  const detail = workflowDetail.workflow;
  const { index: nodeTypeIndex } = useNodeTypes();
  const fileInfo = detail?.fileInfo;
  const savedWorkflow = detail?.workflow;
  const isOwner = fileInfo?.accessType === "owner";

  // The saved definition's process comes from the server, held per workflow: a new revision of
  // the same workflow refreshes it while the previous projection stays on screen; a move to
  // another workflow (breadcrumbs, a subgraph link) fetches afresh and shows nothing of the old one.
  const workflowId = fileInfo?.id;
  const revision = fileInfo?.revision;
  const savedProcess = useResource<ProcessProjection | null>(workflowId ?? null, () =>
    workflowId
      ? apiClient.getWorkflowProcess(workflowId).then((r) => r.process)
      : Promise.resolve(null),
  );
  const refreshProcess = savedProcess.refresh;
  const seenRef = useRef<{ id: string; revision: number } | null>(null);
  useEffect(() => {
    if (!workflowId || revision === undefined) return;
    const seen = seenRef.current;
    seenRef.current = { id: workflowId, revision };
    if (seen && seen.id === workflowId && seen.revision !== revision) void refreshProcess();
  }, [workflowId, revision, refreshProcess]);
  const heldProcess = savedProcess.dataKey === workflowId ? savedProcess.data : undefined;

  // A refetch that fails while the page has content keeps the content and says so once.
  const detailError = workflowDetail.error;
  useEffect(() => {
    if (detailError && savedWorkflow) toast.error(detailError);
  }, [detailError, savedWorkflow]);

  // --- URL state
  const editing = isOwner && searchParams.get(EDIT_PARAM) === "1";
  const guideStep = Number(searchParams.get(GUIDE_PARAM)) || 0;
  const update = useCallback(
    (patch: Record<string, string | null>) => {
      const live = new URLSearchParams(window.location.search);
      const next = new URLSearchParams(live);
      for (const [key, value] of Object.entries(patch)) {
        if (value === null || value === undefined) next.delete(key);
        else next.set(key, value);
      }
      if (next.toString() === live.toString()) return;
      setSearchParams(next);
    },
    [setSearchParams],
  );

  // --- The definition as edited, its process and the run-less projection.
  const edited = useMemo(
    () => (savedWorkflow ? applyEdits(savedWorkflow, edits) : undefined),
    [savedWorkflow, edits],
  );
  // The count shown (and what enables Save) is the number of flow-file entries that actually
  // change; an edit typed back to the stored value is not a change.
  const diff = useMemo(
    () => (savedWorkflow ? exportDiff(savedWorkflow, edits) : []),
    [savedWorkflow, edits],
  );
  const editCount = diff.length;
  const hasEdits = countEdits(edits) > 0;
  const process = useMemo<ProcessProjection | null>(() => {
    if (!edited) return null;
    if (hasEdits) return deriveProcess(edited as unknown as Parameters<typeof deriveProcess>[0]);
    return heldProcess ?? null;
  }, [edited, hasEdits, heldProcess]);
  // Before the first projection of this workflow the page has nothing to show yet; a refetch for
  // a new revision keeps the previous projection and only marks the page pending.
  const processLoading = !hasEdits && heldProcess === undefined && savedProcess.pending;
  const refetching =
    (workflowDetail.pending && !workflowDetail.loading) ||
    (savedProcess.pending && heldProcess !== undefined);
  const progress = useMemo(
    () => (edited && process ? definitionProgress(edited, process) : null),
    [edited, process],
  );
  // Typical durations of the saved version, over the viewer's own completed runs. They are held
  // per workflow and version; a workflow nobody has finished yet simply has an empty sample.
  const version = savedWorkflow?.metadata.version;
  const statisticsResource = useResource<WorkflowVersionStatistics | null>(
    workflowId && version ? `${workflowId}@${version}` : null,
    () =>
      workflowId ? apiClient.getWorkflowStatistics(workflowId, version) : Promise.resolve(null),
  );
  const statistics = statisticsResource.data ?? null;
  const blocks = useMemo(
    () => (progress ? runBlocks(progress, statistics) : []),
    [progress, statistics],
  );

  const requestedMode = resolveFlowMode(searchParams.get(VIEW_PARAM));
  const mode: FlowViewMode = process ? requestedMode : "graph";
  // A view is rendered from the first time it is asked for and never unmounted again.
  const blockParam = searchParams.get(BLOCK_PARAM);
  const selectedBlockId = blocks.some((b) => b.id === blockParam) ? blockParam : null;
  // Opening the graph with a block selected brings that block's first step into view, even when
  // the selection was made while the graph was hidden (a hidden viewport cannot be fitted).
  useEffect(() => {
    if (mode !== "graph" || !selectedBlockId) return;
    const block = blocks.find((b) => b.id === selectedBlockId);
    const first = block?.nodeIds[0];
    if (!first) return;
    // A focus already aimed at a step of this block (a step row in the panel) wins over the
    // block's first step: that request opened the graph, so it must not be overwritten here.
    if (focusRequest && block?.nodeIds.includes(focusRequest.nodeId)) return;
    requestFocus({ nodeId: first });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only the tab change re-focuses
  }, [mode]);
  const shownBlock = blocks.find((b) => b.id === (selectedBlockId ?? blocks[0]?.id)) ?? null;

  const guideSteps = useMemo(() => flowGuideSteps(isOwner), [isOwner]);

  // --- Actions
  const handleBack = () => {
    clearBreadcrumbs();
    navigate(ROUTES.WORKFLOWS);
  };
  const handleNavigate = (workflowId: string) => navigate(`${ROUTES.WORKFLOWS}/${workflowId}`);

  const handleDeleteWorkflow = useCallback(async () => {
    if (!workflowIdentifier) return;
    try {
      await apiClient.deleteWorkflow(workflowIdentifier);
      navigate(ROUTES.WORKFLOWS);
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : t("common.errors.failedToDelete"));
    }
  }, [workflowIdentifier, navigate, t]);

  const handleToggleVisibility = useCallback(async () => {
    if (!workflowIdentifier || !fileInfo) return;
    const newVisibility = fileInfo.visibility === "public" ? "private" : "public";
    setVisibilityUpdating(true);
    try {
      await apiClient.updateWorkflowVisibility(workflowIdentifier, newVisibility);
      workflowDetail.refreshWorkflow();
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : t("common.errors.failedToUpdate"));
    } finally {
      setVisibilityUpdating(false);
    }
  }, [workflowIdentifier, fileInfo, workflowDetail, t]);

  const handleCopyWorkflow = useCallback(async () => {
    if (!workflowIdentifier) return;
    setCopying(true);
    try {
      const result = await apiClient.copyWorkflow(workflowIdentifier);
      navigate(`${ROUTES.WORKFLOWS}/${result.workflowId}`);
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : t("common.errors.failedToCreate"));
    } finally {
      setCopying(false);
    }
  }, [workflowIdentifier, navigate, t]);

  const handleSave = useCallback(async () => {
    if (!fileInfo || !edited) return;
    setSaving(true);
    setSaveError(null);
    try {
      const result = await apiClient.updateWorkflow(fileInfo.id, edited, fileInfo.revision);
      setEdits(EMPTY_EDITS);
      toast.success(t("pages.flowPage.edit.saved", { revision: result.revision }));
      workflowDetail.refreshWorkflow();
    } catch (err: unknown) {
      const message =
        err instanceof ApiClientError && err.status === 409
          ? t("pages.flowPage.edit.conflict")
          : err instanceof Error
            ? err.message
            : t("common.errors.failedToUpdate");
      setSaveError(message);
      toast.error(message);
    } finally {
      setSaving(false);
    }
  }, [fileInfo, edited, setEdits, workflowDetail, t]);

  const onEditsChange = useCallback(
    (next: Parameters<typeof setEdits>[0]) => {
      setSaveError(null);
      setEdits(next);
    },
    [setEdits],
  );

  const focusNode = useCallback(
    (nodeId: string) => {
      update({ [VIEW_PARAM]: "graph" });
      requestFocus({ nodeId });
    },
    [update, requestFocus],
  );

  const handleNodeSelect = useCallback(
    (
      node: Node | null,
      _connections: {
        incoming: Array<{ id: string; label: string }>;
        outgoing: Array<{ id: string; label: string; connectionType: string }>;
      },
    ) => {
      setSelectedNode(node);
      if (node) {
        const owner = blocks.find((b) => b.nodeIds.includes(node.id));
        if (owner) update({ [BLOCK_PARAM]: owner.id });
        setChosenTab("block");
      }
    },
    [blocks, update],
  );
  const handleClearSelection = useCallback(() => {
    setSelectedNode(null);
  }, []);
  const onPanel = useCallback((tab: FlowPanelTab) => setChosenTab(tab), []);
  // A panel section the walkthrough asked to unfold so its step has something to point at.
  const [sectionOpen, requestSection] = useRequest<{ name: string }>();
  const onSection = useCallback((id: string) => requestSection({ name: id }), [requestSection]);

  // --- Render
  const ownerActions = (
    <>
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
        <VisibilityToggle
          visibility={fileInfo.visibility === "public" ? "public" : "private"}
          onChange={handleToggleVisibility}
          disabled={visibilityUpdating}
          testId="workflow-visibility-toggle"
        />
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
    </>
  );

  const flowModes = process ? (
    <Tabs value={mode} onValueChange={(value) => update({ [VIEW_PARAM]: value })}>
      <TabsList aria-label={t("pages.runPage.modeLabel")} className="h-8" data-testid="flow-modes">
        {FLOW_MODES.map((definition) => {
          const Icon = definition.icon;
          return (
            <TabsTrigger
              key={definition.id}
              value={definition.id}
              data-mode={definition.id}
              className="gap-1 text-xs"
            >
              <Icon className="h-3.5 w-3.5" aria-hidden="true" />
              {t(`pages.flowPage.modes.${definition.id}`)}
            </TabsTrigger>
          );
        })}
      </TabsList>
    </Tabs>
  ) : null;
  const flowTrailing = (
    <>
      {refetching && <PendingIndicator />}
      <button
        type="button"
        onClick={() => update({ [GUIDE_PARAM]: "1" })}
        data-hint={t("pages.flowPage.guide.open")}
        aria-label={t("pages.flowPage.guide.open")}
        className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-transparent text-primary hover:border-border hover:bg-primary/10"
        data-testid="guide-open"
      >
        <Compass className="size-4" aria-hidden="true" />
      </button>
    </>
  );
  const technicalGraph = savedWorkflow && edited && (
    <div className="flex h-full min-h-0">
      <div className="flex-1 min-w-0">
        <Suspense fallback={<DiagramSkeleton />}>
          <TechnicalGraph
            workflow={edited}
            validation={detail?.validation}
            blocks={blocks}
            selectedBlockId={selectedBlockId}
            onWorkflowNavigate={handleNavigate}
            onNodeSelect={handleNodeSelect}
            showNodeDetails={false}
            showControls={true}
            toolbarModes={flowModes}
            toolbarLeading={<ContentsToggleSlot />}
            toolbarTrailing={
              <>
                <DiagramGuide mode="graph" />
                {flowTrailing}
              </>
            }
            showMinimap
            focusRequest={focusRequest}
            selectedNodeId={focusRequest?.nodeId ?? null}
            onVariableSelect={goToVariable}
            selectedVariable={variableHighlight?.name ?? null}
          />
        </Suspense>
      </div>
    </div>
  );

  return (
    <EditingProvider
      enabled={editing}
      definition
      edits={edits}
      diagnostics={process?.diagnostics ?? []}
      onChange={onEditsChange}
    >
      <div className="h-full flex flex-col" data-testid="flow-page" data-view={mode}>
        <PageHeader
          back={{
            label: t("pages.workflowDetail.backToWorkflows"),
            onClick: handleBack,
            testId: "flow-back",
          }}
          title={
            savedWorkflow ? (
              <span data-testid="flow-title">{savedWorkflow.metadata.name}</span>
            ) : null
          }
          meta={savedWorkflow ? `v${savedWorkflow.metadata.version}` : undefined}
          description={savedWorkflow?.metadata.description}
          facts={
            savedWorkflow ? (
              <>
                {(savedWorkflow.metadata.tags ?? []).map((tag) => (
                  <span
                    key={tag}
                    className="rounded-full border bg-muted/40 px-2 py-0.5 text-[11px] text-muted-foreground"
                    data-testid="flow-tag"
                  >
                    {tag}
                  </span>
                ))}
                <span
                  className="rounded-full border bg-muted/40 px-2 py-0.5 text-[11px] tabular-nums text-muted-foreground"
                  data-testid="flow-node-count"
                >
                  {savedWorkflow.nodes.length} {t("components.workflowSidebar.totalNodes")}
                </span>
              </>
            ) : undefined
          }
          actions={
            <>
              <div className="hidden md:flex items-center gap-2">
                {isOwner && process && (
                  <>
                    <button
                      type="button"
                      onClick={() => update({ [EDIT_PARAM]: editing ? null : "1" })}
                      aria-pressed={editing}
                      className={cn(
                        "inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                        editing
                          ? "border-warning bg-warning/15 text-warning-foreground"
                          : "text-muted-foreground hover:text-foreground",
                      )}
                      data-testid="flow-edit-toggle"
                    >
                      <PencilLine className="size-3.5" aria-hidden="true" />
                      {t(editing ? "pages.flowPage.edit.on" : "pages.flowPage.edit.off")}
                    </button>
                    <GuidanceHint label={t("pages.flowPage.edit.hintLabel")}>
                      {t("pages.flowPage.edit.hint")}
                    </GuidanceHint>
                  </>
                )}
                {ownerActions}
              </div>

              <div className="md:hidden">
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="icon" aria-label={t("common.actions")}>
                      <MoreHorizontal className="h-4 w-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    {isOwner && process && (
                      <DropdownMenuItem
                        onClick={() => update({ [EDIT_PARAM]: editing ? null : "1" })}
                      >
                        <PencilLine className="mr-2 h-4 w-4" />
                        {t(editing ? "pages.flowPage.edit.on" : "pages.flowPage.edit.off")}
                      </DropdownMenuItem>
                    )}
                    {fileInfo?.visibility === "public" && session?.user && (
                      <DropdownMenuItem onClick={handleCopyWorkflow} disabled={copying}>
                        <Copy className="mr-2 h-4 w-4" />
                        {t("pages.workflowDetail.useAsTemplate")}
                      </DropdownMenuItem>
                    )}
                    {isOwner && fileInfo && (
                      <DropdownMenuItem
                        onClick={handleToggleVisibility}
                        disabled={visibilityUpdating}
                      >
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
            </>
          }
          testId="flow-header"
        />

        {breadcrumbs.length > 0 && (
          <WorkflowBreadcrumbComponent
            breadcrumbs={breadcrumbs}
            onNavigate={handleNavigate}
            onClear={clearBreadcrumbs}
          />
        )}

        {workflowDetail.loading || (workflowDetail.current && processLoading) ? (
          <PageLoader />
        ) : workflowDetail.error && !workflowDetail.current ? (
          <div className="flex items-center justify-center h-full">
            <InlineError
              message={workflowDetail.error}
              onRetry={() => workflowIdentifier && selectWorkflow(workflowIdentifier)}
            />
          </div>
        ) : !savedWorkflow || !edited ? (
          <div className="flex items-center justify-center h-full">
            <p className="text-muted-foreground">{t("pages.workflowDetail.selectWorkflow")}</p>
          </div>
        ) : (
          <div className="flex-1 min-h-0 flex flex-col lg:flex-row overflow-y-auto lg:overflow-hidden">
            <section
              className="flex min-w-0 flex-col lg:flex-1 lg:min-h-0 lg:overflow-hidden"
              aria-label={t("pages.flowPage.title")}
              data-testid="flow-view"
            >
              {!process && (
                <div
                  className="border-b bg-muted/20 px-4 py-2 text-xs text-muted-foreground flex flex-wrap items-center gap-2"
                  data-testid="flow-no-process"
                >
                  <span className="flex-1">{t("pages.flowPage.noProcess")}</span>
                  {refetching && <PendingIndicator />}
                </div>
              )}

              {editing && process && (
                <div
                  className="space-y-1 border-b border-warning/50 bg-warning/5 px-3 py-1.5"
                  data-testid="flow-edit-panel"
                >
                  <div className="flex flex-wrap items-center gap-2 text-sm">
                    <span data-testid="flow-edit-count">
                      {t("pages.flowPage.edit.count", { count: editCount })}
                    </span>
                    <button
                      type="button"
                      onClick={() => onEditsChange(EMPTY_EDITS)}
                      disabled={!hasEdits}
                      className="inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs hover:bg-accent disabled:opacity-40"
                      data-testid="flow-edit-reset"
                    >
                      <RotateCcw className="size-3" aria-hidden="true" />
                      {t("pages.flowPage.edit.reset")}
                    </button>
                    <Button
                      size="sm"
                      onClick={handleSave}
                      disabled={editCount === 0 || saving || process.diagnostics.length > 0}
                      className="h-7 gap-1 text-xs"
                      data-testid="flow-edit-save"
                    >
                      {saving ? (
                        <Loader2 className="size-3 animate-spin" aria-hidden="true" />
                      ) : (
                        <Save className="size-3" aria-hidden="true" />
                      )}
                      {t("pages.flowPage.edit.save")}
                    </Button>
                    <span className="text-xs text-muted-foreground">
                      {t("pages.flowPage.edit.revision", { revision: fileInfo?.revision ?? 0 })}
                    </span>
                    {saveError && (
                      <span
                        className="basis-full text-xs text-destructive"
                        role="alert"
                        data-testid="flow-save-error"
                      >
                        {saveError}
                      </span>
                    )}
                  </div>
                  <Collapsible data-testid="flow-edit-export">
                    <CollapsibleTrigger className="inline-flex items-center gap-1.5 rounded-md px-1 text-sm text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                      {t("pages.flowPage.edit.export", { count: diff.length })}
                    </CollapsibleTrigger>
                    <CollapsibleContent>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {t("pages.flowPage.edit.exportHint")}
                      </p>
                      <ul className="scrollbar-thin mt-2 max-h-[30vh] space-y-1 overflow-auto font-mono text-[11px]">
                        {diff.map((entry) => (
                          <li
                            key={entry.path}
                            className="rounded-md bg-card p-2"
                            data-export-path={entry.path}
                          >
                            <p className="font-semibold">{entry.path}</p>
                            <p className="text-destructive">- {JSON.stringify(entry.before)}</p>
                            <p className="text-success">+ {JSON.stringify(entry.after)}</p>
                          </li>
                        ))}
                      </ul>
                    </CollapsibleContent>
                  </Collapsible>
                </div>
              )}

              {process && process.diagnostics.length > 0 && (
                <ul
                  className="border-b bg-destructive/5 px-4 py-2 text-xs text-destructive"
                  data-testid="flow-diagnostics"
                  aria-label={t("pages.flowPage.diagnostics")}
                >
                  {process.diagnostics.map((d, i) => (
                    <li key={i} className="flex gap-2">
                      <AlertTriangle className="mt-0.5 size-3 shrink-0" aria-hidden="true" />
                      <span>
                        <span className="font-mono">{d.code}</span>: {d.message}
                      </span>
                    </li>
                  ))}
                </ul>
              )}

              {/* Only the shown view is mounted: the selection lives in the URL and the graph
                  re-centres on its focus request, so a switch loses nothing. */}
              <div className="lg:flex-1 lg:min-h-0">
                {progress && mode === "map" && (
                  <div className="lg:h-full">
                    <MapView
                      toolbarModes={flowModes}
                      toolbarTrailing={flowTrailing}
                      onFocusNode={focusNode}
                      progress={progress}
                      blocks={blocks}
                      route={[]}
                      workflow={edited}
                      selectedBlockId={selectedBlockId}
                      onSelectBlock={(blockId) => {
                        update({ [BLOCK_PARAM]: blockId });
                        if (blockId) setChosenTab("block");
                        const first = blocks.find((b) => b.id === blockId)?.nodeIds[0];
                        if (first) requestFocus({ nodeId: first });
                      }}
                      cursor={null}
                      onSetCursor={() => {}}
                    />
                  </div>
                )}
                {progress && mode === "graph" && (
                  <ContentsLayout
                    blocks={blocks}
                    selectedBlockId={selectedBlockId}
                    onSelect={(id) => {
                      update({ [BLOCK_PARAM]: id });
                      setChosenTab("block");
                    }}
                    testId="graph-view"
                  >
                    {(toggle) => (
                      <ContentsToggleProvider value={toggle}>
                        <div className="h-[60vh] lg:h-full">{technicalGraph}</div>
                      </ContentsToggleProvider>
                    )}
                  </ContentsLayout>
                )}
                {!progress && <div className="h-[60vh] lg:h-full">{technicalGraph}</div>}
              </div>
            </section>

            {/* The panel is the only home of a node's details, so it exists without a process view
                too (its block level then shows the empty-state callout). */}
            {
              <aside
                className={cn(
                  "relative flex flex-col bg-card overflow-hidden border-t lg:border-t-0 lg:border-l",
                  "max-h-[38vh] lg:max-h-none shrink-0",
                  panelCollapsed ? "h-10 lg:h-auto lg:w-10" : "lg:w-[380px] xl:w-[440px]",
                )}
                data-testid="flow-panel"
                data-collapsed={panelCollapsed ? "true" : undefined}
              >
                {!panelCollapsed && (
                  <button
                    type="button"
                    onClick={togglePanel}
                    data-hint={t("pages.flowPage.panel.collapse")}
                    aria-label={t("pages.flowPage.panel.collapse")}
                    className="absolute right-1 top-1 z-10 inline-flex h-8 w-8 items-center justify-center rounded-md border bg-card/90 text-muted-foreground shadow-sm hover:bg-accent hover:text-foreground"
                    data-testid="flow-panel-collapse"
                  >
                    <PanelRightClose className="size-4" aria-hidden="true" />
                  </button>
                )}
                {panelCollapsed && (
                  <button
                    type="button"
                    onClick={togglePanel}
                    data-hint={t("pages.flowPage.panel.expand")}
                    aria-label={t("pages.flowPage.panel.expand")}
                    className="flex h-10 w-full items-center justify-center text-muted-foreground hover:bg-accent hover:text-foreground"
                    data-testid="flow-panel-expand"
                  >
                    <PanelRightOpen className="size-4" aria-hidden="true" />
                  </button>
                )}
                <div className={cn("flex min-h-0 flex-1 flex-col", panelCollapsed && "hidden")}>
                  <Tabs
                    value={chosenTab}
                    onValueChange={(value) => setChosenTab(value as FlowPanelTab)}
                    className="flex flex-col h-full"
                  >
                    <TabsList className="w-full justify-start rounded-none border-b bg-muted/30 pl-2 pr-10 h-10">
                      <TabsTrigger value="block" className="gap-1.5 text-xs">
                        <Boxes className="h-3.5 w-3.5" />
                        {t("pages.flowPage.tabs.block")}
                      </TabsTrigger>
                      <TabsTrigger value="variables" className="gap-1.5 text-xs">
                        <Variable className="h-3.5 w-3.5" />
                        {t("pages.flowPage.tabs.variables")}
                      </TabsTrigger>
                    </TabsList>
                    <TabsContent value="block" className="scrollbar-thin flex-1 overflow-auto m-0">
                      {selectedNode ? (
                        <NodePanel
                          workflow={edited}
                          blocks={blocks}
                          nodeId={selectedNode.id}
                          onBack={handleClearSelection}
                          onFocusNode={focusNode}
                          onSelectVariable={goToVariable}
                          validation={detail?.validation ?? null}
                          nodeTypes={nodeTypeIndex}
                        />
                      ) : (
                        <BlockDetailPanel
                          block={shownBlock}
                          blocks={blocks}
                          workflow={edited}
                          statistics={statistics}
                          statisticsPending={statisticsResource.pending}
                          statisticsError={statisticsResource.error}
                          onSelectBlock={(blockId) => {
                            handleClearSelection();
                            update({ [BLOCK_PARAM]: blockId });
                          }}
                          onFocusNode={focusNode}
                          openSection={sectionOpen}
                        />
                      )}
                    </TabsContent>
                    <TabsContent
                      value="variables"
                      className="scrollbar-thin flex-1 overflow-auto m-0"
                    >
                      <RegistryPanel
                        registry={edited.variableRegistry}
                        highlight={variableHighlight}
                      />
                    </TabsContent>
                  </Tabs>
                </div>
              </aside>
            }
          </div>
        )}

        {process && (
          <Walkthrough<FlowViewMode, FlowPanelTab>
            step={guideStep}
            mode={mode}
            currentBlockId={null}
            routeRecorded={false}
            onNavigate={update}
            onPanel={onPanel}
            steps={guideSteps}
            onSection={onSection}
            textKey="pages.flowPage.guide"
          />
        )}

        {workflowIdentifier && (
          <ShareDialog
            open={shareDialogOpen}
            onClose={() => setShareDialogOpen(false)}
            workflowId={workflowIdentifier}
          />
        )}
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
    </EditingProvider>
  );
};

export type { WorkflowGraph as FlowPageWorkflow };
