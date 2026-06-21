/**
 * Start Handler V2 - Simple auto-execution
 * Merges initial data and immediately continues - no agent interaction
 */

import { GraphNode, StartNode, ExecutionContext, isStartNode } from "../types/index.js";
import { NodeExecutionResult, NodeResultBuilder } from "../types/node-execution.js";
import { INodeHandler } from "../interfaces/core-interfaces.js";
import { IDataRepository } from "../interfaces/data-repository.js";
import { IGraphExecutionEngine } from "../interfaces/graph-execution-engine.js";
import { AgentMessageQueue } from "../services/agent-message-queue.js";
import { createLogger, InternalError } from "@mcp-moira/shared";

export class StartNodeHandler implements INodeHandler {
  private logger = createLogger({ component: "StartNodeHandler" });

  getNodeType(): string {
    return "start";
  }

  async execute(
    node: GraphNode,
    context: ExecutionContext,
    messageQueue: AgentMessageQueue,
    repository: IDataRepository,
    engine: IGraphExecutionEngine,
    input?: unknown,
  ): Promise<NodeExecutionResult> {
    if (!isStartNode(node)) {
      throw new InternalError("StartHandler can only execute start nodes", { nodeType: node.type });
    }

    const startNode = node as StartNode;
    const timer = this.logger.startTimer();

    this.logger.info("Auto-executing start node", {
      nodeId: startNode.id,
      executionId: context.executionId,
      hasInitialData: !!startNode.initialData,
      hasInput: !!input,
    });

    // Merge initial data and input into context
    const dataToMerge: Record<string, unknown> = {};

    // Extract values from structured initialData.variables
    if (startNode.initialData?.variables) {
      for (const [varName, varDef] of Object.entries(startNode.initialData.variables)) {
        dataToMerge[varName] = varDef.value ?? null;
      }
    }

    if (input && typeof input === "object") {
      Object.assign(dataToMerge, input);
    }

    this.logger.debug("Data merged into context", {
      nodeId: startNode.id,
      mergedKeys: Object.keys(dataToMerge),
      executionTime: timer.elapsed(),
    });

    // IMMEDIATELY continue to next node - no agent interaction needed
    return NodeResultBuilder.continue(startNode.id, "default", dataToMerge);
  }

  canExecute(node: GraphNode, _context: ExecutionContext): boolean {
    return isStartNode(node);
  }
}
