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
  metadataRevision,
} from "@mcp-moira/shared";
import {
  DatabaseRepository,
  projectExecutionRun,
  resolveExecutionTaskTitle,
  type WorkflowGraph,
} from "@mcp-moira/workflow-engine";
import { MCPEngine } from "../../packages/mcp-server/src/core/mcp-engine.js";
import {
  overviewRows,
  overviewPage,
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
    expect(row.stages).toEqual({
      entries: [
        { id: "work", label: "Import", status: "waiting" },
        { id: "check", label: "Check", status: "pending" },
      ],
      labels: ["Import", "Check"],
      activeIndex: 0,
      doneCount: 0,
    });
  });

  test("a stored rename reaches compact rows independently of notes and retains own flow identity", async () => {
    const { executionId, row } = await runAt(2);
    expect(row.title).toBe("Order import rows");
    expect(row.note).toBe("Rows 2");
    const executionRepository = new ExecutionRepository(getDatabase());
    const source = (await repository.getExecution(executionId))!;
    const renamed = await executionRepository.updateExecutionTaskTitle(
      executionId,
      USER_ID,
      source.revision,
      metadataRevision(null),
      "Import April orders",
    );
    await executionRepository.updateNote(executionId, "Investigating alternate delimiters");
    const [current] = await overviewRows(USER_ID, [executionId], deps());
    expect(current.title).toBe("Import April orders");
    expect(current.workflowName).toBe("Order import rows");
    expect(current.note).toBe("Investigating alternate delimiters");
    const [compact] = await executionRepository.getManyForProgress([executionId]);
    expect(compact.taskIdentity).toEqual(renamed.taskIdentity);
    expect(compact.globalContext.variables).toEqual({});
  });

  test("a legacy authored title exceeding its resolved limit falls back to its own flow without losing the note", async () => {
    const definition = graph();
    definition.progress!.title = "{{task_request}}";
    definition.variableRegistry!.task_request = {
      type: "string",
      description: "The original task request",
    };
    const saved = await getWorkflowService().save({
      graph: definition,
      userId: USER_ID,
      visibility: "private",
    });
    const legacyWorkflow = (await repository.getWorkflowGraph(saved.id, USER_ID))!;
    engine = MCPEngine.getInstance(repository);
    const request = "🧭".repeat(501);
    const note = "Investigating the source request independently";
    const executionId = await engine.executor.startWorkflow(
      legacyWorkflow,
      { task_request: request, plan_steps: STEPS, current_step: 1 },
      USER_ID,
      note,
    );
    const stored = (await repository.getExecution(executionId))!;
    expect(stored.taskIdentity ?? null).toBeNull();
    expect(stored.globalContext.variables.task_request).toBe(request);
    expect(() => projectExecutionRun(legacyWorkflow, stored)).toThrow(
      /title exceeds .* after template resolution/,
    );
    const [row] = await overviewRows(USER_ID, [executionId], deps());
    expect(row.title).toBe(legacyWorkflow.metadata.name);
    expect(row.note).toBe(note);
    expect(row.stages).toBeNull();
    expect(resolveExecutionTaskTitle(legacyWorkflow, stored)).toBe(legacyWorkflow.metadata.name);
  });

  test("a matching child retains its completed parent as context and keeps its own canonical name", async () => {
    const parent = await runAt(1);
    const child = await runAt(2);
    const executionRepository = new ExecutionRepository(getDatabase());
    const parentSource = (await repository.getExecution(parent.executionId))!;
    const childSource = (await repository.getExecution(child.executionId))!;
    await repository.setExecutionParent(
      child.executionId,
      parent.executionId,
      USER_ID,
      childSource.revision,
      metadataRevision(null),
    );
    await executionRepository.updateExecutionTaskTitle(
      parent.executionId,
      USER_ID,
      parentSource.revision,
      metadataRevision(null),
      "Parent import task",
    );
    parentSource.status = "completed";
    parentSource.completedAt = 100;
    await repository.saveExecution(parentSource);
    const page = await overviewPage(
      {
        userId: USER_ID,
        status: "active",
        search: child.executionId,
        sort: "activity",
        limit: 20,
        offset: 0,
      },
      deps(),
    );
    expect(page.runs).toHaveLength(1);
    expect(page.runs[0]).toMatchObject({
      executionId: parent.executionId,
      title: "Parent import task",
      matches: false,
    });
    expect(page.runs[0].childRuns).toHaveLength(1);
    expect(page.runs[0].childRuns[0]).toMatchObject({
      executionId: child.executionId,
      title: "Order import rows",
      matches: true,
    });
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
    // Stable stage ids support reconciliation; every user-visible heading stays authored text.
    expect(
      JSON.stringify({
        current: atCheck.current,
        labels: atCheck.stages?.labels,
        list: atCheck.list,
      }),
    ).not.toMatch(/"(?:import|check)"/);
  });
});
