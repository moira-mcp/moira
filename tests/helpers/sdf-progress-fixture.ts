/**
 * The bundled Software Development Flow as a run fixture: the shortest authored route to a node,
 * and an execution paused on it. Shared by the SDF projection suite and the progress-image
 * geometry suite, which needs a real fifteen-block projection with long titles and a bound list.
 */

import type { ExecutionVisit, WorkflowExecution, WorkflowGraph } from "@mcp-moira/workflow-engine";
import { systemCatalogGraph } from "./catalog-graphs.js";

export function sdfWorkflow(): WorkflowGraph {
  return systemCatalogGraph("software-development-flow", "public");
}

/**
 * A route to `target`: the shortest authored path from the start node, every node exited through
 * the connection the path took, the target left open as the wait. Real runs are longer; the
 * shortest path is enough to place the run truthfully on the process.
 */
export function sdfRouteTo(workflow: WorkflowGraph, target: string): ExecutionVisit[] {
  const byId = new Map(workflow.nodes.map((node) => [node.id, node]));
  const start = workflow.nodes.find((node) => node.type === "start")!;
  const previous = new Map<string, { from: string; key: string }>();
  const queue = [start.id];
  const seen = new Set([start.id]);
  while (queue.length) {
    const id = queue.shift()!;
    if (id === target) break;
    const connections = (byId.get(id)?.connections ?? {}) as Record<string, string>;
    for (const [key, next] of Object.entries(connections)) {
      if (seen.has(next)) continue;
      seen.add(next);
      previous.set(next, { from: id, key });
      queue.push(next);
    }
  }
  if (target !== start.id && !previous.has(target)) throw new Error(`${target} is unreachable`);
  const path: Array<{ nodeId: string; exitKey: string | null }> = [
    { nodeId: target, exitKey: null },
  ];
  let cursor = target;
  while (cursor !== start.id) {
    const step = previous.get(cursor)!;
    path.unshift({ nodeId: step.from, exitKey: step.key });
    cursor = step.from;
  }
  return path.map((entry, seq) => ({
    seq,
    ...entry,
    changes: {},
    ...(entry.exitKey === null ? { waited: true } : {}),
  }));
}

/** An SDF execution on `currentNodeId` with the variables the progress blocks read. */
export function sdfExecution(
  workflow: WorkflowGraph,
  currentNodeId: string | null,
  status: "running" | "completed" = "running",
  visits: ExecutionVisit[] = currentNodeId ? sdfRouteTo(workflow, currentNodeId) : [],
): WorkflowExecution {
  return {
    executionId: "sdf-progress-contract",
    workflowId: workflow.id ?? "software-development-flow",
    userId: "test-user",
    currentNodeId,
    waitingForInputNodeId: currentNodeId,
    globalContext: {
      variables: {
        plan_revision: 3,
        current_step_index: 2,
        total_steps: 5,
        current_iteration: 4,
      },
      nodeStates: {},
      executionId: "sdf-progress-contract",
      workflowId: workflow.id ?? "software-development-flow",
      userId: "test-user",
    },
    status,
    revision: 12,
    createdAt: 1,
    updatedAt: 1,
    visits,
  };
}
