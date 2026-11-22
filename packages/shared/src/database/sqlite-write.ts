import { AsyncLocalStorage } from "node:async_hooks";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import type Database from "better-sqlite3";
import { getSqliteInstance } from "./connection.js";
import { physicalSqlite, snapshotMemoryReaders } from "./private-memory.js";

const remainingOwners = new Map<string | Database.Database, Promise<void>>();
const ownership = new AsyncLocalStorage<SqliteWriter>();
const activeHandles = new WeakMap<Database.Database, SqliteWriter>();
const budgetMs = 5000;

export interface SqliteWriter {
  readonly sqlite: Database.Database;
  commit(): void;
  rollback(): void;
}

function busyError(): Error {
  return Object.assign(new Error("Timed out acquiring the SQLite writer"), { code: "SQLITE_BUSY" });
}

function isBusy(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error.code === "SQLITE_BUSY" || error.code === "SQLITE_BUSY_RECOVERY")
  );
}

async function waitForRelease(released: Promise<void>, remainingMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      released,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(busyError()), remainingMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Only BEGIN is retried. Nothing after acquisition can run more than once. */
async function enterSqliteWriter<T>(
  handle: Database.Database,
  suspendable: boolean,
  enter: (writer: SqliteWriter) => T,
): Promise<T> {
  const sqlite = physicalSqlite(handle);
  const key = sqlite.memory ? sqlite : sqlite.name;
  const deadline = performance.now() + budgetMs;
  while (true) {
    const remaining = deadline - performance.now();
    if (remaining <= 0) throw busyError();
    const previous = remainingOwners.get(key);
    if (previous) {
      await waitForRelease(previous, remaining);
      continue;
    }
    if (sqlite.inTransaction)
      throw new Error("Unowned SQLite transaction on the requested connection");
    // better-sqlite3's busy handler sleeps synchronously. Disable that handler only
    // for this attempt; restore the caller's setting before yielding to other work.
    const timeout = sqlite.pragma("busy_timeout", { simple: true }) as number;
    let acquired = false;
    try {
      sqlite.pragma("busy_timeout = 0");
      sqlite.exec("BEGIN IMMEDIATE");
      acquired = true;
    } catch (error) {
      if (!isBusy(error)) throw error;
    } finally {
      sqlite.pragma("busy_timeout = " + timeout);
    }
    if (!acquired) {
      await delay(Math.min(10, remaining));
      continue;
    }
    let closeSnapshot: (() => void) | undefined;
    try {
      if (suspendable && sqlite.memory) closeSnapshot = snapshotMemoryReaders(sqlite);
    } catch (error) {
      sqlite.exec("ROLLBACK");
      throw error;
    }
    let release!: () => void;
    remainingOwners.set(
      key,
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    const finish = () => {
      activeHandles.delete(sqlite);
      remainingOwners.delete(key);
      release();
      closeSnapshot?.();
    };
    const writer: SqliteWriter = {
      sqlite,
      commit() {
        sqlite.exec("COMMIT");
        finish();
      },
      rollback() {
        try {
          if (sqlite.inTransaction) sqlite.exec("ROLLBACK");
        } finally {
          finish();
        }
      },
    };
    activeHandles.set(sqlite, writer);
    return enter(writer);
  }
}

export function acquireSqliteWriter(handle: Database.Database): Promise<SqliteWriter> {
  return enterSqliteWriter(handle, true, (writer) => writer);
}

export function asSqliteWriter<T>(sqlite: Database.Database, work: () => T): T {
  sqlite = physicalSqlite(sqlite);
  const lease = activeHandles.get(sqlite);
  if (!lease) throw new Error("SQLite writer scope requires its active transaction");
  return ownership.run(lease, work);
}

export function ownsSqliteWriter(handle: Database.Database): boolean {
  const sqlite = physicalSqlite(handle);
  const parent = ownership.getStore();
  return !!parent && parent.sqlite === sqlite && activeHandles.get(sqlite) === parent;
}

export type SqliteWriteResult<T> = T & (T extends PromiseLike<unknown> ? never : unknown);

/** Acquire write authority asynchronously, then execute the caller's synchronous SQLite work. */
export async function withSqliteWrite<T>(
  work: () => SqliteWriteResult<T>,
  sqlite: Database.Database = getSqliteInstance(),
): Promise<T> {
  if (ownsSqliteWriter(sqlite)) return work();
  return enterSqliteWriter(sqlite, false, (lease) => {
    try {
      const result = ownership.run(lease, work);
      if (result && typeof result === "object" && "then" in result)
        throw new TypeError("SQLite application write callbacks must be synchronous");
      lease.commit();
      return result;
    } catch (error) {
      lease.rollback();
      throw error;
    }
  });
}
