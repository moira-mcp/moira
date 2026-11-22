import {
  CompiledQuery,
  SqliteDialect,
  SqliteDriver,
  type DatabaseConnection,
  type SqliteDialectConfig,
} from "kysely";

class AuthSqliteDriver extends SqliteDriver {
  override async beginTransaction(connection: DatabaseConnection): Promise<void> {
    // These transactions can write after reading a user or a grant. Reserve the
    // writer before the read so another WAL writer cannot invalidate the snapshot.
    await connection.executeQuery(CompiledQuery.raw("BEGIN IMMEDIATE"));
  }
}

export class AuthSqliteDialect extends SqliteDialect {
  constructor(private readonly config: SqliteDialectConfig) {
    super(config);
  }

  override createDriver(): AuthSqliteDriver {
    return new AuthSqliteDriver(this.config);
  }
}
