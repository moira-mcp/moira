/**
 * The execution row as the writers store it.
 *
 * Every place that writes a run's cursor — the ordinary save, a start, a recovery, a completed step —
 * stores the same derived columns. They used to serialize the row separately, so a column added to
 * one could be forgotten by another; this module is the one mapping they share. The inventory of
 * writers is pinned by `tests/unit/shared/execution-row-writers.test.ts`.
 */

import type { WorkflowExecution } from "@mcp-moira/workflow-engine";

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
    updatedAt: execution.updatedAt,
    completedAt: execution.completedAt ?? null,
  };
}
