/**
 * Flow page — one workflow shown as the process it declares, at /workflows/:id and
 * /workflows/:handle/:slug.
 *
 * The definition's derived process (from the server for the saved definition, re-derived in the
 * browser while there are unsaved edits) is shown through the run page's modes with no run in
 * them — outline by default, canvas, lanes — plus the split mode (blocks against their steps) and
 * the technical node graph with its controls and node details. The right panel carries the
 * selected block's detail and the variable registry. Owners can turn on edit mode: block names and
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
  ArrowLeft,
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
import { WorkflowSidebar } from "../components/workflow/WorkflowSidebar";
import WorkflowBreadcrumbComponent from "../components/workflow/WorkflowBreadcrumb";
import { ShareDialog } from "../components/workflow/ShareDialog";
import { ConfirmDialog } from "../components/confirm-dialog";
import { PageLoader } from "../components/page-loader";
import { DiagramSkeleton } from "../components/route-skeleton";
import { InlineError } from "../components/inline-error";
import { useWorkflowApp } from "../hooks/useWorkflowData";
import { useResource } from "../hooks/useResource";
import { useSession } from "../auth/better-auth-client";
import { apiClient, ApiClientError } from "../services/api-client";
import { ROUTES } from "../constants/routes";
import type { WorkflowGraph } from "../types/workflow-types";
import { LanesView } from "../components/run/LanesView";
import { CanvasView } from "../components/run/CanvasView";
import { OutlineView } from "../components/run/OutlineView";
import { BlockDetailPanel } from "../components/run/BlockDetailPanel";
import { GuidanceCallout, GuidanceHint } from "../components/run/Guidance";
import { Walkthrough, type GuideStep } from "../components/run/Walkthrough";
import { runBlocks, type RunViewProps } from "../components/run/model";
import { SplitView } from "../components/flow/SplitView";
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

const TechnicalGraph = React.lazy(() =>
  import("../components/workflow/WorkflowGraph").then((module) => ({
    default: module.WorkflowGraph,
  })),
);

const VIEW_PARAM = "view";
const BLOCK_PARAM = "block";
const GUIDE_PARAM = "guide";
const EDIT_PARAM = "edit";

type FlowPanelTab = "block" | "variables";

const MODE_COMPONENTS: Record<Exclude<FlowViewMode, "graph">, React.ComponentType<RunViewProps>> = {
  outline: OutlineView,
  canvas: CanvasView,
  lanes: LanesView,
  split: SplitView,
};

const EVERY_MODE = (selector: string): Partial<Record<FlowViewMode, string>> => ({
  outline: selector,
  canvas: selector,
  lanes: selector,
  split: selector,
  graph: selector,
});

/** The flow page's walkthrough: block, step, evidence, loop, editing, explore. */
export function flowGuideSteps(isOwner: boolean): GuideStep<FlowViewMode, FlowPanelTab>[] {
  return [
    {
      id: "process",
      targets: {
        outline: "section[data-block-id]",
        canvas: "[data-block-id]",
        lanes: "[data-lane-index]",
        split: '[data-testid="split-blocks"] [data-block-id]',
      },
      fallbackView: "outline",
    },
    {
      id: "agent",
      targets: { split: '[data-testid="split-nodes"] [data-node-id]' },
      fallbackView: "split",
    },
    {
      id: "evidence",
      targets: { split: '[data-testid="split-nodes"] [data-node-inputs]' },
      fallbackView: "split",
    },
    {
      id: "loop",
      targets: {
        outline: '[data-transition-kind="cycle"]',
        canvas: "[data-return-chip]",
        lanes: "[data-return-chip]",
      },
      fallbackView: "outline",
    },
    {
      id: "edit",
      targets: EVERY_MODE(
        isOwner ? '[data-testid="flow-edit-toggle"]' : '[data-testid="flow-header"]',
      ),
      fallbackView: "outline",
    },
    { id: "explore", targets: EVERY_MODE('[data-testid="flow-modes"]'), fallbackView: "outline" },
  ];
}

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
  const [nodeConnections, setNodeConnections] = useState<{
    incoming: Array<{ id: string; label: string }>;
    outgoing: Array<{ id: string; label: string; connectionType: string }>;
  }>({ incoming: [], outgoing: [] });
  const [focusRequest, setFocusRequest] = useState<{ nodeId: string; token: number } | null>(null);
  const [chosenTab, setChosenTab] = useState<FlowPanelTab>("block");
  const [edits, setEdits] = useFlowEdits();
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const workflowIdentifier = handle && slug ? `${handle}/${slug}` : id;

  useEffect(() => {
    if (workflowIdentifier) selectWorkflow(workflowIdentifier);
  }, [workflowIdentifier, selectWorkflow]);

  const detail = workflowDetail.workflow;
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
  const blocks = useMemo(() => (progress ? runBlocks(progress) : []), [progress]);

  const requestedMode = resolveFlowMode(searchParams.get(VIEW_PARAM));
  const mode: FlowViewMode = process ? requestedMode : "graph";
  const blockParam = searchParams.get(BLOCK_PARAM);
  const selectedBlockId = blocks.some((b) => b.id === blockParam) ? blockParam : null;
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
      setFocusRequest((previous) => ({ nodeId, token: (previous?.token ?? 0) + 1 }));
    },
    [update],
  );

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
  const onPanel = useCallback((tab: FlowPanelTab) => setChosenTab(tab), []);

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
            onWorkflowNavigate={handleNavigate}
            onNodeSelect={handleNodeSelect}
            showNodeDetails={false}
            showControls={true}
            showMinimap={true}
            focusRequest={focusRequest}
          />
        </Suspense>
      </div>
      <WorkflowSidebar
        workflow={edited}
        selectedNode={selectedNode}
        incomingNodes={nodeConnections.incoming}
        outgoingNodes={nodeConnections.outgoing}
        onClearSelection={handleClearSelection}
        className="w-[340px] lg:w-[400px] shrink-0 hidden md:flex"
      />
    </div>
  );

  const ModeView = mode === "graph" ? null : MODE_COMPONENTS[mode];

  return (
    <EditingProvider
      enabled={editing}
      definition
      edits={edits}
      diagnostics={process?.diagnostics ?? []}
      onChange={onEditsChange}
    >
      <div className="h-full flex flex-col" data-testid="flow-page" data-view={mode}>
        {/* Toolbar */}
        <div className="border-b border-border p-2 flex justify-between items-center gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <Button variant="ghost" size="sm" onClick={handleBack} className="gap-1.5 shrink-0">
              <ArrowLeft className="w-4 h-4" />
              <span className="hidden sm:inline">{t("pages.workflowDetail.backToWorkflows")}</span>
            </Button>
            {savedWorkflow && (
              <span className="truncate text-sm font-medium" data-testid="flow-title">
                {savedWorkflow.metadata.name}
                <span className="ml-1.5 text-xs text-muted-foreground">
                  v{savedWorkflow.metadata.version}
                </span>
              </span>
            )}
          </div>

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
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={t("common.actions", { defaultValue: "Actions" })}
                >
                  <MoreHorizontal className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {isOwner && process && (
                  <DropdownMenuItem onClick={() => update({ [EDIT_PARAM]: editing ? null : "1" })}>
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
          <div className="flex-1 min-h-0 flex flex-col lg:flex-row overflow-hidden">
            <section
              className="flex-1 min-w-0 min-h-0 flex flex-col overflow-hidden"
              aria-label={t("pages.flowPage.title")}
              data-testid="flow-view"
            >
              {process && (
                <div
                  className="border-b bg-card px-3 py-1.5 flex flex-wrap items-center gap-2"
                  data-testid="flow-header"
                >
                  <Tabs value={mode} onValueChange={(value) => update({ [VIEW_PARAM]: value })}>
                    <TabsList
                      aria-label={t("pages.runPage.modeLabel")}
                      className="h-8"
                      data-testid="flow-modes"
                    >
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
                  <div className="flex-1" />
                  {refetching && <PendingIndicator />}
                  <button
                    type="button"
                    onClick={() => update({ [GUIDE_PARAM]: "1" })}
                    className="inline-flex items-center gap-1.5 rounded-lg border bg-primary/5 px-2.5 py-1 text-xs font-medium text-primary hover:bg-primary/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    data-testid="guide-open"
                  >
                    <Compass className="size-3.5" aria-hidden="true" />
                    {t("pages.flowPage.guide.open")}
                  </button>
                </div>
              )}

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
                  className="space-y-2 border-b border-warning/50 bg-warning/5 px-3 py-2"
                  data-testid="flow-edit-panel"
                >
                  <GuidanceCallout
                    title={t("pages.flowPage.edit.guideTitle")}
                    testId="guidance-edit"
                    className="border-warning/40 bg-transparent"
                  >
                    {t("pages.flowPage.edit.guideBody")}
                  </GuidanceCallout>
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

              <div className="flex-1 min-h-0">
                {ModeView && progress ? (
                  <ModeView
                    progress={progress}
                    blocks={blocks}
                    route={[]}
                    workflow={edited}
                    selectedBlockId={selectedBlockId}
                    onSelectBlock={(blockId) => {
                      update({ [BLOCK_PARAM]: blockId });
                      if (blockId) setChosenTab("block");
                    }}
                    cursor={null}
                    onSetCursor={() => {}}
                  />
                ) : (
                  technicalGraph
                )}
              </div>
            </section>

            {process && mode !== "graph" && (
              <aside
                className={cn(
                  "flex flex-col bg-card overflow-hidden border-t lg:border-t-0 lg:border-l",
                  "max-h-[38vh] lg:max-h-none lg:w-[380px] xl:w-[440px] shrink-0",
                )}
                data-testid="flow-panel"
              >
                <Tabs
                  value={chosenTab}
                  onValueChange={(value) => setChosenTab(value as FlowPanelTab)}
                  className="flex flex-col h-full"
                >
                  <TabsList className="w-full justify-start rounded-none border-b bg-muted/30 px-2 h-10">
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
                    <BlockDetailPanel
                      block={shownBlock}
                      blocks={blocks}
                      workflow={edited}
                      onSelectBlock={(blockId) => update({ [BLOCK_PARAM]: blockId })}
                      onFocusNode={focusNode}
                    />
                  </TabsContent>
                  <TabsContent
                    value="variables"
                    className="scrollbar-thin flex-1 overflow-auto m-0"
                  >
                    <RegistryPanel registry={edited.variableRegistry} />
                  </TabsContent>
                </Tabs>
              </aside>
            )}
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
