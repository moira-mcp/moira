/**
 * GraphExecutionEngine interface - separated to avoid circular dependencies
 */

import { WorkflowGraph, ExecutionContext } from "../types/index.js";
import { AgentMessageQueue } from "../services/agent-message-queue.js";
import type { CycleOrigin, EngineVisit } from "../utils/execution-visits.js";

export interface IGraphExecutionEngine {
  executeGraph(
    graph: WorkflowGraph,
    context: ExecutionContext,
    messageQueue: AgentMessageQueue,
    startNodeId: string,
    userInput?: unknown,
    /** The run this cycle continues; handlers then read the live run (see `liveExecution`). */
    origin?: CycleOrigin,
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
  visits?: EngineVisit[]; // Route log entries of this cycle, in order
  // Errors are logged to execution.errors; a refused step pauses in the active run for retry.
}
