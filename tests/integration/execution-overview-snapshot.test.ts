import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";
import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import {
  ExecutionNotificationRepository,
  ExecutionOverviewRepository,
  ExecutionRepository,
  WorkflowRepository,
  getDatabase,
  getSqliteInstance,
  user,
  workflow,
  workflowExecution,
  withReadSnapshot,
} from "@mcp-moira/shared";
import {
  overviewPage,
  overviewRows,
} from "../../packages/web-backend/src/services/execution-overview.js";
import type { OverviewDependencies } from "../../packages/web-backend/src/services/execution-overview.js";

describe("awaited overview reads share an independent WAL snapshot", () => {
  let owner: string;
  let workflowId: string;
  let executionId: string;
  let reader: Database.Database | undefined;

  beforeEach(async () => {
    owner = randomUUID();
    workflowId = randomUUID();
    executionId = randomUUID();
    reader = undefined;
    const now = new Date();
    const db = getDatabase();
    await db.insert(user).values({
      id: owner,
      handle: `snapshot-${owner.slice(0, 12)}`,
      email: `${owner}@example.test`,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    });
    await db.insert(workflow).values({
      id: workflowId,
      userId: owner,
      slug: "snapshot-heading",
      name: "Snapshot flow",
      version: "1.0.0",
      createdAt: now,
      updatedAt: now,
      graph: JSON.stringify({
        metadata: { name: "Snapshot flow", version: "1.0.0", schemaVersion: 1 },
        variableRegistry: {
          task_prompt: { type: "string" },
          default_heading: { type: "string", default: "A default" },
        },
        progress: {
          title: "{{task_prompt}} / {{default_heading}}",
          nodes: [{ id: "work", label: "Work", content: { summary: "Work" } }],
        },
        nodes: [
          { id: "start", type: "start", progressNodeId: "work", connections: { default: "work" } },
          {
            id: "work",
            type: "agent-directive",
            progressNodeId: "work",
            directive: "Work",
            completionCondition: "Done",
            connections: { success: "end" },
          },
          { id: "end", type: "end", progressNodeId: "work" },
        ],
      }),
    });
    await db.insert(workflowExecution).values({
      executionId,
      workflowId,
      userId: owner,
      state: "running",
      currentNodeId: "work",
      waitingForInputNodeId: "work",
      createdAt: now,
      updatedAt: now,
      lastActivityAt: now.getTime(),
      context: JSON.stringify({
        variables: { task_prompt: "A task" },
        nodeStates: {},
        executionId,
        workflowId,
        userId: owner,
      }),
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
    if (reader) expect(reader.open).toBe(false);
    getSqliteInstance().prepare("DELETE FROM user WHERE id=?").run(owner);
  });

  function snapshot<T>(read: (deps: OverviewDependencies) => Promise<T>) {
    return withReadSnapshot((db, sqlite) => {
      reader = sqlite;
      expect(sqlite).not.toBe(getSqliteInstance());
      expect(sqlite.readonly).toBe(true);
      expect(sqlite.inTransaction).toBe(true);
      expect(() =>
        sqlite.prepare("UPDATE user SET updatedAt=updatedAt WHERE id=?").run(owner),
      ).toThrow(/readonly/i);
      return read({
        overview: new ExecutionOverviewRepository(sqlite),
        executions: new ExecutionRepository(db),
        workflows: new WorkflowRepository(db),
        notifications: new ExecutionNotificationRepository(db),
      });
    });
  }

  function page(search: string) {
    return {
      userId: owner,
      workflowId,
      status: "all" as const,
      search,
      sort: "activity" as const,
      limit: 10,
      offset: 0,
    };
  }

  function commitHeadingAndDefault() {
    const writer = getSqliteInstance();
    writer.transaction(() => {
      expect(
        writer
          .prepare(
            "UPDATE workflowExecution SET context=json_set(context,'$.variables.task_prompt','B task') WHERE executionId=?",
          )
          .run(executionId).changes,
      ).toBe(1);
      expect(
        writer
          .prepare(
            "UPDATE workflow SET graph=json_set(graph,'$.variableRegistry.default_heading.default','B default') WHERE id=?",
          )
          .run(workflowId).changes,
      ).toBe(1);
    })();
  }

  test("a writer commits heading and authored default between awaited discovery reads without mixing count or title", async () => {
    let committed = false;
    const result = await snapshot(async (deps) => {
      const original = deps.workflows.getManyForTaskTitles.bind(deps.workflows);
      jest.spyOn(deps.workflows, "getManyForTaskTitles").mockImplementation(async (...args) => {
        const values = await original(...args);
        if (!committed) {
          commitHeadingAndDefault();
          committed = true;
        }
        return values;
      });
      return overviewPage(page("A task"), deps);
    });
    expect(committed).toBe(true);
    expect(result.total).toBe(1);
    expect(result.runs).toHaveLength(1);
    expect(result.runs[0]).toMatchObject({
      executionId,
      title: "A task / A default",
      matches: true,
    });
    const latest = await snapshot((deps) => overviewPage(page("B task"), deps));
    expect(latest.total).toBe(1);
    expect(latest.runs[0].title).toBe("B task / B default");
    expect(await snapshot((deps) => overviewPage(page("A task"), deps))).toMatchObject({
      total: 0,
      runs: [],
    });
  });

  test("unrelated commits at every awaited progress read cannot exhaust the overview generation guard", async () => {
    let writes = 0;
    const result = await snapshot(async (deps) => {
      const original = deps.executions.getManyForProgress.bind(deps.executions);
      jest.spyOn(deps.executions, "getManyForProgress").mockImplementation(async (...args) => {
        const values = await original(...args);
        expect(
          getSqliteInstance()
            .prepare("UPDATE user SET updatedAt=? WHERE id=?")
            .run(`unrelated-${++writes}`, owner).changes,
        ).toBe(1);
        return values;
      });
      return overviewPage(page("A task"), deps);
    });
    expect(writes).toBeGreaterThan(3);
    expect(result.total).toBe(1);
    expect(result.runs[0].title).toBe("A task / A default");
  });

  test("by-ID status facts and projection stay coherent when a writer completes and renames the run between reads", async () => {
    let committed = false;
    const result = await snapshot(async (deps) => {
      const original = deps.executions.getManyWorkflowReferences.bind(deps.executions);
      jest
        .spyOn(deps.executions, "getManyWorkflowReferences")
        .mockImplementation(async (...args) => {
          const values = await original(...args);
          commitHeadingAndDefault();
          expect(
            getSqliteInstance()
              .prepare(
                "UPDATE workflowExecution SET state='completed',completedAt=? WHERE executionId=?",
              )
              .run(Date.now(), executionId).changes,
          ).toBe(1);
          committed = true;
          return values;
        });
      return overviewRows(owner, [executionId], deps);
    });
    expect(committed).toBe(true);
    expect(result[0]).toMatchObject({
      executionId,
      status: "waiting-agent",
      title: "A task / A default",
      completedAt: null,
    });
    expect((await snapshot((deps) => overviewRows(owner, [executionId], deps)))[0]).toMatchObject({
      executionId,
      status: "completed",
      title: "B task / B default",
    });
  });

  test("a rejected callback closes only its own connection and preserves writer usability", async () => {
    const failure = new Error("Snapshot callback failure");
    await expect(
      snapshot(async () => {
        await Promise.resolve();
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(reader?.open).toBe(false);
    expect(getSqliteInstance().open).toBe(true);
    commitHeadingAndDefault();
  });

  test("private memory databases retain their original connection and generation guard", async () => {
    const memory = new Database(":memory:");
    try {
      memory.exec("CREATE TABLE fixture(value); INSERT INTO fixture VALUES(1)");
      await withReadSnapshot(async (_db, sqlite) => {
        expect(sqlite).toBe(memory);
        expect(sqlite.inTransaction).toBe(false);
        expect(sqlite.prepare("SELECT value FROM fixture").get()).toEqual({ value: 1 });
      }, memory);
      expect(memory.open).toBe(true);
      // This test intentionally uses no file-backed reader.
      reader = undefined;
    } finally {
      memory.close();
    }
  });
});
