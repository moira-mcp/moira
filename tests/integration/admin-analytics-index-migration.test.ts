import { describe, expect, test } from "@jest/globals";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { sql } from "drizzle-orm";
import { storedTimestampMs } from "../../packages/shared/src/database/timestamp-sql.js";

const MIGRATIONS = path.resolve(process.cwd(), "packages/web-backend/drizzle");
describe("Administrative analytics index migration", () => {
  test("upgrades an existing database without changing data and supports its scalar access paths", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "moira-analytics-migration-"));
    const sqlite = new Database(":memory:");
    try {
      const oldMigrations = path.join(directory, "before-analytics");
      fs.cpSync(MIGRATIONS, oldMigrations, { recursive: true });
      const journalPath = path.join(oldMigrations, "meta/_journal.json");
      const journal = JSON.parse(fs.readFileSync(journalPath, "utf8")) as {
        entries: Array<{ tag: string }>;
      };
      const index = journal.entries.findIndex(
        (entry) => entry.tag === "0050_admin_analytics_indexes",
      );
      if (index < 1) throw new Error("Analytics index migration missing from journal");
      journal.entries = journal.entries.slice(0, index);
      fs.writeFileSync(journalPath, JSON.stringify(journal));
      const db = drizzle(sqlite);
      migrate(db, { migrationsFolder: oldMigrations });
      sqlite
        .prepare("INSERT INTO user(id,email,handle,createdAt,updatedAt) VALUES(?,?,?,?,?)")
        .run(
          "owner",
          "owner@example.test",
          "owner",
          "2026-01-01T00:00:00.000Z",
          "2026-01-01T00:00:00.000Z",
        );
      sqlite
        .prepare(
          "INSERT INTO workflow(id,userId,slug,name,version,graph,createdAt,updatedAt) VALUES(?,?,?,?,?,?,?,?)",
        )
        .run("flow", "owner", "flow", "Flow", "1.0.0", '{"preserve":true}', 1, 1);
      sqlite
        .prepare(
          "INSERT INTO workflowExecution(executionId,workflowId,userId,state,context,createdAt,updatedAt) VALUES(?,?,?,?,?,?,?)",
        )
        .run("run", "flow", "owner", "running", '{"private":"preserved"}', 1, 1);
      sqlite
        .prepare(
          "INSERT INTO session(id,token,userId,createdAt,updatedAt,expiresAt) VALUES(?,?,?,?,?,?)",
        )
        .run(
          "legacy-session",
          "legacy-session",
          "owner",
          "2026-09-30T11:00:00.000Z",
          "2026-09-30T11:00:00.001Z",
          "2026-10-01T11:00:00.000Z",
        );
      const insertUser = sqlite.prepare(
        "INSERT INTO user(id,email,handle,createdAt,updatedAt) VALUES(?,?,?,?,?)",
      );
      for (const [index, timestamp] of [
        "now",
        "subsec",
        "subsecond",
        "invalid",
        "2026-09-30 11:45:00",
        "2026-09-30T11:45:00.123Z",
      ].entries()) {
        insertUser.run(
          `legacy-${index}`,
          `legacy-${index}@example.test`,
          `legacy-${index}`,
          timestamp,
          timestamp,
        );
      }
      migrate(db, { migrationsFolder: MIGRATIONS });
      expect(
        sqlite
          .prepare("SELECT createdAt,updatedAt,refreshedAt FROM session WHERE id='legacy-session'")
          .get(),
      ).toEqual({
        createdAt: "2026-09-30T11:00:00.000Z",
        updatedAt: "2026-09-30T11:00:00.001Z",
        refreshedAt: null,
      });
      // The same arbitrary historical values remain insertable after the new index exists.
      insertUser.run("post-index", "post@example.test", "post-index", "now", "now");
      expect(
        db.all(
          sql`SELECT ${storedTimestampMs(sql`createdAt`)} AS at FROM user WHERE id LIKE 'legacy-%' OR id='post-index' ORDER BY id`,
        ),
      ).toEqual([
        { at: null },
        { at: null },
        { at: null },
        { at: null },
        { at: Date.UTC(2026, 8, 30, 11, 45) },
        { at: Date.UTC(2026, 8, 30, 11, 45, 0, 123) },
        { at: null },
      ]);
      expect(
        sqlite.prepare("SELECT context FROM workflowExecution WHERE executionId='run'").get(),
      ).toEqual({ context: '{"private":"preserved"}' });
      expect(sqlite.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      const epoch = storedTimestampMs(sql`createdAt`);
      const registrationPlan = db.all<{ detail: string }>(
        sql`EXPLAIN QUERY PLAN SELECT id FROM user WHERE ${epoch}>=0 ORDER BY ${epoch}`,
      );
      expect(registrationPlan.map((row) => row.detail).join("\n")).toContain(
        "user_registration_epoch_idx",
      );
      for (const [query, args, expectedIndex] of [
        [
          "SELECT executionId FROM workflowExecution WHERE userId=? AND createdAt>=? ORDER BY createdAt",
          ["owner", 0],
          "execution_user_created_idx",
        ],
        [
          "SELECT executionId FROM workflowExecution WHERE workflowId=? AND createdAt>=?",
          ["flow", 0],
          "execution_workflow_created_idx",
        ],
        [
          "SELECT executionId FROM workflowExecution WHERE state=? AND createdAt>=? ORDER BY createdAt",
          ["running", 0],
          "execution_state_created_idx",
        ],
        [
          "SELECT executionId FROM workflowExecution WHERE createdAt>=? ORDER BY createdAt",
          [0],
          "execution_created_idx",
        ],
        ["SELECT max(createdAt) FROM auditLog WHERE userId=?", ["owner"], "audit_user_created_idx"],
        [
          "SELECT max(createdAt) FROM auditLog WHERE resourceId=? AND action=? AND resource='execution'",
          ["run", "execution:step"],
          "audit_resource_action_created_idx",
        ],
        ["SELECT count(*) FROM auditLog WHERE createdAt>=?", [0], "audit_created_idx"],
      ] as Array<[string, Array<string | number>, string]>) {
        const plan = sqlite.prepare(`EXPLAIN QUERY PLAN ${query}`).all(...args) as Array<{
          detail: string;
        }>;
        expect(plan.map((row) => row.detail).join("\n")).toContain(expectedIndex);
      }
      const expiry = storedTimestampMs(sql`expiresAt`);
      const renewal = storedTimestampMs(sql`refreshedAt`);
      for (const [statement, expectedIndex] of [
        [
          sql`EXPLAIN QUERY PLAN SELECT max(${renewal}) FROM session WHERE userId='owner' AND ${expiry}>0 AND ${renewal}<2000000000000`,
          "session_user_expiry_activity_idx",
        ],
        [
          sql`EXPLAIN QUERY PLAN SELECT count(*) FROM session WHERE ${renewal}>=0 AND ${expiry}>0`,
          "session_activity_expiry_idx",
        ],
      ] as const) {
        expect(
          db
            .all<{ detail: string }>(statement)
            .map((row) => row.detail)
            .join("\n"),
        ).toContain(expectedIndex);
      }
      // An older auth version ignores this nullable observation; removing it does
      // not change identity, credentials, expiry or the provider's own timestamps.
      sqlite.exec(
        "DROP INDEX session_user_expiry_activity_idx; DROP INDEX session_activity_expiry_idx; ALTER TABLE session DROP COLUMN refreshedAt;",
      );
      expect(
        sqlite.prepare("SELECT token,updatedAt FROM session WHERE id='legacy-session'").get(),
      ).toEqual({ token: "legacy-session", updatedAt: "2026-09-30T11:00:00.001Z" });
      sqlite.exec("DROP INDEX execution_user_created_idx");
      expect(
        sqlite.prepare("SELECT context FROM workflowExecution WHERE executionId='run'").get(),
      ).toEqual({ context: '{"private":"preserved"}' });
    } finally {
      sqlite.close();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
