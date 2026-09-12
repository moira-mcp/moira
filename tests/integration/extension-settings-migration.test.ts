/**
 * The value store appears on a database that already existed.
 *
 * A fresh database is green whatever the migration does, because everything is created at once.
 * The state that matters is an installation whose database was made before this change: the
 * migration must add the new table, leave every existing table exactly as it was, and leave the
 * data in them untouched — the container's start is gated on migrations succeeding, so a failure
 * here does not degrade an installation, it stops it.
 */

import { describe, test, expect } from "@jest/globals";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const MIGRATIONS = path.resolve(process.cwd(), "packages/web-backend/drizzle");
const NEW_TABLE = "extensionSettingValue";
const NEW_MIGRATION_TAG = "0022_extension_setting_values";
const ATTEMPT_MIGRATION_TAG = "0024_execution_mutation_attempts";
const WORKSPACE_MIGRATION_TAG = "0026_workspace_resources";

function tableNames(sqlite: ReturnType<typeof Database>): string[] {
  return (
    sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all() as Array<{ name: string }>
  ).map((row) => row.name);
}

function tableSchemas(sqlite: ReturnType<typeof Database>): Record<string, string> {
  const rows = sqlite
    .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' AND sql IS NOT NULL")
    .all() as Array<{ name: string; sql: string }>;
  return Object.fromEntries(rows.map((row) => [row.name, row.sql]));
}

describe("Migrating a database created before the extension value store", () => {
  test("the new table appears, the existing ones are untouched, and their rows survive", () => {
    const journal = JSON.parse(
      fs.readFileSync(path.join(MIGRATIONS, "meta/_journal.json"), "utf8"),
    ) as { entries: Array<{ tag: string }> };
    expect(journal.entries.map((entry) => entry.tag)).toContain(NEW_MIGRATION_TAG);
    expect(journal.entries.map((entry) => entry.tag)).toContain(ATTEMPT_MIGRATION_TAG);
    expect(journal.entries.map((entry) => entry.tag)).toContain(WORKSPACE_MIGRATION_TAG);

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "moira-migration-"));
    const beforeMigrations = path.join(dir, "before-extension-settings");
    fs.cpSync(MIGRATIONS, beforeMigrations, { recursive: true });
    const beforeJournalPath = path.join(beforeMigrations, "meta/_journal.json");
    const beforeJournal = JSON.parse(fs.readFileSync(beforeJournalPath, "utf8")) as {
      entries: Array<{ tag: string }>;
    };
    const extensionMigrationIndex = beforeJournal.entries.findIndex(
      (entry) => entry.tag === NEW_MIGRATION_TAG,
    );
    beforeJournal.entries = beforeJournal.entries.slice(0, extensionMigrationIndex);
    fs.writeFileSync(beforeJournalPath, `${JSON.stringify(beforeJournal, null, 2)}\n`);
    const file = path.join(dir, "moira.db");
    const sqlite = new Database(file);
    sqlite.pragma("foreign_keys = ON");

    try {
      // A database as it was before this change: everything applied except the new migration.
      migrate(drizzle(sqlite), { migrationsFolder: beforeMigrations });
      expect(tableNames(sqlite)).not.toContain(NEW_TABLE);

      // Data an installation would already have, so that "untouched" means something.
      sqlite
        .prepare(
          `INSERT INTO settingDefinition (key, type, category, label, required, adminOnly, protected, createdAt, updatedAt)
           VALUES ('telegram.bot_token', 'encrypted', 'notifications', 'Bot token', 0, 0, 1, 1, 1)`,
        )
        .run();
      const schemaBefore = tableSchemas(sqlite);
      delete schemaBefore.__drizzle_migrations;

      migrate(drizzle(sqlite), { migrationsFolder: MIGRATIONS });

      // Required state: the store is there. Plausible wrong state: the migration is skipped because
      // the journal thinks it ran, and the installation starts without the table.
      expect(tableNames(sqlite)).toContain(NEW_TABLE);

      const allSchemasAfter = tableSchemas(sqlite);
      const schemaAfter = Object.fromEntries(
        Object.keys(schemaBefore).map((name) => [name, allSchemasAfter[name]]),
      );
      // Every other table is byte-for-byte the definition it had before.
      expect(schemaAfter).toEqual(schemaBefore);

      const kept = sqlite
        .prepare("SELECT key FROM settingDefinition WHERE key = 'telegram.bot_token'")
        .all();
      expect(kept).toHaveLength(1);

      // And the store has the shape the repository writes into: the columns, their order and the
      // composite key. Asserting the schema rather than inserting a row keeps the observation
      // meaningful on a database whose `user` table is empty.
      const columns = (
        sqlite.prepare(`PRAGMA table_info(${NEW_TABLE})`).all() as Array<{
          name: string;
          notnull: number;
          pk: number;
        }>
      ).map((column) => ({ name: column.name, notnull: column.notnull, pk: column.pk }));

      expect(columns.map((column) => column.name)).toEqual([
        "userId",
        "settingKey",
        "value",
        "encrypted",
        "updatedAt",
      ]);
      expect(columns.filter((column) => column.pk > 0).map((column) => column.name)).toEqual([
        "userId",
        "settingKey",
      ]);
    } finally {
      sqlite.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
