import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";
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
        ["failed-legacy", "failed", false],
        ["done", "completed", false],
        ["locked", "locked", true],
      ],
    );
  });

  it("counts and pages the locked-or-stopped union before scalar enrichment", async () => {
    for (let index = 0; index < 8; index++) execution(`selected-${index}`, index + 1);
    lock("selected-1");
    lock("selected-5");
    sqlite
      .prepare("UPDATE workflowExecution SET stopReason=? WHERE executionId=?")
      .run("Stopped", "selected-2");
    sqlite
      .prepare("UPDATE workflowExecution SET state='completed', stopReason='' WHERE executionId=?")
      .run("selected-6");
    const filter = {
      userId: "owner",
      status: ["running" as const],
      locked: true,
      includeStopped: true,
    };
    const page = await repository.listSummaries({ ...filter, limit: 2, offset: 1 });
    expect(page.total).toBe(4);
    expect(page.executions.map((row) => [row.executionId, row.displayStatus])).toEqual([
      ["selected-5", "locked"],
      ["selected-2", "stopped"],
    ]);
    const emptyPage = await repository.listSummaries({ ...filter, limit: 2, offset: 4 });
    expect(emptyPage).toEqual({ total: 4, executions: [] });
    const lockedOnly = await repository.listSummaries({ ...filter, includeStopped: false });
    expect(lockedOnly.total).toBe(2);
    expect(lockedOnly.executions.map((row) => row.executionId)).toEqual([
      "selected-5",
      "selected-1",
    ]);
    const stoppedOnly = await repository.listSummaries({ userId: "owner", includeStopped: true });
    expect(stoppedOnly.total).toBe(2);
    expect(stoppedOnly.executions.map((row) => row.executionId)).toEqual([
      "selected-6",
      "selected-2",
    ]);
  });

  it("projects actual owner, foreign, executing and unavailable capability with scalar task identity", async () => {
    for (const [index, id] of [
      "owner-run",
      "foreign",
      "busy",
      "unknown",
      "done",
      "waiting",
      "failed",
    ].entries())
      execution(
        id,
        index + 1,
        id === "done"
          ? "completed"
          : id === "waiting"
            ? "waiting"
            : id === "failed"
              ? "failed"
              : "running",
        id === "foreign" ? "someone-else" : "owner",
      );
    sqlite.prepare("UPDATE workflowExecution SET revision=7").run();
    // The stored column is NOT NULL; an unusable legacy generation must still publish null capability.
    sqlite.prepare("UPDATE workflowExecution SET revision=-1 WHERE executionId='unknown'").run();
    const identity = { title: "Explicit task", changedAt: 123, changeId: "identity-change" };
    sqlite
      .prepare("UPDATE workflowExecution SET taskIdentity=?, note=? WHERE executionId='owner-run'")
      .run(JSON.stringify(identity), "Independent note");
    db.insert(schema.executionMutationAttempt)
      .values({
        attemptId: "busy-attempt",
        operation: "step",
        userId: "owner",
        executionId: "busy",
        workflowId: "flow",
        workflowVersion: "1.0.0",
        workflowDigest: "digest",
        state: "executing",
        createdAt: new Date(1),
        updatedAt: new Date(1),
      })
      .run();
    const result = await repository.listSummaries({ actorId: "owner" });
    const rows = Object.fromEntries(result.executions.map((row) => [row.executionId, row]));
    expect(rows["owner-run"]).toMatchObject({
      taskIdentity: identity,
      note: "Independent note",
      revision: 7,
      stopCapability: { available: true, revision: 7 },
    });
    expect(rows.foreign.stopCapability).toEqual({
      available: false,
      revision: 7,
      reason: "not-owner",
    });
    expect(rows.busy.stopCapability).toEqual({
      available: false,
      revision: 7,
      reason: "in-flight",
    });
    expect(rows.unknown.stopCapability).toEqual({
      available: false,
      revision: null,
      reason: "unavailable",
    });
    expect(rows.unknown.revision).toBeNull();
    expect(rows.done.stopCapability).toEqual({ available: false, revision: 7, reason: "terminal" });
    expect(rows.waiting).toMatchObject({
      status: "waiting",
      displayStatus: "waiting-agent",
      stopCapability: { available: true, revision: 7 },
    });
    expect(rows.failed).toMatchObject({
      status: "failed",
      displayStatus: "completed",
      stopCapability: { available: false, revision: 7, reason: "terminal" },
    });
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
    sqlite
      .prepare("UPDATE workflowExecution SET errors=? WHERE executionId='mine'")
      .run(
        JSON.stringify([
          { errorType: "degradation", input: "hidden-journal-" + "x".repeat(1_000_000) },
        ]),
      );
    const prepare = sqlite.prepare.bind(sqlite);
    const transferred: unknown[][] = [];
    const observer = jest.spyOn(sqlite, "prepare").mockImplementation(((query: string) => {
      const statement = prepare(query);
      const proxy = new Proxy(statement, {
        get(target, key) {
          const member = Reflect.get(target, key);
          if (key === "raw")
            return (...args: unknown[]) => {
              member.apply(target, args);
              return proxy;
            };
          if (key === "all")
            return (...args: unknown[]) => {
              const rows = member.apply(target, args) as unknown[];
              transferred.push(rows);
              return rows;
            };
          return typeof member === "function" ? member.bind(target) : member;
        },
      });
      return proxy;
    }) as typeof sqlite.prepare);
    let after: typeof before;
    try {
      after = await repository.listSummaries({ userId: "owner" });
    } finally {
      observer.mockRestore();
    }
    expect(after).toEqual(before);
    expect(after.total).toBe(1);
    expect(after.executions.map((row) => row.executionId)).toEqual(["mine"]);
    expect(JSON.stringify(after).length).toBeLessThan(1000);
    expect(transferred.length).toBeGreaterThan(0);
    expect(transferred.every((rows) => rows.length <= 1)).toBe(true);
    const nativeBytes = JSON.stringify(transferred);
    expect(nativeBytes.length).toBeLessThan(5000);
    for (const hidden of [
      "context deliberately",
      "graph deliberately",
      "malformed visits",
      "malformed reminders",
      "hidden-journal-",
    ])
      expect(nativeBytes).not.toContain(hidden);
  });
});
