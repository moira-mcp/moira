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
}

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
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
  error?: string; // DEPRECATED: kept for migration, use errors array instead
  errors?: ExecutionError[]; // Persistent error log (Issue #386)
}

// WorkflowGraph moved to interfaces/core-interfaces.ts to avoid circular imports
