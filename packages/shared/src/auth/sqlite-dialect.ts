import {
  type CompiledQuery,
  Kysely,
  SqliteDialect,
  SqliteDriver,
  type DatabaseConnection,
} from "kysely";
import type Database from "better-sqlite3";
import { acquireSqliteWriter, type SqliteWriter } from "../database/sqlite-write.js";

class AuthSqliteDriver extends SqliteDriver {
  private transaction?: SqliteWriter;
  private wrapped?: DatabaseConnection;
  constructor(private readonly sqlite: Database.Database) {
    super({ database: sqlite });
  }
  override async beginTransaction(): Promise<void> {
    this.transaction = await acquireSqliteWriter(this.sqlite);
  }
  override async commitTransaction(): Promise<void> {
    this.transaction!.commit();
    this.transaction = undefined;
  }
  override async rollbackTransaction(): Promise<void> {
    try {
      this.transaction!.rollback();
    } finally {
      this.transaction = undefined;
    }
  }
  override async acquireConnection(): Promise<DatabaseConnection> {
    if (this.wrapped) return this.wrapped;
    const underlying = await super.acquireConnection();
    this.wrapped = {
      streamQuery: underlying.streamQuery.bind(underlying),
      executeQuery: async <R>(query: CompiledQuery) => {
        if (
          this.transaction ||
          query.query.kind === "SelectQueryNode" ||
          this.sqlite.prepare(query.sql).readonly
        )
          return underlying.executeQuery<R>(query);
        const lease = await acquireSqliteWriter(this.sqlite);
        try {
          const result = await underlying.executeQuery<R>(query);
          lease.commit();
          return result;
        } catch (error) {
          lease.rollback();
          throw error;
        }
      },
    };
    return this.wrapped;
  }
}

class AuthSqliteDialect extends SqliteDialect {
  constructor(private readonly sqlite: Database.Database) {
    super({ database: sqlite });
  }

  override createDriver(): AuthSqliteDriver {
    return new AuthSqliteDriver(this.sqlite);
  }
}

// Kysely serializes access to a SQLite connection. Auth instances sharing a physical
// handle (including the HTTP handler and direct API callers) must share that queue.
const databases = new WeakMap<Database.Database, Kysely<unknown>>();
export function getAuthKysely(sqlite: Database.Database): Kysely<unknown> {
  let db = databases.get(sqlite);
  if (!db) {
    db = new Kysely({ dialect: new AuthSqliteDialect(sqlite) });
    databases.set(sqlite, db);
  }
  return db;
}
