/**
 * The execution row as the writers store it.
 *
 * Every place that writes a run's cursor — the ordinary save, a start, a recovery, a completed step —
 * stores the same derived columns. They used to serialize the row separately, so a column added to
 * one could be forgotten by another; this module is the one mapping they share. The inventory of
 * writers is pinned by `tests/unit/shared/execution-row-writers.test.ts`.
 */

import { sql, type SQL } from "drizzle-orm";
import type { WorkflowExecution } from "@mcp-moira/workflow-engine";
import { workflowExecution } from "./schema.js";
import { executionActivity } from "./execution-activity.js";

/** The cursor-bearing columns of `workflowExecution`, in the representation raw SQL binds. */
export interface ExecutionRowFields {
  state: string;
  currentNodeId: string | null;
  waitingForInputNodeId: string | null;
  context: string;
  error: string | null;
  errors: string | null;
  note: string | null;
  parentExecutionId: string | null;
  reminders: string;
  visits: string;
  /** SQLite boolean: 1 while the run is paused on a step that waits for a person. */
  gateWaiting: 0 | 1;
  /** Derived from `visits` and `completedAt` (see execution-activity.ts). */
  lastActivityAt: number | null;
  /** Derived from `errors`; only a writer that stores `errors` stores it. */
  refusalCount: number;
  updatedAt: number;
  completedAt: number | null;
}

export function executionRowFields(execution: WorkflowExecution): ExecutionRowFields {
  return {
    state: execution.status,
    currentNodeId: execution.currentNodeId,
    waitingForInputNodeId: execution.waitingForInputNodeId || null,
    context: JSON.stringify(execution.globalContext),
    error: execution.error || null,
    errors:
      execution.errors && execution.errors.length > 0 ? JSON.stringify(execution.errors) : null,
    note: execution.note || null,
    parentExecutionId: execution.parentExecutionId || null,
    reminders: JSON.stringify(execution.reminders ?? []),
    visits: JSON.stringify(execution.visits ?? []),
    gateWaiting: execution.gateWaiting ? 1 : 0,
    ...executionActivity({
      visits: execution.visits,
      completedAt: execution.completedAt ?? null,
      errors: execution.errors,
    }),
    updatedAt: execution.updatedAt,
    completedAt: execution.completedAt ?? null,
  };
}

/**
 * `awaitingUser` after a write that moves the cursor without being the agent's own action (the
 * ordinary save, used by a run-page answer): the stored question stays while the run stays on the
 * node it was asked on and is cleared when the run leaves it or finishes. Evaluated against the
 * stored value in the same statement, so a question raised after the writer loaded the run is kept
 * rather than overwritten with the writer's stale copy.
 */
export function awaitingUserAfterWrite(state: string, currentNodeId: string | null): SQL {
  return sql`CASE
    WHEN ${workflowExecution.awaitingUser} IS NULL THEN NULL
    WHEN ${state} IN ('completed', 'failed') THEN NULL
    WHEN json_valid(${workflowExecution.awaitingUser}) = 0 THEN NULL
    WHEN json_extract(${workflowExecution.awaitingUser}, '$.nodeId') IS ${currentNodeId} THEN ${workflowExecution.awaitingUser}
    ELSE NULL
  END`;
}
