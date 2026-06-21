/**
 * Pure model for the execution context variable editor.
 *
 * Combines an execution's context variables with the workflow definition to produce a
 * displayable list. The variable model is the registry/node-local model:
 *  - GLOBAL variables are declared once in the workflow `variableRegistry`; they live at the top
 *    level of the execution context and are referenced by bare name. Their description comes from
 *    the registry (single source of truth).
 *  - NODE-LOCAL scopes are the per-node result objects, keyed at the top level by node id; their
 *    fields are referenced as `node-id.name`.
 *  - Anything else at the top level (neither a registry global nor a node id) is "runtime" — a
 *    value that appeared during execution without a declaration.
 *
 * No UI here — this is the data backbone consumed by the tree editor (which renders nesting,
 * filtering, and per-path editing itself).
 */

import type { WorkflowGraph } from "../types/workflow-types";

export type VariableOrigin = "global" | "node-local" | "runtime";

/** Field a text filter matches against. */
export type VariableFilterField = "key" | "value" | "both";

export interface ContextVariable {
  name: string;
  value: unknown;
  /** "global" (registry), "node-local" (a node-id scope), or "runtime" (undeclared). */
  origin: VariableOrigin;
  /** Human-readable description from the registry (globals only), or undefined. */
  description?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Names declared as global variables in the workflow `variableRegistry`. */
export function getGlobalVariableNames(workflow: WorkflowGraph | undefined): Set<string> {
  const names = new Set<string>();
  const registry = workflow?.variableRegistry;
  if (!isRecord(registry)) return names;
  for (const key of Object.keys(registry)) names.add(key);
  return names;
}

/** Set of node ids in the workflow (a top-level context key matching one is a node-local scope). */
export function getNodeIds(workflow: WorkflowGraph | undefined): Set<string> {
  const ids = new Set<string>();
  for (const node of workflow?.nodes ?? []) {
    if (node?.id) ids.add(node.id);
  }
  return ids;
}

/**
 * Map of global variable name -> description, from the workflow `variableRegistry`
 * (single source of truth).
 */
export function getVariableDescriptions(
  workflow: WorkflowGraph | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  const registry = workflow?.variableRegistry;
  if (!isRecord(registry)) return out;
  for (const [name, decl] of Object.entries(registry)) {
    if (isRecord(decl) && typeof decl.description === "string" && decl.description.length > 0) {
      out[name] = decl.description;
    }
  }
  return out;
}

/**
 * Build the displayable top-level variable model from an execution's context variables plus the
 * workflow definition. Pure: no sorting/filtering applied (the tree editor composes those).
 */
export function buildContextVariables(
  variables: Record<string, unknown> | undefined,
  workflow: WorkflowGraph | undefined,
): ContextVariable[] {
  const globalNames = getGlobalVariableNames(workflow);
  const nodeIds = getNodeIds(workflow);
  const descriptions = getVariableDescriptions(workflow);

  return Object.entries(variables ?? {}).map(([name, value]) => {
    let origin: VariableOrigin;
    if (globalNames.has(name)) origin = "global";
    else if (nodeIds.has(name)) origin = "node-local";
    else origin = "runtime";
    return {
      name,
      value,
      origin,
      description: origin === "global" ? descriptions[name] : undefined,
    };
  });
}

/** Alphabetical (case-insensitive, then case-sensitive tiebreak) by variable name. */
export function sortVariablesByName(vars: ContextVariable[]): ContextVariable[] {
  return [...vars].sort((a, b) => {
    const an = a.name.toLowerCase();
    const bn = b.name.toLowerCase();
    if (an < bn) return -1;
    if (an > bn) return 1;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });
}
