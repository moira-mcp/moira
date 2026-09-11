/**
 * Run page — one execution shown as a process.
 *
 * The page keeps the inspector's contract (props injected by the user and admin wrappers, the
 * compact toolbar, context editing, errors, steps, locks) and puts the run in front: the modes
 * (lanes by default, canvas, outline, route) fill the viewport on the left, a panel on the right
 * carries the selected block's detail, the run's variables with the runtime adjustments, and the
 * inspector's tabs. Everything about the run comes from the server's projection; the page never
 * derives block statuses or the route itself. State is deep-linkable: `view`, `block`, `at`,
 * `guide`. A workflow without a process view falls back to the technical node graph.
 */

import React, { useState, useEffect, useCallback, useMemo, Suspense, useRef } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { apiClient } from "../../services/api-client";
import { ContextVariableEditor } from "./ContextVariableEditor";
import type { WorkflowGraph as WorkflowGraphType } from "../../types";
import type { ExecutionProgress } from "@mcp-moira/workflow-engine/progress-visual";
import {
  ExecutionErrorHistory,
  type ExecutionErrorEntry,
  ErrorCountBadge,
} from "./ExecutionErrorHistory";
import {
  ArrowLeft,
  RefreshCw,
  FileJson,
  Play,
  AlertTriangle,
  Check,
  Compass,
  Loader2,
  Maximize2,
  ListChecks,
  Lock,
  Unlock,
  Boxes,
  Variable,
  Workflow,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Card } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { MODES, resolveMode, type RunViewMode } from "../run/modes";
import { LanesView } from "../run/LanesView";
import { CanvasView } from "../run/CanvasView";
import { OutlineView } from "../run/OutlineView";
import { RouteView } from "../run/RouteView";
import { BlockDetailPanel } from "../run/BlockDetailPanel";
import { VariablesPanel } from "../run/VariablesPanel";
import { RunCursor } from "../run/RunCursor";
import { StatusLegend } from "../run/status";
import { Walkthrough, type PanelTab } from "../run/Walkthrough";
import { currentBlockId, runBlocks, waitingStep, type RunViewProps } from "../run/model";
import { clampCursor } from "../run/route";

// Lazy load the technical graph (with its focus wrapper) for better initial page load
const WorkflowGraphWithFocus = React.lazy(() =>
  import("../workflow/WorkflowGraphWithFocus").then((module) => ({
    default: module.WorkflowGraphWithFocus,
  })),
);

const VIEW_PARAM = "view";
const BLOCK_PARAM = "block";
const AT_PARAM = "at";
const GUIDE_PARAM = "guide";

const MODE_COMPONENTS: Record<RunViewMode, React.ComponentType<RunViewProps>> = {
  lanes: LanesView,
  canvas: CanvasView,
  outline: OutlineView,
  route: RouteView,
};

// Base execution data - common fields
export interface ExecutionData {
  executionId: string;
  workflowId: string;
  workflowName?: string | null; // Issue #421: Resolved from workflow table
  userId: string;
  status: string;
  currentNodeId: string | null;
  waitingForInputNodeId: string | null;
  revision: number;
  /** Target-specific revisions of the detail response; the context one guards per-path saves. */
  metadataRevisions?: { parent: string; context: string; reminders: string };
  context: {
    variables: Record<string, unknown>;
    nodeStates: Record<string, unknown>;
  };
  createdAt?: number;
  updatedAt?: number;
  error?: string;
  errors?: ExecutionErrorEntry[];
  // Optional owner info (available in admin view)
  userEmail?: string;
  userName?: string | null;
}

export interface ExecutionInspectorProps {
  executionId: string;
  // Services injected from outside
  fetchExecution: (id: string) => Promise<ExecutionData>;
  /** When true, context variables are editable (per-path save via the API). */
  editable?: boolean;
  /**
   * When true, the page may answer the step the run waits for (the execution's owner, or an
   * administrator on the admin page). Defaults to `editable`.
   */
  canAnswer?: boolean;
  // UI configuration
  backRoute: string;
  showOwnerInfo?: boolean;
}

export const ExecutionInspector: React.FC<ExecutionInspectorProps> = ({
  executionId,
  fetchExecution,
  editable = false,
  canAnswer,
  backRoute,
  showOwnerInfo = false,
}) => {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const [searchParams, setSearchParams] = useSearchParams();

  const [execution, setExecution] = useState<ExecutionData | null>(null);
  const [workflow, setWorkflow] = useState<{
    workflow: WorkflowGraphType;
    validation?: {
      isValid: boolean;
      globalErrors: string[];
      globalWarnings: string[];
      nodeValidation: Record<string, { isValid: boolean; errors: string[]; warnings: string[] }>;
    };
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  /** The whole run's projection. */
  const [progress, setProgress] = useState<ExecutionProgress | null>(null);
  /** The projection at the route cursor, when one is set. */
  const [cursorProgress, setCursorProgress] = useState<ExecutionProgress | null>(null);
  const [progressError, setProgressError] = useState(false);
  const [progressLoading, setProgressLoading] = useState(false);
  const [editableVariableNames, setEditableVariableNames] = useState<ReadonlySet<string>>(
    new Set(),
  );
  const progressRequestRef = useRef(0);
  const cursorRequestRef = useRef(0);

  // Context editing state (per-variable save is handled inside ContextVariableEditor)
  const [contextFullscreen, setContextFullscreen] = useState(false);
  const [contextQuery, setContextQuery] = useState<string | undefined>(undefined);

  // Panel tab: the block detail once the run has a process view, the context otherwise.
  const [chosenTab, setChosenTab] = useState<PanelTab | null>(null);
  const activeTab: PanelTab = chosenTab ?? (progress ? "block" : "context");

  // Lock management state
  interface LockRecord {
    id: string;
    nodeId: string;
    reason: string;
    lockedBy: string;
    status: string;
    createdAt: string;
    unlockedAt: string | null;
  }
  const [locks, setLocks] = useState<LockRecord[]>([]);
  const [locksLoading, setLocksLoading] = useState(false);
  const [unlocking, setUnlocking] = useState<string | null>(null);
  const [lockDialogOpen, setLockDialogOpen] = useState(false);
  const [lockReason, setLockReason] = useState("");
  const [locking, setLocking] = useState(false);
  const [lockResult, setLockResult] = useState<{ lockId: string; pin: string } | null>(null);

  // Technical node graph focus: the node to bring into view once the graph is mounted.
  const [focusRequest, setFocusRequest] = useState<{ nodeId: string; token: number } | null>(null);

  // Copy to clipboard state
  const [copied, setCopied] = useState(false);

  const loadProgress = useCallback(async (id: string): Promise<void> => {
    const request = ++progressRequestRef.current;
    setProgressLoading(true);
    try {
      const next = await apiClient.getExecutionProgress(id);
      if (request === progressRequestRef.current) {
        setProgress(next);
        setProgressError(false);
      }
    } catch {
      if (request === progressRequestRef.current) {
        setProgress(null);
        setProgressError(true);
      }
    } finally {
      if (request === progressRequestRef.current) setProgressLoading(false);
    }
  }, []);

  // Extract error node IDs from errors array for graph highlighting
  const errorNodeIds = useMemo(() => {
    if (!execution?.errors) return [];
    const nodeIds = new Set(execution.errors.map((e) => e.nodeId));
    return Array.from(nodeIds);
  }, [execution?.errors]);

  const loadExecution = useCallback(
    async (isRefresh = false) => {
      try {
        if (isRefresh) {
          setRefreshing(true);
        } else {
          setLoading(true);
        }
        const execData = await fetchExecution(executionId);
        setExecution(execData);

        // Load workflow for visualization
        const [workflowData, variableAccess] = await Promise.all([
          apiClient.getWorkflow(execData.workflowId),
          editable ? apiClient.getExecutionVariables(execData.executionId) : Promise.resolve(null),
        ]);
        setWorkflow(workflowData);
        setEditableVariableNames(
          new Set(
            variableAccess?.variables
              .filter((variable) => variable.editable)
              .map((variable) => variable.name) ?? [],
          ),
        );
        setError(null);
        void loadProgress(execData.executionId);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : t("common.errors.failedToLoad");
        setError(message);
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [editable, executionId, fetchExecution, loadProgress, t],
  );

  useEffect(() => {
    loadExecution();
  }, [loadExecution]);

  const handleRefresh = useCallback(() => {
    loadExecution(true);
  }, [loadExecution]);

  // --- URL state: mode, selected block, cursor, guide.
  const mode = resolveMode(searchParams.get(VIEW_PARAM));
  const blocks = useMemo(() => (progress ? runBlocks(progress) : []), [progress]);
  const current = useMemo(() => currentBlockId(blocks), [blocks]);
  const blockParam = searchParams.get(BLOCK_PARAM);
  const selectedBlockId = blocks.some((b) => b.id === blockParam) ? blockParam : null;
  const shownBlockId = selectedBlockId ?? current ?? blocks[0]?.id ?? null;
  const cursor = useMemo(
    () => (progress ? clampCursor(searchParams.get(AT_PARAM), progress.route) : null),
    [progress, searchParams],
  );
  const guideStep = Number(searchParams.get(GUIDE_PARAM)) || 0;

  const update = useCallback(
    (patch: Record<string, string | null>) => {
      // Radix tabs report a value on focus and again on click, both before React re-renders, so
      // the hook's `searchParams` is stale for the second call. Compare against the live URL:
      // a duplicate navigation would push a second history entry and make Back appear inert.
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

  // The projection at the cursor comes from the server too; the whole run stays loaded for the
  // scrubber's range and for the modes once the cursor is cleared.
  useEffect(() => {
    if (!execution || cursor === null) {
      setCursorProgress(null);
      return;
    }
    const request = ++cursorRequestRef.current;
    void apiClient
      .getExecutionProgress(execution.executionId, cursor)
      .then((next) => {
        if (request === cursorRequestRef.current) setCursorProgress(next);
      })
      .catch(() => {
        if (request === cursorRequestRef.current) setCursorProgress(null);
      });
  }, [execution, cursor, progress]);

  const shownProgress = cursor !== null && cursorProgress ? cursorProgress : progress;
  const shownBlocks = useMemo(
    () => (shownProgress ? runBlocks(shownProgress) : []),
    [shownProgress],
  );
  const shownBlock = shownBlocks.find((b) => b.id === shownBlockId) ?? null;

  // Load locks for both admin and user views
  const loadLocks = useCallback(async () => {
    setLocksLoading(true);
    try {
      const data = showOwnerInfo
        ? await apiClient.getExecutionLocks(executionId)
        : await apiClient.getUserExecutionLocks(executionId);
      setLocks(data.locks);
    } catch {
      setLocks([]);
    } finally {
      setLocksLoading(false);
    }
  }, [executionId, showOwnerInfo]);

  useEffect(() => {
    if (activeTab === "locks") {
      loadLocks();
    }
  }, [activeTab, loadLocks]);

  const handleAdminUnlock = useCallback(
    async (lockId: string) => {
      setUnlocking(lockId);
      try {
        await apiClient.adminUnlockExecution(executionId, lockId);
        await loadLocks();
        await loadExecution(true);
      } catch {
        // Error handled by api client
      } finally {
        setUnlocking(null);
      }
    },
    [executionId, loadLocks, loadExecution],
  );

  const handleOwnerUnlock = useCallback(
    async (lockId: string) => {
      setUnlocking(lockId);
      try {
        await apiClient.ownerUnlockExecution(executionId, lockId);
        await loadLocks();
        await loadExecution(true);
      } catch {
        // Error handled by api client
      } finally {
        setUnlocking(null);
      }
    },
    [executionId, loadLocks, loadExecution],
  );

  const handleCreateLock = useCallback(async () => {
    if (!lockReason.trim()) return;
    setLocking(true);
    try {
      const result = await apiClient.createLock(executionId, lockReason.trim());
      setLockResult({ lockId: result.lockId, pin: result.pin });
      setLockReason("");
      await loadExecution(true);
      if (activeTab === "locks") {
        await loadLocks();
      }
    } catch {
      // Error handled by api client
    } finally {
      setLocking(false);
    }
  }, [executionId, lockReason, loadExecution, loadLocks, activeTab]);

  const handleNodeClick = useCallback((_event: React.MouseEvent, _node: { id: string }) => {
    // Node details are shown via NodeDetailSheet in WorkflowGraph
  }, []);

  /** Bring a node into view on the technical graph (the graph panel when a process view exists). */
  const focusNode = useCallback(
    (nodeId: string) => {
      if (progress) setChosenTab("graph");
      setFocusRequest((previous) => ({ nodeId, token: (previous?.token ?? 0) + 1 }));
    },
    [progress],
  );

  const handleCurrentNodeClick = useCallback(() => {
    if (execution?.currentNodeId) focusNode(execution.currentNodeId);
  }, [execution?.currentNodeId, focusNode]);

  const handleCopyExecutionId = useCallback(async () => {
    if (execution?.executionId) {
      await navigator.clipboard.writeText(execution.executionId);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  }, [execution?.executionId]);

  const canEdit = editable;
  const answerable = canAnswer ?? editable;

  // Per-path save: update a value at any nesting path without overwriting the rest of the
  // object or other variables. After a successful save, refresh ONLY the execution context
  // (not the workflow) to reflect authoritative server state, so a transient workflow-fetch
  // failure never tears down the editor while the save's PUT is still settling.
  const handleSavePath = useCallback(
    async (path: Array<string | number>, value: unknown): Promise<boolean> => {
      if (!editable || !execution || !execution.metadataRevisions) return false;
      const success = await apiClient.updateExecutionContextPath(
        execution.executionId,
        path,
        value,
        execution.revision,
        execution.metadataRevisions.context,
      );
      if (success) {
        try {
          const execData = await fetchExecution(execution.executionId);
          setExecution(execData);
          await loadProgress(execData.executionId);
        } catch {
          /* keep existing execution state; save already persisted */
        }
      }
      return success;
    },
    [editable, execution, fetchExecution, loadProgress],
  );

  /** Answer the waiting step; resolves to null on success or the server's refusal message. */
  const handleAnswer = useCallback(
    async (input: Record<string, unknown>): Promise<string | null> => {
      if (!execution) return t("pages.runPage.answer.notLoaded");
      let failure: string | null = null;
      try {
        await apiClient.answerExecutionStep(execution.executionId, input, execution.revision);
      } catch (caught) {
        failure = caught instanceof Error ? caught.message : String(caught);
      }
      // A rejected answer still ran a step (the rejection is logged on the execution and bumps
      // its revision), and a conflict means the run moved: reload either way so the next attempt
      // is written against the current revision.
      try {
        const execData = await fetchExecution(execution.executionId);
        setExecution(execData);
        await loadProgress(execData.executionId);
      } catch {
        /* keep the current state; the next refresh shows the server's */
      }
      return failure;
    },
    [execution, fetchExecution, loadProgress, t],
  );

  const handleEditVariable = useCallback((name: string) => {
    setContextQuery(name);
    setChosenTab("context");
  }, []);

  const waiting = useMemo(
    () =>
      execution &&
      execution.status === "running" &&
      execution.waitingForInputNodeId &&
      execution.waitingForInputNodeId === execution.currentNodeId
        ? waitingStep(workflow?.workflow, execution.waitingForInputNodeId)
        : null,
    [execution, workflow],
  );
  const waitingBlockName = useMemo(
    () => blocks.find((b) => b.nodeIds.includes(waiting?.id ?? ""))?.name ?? null,
    [blocks, waiting],
  );

  const onPanel = useCallback((tab: PanelTab) => setChosenTab(tab), []);

  const getCurrentNode = () => {
    if (!execution?.currentNodeId || !workflow?.workflow?.nodes) return null;
    return workflow.workflow.nodes.find((n) => n.id === execution.currentNodeId);
  };

  const currentNode = getCurrentNode();

  const getStatusBadgeVariant = (
    status: string,
  ): "default" | "secondary" | "destructive" | "outline" => {
    switch (status) {
      case "completed":
        return "default";
      case "failed":
        return "destructive";
      case "waiting":
      case "running":
        return "secondary";
      case "locked":
        return "outline";
      default:
        return "outline";
    }
  };

  const getStatusIcon = (status: string) => {
    switch (status) {
      case "running":
      case "waiting":
        return <Play className="h-3 w-3" />;
      case "failed":
        return <AlertTriangle className="h-3 w-3" />;
      case "locked":
        return <Lock className="h-3 w-3" />;
      default:
        return null;
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-muted-foreground">{t("pages.executionInspector.loading")}</div>
      </div>
    );
  }

  if (error || !execution || !workflow) {
    return (
      <div className="p-8">
        <div className="text-destructive mb-4">
          {error || t("pages.executionInspector.notFound")}
        </div>
        <Button onClick={() => navigate(backRoute)} variant="outline">
          <ArrowLeft className="h-4 w-4 mr-2" />
          {t("pages.executionInspector.back")}
        </Button>
      </div>
    );
  }

  const errorsCount = execution.errors?.length ?? 0;
  const ModeView = MODE_COMPONENTS[mode];
  const technicalGraph = (
    <Suspense
      fallback={
        <div className="flex items-center justify-center h-full bg-muted/20">
          <div className="text-muted-foreground">{t("components.workflowGraph.loading")}</div>
        </div>
      }
    >
      <WorkflowGraphWithFocus
        workflow={workflow.workflow}
        validation={workflow.validation}
        currentNodeId={execution.currentNodeId}
        errorNodeIds={errorNodeIds}
        onNodeClick={handleNodeClick}
        showControls={true}
        showMinimap={false}
        showNodeDetails={true}
        focusRequest={focusRequest}
      />
    </Suspense>
  );

  return (
    <div className="h-full flex flex-col" data-testid="run-page">
      {/* Compact Toolbar - 1 line */}
      <div className="border-b bg-card px-4 py-2 flex items-center gap-3">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="sm" onClick={() => navigate(backRoute)}>
              <ArrowLeft className="h-4 w-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{t("pages.executionInspector.backToExecutions")}</TooltipContent>
        </Tooltip>

        <div className="flex items-center gap-1.5">
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={handleCopyExecutionId}
                className="font-mono text-sm text-muted-foreground hover:text-foreground transition-colors"
              >
                {execution.executionId.substring(0, 8)}
              </button>
            </TooltipTrigger>
            <TooltipContent>
              {copied
                ? t("pages.executionInspector.toolbar.copied")
                : t("pages.executionInspector.toolbar.copyId")}
            </TooltipContent>
          </Tooltip>
          {copied && <Check className="h-3 w-3 text-chart-2" />}
        </div>

        <span className="text-muted-foreground">•</span>

        <Tooltip>
          <TooltipTrigger asChild>
            <span className="text-sm font-medium truncate max-w-[200px] cursor-default">
              {execution.workflowName || execution.workflowId.substring(0, 8) + "..."}
            </span>
          </TooltipTrigger>
          <TooltipContent>{execution.workflowName || execution.workflowId}</TooltipContent>
        </Tooltip>

        <Badge variant={getStatusBadgeVariant(execution.status)} className="gap-1">
          {getStatusIcon(execution.status)}
          {t(`common.status.${execution.status}`)}
        </Badge>

        {currentNode && (
          <>
            <span className="text-muted-foreground hidden sm:inline">•</span>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  onClick={handleCurrentNodeClick}
                  className="hidden sm:flex items-center gap-1.5 px-2 py-1 rounded-md bg-primary/10 hover:bg-primary/20 transition-colors"
                >
                  <Play className="h-3 w-3 text-primary" />
                  <span className="text-sm font-medium text-primary truncate max-w-[150px]">
                    {currentNode.metadata?.displayName || currentNode.id}
                  </span>
                </button>
              </TooltipTrigger>
              <TooltipContent>{t("pages.executionInspector.toolbar.focusNode")}</TooltipContent>
            </Tooltip>
          </>
        )}

        <div className="flex-1" />

        {showOwnerInfo && (execution.userEmail || execution.userName) && (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="text-xs text-muted-foreground truncate max-w-[150px]">
                {execution.userName || execution.userEmail}
              </span>
            </TooltipTrigger>
            <TooltipContent>
              {t("pages.executionInspector.owner")}: {execution.userName || execution.userEmail}
              {execution.userName && execution.userEmail && ` (${execution.userEmail})`}
            </TooltipContent>
          </Tooltip>
        )}

        <div className="flex items-center gap-1">
          {!showOwnerInfo && execution.status === "running" && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setLockDialogOpen(true)}
                  className="text-yellow-600 hover:text-yellow-700 border-yellow-500/50"
                >
                  <Lock className="h-4 w-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                {t("pages.executionInspector.toolbar.lock", "Lock Execution")}
              </TooltipContent>
            </Tooltip>
          )}

          {activeTab === "context" && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setContextFullscreen(true)}
                  data-testid="context-fullscreen-button"
                >
                  <Maximize2 className="h-4 w-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{t("pages.executionInspector.toolbar.fullscreen")}</TooltipContent>
            </Tooltip>
          )}

          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="outline" size="sm" onClick={handleRefresh} disabled={refreshing}>
                <RefreshCw className={`h-4 w-4 ${refreshing ? "animate-spin" : ""}`} />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t("pages.executionInspector.toolbar.refresh")}</TooltipContent>
          </Tooltip>

          {errorsCount > 0 && <ErrorCountBadge count={errorsCount} />}
        </div>
      </div>

      {!progress && progressLoading ? (
        <div
          className="border-b bg-muted/20 px-4 py-3 text-xs text-muted-foreground"
          role="status"
          data-testid="execution-progress-loading"
        >
          {t("pages.executionInspector.progress.loading")}
        </div>
      ) : !progress && progressError ? (
        <div className="border-b bg-destructive/5 px-4 py-2 text-xs text-destructive" role="status">
          {t("pages.executionInspector.progress.error")}
        </div>
      ) : null}

      {/* Main content: the run on the left, the panel on the right (stacked on a phone). */}
      <div className="flex-1 min-h-0 flex flex-col lg:flex-row overflow-hidden">
        <section
          className="flex-1 min-w-0 min-h-0 flex flex-col overflow-hidden"
          data-view={progress ? mode : "graph"}
          {...(progress ? { "data-testid": "execution-progress" } : {})}
          aria-label={t("pages.runPage.title")}
        >
          {progress && shownProgress ? (
            <>
              <div
                className="border-b bg-card px-3 py-1.5 flex flex-wrap items-center gap-2"
                data-testid="run-header"
              >
                <Tabs value={mode} onValueChange={(value) => update({ [VIEW_PARAM]: value })}>
                  <TabsList
                    aria-label={t("pages.runPage.modeLabel")}
                    className="h-8"
                    data-testid="run-modes"
                  >
                    {MODES.map((definition) => {
                      const Icon = definition.icon;
                      return (
                        <TabsTrigger
                          key={definition.id}
                          value={definition.id}
                          data-mode={definition.id}
                          className="gap-1 text-xs"
                        >
                          <Icon className="h-3.5 w-3.5" aria-hidden="true" />
                          {t(`pages.runPage.modes.${definition.id}`)}
                        </TabsTrigger>
                      );
                    })}
                  </TabsList>
                </Tabs>
                {progress.routeRecorded && (
                  <RunCursor
                    route={progress.route}
                    cursor={cursor}
                    onSetCursor={(at) => update({ [AT_PARAM]: at === null ? null : String(at) })}
                  />
                )}
                <div className="flex-1" />
                <StatusLegend className="hidden xl:flex" />
                <button
                  type="button"
                  onClick={() => update({ [GUIDE_PARAM]: "1" })}
                  className="inline-flex items-center gap-1.5 rounded-lg border bg-primary/5 px-2.5 py-1 text-xs font-medium text-primary hover:bg-primary/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  data-testid="guide-open"
                >
                  <Compass className="size-3.5" aria-hidden="true" />
                  {t("pages.runPage.guide.open")}
                </button>
              </div>
              <div className="flex-1 min-h-0">
                <ModeView
                  progress={shownProgress}
                  blocks={shownBlocks}
                  route={progress.route}
                  workflow={workflow.workflow}
                  selectedBlockId={selectedBlockId}
                  onSelectBlock={(id) => {
                    update({ [BLOCK_PARAM]: id });
                    if (id && chosenTab !== null && chosenTab !== "block") setChosenTab("block");
                  }}
                  cursor={cursor}
                  onSetCursor={(at) => update({ [AT_PARAM]: at === null ? null : String(at) })}
                />
              </div>
            </>
          ) : (
            <div className="flex-1 min-h-0">{technicalGraph}</div>
          )}
        </section>

        {/* Right panel */}
        <aside
          className={cn(
            "flex flex-col bg-card overflow-hidden border-t lg:border-t-0 lg:border-l",
            "max-h-[38vh] lg:max-h-none lg:w-[400px] xl:w-[460px] shrink-0",
          )}
          data-testid="run-panel"
        >
          <Tabs
            value={activeTab}
            onValueChange={(value) => setChosenTab(value as PanelTab)}
            className="flex flex-col h-full"
          >
            <TabsList className="w-full justify-start overflow-x-auto rounded-none border-b bg-muted/30 px-2 h-10">
              {progress && (
                <TabsTrigger value="block" className="gap-1.5 text-xs">
                  <Boxes className="h-3.5 w-3.5" />
                  {t("pages.runPage.tabs.block")}
                </TabsTrigger>
              )}
              {progress && (
                <TabsTrigger value="variables" className="gap-1.5 text-xs">
                  <Variable className="h-3.5 w-3.5" />
                  {t("pages.runPage.tabs.variables")}
                  {answerable && waiting && (
                    <Badge
                      variant="secondary"
                      className="ml-1 h-5 px-1.5 text-[10px] bg-warning/20 text-warning-foreground"
                      data-testid="variables-waiting-badge"
                    >
                      !
                    </Badge>
                  )}
                </TabsTrigger>
              )}
              <TabsTrigger value="context" className="gap-1.5 text-xs">
                <FileJson className="h-3.5 w-3.5" />
                {t("pages.executionInspector.tabs.context")}
              </TabsTrigger>
              <TabsTrigger value="errors" className="gap-1.5 text-xs">
                <AlertTriangle className="h-3.5 w-3.5" />
                {t("pages.executionInspector.tabs.errors")}
                {errorsCount > 0 && (
                  <Badge variant="destructive" className="ml-1 h-5 px-1.5 text-[10px]">
                    {errorsCount}
                  </Badge>
                )}
              </TabsTrigger>
              <TabsTrigger value="steps" className="gap-1.5 text-xs">
                <ListChecks className="h-3.5 w-3.5" />
                {t("pages.executionInspector.tabs.steps")}
              </TabsTrigger>
              {progress && (
                <TabsTrigger value="graph" className="gap-1.5 text-xs">
                  <Workflow className="h-3.5 w-3.5" />
                  {t("pages.runPage.tabs.graph")}
                </TabsTrigger>
              )}
              <TabsTrigger value="locks" className="gap-1.5 text-xs">
                <Lock className="h-3.5 w-3.5" />
                {t("pages.executionInspector.tabs.locks")}
                {locks.some((l) => l.status === "active") && (
                  <Badge
                    variant="secondary"
                    className="ml-1 h-5 px-1.5 text-[10px] bg-yellow-500/20 text-yellow-600"
                  >
                    !
                  </Badge>
                )}
              </TabsTrigger>
            </TabsList>

            {progress && (
              <TabsContent value="block" className="flex-1 overflow-auto m-0">
                <BlockDetailPanel
                  block={shownBlock}
                  blocks={shownBlocks}
                  workflow={workflow.workflow}
                  onSelectBlock={(id) => update({ [BLOCK_PARAM]: id })}
                  onFocusNode={focusNode}
                />
              </TabsContent>
            )}

            {progress && shownProgress && (
              <TabsContent value="variables" className="flex-1 overflow-auto m-0">
                <VariablesPanel
                  progress={shownProgress}
                  cursor={cursor}
                  waiting={waiting}
                  waitingBlockName={waitingBlockName}
                  canAdjust={answerable}
                  editableVariableNames={editableVariableNames}
                  onAnswer={handleAnswer}
                  onEditVariable={handleEditVariable}
                />
              </TabsContent>
            )}

            <TabsContent value="context" className="flex-1 flex flex-col overflow-hidden m-0">
              <div className="flex-1 overflow-auto p-3">
                <ContextVariableEditor
                  variables={execution?.context?.variables || {}}
                  workflow={workflow?.workflow}
                  onSavePath={canEdit ? handleSavePath : undefined}
                  editableRootNames={editableVariableNames}
                  initialQuery={contextQuery}
                />
              </div>
            </TabsContent>

            <TabsContent value="errors" className="flex-1 overflow-auto m-0 p-4">
              <ExecutionErrorHistory errors={execution.errors ?? []} />
            </TabsContent>

            <TabsContent value="steps" className="flex-1 overflow-auto m-0 p-4">
              <StepProgression
                workflow={workflow.workflow}
                currentNodeId={execution.currentNodeId}
                nodeStates={execution.context?.nodeStates}
                onNodeClick={focusNode}
              />
            </TabsContent>

            {progress && (
              <TabsContent value="graph" className="flex-1 overflow-hidden m-0">
                <div className="h-full min-h-[320px]">{technicalGraph}</div>
              </TabsContent>
            )}

            <TabsContent value="locks" className="flex-1 overflow-auto m-0 p-4">
              {locksLoading ? (
                <div className="flex items-center justify-center py-8">
                  <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                </div>
              ) : locks.length === 0 ? (
                <div className="text-center py-8 text-muted-foreground text-sm">
                  {t("pages.executionInspector.locks.noHistory")}
                </div>
              ) : (
                <div className="space-y-3">
                  {locks.map((lock) => (
                    <Card key={lock.id} className="p-3">
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex items-center gap-2 min-w-0">
                          {lock.status === "active" ? (
                            <Lock className="h-4 w-4 text-yellow-500 flex-shrink-0" />
                          ) : (
                            <Unlock className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                          )}
                          <div className="min-w-0">
                            <div className="text-sm font-medium truncate">{lock.reason}</div>
                            <div className="text-xs text-muted-foreground">
                              {t("pages.executionInspector.locks.node")}{" "}
                              <code className="text-[10px]">{lock.nodeId}</code>
                            </div>
                          </div>
                        </div>
                        <div className="flex items-center gap-2 flex-shrink-0">
                          <Badge
                            variant={lock.status === "active" ? "default" : "secondary"}
                            className={
                              lock.status === "active"
                                ? "bg-yellow-500/20 text-yellow-600 border-yellow-500/30"
                                : ""
                            }
                          >
                            {lock.status}
                          </Badge>
                          {lock.status === "active" && (
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() =>
                                showOwnerInfo
                                  ? handleAdminUnlock(lock.id)
                                  : handleOwnerUnlock(lock.id)
                              }
                              disabled={unlocking === lock.id}
                              className="h-7 text-xs"
                            >
                              {unlocking === lock.id ? (
                                <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                              ) : (
                                <Unlock className="h-3 w-3 mr-1" />
                              )}
                              {t("pages.executionInspector.locks.unlock")}
                            </Button>
                          )}
                        </div>
                      </div>
                      <div className="mt-2 flex gap-4 text-[10px] text-muted-foreground">
                        <span>
                          {t("pages.executionInspector.locks.created")}{" "}
                          {new Date(lock.createdAt).toLocaleString()}
                        </span>
                        {lock.unlockedAt && (
                          <span>
                            {t("pages.executionInspector.locks.unlocked")}{" "}
                            {new Date(lock.unlockedAt).toLocaleString()}
                          </span>
                        )}
                      </div>
                    </Card>
                  ))}
                </div>
              )}
            </TabsContent>
          </Tabs>
        </aside>
      </div>

      {/* Context Fullscreen Modal */}
      <Dialog open={contextFullscreen} onOpenChange={setContextFullscreen}>
        <DialogContent className="w-[90vw] max-w-5xl min-w-[800px] max-h-[90vh] flex flex-col p-0 gap-0 overflow-hidden">
          <DialogHeader className="px-6 py-4 border-b bg-muted/30">
            <DialogTitle className="flex items-center gap-3">
              <div className="p-2 rounded-md bg-primary/10">
                <FileJson className="h-5 w-5 text-primary" />
              </div>
              <div className="flex flex-col gap-1">
                <span>{t("pages.executionInspector.context.title")}</span>
                <span className="text-xs font-normal text-muted-foreground">
                  {execution.workflowName || execution.workflowId} •{" "}
                  {execution.executionId.substring(0, 8)}
                </span>
              </div>
            </DialogTitle>
          </DialogHeader>

          <div className="flex-1 overflow-auto p-4 bg-background">
            <ContextVariableEditor
              variables={execution?.context?.variables || {}}
              workflow={workflow?.workflow}
              onSavePath={canEdit ? handleSavePath : undefined}
              editableRootNames={editableVariableNames}
            />
          </div>
        </DialogContent>
      </Dialog>
      {/* Lock creation dialog */}
      <Dialog
        open={lockDialogOpen}
        onOpenChange={(open) => {
          if (!open) {
            setLockDialogOpen(false);
            setLockReason("");
            setLockResult(null);
          }
        }}
      >
        <DialogContent className="sm:max-w-[425px]">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Lock className="h-5 w-5 text-yellow-600" />
              {lockResult
                ? t("pages.executionInspector.lockDialog.success", "Execution Locked")
                : t("pages.executionInspector.lockDialog.title", "Lock Execution")}
            </DialogTitle>
          </DialogHeader>

          {lockResult ? (
            <div className="space-y-4 py-2">
              <p className="text-sm text-muted-foreground">
                {t(
                  "pages.executionInspector.lockDialog.successMessage",
                  "Execution has been locked. Share the PIN with the agent to unlock.",
                )}
              </p>
              <div className="p-3 bg-muted rounded-md text-center">
                <div className="text-xs text-muted-foreground mb-1">PIN</div>
                <div className="font-mono text-2xl font-bold tracking-widest">{lockResult.pin}</div>
              </div>
              <DialogFooter>
                <Button
                  onClick={() => {
                    setLockDialogOpen(false);
                    setLockResult(null);
                  }}
                >
                  {t("common.close", "Close")}
                </Button>
              </DialogFooter>
            </div>
          ) : (
            <div className="space-y-4 py-2">
              <p className="text-sm text-muted-foreground">
                {t(
                  "pages.executionInspector.lockDialog.description",
                  "Locking will pause the execution. Provide a reason for locking.",
                )}
              </p>
              <Input
                placeholder={t(
                  "pages.executionInspector.lockDialog.reasonPlaceholder",
                  "Reason for locking...",
                )}
                value={lockReason}
                onChange={(e) => setLockReason(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && lockReason.trim()) {
                    handleCreateLock();
                  }
                }}
                autoFocus
              />
              <DialogFooter>
                <Button variant="outline" onClick={() => setLockDialogOpen(false)}>
                  {t("common.cancel", "Cancel")}
                </Button>
                <Button
                  onClick={handleCreateLock}
                  disabled={!lockReason.trim() || locking}
                  className="bg-yellow-600 hover:bg-yellow-700 text-white"
                >
                  {locking && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                  <Lock className="h-4 w-4 mr-2" />
                  {t("pages.executionInspector.lockDialog.confirm", "Lock")}
                </Button>
              </DialogFooter>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {progress && (
        <Walkthrough
          step={guideStep}
          mode={mode}
          currentBlockId={current}
          routeRecorded={progress.routeRecorded}
          onNavigate={update}
          onPanel={onPanel}
        />
      )}
    </div>
  );
};

/**
 * Step Progression component — shows workflow nodes as a step list
 * with current/completed/pending states
 */
interface StepProgressionProps {
  workflow: WorkflowGraphType;
  currentNodeId: string | null;
  nodeStates?: Record<string, unknown>;
  onNodeClick: (nodeId: string) => void;
}

const StepProgression: React.FC<StepProgressionProps> = ({
  workflow,
  currentNodeId,
  nodeStates,
  onNodeClick,
}) => {
  const { t } = useTranslation();

  if (!workflow?.nodes?.length) {
    return (
      <div className="text-sm text-muted-foreground text-center py-8">
        {t("pages.executionInspector.steps.noSteps")}
      </div>
    );
  }

  const getNodeStatus = (nodeId: string): "completed" | "current" | "pending" => {
    if (nodeId === currentNodeId) return "current";
    if (nodeStates && nodeId in nodeStates) return "completed";
    return "pending";
  };

  return (
    <div className="space-y-1">
      {workflow.nodes.map((node, index) => {
        const status = getNodeStatus(node.id);
        const label = node.metadata?.displayName || node.id;
        const nodeType = node.type || "action";

        return (
          <button
            key={node.id}
            onClick={() => onNodeClick(node.id)}
            className={`w-full flex items-center gap-3 px-3 py-2 rounded-md text-left transition-colors hover:bg-muted/50 ${
              status === "current" ? "bg-primary/10 border border-primary/20" : ""
            }`}
          >
            <div
              className={`flex-shrink-0 w-6 h-6 rounded-full flex items-center justify-center text-xs font-medium ${
                status === "completed"
                  ? "bg-chart-2/20 text-chart-2"
                  : status === "current"
                    ? "bg-primary/20 text-primary"
                    : "bg-muted text-muted-foreground"
              }`}
            >
              {status === "completed" ? <Check className="h-3.5 w-3.5" /> : index + 1}
            </div>

            <div className="flex-1 min-w-0">
              <div
                className={`text-sm truncate ${
                  status === "current"
                    ? "font-medium text-primary"
                    : status === "completed"
                      ? "text-foreground"
                      : "text-muted-foreground"
                }`}
              >
                {label}
              </div>
              <div className="text-[10px] text-muted-foreground">{nodeType}</div>
            </div>

            {status === "current" && (
              <Badge variant="secondary" className="text-[10px] h-5">
                {t("pages.executionInspector.steps.current")}
              </Badge>
            )}
          </button>
        );
      })}
    </div>
  );
};
