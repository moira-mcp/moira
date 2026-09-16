/**
 * Expression Handler - Executes expression nodes for safe arithmetic operations
 *
 * Expression nodes evaluate mathematical expressions and update context variables.
 * This is used for automatic counter increments, calculations, etc.
 *
 * SECURITY: Uses SafeExpressionInterpreter - NOT JavaScript eval()
 */

import {
  GraphNode,
  ExpressionNode,
  ExecutionContext,
  VariableRegistry,
  isExpressionNode,
} from "../types/index.js";
import { NodeExecutionResult, NodeResultBuilder } from "../types/node-execution.js";
import { INodeHandler } from "../interfaces/core-interfaces.js";
import { IDataRepository } from "../interfaces/data-repository.js";
import { IGraphExecutionEngine } from "../interfaces/graph-execution-engine.js";
import { AgentMessageQueue } from "../services/agent-message-queue.js";
import { createLogger, InternalError, ValidationError } from "@mcp-moira/shared";
import { runNodeExpressions } from "../services/node-routing.js";

export class ExpressionHandler implements INodeHandler {
  private logger = createLogger({ component: "ExpressionHandler" });

  getNodeType(): string {
    return "expression";
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
    if (!isExpressionNode(node)) {
      throw new InternalError("ExpressionHandler can only execute expression nodes", {
        nodeType: node.type,
      });
    }

    const expressionNode = node as ExpressionNode;
    const timer = this.logger.startTimer();

    this.logger.info("Executing expression node", {
      nodeId: expressionNode.id,
      executionId: context.executionId,
      expressionCount: expressionNode.expressions.length,
    });

    // The same runner serves expressions carried by routing nodes; a failure here takes the
    // node's error output when it has one and fails the node otherwise, publishing nothing.
    const run = runNodeExpressions(
      expressionNode.expressions,
      context.variables,
      variableRegistry,
      `expression node '${expressionNode.id}'`,
    );
    if (run.failure) {
      if (expressionNode.connections.error) {
        return NodeResultBuilder.continue(expressionNode.id, "error", {
          expressionFailed: true,
          failedIndex: run.failure.index,
        });
      }
      throw new ValidationError(
        `Expression evaluation failed at index ${run.failure.index}: ${run.failure.message}`,
        { nodeId: expressionNode.id, expressionIndex: run.failure.index },
      );
    }
    const allAssignments = run.assignments;

    const executionTime = timer.elapsed();

    this.logger.info("Expression node completed", {
      nodeId: expressionNode.id,
      executionTime,
      totalAssignments: Object.keys(allAssignments).length,
      assignmentNames: Object.keys(allAssignments),
    });

    // Return continue with all assignments as data
    // These will be merged into execution context by the engine
    return NodeResultBuilder.continue(expressionNode.id, "default", allAssignments);
  }

  canExecute(node: GraphNode, _context: ExecutionContext): boolean {
    return isExpressionNode(node);
  }
}
