/**
 * Integration tests for per-key execution context update (ExecutionService.updateContext).
 *
 * Verifies the merge-by-key contract used by the web ExecutionInspector:
 * - sending a single changed variable updates only that variable
 * - other variables are preserved from the database, even when the caller's
 *   payload omits them (stale-view safety)
 * - the audit entry records exactly which variable keys changed (old -> new)
 */

import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { ExecutionRepository, AuditRepository, ExecutionService } from "@mcp-moira/shared";
import type { WorkflowExecution } from "@mcp-moira/workflow-engine";
import path from "path";
import { v4 as uuidv4 } from "uuid";

import * as schema from "../../packages/shared/src/database/schema.js";

const TEST_USER_ID = "test-user-per-key-ctx";

function buildExecution(
  executionId: string,
  workflowId: string,
  variables: Record<string, unknown>,
  nodeStates: Record<string, unknown> = {},
): WorkflowExecution {
  return {
    executionId,
    workflowId,
    userId: TEST_USER_ID,
    currentNodeId: "task",
    waitingForInputNodeId: "task",
    globalContext: {
      variables,
      nodeStates,
      executionId,
      workflowId,
      userId: TEST_USER_ID,
    },
    status: "running",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

describe("ExecutionService.updateContext (per-key merge)", () => {
  let db: BetterSQLite3Database<typeof schema>;
  let sqlite: Database.Database;
  let executionRepo: ExecutionRepository;
  let auditRepo: AuditRepository;
  let service: ExecutionService;
  let workflowId: string;

  beforeEach(() => {
    sqlite = new Database(":memory:");
    db = drizzle(sqlite, { schema });
    sqlite.exec("PRAGMA foreign_keys = OFF");

    const migrationsPath = path.join(process.cwd(), "packages/web-backend/drizzle");
    migrate(db, { migrationsFolder: migrationsPath });

    executionRepo = new ExecutionRepository(db);
    auditRepo = new AuditRepository(db);
    service = new ExecutionService(executionRepo, auditRepo);

    workflowId = `wf-${uuidv4()}`;
  });

  afterEach(() => {
    sqlite.close();
  });

  it("updates only the provided variable key and preserves all other variables", async () => {
    const executionId = uuidv4();
    await executionRepo.save(
      buildExecution(executionId, workflowId, {
        alpha: "a-original",
        beta: "b-original",
        counter: 1,
      }),
    );

    const ok = await service.updateContext(executionId, TEST_USER_ID, {
      variables: { alpha: "a-updated" },
    });
    expect(ok).toBe(true);

    const after = await executionRepo.get(executionId);
    expect(after).not.toBeNull();
    expect(after!.globalContext.variables.alpha).toBe("a-updated");
    // Untouched keys preserved
    expect(after!.globalContext.variables.beta).toBe("b-original");
    expect(after!.globalContext.variables.counter).toBe(1);
  });

  it("does not clobber a variable that changed on the server when the caller omits it (stale-view safety)", async () => {
    const executionId = uuidv4();
    await executionRepo.save(
      buildExecution(executionId, workflowId, {
        editable: "old",
        serverManaged: "v1",
      }),
    );

    // Simulate the server advancing the execution and changing `serverManaged`
    // AFTER the client loaded its (now stale) snapshot.
    await executionRepo.updateContext(executionId, { variables: { serverManaged: "v2" } });

    // Client saves ONLY the key it edited, working from its stale snapshot.
    const ok = await service.updateContext(executionId, TEST_USER_ID, {
      variables: { editable: "new" },
    });
    expect(ok).toBe(true);

    const after = await executionRepo.get(executionId);
    expect(after!.globalContext.variables.editable).toBe("new");
    // The server-side change must survive — not be overwritten back to v1.
    expect(after!.globalContext.variables.serverManaged).toBe("v2");
  });

  it("can add a brand-new variable key without touching existing ones", async () => {
    const executionId = uuidv4();
    await executionRepo.save(buildExecution(executionId, workflowId, { existing: "keep" }));

    await service.updateContext(executionId, TEST_USER_ID, {
      variables: { freshKey: { nested: true } },
    });

    const after = await executionRepo.get(executionId);
    expect(after!.globalContext.variables.existing).toBe("keep");
    expect(after!.globalContext.variables.freshKey).toEqual({ nested: true });
  });

  it("records the changed variable keys in the audit entry", async () => {
    const executionId = uuidv4();
    await executionRepo.save(
      buildExecution(executionId, workflowId, { tracked: "before", other: "untouched" }),
    );

    await service.updateContext(executionId, TEST_USER_ID, {
      variables: { tracked: "after" },
    });

    const auditEntries = await auditRepo.list({ userId: TEST_USER_ID });
    const ctxEntry = auditEntries.find((e) => e.resourceId === executionId);
    expect(ctxEntry).toBeDefined();

    const metadata = JSON.parse(ctxEntry!.metadata ?? "{}");
    expect(metadata.changedVariableKeys).toEqual(["tracked"]);

    expect(ctxEntry!.changes).toBeDefined();
    const changes = JSON.parse(ctxEntry!.changes ?? "[]");
    expect(changes).toEqual([{ field: "tracked", oldValue: "before", newValue: "after" }]);
  });

  it("returns false for a non-existent execution and writes no audit entry", async () => {
    const ok = await service.updateContext(uuidv4(), TEST_USER_ID, {
      variables: { x: 1 },
    });
    expect(ok).toBe(false);

    const auditEntries = await auditRepo.list({ userId: TEST_USER_ID });
    expect(auditEntries.length).toBe(0);
  });

  it("tolerates a row with a malformed context column when listing (no crash)", async () => {
    // A single corrupt context row must not crash listing of all executions
    // (e.g. analytics endpoints that map over every execution).
    const goodId = uuidv4();
    await executionRepo.save(buildExecution(goodId, workflowId, { ok: true }));

    const badId = uuidv4();
    sqlite
      .prepare(
        `INSERT INTO workflowExecution
          (executionId, workflowId, userId, state, currentNodeId, context, createdAt, updatedAt)
         VALUES (?, ?, ?, 'running', 'task', ?, ?, ?)`,
      )
      .run(badId, workflowId, TEST_USER_ID, "172.217.23.238", Date.now(), Date.now());

    const all = await executionRepo.listByUser(TEST_USER_ID);
    const ids = all.map((e) => e.executionId);
    expect(ids).toContain(goodId);
    expect(ids).toContain(badId);

    // Corrupt row falls back to an empty-but-valid context instead of throwing.
    const bad = all.find((e) => e.executionId === badId);
    expect(bad!.globalContext.variables).toEqual({});
    expect(bad!.globalContext.nodeStates).toEqual({});
  });

  describe("per-path update (updateContextPath)", () => {
    it("sets a nested value without overwriting siblings or other variables", async () => {
      const executionId = uuidv4();
      await executionRepo.save(
        buildExecution(executionId, workflowId, {
          review: { blocking: 0, remarks: 2 },
          other: "keep",
        }),
      );

      const ok = await service.updateContextPath(
        executionId,
        TEST_USER_ID,
        ["review", "blocking"],
        5,
      );
      expect(ok).toBe(true);

      const after = await executionRepo.get(executionId);
      expect(after!.globalContext.variables.review).toEqual({ blocking: 5, remarks: 2 });
      expect(after!.globalContext.variables.other).toBe("keep");
    });

    it("updates a value inside an array by index", async () => {
      const executionId = uuidv4();
      await executionRepo.save(buildExecution(executionId, workflowId, { items: ["a", "b", "c"] }));

      const ok = await service.updateContextPath(executionId, TEST_USER_ID, ["items", 1], "B");
      expect(ok).toBe(true);

      const after = await executionRepo.get(executionId);
      expect(after!.globalContext.variables.items).toEqual(["a", "B", "c"]);
    });

    it("creates missing intermediate containers along the path", async () => {
      const executionId = uuidv4();
      await executionRepo.save(buildExecution(executionId, workflowId, {}));

      const ok = await service.updateContextPath(
        executionId,
        TEST_USER_ID,
        ["config", "nested", "flag"],
        true,
      );
      expect(ok).toBe(true);

      const after = await executionRepo.get(executionId);
      expect(after!.globalContext.variables.config).toEqual({ nested: { flag: true } });
    });

    it("records an audit entry with the dotted path and old/new value", async () => {
      const executionId = uuidv4();
      await executionRepo.save(
        buildExecution(executionId, workflowId, { review: { blocking: 0 } }),
      );

      await service.updateContextPath(executionId, TEST_USER_ID, ["review", "blocking"], 9);

      const auditEntries = await auditRepo.list({ userId: TEST_USER_ID });
      const entry = auditEntries.find((e) => e.resourceId === executionId);
      expect(entry).toBeDefined();
      const changes = JSON.parse(entry!.changes ?? "[]");
      expect(changes).toEqual([{ field: "review.blocking", oldValue: 0, newValue: 9 }]);
    });

    it("returns false for a non-existent execution", async () => {
      const ok = await service.updateContextPath(uuidv4(), TEST_USER_ID, ["x"], 1);
      expect(ok).toBe(false);
    });

    it("rejects prototype-pollution path segments and leaves Object.prototype untouched", async () => {
      const executionId = uuidv4();
      await executionRepo.save(buildExecution(executionId, workflowId, { safe: 1 }));

      for (const bad of ["__proto__", "constructor", "prototype"]) {
        const ok = await service.updateContextPath(
          executionId,
          TEST_USER_ID,
          [bad, "polluted"],
          "x",
        );
        expect(ok).toBe(false);
      }

      // Object.prototype must not have been poisoned.
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();

      // The execution's variables are unchanged.
      const after = await executionRepo.get(executionId);
      expect(after!.globalContext.variables).toEqual({ safe: 1 });
    });
  });
});
