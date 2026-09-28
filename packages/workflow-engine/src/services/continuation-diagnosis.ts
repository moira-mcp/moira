import type { IDataRepository } from "../interfaces/data-repository.js";
import type { ExecutionAttempt, WorkflowExecution } from "../types/index.js";
import type { GraphNode, VariableRegistry } from "../types/graph-nodes.js";
import { getNodeOutputScope, inlineGlobalInputs } from "../types/graph-nodes.js";
import { parseExpressionAst, type ASTNode } from "../expression/expression-parser.js";
import { GraphTemplateProcessor } from "../templates/graph-template-processor.js";
import { SchemaValidator } from "../utils/schema-validator.js";
import {
  continuationFactDifference,
  continuationFacts,
  continuationSurfaceDigest,
} from "./continuation-surface.js";

/**
 * Why a paused run can or cannot continue against the definition as it stands now.
 *
 * Every way continuation can be refused has a named cause here, so an agent that meets a stale
 * attempt is never told only that something is wrong. The causes are also the vocabulary recovery
 * uses to decide whether a run is eligible to be repaired, which is why they are structured rather
 * than rendered as prose.
 *
 * Not every cause blocks. Each carries `blocks`, which separates the two kinds:
 *
 * - **Blocking** means the run cannot reach its next `step()` without repair. These are what make
 *   a run eligible for recovery.
 * - **Non-blocking** means the run can still get there — either on its own (`step()` simply works)
 *   or after an ordinary `current_step` refresh, which rebinds a revision-stale presentation and
 *   installs a missing one. These are reported because they explain what an agent is seeing, not
 *   because anything is broken.
 *
 * The distinction is load-bearing rather than cosmetic. A recorded execution error, for instance,
 * is written by the engine's own retry path when an agent answers with the wrong shape, and errors
 * are never cleared — treating it as blocking would mark every run that ever had a rejected answer
 * permanently unrepairable while `step()` kept working, and would hand recovery a licence to touch
 * healthy runs.
 */
export type ContinuationCause = { blocks: boolean } &
  /** The execution is not running, so there is no step to continue. Blocks. */
  (
    | { kind: "execution_not_running"; status: string }
    /** The execution has no current node — it never paused, or it finished. Blocks. */
    | { kind: "no_current_node" }
    /** The workflow definition is gone or no longer readable by this owner. Blocks. */
    | { kind: "workflow_unavailable"; workflowId: string }
    /** The run is paused but carries no step attempt; `current_step` installs one. Does not block. */
    | { kind: "no_presented_attempt" }
    /**
     * An attempt exists but is not presented. `executing` means another caller owns it and the run
     * is healthy; `outcome_unknown` means its effect could not be proven and it will never be
     * retried automatically, which does block.
     */
    | { kind: "attempt_not_presented"; state: string }
    /** The attempt predates the continuation binding, so it can never match. Blocks. */
    | { kind: "attempt_unbound" }
    /** The attempt belongs to a different node or workflow than the execution is on. Blocks. */
    | { kind: "attempt_foreign"; attemptNodeId: string | null; attemptWorkflowId: string }
    /** The execution moved on while this attempt stayed presented; `current_step` rebinds it. */
    | { kind: "execution_revision_advanced"; boundRevision: number | null; currentRevision: number }
    /** The node the run is paused on no longer exists in the definition. Blocks. */
    | { kind: "node_missing"; nodeId: string }
    /** Named facts of the continuation surface that changed, disappeared, or appeared. Blocks. */
    | { kind: "continuation_changed"; changed: string[]; removed: string[]; added: string[] }
    /** The attempt carries no fact map, so the mismatch cannot be attributed. Blocks. */
    | { kind: "continuation_changed_unattributable" }
    /**
     * The presented step interpolates references the context cannot resolve. The directive is shown
     * with a placeholder where a value belongs, which is worth knowing and does not stop `step()`.
     */
    | { kind: "unresolved_references"; references: string[] }
    /** An expression needs persisted state this step's answer cannot supply. Blocks. */
    | { kind: "missing_expression_variables"; nodeId: string; variables: string[] }
    /**
     * The execution recorded an error. Errors are append-only and the engine's retry path writes
     * them, so this reports history rather than an obstacle.
     */
    | { kind: "recorded_error"; nodeId: string; message: string }
  );

export interface ContinuationDiagnosis {
  executionId: string;
  workflowId: string;
  /**
   * True when no cause blocks — the run can reach its next `step()` without repair, possibly after
   * an ordinary `current_step` refresh. Non-blocking causes may still be present and named.
   */
  continuable: boolean;
  currentNodeId: string | null;
  /** Whether that node still exists in the current definition. */
  currentNodeExists: boolean;
  attempt: {
    attemptId: string;
    state: string;
    boundNodeId: string | null;
    boundExecutionRevision: number | null;
    /** Whether the attempt's binding still matches the definition as it stands. */
    boundToCurrentDefinition: boolean;
  } | null;
  executionRevision: number;
  causes: ContinuationCause[];
}

/**
 * Every authored string a pausing node renders when it is presented to an agent.
 *
 * Only the fields that reach the agent belong here: they are the ones an unresolved reference would
 * actually damage. The list follows the handlers that pause, so a node type added to that set
 * without being added here reports no references rather than the wrong ones — visible as a target
 * that recovery accepts and that then presents with a placeholder, not as a silent wrong answer.
 */
function presentedTexts(node: GraphNode): string[] {
  const strings = (value: unknown): string[] =>
    typeof value === "string" && value.length > 0 ? [value] : [];
  const fields = node as {
    directive?: unknown;
    completionCondition?: unknown;
    reason?: unknown;
    basePath?: unknown;
    files?: unknown;
  };

  const texts = [
    ...strings(fields.directive),
    ...strings(fields.completionCondition),
    ...strings(fields.reason),
    ...strings(fields.basePath),
  ];

  if (Array.isArray(fields.files)) {
    // A file's path is authored text and may interpolate; its content is not authored here at all,
    // it is named by `from` and read from the registry, so an absent source is a different failure
    // than an unresolved reference and is not this function's subject.
    for (const file of fields.files) {
      texts.push(...strings((file as { path?: unknown })?.path));
    }
  }
  return texts;
}

/**
 * References the paused step would present unresolved.
 *
 * The references are read off everything the node presents through, which is not the same set of
 * fields for every type that can pause: an `agent-directive` presents its directive and completion
 * condition, a `materialize` node its base path and the paths of its files, and a
 * `lock` node its reason. Reading only the first two would let a run be recovered to a target whose
 * text still carries a reference nothing can resolve. Whether
 * each one resolves is decided by rendering it through the engine's own template processor against
 * the run's context: an unresolved reference renders to the processor's undefined placeholder. That
 * keeps one owner for what a reference means — a second resolver here would drift from the one that
 * actually presents the step — while still being able to name which references are missing, which
 * the rendered text alone cannot say, because the placeholder carries no name.
 *
 * The fragment-variable set is recomputed from the registry before rendering, as every other place
 * that renders a stored context does. A context read back from storage carries that set as plain
 * JSON rather than a Set, and the processor treats the resulting failure as an unresolved variable —
 * so rendering a stored context without recomputing it reports every reference as missing.
 */
export async function unresolvedReferences(
  node: GraphNode,
  execution: WorkflowExecution,
  registry: VariableRegistry | undefined,
): Promise<string[]> {
  const references = new Set<string>();
  for (const text of presentedTexts(node)) {
    // The body is captured whole and trimmed here rather than by padding the pattern with `\s*`
    // around a lazy quantifier: that shape lets the engine split leading spaces between two parts of
    // the pattern, which is quadratic on adversarial text, and this text comes from a workflow
    // definition that a user authored.
    for (const match of text.matchAll(/\{\{([^{}]*)\}\}/g)) {
      const reference = match[1].trim();
      if (reference.length > 0) references.add(reference);
    }
  }
  if (references.size === 0) return [];

  const processor = new GraphTemplateProcessor();
  const unresolved: string[] = [];
  for (const reference of references) {
    const rendered = await processor.processDirectiveAsync(`{{${reference}}}`, {
      ...execution.globalContext,
      _templateFragmentVars: GraphTemplateProcessor.computeFragmentVars(registry),
    });
    if (rendered.includes(GraphTemplateProcessor.UNDEFINED_PLACEHOLDER)) {
      unresolved.push(reference);
    }
  }
  return unresolved.sort();
}

function collectMissingExpressionReads(
  ast: ASTNode,
  available: Set<string>,
  missing: Set<string>,
): void {
  switch (ast.type) {
    case "Identifier": {
      const root = /^[A-Za-z_][A-Za-z0-9_]*/.exec(ast.name)?.[0];
      const indices = [...ast.name.matchAll(/\[([A-Za-z_][A-Za-z0-9_]*)\]/g)].map(
        (match) => match[1],
      );
      for (const name of root ? [root, ...indices] : indices) {
        if (!available.has(name)) missing.add(name);
      }
      return;
    }
    case "BinaryExpression":
      collectMissingExpressionReads(ast.left, available, missing);
      collectMissingExpressionReads(ast.right, available, missing);
      return;
    case "AssignmentExpression":
      collectMissingExpressionReads(ast.value, available, missing);
      available.add(ast.target);
      return;
    default:
      return;
  }
}

/** Prove only simple type exclusions; unresolved JSON Schema constraints remain answer-capable. */
function schemaMayAcceptObject(schema: unknown): boolean {
  if (schema === false) return false;
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return true;
  const shape = schema as Record<string, unknown>;
  const type = shape.type;
  if (typeof type === "string" && type !== "object") return false;
  if (Array.isArray(type) && !type.includes("object")) return false;

  if (Array.isArray(shape.allOf) && shape.allOf.some((part) => !schemaMayAcceptObject(part))) {
    return false;
  }
  for (const keyword of ["anyOf", "oneOf"] as const) {
    const alternatives = shape[keyword];
    if (
      Array.isArray(alternatives) &&
      alternatives.length > 0 &&
      alternatives.every((part) => !schemaMayAcceptObject(part))
    ) {
      return false;
    }
  }
  return true;
}

/** Only assertions that every object carrying `name` satisfies may establish a negated ban. */
function negationForbidsProperty(
  schema: unknown,
  name: string,
  mandatory: ReadonlySet<string>,
): boolean {
  if (schema === true) return true;
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return false;
  const shape = schema as Record<string, unknown>;
  const annotations = new Set([
    "$comment",
    "title",
    "description",
    "default",
    "examples",
    "readOnly",
    "writeOnly",
  ]);
  if (
    Object.keys(shape).some((key) => !annotations.has(key) && key !== "type" && key !== "required")
  ) {
    return false;
  }
  const type = shape.type;
  if (
    type !== undefined &&
    type !== "object" &&
    (!Array.isArray(type) || !type.includes("object"))
  ) {
    return false;
  }
  const required = shape.required;
  return (
    required === undefined ||
    (Array.isArray(required) && required.every((key) => key === name || mandatory.has(key)))
  );
}

/** A literal pattern can be decided without executing an authored regular expression. */
function literalPatternMatch(pattern: string, name: string): boolean | null {
  const exact = /^\^([A-Za-z_][A-Za-z0-9_]*)\$$/.exec(pattern);
  if (exact) return exact[1] === name;
  const literal = /^[A-Za-z_][A-Za-z0-9_]*$/.exec(pattern);
  if (literal) return name.includes(literal[0]);
  return null;
}

/** Names every valid object for this schema must carry; unknown conditions add no names. */
function guaranteedRequiredKeys(schema: unknown, cache: WeakMap<object, Set<string>>): Set<string> {
  const required = new Set<string>();
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return required;
  const cached = cache.get(schema);
  if (cached) return cached;
  const shape = schema as Record<string, unknown>;
  if (Array.isArray(shape.required)) {
    for (const key of shape.required) if (typeof key === "string") required.add(key);
  }
  if (Array.isArray(shape.allOf)) {
    for (const part of shape.allOf) {
      for (const key of guaranteedRequiredKeys(part, cache)) required.add(key);
    }
  }
  for (const keyword of ["anyOf", "oneOf"] as const) {
    const alternatives = shape[keyword];
    if (!Array.isArray(alternatives) || alternatives.length === 0) continue;
    const common = new Set(guaranteedRequiredKeys(alternatives[0], cache));
    for (const part of alternatives.slice(1)) {
      const branch = guaranteedRequiredKeys(part, cache);
      for (const key of common) if (!branch.has(key)) common.delete(key);
    }
    for (const key of common) required.add(key);
  }
  cache.set(schema, required);
  return required;
}

/**
 * One-sided presence proof: false means this schema cannot accept an object containing `name`.
 * True means only that such an answer remains possible or unproved, never that one was found.
 */
function schemaMayAllowTopLevelKey(
  schema: unknown,
  name: string,
  requiredByConjunction: ReadonlySet<string> = new Set(),
  requiredCache: WeakMap<object, Set<string>> = new WeakMap(),
): boolean {
  if (!schemaMayAcceptObject(schema)) return false;
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return true;
  const shape = schema as Record<string, unknown>;
  const mandatory = new Set([
    ...requiredByConjunction,
    ...guaranteedRequiredKeys(schema, requiredCache),
  ]);

  if (Object.prototype.hasOwnProperty.call(shape, "const")) {
    const value = shape.const;
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      !Object.prototype.hasOwnProperty.call(value, name)
    ) {
      return false;
    }
  }
  if (
    Array.isArray(shape.enum) &&
    shape.enum.every(
      (value) =>
        !value ||
        typeof value !== "object" ||
        Array.isArray(value) ||
        !Object.prototype.hasOwnProperty.call(value, name),
    )
  ) {
    return false;
  }

  if (
    typeof shape.maxProperties === "number" &&
    mandatory.size <= shape.maxProperties &&
    new Set([...mandatory, name]).size > shape.maxProperties
  ) {
    return false;
  }

  const properties =
    shape.properties && typeof shape.properties === "object" && !Array.isArray(shape.properties)
      ? (shape.properties as Record<string, unknown>)
      : null;
  if (
    properties &&
    Object.prototype.hasOwnProperty.call(properties, name) &&
    properties[name] === false
  ) {
    return false;
  }
  let patternCouldMatch = false;
  const patterns =
    shape.patternProperties &&
    typeof shape.patternProperties === "object" &&
    !Array.isArray(shape.patternProperties)
      ? (shape.patternProperties as Record<string, unknown>)
      : null;
  if (patterns) {
    for (const [pattern, constraint] of Object.entries(patterns)) {
      const matches = literalPatternMatch(pattern, name);
      if (matches !== false) patternCouldMatch = true;
      if (matches === true && constraint === false) return false;
    }
  }
  if (
    shape.additionalProperties === false &&
    !(properties && Object.prototype.hasOwnProperty.call(properties, name)) &&
    !patternCouldMatch
  ) {
    return false;
  }
  if (negationForbidsProperty(shape.not, name, mandatory)) return false;
  if (
    Array.isArray(shape.allOf) &&
    shape.allOf.some((part) => !schemaMayAllowTopLevelKey(part, name, mandatory, requiredCache))
  ) {
    return false;
  }
  for (const keyword of ["anyOf", "oneOf"] as const) {
    const alternatives = shape[keyword];
    if (
      Array.isArray(alternatives) &&
      alternatives.length > 0 &&
      alternatives.every((part) => !schemaMayAllowTopLevelKey(part, name, mandatory, requiredCache))
    ) {
      return false;
    }
  }
  return true;
}

/**
 * Names roots proven unavailable from saved context and any answer that can pass both input
 * validation and output routing. Unproved schema shapes remain answer-capable. Authored expressions
 * run in order, so an earlier assignment can satisfy a later read. A failed-step caller may stop at
 * its actual failure index; diagnosis scans the whole node. An error edge can route a failure.
 */
export function missingExpressionVariables(
  node: GraphNode,
  variables: Record<string, unknown>,
  registry: VariableRegistry | undefined,
  throughExpressionIndex?: number,
): string[] {
  if (node.type !== "agent-directive" || !node.expressions?.length || node.connections.error) {
    return [];
  }

  const effectiveSchema = (inlineGlobalInputs(node, registry) as { inputSchema?: unknown })
    .inputSchema;
  const schema = effectiveSchema
    ? SchemaValidator.enforceStrictSchema(effectiveSchema as Record<string, unknown>)
    : null;
  const outputScope = getNodeOutputScope(node);
  const requiredCache = new WeakMap<object, Set<string>>();

  const available = new Set(
    Object.entries(variables)
      .filter(([, value]) => value !== undefined && value !== null)
      .map(([name]) => name),
  );
  available.add(node.id); // The handler merges the current answer under the node's own id.
  if (schema?.properties && typeof schema.properties === "object") {
    for (const name of Object.keys(schema.properties)) {
      // Both the output declaration and effective input schema must allow the answer key.
      if (
        (outputScope.localOutputs.has(name) || outputScope.globalInputs.has(name)) &&
        schemaMayAllowTopLevelKey(schema, name, new Set(), requiredCache)
      ) {
        available.add(name);
      }
    }
  }

  const missing = new Set<string>();
  for (const [index, expression] of node.expressions.entries()) {
    if (throughExpressionIndex !== undefined && index > throughExpressionIndex) break;
    let ast: ASTNode;
    try {
      ast = parseExpressionAst(expression);
    } catch {
      // Invalid authoring is not evidence that persisted execution state is missing.
      return [];
    }
    collectMissingExpressionReads(ast, available, missing);
  }
  return [...missing].sort();
}

function parseFacts(raw: string | null): Record<string, string> | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, string>;
  } catch {
    return null;
  }
}

/**
 * Diagnose one execution the caller owns. Read-only: nothing about the execution, its attempt or its
 * context is changed. A healthy run is diagnosed too, and reports itself continuable with no causes.
 */
export async function diagnoseContinuation(
  repository: IDataRepository,
  execution: WorkflowExecution,
  attempt: ExecutionAttempt | null,
): Promise<ContinuationDiagnosis> {
  const causes: ContinuationCause[] = [];
  const graph = await repository.getWorkflowGraph(execution.workflowId, execution.userId);
  const currentNodeId = execution.currentNodeId ?? null;
  const node = currentNodeId
    ? (graph?.nodes.find((candidate) => candidate.id === currentNodeId) ?? null)
    : null;

  if (execution.status !== "running" && execution.status !== "waiting") {
    causes.push({ kind: "execution_not_running", status: execution.status, blocks: true });
  }
  if (!currentNodeId) causes.push({ kind: "no_current_node", blocks: true });

  for (const recorded of execution.errors ?? []) {
    causes.push({
      kind: "recorded_error",
      nodeId: recorded.nodeId,
      message: recorded.message,
      blocks: false,
    });
  }

  if (!graph) {
    causes.push({ kind: "workflow_unavailable", workflowId: execution.workflowId, blocks: true });
  } else if (currentNodeId && !node) {
    causes.push({ kind: "node_missing", nodeId: currentNodeId, blocks: true });
  }

  if (node) {
    const unresolved = await unresolvedReferences(node, execution, graph?.variableRegistry);
    if (unresolved.length > 0) {
      causes.push({ kind: "unresolved_references", references: unresolved, blocks: false });
    }
    const missing = missingExpressionVariables(
      node,
      execution.globalContext.variables,
      graph?.variableRegistry,
    );
    if (missing.length > 0) {
      causes.push({
        kind: "missing_expression_variables",
        nodeId: node.id,
        variables: missing,
        blocks: true,
      });
    }
  }

  let boundToCurrentDefinition = false;
  if (!attempt) {
    if (currentNodeId) causes.push({ kind: "no_presented_attempt", blocks: false });
  } else {
    if (attempt.state !== "presented") {
      causes.push({
        kind: "attempt_not_presented",
        state: attempt.state,
        blocks: attempt.state === "outcome_unknown",
      });
    }
    if (attempt.nodeId !== currentNodeId || attempt.workflowId !== execution.workflowId) {
      causes.push({
        kind: "attempt_foreign",
        attemptNodeId: attempt.nodeId,
        attemptWorkflowId: attempt.workflowId,
        blocks: true,
      });
    } else if (attempt.continuationDigest === null) {
      causes.push({ kind: "attempt_unbound", blocks: true });
    } else if (graph && currentNodeId) {
      const currentDigest = continuationSurfaceDigest(graph, currentNodeId);
      if (currentDigest === attempt.continuationDigest) {
        boundToCurrentDefinition = true;
      } else {
        const bound = parseFacts(attempt.continuationFacts);
        if (!bound) causes.push({ kind: "continuation_changed_unattributable", blocks: true });
        else {
          causes.push({
            kind: "continuation_changed",
            ...continuationFactDifference(bound, continuationFacts(graph, currentNodeId)),
            blocks: true,
          });
        }
      }
    }
    if (
      boundToCurrentDefinition &&
      attempt.state === "presented" &&
      attempt.executionRevision !== execution.revision
    ) {
      causes.push({
        kind: "execution_revision_advanced",
        boundRevision: attempt.executionRevision,
        currentRevision: execution.revision,
        blocks: false,
      });
    }
  }

  return {
    executionId: execution.executionId,
    workflowId: execution.workflowId,
    continuable: causes.every((cause) => !cause.blocks),
    currentNodeId,
    currentNodeExists: node !== null,
    attempt: attempt
      ? {
          attemptId: attempt.attemptId,
          state: attempt.state,
          boundNodeId: attempt.nodeId,
          boundExecutionRevision: attempt.executionRevision,
          boundToCurrentDefinition,
        }
      : null,
    executionRevision: execution.revision,
    causes,
  };
}
