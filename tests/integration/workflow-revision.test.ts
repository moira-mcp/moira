/**
 * The workflow definition revision: migration 0026 gives existing rows revision 0; the shared
 * repository's save advances it on every update of the stored graph and leaves it alone on
 * writes that do not touch the graph (visibility). The reconciliation writer is covered in
 * `workflow-catalog-loader.test.ts`.
 */

import { describe, test, expect, beforeEach, afterEach } from "@jest/globals";
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import fs from "fs";
import os from "os";
import path from "path";
import { WorkflowRepository } from "@mcp-moira/shared";
import type { WorkflowGraph } from "@mcp-moira/workflow-engine";
import * as schema from "../../packages/shared/src/database/schema.js";

const MIGRATIONS = path.resolve(process.cwd(), "packages/web-backend/drizzle");
const OWNER = "revision-owner";

function graph(name: string, directive = "Do the work"): WorkflowGraph {
  return {
    metadata: { name, version: "1.0.0", description: "fixture" },
    nodes: [
      { id: "start", type: "start", connections: { default: "step" } },
      {
        id: "step",
        type: "agent-directive",
        directive,
        completionCondition: "Done",
        connections: { success: "end" },
      },
      { id: "end", type: "end" },
    ],
  } as WorkflowGraph;
}

describe("workflow definition revision", () => {
  let sqlite: Database.Database;
  let db: BetterSQLite3Database<typeof schema>;
  let repo: WorkflowRepository;

  beforeEach(() => {
    sqlite = new Database(":memory:");
    db = drizzle(sqlite, { schema });
    sqlite.exec("PRAGMA foreign_keys = OFF");
    migrate(db, { migrationsFolder: MIGRATIONS });
    repo = new WorkflowRepository(db);
  });

  afterEach(() => {
    sqlite.close();
  });

  test("migration 0026 adds the column and existing rows start at revision 0", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "moira-workflow-revision-"));
    const file = new Database(path.join(directory, "moira.db"));
    try {
      file.exec("PRAGMA foreign_keys = OFF");
      migrate(drizzle(file), { migrationsFolder: MIGRATIONS });
      const journal = JSON.parse(
        fs.readFileSync(path.join(MIGRATIONS, "meta/_journal.json"), "utf8"),
      ) as { entries: Array<{ tag: string; when: number }> };
      const revisionMigration = journal.entries.find(
        (entry) => entry.tag === "0026_workflow_revision",
      )!;
      file.exec("ALTER TABLE workflow DROP COLUMN revision");
      file
        .prepare("DELETE FROM __drizzle_migrations WHERE created_at >= ?")
        .run(revisionMigration.when);
      const now = Date.now();
      file
        .prepare(
          `INSERT INTO workflow (id, userId, slug, name, version, graph, visibility, createdAt, updatedAt)
           VALUES ('w-before', 'u', 'w-before', 'Before', '1.0.0', '{}', 'private', ?, ?)`,
        )
        .run(now, now);

      migrate(drizzle(file), { migrationsFolder: MIGRATIONS });

      expect(file.prepare("SELECT revision FROM workflow WHERE id = 'w-before'").get()).toEqual({
        revision: 0,
      });
    } finally {
      file.close();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  test("repository save starts at 0, advances on every graph update, and not on a visibility write", async () => {
    const { id } = await repo.save({ graph: graph("Revisioned"), userId: OWNER });
    expect((await repo.getFullInfo(id, OWNER))?.revision).toBe(0);

    const stored = await repo.get(id, OWNER);
    await repo.save({ graph: { ...stored!, ...graph("Revisioned", "Step two") }, userId: OWNER });
    await repo.save({ graph: { ...stored!, ...graph("Revisioned", "Step three") }, userId: OWNER });
    expect((await repo.getFullInfo(id, OWNER))?.revision).toBe(2);

    await repo.updateVisibility(id, OWNER, "public");
    expect((await repo.getFullInfo(id, OWNER))?.revision).toBe(2);
    expect((await repo.list(OWNER)).find((w) => w.id === id)?.revision).toBe(2);
  });
});
