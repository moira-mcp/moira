/**
 * Expression Handler - Executes expression nodes for safe arithmetic operations
 *
 * Expression nodes evaluate mathematical expressions and update context variables.
 * This is used for automatic counter increments, calculations, etc.
 *
 * SECURITY: Uses SafeExpressionInterpreter - NOT JavaScript eval()
 */

import { GraphNode, ExpressionNode, ExecutionContext, isExpressionNode } from "../types/index.js";
import { NodeExecutionResult, NodeResultBuilder } from "../types/node-execution.js";
import { INodeHandler } from "../interfaces/core-interfaces.js";
import { IDataRepository } from "../interfaces/data-repository.js";
import { IGraphExecutionEngine } from "../interfaces/graph-execution-engine.js";
import { AgentMessageQueue } from "../services/agent-message-queue.js";
import { createLogger, InternalError, ValidationError } from "@mcp-moira/shared";
import { SafeExpressionInterpreter, ExpressionResult } from "../expression/index.js";

export class ExpressionHandler implements INodeHandler {
  private logger = createLogger({ component: "ExpressionHandler" });
  private interpreter: SafeExpressionInterpreter;

  constructor() {
    this.interpreter = new SafeExpressionInterpreter();
  }

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

    // Collect all assignments from all expressions
    const allAssignments: Record<string, number | string | boolean> = {};
    const results: ExpressionResult[] = [];

    // Execute each expression in order
    // Use a merged context that includes previous assignments
    const mergedContext = { ...context.variables };

    for (let i = 0; i < expressionNode.expressions.length; i++) {
      const expression = expressionNode.expressions[i];

      this.logger.debug("Evaluating expression", {
        nodeId: expressionNode.id,
        expressionIndex: i,
        expression,
      });

      const result = this.interpreter.evaluate(expression, mergedContext);
      results.push(result);

      if (result.error) {
        // Check if error connection exists - use it for graceful handling
        if (expressionNode.connections.error) {
          return NodeResultBuilder.continue(expressionNode.id, "error", {
            expressionError: result.error,
            failedExpression: expression,
            failedIndex: i,
          });
        }

        // No error connection - throw to boundary
        throw new ValidationError(`Expression evaluation failed at index ${i}: ${result.error}`, {
          nodeId: expressionNode.id,
          expressionIndex: i,
          expression,
        });
      }

      // Merge assignments into context for subsequent expressions
      Object.assign(allAssignments, result.assignments);
      Object.assign(mergedContext, result.assignments);

      this.logger.debug("Expression evaluated", {
        nodeId: expressionNode.id,
        expressionIndex: i,
        value: result.value,
        assignments: result.assignments,
      });
    }

    const executionTime = timer.elapsed();

    this.logger.info("Expression node completed", {
      nodeId: expressionNode.id,
      executionTime,
      totalAssignments: Object.keys(allAssignments).length,
      assignments: allAssignments,
    });

    // Return continue with all assignments as data
    // These will be merged into execution context by the engine
    return NodeResultBuilder.continue(expressionNode.id, "default", allAssignments);
  }

  canExecute(node: GraphNode, _context: ExecutionContext): boolean {
    return isExpressionNode(node);
  }
}
