/**
 * The variables panel's rows, built from the two sources the run page has: the execution's raw
 * context (every value as it stands now, the thing a per-path edit changes) and, when the run has
 * a process view, the projection's variable states (the value at the cursor and the history of
 * changes). Declared variables are rows; a node's outputs are a group under the node. Pure so the
 * grouping is testable without rendering.
 */

import type { WorkflowGraph } from "../../types/workflow-types";
import type { ExecutionProgress } from "./model";
import {
  getGlobalVariableNames,
  getNodeIds,
  getVariableDescriptions,
} from "../../utils/context-variable-model";

export type VariableState = ExecutionProgress["variables"][number];
export type VariableChange = VariableState["history"][number];

export interface DeclaredRow {
  name: string;
  /** The value shown: the projection's at the cursor when one is set, else the context's. */
  value: unknown;
  description?: string;
  /** The server permits the owner to edit this variable at the current node. */
  editable: boolean;
  history: VariableChange[];
  adjusted: boolean;
}

export interface OutputGroup {
  nodeId: string;
  /** The node's own outputs: the globals it wrote are shown once, under the declared rows. */
  value: Record<string, unknown>;
}

export interface VariableRows {
  declared: DeclaredRow[];
  outputs: OutputGroup[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function byName(a: string, b: string): number {
  const an = a.toLowerCase();
  const bn = b.toLowerCase();
  if (an !== bn) return an < bn ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

export function variableRows(input: {
  context: Record<string, unknown> | undefined;
  workflow: WorkflowGraph | undefined;
  /** The projection's variables (the whole run, or the run at the cursor); absent without a process view. */
  projection?: VariableState[] | null;
  /** A cursor is set: values come from the projection, edits still target the context. */
  atCursor: boolean;
  editableNames: ReadonlySet<string>;
}): VariableRows {
  const context = input.context ?? {};
  const globalNames = getGlobalVariableNames(input.workflow);
  const nodeIds = getNodeIds(input.workflow);
  const descriptions = getVariableDescriptions(input.workflow);
  const states = new Map(
    (input.projection ?? []).filter((v) => v.kind === "variable").map((v) => [v.name, v]),
  );
  // Every declared name, plus any top-level context key that is neither a declaration nor a
  // node scope (the engine refuses those, but a stored context is shown as it is).
  const names = new Set<string>(globalNames);
  for (const key of Object.keys(context)) if (!nodeIds.has(key)) names.add(key);
  const declared: DeclaredRow[] = [...names].sort(byName).map((name) => {
    const state = states.get(name);
    return {
      name,
      value: input.atCursor && state ? state.current : context[name],
      description: descriptions[name],
      editable: input.editableNames.has(name),
      history: state?.history ?? [],
      adjusted: state?.adjusted ?? false,
    };
  });
  const outputs: OutputGroup[] = [];
  for (const nodeId of Object.keys(context).sort(byName)) {
    if (!nodeIds.has(nodeId) || globalNames.has(nodeId)) continue;
    const scope = context[nodeId];
    if (!isRecord(scope)) continue;
    const own = Object.fromEntries(Object.entries(scope).filter(([key]) => !globalNames.has(key)));
    if (Object.keys(own).length === 0) continue;
    outputs.push({ nodeId, value: own });
  }
  return { declared, outputs };
}
