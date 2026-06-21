/**
 * Unified Execution Inspector Component
 * View and optionally edit execution state
 * Uses dependency injection through props for flexibility
 *
 * Differences between user/admin views are passed via props, not modes.
 *
 * UX Redesign (Step 28):
 * - Tabbed right panel: Context (default), Errors, Steps
 * - Context visible inline by default without modal
 * - JSON editor with syntax highlighting and folding
 * - Optional fullscreen modal for context editing
 * - Compact 1-line toolbar
 * - Lazy loading for WorkflowGraph
 */

import React, { useState, useEffect, useCallback, useMemo, Suspense, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { apiClient } from "../../services/api-client";
import { ContextVariableEditor } from "./ContextVariableEditor";
import type { WorkflowGraph as WorkflowGraphType } from "../../types";
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
  Loader2,
  Maximize2,
  ListChecks,
  Lock,
  Unlock,
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

// Lazy load WorkflowGraph for better initial page load
const WorkflowGraph = React.lazy(() =>
  import("../workflow/WorkflowGraph").then((module) => ({
    default: module.WorkflowGraph,
  })),
);

// Base execution data - common fields
export interface ExecutionData {
  executionId: string;
  workflowId: string;
  workflowName?: string | null; // Issue #421: Resolved from workflow table
  userId: string;
  status: string;
  currentNodeId: string | null;
  waitingForInputNodeId: string | null;
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
  // UI configuration
  backRoute: string;
  showOwnerInfo?: boolean;
}

export const ExecutionInspector: React.FC<ExecutionInspectorProps> = ({
  executionId,
  fetchExecution,
  editable = false,
  backRoute,
  showOwnerInfo = false,
}) => {
  const navigate = useNavigate();
  const { t } = useTranslation();

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

  // Context editing state (per-variable save is handled inside ContextVariableEditor)
  const [contextFullscreen, setContextFullscreen] = useState(false);

  // Tab state
  const [activeTab, setActiveTab] = useState("context");

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

  // For focus on node functionality
  const workflowGraphRef = useRef<{ focusOnNode: (nodeId: string) => void } | null>(null);

  // Copy to clipboard state
  const [copied, setCopied] = useState(false);

  // Extract error node IDs from errors array for graph highlighting
  const errorNodeIds = useMemo(() => {
    if (!execution?.errors) return [];
    // Get unique node IDs that have errors
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
        const workflowData = await apiClient.getWorkflow(execData.workflowId);
        setWorkflow(workflowData);
        setError(null);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : t("common.errors.failedToLoad");
        setError(message);
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [executionId, fetchExecution, t],
  );

  useEffect(() => {
    loadExecution();
  }, [loadExecution]);

  const handleRefresh = useCallback(() => {
    loadExecution(true);
  }, [loadExecution]);

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
    // No longer need to track selectedNodeId for display
    // Node details are shown via NodeDetailSheet in WorkflowGraph
  }, []);

  const handleCurrentNodeClick = useCallback(() => {
    if (execution?.currentNodeId && workflowGraphRef.current) {
      workflowGraphRef.current.focusOnNode(execution.currentNodeId);
    }
  }, [execution?.currentNodeId]);

  const handleCopyExecutionId = useCallback(async () => {
    if (execution?.executionId) {
      await navigator.clipboard.writeText(execution.executionId);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  }, [execution?.executionId]);

  const canEdit = editable;

  // Per-path save: update a value at any nesting path without overwriting the rest of the
  // object or other variables. After a successful save, refresh ONLY the execution context
  // (not the workflow) to reflect authoritative server state.
  //
  // We deliberately avoid loadExecution(true) here: that also re-fetches the workflow graph,
  // which is unchanged by a context edit. Coupling the two means a transient workflow-fetch
  // failure (or its re-render) tears down the editor subtree while the save's PUT is still
  // settling, aborting the in-flight request (net::ERR_ABORTED). Refreshing just the execution
  // keeps the graph mounted and the save atomic from the UI's perspective.
  const handleSavePath = useCallback(
    async (path: Array<string | number>, value: unknown): Promise<boolean> => {
      if (!editable || !execution) return false;
      const success = await apiClient.updateExecutionContextPath(
        execution.executionId,
        path,
        value,
      );
      if (success) {
        // Refresh execution state only. On a transient fetch error, keep the current
        // inspector mounted rather than surfacing a full-page error — the save itself
        // already succeeded server-side.
        try {
          const execData = await fetchExecution(execution.executionId);
          setExecution(execData);
        } catch {
          /* keep existing execution state; save already persisted */
        }
      }
      return success;
    },
    [editable, execution, fetchExecution],
  );

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

  return (
    <div className="h-full flex flex-col">
      {/* Compact Toolbar - 1 line */}
      <div className="border-b bg-card px-4 py-2 flex items-center gap-3">
        {/* Back button */}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="sm" onClick={() => navigate(backRoute)}>
              <ArrowLeft className="h-4 w-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{t("pages.executionInspector.backToExecutions")}</TooltipContent>
        </Tooltip>

        {/* Execution ID with copy */}
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

        {/* Workflow name */}
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="text-sm font-medium truncate max-w-[200px] cursor-default">
              {execution.workflowName || execution.workflowId.substring(0, 8) + "..."}
            </span>
          </TooltipTrigger>
          <TooltipContent>{execution.workflowName || execution.workflowId}</TooltipContent>
        </Tooltip>

        {/* Status badge */}
        <Badge variant={getStatusBadgeVariant(execution.status)} className="gap-1">
          {getStatusIcon(execution.status)}
          {t(`common.status.${execution.status}`)}
        </Badge>

        {/* Current node - clickable to focus */}
        {currentNode && (
          <>
            <span className="text-muted-foreground">•</span>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  onClick={handleCurrentNodeClick}
                  className="flex items-center gap-1.5 px-2 py-1 rounded-md bg-primary/10 hover:bg-primary/20 transition-colors"
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

        {/* Spacer */}
        <div className="flex-1" />

        {/* Owner info (admin view) - compact */}
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

        {/* Action buttons */}
        <div className="flex items-center gap-1">
          {/* Lock button — only for running executions without active lock, non-admin view */}
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

          {/* Fullscreen context button — visible when on context tab */}
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

          {/* Refresh button */}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="outline" size="sm" onClick={handleRefresh} disabled={refreshing}>
                <RefreshCw className={`h-4 w-4 ${refreshing ? "animate-spin" : ""}`} />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t("pages.executionInspector.toolbar.refresh")}</TooltipContent>
          </Tooltip>

          {/* Errors badge */}
          {errorsCount > 0 && <ErrorCountBadge count={errorsCount} />}
        </div>
      </div>

      {/* Main content */}
      <div className="flex-1 flex overflow-hidden">
        {/* Workflow visualization - left side */}
        <div className="w-1/2 border-r">
          <Suspense
            fallback={
              <div className="flex items-center justify-center h-full bg-muted/20">
                <div className="text-muted-foreground">{t("components.workflowGraph.loading")}</div>
              </div>
            }
          >
            <WorkflowGraphWithRef
              ref={workflowGraphRef}
              workflow={workflow.workflow}
              validation={workflow.validation}
              currentNodeId={execution.currentNodeId}
              errorNodeIds={errorNodeIds}
              onNodeClick={handleNodeClick}
              showControls={true}
              showMinimap={false}
              showNodeDetails={true}
            />
          </Suspense>
        </div>

        {/* Right panel — Tabbed: Context (default), Errors, Steps */}
        <div className="w-1/2 flex flex-col bg-card overflow-hidden">
          <Tabs value={activeTab} onValueChange={setActiveTab} className="flex flex-col h-full">
            <TabsList className="w-full justify-start rounded-none border-b bg-muted/30 px-2 h-10">
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

            {/* Context tab */}
            <TabsContent value="context" className="flex-1 flex flex-col overflow-hidden m-0">
              <div className="flex-1 overflow-auto p-3">
                <ContextVariableEditor
                  variables={execution?.context?.variables || {}}
                  workflow={workflow?.workflow}
                  onSavePath={canEdit ? handleSavePath : undefined}
                />
              </div>
            </TabsContent>

            {/* Errors tab */}
            <TabsContent value="errors" className="flex-1 overflow-auto m-0 p-4">
              <ExecutionErrorHistory errors={execution.errors ?? []} />
            </TabsContent>

            {/* Steps tab — step progression */}
            <TabsContent value="steps" className="flex-1 overflow-auto m-0 p-4">
              <StepProgression
                workflow={workflow.workflow}
                currentNodeId={execution.currentNodeId}
                nodeStates={execution.context?.nodeStates}
                onNodeClick={(nodeId) => {
                  if (workflowGraphRef.current) {
                    workflowGraphRef.current.focusOnNode(nodeId);
                  }
                }}
              />
            </TabsContent>

            {/* Locks tab */}
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
                          {lock.status === "active" && showOwnerInfo && (
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => handleAdminUnlock(lock.id)}
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
                          {lock.status === "active" && !showOwnerInfo && (
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => handleOwnerUnlock(lock.id)}
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
            {/* Step number / status indicator */}
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

            {/* Node info */}
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

            {/* Status badge for current */}
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

/**
 * Wrapper component to expose focusOnNode via ref
 * This bridges the gap between ExecutionInspector and WorkflowGraph's internal ReactFlow instance
 */
interface WorkflowGraphWithRefProps {
  workflow: WorkflowGraphType;
  validation?: {
    isValid: boolean;
    globalErrors: string[];
    globalWarnings: string[];
    nodeValidation: Record<string, { isValid: boolean; errors: string[]; warnings: string[] }>;
  };
  currentNodeId?: string | null;
  errorNodeIds?: string[];
  onNodeClick?: (event: React.MouseEvent, node: { id: string }) => void;
  showControls?: boolean;
  showMinimap?: boolean;
  showNodeDetails?: boolean;
}

const WorkflowGraphWithRef = React.forwardRef<
  { focusOnNode: (nodeId: string) => void },
  WorkflowGraphWithRefProps
>(function WorkflowGraphWithRef(props, ref) {
  const [reactFlowInstance, setReactFlowInstance] = useState<{
    fitView: (options?: { nodes?: { id: string }[]; padding?: number; duration?: number }) => void;
  } | null>(null);

  React.useImperativeHandle(
    ref,
    () => ({
      focusOnNode: (nodeId: string) => {
        if (reactFlowInstance) {
          reactFlowInstance.fitView({
            nodes: [{ id: nodeId }],
            padding: 0.5,
            duration: 300,
          });
        }
      },
    }),
    [reactFlowInstance],
  );

  return <WorkflowGraph {...props} onInit={(instance) => setReactFlowInstance(instance)} />;
});
