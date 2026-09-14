/**
 * Lookups the variables surfaces share: which top-level context keys are declared globals
 * (the workflow `variableRegistry`), which are node-local scopes (node ids), and the registry's
 * descriptions. The rows themselves are built by `components/run/variableRows.ts`.
 */

import type { WorkflowGraph } from "../types/workflow-types";

/** Field a text filter matches against. */
export type VariableFilterField = "key" | "value" | "both";

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
