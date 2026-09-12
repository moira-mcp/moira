import { describe, expect, test } from "@jest/globals";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const migrations = path.resolve(process.cwd(), "packages/web-backend/drizzle");
const newTables = [
  "workspaceAuthorizationState",
  "workspaceConnection",
  "workspaceConnectionInstallation",
  "workspaceConnectionRepository",
  "workspaceCredentialRevocation",
  "workspaceCredentialVault",
];

function tables(sqlite: Database.Database): string[] {
  return (
    sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all() as Array<{
      name: string;
    }>
  ).map(({ name }) => name);
}

function copyMigrationsBeforeWorkspaceFeature(directory: string): string {
  const target = path.join(directory, "pre-feature-migrations");
  fs.cpSync(migrations, target, { recursive: true });
  const journalPath = path.join(target, "meta/_journal.json");
  const journal = JSON.parse(fs.readFileSync(journalPath, "utf8")) as {
    entries: Array<{ tag: string }>;
  };
  const workspaceMigrationIndex = journal.entries.findIndex(
    (entry) => entry.tag === "0025_workspace_connections",
  );
  expect(workspaceMigrationIndex).toBeGreaterThan(0);
  journal.entries = journal.entries.slice(0, workspaceMigrationIndex);
  fs.writeFileSync(journalPath, `${JSON.stringify(journal, null, 2)}\n`);
  return target;
}

describe("Workspace connection schema migration", () => {
  test("upgrades a pre-feature database without changing unrelated data or adding plaintext defaults", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "moira-workspace-migration-"));
    const filename = path.join(directory, "moira.db");
    const preFeatureMigrations = copyMigrationsBeforeWorkspaceFeature(directory);
    const sqlite = new Database(filename);
    sqlite.pragma("foreign_keys = ON");
    try {
      migrate(drizzle(sqlite), { migrationsFolder: preFeatureMigrations });
      expect(newTables.some((table) => tables(sqlite).includes(table))).toBe(false);

      sqlite
        .prepare(
          `INSERT INTO user (id, email, name, handle, createdAt, updatedAt)
           VALUES ('existing-user', 'existing@example.test', 'Existing', 'existing-user', 'before', 'before')`,
        )
        .run();
      sqlite
        .prepare(
          `INSERT INTO settingDefinition
           (key, type, category, label, required, adminOnly, protected, createdAt, updatedAt)
           VALUES ('existing.setting', 'string', 'test', 'Existing', 0, 0, 0, 1, 1)`,
        )
        .run();
      sqlite
        .prepare(
          `INSERT INTO workflow
           (id, userId, slug, name, version, graph, visibility, deleted, createdAt, updatedAt)
           VALUES ('existing-workflow', 'existing-user', 'existing-flow', 'Existing flow', '1.0.0',
                   '{"nodes":[],"connections":[]}', 'private', 0, 1, 1)`,
        )
        .run();
      sqlite
        .prepare(
          `INSERT INTO extensionSettingValue
           (userId, settingKey, value, encrypted, updatedAt)
           VALUES ('existing-user', 'example.setting', 'preserved-value', 0, 1)`,
        )
        .run();
      sqlite
        .prepare(
          `INSERT INTO oauthConsent
           (id, clientId, userId, scopes, createdAt, updatedAt, consentGiven)
           VALUES ('existing-consent', 'existing-client', 'existing-user', 'openid',
                   'before', 'before', 1)`,
        )
        .run();

      migrate(drizzle(sqlite), { migrationsFolder: migrations });

      expect(newTables.every((table) => tables(sqlite).includes(table))).toBe(true);
      expect(sqlite.prepare("SELECT email FROM user WHERE id = 'existing-user'").get()).toEqual({
        email: "existing@example.test",
      });
      expect(
        sqlite.prepare("SELECT label FROM settingDefinition WHERE key = 'existing.setting'").get(),
      ).toEqual({ label: "Existing" });
      expect(
        sqlite.prepare("SELECT name FROM workflow WHERE id = 'existing-workflow'").get(),
      ).toEqual({ name: "Existing flow" });
      expect(
        sqlite
          .prepare(
            "SELECT value FROM extensionSettingValue WHERE userId = 'existing-user' AND settingKey = 'example.setting'",
          )
          .get(),
      ).toEqual({ value: "preserved-value" });
      expect(
        sqlite.prepare("SELECT scopes FROM oauthConsent WHERE id = 'existing-consent'").get(),
      ).toEqual({ scopes: "openid" });
      const workspaceSchema = newTables.map(
        (table) =>
          (
            sqlite
              .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
              .get(table) as { sql: string }
          ).sql,
      );
      expect(workspaceSchema.join("\n")).not.toMatch(/accessToken|refreshToken|clientSecret/);
    } finally {
      sqlite.close();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  test("creates the complete empty workspace schema on a clean database", () => {
    const sqlite = new Database(":memory:");
    sqlite.pragma("foreign_keys = ON");
    try {
      migrate(drizzle(sqlite), { migrationsFolder: migrations });
      expect(newTables.every((table) => tables(sqlite).includes(table))).toBe(true);
      for (const table of newTables) {
        expect(sqlite.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()).toEqual({
          count: 0,
        });
      }
    } finally {
      sqlite.close();
    }
  });

  test("rolls back the workspace schema when its migration fails", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "moira-workspace-rollback-"));
    const preFeatureMigrations = copyMigrationsBeforeWorkspaceFeature(directory);
    const failedMigrations = path.join(directory, "failed-migrations");
    fs.cpSync(migrations, failedMigrations, { recursive: true });
    const migrationPath = path.join(failedMigrations, "0025_workspace_connections.sql");
    fs.appendFileSync(
      migrationPath,
      "\n--> statement-breakpoint\nCREATE TABLE intentionally_invalid (\n",
    );
    const sqlite = new Database(path.join(directory, "moira.db"));
    sqlite.pragma("foreign_keys = ON");
    try {
      migrate(drizzle(sqlite), { migrationsFolder: preFeatureMigrations });
      sqlite
        .prepare(
          `INSERT INTO user (id, email, name, handle, createdAt, updatedAt)
           VALUES ('existing-user', 'existing@example.test', 'Existing', 'existing-user', 'before', 'before')`,
        )
        .run();

      expect(() => migrate(drizzle(sqlite), { migrationsFolder: failedMigrations })).toThrow();
      expect(newTables.some((table) => tables(sqlite).includes(table))).toBe(false);
      expect(sqlite.prepare("SELECT email FROM user WHERE id = 'existing-user'").get()).toEqual({
        email: "existing@example.test",
      });
    } finally {
      sqlite.close();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
