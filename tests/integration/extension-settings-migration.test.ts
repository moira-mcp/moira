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
const LATER_TABLE = "communication_attachment_grant";
const ATTEMPT_TABLE = "executionMutationAttempt";
const ATTEMPT_MIGRATION_TAG = "0024_execution_mutation_attempts";

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
    ) as { entries: Array<{ tag: string; when: number }> };
    expect(journal.entries.map((entry) => entry.tag)).toContain(NEW_MIGRATION_TAG);
    expect(journal.entries.map((entry) => entry.tag)).toContain(ATTEMPT_MIGRATION_TAG);
    const newMigrationTimestamp = journal.entries.find(
      (entry) => entry.tag === NEW_MIGRATION_TAG,
    )!.when;

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "moira-migration-"));
    const file = path.join(dir, "moira.db");
    const sqlite = new Database(file);
    sqlite.pragma("foreign_keys = ON");

    try {
      // A database as it was before this change: everything applied except the new migration.
      migrate(drizzle(sqlite), { migrationsFolder: MIGRATIONS });
      sqlite.exec(`DROP TABLE ${ATTEMPT_TABLE}`);
      sqlite.exec(`DROP TABLE ${LATER_TABLE}`);
      sqlite.exec(`DROP TABLE ${NEW_TABLE}`);
      sqlite
        .prepare("DELETE FROM __drizzle_migrations WHERE created_at >= ?")
        .run(newMigrationTimestamp);
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

      const schemaAfter = tableSchemas(sqlite);
      delete schemaAfter.__drizzle_migrations;
      delete schemaAfter[NEW_TABLE];
      delete schemaAfter[LATER_TABLE];
      delete schemaAfter[ATTEMPT_TABLE];
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
