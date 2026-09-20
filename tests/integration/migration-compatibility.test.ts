import { describe, expect, test } from "@jest/globals";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { bridgeLegacyExecutionWorkflowVersionMigration } from "../../scripts/migration-compatibility.js";

const MIGRATIONS = path.resolve(process.cwd(), "packages/web-backend/drizzle");
const LEGACY_CREATED_AT = 1789290120000;
const CODESPACE_RENAME_CREATED_AT = 1790000000000;
const WORKFLOW_VERSION_CREATED_AT = 1790000060000;

interface Journal {
  entries: Array<{
    idx: number;
    version: string;
    when: number;
    tag: string;
    breakpoints: boolean;
  }>;
}

function createLegacyMigrations(directory: string): string {
  const target = path.join(directory, "legacy-migrations");
  fs.cpSync(MIGRATIONS, target, { recursive: true });

  const journalPath = path.join(target, "meta/_journal.json");
  const journal = JSON.parse(fs.readFileSync(journalPath, "utf8")) as Journal;
  const renameIndex = journal.entries.findIndex((entry) => entry.tag === "0037_codespace_rename");
  expect(renameIndex).toBeGreaterThan(0);
  journal.entries = journal.entries.slice(0, renameIndex);
  journal.entries.push({
    idx: renameIndex,
    version: "7",
    when: LEGACY_CREATED_AT,
    tag: "0037_execution_workflow_version",
    breakpoints: true,
  });
  fs.writeFileSync(journalPath, `${JSON.stringify(journal, null, 2)}\n`);
  fs.copyFileSync(
    path.join(MIGRATIONS, "0038_execution_workflow_version.sql"),
    path.join(target, "0037_execution_workflow_version.sql"),
  );
  return target;
}

function tableNames(sqlite: Database.Database): string[] {
  return (
    sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all() as Array<{
      name: string;
    }>
  ).map((row) => row.name);
}

describe("migration compatibility bridge", () => {
  test("upgrades the exact pre-rebase 0037 database without adding workflowVersion twice", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "moira-migration-bridge-"));
    const sqlite = new Database(path.join(directory, "moira.db"));
    sqlite.pragma("foreign_keys = ON");

    try {
      migrate(drizzle(sqlite), { migrationsFolder: createLegacyMigrations(directory) });
      sqlite.exec(`
        INSERT INTO user (id, email, handle, createdAt, updatedAt)
        VALUES ('user-1', 'user@example.test', 'user-one', 'now', 'now');
        INSERT INTO workflow
          (id, userId, slug, name, version, graph, visibility, createdAt, updatedAt)
        VALUES ('workflow-1', 'user-1', 'workflow-one', 'Workflow', '15.8.0', '{}', 'private', 1, 1);
        INSERT INTO workflowExecution
          (executionId, workflowId, userId, state, context, workflowVersion, createdAt, updatedAt)
        VALUES ('execution-1', 'workflow-1', 'user-1', 'running', '{}', '15.8.0', 1, 1);
      `);

      expect(() => migrate(drizzle(sqlite), { migrationsFolder: MIGRATIONS })).toThrow(
        /Failed to run the query 'ALTER TABLE `workflowExecution` ADD `workflowVersion` text;'/,
      );
      expect(tableNames(sqlite)).toContain("workspaceConnection");
      expect(tableNames(sqlite)).not.toContain("codespaceConnection");

      expect(bridgeLegacyExecutionWorkflowVersionMigration(sqlite, MIGRATIONS)).toBe(true);
      expect(() => migrate(drizzle(sqlite), { migrationsFolder: MIGRATIONS })).not.toThrow();

      const names = tableNames(sqlite);
      expect(names).not.toContain("workspaceConnection");
      expect(names).toContain("codespaceConnection");
      expect(
        sqlite
          .prepare("SELECT workflowVersion FROM workflowExecution WHERE executionId = ?")
          .get("execution-1"),
      ).toEqual({ workflowVersion: "15.8.0" });
      const workflowVersionColumns = (
        sqlite.prepare("PRAGMA table_info(workflowExecution)").all() as Array<{ name: string }>
      ).filter((column) => column.name === "workflowVersion");
      expect(workflowVersionColumns).toHaveLength(1);

      const recorded = sqlite
        .prepare(
          `SELECT created_at AS createdAt
           FROM __drizzle_migrations
           WHERE created_at IN (?, ?, ?)
           ORDER BY created_at`,
        )
        .all(LEGACY_CREATED_AT, CODESPACE_RENAME_CREATED_AT, WORKFLOW_VERSION_CREATED_AT) as Array<{
        createdAt: number;
      }>;
      expect(recorded.map((row) => Number(row.createdAt))).toEqual([
        CODESPACE_RENAME_CREATED_AT,
        WORKFLOW_VERSION_CREATED_AT,
      ]);
      expect(sqlite.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      sqlite.close();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  test("does not activate for a migration row with an unknown hash", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "moira-migration-bridge-"));
    const sqlite = new Database(path.join(directory, "moira.db"));
    try {
      migrate(drizzle(sqlite), { migrationsFolder: createLegacyMigrations(directory) });
      sqlite
        .prepare("UPDATE __drizzle_migrations SET hash = ? WHERE created_at = ?")
        .run("unknown-legacy-hash", LEGACY_CREATED_AT);

      expect(bridgeLegacyExecutionWorkflowVersionMigration(sqlite, MIGRATIONS)).toBe(false);
      expect(tableNames(sqlite)).toContain("workspaceConnection");
      expect(tableNames(sqlite)).not.toContain("codespaceConnection");
    } finally {
      sqlite.close();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  test("does not activate for a partially renamed schema", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "moira-migration-bridge-"));
    const sqlite = new Database(path.join(directory, "moira.db"));
    try {
      migrate(drizzle(sqlite), { migrationsFolder: createLegacyMigrations(directory) });
      sqlite.exec("ALTER TABLE workspaceConnection RENAME TO codespaceConnection");

      expect(bridgeLegacyExecutionWorkflowVersionMigration(sqlite, MIGRATIONS)).toBe(false);
      expect(tableNames(sqlite)).toContain("workspaceResource");
      expect(tableNames(sqlite)).not.toContain("codespaceResource");
    } finally {
      sqlite.close();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  test("leaves a clean current migration path unchanged", () => {
    const sqlite = new Database(":memory:");
    try {
      expect(bridgeLegacyExecutionWorkflowVersionMigration(sqlite, MIGRATIONS)).toBe(false);
      expect(() => migrate(drizzle(sqlite), { migrationsFolder: MIGRATIONS })).not.toThrow();
      expect(bridgeLegacyExecutionWorkflowVersionMigration(sqlite, MIGRATIONS)).toBe(false);
    } finally {
      sqlite.close();
    }
  });
});
