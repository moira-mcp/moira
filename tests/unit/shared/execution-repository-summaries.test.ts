import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { ExecutionAttemptRepository, ExecutionRepository } from "@mcp-moira/shared";
import * as schema from "../../../packages/shared/src/database/schema.js";
import path from "node:path";
import { sql } from "drizzle-orm";
import {
  refusalCount,
  latestRefusalAt,
} from "../../../packages/shared/src/database/execution-summary-sql.js";

describe("Execution management summaries", () => {
  let sqlite: Database.Database;
  let db: BetterSQLite3Database<typeof schema>;
  let repository: ExecutionRepository;

  beforeEach(() => {
    sqlite = new Database(":memory:");
    sqlite.pragma("foreign_keys = OFF");
    db = drizzle(sqlite, { schema });
    migrate(db, { migrationsFolder: path.join(process.cwd(), "packages/web-backend/drizzle") });
    repository = new ExecutionRepository(db);
    db.insert(schema.user)
      .values({
        id: "owner",
        email: "owner@example.test",
        name: "Owner",
        handle: "owner",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      })
      .run();
    db.insert(schema.workflow)
      .values({
        id: "flow",
        userId: "owner",
        slug: "flow",
        name: "A workflow",
        version: "1.0.0",
        graph: "graph deliberately not JSON",
        createdAt: new Date(1),
        updatedAt: new Date(1),
      })
      .run();
  });

  afterEach(() => {
    sqlite.close();
  });

  function execution(id: string, createdAt: number, state = "running", userId = "owner") {
    db.insert(schema.workflowExecution)
      .values({
        executionId: id,
        workflowId: "flow",
        userId,
        state,
        currentNodeId: "task",
        context: "context deliberately not JSON",
        createdAt: new Date(createdAt),
        updatedAt: new Date(createdAt),
      })
      .run();
  }

  function lock(id: string, status = "active") {
    db.insert(schema.executionLock)
      .values({
        id: `lock-${id}-${status}`,
        executionId: id,
        nodeId: "task",
        reason: "Review",
        lockedBy: "owner",
        pin: "hashed",
        status,
        createdAt: new Date(10),
      })
      .run();
  }

  it("filters locks before counting and paginating interleaved rows", async () => {
    for (let index = 0; index < 10; index++) {
      execution(`run-${index}`, index + 1);
      if (index % 2 === 0) lock(`run-${index}`);
    }
    lock("run-9", "unlocked");
    lock("run-7", "pending_delivery");
    const page = await repository.listSummaries({
      status: ["running"],
      locked: true,
      limit: 2,
      offset: 2,
    });
    expect(page.total).toBe(5);
    expect(page.executions.map((row) => row.executionId)).toEqual(["run-4", "run-2"]);
    expect(page.executions.map((row) => row.status)).toEqual(["locked", "locked"]);
    expect(
      (await repository.listSummaries({ status: ["running"], locked: true, offset: 5 })).total,
    ).toBe(5);
  });

  it("keeps ordinary running rows in running+locked inventory and completed rows in locked+completed", async () => {
    execution("locked", 1);
    lock("locked");
    execution("running", 2);
    execution("done", 3, "completed");
    lock("done");
    execution("failed-legacy", 4, "failed");
    const running = await repository.listSummaries({ status: ["running"] });
    expect(running.total).toBe(2);
    expect(running.executions.map((row) => row.status)).toEqual(["running", "locked"]);
    const mixed = await repository.listSummaries({
      status: ["running", "completed"],
      locked: true,
    });
    expect(mixed.total).toBe(3);
    expect(mixed.executions.map((row) => [row.executionId, row.status, row.hasActiveLock])).toEqual(
      [
        ["failed-legacy", "completed", false],
        ["done", "completed", false],
        ["locked", "locked", true],
      ],
    );
  });

  it("reports only authentic step audit time despite newer record edits", async () => {
    execution("stepped", 1);
    execution("unknown", 2);
    const insertAudit = (id: string, action: string, resource: string, createdAt: number) =>
      db
        .insert(schema.auditLog)
        .values({
          id,
          userId: "owner",
          action,
          resource,
          resourceId: "stepped",
          createdAt: new Date(createdAt),
        })
        .run();
    insertAudit("step-old", "execution:step", "execution", 20);
    insertAudit("step-new", "execution:step", "execution", 30);
    insertAudit("edit", "execution:update-context", "execution", 40);
    insertAudit("unrelated", "execution:step", "workflow", 50);
    await repository.updateNote("stepped", "Edited after stepping");
    const result = await repository.listSummaries({ sort: "createdAt", sortOrder: "asc" });
    expect(result.executions.map((row) => [row.executionId, row.lastStepAt])).toEqual([
      ["stepped", 30],
      ["unknown", null],
    ]);
    expect(result.executions[0]).toMatchObject({
      workflowName: "A workflow",
      userName: "Owner",
      userEmail: "owner@example.test",
      note: "Edited after stepping",
    });
  });

  it("projects the actual stop reason without hydrating working data or inventing a refusal", async () => {
    execution("stopped", 1);
    execution("ordinary-completion", 2, "completed");
    new ExecutionAttemptRepository(sqlite).stopExecution(
      "stopped",
      "owner",
      0,
      "Task deliberately abandoned",
    );
    const page = await repository.listSummaries({ status: ["completed"], sortOrder: "asc" });
    expect(page.total).toBe(2);
    expect(page.executions).toEqual([
      expect.objectContaining({
        executionId: "stopped",
        status: "completed",
        stopReason: "Task deliberately abandoned",
        errorCount: 0,
      }),
      expect.objectContaining({
        executionId: "ordinary-completion",
        stopReason: null,
      }),
    ]);
    expect(JSON.stringify(page)).not.toContain("context deliberately");
  });

  it("keeps missing summary timestamps unknown and preserves a genuine Unix epoch observation", async () => {
    execution("missing-both", 1);
    execution("missing-created", 2);
    execution("missing-updated", 3);
    execution("epoch", 0);
    sqlite
      .prepare(
        "UPDATE workflowExecution SET createdAt=NULL, updatedAt=NULL WHERE executionId='missing-both'",
      )
      .run();
    sqlite
      .prepare("UPDATE workflowExecution SET createdAt=NULL WHERE executionId='missing-created'")
      .run();
    sqlite
      .prepare("UPDATE workflowExecution SET updatedAt=NULL WHERE executionId='missing-updated'")
      .run();
    const result = await repository.listSummaries({});
    const observed = Object.fromEntries(
      result.executions.map((row) => [
        row.executionId,
        { createdAt: row.createdAt, updatedAt: row.updatedAt },
      ]),
    );
    expect(observed).toEqual({
      "missing-both": { createdAt: null, updatedAt: null },
      "missing-created": { createdAt: null, updatedAt: 2 },
      "missing-updated": { createdAt: 3, updatedAt: null },
      epoch: { createdAt: 0, updatedAt: 0 },
    });
  });

  it.each([
    [null, 0],
    ["invalid json", 0],
    ["{}", 0],
    ['[{"errorType":"degradation"}]', 0],
    [
      '[{"errorType":"degradation"},{"errorType":"validation","input":{"secret":"hidden"}},{"message":"legacy"}]',
      2,
    ],
  ])("counts refusals defensively for journal %s", async (errors, count) => {
    execution("run", 1);
    sqlite
      .prepare("UPDATE workflowExecution SET errors = ? WHERE executionId = ?")
      .run(errors, "run");
    const result = await repository.listSummaries({});
    expect(result.executions[0].errorCount).toBe(count);
    expect(JSON.stringify(result.executions)).not.toContain("hidden");
  });

  it.each([
    ["invalid json", 0, null],
    ["{}", 0, null],
    ["null", 0, null],
    ['["legacy scalar",23,null]', 3, null],
    ['[{"errorType":"degradation","timestamp":100}]', 0, null],
    [
      '[{"timestamp":20},{"errorType":"validation","timestamp":10},{"errorType":"degradation","timestamp":100}]',
      2,
      20,
    ],
    ['[{"timestamp":"not a timestamp"},{"timestamp":{"malformed":true}}]', 2, null],
  ])("shares safe count and timestamp semantics for journal %s", (journal, count, lastAt) => {
    const result = db.get<{ count: number; lastAt: number | null }>(
      sql`SELECT ${refusalCount(sql`${journal}`)} AS count, ${latestRefusalAt(sql`${journal}`)} AS lastAt`,
    );
    expect(result).toEqual({ count, lastAt });
  });

  it("keeps the projection bounded and independent of large hidden working data", async () => {
    execution("mine", 1);
    execution("other", 2, "running", "someone-else");
    const before = await repository.listSummaries({ userId: "owner" });
    sqlite
      .prepare(
        "UPDATE workflowExecution SET context = ?, visits = ?, reminders = ? WHERE executionId = ?",
      )
      .run(
        JSON.stringify({ payload: "x".repeat(1_000_000) }),
        "malformed visits",
        "malformed reminders",
        "mine",
      );
    const after = await repository.listSummaries({ userId: "owner" });
    expect(after).toEqual(before);
    expect(after.total).toBe(1);
    expect(after.executions.map((row) => row.executionId)).toEqual(["mine"]);
    expect(JSON.stringify(after).length).toBeLessThan(1000);
  });
});
