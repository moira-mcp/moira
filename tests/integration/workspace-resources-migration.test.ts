import { describe, expect, test } from "@jest/globals";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const migrations = path.resolve(process.cwd(), "packages/web-backend/drizzle");
const resourceTables = [
  "workspaceLifecycleCapability",
  "workspacePolicyUsage",
  "workspaceProviderControl",
  "workspaceProviderMutation",
  "workspaceResource",
];

function copyBeforeResourceMigration(directory: string): string {
  const target = path.join(directory, "before-resources");
  fs.cpSync(migrations, target, { recursive: true });
  const journalPath = path.join(target, "meta/_journal.json");
  const journal = JSON.parse(fs.readFileSync(journalPath, "utf8")) as {
    entries: Array<{ tag: string }>;
  };
  const index = journal.entries.findIndex((entry) => entry.tag === "0026_workspace_resources");
  expect(index).toBeGreaterThan(0);
  journal.entries = journal.entries.slice(0, index);
  fs.writeFileSync(journalPath, `${JSON.stringify(journal, null, 2)}\n`);
  return target;
}

function hasTable(sqlite: Database.Database, name: string): boolean {
  return Boolean(
    sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name),
  );
}

describe("workspace resource migration", () => {
  test("upgrades Unit 1 data without credentials or partial ownership authority", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "moira-resource-migration-"));
    const before = copyBeforeResourceMigration(directory);
    const sqlite = new Database(path.join(directory, "moira.db"));
    sqlite.pragma("foreign_keys = ON");
    try {
      migrate(drizzle(sqlite), { migrationsFolder: before });
      sqlite
        .prepare(
          `INSERT INTO user (id, email, handle, createdAt, updatedAt)
         VALUES ('user-1', 'one@example.test', 'user-one', 'before', 'before')`,
        )
        .run();
      sqlite
        .prepare(
          `INSERT INTO workspaceConnection
         (id, userId, provider, externalAccountId, externalLogin, status,
          credentialGeneration, createdAt, updatedAt)
         VALUES ('connection-1', 'user-1', 'github-codespaces', '101', 'owner',
                 'connected', 1, 1, 1)`,
        )
        .run();

      migrate(drizzle(sqlite), { migrationsFolder: migrations });
      expect(resourceTables.every((table) => hasTable(sqlite, table))).toBe(true);
      expect(sqlite.prepare("SELECT externalLogin FROM workspaceConnection").get()).toEqual({
        externalLogin: "owner",
      });
      const schema = resourceTables.map(
        (table) =>
          (
            sqlite.prepare("SELECT sql FROM sqlite_master WHERE name = ?").get(table) as {
              sql: string;
            }
          ).sql,
      );
      expect(schema.join("\n")).not.toMatch(/accessToken|refreshToken|privateKey|sshKey/);
    } finally {
      sqlite.close();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  test("rolls back every resource table when the migration fails", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "moira-resource-rollback-"));
    const before = copyBeforeResourceMigration(directory);
    const failed = path.join(directory, "failed");
    fs.cpSync(migrations, failed, { recursive: true });
    fs.appendFileSync(
      path.join(failed, "0026_workspace_resources.sql"),
      "\n--> statement-breakpoint\nCREATE TABLE invalid_resource_migration (\n",
    );
    const sqlite = new Database(path.join(directory, "moira.db"));
    try {
      migrate(drizzle(sqlite), { migrationsFolder: before });
      expect(() => migrate(drizzle(sqlite), { migrationsFolder: failed })).toThrow();
      expect(resourceTables.some((table) => hasTable(sqlite, table))).toBe(false);
    } finally {
      sqlite.close();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
