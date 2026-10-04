/**
 * Database Connection Singleton
 * Single Database instance shared across all services
 */

import { drizzle, BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import Database from "better-sqlite3";
import path from "path";
import "dotenv/config";
import * as schema from "./schema.js";
import { createLogger } from "../logging/logger.js";
import { getDbPath, isLogSqlEnabled, getNodeEnv, isTestEnvironment } from "../config/env.js";

let dbInstance: BetterSQLite3Database<typeof schema> | null = null;
let sqliteInstance: Database.Database | null = null;
const managementFunctions = new WeakSet<Database.Database>();

/** Unicode case folding shared by singleton and independent overview connections. */
export function registerExecutionManagementFunctions(sqlite: Database.Database): void {
  if (managementFunctions.has(sqlite)) return;
  sqlite.function("moira_lower", { deterministic: true }, (value) =>
    typeof value === "string" ? value.toLowerCase() : "",
  );
  managementFunctions.add(sqlite);
}

class DrizzleLogger {
  private logger = createLogger({ component: "Drizzle" });

  logQuery(query: string, params: unknown[]): void {
    // Only log SQL in development or when explicitly enabled via LOG_SQL env var
    // Prevents production log pollution and potential data exposure
    if (getNodeEnv() === "development" || isLogSqlEnabled()) {
      this.logger.debug("SQL Query", { query, params });
    }
  }
}

/**
 * Get Drizzle database instance (singleton)
 * Type-safe queries with schema
 */
export function getDatabase() {
  if (!dbInstance) {
    const dbPath = getDbPath();

    // Special handling for in-memory database (don't resolve path)
    const isInMemory = dbPath === ":memory:";
    const resolvedPath = isInMemory ? ":memory:" : path.resolve(dbPath);

    // Prevent accidental production DB creation in tests
    if (
      isTestEnvironment() &&
      !isInMemory &&
      resolvedPath.includes("moira.db") &&
      !resolvedPath.includes("test-")
    ) {
      throw new Error(
        `TEST ENVIRONMENT: Attempted to create production database at ${resolvedPath}. Use DB_PATH=./data/test-*.db or :memory: for tests.`,
      );
    }

    sqliteInstance = new Database(resolvedPath);
    registerExecutionManagementFunctions(sqliteInstance);

    sqliteInstance.pragma("journal_mode = WAL"); // WAL for concurrent reads + faster writes
    sqliteInstance.pragma("synchronous = NORMAL"); // Safe with WAL, faster than FULL
    sqliteInstance.pragma("foreign_keys = ON");
    sqliteInstance.pragma("busy_timeout = 5000"); // Wait up to 5s for locks

    dbInstance = drizzle(sqliteInstance, { schema, logger: new DrizzleLogger() });
  }

  return dbInstance;
}

/**
 * Get raw SQLite instance (for Better Auth and raw queries)
 * Same instance as Drizzle uses
 */
export function getSqliteInstance(): Database.Database {
  if (!sqliteInstance) {
    getDatabase(); // Initialize if not yet
  }
  return sqliteInstance!;
}

/**
 * Keep awaited reads on one WAL snapshot without sharing a transaction with writers.
 * Private in-memory databases cannot be reopened; their existing generation guards remain active.
 */
export async function withReadSnapshot<T>(
  read: (db: BetterSQLite3Database<typeof schema>, sqlite: Database.Database) => Promise<T>,
  source: Database.Database = getSqliteInstance(),
): Promise<T> {
  if (!source.name || source.name === ":memory:") return read(drizzle(source, { schema }), source);
  const sqlite = new Database(source.name, { readonly: true, fileMustExist: true });
  try {
    if (sqlite.pragma("journal_mode", { simple: true }) !== "wal")
      throw new Error("Awaited database snapshots require WAL journal mode");
    registerExecutionManagementFunctions(sqlite);
    sqlite.pragma("busy_timeout = 5000");
    sqlite.exec("BEGIN DEFERRED");
    // BEGIN alone is lazy: acquire the read snapshot before the callback's first await.
    sqlite.prepare("SELECT rootpage FROM sqlite_schema LIMIT 1").get();
    return await read(drizzle(sqlite, { schema }), sqlite);
  } finally {
    try {
      if (sqlite.inTransaction) sqlite.exec("ROLLBACK");
    } finally {
      sqlite.close();
    }
  }
}

/**
 * Close database connection (for graceful shutdown)
 */
export function closeDatabase(): void {
  if (sqliteInstance) {
    sqliteInstance.close();
    sqliteInstance = null;
    dbInstance = null;
  }
}
