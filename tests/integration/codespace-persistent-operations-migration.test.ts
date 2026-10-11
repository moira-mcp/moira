import { describe, expect, test } from "@jest/globals";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { CodespaceOperationRepository } from "../../packages/shared/src/codespaces/operation-repository.js";

const migrations = path.resolve(process.cwd(), "packages/web-backend/drizzle");

function copyBeforeMigration(
  directory: string,
  tag = "0029_persistent_workspace_operations",
): string {
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

function insertLegacyResource(sqlite: Database.Database): void {
  sqlite
    .prepare(
      `INSERT INTO user (id, email, handle, createdAt, updatedAt)
       VALUES ('user-1', 'one@example.test', 'user-one', 'now', 'now')`,
    )
    .run();
  sqlite
    .prepare(
      `INSERT INTO workspaceConnection
       (id, userId, provider, externalAccountId, externalLogin, status,
        credentialGeneration, createdAt, updatedAt)
       VALUES ('connection-1', 'user-1', 'github-codespaces', '101', 'owner',
               'connected', 3, 1, 1)`,
    )
    .run();
  sqlite
    .prepare(
      `INSERT INTO workspaceResource
       (id, userId, connectionId, provider, repositoryId, repositoryFullName,
        requestedRef, operationMarker, providerResourceName, externalOwnerId,
        billableOwnerId, machineName, machineDisplayName, machineOperatingSystem,
        machineCpuCores, machineMemoryBytes, machineStorageBytes, state, generation,
        createDeadlineAt, remoteExpiresAt, createdAt, updatedAt)
       VALUES ('codespace-1', 'user-1', 'connection-1', 'github-codespaces', '301',
         'owner/repository', 'refs/heads/main', 'moira-old', 'silver-space', '101', '101',
         'basic', 'Basic', 'linux', 2, 1024, 2048, 'usable', 4, 10, 20, 1, 1)`,
    )
    .run();
}

function prepareBeforeAcceptance(sqlite: Database.Database, directory: string): void {
  migrate(drizzle(sqlite), { migrationsFolder: copyBeforeMigration(directory) });
  insertLegacyResource(sqlite);
  migrate(drizzle(sqlite), {
    migrationsFolder: copyBeforeMigration(directory, "0058_codespace_operation_acceptance"),
  });
  const insert = sqlite.prepare(
    `INSERT INTO codespaceOperation
     (id, userId, resourceId, resourceGeneration, authorizationGeneration, provider,
      providerResourceName, remoteMarker, kind, state, inputBytes, stdoutLimitBytes,
      stderrLimitBytes, outputBytes, exitCode, remoteCleanupPending, resultExpiresAt,
      deadlineAt, lastOutcome, createdAt, updatedAt)
     VALUES (?, 'user-1', 'codespace-1', 4, 3, 'github-codespaces', 'silver-space', ?,
       'exec', ?, 128, 1024, 1024, ?, ?, 1, ?, 1000, ?, 10, 20)`,
  );
  insert.run("old-success", "moira-old-success", "succeeded", 17, 0, 5000, "remote_terminal");
  insert.run(
    "old-unknown",
    "moira-old-unknown",
    "reconcile_pending",
    0,
    null,
    null,
    "remote_outcome_unknown",
  );
  sqlite
    .prepare(
      `INSERT INTO codespaceLocalDevice
     (id, userId, connectionId, label, status, credentialDigest, policy, policyDigest, createdAt, updatedAt)
     VALUES ('device-1', 'user-1', 'connection-1', 'test', 'active', 'test-credential-digest', '{}', 'test-policy-digest', 1, 1)`,
    )
    .run();
  const relay = sqlite.prepare(
    `INSERT INTO codespaceLocalRelay
     (requestId, userId, deviceId, deviceGeneration, connectionId, resourceId,
      resourceGeneration, digest, inputReference, status, claimId, claimExpiresAt,
      deadlineAt, createdAt, updatedAt)
     VALUES (?, 'user-1', 'device-1', 1, 'connection-1', 'codespace-1', 4,
       'test-request-digest', 'test-private-reference', ?, ?, ?, 1000, 10, 20)`,
  );
  relay.run("old-claimed", "claimed", "original-claim", 100);
  relay.run("old-queued", "queued", null, null);
}

describe("persistent codespace operation migration", () => {
  test("preserves old resources as legacy-disposable and adds metadata-only operations", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "moira-persistent-codespace-"));
    const sqlite = new Database(path.join(directory, "moira.db"));
    try {
      migrate(drizzle(sqlite), {
        migrationsFolder: copyBeforeMigration(directory),
      });
      insertLegacyResource(sqlite);

      migrate(drizzle(sqlite), { migrationsFolder: migrations });

      expect(
        sqlite
          .prepare(
            `SELECT authorizationGeneration, retentionPolicy, desiredState, observedState
             FROM codespaceResource WHERE id = 'codespace-1'`,
          )
          .get(),
      ).toEqual({
        authorizationGeneration: 3,
        retentionPolicy: "legacy_disposable",
        desiredState: "running",
        observedState: "running",
      });
      const operationColumns = (
        sqlite.prepare("PRAGMA table_info(codespaceOperation)").all() as Array<{ name: string }>
      ).map(({ name }) => name);
      expect(operationColumns).toEqual(
        expect.arrayContaining([
          "resourceId",
          "resourceGeneration",
          "authorizationGeneration",
          "remoteMarker",
          "inputBytes",
          "stdoutLimitBytes",
          "stderrLimitBytes",
          "outputBytes",
          "exitCode",
          "remoteCleanupPending",
          "resultExpiresAt",
        ]),
      );
      expect(operationColumns).not.toEqual(
        expect.arrayContaining([
          "argv",
          "command",
          "cwd",
          "stdin",
          "stdout",
          "stderr",
          "token",
          "credential",
          "sshConfig",
        ]),
      );
    } finally {
      sqlite.close();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  test("rolls back every lifecycle column and operation table on injected failure", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "moira-persistent-rollback-"));
    const before = copyBeforeMigration(directory);
    const failed = path.join(directory, "failed");
    fs.cpSync(migrations, failed, { recursive: true });
    fs.appendFileSync(
      path.join(failed, "0029_persistent_workspace_operations.sql"),
      "\n--> statement-breakpoint\nCREATE TABLE invalid_persistent_codespace_migration (\n",
    );
    const sqlite = new Database(path.join(directory, "moira.db"));
    try {
      migrate(drizzle(sqlite), { migrationsFolder: before });
      expect(() => migrate(drizzle(sqlite), { migrationsFolder: failed })).toThrow();
      const columns = (
        sqlite.prepare("PRAGMA table_info(workspaceResource)").all() as Array<{ name: string }>
      ).map(({ name }) => name);
      expect(columns).not.toContain("retentionPolicy");
      expect(
        sqlite.prepare("SELECT 1 FROM sqlite_master WHERE name = 'workspaceOperation'").get(),
      ).toBeUndefined();
    } finally {
      sqlite.close();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  test("acceptance migration keeps historical identities and uncertainty addressable without inventing caller or start evidence", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "moira-acceptance-migration-"));
    const sqlite = new Database(path.join(directory, "moira.db"));
    try {
      prepareBeforeAcceptance(sqlite, directory);
      const historical = sqlite.prepare("SELECT * FROM codespaceOperation ORDER BY id").all();
      const relays = sqlite.prepare("SELECT * FROM codespaceLocalRelay ORDER BY requestId").all();

      migrate(drizzle(sqlite), { migrationsFolder: migrations });

      const repository = new CodespaceOperationRepository(sqlite);
      expect(historical).toHaveLength(2);
      for (const row of historical as Array<{ id: string }>) {
        expect(repository.getOwned("user-1", row.id)).toEqual({
          ...row,
          requestId: null,
          requestDigest: null,
          inputReference: null,
          resultReference: null,
          admissionDeadlineAt: null,
          runtimeMs: null,
          startedAt: null,
          sessionKey: null,
        });
        expect(repository.getOwned("other-user", row.id)).toBeNull();
      }
      expect(sqlite.prepare("SELECT * FROM codespaceLocalRelay ORDER BY requestId").all()).toEqual(
        (relays as Array<{ claimId: string | null }>).map((row) => ({
          ...row,
          settlementClaimId: row.claimId,
        })),
      );
    } finally {
      sqlite.close();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  test("failed acceptance migration rolls back new authority fields while preserving accepted effects and original claims", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "moira-acceptance-rollback-"));
    const sqlite = new Database(path.join(directory, "moira.db"));
    try {
      prepareBeforeAcceptance(sqlite, directory);
      const historical = sqlite.prepare("SELECT * FROM codespaceOperation ORDER BY id").all();
      const relays = sqlite.prepare("SELECT * FROM codespaceLocalRelay ORDER BY requestId").all();
      const failed = path.join(directory, "failed-acceptance");
      fs.cpSync(migrations, failed, { recursive: true });
      fs.appendFileSync(
        path.join(failed, "0058_codespace_operation_acceptance.sql"),
        "\n--> statement-breakpoint\nCREATE TABLE invalid_acceptance_migration (\n",
      );

      expect(() => migrate(drizzle(sqlite), { migrationsFolder: failed })).toThrow();

      expect(sqlite.prepare("SELECT * FROM codespaceOperation ORDER BY id").all()).toEqual(
        historical,
      );
      expect(sqlite.prepare("SELECT * FROM codespaceLocalRelay ORDER BY requestId").all()).toEqual(
        relays,
      );
      expect(
        (
          sqlite.prepare("PRAGMA table_info(codespaceOperation)").all() as Array<{ name: string }>
        ).map((row) => row.name),
      ).not.toContain("requestId");
      expect(
        (
          sqlite.prepare("PRAGMA table_info(codespaceLocalRelay)").all() as Array<{ name: string }>
        ).map((row) => row.name),
      ).not.toContain("settlementClaimId");
    } finally {
      sqlite.close();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
