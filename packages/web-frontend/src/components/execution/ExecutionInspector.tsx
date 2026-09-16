/**
 * Run page — one execution shown as a process.
 *
 * The page keeps the inspector's contract (props injected by the user and admin wrappers, the
 * compact toolbar, context editing, errors, steps, locks) and puts the run in front: two views —
 * the map (the process as a diagram with its contents) and the technical node graph — fill the
 * viewport on the left, a panel on the right carries the selected block's detail, the run's
 * variables with the runtime adjustments, and the inspector's tabs. Both views stay mounted once
 * shown and are only hidden, so switching between them keeps the map's selection and the graph's
 * viewport; the graph's chunk is fetched on mount, before anything asks for it. Everything about
 * the run comes from the server's projection; the page never derives block statuses or the route
 * itself. State is deep-linkable: `view`, `block`, `at`, `guide`. A workflow without a process
 * view shows the technical node graph alone.
 */

import React, { useState, useEffect, useCallback, useMemo, Suspense, useRef } from "react";
import { toast } from "sonner";
import { useResource } from "../../hooks/useResource";
import { DiagramSkeleton } from "../route-skeleton";
import { TabBadge } from "../run/TabBadge";

/** One tab of the panel strip: content-sized, underline when active, never stretched. */
const TAB_CLASS = "h-8 flex-none gap-1.5 px-2 text-xs";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { apiClient } from "../../services/api-client";
import type { WorkflowGraph as WorkflowGraphType } from "../../types";
import {
  ExecutionErrorHistory,
  isRefusalEntry,
  type ExecutionErrorEntry,
  ErrorCountBadge,
} from "./ExecutionErrorHistory";
import {
  ArrowLeft,
  RefreshCw,
  Play,
  AlertTriangle,
  Check,
  Compass,
  Loader2,
  ListChecks,
  Lock,
  Unlock,
  Boxes,
  Variable,
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
import { MODES, resolveMode } from "../run/modes";
import { MapView } from "../run/MapView";
import { ContentsLayout } from "../run/ContentsSidebar";
import { PageHeader } from "../diagram/PageHeader";

/** The contents fold button, handed from the graph's layout into the graph's toolbar. */
const GraphContentsToggle = React.createContext<React.ReactNode>(null);
function GraphContentsToggleSlot(): React.JSX.Element {
  return <>{React.useContext(GraphContentsToggle)}</>;
}
import { BlockDetailPanel } from "../run/BlockDetailPanel";
import { NodePanel } from "../run/NodePanel";
import { useStoredFlag } from "../diagram/useStoredFlag";
import type { HighlightRequest } from "../diagram/useHighlightTarget";
import { PanelRightClose, PanelRightOpen } from "lucide-react";
import { RouteSummary } from "../run/RouteSummary";
import { nodeOwners } from "../run/model";
import { VariablesPanel } from "../run/VariablesPanel";
import { RunCursor } from "../run/RunCursor";
import { StatusLegend } from "../run/status";
import { Walkthrough, type PanelTab } from "../run/Walkthrough";
import { currentBlockId, runBlocks, stepsOf, waitingStep } from "../run/model";
import { StepCard, StepCardList } from "../run/StepCard";
import type { RunBlock, RunProgress } from "../run/model";
import { clampCursor } from "../run/route";

// The technical graph is a large chunk: it is loaded lazily, but requested as soon as the page
// mounts, so the first switch to the graph view has nothing to wait for.
const importWorkflowGraph = () => import("../workflow/WorkflowGraph");
const WorkflowGraph = React.lazy(() =>
  importWorkflowGraph().then((module) => ({
    default: module.WorkflowGraph,
  })),
);

const VIEW_PARAM = "view";
const BLOCK_PARAM = "block";
const AT_PARAM = "at";
const GUIDE_PARAM = "guide";

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
  /** The whole run's projection, with the version statistics the API attaches to it. */
  const [progress, setProgress] = useState<RunProgress | null>(null);
  /** The projection at the route cursor, when one is set. */
  const [cursorProgress, setCursorProgress] = useState<RunProgress | null>(null);
  const [progressError, setProgressError] = useState(false);
  const [progressLoading, setProgressLoading] = useState(false);
  const [editableVariableNames, setEditableVariableNames] = useState<ReadonlySet<string>>(
    new Set(),
  );
  const progressRequestRef = useRef(0);
  const cursorRequestRef = useRef(0);

  // The variables panel opened as a dialog (the same panel, more room).
  const [variablesFullscreen, setVariablesFullscreen] = useState(false);

  // Panel tab: the block detail once the run has a process view, the variables otherwise.
  const [chosenTab, setChosenTab] = useState<PanelTab | null>(null);
  const activeTab: PanelTab = chosenTab ?? (progress ? "block" : "variables");

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
  // The lock history is wanted once the tab has been opened; switching away and back refreshes it
  // behind the list already shown.
  const [locksWanted, setLocksWanted] = useState(false);
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
      // A failed refetch keeps the projection already on screen; only a first load has none.
      if (request === progressRequestRef.current) setProgressError(true);
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
        // A failed refresh keeps the run on screen and says so once; only a first load has
        // nothing to keep.
        if (isRefresh) toast.error(message);
        else setError(message);
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [editable, executionId, fetchExecution, loadProgress, t],
  );

  // The first load happens once per execution. `loadExecution` is recreated whenever one of its
  // inputs changes identity (a URL parameter, a callback), and re-running it on every such
  // change swapped the whole page for a loader — the "blink" on selecting a block.
  const loadExecutionRef = useRef(loadExecution);
  loadExecutionRef.current = loadExecution;
  useEffect(() => {
    void loadExecutionRef.current();
  }, [executionId]);

  // Fetch the graph's chunk while the run is loading, so the first switch to the graph view has
  // nothing to download and shows no skeleton.
  useEffect(() => {
    void importWorkflowGraph();
  }, []);

  const handleRefresh = useCallback(() => {
    loadExecution(true);
  }, [loadExecution]);

  // --- URL state: mode, selected block, cursor, guide.
  const mode = resolveMode(searchParams.get(VIEW_PARAM));
  const blocks = useMemo(
    () => (progress ? runBlocks(progress, progress.statistics) : []),
    [progress],
  );
  const current = useMemo(() => currentBlockId(blocks), [blocks]);
  const blockParam = searchParams.get(BLOCK_PARAM);
  const selectedBlockId = blocks.some((b) => b.id === blockParam) ? blockParam : null;
  const shownBlockId = selectedBlockId ?? current ?? blocks[0]?.id ?? null;
  const cursor = useMemo(
    () => (progress ? clampCursor(searchParams.get(AT_PARAM), progress.route) : null),
    [progress, searchParams],
  );
  const guideStep = Number(searchParams.get(GUIDE_PARAM)) || 0;
  // A view is rendered from the first time it is asked for and never unmounted again.

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
    () => (shownProgress ? runBlocks(shownProgress, shownProgress.statistics) : []),
    [shownProgress],
  );
  const shownBlock = shownBlocks.find((b) => b.id === shownBlockId) ?? null;
  // The step the shown projection is at (the cursor's projection ends at the cursor's visit).
  const shownCurrentNodeId =
    shownBlocks.find((b) => b.id === currentBlockId(shownBlocks))?.currentNodeId ??
    execution?.currentNodeId ??
    null;
  // The nodes the shown route has visited (the cursor's projection carries the route up to it).
  const visitedNodeIds = useMemo(
    () => new Set((shownProgress?.route ?? []).map((visit) => visit.nodeId)),
    [shownProgress],
  );
  const visitedNodeList = useMemo(() => [...visitedNodeIds], [visitedNodeIds]);

  // Lock history for both admin and user views, kept while a refetch is pending.
  const lockHistory = useResource<LockRecord[]>(
    locksWanted ? `${executionId}:${showOwnerInfo ? "admin" : "owner"}` : null,
    async () =>
      (showOwnerInfo
        ? await apiClient.getExecutionLocks(executionId)
        : await apiClient.getUserExecutionLocks(executionId)
      ).locks,
  );
  const locks = lockHistory.data ?? [];
  const locksLoading = lockHistory.data === undefined && lockHistory.pending;
  const loadLocks = lockHistory.refresh;
  const locksHeldRef = useRef(false);
  locksHeldRef.current = lockHistory.data !== undefined;
  useEffect(() => {
    if (activeTab !== "locks") return;
    setLocksWanted(true);
    if (locksHeldRef.current) void loadLocks();
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

  // A step clicked on the graph opens as the second level of the block panel: its block becomes
  // the selected block, the panel shows the step with a breadcrumb back to the block.
  const [panelNodeId, setPanelNodeId] = useState<string | null>(null);
  const [panelCollapsed, togglePanel] = useStoredFlag("moira.run.panelCollapsed");
  // A variable reference token was clicked: open the variables tab and mark the variable there.
  const [variableHighlight, setVariableHighlight] = useState<HighlightRequest | null>(null);
  // A list item clicked on a block card: the block panel opens its list section at that item.
  const [listHighlight, setListHighlight] = useState<HighlightRequest | null>(null);
  const selectListItem = useCallback(
    (blockId: string, index: number) => {
      update({ [BLOCK_PARAM]: blockId });
      setChosenTab("block");
      setListHighlight((previous) => ({ name: String(index), token: (previous?.token ?? 0) + 1 }));
    },
    [update],
  );
  const goToVariable = useCallback((name: string) => {
    setChosenTab("variables");
    setVariableHighlight((previous) => ({ name, token: (previous?.token ?? 0) + 1 }));
  }, []);
  const [legendOpen, setLegendOpen] = useState(false);
  const handleNodeClick = useCallback(
    (_event: React.MouseEvent, node: { id: string }) => {
      const owner = nodeOwners(blocks).get(node.id) ?? null;
      if (owner) update({ [BLOCK_PARAM]: owner });
      setPanelNodeId(node.id);
      setChosenTab("block");
    },
    [blocks, update],
  );
  // Selecting a block that does not own the shown step (contents, map) leaves the step level.
  useEffect(() => {
    setPanelNodeId((current) =>
      current && nodeOwners(blocks).get(current) !== selectedBlockId ? null : current,
    );
  }, [selectedBlockId, blocks]);

  // Opening the graph with a block selected brings that block's first step into view, even when
  // the selection was made while the graph was hidden (a hidden viewport cannot be fitted).
  useEffect(() => {
    if (mode !== "graph" || !selectedBlockId) return;
    const first = blocks.find((b) => b.id === selectedBlockId)?.nodeIds[0];
    if (!first) return;
    setFocusRequest((previous) => ({ nodeId: first, token: (previous?.token ?? 0) + 1 }));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only the tab change re-focuses
  }, [mode]);

  /** Bring a node into view on the technical graph: the page switches to the graph view for it. */
  const focusNode = useCallback(
    (nodeId: string) => {
      // The step's block becomes the selection, so the panel's node level survives the jump.
      const owner = nodeOwners(blocks).get(nodeId) ?? null;
      update({ [VIEW_PARAM]: "graph", ...(owner ? { [BLOCK_PARAM]: owner } : {}) });
      setFocusRequest((previous) => ({ nodeId, token: (previous?.token ?? 0) + 1 }));
      // The panel follows the jump to its node level.
      setPanelNodeId(nodeId);
      setChosenTab("block");
    },
    [update, blocks],
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

  // A page-wide loader only while there is nothing to show yet; a refresh keeps the page.
  if (loading && !execution) {
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

  // Only refusals are errors. A degradation says the step ran without behaviour text it names, so
  // it gets its own count instead of turning a healthy run red.
  const journal = execution.errors ?? [];
  const errorsCount = journal.filter(isRefusalEntry).length;
  const degradationsCount = journal.length - errorsCount;
  // The run's own controls live in the diagram toolbar with the map's and the graph's, so the
  // page has one row above the diagram: view tabs and route cursor first, legend and guide last.
  const runModes = progress ? (
    <Tabs value={mode} onValueChange={(value) => update({ [VIEW_PARAM]: value })}>
      <TabsList aria-label={t("pages.runPage.modeLabel")} className="h-8" data-testid="run-modes">
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
  ) : null;
  const runControls =
    progress && progress.routeRecorded ? (
      <div className="hidden shrink-0 lg:block">
        <RunCursor
          route={progress.route}
          cursor={cursor}
          onSetCursor={(at) => update({ [AT_PARAM]: at === null ? null : String(at) })}
        />
      </div>
    ) : null;
  const runTrailing = progress ? (
    <>
      <div className="relative">
        <button
          type="button"
          onClick={() => setLegendOpen((was) => !was)}
          aria-expanded={legendOpen}
          data-hint={t("pages.runPage.legend.title", { defaultValue: "Легенда статусов" })}
          aria-label={t("pages.runPage.legend.title", { defaultValue: "Легенда статусов" })}
          className={cn(
            "inline-flex h-8 w-8 items-center justify-center rounded-md border border-transparent text-muted-foreground hover:border-border hover:bg-accent hover:text-foreground",
            legendOpen && "border-primary/50 bg-primary/10 text-primary",
          )}
          data-testid="legend-open"
        >
          <ListChecks className="size-4" aria-hidden="true" />
        </button>
        {legendOpen && (
          <div className="absolute right-0 top-full z-20 mt-1 rounded-lg border bg-popover p-3 shadow-md">
            <StatusLegend
              waitingFor={shownProgress?.waitingFor ?? null}
              className="flex-col items-start gap-1"
            />
          </div>
        )}
      </div>
      <button
        type="button"
        onClick={() => update({ [GUIDE_PARAM]: "1" })}
        data-hint={t("pages.runPage.guide.open")}
        aria-label={t("pages.runPage.guide.open")}
        className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-transparent text-primary hover:border-border hover:bg-primary/10"
        data-testid="guide-open"
      >
        <Compass className="size-4" aria-hidden="true" />
      </button>
    </>
  ) : null;

  const graphContentsToggle = <GraphContentsToggleSlot />;
  const technicalGraph = (
    <Suspense fallback={<DiagramSkeleton />}>
      <WorkflowGraph
        workflow={workflow.workflow}
        validation={workflow.validation}
        blocks={blocks}
        currentNodeId={execution.currentNodeId}
        selectedBlockId={selectedBlockId}
        errorNodeIds={errorNodeIds}
        onNodeClick={handleNodeClick}
        showControls={true}
        showMinimap
        showNodeDetails={false}
        focusRequest={focusRequest}
        selectedNodeId={focusRequest?.nodeId ?? null}
        visitedNodeIds={visitedNodeList}
        onVariableSelect={goToVariable}
        selectedVariable={variableHighlight?.name ?? null}
        toolbarModes={runModes}
        toolbarLeading={
          <>
            {graphContentsToggle}
            {runControls}
          </>
        }
        toolbarTrailing={runTrailing}
      />
    </Suspense>
  );

  return (
    <div className="h-full flex flex-col" data-testid="run-page">
      {/* The header: what is being looked at, and the page's own actions. */}
      <PageHeader
        description={progress?.goal ?? progress?.taskTitle ?? undefined}
        testId="run-header"
      >
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

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                onClick={handleRefresh}
                disabled={refreshing}
                data-pending={refreshing || progressLoading ? "true" : undefined}
              >
                <RefreshCw
                  className={`h-4 w-4 ${refreshing || progressLoading ? "animate-spin" : ""}`}
                />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t("pages.executionInspector.toolbar.refresh")}</TooltipContent>
          </Tooltip>

          {errorsCount > 0 && <ErrorCountBadge count={errorsCount} />}
        </div>
      </PageHeader>

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

      {/* Main content: the run on the left, the panel on the right. On a phone the two stack into
          one scrolling column — the view keeps a readable height instead of being squeezed into
          what the panel leaves — and from `lg` the row fills the page and scrolls nowhere. */}
      <div className="flex-1 min-h-0 flex flex-col lg:flex-row overflow-y-auto lg:overflow-hidden">
        <section
          className="flex min-w-0 flex-col lg:flex-1 lg:min-h-0 lg:overflow-hidden"
          data-view={progress ? mode : "graph"}
          {...(progress ? { "data-testid": "execution-progress" } : {})}
          aria-label={t("pages.runPage.title")}
        >
          {progress && shownProgress ? (
            <>
              {/* Only the shown view is mounted: the selection lives in the URL and the graph
                  re-centres on its focus request, so nothing is lost, and one diagram means one
                  toolbar and one set of markers in the document. */}
              <div className="lg:flex-1 lg:min-h-0">
                {mode === "map" && (
                  <div className="lg:h-full">
                    <MapView
                      toolbarModes={runModes}
                      onFocusNode={focusNode}
                      onSelectListItem={selectListItem}
                      toolbarExtra={runControls}
                      toolbarTrailing={runTrailing}
                      progress={shownProgress}
                      blocks={shownBlocks}
                      route={progress.route}
                      workflow={workflow.workflow}
                      selectedBlockId={selectedBlockId}
                      onSelectBlock={(id) => {
                        update({ [BLOCK_PARAM]: id });
                        if (id && chosenTab !== null && chosenTab !== "block")
                          setChosenTab("block");
                        // The graph opens on the block's first step when the reader goes there.
                        const first = blocks.find((b) => b.id === id)?.nodeIds[0];
                        if (first)
                          setFocusRequest((previous) => ({
                            nodeId: first,
                            token: (previous?.token ?? 0) + 1,
                          }));
                      }}
                      cursor={cursor}
                      onSetCursor={(at) => update({ [AT_PARAM]: at === null ? null : String(at) })}
                    />
                  </div>
                )}
                {mode === "graph" && (
                  <ContentsLayout
                    blocks={shownBlocks}
                    selectedBlockId={selectedBlockId}
                    onSelect={(id) => {
                      update({ [BLOCK_PARAM]: id });
                      if (chosenTab !== null && chosenTab !== "block") setChosenTab("block");
                    }}
                    testId="graph-view"
                  >
                    {(toggle) => (
                      <GraphContentsToggle.Provider value={toggle}>
                        <div className="h-[60vh] lg:h-full">{technicalGraph}</div>
                      </GraphContentsToggle.Provider>
                    )}
                  </ContentsLayout>
                )}
              </div>
            </>
          ) : (
            <div className="h-[60vh] lg:h-full lg:flex-1 lg:min-h-0">{technicalGraph}</div>
          )}
        </section>

        {/* Right panel */}
        <aside
          className={cn(
            "relative flex flex-col bg-card overflow-hidden border-t lg:border-t-0 lg:border-l",
            "max-h-[38vh] lg:max-h-none shrink-0",
            panelCollapsed ? "h-10 lg:h-auto lg:w-10" : "lg:w-[400px] xl:w-[460px]",
          )}
          data-testid="run-panel"
          data-collapsed={panelCollapsed ? "true" : undefined}
        >
          {!panelCollapsed && (
            <button
              type="button"
              onClick={togglePanel}
              data-hint={t("pages.runPage.panel.collapse", { defaultValue: "Свернуть панель" })}
              aria-label={t("pages.runPage.panel.collapse", { defaultValue: "Свернуть панель" })}
              className="absolute right-1 top-1 z-10 inline-flex h-8 w-8 items-center justify-center rounded-md border bg-card/90 text-muted-foreground shadow-sm hover:bg-accent hover:text-foreground"
              data-testid="run-panel-collapse"
            >
              <PanelRightClose className="size-4" aria-hidden="true" />
            </button>
          )}
          {panelCollapsed && (
            <button
              type="button"
              onClick={togglePanel}
              data-hint={t("pages.runPage.panel.expand", { defaultValue: "Развернуть панель" })}
              aria-label={t("pages.runPage.panel.expand", { defaultValue: "Развернуть панель" })}
              className="flex h-10 w-full items-center justify-center text-muted-foreground hover:bg-accent hover:text-foreground"
              data-testid="run-panel-expand"
            >
              <PanelRightOpen className="size-4" aria-hidden="true" />
            </button>
          )}
          <div className={cn("flex min-h-0 flex-1 flex-col", panelCollapsed && "hidden")}>
            <Tabs
              value={activeTab}
              onValueChange={(value) => setChosenTab(value as PanelTab)}
              className="flex flex-col h-full"
            >
              {/* The panel strip: underline tabs that wrap on a narrow panel instead of scrolling;
                each tab says what it holds, and counters and warnings are one badge. The list's
                height must follow the wrapped rows (the tabs variant fixes it at one row, hence
                the important override), so the second row never paints over the content. */}
              <TabsList
                variant="line"
                className="!h-auto w-full flex-wrap justify-start gap-x-0 gap-y-1 rounded-none border-b bg-card py-1 pl-2 pr-10"
                data-testid="run-panel-tabs"
              >
                {progress && (
                  <TabsTrigger
                    value="block"
                    className={TAB_CLASS}
                    data-hint={t("pages.runPage.tabHints.block")}
                  >
                    <Boxes className="size-3.5" />
                    {t("pages.runPage.tabs.block")}
                  </TabsTrigger>
                )}
                <TabsTrigger
                  value="variables"
                  className={TAB_CLASS}
                  data-hint={t("pages.runPage.tabHints.variables")}
                >
                  <Variable className="size-3.5" />
                  {t("pages.runPage.tabs.variables")}
                  <TabBadge
                    warning={Boolean(answerable && waiting)}
                    tone="warning"
                    label={t("pages.runPage.tabHints.variablesWaiting")}
                    testId="variables-waiting-badge"
                  />
                </TabsTrigger>
                <TabsTrigger
                  value="errors"
                  className={TAB_CLASS}
                  data-hint={t("pages.runPage.tabHints.errors")}
                >
                  <AlertTriangle className="size-3.5" />
                  {t("pages.executionInspector.tabs.errors")}
                  <TabBadge
                    count={errorsCount}
                    tone="danger"
                    label={t("pages.runPage.tabHints.errorCount", { count: errorsCount })}
                    testId="errors-count-badge"
                  />
                  {degradationsCount > 0 && (
                    <TabBadge
                      count={degradationsCount}
                      tone="warning"
                      label={t("pages.runPage.tabHints.degradationCount", {
                        count: degradationsCount,
                      })}
                      testId="degradations-count-badge"
                    />
                  )}
                </TabsTrigger>
                <TabsTrigger
                  value="steps"
                  className={TAB_CLASS}
                  data-hint={t("pages.runPage.tabHints.steps")}
                >
                  <ListChecks className="size-3.5" />
                  {t("pages.executionInspector.tabs.steps")}
                </TabsTrigger>
                <TabsTrigger
                  value="locks"
                  className={TAB_CLASS}
                  data-hint={t("pages.runPage.tabHints.locks")}
                >
                  <Lock className="size-3.5" />
                  {t("pages.executionInspector.tabs.locks")}
                  <TabBadge
                    warning={locks.some((l) => l.status === "active")}
                    tone="warning"
                    label={t("pages.runPage.tabHints.lockActive")}
                    testId="locks-active-badge"
                  />
                </TabsTrigger>
              </TabsList>

              {progress && (
                <TabsContent value="block" className="scrollbar-thin flex-1 overflow-auto m-0">
                  <RouteSummary
                    route={progress.route}
                    workflow={workflow.workflow}
                    blocks={shownBlocks}
                  />
                  {panelNodeId && workflow.workflow ? (
                    <NodePanel
                      workflow={workflow.workflow}
                      blocks={shownBlocks}
                      nodeId={panelNodeId}
                      onBack={() => setPanelNodeId(null)}
                      onFocusNode={focusNode}
                      onSelectVariable={goToVariable}
                    />
                  ) : (
                    <BlockDetailPanel
                      block={shownBlock}
                      blocks={shownBlocks}
                      workflow={workflow.workflow}
                      waitingFor={shownProgress?.waitingFor ?? null}
                      progress={shownProgress ?? undefined}
                      route={progress.route}
                      statistics={shownProgress?.statistics}
                      cursor={cursor}
                      onSelectBlock={(id) => update({ [BLOCK_PARAM]: id })}
                      onSetCursor={(at) => update({ [AT_PARAM]: at === null ? null : String(at) })}
                      onFocusNode={focusNode}
                      listHighlight={listHighlight}
                    />
                  )}
                </TabsContent>
              )}

              <TabsContent value="variables" className="scrollbar-thin flex-1 overflow-auto m-0">
                <VariablesPanel
                  progress={shownProgress}
                  cursor={cursor}
                  context={execution?.context?.variables}
                  workflow={workflow?.workflow}
                  waiting={waiting}
                  waitingBlockName={waitingBlockName}
                  canAdjust={answerable}
                  editableVariableNames={editableVariableNames}
                  onAnswer={handleAnswer}
                  onSavePath={canEdit ? handleSavePath : undefined}
                  onFullscreen={() => setVariablesFullscreen(true)}
                  highlight={variableHighlight}
                />
              </TabsContent>

              <TabsContent value="errors" className="scrollbar-thin flex-1 overflow-auto m-0 p-4">
                <ExecutionErrorHistory errors={execution.errors ?? []} />
              </TabsContent>

              <TabsContent value="steps" className="scrollbar-thin flex-1 overflow-auto m-0 p-4">
                <StepProgression
                  workflow={workflow.workflow}
                  blocks={shownBlocks}
                  currentNodeId={shownCurrentNodeId}
                  visitedNodeIds={visitedNodeIds}
                  onNodeClick={focusNode}
                />
              </TabsContent>

              <TabsContent
                value="locks"
                className="scrollbar-thin flex-1 overflow-auto m-0 p-4"
                data-testid="locks-panel"
                data-pending={lockHistory.pending ? "true" : undefined}
              >
                {lockHistory.error && (
                  <div
                    className="mb-3 text-xs text-destructive"
                    role="alert"
                    data-testid="locks-error"
                  >
                    {lockHistory.error}
                  </div>
                )}
                {locksLoading ? (
                  <div
                    className="flex items-center justify-center py-8"
                    data-testid="locks-loading"
                  >
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
          </div>
        </aside>
      </div>

      {/* The variables panel with more room: the same panel in a dialog */}
      <Dialog open={variablesFullscreen} onOpenChange={setVariablesFullscreen}>
        <DialogContent className="flex max-h-[90vh] w-[90vw] flex-col gap-0 overflow-hidden p-0 sm:max-w-5xl">
          <DialogHeader className="border-b bg-muted/30 px-6 py-4">
            <DialogTitle className="flex items-center gap-3">
              <div className="rounded-md bg-primary/10 p-2">
                <Variable className="h-5 w-5 text-primary" />
              </div>
              <div className="flex flex-col gap-1">
                <span>{t("pages.runPage.tabs.variables")}</span>
                <span className="text-xs font-normal text-muted-foreground">
                  {execution.workflowName || execution.workflowId} •{" "}
                  {execution.executionId.substring(0, 8)}
                </span>
              </div>
            </DialogTitle>
          </DialogHeader>
          <div className="scrollbar-thin flex-1 overflow-auto bg-background">
            <VariablesPanel
              progress={shownProgress}
              cursor={cursor}
              context={execution?.context?.variables}
              workflow={workflow?.workflow}
              waiting={waiting}
              waitingBlockName={waitingBlockName}
              canAdjust={answerable}
              editableVariableNames={editableVariableNames}
              onAnswer={handleAnswer}
              onSavePath={canEdit ? handleSavePath : undefined}
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
 * The Steps tab: every node of the definition in authored order as the shared step card, marked
 * completed, current or pending from the run; a click focuses the node on the technical graph.
 */
interface StepProgressionProps {
  workflow: WorkflowGraphType;
  /** The run's blocks in process order; steps are listed block by block, the rest after. */
  blocks: RunBlock[];
  currentNodeId: string | null;
  /** Node ids the recorded route has visited (up to the cursor); their cards carry a done mark. */
  visitedNodeIds: ReadonlySet<string>;
  onNodeClick: (nodeId: string) => void;
}

const StepProgression: React.FC<StepProgressionProps> = ({
  workflow,
  blocks,
  currentNodeId,
  visitedNodeIds,
  onNodeClick,
}) => {
  const { t } = useTranslation();
  const steps = useMemo(() => {
    const ordered = blocks.flatMap((block) => block.nodeIds);
    const owned = new Set(ordered);
    const rest = (workflow?.nodes ?? []).map((node) => node.id).filter((id) => !owned.has(id));
    return stepsOf(workflow, [...ordered, ...rest]);
  }, [workflow, blocks]);
  if (!steps.length) {
    return (
      <div className="py-8 text-center text-sm text-muted-foreground">
        {t("pages.executionInspector.steps.noSteps")}
      </div>
    );
  }
  return (
    <StepCardList testId="steps-list" ariaLabel={t("pages.executionInspector.tabs.steps")}>
      {steps.map((step, index) => {
        const current = step.id === currentNodeId;
        const completed = !current && visitedNodeIds.has(step.id);
        return (
          <StepCard
            key={step.id}
            step={step}
            position={index + 1}
            current={current}
            onSelect={() => onNodeClick(step.id)}
            selectTitle={t("pages.runPage.blockDetail.focusStep")}
            afterTitle={
              completed ? (
                <span
                  className="inline-flex items-center gap-1 text-[11px] font-medium text-success"
                  data-step-done=""
                  data-hint={t("pages.runPage.status.done")}
                >
                  <Check className="size-3.5" aria-hidden="true" />
                  {t("pages.runPage.status.done")}
                </span>
              ) : undefined
            }
          />
        );
      })}
    </StepCardList>
  );
};
