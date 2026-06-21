/**
 * Universal Node Execution Results - Simplified approach
 * Nodes return action decisions, executor handles message routing
 */

// Universal node execution result - what should executor do next?
export interface NodeExecutionResult {
  nodeId: string;
  action: "continue" | "pause" | "error" | "complete";
  outputPath?: string; // Which connection to follow (for continue)
  data?: Record<string, unknown>; // Data to merge into context
  error?: string; // Error message (for error action)
  executionTime?: number;
}

// Node execution actions explained:
export type NodeAction =
  | "continue" // Execute next node immediately (condition, start nodes)
  | "pause" // Wait for agent input (agent-directive nodes)
  | "error" // Something failed, stop execution
  | "complete"; // Workflow finished successfully (end nodes)

// Helper functions for creating standard results
export class NodeResultBuilder {
  static continue(
    nodeId: string,
    outputPath: string,
    data?: Record<string, unknown>,
  ): NodeExecutionResult {
    return {
      nodeId,
      action: "continue",
      outputPath,
      data,
    };
  }

  static pause(nodeId: string, data?: Record<string, unknown>): NodeExecutionResult {
    return {
      nodeId,
      action: "pause",
      data,
    };
  }

  static error(nodeId: string, error: string): NodeExecutionResult {
    return {
      nodeId,
      action: "error",
      error,
    };
  }

  static complete(nodeId: string, data?: Record<string, unknown>): NodeExecutionResult {
    return {
      nodeId,
      action: "complete",
      outputPath: "", // Empty path for complete action
      data,
    };
  }
}

// NodeExecutionContext removed - use ExecutionContext + AgentMessageQueue parameters directly

// Import base types
export type { ExecutionContext } from "./base-types.js";
