/**
 * Core interfaces for Graph Workflow Engine
 * Clean dependency injection architecture with minimal contracts
 */

import { WorkflowExecution, ExecutionContext } from "../types/base-types.js";
import { NodeExecutionResult } from "../types/node-execution.js";
import { GraphNode, VariableRegistry } from "../types/graph-nodes.js";
import { AgentMessageQueue } from "../services/agent-message-queue.js";
import type { IGraphExecutionEngine } from "./graph-execution-engine.js";

// Re-export GraphNode for tools
export type { GraphNode } from "../types/graph-nodes.js";
import { GraphValidationResult } from "../validation/graph-validator.js";

// Re-export message types for external use
export { AgentMessageType } from "../services/agent-message-queue.js";
export type {
  AgentMessage,
  DirectiveMessage,
  NotificationMessage,
} from "../services/agent-message-queue.js";

// Define WorkflowGraph here to avoid circular imports
export interface WorkflowGraph {
  /** Server-assigned identifier. Absent in workflow definition files; assigned on save. */
  id?: string;
  metadata: {
    name: string;
    version: string;
    description: string;
    author?: string;
    tags?: string[];
  };
  nodes: GraphNode[];
  // No startNodeId/endNodeIds - engine finds by node types automatically

  /**
   * Global variable registry (optional during transition; required after migration).
   * Single source of truth for workflow-global variables' type/description/default.
   * Bare-name references resolve against this; node-local values use `node-id.name`.
   */
  variableRegistry?: VariableRegistry;

  /**
   * Per-workflow system reminder (optional)
   * Overrides global mcp.systemReminder when set
   * Added to each execute_step response
   */
  systemReminder?: string;
}

// Workflow loading result with validation status
export interface WorkflowLoadResult {
  workflow?: WorkflowGraph;
  validation: GraphValidationResult;
  filePath?: string;
}

// Workflow list item with validation status
export interface WorkflowListItem {
  id: string;
  metadata: WorkflowGraph["metadata"];
  filePath: string;
  validation: GraphValidationResult;
  workflow?: WorkflowGraph; // Only included if valid
  userId: string;
  visibility: "public" | "private";
  createdAt: number;
  updatedAt: number;
}

// Main execution interface - simplified for graph traversal
export interface IGraphExecutor {
  /**
   * Start a new workflow execution
   * @param note Optional note for execution identification (max 500 chars)
   * @param parentExecutionId Optional parent execution ID for continuation
   */
  startWorkflow(
    graph: WorkflowGraph,
    initialData: Record<string, unknown> | undefined,
    userId: string,
    note?: string,
    parentExecutionId?: string,
  ): Promise<string>;

  /**
   * Execute current node and advance to next
   * Returns formatted text string when agent-directive node needs user input
   * @param teleportTo Optional teleport node ID to jump execution to
   */
  executeStep(executionId: string, userInput?: unknown, teleportTo?: string): Promise<string>;

  /**
   * Get current execution state
   */
  getExecutionState(executionId: string): Promise<WorkflowExecution | null>;

  /**
   * Cancel running execution
   */
  cancelExecution(executionId: string): Promise<void>;
}

// Node handler interface - clean and focused
export interface INodeHandler {
  /**
   * Get supported node type
   */
  getNodeType(): string;

  /**
   * Execute a node with given context, message queue, repository, engine, and input
   */
  execute(
    node: GraphNode,
    context: ExecutionContext,
    messageQueue: AgentMessageQueue,
    repository: unknown, // IDataRepository - avoiding circular import
    engine: IGraphExecutionEngine,
    input?: unknown,
  ): Promise<NodeExecutionResult>;

  /**
   * Check if node can be executed (optional validation)
   */
  canExecute?(node: GraphNode, context: ExecutionContext): boolean;
}

// Graph storage interface for persistence
export interface IGraphStorage {
  saveExecution(execution: WorkflowExecution): Promise<void>;
  getExecution(executionId: string): Promise<WorkflowExecution | null>;
  deleteExecution(executionId: string): Promise<void>;
  listExecutions(): Promise<WorkflowExecution[]>;

  saveWorkflow(graph: WorkflowGraph, userId: string): Promise<void>;
  getWorkflow(workflowId: string, userId: string): Promise<WorkflowGraph | null>;
  listWorkflows(userId: string): Promise<WorkflowGraph[]>;
  deleteWorkflow(workflowId: string, userId: string): Promise<void>;

  // New methods with validation support
  getWorkflowWithValidation(workflowId: string, userId: string): Promise<WorkflowLoadResult>;
  listWorkflowsWithValidation(userId: string): Promise<WorkflowListItem[]>;
}

// Agent command response - ONLY for agent-directive nodes
export interface AgentDirective {
  processId: string; // executionId for MCP compatibility
  directive: string; // ALWAYS present - what agent should do
  completionCondition: string; // ALWAYS present - when agent is done
  inputSchema?: Record<string, unknown>; // Expected input structure
  error?: string; // Error message for failed workflows
}

// Context management interface
export interface IContextManager {
  getValue(path: string): unknown;
  setValue(path: string, value: unknown): void;
  hasValue(path: string): boolean;
  getAll(): Record<string, unknown>;
  clear(): void;
}

export type {
  IGraphExecutionEngine,
  GraphExecutionResult,
} from "../interfaces/graph-execution-engine.js";
