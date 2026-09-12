import { describe, expect, test } from "@jest/globals";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const migrations = path.resolve(process.cwd(), "packages/web-backend/drizzle");

function copyBeforeTransferMigration(directory: string): string {
  const target = path.join(directory, "before-workspace-transfers");
  fs.cpSync(migrations, target, { recursive: true });
  const journalPath = path.join(target, "meta/_journal.json");
  const journal = JSON.parse(fs.readFileSync(journalPath, "utf8")) as {
    entries: Array<{ tag: string }>;
  };
  const index = journal.entries.findIndex((entry) => entry.tag === "0028_workspace_transfers");
  expect(index).toBeGreaterThan(0);
  journal.entries = journal.entries.slice(0, index);
  fs.writeFileSync(journalPath, `${JSON.stringify(journal, null, 2)}\n`);
  return target;
}

describe("workspace transfer migration", () => {
  test("adds metadata-only transfer authority without file bytes or source URLs", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "moira-workspace-transfer-migration-"));
    const sqlite = new Database(path.join(directory, "moira.db"));
    try {
      migrate(drizzle(sqlite), { migrationsFolder: copyBeforeTransferMigration(directory) });
      migrate(drizzle(sqlite), { migrationsFolder: migrations });
      const columns = (
        sqlite.prepare("PRAGMA table_info(workspaceTransfer)").all() as Array<{ name: string }>
      ).map(({ name }) => name);
      expect(columns).toEqual(
        expect.arrayContaining([
          "tokenDigest",
          "userId",
          "purpose",
          "state",
          "declaredSize",
          "observedSize",
          "sha256",
          "objectKey",
          "ownerPid",
          "ownerStartTime",
          "expiresAt",
        ]),
      );
      expect(columns).not.toEqual(
        expect.arrayContaining(["bytes", "content", "downloadUrl", "sourceUrl"]),
      );
    } finally {
      sqlite.close();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  test("rolls back the complete transfer table on migration failure", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "moira-workspace-transfer-rollback-"));
    const before = copyBeforeTransferMigration(directory);
    const failed = path.join(directory, "failed");
    fs.cpSync(migrations, failed, { recursive: true });
    fs.appendFileSync(
      path.join(failed, "0028_workspace_transfers.sql"),
      "\n--> statement-breakpoint\nCREATE TABLE invalid_workspace_transfer_migration (\n",
    );
    const sqlite = new Database(path.join(directory, "moira.db"));
    try {
      migrate(drizzle(sqlite), { migrationsFolder: before });
      expect(() => migrate(drizzle(sqlite), { migrationsFolder: failed })).toThrow();
      expect(
        sqlite.prepare("SELECT 1 FROM sqlite_master WHERE name = 'workspaceTransfer'").get(),
      ).toBeUndefined();
    } finally {
      sqlite.close();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
