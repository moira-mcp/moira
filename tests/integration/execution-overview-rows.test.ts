import { afterEach, beforeAll, describe, expect, test } from "@jest/globals";
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
import {
  overviewRows,
  type OverviewRun,
} from "../../packages/web-backend/src/services/execution-overview.js";

/**
 * What one overview row carries: the stages, a window of the active block's list around its current
 * item, and the current step named as people read it — never a node id — with the moment its
 * directive was shown.
 */

const USER_ID = "execution-overview-rows-user";
const STEPS = Array.from({ length: 8 }, (_, index) => ({ title: `Import batch ${index + 1}` }));

function graph(): WorkflowGraph {
  return {
    metadata: { name: "Order import rows", version: "1.0.0", description: "Overview rows test" },
    variableRegistry: {
      plan_steps: { type: "array", description: "The batches to import" },
      current_step: { type: "number", description: "The batch in progress, from 1" },
    },
    progress: {
      nodes: [
        {
          id: "work",
          label: "Import",
          content: { summary: "Import the orders batch by batch" },
          list: { items: "plan_steps", title: "title", current: "current_step" },
        },
        { id: "check", label: "Check", content: { summary: "Check the imported orders" } },
      ],
    },
    nodes: [
      { type: "start", id: "start", progressNodeId: "work", connections: { default: "import" } },
      {
        type: "agent-directive",
        id: "import",
        progressNodeId: "work",
        metadata: { displayName: "Import one batch" },
        directive: "Import the batch",
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

describe("an overview row", () => {
  let workflow: WorkflowGraph;
  let engine: ReturnType<typeof MCPEngine.getInstance>;
  let repository: DatabaseRepository;

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
    repository = new DatabaseRepository();
    const saved = await getWorkflowService().save({
      graph: graph(),
      userId: USER_ID,
      visibility: "private",
    });
    workflow = (await repository.getWorkflowGraph(saved.id, USER_ID))!;
  });

  afterEach(() => MCPEngine.resetInstance());

  async function runAt(current: number): Promise<{ executionId: string; row: OverviewRun }> {
    engine = MCPEngine.getInstance(repository);
    const executionId = await engine.executor.startWorkflow(
      workflow,
      { plan_steps: STEPS, current_step: current },
      USER_ID,
      `Rows ${current}`,
    );
    await engine.executor.executeStep(executionId, undefined, undefined, {
      userId: USER_ID,
      createPresentation: true,
    });
    const [row] = await overviewRows(USER_ID, [executionId], deps());
    return { executionId, row };
  }

  test.each([
    [1, [0, 1, 2, 3, 4]],
    [4, [1, 2, 3, 4, 5]],
    [7, [3, 4, 5, 6, 7]],
    [8, [3, 4, 5, 6, 7]],
  ])(
    "with batch %i in progress it shows five items around it, shifted in at the ends",
    async (current, window) => {
      const { row } = await runAt(current);
      expect(row.list?.title).toBe("Import");
      expect(row.list?.total).toBe(8);
      expect(row.list?.items.map((item) => item.index)).toEqual(window);
      expect(row.list?.items.filter((item) => item.current).map((item) => item.index)).toEqual([
        current - 1,
      ]);
      expect(row.list?.items.find((item) => item.current)?.title).toBe(`Import batch ${current}`);
    },
  );

  test("its stages are the flow's blocks, with the active one", async () => {
    const { row } = await runAt(2);
    expect(row.stages).toEqual({ labels: ["Import", "Check"], activeIndex: 0, doneCount: 0 });
  });

  test("its step is named as people read it, and dates the directive it waits at", async () => {
    const { executionId, row } = await runAt(3);
    expect(row.current?.stepName).toBe("Import one batch");
    const run = (await repository.getExecution(executionId))!;
    const open = run.visits!.filter((visit) => visit.nodeId === "import" && visit.exitKey === null);
    expect(row.current?.directiveShownAt).toBe(open.at(-1)!.enteredAt);

    // A step without a display name is named by its block, never by its id.
    const presentation = await engine.executor.executeStep(executionId, undefined, undefined, {
      userId: USER_ID,
      createPresentation: true,
    });
    await engine.executor.executeStep(executionId, {}, undefined, {
      userId: USER_ID,
      attemptId: presentation.match(/Step attempt ID:\s*([a-f0-9-]+)/i)![1],
    });
    const [atCheck] = await overviewRows(USER_ID, [executionId], deps());
    expect(atCheck.current?.stepName).toBe("Check");
    expect(JSON.stringify(atCheck)).not.toMatch(/"(?:import|check)"/);
  });
});
