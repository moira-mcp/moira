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
import { migrationsBefore } from "../helpers/migrations-before.js";

const MIGRATIONS = path.resolve(process.cwd(), "packages/web-backend/drizzle");
const REVISION_TAG = "0026_workflow_revision";
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
      // A database as it was before this migration: the journal is cut just before it, so every
      // later migration — including ones added after it — stays unapplied and untouched here.
      migrate(drizzle(file), { migrationsFolder: migrationsBefore(directory, REVISION_TAG) });
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

  test("a save against a stale expected revision changes nothing and reports the current revision", async () => {
    const { id } = await repo.save({ graph: graph("Guarded"), userId: OWNER });
    const stored = await repo.get(id, OWNER);
    await repo.save({
      graph: { ...stored!, ...graph("Guarded", "First writer") },
      userId: OWNER,
      expectedRevision: 0,
    });

    await expect(
      repo.save({
        graph: { ...stored!, ...graph("Guarded", "Second writer") },
        userId: OWNER,
        expectedRevision: 0,
      }),
    ).rejects.toMatchObject({
      name: "WorkflowRevisionConflictError",
      expectedRevision: 0,
      currentRevision: 1,
    });

    const after = await repo.getFullInfo(id, OWNER);
    expect(after?.revision).toBe(1);
    expect(
      (after?.workflow.nodes.find((n) => n.id === "step") as { directive: string }).directive,
    ).toBe("First writer");
  });
});
