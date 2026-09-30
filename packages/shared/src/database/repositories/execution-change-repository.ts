/**
 * Reading and trimming the change feed of execution rows (see execution-change.ts).
 */

import type Database from "better-sqlite3";
import type { ExecutionChangeKind } from "../execution-change.js";

export interface ExecutionChangeEvent {
  seq: number;
  executionId: string;
  userId: string;
  kind: ExecutionChangeKind;
  at: number;
}

export class ExecutionChangeRepository {
  constructor(private readonly sqlite: Database.Database) {}

  /** Every user's events after `seq`, oldest first, at most `limit` — for the process's watcher. */
  since(seq: number, limit: number): ExecutionChangeEvent[] {
    return this.sqlite
      .prepare(
        `SELECT seq, executionId, userId, kind, at FROM executionChange
         WHERE seq > ? ORDER BY seq LIMIT ?`,
      )
      .all(seq, limit) as ExecutionChangeEvent[];
  }

  /** One user's events after `seq` (and at most `through`), oldest first, at most `limit`. */
  forUserAfter(
    userId: string,
    seq: number,
    limit: number,
    through: number = Number.MAX_SAFE_INTEGER,
  ): ExecutionChangeEvent[] {
    return this.sqlite
      .prepare(
        `SELECT seq, executionId, userId, kind, at FROM executionChange
         WHERE userId = ? AND seq > ? AND seq <= ? ORDER BY seq LIMIT ?`,
      )
      .all(userId, seq, through, limit) as ExecutionChangeEvent[];
  }

  /** The number of the latest event ever written (0 when none was), kept or trimmed. */
  latestSeq(): number {
    const row = this.sqlite
      .prepare("SELECT seq FROM sqlite_sequence WHERE name = 'executionChange'")
      .get() as { seq: number } | undefined;
    return row?.seq ?? 0;
  }

  /**
   * Whether the feed cannot say what happened after `cursor`: events after it may have been trimmed
   * (it is older than the oldest kept event, or nothing is kept while newer events were written), or
   * it lies ahead of the latest event (the database was restored from an older copy). A reader then
   * starts over (`reset`).
   */
  isExpired(cursor: number): boolean {
    if (cursor > this.latestSeq()) return true;
    const oldest = (
      this.sqlite.prepare("SELECT MIN(seq) AS seq FROM executionChange").get() as {
        seq: number | null;
      }
    ).seq;
    if (oldest === null) return cursor < this.latestSeq();
    return cursor < oldest - 1;
  }

  /** Remove events older than `at` (epoch ms); returns how many. */
  deleteOlderThan(at: number): number {
    return this.sqlite.prepare("DELETE FROM executionChange WHERE at < ?").run(at).changes;
  }
}
