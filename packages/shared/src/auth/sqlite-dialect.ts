import {
  CompiledQuery,
  Kysely,
  SqliteDialect,
  SqliteDriver,
  type DatabaseConnection,
  type SqliteDialectConfig,
} from "kysely";
import type Database from "better-sqlite3";

class AuthSqliteDriver extends SqliteDriver {
  override async beginTransaction(connection: DatabaseConnection): Promise<void> {
    // These transactions can write after reading a user or a grant. Reserve the
    // writer before the read so another WAL writer cannot invalidate the snapshot.
    await connection.executeQuery(CompiledQuery.raw("BEGIN IMMEDIATE"));
  }
}

class AuthSqliteDialect extends SqliteDialect {
  constructor(private readonly config: SqliteDialectConfig) {
    super(config);
  }

  override createDriver(): AuthSqliteDriver {
    return new AuthSqliteDriver(this.config);
  }
}

// Kysely serializes access to a SQLite connection. Auth instances sharing a physical
// handle (including the HTTP handler and direct API callers) must share that queue.
const databases = new WeakMap<Database.Database, Kysely<unknown>>();
export function getAuthKysely(sqlite: Database.Database): Kysely<unknown> {
  let db = databases.get(sqlite);
  if (!db) {
    db = new Kysely({ dialect: new AuthSqliteDialect({ database: sqlite }) });
    databases.set(sqlite, db);
  }
  return db;
}
