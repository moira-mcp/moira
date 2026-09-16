/**
 * View model of the flow page: the definition's derived process read through the run page's
 * projection shape with no run in it, so the map renders a definition exactly as it renders a
 * run — every block pending, no route, no cursor — plus the step order a block's panel lists.
 */

import type { ProcessProjection } from "@mcp-moira/workflow-engine/process";
import type { ExecutionProgress } from "@mcp-moira/workflow-engine/progress-visual";
import type { WorkflowGraph } from "../../types/workflow-types";
import type { RunBlock } from "../run/model";

/** Nodes of a block in traversal order: entry nodes first, then breadth-first along in-block edges. */
export function orderedNodeIds(workflow: WorkflowGraph | undefined, block: RunBlock): string[] {
  const nodes = new Map((workflow?.nodes ?? []).map((n) => [n.id, n]));
  const inBlock = new Set(block.nodeIds);
  const targetedFromInside = new Set<string>();
  for (const id of block.nodeIds) {
    for (const target of Object.values(nodes.get(id)?.connections ?? {})) {
      if (inBlock.has(target) && target !== id) targetedFromInside.add(target);
    }
  }
  const entries = block.nodeIds.filter((id) => !targetedFromInside.has(id));
  const queue = entries.length > 0 ? [...entries] : block.nodeIds.slice(0, 1);
  const seen = new Set<string>();
  const order: string[] = [];
  while (queue.length > 0) {
    const id = queue.shift()!;
    if (seen.has(id) || !inBlock.has(id)) continue;
    seen.add(id);
    order.push(id);
    for (const target of Object.values(nodes.get(id)?.connections ?? {})) {
      if (inBlock.has(target) && !seen.has(target)) queue.push(target);
    }
  }
  for (const id of block.nodeIds) if (!seen.has(id)) order.push(id);
  return order;
}

/** A run-less projection of a definition: the process with every block pending. */
export function definitionProgress(
  workflow: WorkflowGraph,
  process: ProcessProjection,
): ExecutionProgress {
  return {
    taskTitle: workflow.metadata.name,
    // The authored run title is a template rendered by a run; a definition shows none.
    title: null,
    goal: workflow.metadata.description || null,
    facts: [],
    activeNodeId: null,
    nodes: process.blocks.map((block) => ({
      id: block.id,
      label: block.label,
      state: "pending",
      status: "pending",
      iterations: 0,
      visits: 0,
      currentNodeId: null,
      connections: {},
      primaryNodeIds: block.nodeIds,
      focusNodeId: null,
      content: { summary: null, details: [], outcome: null, next: null },
      timing: { passes: [], totalMs: null, currentMs: null, recorded: false },
      list: null,
    })),
    workflowVersion: workflow.metadata.version,
    executionWorkflowVersion: null,
    projectedAt: 0,
    waitingFor: null,
    executionRevision: 0,
    executionStatus: "definition",
    diagnostics: process.diagnostics.map((d) => d.message),
    process,
    route: [],
    variables: [],
    routeRecorded: false,
    cursor: null,
    source: "trace",
  };
}
