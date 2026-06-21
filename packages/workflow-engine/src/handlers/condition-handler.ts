/**
 * Condition Handler V2 - Simple auto-execution
 * Evaluates condition and immediately continues - no agent interaction
 */

import {
  GraphNode,
  ConditionNode,
  ExecutionContext,
  StructuredCondition,
  isConditionNode,
} from "../types/index.js";
import { NodeExecutionResult, NodeResultBuilder } from "../types/node-execution.js";
import { INodeHandler } from "../interfaces/core-interfaces.js";
import { IDataRepository } from "../interfaces/data-repository.js";
import { IGraphExecutionEngine } from "../interfaces/graph-execution-engine.js";
import { AgentMessageQueue } from "../services/agent-message-queue.js";
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
  ): Promise<NodeExecutionResult> {
    if (!isConditionNode(node)) {
      throw new InternalError("ConditionHandler can only execute condition nodes", {
        nodeType: node.type,
      });
    }

    const conditionNode = node as ConditionNode;
    const timer = this.logger.startTimer();

    this.logger.info("Auto-executing condition node", {
      nodeId: conditionNode.id,
      executionId: context.executionId,
      operator: conditionNode.condition.operator,
    });

    // Evaluate condition automatically
    const result = await this.evaluateCondition(conditionNode.condition, context);

    if (result.error) {
      throw new InternalError(`Condition evaluation failed: ${result.error}`, {
        nodeId: conditionNode.id,
      });
    }

    const outputPath = result.result ? "true" : "false";
    const executionTime = timer.elapsed();

    this.logger.info("Condition auto-evaluated, continuing execution", {
      nodeId: conditionNode.id,
      conditionResult: result.result,
      outputPath,
      executionTime,
      evaluatedValues: result.evaluatedValues,
    });

    // IMMEDIATELY continue to next node - no agent interaction
    return NodeResultBuilder.continue(conditionNode.id, outputPath, {
      conditionResult: result.result,
      evaluatedValues: result.evaluatedValues,
    });
  }

  /**
   * Evaluate StructuredCondition safely
   */
  private async evaluateCondition(condition: StructuredCondition, context: ExecutionContext) {
    const evaluatedValues: Record<string, unknown> = {};

    try {
      const result = await this.evaluateStructuredCondition(condition, context, evaluatedValues);

      return {
        result,
        evaluatedValues,
      };
    } catch (error) {
      return {
        result: false,
        evaluatedValues,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Recursive evaluation of structured conditions
   */
  private async evaluateStructuredCondition(
    condition: StructuredCondition,
    context: ExecutionContext,
    evaluatedValues: Record<string, unknown>,
  ): Promise<boolean> {
    switch (condition.operator) {
      case "eq": {
        const leftEq = this.resolveValue(condition.left!, context, evaluatedValues);
        const rightEq = this.resolveValue(condition.right!, context, evaluatedValues);
        return leftEq === rightEq;
      }

      case "exists": {
        const valueToCheck = this.resolveValue(condition.value!, context, evaluatedValues);
        return valueToCheck !== undefined && valueToCheck !== null;
      }

      case "gt": {
        const leftGt = Number(this.resolveValue(condition.left!, context, evaluatedValues));
        const rightGt = Number(this.resolveValue(condition.right!, context, evaluatedValues));
        return leftGt > rightGt;
      }

      case "gte": {
        const leftGte = Number(this.resolveValue(condition.left!, context, evaluatedValues));
        const rightGte = Number(this.resolveValue(condition.right!, context, evaluatedValues));
        return leftGte >= rightGte;
      }

      case "lt": {
        const leftLt = Number(this.resolveValue(condition.left!, context, evaluatedValues));
        const rightLt = Number(this.resolveValue(condition.right!, context, evaluatedValues));
        return leftLt < rightLt;
      }

      case "lte": {
        const leftLte = Number(this.resolveValue(condition.left!, context, evaluatedValues));
        const rightLte = Number(this.resolveValue(condition.right!, context, evaluatedValues));
        return leftLte <= rightLte;
      }

      case "neq": {
        const leftNeq = this.resolveValue(condition.left!, context, evaluatedValues);
        const rightNeq = this.resolveValue(condition.right!, context, evaluatedValues);
        return leftNeq !== rightNeq;
      }

      case "contains": {
        const leftContains = this.resolveValue(condition.left!, context, evaluatedValues);
        const rightContains = this.resolveValue(condition.right!, context, evaluatedValues);
        if (typeof leftContains === "string" && typeof rightContains === "string") {
          return leftContains.includes(rightContains);
        }
        if (Array.isArray(leftContains)) {
          return leftContains.includes(rightContains);
        }
        return false;
      }

      case "and": {
        const andCondition = condition as { conditions?: unknown[] };
        if (!andCondition.conditions || !Array.isArray(andCondition.conditions)) {
          throw new ValidationError("'and' operator requires 'conditions' array");
        }
        for (const subCondition of andCondition.conditions) {
          const subResult = await this.evaluateStructuredCondition(
            subCondition as StructuredCondition,
            context,
            evaluatedValues,
          );
          if (!subResult) return false; // Short-circuit on first false
        }
        return true;
      }

      case "or": {
        const orCondition = condition as { conditions?: unknown[] };
        if (!orCondition.conditions || !Array.isArray(orCondition.conditions)) {
          throw new ValidationError("'or' operator requires 'conditions' array");
        }
        for (const subCondition of orCondition.conditions) {
          const subResult = await this.evaluateStructuredCondition(
            subCondition as StructuredCondition,
            context,
            evaluatedValues,
          );
          if (subResult) return true; // Short-circuit on first true
        }
        return false;
      }

      case "not": {
        const notCondition = condition as { condition?: StructuredCondition };
        if (!notCondition.condition) {
          throw new ValidationError("'not' operator requires 'condition' property");
        }
        const negateResult = await this.evaluateStructuredCondition(
          notCondition.condition,
          context,
          evaluatedValues,
        );
        return !negateResult;
      }

      default:
        throw new ValidationError(
          `Condition operator '${condition.operator}' not implemented yet`,
          {
            operator: condition.operator,
          },
        );
    }
  }

  /**
   * Resolve condition value (literal or context path)
   */
  private resolveValue(
    value: string | number | boolean | null | { contextPath: string },
    context: ExecutionContext,
    evaluatedValues: Record<string, unknown>,
  ): unknown {
    // Literal value
    if (value === null || typeof value !== "object") {
      return value;
    }

    // Context path resolution
    if ("contextPath" in value) {
      const path = value.contextPath;
      const resolvedValue = this.getNestedValue(context.variables, path);
      evaluatedValues[path] = resolvedValue;
      return resolvedValue;
    }

    return value;
  }

  /**
   * Get nested value from context
   */
  private getNestedValue(obj: Record<string, unknown>, path: string): unknown {
    if (!path) return obj;

    const segments = path.split(".");
    let current: unknown = obj;

    for (const segment of segments) {
      if (current === null || current === undefined) {
        return undefined;
      }
      current = (current as Record<string, unknown>)[segment];
    }

    return current;
  }

  canExecute(node: GraphNode, _context: ExecutionContext): boolean {
    return isConditionNode(node);
  }
}
