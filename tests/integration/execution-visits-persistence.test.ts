/**
 * The route log persists with the execution row: saved and read back through the database
 * repository, appended atomically with a variable adjustment, and defaulted for rows created
 * before routes were recorded.
 */

import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { ExecutionRepository, metadataRevision } from "@mcp-moira/shared";
import type { ExecutionVisit, WorkflowExecution } from "@mcp-moira/workflow-engine";
import path from "path";
import { randomUUID } from "node:crypto";
import * as schema from "../../packages/shared/src/database/schema.js";

const TEST_USER_ID = "test-user-visits-persistence";

function buildExecution(executionId: string, workflowId: string): WorkflowExecution {
  return {
    executionId,
    workflowId,
    userId: TEST_USER_ID,
    currentNodeId: "task",
    waitingForInputNodeId: "task",
    globalContext: {
      variables: { alpha: "old" },
      nodeStates: {},
      executionId,
      workflowId,
      userId: TEST_USER_ID,
    },
    status: "running",
    revision: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    visits: [
      { seq: 0, nodeId: "start", exitKey: "default", changes: { alpha: "old" } },
      { seq: 1, nodeId: "task", exitKey: null, changes: {}, waited: true },
    ],
  };
}

describe("execution route log persistence", () => {
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

  afterEach(() => {
    sqlite.close();
  });

  it("persists visit timestamps and the definition version the run started on", async () => {
    const executionId = randomUUID();
    const execution = buildExecution(executionId, workflowId);
    execution.workflowVersion = "4.2.0";
    execution.visits = [
      { seq: 0, nodeId: "start", exitKey: "default", changes: {}, enteredAt: 1_000, leftAt: 1_005 },
      { seq: 1, nodeId: "task", exitKey: null, changes: {}, waited: true, enteredAt: 1_010 },
    ];
    await repository.save(execution);
    const loaded = (await repository.get(executionId))!;
    expect(loaded.workflowVersion).toBe("4.2.0");
    expect(loaded.visits).toEqual(execution.visits);
    expect(await repository.listByWorkflowVersion(workflowId, "4.2.0")).toHaveLength(1);
    expect(await repository.listByWorkflowVersion(workflowId, "4.1.0")).toHaveLength(0);
    const unstamped = buildExecution(randomUUID(), workflowId);
    await repository.save(unstamped);
    expect((await repository.get(unstamped.executionId))!.workflowVersion).toBeNull();
    expect(await repository.summarizeByWorkflowVersion(workflowId, "4.2.0")).toEqual({
      count: 1,
      lastUpdatedAt: expect.any(Number),
      unstamped: 1,
    });
  });

  it("round-trips the log through save and get, and grows it on the next save", async () => {
    const executionId = randomUUID();
    const execution = buildExecution(executionId, workflowId);
    await repository.save(execution);

    const loaded = (await repository.get(executionId))!;
    expect(loaded.visits).toEqual(execution.visits);

    loaded.visits![1].exitKey = "success";
    loaded.visits!.push({ seq: 2, nodeId: "end", exitKey: null, changes: {} });
    await repository.save(loaded);
    const again = (await repository.get(executionId))!;
    expect(again.revision).toBe(1);
    expect(again.visits!.map((visit) => `${visit.nodeId}:${visit.exitKey}`)).toEqual([
      "start:default",
      "task:success",
      "end:null",
    ]);
  });

  it("appends an adjustment visit in the same guarded write as the variable it changed", async () => {
    const executionId = randomUUID();
    await repository.save(buildExecution(executionId, workflowId));
    const before = (await repository.get(executionId))!;
    const visit: Omit<ExecutionVisit, "seq"> = {
      nodeId: "task",
      exitKey: null,
      changes: { alpha: "new" },
      adjusted: true,
      actor: { role: "user", userId: TEST_USER_ID },
    };
    await repository.updateContext(
      executionId,
      { variables: { alpha: "new" } },
      0,
      metadataRevision(before.globalContext),
      visit,
    );

    const after = (await repository.get(executionId))!;
    expect(after.globalContext.variables.alpha).toBe("new");
    expect(after.visits).toEqual([...before.visits!, { seq: 2, ...visit }]);
    expect(after.revision).toBe(0);
  });

  it("a stale context revision appends nothing", async () => {
    const executionId = randomUUID();
    await repository.save(buildExecution(executionId, workflowId));
    await expect(
      repository.updateContext(executionId, { variables: { alpha: "new" } }, 0, "stale", {
        nodeId: "task",
        exitKey: null,
        changes: { alpha: "new" },
        adjusted: true,
        actor: { role: "user", userId: TEST_USER_ID },
      }),
    ).rejects.toThrow(/stale|changed/i);
    expect((await repository.get(executionId))!.visits).toHaveLength(2);
  });

  it("a row written before routes were recorded reads back with an empty log", async () => {
    const executionId = randomUUID();
    const legacy = buildExecution(executionId, workflowId);
    delete legacy.visits;
    await repository.save(legacy);
    sqlite
      .prepare("UPDATE workflowExecution SET visits = '[]' WHERE executionId = ?")
      .run(executionId);
    expect((await repository.get(executionId))!.visits).toEqual([]);
    sqlite
      .prepare("UPDATE workflowExecution SET visits = 'not json' WHERE executionId = ?")
      .run(executionId);
    expect((await repository.get(executionId))!.visits).toEqual([]);
  });
});
