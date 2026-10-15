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

import { SafeExpressionInterpreter } from "../expression/index.js";
import type { VariableRegistry } from "../types/index.js";
import type { RoutingCase } from "../types/index.js";
import { validateDeclaredRegistryValues } from "../utils/registry-value-validator.js";

export { evaluateStructuredCondition, type RoutingScope } from "./structured-condition.js";
import { evaluateStructuredCondition, type RoutingScope } from "./structured-condition.js";

export interface ConditionEvaluation {
  result: boolean;
  evaluatedValues: Record<string, unknown>;
}

export interface ExpressionRunResult {
  /** Declared-global assignments, validated against the registry, in evaluation order. */
  assignments: Record<string, unknown>;
  /** Present when an expression failed; nothing in `assignments` may be published then. */
  failure?: { index: number; message: string; unresolvedRoot?: string };
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
      return {
        assignments: {},
        failure: {
          index,
          message: result.error,
          ...(result.unresolvedRoot ? { unresolvedRoot: result.unresolvedRoot } : {}),
        },
      };
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
  failure?: { index: number; message: string; unresolvedRoot?: string };
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
