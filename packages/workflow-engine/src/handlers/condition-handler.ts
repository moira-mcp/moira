/**
 * Condition Handler — routes to one of N outputs without agent interaction.
 *
 * The node's expressions run first, then its cases are evaluated in order; the first case whose
 * condition holds selects its output, otherwise `default`. Assignments made by the expressions
 * are published as declared globals when the node succeeds.
 */

import { GraphNode, ConditionNode, ExecutionContext, isConditionNode } from "../types/index.js";
import type { VariableRegistry } from "../types/index.js";
import { NodeExecutionResult, NodeResultBuilder } from "../types/node-execution.js";
import { INodeHandler } from "../interfaces/core-interfaces.js";
import { IDataRepository } from "../interfaces/data-repository.js";
import { IGraphExecutionEngine } from "../interfaces/graph-execution-engine.js";
import { AgentMessageQueue } from "../services/agent-message-queue.js";
import { routeNode } from "../services/node-routing.js";
import { createLogger, InternalError, ValidationError } from "@mcp-moira/shared";

export class ConditionHandler implements INodeHandler {
  private logger = createLogger({ component: "ConditionHandler" });

  getNodeType(): string {
    return "condition";
  }

  async execute(
    node: GraphNode,
    context: ExecutionContext,
    _messageQueue: AgentMessageQueue,
    _repository: IDataRepository,
    _engine: IGraphExecutionEngine,
    _input?: unknown,
    variableRegistry?: VariableRegistry,
  ): Promise<NodeExecutionResult> {
    if (!isConditionNode(node)) {
      throw new InternalError("ConditionHandler can only execute condition nodes", {
        nodeType: node.type,
      });
    }

    const conditionNode = node as ConditionNode;
    const timer = this.logger.startTimer();

    let routing;
    try {
      routing = routeNode(
        conditionNode,
        "default",
        context,
        variableRegistry,
        `condition node '${conditionNode.id}'`,
      );
    } catch (error) {
      throw new InternalError(
        `Condition evaluation failed: ${error instanceof Error ? error.message : String(error)}`,
        { nodeId: conditionNode.id },
      );
    }

    if (routing.failure) {
      throw new ValidationError(
        `Expression evaluation failed at index ${routing.failure.index}: ${routing.failure.message}`,
        { nodeId: conditionNode.id, expressionIndex: routing.failure.index },
      );
    }

    this.logger.info("Condition routed, continuing execution", {
      nodeId: conditionNode.id,
      executionId: context.executionId,
      output: routing.output,
      matchedCase: routing.matchedCase,
      executionTime: timer.elapsed(),
      evaluatedValues: routing.evaluatedValues,
    });

    return NodeResultBuilder.continue(
      conditionNode.id,
      routing.output,
      {
        output: routing.output,
        matchedCase: routing.matchedCase,
        evaluatedValues: routing.evaluatedValues,
      },
      routing.assignments,
    );
  }

  canExecute(node: GraphNode, _context: ExecutionContext): boolean {
    return isConditionNode(node);
  }
}
