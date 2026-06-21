/**
 * Unit tests for ExecutionRetentionService + ExecutionRepository.deleteCompletedOlderThan.
 *
 * Verifies: disabled by default (0 days) → no-op; cleanup deletes only EXPIRED
 * COMPLETED executions; never deletes running/fresh ones; preserves a completed
 * parent that still has a running child.
 */

import { describe, it, expect, beforeEach, afterEach, jest } from "@jest/globals";
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { randomUUID } from "crypto";
import path from "path";

import { ExecutionRepository, ExecutionRetentionService } from "@mcp-moira/shared";
import type { GlobalSettingsService } from "@mcp-moira/shared";
import type { WorkflowExecution, LegacyExecutionStatus } from "@mcp-moira/shared";
import * as schema from "../../../packages/shared/src/database/schema.js";

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const USER = "ret-user";
const WF = "ret-wf";

describe("Execution retention", () => {
  let sqlite: Database.Database;
  let db: BetterSQLite3Database<typeof schema>;
  let repo: ExecutionRepository;

  beforeEach(() => {
    sqlite = new Database(":memory:");
    db = drizzle(sqlite, { schema });
    sqlite.exec("PRAGMA foreign_keys = OFF");
    migrate(db, { migrationsFolder: path.join(process.cwd(), "packages/web-backend/drizzle") });
    repo = new ExecutionRepository(db);
  });

  afterEach(() => sqlite.close());

  function makeExec(opts: {
    status: "running" | "completed";
    ageDays: number;
    parentExecutionId?: string;
  }): WorkflowExecution {
    const t = Date.now() - opts.ageDays * MS_PER_DAY;
    return {
      executionId: randomUUID(),
      workflowId: WF,
      userId: USER,
      currentNodeId: "start",
      globalContext: {
        variables: {},
        nodeStates: {},
        executionId: "",
        workflowId: WF,
        userId: USER,
      },
      status: opts.status as LegacyExecutionStatus,
      parentExecutionId: opts.parentExecutionId,
      createdAt: t,
      updatedAt: t,
      completedAt: opts.status === "completed" ? t : undefined,
    } as WorkflowExecution;
  }

  function settings(retentionDays: string | null): GlobalSettingsService {
    return {
      getValue: jest.fn<(key: string) => Promise<unknown>>().mockResolvedValue(retentionDays),
    } as unknown as GlobalSettingsService;
  }

  async function ids(): Promise<string[]> {
    const rows = await db
      .select({ id: schema.workflowExecution.executionId })
      .from(schema.workflowExecution);
    return rows.map((r) => r.id);
  }

  describe("deleteCompletedOlderThan", () => {
    it("deletes only completed executions older than the cutoff", async () => {
      const oldDone = makeExec({ status: "completed", ageDays: 40 });
      const freshDone = makeExec({ status: "completed", ageDays: 1 });
      const oldRunning = makeExec({ status: "running", ageDays: 40 });
      for (const e of [oldDone, freshDone, oldRunning]) await repo.save(e);

      const deleted = await repo.deleteCompletedOlderThan(new Date(Date.now() - 30 * MS_PER_DAY));

      expect(deleted).toBe(1);
      const remaining = await ids();
      expect(remaining).toContain(freshDone.executionId); // too fresh
      expect(remaining).toContain(oldRunning.executionId); // running, never deleted
      expect(remaining).not.toContain(oldDone.executionId); // deleted
    });

    it("preserves a completed parent that still has a running child", async () => {
      const parent = makeExec({ status: "completed", ageDays: 40 });
      await repo.save(parent);
      const child = makeExec({
        status: "running",
        ageDays: 40,
        parentExecutionId: parent.executionId,
      });
      await repo.save(child);

      const deleted = await repo.deleteCompletedOlderThan(new Date(Date.now() - 30 * MS_PER_DAY));

      expect(deleted).toBe(0);
      expect(await ids()).toContain(parent.executionId);
    });

    it("returns 0 when nothing is eligible", async () => {
      await repo.save(makeExec({ status: "running", ageDays: 100 }));
      const deleted = await repo.deleteCompletedOlderThan(new Date(Date.now() - 30 * MS_PER_DAY));
      expect(deleted).toBe(0);
    });
  });

  describe("ExecutionRetentionService", () => {
    it("is a no-op when retention_days is unset (keep forever)", async () => {
      await repo.save(makeExec({ status: "completed", ageDays: 999 }));
      const svc = new ExecutionRetentionService(repo, settings(null));
      expect(await svc.getRetentionDays()).toBe(0);
      expect(await svc.runOnce()).toBe(0);
      expect((await ids()).length).toBe(1);
    });

    it("is a no-op when retention_days is 0", async () => {
      await repo.save(makeExec({ status: "completed", ageDays: 999 }));
      const svc = new ExecutionRetentionService(repo, settings("0"));
      expect(await svc.runOnce()).toBe(0);
      expect((await ids()).length).toBe(1);
    });

    it("deletes completed executions older than retention_days", async () => {
      const old = makeExec({ status: "completed", ageDays: 40 });
      const fresh = makeExec({ status: "completed", ageDays: 5 });
      await repo.save(old);
      await repo.save(fresh);

      const svc = new ExecutionRetentionService(repo, settings("30"));
      const deleted = await svc.runOnce();

      expect(deleted).toBe(1);
      const remaining = await ids();
      expect(remaining).toContain(fresh.executionId);
      expect(remaining).not.toContain(old.executionId);
    });
  });
});
