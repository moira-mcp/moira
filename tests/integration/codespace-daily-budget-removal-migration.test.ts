import { describe, expect, test } from "@jest/globals";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const migrations = path.resolve(process.cwd(), "packages/web-backend/drizzle");

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

describe("codespace daily budget removal migration", () => {
  test("drops submitted-operation accounting while preserving required cleanups", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "moira-codespace-budget-migration-"));
    const sqlite = new Database(path.join(directory, "moira.db"));
    try {
      sqlite.pragma("foreign_keys = ON");
      migrate(drizzle(sqlite), {
        migrationsFolder: copyBeforeMigration(directory, "0031_workspace_daily_budget_removal"),
      });
      sqlite
        .prepare(
          `INSERT INTO user (id, email, handle, createdAt, updatedAt)
         VALUES ('user-1', 'one@example.test', 'user-one', 'before', 'before')`,
        )
        .run();
      sqlite
        .prepare("INSERT INTO workspacePolicyUsage VALUES (?, ?, ?, ?, ?, ?)")
        .run("user-1", "github-codespaces", "2026-09-13", 23, 4, 1789300000000);

      // Verify the budget rewrite before the controller migration retires cloud accounting.
      migrate(drizzle(sqlite), {
        migrationsFolder: copyBeforeMigration(directory, "0061_local_controller_authority"),
      });

      const columns = (
        sqlite.prepare("PRAGMA table_info(codespacePolicyUsage)").all() as Array<{ name: string }>
      ).map(({ name }) => name);
      expect(columns).toEqual([
        "userId",
        "provider",
        "utcDay",
        "requiredCleanupOperations",
        "updatedAt",
      ]);
      // The accounting that outlives the removed budget keeps the day's recorded cleanups.
      expect(sqlite.prepare("SELECT * FROM codespacePolicyUsage").all()).toEqual([
        {
          userId: "user-1",
          provider: "github-codespaces",
          utcDay: "2026-09-13",
          requiredCleanupOperations: 4,
          updatedAt: 1789300000000,
        },
      ]);
      // The day key must still reject a duplicate row after the table was rewritten.
      expect(() =>
        sqlite
          .prepare("INSERT INTO codespacePolicyUsage VALUES (?, ?, ?, ?, ?)")
          .run("user-1", "github-codespaces", "2026-09-13", 1, 1789300000001),
      ).toThrow(/UNIQUE constraint failed/);

      const retained = sqlite.prepare("SELECT * FROM codespacePolicyUsage").all();
      migrate(drizzle(sqlite), { migrationsFolder: migrations });
      expect(sqlite.prepare("SELECT * FROM archiveCodespacePolicyUsage").all()).toEqual(retained);
      expect(
        sqlite.prepare("SELECT name FROM sqlite_master WHERE name='codespacePolicyUsage'").get(),
      ).toBeUndefined();
      expect(sqlite.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      sqlite.close();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
