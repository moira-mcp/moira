/**
 * Node routing — what a deciding node does between "its work is done" and "the run continues".
 *
 * Both routing node types (`condition`, `agent-directive`) share three steps, in this order:
 *  1. `expressions` run against a working view of the variables; their assignments are declared
 *     globals (registry-validated) and are published only when the whole node succeeds;
 *  2. `cases` are evaluated in authored order against the same view (which already includes the
 *     expression assignments); the first case whose structured condition holds selects its output;
 *  3. when no case holds, the node's default output is taken.
 *
 * A failing expression selects the `error` output when the node has one, otherwise the failure is
 * reported to the handler, which fails the node the way a standalone expression node does.
 *
 * Everything here is pure: the caller owns logging, the execution context and the result.
 */

import { ValidationError } from "@mcp-moira/shared";
import { SafeExpressionInterpreter } from "../expression/index.js";
import type { ExecutionContext, VariableRegistry } from "../types/index.js";
import type { RoutingCase, StructuredCondition } from "../types/index.js";
import type { ConditionValue } from "../types/structured-condition.js";
import { validateDeclaredRegistryValues } from "../utils/registry-value-validator.js";

/** The part of the execution context a condition can read: variables plus engine-owned ids. */
export type RoutingScope = Pick<ExecutionContext, "variables" | "executionId" | "workflowId"> &
  Partial<Pick<ExecutionContext, "userId">>;

export interface ConditionEvaluation {
  result: boolean;
  /** Context paths the evaluation read, with the values it saw (for logs and the run record). */
  evaluatedValues: Record<string, unknown>;
}

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

export interface ExpressionRunResult {
  /** Declared-global assignments, validated against the registry, in evaluation order. */
  assignments: Record<string, unknown>;
  /** Present when an expression failed; nothing in `assignments` may be published then. */
  failure?: { index: number; message: string };
}

const interpreter = new SafeExpressionInterpreter();

/**
 * Run a node's expressions in order over a working copy of `variables`. Each expression sees the
 * assignments of the ones before it. On the first failure the run stops and reports it; the
 * caller decides between the node's `error` output and failing the node.
 */
export function runNodeExpressions(
  expressions: readonly string[] | undefined,
  variables: Record<string, unknown>,
  registry: VariableRegistry | undefined,
  boundary: string,
): ExpressionRunResult {
  const assignments: Record<string, unknown> = {};
  if (!expressions || expressions.length === 0) return { assignments };
  const working = { ...variables };
  for (let index = 0; index < expressions.length; index++) {
    const result = interpreter.evaluate(expressions[index], working);
    if (result.error) {
      return { assignments: {}, failure: { index, message: result.error } };
    }
    let normalized: Record<string, unknown>;
    try {
      normalized = validateDeclaredRegistryValues(
        result.assignments,
        registry,
        `${boundary} index ${index}`,
        true,
      );
    } catch (error) {
      return {
        assignments: {},
        failure: { index, message: error instanceof Error ? error.message : String(error) },
      };
    }
    Object.assign(assignments, normalized);
    Object.assign(working, normalized);
  }
  return { assignments };
}

export interface CaseSelection {
  /** Zero-based index of the case that held, or -1 when the default output was taken. */
  matchedCase: number;
  output: string;
  evaluatedValues: Record<string, unknown>;
}

/** Select the output of a routing node: the first holding case, otherwise `defaultOutput`. */
export function selectOutput(
  cases: readonly RoutingCase[] | undefined,
  defaultOutput: string,
  scope: RoutingScope,
): CaseSelection {
  const evaluatedValues: Record<string, unknown> = {};
  if (cases) {
    for (let index = 0; index < cases.length; index++) {
      if (evaluateStructuredCondition(cases[index].when, scope, evaluatedValues)) {
        return { matchedCase: index, output: cases[index].output, evaluatedValues };
      }
    }
  }
  return { matchedCase: -1, output: defaultOutput, evaluatedValues };
}

export interface NodeRoutingResult {
  output: string;
  matchedCase: number;
  evaluatedValues: Record<string, unknown>;
  /** Declared-global assignments to publish with the node; empty when an expression failed. */
  assignments: Record<string, unknown>;
  /** Set when an expression failed and the node has no `error` output. */
  failure?: { index: number; message: string };
}

/**
 * Route a node: expressions, then cases, then the default. `variables` is the view the node
 * decides on (for a directive: the context plus its validated answer). When an expression fails
 * and the node declares `connections.error`, the result routes there with no assignments; when it
 * fails without an `error` output, `failure` is set and `output` is the default, so the caller can
 * raise the failure the way a standalone expression node does.
 */
export function routeNode(
  node: {
    expressions?: string[];
    cases?: RoutingCase[];
    connections: Record<string, string | undefined>;
  },
  defaultOutput: string,
  scope: RoutingScope,
  registry: VariableRegistry | undefined,
  boundary: string,
): NodeRoutingResult {
  const expressions = runNodeExpressions(node.expressions, scope.variables, registry, boundary);
  if (expressions.failure) {
    return {
      output: node.connections.error ? "error" : defaultOutput,
      matchedCase: -1,
      evaluatedValues: {},
      assignments: {},
      ...(node.connections.error ? {} : { failure: expressions.failure }),
    };
  }
  const view: RoutingScope = {
    ...scope,
    variables: { ...scope.variables, ...expressions.assignments },
  };
  const selection = selectOutput(node.cases, defaultOutput, view);
  return { ...selection, assignments: expressions.assignments };
}
