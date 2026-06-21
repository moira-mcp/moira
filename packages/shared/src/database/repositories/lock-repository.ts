/**
 * Lock Repository - Domain repository for execution locks
 * Drizzle ORM queries for lock CRUD operations
 */

import { eq, and, like } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { executionLock } from "../schema.js";
import type * as schema from "../schema.js";

export type LockStatus = "active" | "unlocked";

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
  createdAt: Date;
}

export class LockRepository {
  constructor(private db: BetterSQLite3Database<typeof schema>) {}

  async create(input: CreateLockInput): Promise<void> {
    await this.db.insert(executionLock).values({
      id: input.id,
      executionId: input.executionId,
      nodeId: input.nodeId,
      reason: input.reason,
      lockedBy: input.lockedBy,
      pin: input.pin,
      status: "active",
      createdAt: input.createdAt,
    });
  }

  async getById(lockId: string): Promise<LockRecord | null> {
    const rows = await this.db
      .select()
      .from(executionLock)
      .where(eq(executionLock.id, lockId))
      .limit(1);

    return rows.length > 0 ? (rows[0] as LockRecord) : null;
  }

  async getActiveByExecution(executionId: string): Promise<LockRecord | null> {
    const rows = await this.db
      .select()
      .from(executionLock)
      .where(and(eq(executionLock.executionId, executionId), eq(executionLock.status, "active")))
      .limit(1);

    return rows.length > 0 ? (rows[0] as LockRecord) : null;
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
    await this.db.update(executionLock).set(updates).where(eq(executionLock.id, lockId));
  }

  async getActiveByExecutionPrefix(executionIdPrefix: string): Promise<LockRecord | null> {
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

    return rows.length > 0 ? (rows[0] as LockRecord) : null;
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
