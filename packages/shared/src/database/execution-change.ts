/**
 * The change feed of execution rows: one row per change, numbered by `seq`, so a reader that knows
 * the last number it saw can ask for exactly what happened since.
 *
 * Every writer of an execution row records its change here inside its own transaction, so the row
 * and its event commit together or not at all. An event names the run, its owner and the kind of
 * change — never the data: a reader refetches the rows it cares about through the owner-scoped
 * overview. A `deleted` event is written from the rows about to go, before the delete, and has no
 * foreign key so it outlives them.
 */

import { eq, sql } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { executionChange, workflowExecution } from "./schema.js";
import type * as schema from "./schema.js";

type Db = BetterSQLite3Database<typeof schema>;

export type ExecutionChangeKind = "created" | "activity" | "status" | "lock" | "meta" | "deleted";

/** How long events are kept; a cursor older than the oldest kept event is answered with `reset`. */
export const EXECUTION_CHANGE_RETENTION_MS = 24 * 60 * 60 * 1000;

/** The facts of a row that decide the kind of its change. */
export interface ExecutionChangeFacts {
  state: string;
  gateWaiting: boolean;
  awaitingUser: string | null;
  refusalCount: number;
  lastActivityAt: number | null;
}

/**
 * The kind of a change to an existing row: `status` when what the run waits for or how it stands
 * changed, else `activity` when its last event of work moved, else `meta`.
 */
export function executionChangeKind(
  before: ExecutionChangeFacts,
  after: ExecutionChangeFacts,
): ExecutionChangeKind {
  if (
    before.state !== after.state ||
    before.gateWaiting !== after.gateWaiting ||
    before.awaitingUser !== after.awaitingUser ||
    before.refusalCount !== after.refusalCount
  ) {
    return "status";
  }
  return before.lastActivityAt !== after.lastActivityAt ? "activity" : "meta";
}

/** Record one change. Call inside the writer's transaction. */
export function recordExecutionChange(
  db: Db,
  change: { executionId: string; userId: string; kind: ExecutionChangeKind },
  at: number = Date.now(),
): void {
  db.insert(executionChange)
    .values({ executionId: change.executionId, userId: change.userId, kind: change.kind, at })
    .run();
}

/**
 * Record `deleted` for every run a delete is about to remove: the runs of a workflow, of a user, or
 * the runs with these ids. Call inside the deleting transaction, before the delete.
 */
export function recordExecutionsDeleted(
  db: Db,
  scope: { workflowId: string } | { userId: string } | { executionIds: string[] },
  at: number = Date.now(),
): void {
  const where =
    "workflowId" in scope
      ? sql`"workflowId" = ${scope.workflowId}`
      : "userId" in scope
        ? // The user's own runs, and everyone's runs of the workflows the user owns: both cascade.
          sql`("userId" = ${scope.userId} OR "workflowId" IN (SELECT "id" FROM "workflow" WHERE "userId" = ${scope.userId}))`
        : sql`"executionId" IN (SELECT value FROM json_each(${JSON.stringify(scope.executionIds)}))`;
  db.run(
    sql`INSERT INTO "executionChange" ("executionId", "userId", "kind", "at")
        SELECT "executionId", "userId", 'deleted', ${at} FROM "workflowExecution" WHERE ${where}`,
  );
}

/** The stored facts of a run that decide the kind of its change, with its owner. */
function readFacts(
  db: Db,
  executionId: string,
): (ExecutionChangeFacts & { userId: string }) | null {
  const row = db
    .select({
      userId: workflowExecution.userId,
      state: workflowExecution.state,
      gateWaiting: workflowExecution.gateWaiting,
      awaitingUser: workflowExecution.awaitingUser,
      refusalCount: workflowExecution.refusalCount,
      lastActivityAt: workflowExecution.lastActivityAt,
    })
    .from(workflowExecution)
    .where(eq(workflowExecution.executionId, executionId))
    .get();
  return row ?? null;
}

/**
 * Run a write of one existing row and record its change: the row's facts are read before and after
 * the write, and the kind is decided from them. `wrote` says whether the write changed the row (a
 * write refused by its guard records nothing). Call inside the writer's transaction.
 */
export function trackExecutionChange<T>(
  db: Db,
  executionId: string,
  write: () => T,
  wrote: (result: T) => boolean,
  at: number = Date.now(),
): T {
  const before = readFacts(db, executionId);
  const result = write();
  if (!before || !wrote(result)) return result;
  const after = readFacts(db, executionId);
  if (!after) return result;
  recordExecutionChange(
    db,
    { executionId, userId: after.userId, kind: executionChangeKind(before, after) },
    at,
  );
  return result;
}
