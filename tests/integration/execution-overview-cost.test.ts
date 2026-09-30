import { afterEach, beforeAll, describe, expect, jest, test } from "@jest/globals";
import {
  ExecutionNotificationRepository,
  ExecutionOverviewRepository,
  ExecutionRepository,
  getDatabase,
  getSqliteInstance,
  getWorkflowService,
  user,
  WorkflowRepository,
} from "@mcp-moira/shared";
import { DatabaseRepository, type WorkflowGraph } from "@mcp-moira/workflow-engine";
import { MCPEngine } from "../../packages/mcp-server/src/core/mcp-engine.js";
import { overviewPage } from "../../packages/web-backend/src/services/execution-overview.js";

/**
 * The overview projects a page in batch: the number of database queries is the same for a page of
 * five runs and a page of fifty runs of one flow. Queries are counted as statements the SQLite
 * connection prepares — every Drizzle query and every raw statement goes through it.
 */

const USER_ID = "execution-overview-cost-user";

function graph(): WorkflowGraph {
  return {
    metadata: { name: "Order import cost", version: "1.0.0", description: "Overview cost test" },
    progress: {
      nodes: [
        { id: "work", label: "Import", content: { summary: "Import the orders" } },
        { id: "check", label: "Check", content: { summary: "Check the imported orders" } },
      ],
    },
    nodes: [
      { type: "start", id: "start", progressNodeId: "work", connections: { default: "import" } },
      {
        type: "agent-directive",
        id: "import",
        progressNodeId: "work",
        directive: "Import the orders",
        completionCondition: "Imported",
        connections: { success: "check" },
        connectionLabels: { success: "imported" },
      },
      {
        type: "agent-directive",
        id: "check",
        progressNodeId: "check",
        directive: "Check the orders",
        completionCondition: "Checked",
        connections: { success: "end" },
      },
      { type: "end", id: "end", progressNodeId: "check" },
    ],
  };
}

function deps() {
  const db = getDatabase();
  return {
    overview: new ExecutionOverviewRepository(getSqliteInstance()),
    executions: new ExecutionRepository(db),
    workflows: new WorkflowRepository(db),
    notifications: new ExecutionNotificationRepository(db),
  };
}

describe("the overview's cost does not grow with the page", () => {
  beforeAll(async () => {
    const now = new Date().toISOString();
    await getDatabase()
      .insert(user)
      .values({
        id: USER_ID,
        email: `${USER_ID}@example.test`,
        handle: USER_ID,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing();
    const repository = new DatabaseRepository();
    const saved = await getWorkflowService().save({
      graph: graph(),
      userId: USER_ID,
      visibility: "private",
    });
    const workflow = (await repository.getWorkflowGraph(saved.id, USER_ID))!;
    const engine = MCPEngine.getInstance(repository);
    for (let index = 0; index < 50; index += 1) {
      const executionId = await engine.executor.startWorkflow(
        workflow,
        {},
        USER_ID,
        `Import batch ${index}`,
      );
      await engine.executor.executeStep(executionId, undefined, undefined, {
        userId: USER_ID,
        createPresentation: true,
      });
    }
  });

  afterEach(() => {
    jest.restoreAllMocks();
    MCPEngine.resetInstance();
  });

  async function countedPage(limit: number) {
    const sqlite = getSqliteInstance();
    const prepare = jest.spyOn(sqlite, "prepare");
    const page = await overviewPage(
      { userId: USER_ID, status: "active", sort: "activity", limit, offset: 0 },
      deps(),
    );
    const queries = prepare.mock.calls.length;
    prepare.mockRestore();
    return { page, queries };
  }

  test("a page of five and a page of fifty take the same number of queries", async () => {
    const five = await countedPage(5);
    const fifty = await countedPage(50);
    expect(five.page.runs).toHaveLength(5);
    expect(fifty.page.runs).toHaveLength(50);
    expect(fifty.page.runs.every((run) => run.stages?.labels.length === 2)).toBe(true);
    expect(fifty.queries).toBe(five.queries);
  });
});
