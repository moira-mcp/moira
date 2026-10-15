import { describe, expect, test } from "@jest/globals";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const migrations = path.resolve(process.cwd(), "packages/web-backend/drizzle");

const oldTables = [
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
];
const newTables = oldTables.map((name) => name.replace(/^workspace/, "codespace"));
const renamedTable = new Map(oldTables.map((name, index) => [name, newTables[index]!]));

type StoredRow = Record<string, string | number | null>;

function rows(sqlite: Database.Database, table: string): StoredRow[] {
  return sqlite.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all() as StoredRow[];
}

function expectedRowsAfterRename(table: string, storedRows: StoredRow[]): StoredRow[] {
  return storedRows.map((stored) => {
    const expected = { ...stored };
    if (table === "workspaceConnection") {
      expected.grantsRefreshedAt = null;
      expected.grantsVersion = 0;
      // Added by the later activity migration.
      expected.resourcesObservedAt = null;
    }
    if (table === "workspaceAuthorizationState") {
      // Existing one-time states keep their connect intent after the reauthorization migration.
      expected.intent = "connect";
      expected.expectedConnectionId = null;
      expected.expectedGeneration = null;
    }
    if (table === "workspaceResource") {
      expected.lastOutcome = String(expected.lastOutcome).replace("workspace_", "codespace_");
      // Added by the later observed-ref migration, with its defaults for existing rows.
      expected.observedRef = null;
      expected.reconcileFailures = 0;
      // Added by the later activity migration.
      expected.lastActivityAt = null;
      expected.providerLastUsedAt = null;
      // Existing rows have no verified observation timestamp after the observation migration.
      expected.observedAt = null;
    }
    if (table === "workspaceOperation") {
      expected.lastOutcome = String(expected.lastOutcome).replace("workspace_", "codespace_");
      // Historical operations keep their identity without invented admission or launch proof.
      expected.requestId = null;
      expected.requestDigest = null;
      expected.inputReference = null;
      expected.resultReference = null;
      expected.admissionDeadlineAt = null;
      expected.runtimeMs = null;
      expected.startedAt = null;
      expected.sessionKey = null;
    }
    if (table === "workspaceTransfer") {
      expected.purpose = String(expected.purpose).replace("workspace_", "codespace_");
      // Existing transfer rows retain their identity without invented streaming authority.
      expected.requestId = null;
      expected.requestDigest = null;
      expected.direction = null;
      expected.resourceId = null;
      expected.provider = null;
      expected.resourceGeneration = null;
      expected.authorizationGeneration = null;
      expected.environmentIdentity = null;
      expected.expectedSha256 = null;
      expected.uploadedBytes = stored.observedSize ?? 0;
    }
    return expected;
  });
}

interface IndexListRow {
  name: string;
  unique: number;
  origin: string;
  partial: number;
}

interface IndexColumnRow {
  seqno: number;
  name: string;
}

function indexProjection(
  sqlite: Database.Database,
  tables: string[],
  normalizeOldNames: boolean,
  explicitOnly = true,
): Array<{
  table: string;
  name: string;
  unique: number;
  partial: number;
  columns: string[];
}> {
  return tables
    .flatMap((table) =>
      (sqlite.prepare(`PRAGMA index_list(${table})`).all() as IndexListRow[])
        .filter(({ origin }) => !explicitOnly || origin === "c")
        .map((index) => ({
          table: normalizeOldNames ? renamedTable.get(table)! : table,
          name: normalizeOldNames ? index.name.replace(/^workspace/, "codespace") : index.name,
          unique: index.unique,
          partial: index.partial,
          columns: (sqlite.prepare(`PRAGMA index_info(${index.name})`).all() as IndexColumnRow[])
            .sort((left, right) => left.seqno - right.seqno)
            .map(({ name }) => name),
        })),
    )
    .sort((left, right) => left.name.localeCompare(right.name));
}

interface ForeignKeyRow {
  id: number;
  seq: number;
  table: string;
  from: string;
  to: string;
  on_update: string;
  on_delete: string;
  match: string;
}

function foreignKeyProjection(
  sqlite: Database.Database,
  tables: string[],
  normalizeOldNames: boolean,
): Array<ForeignKeyRow & { owner: string }> {
  return tables
    .flatMap((table) =>
      (sqlite.prepare(`PRAGMA foreign_key_list(${table})`).all() as ForeignKeyRow[]).map((key) => ({
        ...key,
        owner: normalizeOldNames ? renamedTable.get(table)! : table,
        table: normalizeOldNames ? (renamedTable.get(key.table) ?? key.table) : key.table,
      })),
    )
    .sort((left, right) =>
      [left.owner, left.id, left.seq]
        .join(":")
        .localeCompare([right.owner, right.id, right.seq].join(":")),
    );
}

function copyBeforeMigration(directory: string, tag: string): string {
  const target = path.join(directory, `before-${tag}`);
  fs.cpSync(migrations, target, { recursive: true });
  const journalPath = path.join(target, "meta/_journal.json");
  const journal = JSON.parse(fs.readFileSync(journalPath, "utf8")) as {
    entries: Array<{ tag: string }>;
  };
  const index = journal.entries.findIndex((entry) => entry.tag === tag);
  expect(index).toBeGreaterThan(0);
  journal.entries = journal.entries.slice(0, index);
  fs.writeFileSync(journalPath, `${JSON.stringify(journal, null, 2)}\n`);
  return target;
}

function populateEveryOldTable(sqlite: Database.Database): void {
  sqlite.exec(`
    INSERT INTO user (id, email, handle, createdAt, updatedAt)
    VALUES ('user-1', 'one@example.test', 'user-one', 'now', 'now');
    INSERT INTO workspaceConnection
      (id, userId, provider, externalAccountId, externalLogin, status,
       credentialGeneration, createdAt, updatedAt)
    VALUES ('connection-1', 'user-1', 'github-codespaces', '101', 'owner', 'connected', 1, 1, 1);
    INSERT INTO workspaceCredentialVault
      (connectionId, envelopeVersion, keyVersion, iv, authTag, ciphertext, generation, updatedAt)
    VALUES ('connection-1', 1, 'v1', 'iv', 'tag', 'ciphertext', 1, 1);
    INSERT INTO workspaceCredentialRevocation
      (id, userId, provider, envelopeVersion, keyVersion, iv, authTag, ciphertext,
       generation, createdAt, updatedAt)
    VALUES ('revocation-1', 'user-1', 'github-codespaces', 1, 'v1', 'iv', 'tag',
            'ciphertext', 1, 1, 1);
    INSERT INTO workspaceAuthorizationState
      (stateHash, userId, sessionTokenHash, provider, redirectPath, expiresAt, createdAt)
    VALUES ('state-hash', 'user-1', 'session-hash', 'github-codespaces', '/settings', 100, 1);
    INSERT INTO workspaceConnectionInstallation
      (connectionId, externalInstallationId, repositorySelection, createdAt)
    VALUES ('connection-1', '201', 'selected', 1);
    INSERT INTO workspaceConnectionRepository
      (connectionId, externalInstallationId, externalRepositoryId, fullName, private, createdAt)
    VALUES ('connection-1', '201', '301', 'owner/repository', 1, 1);
    INSERT INTO workspaceResource
      (id, userId, connectionId, authorizationGeneration, provider, repositoryId,
       repositoryFullName, requestedRef, operationMarker, providerResourceName,
       externalOwnerId, billableOwnerId, machineName, machineDisplayName,
       machineOperatingSystem, machineCpuCores, machineMemoryBytes, machineStorageBytes,
       state, retentionPolicy, desiredState, observedState, generation, createDeadlineAt,
       remoteExpiresAt, lastOutcome, createdAt, updatedAt)
    VALUES ('resource-1', 'user-1', 'connection-1', 1, 'github-codespaces', '301',
            'owner/repository', 'refs/heads/main', 'marker-1', 'silver-space', '101', '101',
            'basic', 'Basic', 'linux', 2, 1024, 2048, 'usable', 'persistent', 'running',
            'running', 1, 100, 200, 'workspace_stop_requested', 1, 1);
    INSERT INTO workspaceLifecycleCapability (resourceId, userId, capabilityHash, createdAt)
    VALUES ('resource-1', 'user-1', 'capability-hash', 1);
    INSERT INTO workspacePolicyUsage
      (userId, provider, utcDay, requiredCleanupOperations, updatedAt)
    VALUES ('user-1', 'github-codespaces', '2026-09-20', 1, 1);
    INSERT INTO workspaceProviderMutation
      (id, resourceId, userId, provider, generation, kind, attempt, createdAt)
    VALUES ('mutation-1', 'resource-1', 'user-1', 'github-codespaces', 1, 'create', 1, 1);
    INSERT INTO workspaceProviderControl (scope, disabled, reason, updatedAt, updatedBy)
    VALUES ('global', 0, NULL, 1, 'user-1');
    INSERT INTO workspaceOperation
      (id, userId, resourceId, resourceGeneration, authorizationGeneration, provider,
       providerResourceName, remoteMarker, kind, state, inputBytes, stdoutLimitBytes,
       stderrLimitBytes, outputBytes, remoteCleanupPending, deadlineAt, lastOutcome, createdAt, updatedAt)
    VALUES ('operation-1', 'user-1', 'resource-1', 1, 1, 'github-codespaces', 'silver-space',
            'operation-marker', 'exec', 'running', 0, 1024, 1024, 0, 1, 100,
            'workspace_restarted', 1, 1);
    INSERT INTO workspaceTransfer
      (id, tokenDigest, userId, purpose, state, fileName, mimeType, declaredSize,
       objectKey, ownerPid, expiresAt, createdAt, updatedAt)
    VALUES ('transfer-1', 'token-digest', 'user-1', 'workspace_download', 'ready', 'result.txt',
            'text/plain', 12, 'object-key', 123, 100, 1, 1);
    INSERT INTO auditLog
      (id, userId, action, resource, resourceId, source, metadata, createdAt)
    VALUES ('audit-1', 'user-1', 'workspace:resource_stop', 'workspace_resource', 'resource-1',
            'mcp', '{"workspaceId":"resource-1","workspace_id":"resource-1"}', 1);
  `);
}

describe("codespace rename migration", () => {
  test("preserves every row, foreign key and explicit index while adding current connection metadata", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "moira-codespace-rename-"));
    const sqlite = new Database(path.join(directory, "moira.db"));
    sqlite.pragma("foreign_keys = ON");
    try {
      migrate(drizzle(sqlite), {
        migrationsFolder: copyBeforeMigration(directory, "0037_codespace_rename"),
      });
      populateEveryOldTable(sqlite);

      const storedRows = new Map(oldTables.map((table) => [table, rows(sqlite, table)]));
      const storedIndexes = indexProjection(sqlite, oldTables, true);
      const storedForeignKeys = foreignKeyProjection(sqlite, oldTables, true);
      const storedAudit = rows(sqlite, "auditLog");

      // Inspect the renamed operational schema before later owner migrations archive it.
      migrate(drizzle(sqlite), {
        migrationsFolder: copyBeforeMigration(directory, "0061_local_controller_authority"),
      });

      for (const oldTable of oldTables) {
        const newTable = renamedTable.get(oldTable)!;
        expect(rows(sqlite, newTable)).toEqual(
          expectedRowsAfterRename(oldTable, storedRows.get(oldTable)!),
        );
      }
      const currentNames = (
        sqlite
          .prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'index')")
          .all() as Array<{ name: string }>
      ).map(({ name }) => name);
      for (const oldName of oldTables) expect(currentNames).not.toContain(oldName);
      // Only the new agent's scoped authentication state uses this namespace;
      // none of the historical workspace tables or their rows are adopted as it.
      expect(currentNames.filter((name) => /^workspace(?:_|[A-Z])/.test(name))).toEqual([
        "workspaceAgentCredential",
      ]);
      expect(rows(sqlite, "workspaceAgentCredential")).toEqual([]);
      expect(indexProjection(sqlite, newTables, false)).toEqual(
        [
          ...storedIndexes,
          {
            table: "codespaceOperation",
            name: "codespace_operation_request_idx",
            unique: 1,
            partial: 0,
            columns: ["userId", "requestId"],
          },
          {
            table: "codespaceTransfer",
            name: "codespace_transfer_request_idx",
            unique: 1,
            partial: 0,
            columns: ["userId", "requestId"],
          },
        ].sort((left, right) => left.name.localeCompare(right.name)),
      );
      expect(foreignKeyProjection(sqlite, newTables, false)).toEqual(storedForeignKeys);

      const connectionColumns = (
        sqlite.prepare("PRAGMA table_info(codespaceConnection)").all() as Array<{ name: string }>
      ).map(({ name }) => name);
      const auditColumns = (
        sqlite.prepare("PRAGMA table_info(auditLog)").all() as Array<{ name: string }>
      ).map(({ name }) => name);
      expect(connectionColumns).toContain("grantsRefreshedAt");
      expect(connectionColumns).toContain("grantsVersion");
      expect(auditColumns).toContain("dedupeKey");
      expect(
        indexProjection(sqlite, ["auditLog"], false, false).find(
          (index) => index.columns.length === 1 && index.columns[0] === "dedupeKey",
        ),
      ).toMatchObject({ table: "auditLog", unique: 1, columns: ["dedupeKey"] });
      expect(rows(sqlite, "auditLog")).toEqual(
        storedAudit.map((stored) => ({
          ...stored,
          dedupeKey: null,
          action: String(stored.action).replace("workspace:", "codespace:"),
          resource: String(stored.resource).replace("workspace_", "codespace_"),
          metadata: String(stored.metadata)
            .replace('"workspaceId"', '"codespaceId"')
            .replace('"workspace_id"', '"codespace_id"'),
        })),
      );
      expect(sqlite.prepare("PRAGMA foreign_key_check").all()).toEqual([]);

      const archivedTables = new Map([
        ["codespaceResource", "archiveGithubResourceOperational"],
        ["codespaceLifecycleCapability", "archiveCodespaceLifecycleCapability"],
        ["codespacePolicyUsage", "archiveCodespacePolicyUsage"],
        ["codespaceProviderMutation", "archiveCodespaceProviderMutation"],
        ["codespaceProviderControl", "archiveCodespaceProviderControl"],
        ["codespaceOperation", "archiveCodespaceOperation"],
        ["codespaceTransfer", "archiveCommunicationTransfer"],
      ]);
      const beforeArchival = new Map(
        [...archivedTables.keys()].map((table) => [table, rows(sqlite, table)]),
      );
      migrate(drizzle(sqlite), { migrationsFolder: migrations });
      for (const [table, archive] of archivedTables) {
        // Full-row equality also retains the original running operation and cleanup uncertainty.
        expect(rows(sqlite, archive)).toEqual(beforeArchival.get(table));
        expect(
          sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table),
        ).toBeUndefined();
      }
      expect(sqlite.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      sqlite.close();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
