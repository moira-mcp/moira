/**
 * Integration tests for the internal revisioned execution-context persistence primitive.
 *
 * Public context mutation is policy-governed by the runtime variable service. These tests cover
 * only the repository primitive used by the engine after its caller has made that decision.
 */

import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { ConflictError, ExecutionRepository, metadataRevision } from "@mcp-moira/shared";
import type { WorkflowExecution } from "@mcp-moira/workflow-engine";
import path from "path";
import { randomUUID } from "node:crypto";
import * as schema from "../../packages/shared/src/database/schema.js";

const TEST_USER_ID = "test-user-context-persistence";

function buildExecution(
  executionId: string,
  workflowId: string,
  variables: Record<string, unknown>,
): WorkflowExecution {
  return {
    executionId,
    workflowId,
    userId: TEST_USER_ID,
    currentNodeId: "task",
    waitingForInputNodeId: "task",
    globalContext: {
      variables,
      nodeStates: {},
      executionId,
      workflowId,
      userId: TEST_USER_ID,
    },
    status: "running",
    revision: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

describe("ExecutionRepository revisioned context persistence", () => {
  let db: BetterSQLite3Database<typeof schema>;
  let sqlite: Database.Database;
  let repository: ExecutionRepository;
  let workflowId: string;

  beforeEach(() => {
    sqlite = new Database(":memory:");
    db = drizzle(sqlite, { schema });
    sqlite.exec("PRAGMA foreign_keys = OFF");
    migrate(db, { migrationsFolder: path.join(process.cwd(), "packages/web-backend/drizzle") });
    repository = new ExecutionRepository(db);
    workflowId = `wf-${randomUUID()}`;
  });

  afterEach(() => sqlite.close());

  it("merges selected variable keys and preserves unmentioned keys", async () => {
    const executionId = randomUUID();
    await repository.save(buildExecution(executionId, workflowId, { alpha: "old", beta: "keep" }));

    const before = await repository.get(executionId);
    await repository.updateContext(
      executionId,
      { variables: { alpha: "new" } },
      0,
      metadataRevision(before!.globalContext),
    );

    const after = await repository.get(executionId);
    expect(after!.globalContext.variables).toEqual({ alpha: "new", beta: "keep" });
    expect(after!.revision).toBe(0);
  });

  it("rejects a stale context snapshot within one step generation", async () => {
    const executionId = randomUUID();
    await repository.save(
      buildExecution(executionId, workflowId, { editable: "old", serverManaged: "v1" }),
    );
    const before = await repository.get(executionId);
    const staleContextRevision = metadataRevision(before!.globalContext);
    await repository.updateContext(
      executionId,
      { variables: { serverManaged: "v2" } },
      0,
      staleContextRevision,
    );

    await expect(
      repository.updateContext(
        executionId,
        { variables: { editable: "new" } },
        0,
        staleContextRevision,
      ),
    ).rejects.toBeInstanceOf(ConflictError);
    const after = await repository.get(executionId);
    expect(after!.globalContext.variables).toEqual({ editable: "old", serverManaged: "v2" });
    expect(after!.revision).toBe(0);
  });

  it("rejects one simultaneous context snapshot write without changing step revision", async () => {
    const executionId = randomUUID();
    await repository.save(buildExecution(executionId, workflowId, { alpha: 0, beta: 0 }));
    const before = await repository.get(executionId);
    const contextRevision = metadataRevision(before!.globalContext);

    const results = await Promise.allSettled([
      repository.updateContext(executionId, { variables: { alpha: 1 } }, 0, contextRevision),
      repository.updateContext(executionId, { variables: { beta: 1 } }, 0, contextRevision),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected).toMatchObject({ status: "rejected", reason: expect.any(ConflictError) });
    expect((await repository.get(executionId))?.revision).toBe(0);
  });

  it("tolerates one malformed stored context while listing executions", async () => {
    const goodId = randomUUID();
    await repository.save(buildExecution(goodId, workflowId, { ok: true }));
    const badId = randomUUID();
    sqlite
      .prepare(
        `INSERT INTO workflowExecution
          (executionId, workflowId, userId, state, currentNodeId, context, createdAt, updatedAt)
         VALUES (?, ?, ?, 'running', 'task', ?, ?, ?)`,
      )
      .run(badId, workflowId, TEST_USER_ID, "malformed", Date.now(), Date.now());

    const all = await repository.listByUser(TEST_USER_ID);
    expect(all.map((execution) => execution.executionId)).toEqual(
      expect.arrayContaining([goodId, badId]),
    );
    const bad = all.find((execution) => execution.executionId === badId);
    expect(bad!.globalContext.variables).toEqual({});
    expect(bad!.globalContext.nodeStates).toEqual({});
  });
});
