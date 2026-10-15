import { ValidationError } from "@mcp-moira/shared/errors";
import type { ExecutionContext } from "../types/base-types.js";
import type { StructuredCondition, ConditionValue } from "../types/structured-condition.js";

/** The part of the execution context a condition can read: variables plus engine-owned ids. */
export type RoutingScope = Pick<ExecutionContext, "variables" | "executionId" | "workflowId"> &
  Partial<Pick<ExecutionContext, "userId">>;

function getNestedValue(obj: Record<string, unknown>, path: string): unknown {
  if (!path) return obj;
  let current: unknown = obj;
  for (const segment of path.split(".")) {
    if (current === null || current === undefined) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/**
 * Resolve a registry/node path, or one of the engine-owned system values that templates and the
 * validator also expose to authors (`executionId`, `workflowId`, `userId`).
 */
function resolveContextPath(scope: RoutingScope, path: string): unknown {
  if (path === "executionId") return scope.executionId;
  if (path === "workflowId") return scope.workflowId;
  if (path === "userId") return scope.userId;
  return getNestedValue(scope.variables, path);
}

function resolveValue(
  value: ConditionValue,
  scope: RoutingScope,
  evaluatedValues: Record<string, unknown>,
): unknown {
  if (value === null || typeof value !== "object") return value;
  if ("contextPath" in value) {
    const resolved = resolveContextPath(scope, value.contextPath);
    evaluatedValues[value.contextPath] = resolved;
    return resolved;
  }
  return value;
}

function numeric(value: unknown): number {
  return Number(value);
}

/** Evaluate a structured condition; throws ValidationError on a malformed condition. */
export function evaluateStructuredCondition(
  condition: StructuredCondition,
  scope: RoutingScope,
  evaluatedValues: Record<string, unknown> = {},
): boolean {
  const binary = () => [
    resolveValue(condition.left!, scope, evaluatedValues),
    resolveValue(condition.right!, scope, evaluatedValues),
  ];
  switch (condition.operator) {
    case "eq": {
      const [left, right] = binary();
      return left === right;
    }
    case "neq": {
      const [left, right] = binary();
      return left !== right;
    }
    case "gt": {
      const [left, right] = binary();
      return numeric(left) > numeric(right);
    }
    case "gte": {
      const [left, right] = binary();
      return numeric(left) >= numeric(right);
    }
    case "lt": {
      const [left, right] = binary();
      return numeric(left) < numeric(right);
    }
    case "lte": {
      const [left, right] = binary();
      return numeric(left) <= numeric(right);
    }
    case "contains": {
      const [left, right] = binary();
      if (typeof left === "string" && typeof right === "string") return left.includes(right);
      if (Array.isArray(left)) return left.includes(right);
      return false;
    }
    case "exists": {
      const value = resolveValue(condition.value!, scope, evaluatedValues);
      return value !== undefined && value !== null;
    }
    case "and": {
      if (!Array.isArray(condition.conditions)) {
        throw new ValidationError("'and' operator requires 'conditions' array");
      }
      for (const sub of condition.conditions) {
        if (!evaluateStructuredCondition(sub, scope, evaluatedValues)) return false;
      }
      return true;
    }
    case "or": {
      if (!Array.isArray(condition.conditions)) {
        throw new ValidationError("'or' operator requires 'conditions' array");
      }
      for (const sub of condition.conditions) {
        if (evaluateStructuredCondition(sub, scope, evaluatedValues)) return true;
      }
      return false;
    }
    case "not": {
      if (!condition.condition) {
        throw new ValidationError("'not' operator requires 'condition' property");
      }
      return !evaluateStructuredCondition(condition.condition, scope, evaluatedValues);
    }
    default:
      throw new ValidationError(`Condition operator '${condition.operator}' not implemented yet`, {
        operator: condition.operator,
      });
  }
}
