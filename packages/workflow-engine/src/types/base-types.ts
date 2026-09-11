/**
 * Base types for Node-Graph Workflow Architecture
 * Foundation types for the new graph-based execution engine
 */

import type { ExecutionError, LegacyExecutionStatus } from "@mcp-moira/shared";

// Execution context and state management
export interface ExecutionContext {
  variables: Record<string, unknown>;
  nodeStates: Record<string, unknown>;
  executionId: string;
  workflowId: string;
  userId: string; // User who owns this execution

  // Names of registry variables whose author-authored `default` contains template syntax
  // (legitimate template fragments that may carry live {{...}} meant to expand, e.g.
  // a *_prompt/*_directive default referencing {{topic}}). Used by the template processor
  // to decide which substituted values may be re-scanned vs. neutralized (§14 injection
  // protection). When absent, the processor falls back to a name-convention heuristic.
  _templateFragmentVars?: ReadonlySet<string>;

  // Subgraph execution tracking
  _subgraphDepth?: number; // Current nesting level (0 = root)
  _parentExecutionId?: string; // Parent workflow execution ID
  _subgraphChain?: string[]; // Workflow ID chain for debugging

  // Step delegation state tracking
  _subgraphState?: {
    isInSubgraph: boolean;
    childExecutionId: string;
    childWorkflowId: string;
    parentNodeId: string;
    outputMapping: Record<string, string>;
  };
}

// Node execution hooks for extensibility
export interface NodeHooks {
  beforeExecute?: (context: ExecutionContext) => void;
  afterExecute?: (context: ExecutionContext, result: NodeExecutionResult) => void;
  onError?: (context: ExecutionContext, error: Error) => void;
}

// Core node execution result
export interface NodeExecutionResult {
  nodeId: string;
  outputPath: string; // Which output connection to follow
  success: boolean;
  data?: unknown;
  error?: string;
  executionTime?: number;
}

// Base interface for all node types
export interface BaseNode {
  type: string;
  id: string;
  /** User-facing progress milestone activated while this primary node is current. */
  progressNodeId?: string;
  /** Template-enabled label used only while this exact primary node is current. */
  progressActiveLabel?: string;
  /** Template-enabled presentation merged into the active progress milestone. */
  progressActiveContent?: ProgressContentTemplate;
  metadata?: {
    displayName?: string;
    description?: string;
    icon?: string;
    color?: string;
    tags?: string[];
    estimatedDuration?: number;
  };
  hooks?: NodeHooks;
  timeout?: number;
  connections?: Record<string, string>; // outputPath -> nextNodeId
  /** Human labels for connections, keyed like `connections`; used by the aggregated process view. */
  connectionLabels?: Record<string, ConnectionLabel>;
}

/** A connection label: plain text, or text plus an explanation of the return it represents. */
export type ConnectionLabel = string | { label: string; cycle?: { cause: string; exit: string } };

export interface ProgressContentTemplate {
  summary?: string;
  details?: string[];
  outcome?: string;
  next?: string;
}

export type ProgressFactTone = "neutral" | "positive" | "warning" | "critical";

// Workflow execution instance
export interface WorkflowExecution {
  executionId: string;
  workflowId: string;
  userId: string; // User who owns this execution
  currentNodeId: string | null;
  waitingForInputNodeId?: string | null; // Which node is waiting for agent input
  globalContext: ExecutionContext;
  status: LegacyExecutionStatus; // TODO(#386): Change to ExecutionStatus after migration
  note?: string | null; // User-provided note for identification (max 500 chars)
  parentExecutionId?: string | null; // Links to parent execution for continuation
  revision: number; // Workflow-step generation; metadata targets use independent revisions
  reminders?: ExecutionReminder[]; // Durable caller follow-ups returned at completion
  visits?: ExecutionVisit[]; // Append-only route log written by the executor on every node transition
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
  error?: string; // DEPRECATED: kept for migration, use errors array instead
  errors?: ExecutionError[]; // Persistent error log (Issue #386)
}

/** Who produced a runtime adjustment: the agent through MCP, or a person through the web UI. */
export type ExecutionVisitActorRole = "agent" | "user";

/**
 * One entry of an execution's route log: the node that ran, the connection it left through
 * (`null` while it waits or at completion; `"teleport"` when a jump left it), the variables it
 * changed, whether it paused for input, and — for a runtime adjustment — the actor.
 */
export interface ExecutionVisit {
  seq: number;
  nodeId: string;
  exitKey: string | null;
  changes: Record<string, unknown>;
  waited?: boolean;
  adjusted?: boolean;
  actor?: { role: ExecutionVisitActorRole; userId: string };
}

export interface ExecutionReminder {
  id: string;
  text: string;
  status: "active" | "cancelled";
  idempotencyKey?: string;
  createdAt: number;
  updatedAt: number;
}

export type ReminderMutation =
  | { action: "add"; text: string; idempotencyKey?: string }
  | { action: "update"; reminderId: string; text: string }
  | { action: "cancel"; reminderId: string };

export interface ReminderMutationResult {
  reminder: ExecutionReminder;
  revision: number;
  remindersRevision: string;
  changed: boolean;
}

// WorkflowGraph moved to interfaces/core-interfaces.ts to avoid circular imports
