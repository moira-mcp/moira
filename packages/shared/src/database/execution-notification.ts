/**
 * Queueing the notification that a run waits for its person.
 *
 * A run starts waiting for the person when it arrives at a step marked `humanGate` whose condition
 * held, or when the agent raises its question (`session await-user`). A gate with `notify: auto` (the
 * default) gets the engine's first notification; a gate with `notify: off` is one whose flow sends
 * its own first message, so the queue holds only its reminder, when it has `remindAfter`. Every writer that can put a run into such a wait calls
 * `enqueueWaitingNotification` inside its own transaction, after its write: it reads the row as
 * written and inserts the `first` notification of the current wait, keyed by the wait. The key makes
 * the insert idempotent — a repeated step, a re-presentation or a reconnect finds the row already
 * there — and the transaction makes it atomic with the transition: a step whose commit fails leaves
 * no row. Delivery belongs to the MCP server's sender, which reads the same table.
 */

import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { humanGateDurationMs } from "../utils/human-gate-duration.js";
import { executionNotification, workflow, workflowExecution } from "./schema.js";
import type * as schema from "./schema.js";

type Db = BetterSQLite3Database<typeof schema>;

/** What a stored run waits for from its person right now, or null. */
export interface CurrentPersonWait {
  /** `gate:<seq of the open waited visit>` or `agent:<question id>`. */
  waitKey: string;
  source: "gate" | "agent";
}

interface StoredVisit {
  seq: number;
  nodeId: string;
  exitKey: string | null;
  waited?: boolean;
  adjusted?: boolean;
}

function parse<T>(json: string | null | undefined): T | null {
  if (!json) return null;
  try {
    return JSON.parse(json) as T;
  } catch {
    return null;
  }
}

/**
 * The person-facing wait of a stored run: the agent's open question on the node the run stands on,
 * else a gate the engine marked as waiting (`gateWaiting`) at the run's open waited visit. The
 * question takes precedence, as it does in the progress projection.
 */
export function currentPersonWait(row: {
  state: string;
  currentNodeId: string | null;
  gateWaiting: boolean;
  awaitingUser: string | null;
  visits: string;
}): CurrentPersonWait | null {
  if (row.state !== "running" || !row.currentNodeId) return null;
  const question = parse<{ id?: string; nodeId?: string }>(row.awaitingUser);
  if (question?.id && question.nodeId === row.currentNodeId) {
    return { waitKey: `agent:${question.id}`, source: "agent" };
  }
  if (!row.gateWaiting) return null;
  const visits = parse<StoredVisit[]>(row.visits) ?? [];
  const open = [...visits]
    .reverse()
    .find(
      (visit) => visit.nodeId === row.currentNodeId && !visit.adjusted && visit.exitKey === null,
    );
  // Without an open visit at the node (a run recorded before the route log existed), the key counts
  // only engine visits, so a variable edit — an adjusted visit — does not move it.
  const fallback = `gate:@${visits.filter((visit) => !visit.adjusted).length}`;
  return { waitKey: open ? `gate:${open.seq}` : fallback, source: "gate" };
}

/**
 * Every person-facing wait a stored run holds right now: the agent's open question and, beneath it,
 * a gate the engine marked. The notification of either is still worth sending while its wait holds,
 * even when the other takes precedence on the page.
 */
export function personWaitKeys(row: Parameters<typeof currentPersonWait>[0]): string[] {
  const keys: string[] = [];
  const primary = currentPersonWait(row);
  if (primary) keys.push(primary.waitKey);
  if (primary?.source === "agent" && row.gateWaiting) {
    const gate = currentPersonWait({ ...row, awaitingUser: null });
    if (gate) keys.push(gate.waitKey);
  }
  return keys;
}

/**
 * How the gate of the node a run stands on is announced: `notify` (`auto` when the graph cannot be
 * read) and its reminder delay in milliseconds, or null without a valid `remindAfter`.
 */
function gateAnnouncement(
  db: Db,
  workflowId: string,
  nodeId: string,
): { notify: "auto" | "off"; remindAfterMs: number | null } {
  const row = db
    .select({ graph: workflow.graph })
    .from(workflow)
    .where(eq(workflow.id, workflowId))
    .get();
  const graph = parse<{
    nodes?: Array<{ id?: string; humanGate?: { notify?: string; remindAfter?: string } }>;
  }>(row?.graph);
  const gate = graph?.nodes?.find((candidate) => candidate.id === nodeId)?.humanGate;
  return {
    notify: gate?.notify === "off" ? "off" : "auto",
    remindAfterMs: humanGateDurationMs(gate?.remindAfter),
  };
}

/**
 * Insert the `first` notification of every person-facing wait the run holds, where the row does not
 * exist yet; for a gate with `notify: off` insert instead its single reminder, due `remindAfter`
 * after now — the moment the queue first records the wait, on arrival or on the recompute of a new
 * workflow version (a later call finds the row and leaves its due time alone). Call inside the
 * transaction that wrote the run. Returns the primary key queued with a first notification, or null
 * when the run does not wait for its person or its only wait is a gate with `notify: off`.
 */
export function enqueueWaitingNotification(
  db: Db,
  executionId: string,
  now: number = Date.now(),
): string | null {
  const row = db
    .select({
      userId: workflowExecution.userId,
      workflowId: workflowExecution.workflowId,
      state: workflowExecution.state,
      currentNodeId: workflowExecution.currentNodeId,
      gateWaiting: workflowExecution.gateWaiting,
      awaitingUser: workflowExecution.awaitingUser,
      visits: workflowExecution.visits,
    })
    .from(workflowExecution)
    .where(eq(workflowExecution.executionId, executionId))
    .get();
  if (!row) return null;
  // Every wait the run holds gets its notification: a gate marked beneath an open question is
  // announced too, not only the wait the page shows first.
  const queued: string[] = [];
  for (const waitKey of personWaitKeys(row)) {
    const gate = waitKey.startsWith("gate:")
      ? gateAnnouncement(db, row.workflowId, row.currentNodeId!)
      : null;
    if (gate?.notify === "off" && gate.remindAfterMs === null) continue;
    const reminderOnly = gate?.notify === "off";
    db.insert(executionNotification)
      .values({
        id: randomUUID(),
        executionId,
        userId: row.userId,
        waitKey,
        kind: reminderOnly ? "remind" : "first",
        state: "pending",
        notBefore: reminderOnly ? now + gate.remindAfterMs! : now,
        createdAt: now,
      })
      .onConflictDoNothing()
      .run();
    if (!reminderOnly) queued.push(waitKey);
  }
  return queued[0] ?? null;
}
