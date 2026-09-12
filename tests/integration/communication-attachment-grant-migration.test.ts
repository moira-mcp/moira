import { describe, expect, test } from "@jest/globals";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const MIGRATIONS = path.resolve(process.cwd(), "packages/web-backend/drizzle");
const TABLE = "communication_attachment_grant";
const MIGRATION_TAG = "0023_communication_attachment_grants";

function copyBeforeGrantMigration(directory: string): string {
  const target = path.join(directory, "before-communication-grants");
  fs.cpSync(MIGRATIONS, target, { recursive: true });
  const journalPath = path.join(target, "meta/_journal.json");
  const journal = JSON.parse(fs.readFileSync(journalPath, "utf8")) as {
    entries: Array<{ tag: string }>;
  };
  const index = journal.entries.findIndex((entry) => entry.tag === MIGRATION_TAG);
  if (index < 1) throw new Error("Communication grant migration is absent from the journal");
  journal.entries = journal.entries.slice(0, index);
  fs.writeFileSync(journalPath, `${JSON.stringify(journal, null, 2)}\n`);
  return target;
}

describe("communication attachment grant migration", () => {
  test("upgrades an existing database with the digest-only grant shape", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "moira-communication-migration-"));
    const sqlite = new Database(path.join(directory, "moira.db"));
    try {
      migrate(drizzle(sqlite), { migrationsFolder: copyBeforeGrantMigration(directory) });
      migrate(drizzle(sqlite), { migrationsFolder: MIGRATIONS });

      const columns = (
        sqlite.prepare(`PRAGMA table_info(${TABLE})`).all() as Array<{ name: string }>
      ).map((column) => column.name);
      expect(columns).toContain("token_digest");
      expect(columns).not.toContain("token");
      expect(columns).toEqual(
        expect.arrayContaining([
          "user_id",
          "audience",
          "purpose",
          "declared_size",
          "state",
          "expires_at",
        ]),
      );
      const indexes = (
        sqlite.prepare(`PRAGMA index_list(${TABLE})`).all() as Array<{ name: string }>
      ).map((index) => index.name);
      expect(indexes).toEqual(
        expect.arrayContaining([
          "communication_grant_user_state_expiry_idx",
          "communication_grant_state_expiry_idx",
        ]),
      );
    } finally {
      sqlite.close();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }, 60_000);
});
