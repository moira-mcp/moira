/**
 * Keeping `gateWaiting` true to a workflow's current definition.
 *
 * The engine decides whether a paused run waits for a person when the run arrives at a step. A new
 * version of the workflow can mark, unmark or change the gate of the step a run is already standing
 * on, and nothing would move that run to re-decide, so storing a version re-decides the paused runs
 * whose current node's gate it changed — and only those: a save that leaves the gate alone keeps the
 * arrival decision, even if the run's variables have moved since. It runs inside the caller's
 * transaction, with synchronous statements, so the definition and the flags it implies are committed
 * together; the caller reads the previous definition (`storedGraphNodes`) before overwriting it.
 */

import { and, eq } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type { WorkflowGraph } from "@mcp-moira/workflow-engine";
import { humanGateChanged, humanGateWaiting } from "@mcp-moira/workflow-engine/human-gate";
import { workflow, workflowExecution } from "./schema.js";
import { enqueueWaitingNotification } from "./execution-notification.js";
import type * as schema from "./schema.js";

type GraphNodes = Pick<WorkflowGraph, "nodes">;

/** The stored definition's nodes, or null when the workflow is absent or its graph unreadable. */
export function storedGraphNodes(
  db: BetterSQLite3Database<typeof schema>,
  workflowId: string,
): GraphNodes | null {
  const row = db
    .select({ graph: workflow.graph })
    .from(workflow)
    .where(eq(workflow.id, workflowId))
    .get();
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.graph) as Partial<GraphNodes>;
    return Array.isArray(parsed.nodes) ? { nodes: parsed.nodes } : null;
  } catch {
    return null;
  }
}

/**
 * Re-decide `gateWaiting` for the workflow's paused runs whose current node's gate differs between
 * `previous` and `graph` (every paused run when `previous` is null); returns how many rows changed.
 */
export function recomputeGateWaiting(
  db: BetterSQLite3Database<typeof schema>,
  workflowId: string,
  previous: GraphNodes | null,
  graph: GraphNodes,
): number {
  const paused = db
    .select({
      executionId: workflowExecution.executionId,
      workflowId: workflowExecution.workflowId,
      state: workflowExecution.state,
      currentNodeId: workflowExecution.currentNodeId,
      waitingForInputNodeId: workflowExecution.waitingForInputNodeId,
      context: workflowExecution.context,
      gateWaiting: workflowExecution.gateWaiting,
    })
    .from(workflowExecution)
    .where(
      and(eq(workflowExecution.workflowId, workflowId), eq(workflowExecution.state, "running")),
    )
    .all();

  let changed = 0;
  for (const row of paused) {
    if (!humanGateChanged(previous, graph, row.currentNodeId)) continue;
    let globalContext;
    try {
      globalContext = JSON.parse(row.context);
    } catch {
      continue; // An unreadable context cannot satisfy a condition; the row keeps its flag.
    }
    const waiting = humanGateWaiting(graph, {
      executionId: row.executionId,
      workflowId: row.workflowId,
      status: row.state as "running",
      currentNodeId: row.currentNodeId,
      waitingForInputNodeId: row.waitingForInputNodeId,
      globalContext,
    });
    if (waiting === row.gateWaiting) continue;
    db.update(workflowExecution)
      .set({ gateWaiting: waiting })
      .where(eq(workflowExecution.executionId, row.executionId))
      .run();
    // A run the new definition puts into a person's wait is announced like any arrival.
    if (waiting) enqueueWaitingNotification(db, row.executionId);
    changed += 1;
  }
  return changed;
}
