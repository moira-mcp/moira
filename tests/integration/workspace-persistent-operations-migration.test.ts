import { describe, expect, test } from "@jest/globals";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const migrations = path.resolve(process.cwd(), "packages/web-backend/drizzle");

function copyBeforePersistentMigration(directory: string): string {
  const target = path.join(directory, "before-persistent-workspaces");
  fs.cpSync(migrations, target, { recursive: true });
  const journalPath = path.join(target, "meta/_journal.json");
  const journal = JSON.parse(fs.readFileSync(journalPath, "utf8")) as {
    entries: Array<{ tag: string }>;
  };
  const index = journal.entries.findIndex(
    (entry) => entry.tag === "0027_persistent_workspace_operations",
  );
  expect(index).toBeGreaterThan(0);
  journal.entries = journal.entries.slice(0, index);
  fs.writeFileSync(journalPath, `${JSON.stringify(journal, null, 2)}\n`);
  return target;
}

describe("persistent workspace operation migration", () => {
  test("preserves old resources as legacy-disposable and adds metadata-only operations", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "moira-persistent-workspace-"));
    const sqlite = new Database(path.join(directory, "moira.db"));
    try {
      migrate(drizzle(sqlite), {
        migrationsFolder: copyBeforePersistentMigration(directory),
      });
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
           VALUES ('workspace-1', 'user-1', 'connection-1', 'github-codespaces', '301',
             'owner/repository', 'refs/heads/main', 'moira-old', 'silver-space', '101', '101',
             'basic', 'Basic', 'linux', 2, 1024, 2048, 'usable', 4, 10, 20, 1, 1)`,
        )
        .run();

      migrate(drizzle(sqlite), { migrationsFolder: migrations });

      expect(
        sqlite
          .prepare(
            `SELECT authorizationGeneration, retentionPolicy, desiredState, observedState
             FROM workspaceResource WHERE id = 'workspace-1'`,
          )
          .get(),
      ).toEqual({
        authorizationGeneration: 3,
        retentionPolicy: "legacy_disposable",
        desiredState: "running",
        observedState: "running",
      });
      const operationColumns = (
        sqlite.prepare("PRAGMA table_info(workspaceOperation)").all() as Array<{ name: string }>
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
    const before = copyBeforePersistentMigration(directory);
    const failed = path.join(directory, "failed");
    fs.cpSync(migrations, failed, { recursive: true });
    fs.appendFileSync(
      path.join(failed, "0027_persistent_workspace_operations.sql"),
      "\n--> statement-breakpoint\nCREATE TABLE invalid_persistent_workspace_migration (\n",
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
});
