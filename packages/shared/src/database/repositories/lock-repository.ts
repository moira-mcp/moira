/**
 * Lock Repository - Domain repository for execution locks
 * Drizzle ORM queries for lock CRUD operations
 */

import { eq, and, like } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { executionLock, workflowExecution } from "../schema.js";
import { recordExecutionChange } from "../execution-change.js";
import type * as schema from "../schema.js";

export type PublicLockStatus = "active" | "unlocked";
export type LockStatus = "pending_delivery" | PublicLockStatus | "delivery_failed";

export interface LockRecord {
  id: string;
  executionId: string;
  nodeId: string;
  reason: string;
  lockedBy: string;
  pin: string;
  status: LockStatus;
  createdAt: Date;
  unlockedAt: Date | null;
}

export interface CreateLockInput {
  id: string;
  executionId: string;
  nodeId: string;
  reason: string;
  lockedBy: string;
  pin: string;
  status?: LockStatus;
  createdAt: Date;
}

export class LockRepository {
  constructor(private db: BetterSQLite3Database<typeof schema>) {}

  async create(input: CreateLockInput): Promise<void> {
    this.db.transaction(
      (tx) => {
        tx.insert(executionLock)
          .values({
            id: input.id,
            executionId: input.executionId,
            nodeId: input.nodeId,
            reason: input.reason,
            lockedBy: input.lockedBy,
            pin: input.pin,
            status: input.status ?? "active",
            createdAt: input.createdAt,
          })
          .run();
        this.recordLockChange(tx, input.executionId);
      },
      { behavior: "immediate" },
    );
  }

  /**
   * Record a `lock` event for the run: every write of a lock's status changes whether the run is
   * shown as locked. Each status write is its own small transaction — lock delivery waits on the
   * network between creation and activation, so the lock never shares the run's writes.
   */
  private recordLockChange(tx: BetterSQLite3Database<typeof schema>, executionId: string): void {
    const run = tx
      .select({ userId: workflowExecution.userId })
      .from(workflowExecution)
      .where(eq(workflowExecution.executionId, executionId))
      .get();
    if (run) recordExecutionChange(tx, { executionId, userId: run.userId, kind: "lock" });
  }

  async getById(lockId: string): Promise<LockRecord | null> {
    const rows = await this.db
      .select()
      .from(executionLock)
      .where(eq(executionLock.id, lockId))
      .limit(1);

    return rows.length > 0 ? (rows[0] as LockRecord) : null;
  }

  async getActiveByExecution(
    executionId: string,
  ): Promise<(LockRecord & { status: "active" }) | null> {
    const rows = await this.db
      .select()
      .from(executionLock)
      .where(and(eq(executionLock.executionId, executionId), eq(executionLock.status, "active")))
      .limit(1);

    return rows.length > 0 ? (rows[0] as LockRecord & { status: "active" }) : null;
  }

  async updateStatus(
    lockId: string,
    status: LockStatus,
    extra?: { unlockedAt?: Date },
  ): Promise<void> {
    const updates: Record<string, unknown> = { status };
    if (extra?.unlockedAt !== undefined) {
      updates.unlockedAt = extra.unlockedAt;
    }
    this.db.transaction(
      (tx) => {
        const lock = tx
          .select({ executionId: executionLock.executionId })
          .from(executionLock)
          .where(eq(executionLock.id, lockId))
          .get();
        const result = tx
          .update(executionLock)
          .set(updates)
          .where(eq(executionLock.id, lockId))
          .run();
        if (lock && result.changes > 0) this.recordLockChange(tx, lock.executionId);
      },
      { behavior: "immediate" },
    );
  }

  async getActiveByExecutionPrefix(
    executionIdPrefix: string,
  ): Promise<(LockRecord & { status: "active" }) | null> {
    // Sanitize LIKE special characters to prevent wildcard injection
    const sanitized = executionIdPrefix.replace(/[%_]/g, "");
    if (sanitized.length < 8) {
      return null;
    }

    const rows = await this.db
      .select()
      .from(executionLock)
      .where(
        and(like(executionLock.executionId, `${sanitized}%`), eq(executionLock.status, "active")),
      )
      .limit(1);

    return rows.length > 0 ? (rows[0] as LockRecord & { status: "active" }) : null;
  }

  async listByExecution(executionId: string): Promise<LockRecord[]> {
    const rows = await this.db
      .select()
      .from(executionLock)
      .where(eq(executionLock.executionId, executionId));

    return rows as LockRecord[];
  }

  async getActiveExecutionIds(): Promise<Set<string>> {
    const rows = await this.db
      .select({ executionId: executionLock.executionId })
      .from(executionLock)
      .where(eq(executionLock.status, "active"));

    return new Set(rows.map((r) => r.executionId));
  }
}
