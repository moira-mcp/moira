/**
 * Complete type system for Node-Graph Workflow Architecture
 * Central export point for all graph-related types
 */

// Base types and execution context
export * from "./base-types.js";

// Workflow types
export * from "./workflow.js";

// Structured condition system
export * from "./structured-condition.js";

// All node types with architectural improvements
export * from "./graph-nodes.js";

// Telegram notification types
export * from "./telegram-types.js";

// Validation and error handling types
export * from "./validation-types.js";

// Re-export for convenience - corrected imports
export type {
  // Core execution types
  WorkflowExecution,
  ExecutionContext,
  NodeExecutionResult,
  NodeHooks,
} from "./base-types.js";

export type {
  // Workflow definition
  WorkflowGraph,
} from "../interfaces/core-interfaces.js";

export type {
  // Node types
  GraphNode,
  StartNode,
  EndNode,
  AgentDirectiveNode,
  ConditionNode,
  SubgraphNode,
  TelegramNotificationNode,
  ExpressionNode,
  ReadNoteNode,
  WriteNoteNode,
  UpsertNoteNode,
  LockNode,
  TeleportNode,
} from "./graph-nodes.js";

export type {
  // Condition system
  StructuredCondition,
  ConditionResult,
} from "./structured-condition.js";

// Type guards re-export
export {
  isStartNode,
  isEndNode,
  isAgentDirectiveNode,
  isConditionNode,
  isSubgraphNode,
  isTelegramNotificationNode,
  isExpressionNode,
  isReadNoteNode,
  isWriteNoteNode,
  isUpsertNoteNode,
  isLockNode,
  isTeleportNode,
  getNextNodeId,
  validateNodeConnections,
} from "./graph-nodes.js";

// Condition helpers re-export
export { ConditionBuilder } from "./structured-condition.js";

// Re-export ExecutionError types from shared (Issue #386)
export type {
  ExecutionError,
  ExecutionErrorType,
  ExecutionStatus,
  LegacyExecutionStatus,
} from "@mcp-moira/shared";
export { mapLegacyStatus, mapLegacyStatusArray } from "@mcp-moira/shared";
