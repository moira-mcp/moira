import { describe, expect, test } from "@jest/globals";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const MIGRATIONS = path.resolve(process.cwd(), "packages/web-backend/drizzle");
const TABLE = "communication_attachment_grant";

describe("communication attachment grant migration", () => {
  test("upgrades an existing database with the digest-only grant shape", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "moira-communication-migration-"));
    const sqlite = new Database(path.join(directory, "moira.db"));
    try {
      migrate(drizzle(sqlite), { migrationsFolder: MIGRATIONS });
      sqlite.exec(`DROP TABLE ${TABLE}`);
      sqlite
        .prepare(
          "DELETE FROM __drizzle_migrations WHERE hash IN (SELECT hash FROM __drizzle_migrations ORDER BY created_at DESC LIMIT 1)",
        )
        .run();
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
