import Database from "better-sqlite3";
import { readMigrationFiles, type MigrationMeta } from "drizzle-orm/migrator";

const LEGACY_EXECUTION_WORKFLOW_VERSION_CREATED_AT = 1789290120000;
const LEGACY_EXECUTION_WORKFLOW_VERSION_HASH =
  "5d72e1f6f53d4ecf2ba70c606daeb6694d612faba7d0212c5dc794cb31081609";
const CODESPACE_RENAME_CREATED_AT = 1790000000000;
const CODESPACE_RENAME_HASH = "36faefb60733c85c4c1daa3ce3dced700dc253e6bcd86df963768972f11c6072";
const EXECUTION_WORKFLOW_VERSION_CREATED_AT = 1790000060000;

const LEGACY_CODESPACE_TABLES = [
  "workspaceConnection",
  "workspaceCredentialVault",
  "workspaceCredentialRevocation",
  "workspaceAuthorizationState",
  "workspaceConnectionInstallation",
  "workspaceConnectionRepository",
  "workspaceResource",
  "workspaceLifecycleCapability",
  "workspacePolicyUsage",
  "workspaceProviderMutation",
  "workspaceProviderControl",
  "workspaceOperation",
  "workspaceTransfer",
] as const;

interface MigrationRow {
  hash: string;
  createdAt: number;
}

interface TableInfoRow {
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | number | null;
}

function tableExists(sqlite: Database.Database, table: string): boolean {
  return Boolean(
    sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table),
  );
}

function tableColumns(sqlite: Database.Database, table: string): TableInfoRow[] {
  return sqlite.prepare(`PRAGMA table_info(${table})`).all() as TableInfoRow[];
}

function findMigration(migrations: MigrationMeta[], createdAt: number): MigrationMeta | undefined {
  return migrations.find((migration) => migration.folderMillis === createdAt);
}

function hasExactLegacyJournal(
  sqlite: Database.Database,
  migrationsBeforeRename: MigrationMeta[],
): boolean {
  const actual = sqlite
    .prepare(
      "SELECT hash, created_at AS createdAt FROM __drizzle_migrations ORDER BY created_at, hash",
    )
    .all() as MigrationRow[];
  const expected = [
    ...migrationsBeforeRename.map((migration) => ({
      hash: migration.hash,
      createdAt: migration.folderMillis,
    })),
    {
      hash: LEGACY_EXECUTION_WORKFLOW_VERSION_HASH,
      createdAt: LEGACY_EXECUTION_WORKFLOW_VERSION_CREATED_AT,
    },
  ].sort((left, right) => left.createdAt - right.createdAt || left.hash.localeCompare(right.hash));

  return (
    actual.length === expected.length &&
    actual.every(
      (row, index) =>
        Number(row.createdAt) === expected[index]!.createdAt && row.hash === expected[index]!.hash,
    )
  );
}

function hasExactLegacySchema(sqlite: Database.Database): boolean {
  if (!LEGACY_CODESPACE_TABLES.every((table) => tableExists(sqlite, table))) return false;
  if (
    LEGACY_CODESPACE_TABLES.some((table) =>
      tableExists(sqlite, table.replace(/^workspace/, "codespace")),
    )
  ) {
    return false;
  }

  const executionWorkflowVersion = tableColumns(sqlite, "workflowExecution").find(
    (column) => column.name === "workflowVersion",
  );
  if (
    !executionWorkflowVersion ||
    executionWorkflowVersion.type.toUpperCase() !== "TEXT" ||
    executionWorkflowVersion.notnull !== 0 ||
    executionWorkflowVersion.dflt_value !== null
  ) {
    return false;
  }

  const connectionColumns = tableColumns(sqlite, "workspaceConnection");
  if (
    connectionColumns.some(
      (column) => column.name === "grantsRefreshedAt" || column.name === "grantsVersion",
    )
  ) {
    return false;
  }

  return !tableColumns(sqlite, "auditLog").some((column) => column.name === "dedupeKey");
}

/**
 * Bridges the one migration history published before 0037 was reassigned during a rebase.
 *
 * The legacy migration already performed the schema change now owned by 0038. When, and only
 * when, both the complete migration journal and the database schema match that known release,
 * apply 0037 and replace the legacy journal row with the current 0038 row in one transaction.
 */
export function bridgeLegacyExecutionWorkflowVersionMigration(
  sqlite: Database.Database,
  migrationsFolder: string,
): boolean {
  if (!tableExists(sqlite, "__drizzle_migrations")) return false;

  const migrations = readMigrationFiles({ migrationsFolder });
  const codespaceRenameIndex = migrations.findIndex(
    (migration) => migration.folderMillis === CODESPACE_RENAME_CREATED_AT,
  );
  const codespaceRename = migrations[codespaceRenameIndex];
  const executionWorkflowVersion = findMigration(migrations, EXECUTION_WORKFLOW_VERSION_CREATED_AT);

  if (
    codespaceRenameIndex < 0 ||
    !codespaceRename ||
    codespaceRename.hash !== CODESPACE_RENAME_HASH ||
    !executionWorkflowVersion ||
    executionWorkflowVersion.hash !== LEGACY_EXECUTION_WORKFLOW_VERSION_HASH
  ) {
    throw new Error("Current migration files do not match the legacy 0037 compatibility bridge");
  }

  return sqlite.transaction(() => {
    if (!hasExactLegacyJournal(sqlite, migrations.slice(0, codespaceRenameIndex))) return false;
    if (!hasExactLegacySchema(sqlite)) return false;

    for (const statement of codespaceRename.sql) {
      if (statement.trim()) sqlite.exec(statement);
    }

    sqlite
      .prepare("INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)")
      .run(codespaceRename.hash, CODESPACE_RENAME_CREATED_AT);
    const updated = sqlite
      .prepare(
        `UPDATE __drizzle_migrations
         SET hash = ?, created_at = ?
         WHERE hash = ? AND created_at = ?`,
      )
      .run(
        executionWorkflowVersion.hash,
        EXECUTION_WORKFLOW_VERSION_CREATED_AT,
        LEGACY_EXECUTION_WORKFLOW_VERSION_HASH,
        LEGACY_EXECUTION_WORKFLOW_VERSION_CREATED_AT,
      );
    if (updated.changes !== 1) {
      throw new Error("Legacy 0037 migration journal row changed during compatibility migration");
    }

    return true;
  })();
}
