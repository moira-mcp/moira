/**
 * The queue of notifications that a run waits for its person (`executionNotification`).
 *
 * Rows are inserted by the execution writers, in the transaction of the transition
 * (`enqueueWaitingNotification`). This repository is what the MCP server's sender and the run page
 * read and what the sender writes the outcome to: the row, not the run's visit log, holds the result.
 */

import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray, isNotNull, like, lte, ne, or } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { executionNotification, workflowExecution } from "../schema.js";
import type * as schema from "../schema.js";
import { currentPersonWait, personWaitKeys } from "../execution-notification.js";

export type ExecutionNotificationKind = "first" | "remind";
export type ExecutionNotificationState = "pending" | "sent" | "superseded";

export interface ExecutionNotificationRow {
  id: string;
  executionId: string;
  userId: string;
  waitKey: string;
  kind: ExecutionNotificationKind;
  state: ExecutionNotificationState;
  notBefore: number;
  createdAt: number;
  sentAt: number | null;
  deliveryStatus: string | null;
  deliveredChannels: string[];
}

function toRow(row: typeof executionNotification.$inferSelect): ExecutionNotificationRow {
  let channels: string[] = [];
  try {
    channels = row.deliveredChannels ? (JSON.parse(row.deliveredChannels) as string[]) : [];
  } catch {
    channels = [];
  }
  return {
    ...row,
    kind: row.kind as ExecutionNotificationKind,
    state: row.state as ExecutionNotificationState,
    deliveredChannels: channels,
  };
}

export class ExecutionNotificationRepository {
  constructor(private readonly db: BetterSQLite3Database<typeof schema>) {}

  /** Pending rows whose time has come, oldest first. */
  due(now: number, limit = 50): ExecutionNotificationRow[] {
    return this.db
      .select()
      .from(executionNotification)
      .where(
        and(eq(executionNotification.state, "pending"), lte(executionNotification.notBefore, now)),
      )
      .orderBy(asc(executionNotification.notBefore), asc(executionNotification.createdAt))
      .limit(limit)
      .all()
      .map(toRow);
  }

  /** Every row of one run, oldest first. */
  forExecution(executionId: string): ExecutionNotificationRow[] {
    return this.db
      .select()
      .from(executionNotification)
      .where(eq(executionNotification.executionId, executionId))
      .orderBy(asc(executionNotification.createdAt))
      .all()
      .map(toRow);
  }

  /** The row the sender is about to handle is no longer about a current wait. */
  markSuperseded(id: string): void {
    this.db
      .update(executionNotification)
      .set({ state: "superseded" })
      .where(and(eq(executionNotification.id, id), eq(executionNotification.state, "pending")))
      .run();
  }

  /** Hold a pending row until `until`. */
  hold(id: string, until: number): void {
    this.db
      .update(executionNotification)
      .set({ notBefore: until })
      .where(and(eq(executionNotification.id, id), eq(executionNotification.state, "pending")))
      .run();
  }

  /** Record the delivery outcome; only a pending row is taken, so a row is sent once. */
  markSent(id: string, now: number, deliveryStatus: string, deliveredChannels: string[]): boolean {
    return (
      this.db
        .update(executionNotification)
        .set({
          state: "sent",
          sentAt: now,
          deliveryStatus,
          deliveredChannels: JSON.stringify(deliveredChannels),
        })
        .where(and(eq(executionNotification.id, id), eq(executionNotification.state, "pending")))
        .run().changes === 1
    );
  }

  /** When the run's latest agent-question notification was sent, other than `exceptId`. */
  lastAgentQuestionSentAt(executionId: string, exceptId: string): number | null {
    const row = this.db
      .select({ sentAt: executionNotification.sentAt })
      .from(executionNotification)
      .where(
        and(
          eq(executionNotification.executionId, executionId),
          like(executionNotification.waitKey, "agent:%"),
          eq(executionNotification.state, "sent"),
          isNotNull(executionNotification.sentAt),
          ne(executionNotification.id, exceptId),
        ),
      )
      .orderBy(desc(executionNotification.sentAt))
      .limit(1)
      .get();
    return row?.sentAt ?? null;
  }

  /**
   * Queue the single reminder of a wait, due at `notBefore` (the unique key keeps it single). If the
   * wait has ended by then, the sender drops it like any row whose wait is gone.
   */
  enqueueReminder(first: ExecutionNotificationRow, notBefore: number, now: number): void {
    this.db
      .insert(executionNotification)
      .values({
        id: randomUUID(),
        executionId: first.executionId,
        userId: first.userId,
        waitKey: first.waitKey,
        kind: "remind",
        state: "pending",
        notBefore,
        createdAt: now,
      })
      .onConflictDoNothing()
      .run();
  }

  /** The stored fields a wait is decided from. */
  private waitRow(executionId: string) {
    return this.db
      .select({
        state: workflowExecution.state,
        currentNodeId: workflowExecution.currentNodeId,
        gateWaiting: workflowExecution.gateWaiting,
        awaitingUser: workflowExecution.awaitingUser,
        visits: workflowExecution.visits,
      })
      .from(workflowExecution)
      .where(eq(workflowExecution.executionId, executionId))
      .get();
  }

  /** The wait key the run stands in right now, or null (read from the stored row). */
  currentWaitKey(executionId: string): string | null {
    const row = this.waitRow(executionId);
    return row ? (currentPersonWait(row)?.waitKey ?? null) : null;
  }

  /** Whether the run still holds the wait `waitKey` names (a gate beneath a question included). */
  holdsWait(executionId: string, waitKey: string): boolean {
    const row = this.waitRow(executionId);
    return row ? personWaitKeys(row).includes(waitKey) : false;
  }

  /**
   * The latest notification about the run's current wait — what the run page shows. A reminder
   * queued for later is not news yet, so a reminder not due at `now` is skipped; a first notification
   * that is held (question pause, rate limit) is shown as on its way.
   */
  latestForCurrentWait(
    executionId: string,
    now: number = Date.now(),
  ): ExecutionNotificationRow | null {
    const waitKey = this.currentWaitKey(executionId);
    if (!waitKey) return null;
    const row = this.db
      .select()
      .from(executionNotification)
      .where(
        and(
          eq(executionNotification.executionId, executionId),
          eq(executionNotification.waitKey, waitKey),
          or(
            ne(executionNotification.kind, "remind"),
            ne(executionNotification.state, "pending"),
            lte(executionNotification.notBefore, now),
          ),
        ),
      )
      .orderBy(desc(executionNotification.createdAt))
      .limit(1)
      .get();
    return row ? toRow(row) : null;
  }

  /**
   * `latestForCurrentWait` for many runs at once, in two queries: the runs' wait fields and their
   * notification rows. Runs without a current wait or without a row are left out.
   */
  latestForCurrentWaits(
    executionIds: string[],
    now: number = Date.now(),
  ): Map<string, ExecutionNotificationRow> {
    const result = new Map<string, ExecutionNotificationRow>();
    if (executionIds.length === 0) return result;
    const waits = new Map<string, string>();
    for (const row of this.db
      .select({
        executionId: workflowExecution.executionId,
        state: workflowExecution.state,
        currentNodeId: workflowExecution.currentNodeId,
        gateWaiting: workflowExecution.gateWaiting,
        awaitingUser: workflowExecution.awaitingUser,
        visits: workflowExecution.visits,
      })
      .from(workflowExecution)
      .where(inArray(workflowExecution.executionId, executionIds))
      .all()) {
      const waitKey = currentPersonWait(row)?.waitKey;
      if (waitKey) waits.set(row.executionId, waitKey);
    }
    if (waits.size === 0) return result;
    const rows = this.db
      .select()
      .from(executionNotification)
      .where(inArray(executionNotification.executionId, [...waits.keys()]))
      .orderBy(desc(executionNotification.createdAt))
      .all();
    for (const row of rows) {
      if (result.has(row.executionId) || waits.get(row.executionId) !== row.waitKey) continue;
      // A reminder queued for later is not news yet.
      if (row.kind === "remind" && row.state === "pending" && row.notBefore > now) continue;
      result.set(row.executionId, toRow(row));
    }
    return result;
  }
}
