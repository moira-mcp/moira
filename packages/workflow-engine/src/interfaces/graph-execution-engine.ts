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
}

export interface GraphExecutionResult {
  action: "pause" | "complete";
  context: ExecutionContext;
  nextNodeId?: string;
  visitedNodes?: string[]; // All nodes visited during this execution cycle
  // Note: "error" action removed in Issue #386 - errors are logged to execution.errors
  // and execution stays in "running" state for retry
}
