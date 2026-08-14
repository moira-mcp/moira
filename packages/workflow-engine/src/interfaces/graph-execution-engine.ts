/**
 * GraphExecutionEngine interface - separated to avoid circular dependencies
 */

import { WorkflowGraph, ExecutionContext } from "../types/index.js";
import { AgentMessageQueue } from "../services/agent-message-queue.js";

export interface IGraphExecutionEngine {
  executeGraph(
    graph: WorkflowGraph,
    context: ExecutionContext,
    messageQueue: AgentMessageQueue,
    startNodeId: string,
    userInput?: unknown,
  ): Promise<GraphExecutionResult>;

  /**
   * Re-present one materialize node without traversing any of its connections.
   * The handler must pause; every other result is surfaced as a presentation failure.
   */
  presentMaterializeNode(
    graph: WorkflowGraph,
    context: ExecutionContext,
    messageQueue: AgentMessageQueue,
    nodeId: string,
  ): Promise<void>;
}

export interface GraphExecutionResult {
  action: "pause" | "complete";
  context: ExecutionContext;
  nextNodeId?: string;
  visitedNodes?: string[]; // All nodes visited during this execution cycle
  // Note: "error" action removed in Issue #386 - errors are logged to execution.errors
  // and execution stays in "running" state for retry
}
