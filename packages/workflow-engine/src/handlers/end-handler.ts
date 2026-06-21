/**
 * End Handler V2 - Simple workflow completion
 * Collects final data and signals completion - no agent interaction
 */

import { GraphNode, EndNode, ExecutionContext, isEndNode } from "../types/index.js";
import { NodeExecutionResult, NodeResultBuilder } from "../types/node-execution.js";
import { INodeHandler } from "../interfaces/core-interfaces.js";
import { IDataRepository } from "../interfaces/data-repository.js";
import { IGraphExecutionEngine } from "../interfaces/graph-execution-engine.js";
import { AgentMessageQueue } from "../services/agent-message-queue.js";
import { createLogger, InternalError } from "@mcp-moira/shared";

export class EndNodeHandler implements INodeHandler {
  private logger = createLogger({ component: "EndNodeHandler" });

  getNodeType(): string {
    return "end";
  }

  async execute(
    node: GraphNode,
    context: ExecutionContext,
    messageQueue: AgentMessageQueue,
    repository: IDataRepository,
    engine: IGraphExecutionEngine,
    input?: unknown,
  ): Promise<NodeExecutionResult> {
    if (!isEndNode(node)) {
      throw new InternalError("EndHandler can only execute end nodes", { nodeType: node.type });
    }

    const endNode = node as EndNode;
    const timer = this.logger.startTimer();

    this.logger.info("Auto-executing end node - workflow completing", {
      nodeId: endNode.id,
      executionId: context.executionId,
      finalOutputKeys: endNode.finalOutput,
      hasInput: !!input,
    });

    // Process any final input
    const finalData: Record<string, unknown> = {};

    if (input && typeof input === "object") {
      Object.assign(finalData, input);
      this.logger.debug("Final input merged", {
        nodeId: endNode.id,
        inputKeys: Object.keys(input),
      });
    }

    // Collect final output based on configuration
    if (endNode.finalOutput && endNode.finalOutput.length > 0) {
      // Include only specified keys
      for (const key of endNode.finalOutput) {
        if (key in context.variables) {
          finalData[key] = context.variables[key];
        }
      }

      this.logger.debug("Final output collected (filtered)", {
        nodeId: endNode.id,
        requestedKeys: endNode.finalOutput,
        includedKeys: Object.keys(finalData),
      });
    } else {
      // Include all context variables
      Object.assign(finalData, context.variables);

      this.logger.debug("Final output collected (all variables)", {
        nodeId: endNode.id,
        totalKeys: Object.keys(finalData).length,
      });
    }

    this.logger.info("Workflow completed successfully", {
      nodeId: endNode.id,
      executionTime: timer.elapsed(),
      finalDataKeys: Object.keys(finalData),
    });

    // Signal workflow completion - no more nodes to execute
    return NodeResultBuilder.complete(endNode.id, finalData);
  }

  canExecute(node: GraphNode, _context: ExecutionContext): boolean {
    return isEndNode(node);
  }
}
