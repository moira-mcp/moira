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
import { ConflictError, ExecutionRepository } from "@mcp-moira/shared";
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

    await repository.updateContext(executionId, { variables: { alpha: "new" } }, 0);

    const after = await repository.get(executionId);
    expect(after!.globalContext.variables).toEqual({ alpha: "new", beta: "keep" });
    expect(after!.revision).toBe(1);
  });

  it("rejects a stale write without restoring newer state", async () => {
    const executionId = randomUUID();
    await repository.save(
      buildExecution(executionId, workflowId, { editable: "old", serverManaged: "v1" }),
    );
    await repository.updateContext(executionId, { variables: { serverManaged: "v2" } }, 0);

    await expect(
      repository.updateContext(executionId, { variables: { editable: "new" } }, 0),
    ).rejects.toBeInstanceOf(ConflictError);
    const after = await repository.get(executionId);
    expect(after!.globalContext.variables).toEqual({ editable: "old", serverManaged: "v2" });
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
