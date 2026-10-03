import { afterEach, beforeAll, describe, expect, jest, test } from "@jest/globals";
import {
  ExecutionNotificationRepository,
  ExecutionOverviewRepository,
  ExecutionRepository,
  ConflictError,
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
  progressReadDependencies,
  type WorkflowGraph,
} from "@mcp-moira/workflow-engine";
import { MCPEngine } from "../../packages/mcp-server/src/core/mcp-engine.js";
import {
  overviewPage,
  overviewRows,
} from "../../packages/web-backend/src/services/execution-overview.js";
import { cpuTimeMs } from "../utils/cpu-time.js";
import Database from "better-sqlite3";

/**
 * The overview projects a page in batch: the number of database queries is the same for a page of
 * five runs and a page of fifty runs of one flow. Queries are counted as statements the SQLite
 * connection prepares — every Drizzle query and every raw statement goes through it.
 */

const USER_ID = "execution-overview-cost-user";
const executionIds: string[] = [];
let workflowGraph: WorkflowGraph;

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

async function nativeRead<T>(work: () => Promise<T>): Promise<{ result: T; native: string }> {
  const sqlite = getSqliteInstance();
  const prepare = sqlite.prepare.bind(sqlite);
  const nativeResults: unknown[] = [];
  const spy = jest.spyOn(sqlite, "prepare").mockImplementation((statementSql) => {
    const statement = prepare(statementSql);
    const proxy: typeof statement = new Proxy(statement, {
      get(target, key) {
        const member = Reflect.get(target, key);
        if (key === "raw")
          return (...args: unknown[]) => {
            member.apply(target, args);
            return proxy;
          };
        if (key === "all" || key === "get")
          return (...args: unknown[]) => {
            const result = member.apply(target, args);
            nativeResults.push(result);
            return result;
          };
        return typeof member === "function" ? member.bind(target) : member;
      },
    });
    return proxy;
  });
  try {
    return { result: await work(), native: JSON.stringify(nativeResults) };
  } finally {
    spy.mockRestore();
  }
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
      executionIds.push(executionId);
    }
    workflowGraph = workflow;
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

  test("exact current visible heading search precedes count/page and excludes unused native payload", async () => {
    const definition = graph();
    definition.metadata.name = "Selective heading fixture";
    definition.progress!.title = "{{task_prompt}}";
    const marker = "UNUSED_TITLE_SEARCH_PAYLOAD_";
    definition.variableRegistry = {
      task_prompt: {
        type: "string",
        description: "Authored title",
        default: "{{#if ready}}{{chosen[index].name}}{{else}}Not ready{{/if}}",
      },
      unused_default: {
        type: "string",
        description: marker.repeat(1000),
        default: marker.repeat(1000),
      },
    };
    const repository = new DatabaseRepository();
    const saved = await getWorkflowService().save({
      graph: definition,
      userId: USER_ID,
      visibility: "private",
    });
    const authored = (await repository.getWorkflowGraph(saved.id, USER_ID))!;
    const engine = MCPEngine.getInstance(repository);
    const ids: string[] = [];
    for (let index = 0; index < 3; index++) {
      ids.push(
        await engine.executor.startWorkflow(
          authored,
          {
            ready: true,
            index: 1,
            chosen: [{ name: "Earlier" }, { name: "Точная видимая задача" }],
            unused: marker.repeat(1000),
          },
          USER_ID,
          "Independent investigation note",
        ),
      );
    }
    const executions = new ExecutionRepository(getDatabase());
    const first = (await executions.get(ids[0]))!;
    await executions.updateExecutionTaskTitle(
      ids[0],
      USER_ID,
      first.revision,
      metadataRevision(null),
      "Explicit replacement heading",
    );
    const dependencies = deps();
    const fullDefinitions = jest.spyOn(dependencies.workflows, "getManyForUser");
    const query = {
      userId: USER_ID,
      workflowId: saved.id,
      status: "active" as const,
      search: "ТОЧНАЯ ВИДИМАЯ",
      sort: "activity" as const,
      limit: 1,
      offset: 2,
    };
    const { result: beyond, native } = await nativeRead(() => overviewPage(query, dependencies));
    expect(beyond.total).toBe(2);
    expect(beyond.runs).toEqual([]);
    expect(native).not.toContain(marker);
    expect(fullDefinitions.mock.calls.every(([requested]) => requested.length === 0)).toBe(true);
    const visible = await overviewPage({ ...query, offset: 0, limit: 10 }, deps());
    expect(visible.runs.map((run) => run.executionId).sort()).toEqual(ids.slice(1).sort());
    expect(visible.runs.every((run) => run.title === "Точная видимая задача")).toBe(true);
    const replacement = await overviewPage(
      { ...query, search: "Explicit replacement", offset: 0 },
      deps(),
    );
    expect(replacement.total).toBe(1);
    expect(replacement.runs[0].executionId).toBe(ids[0]);
  });

  test("a same-generation title context change is retried before SQL membership", async () => {
    const definition = graph();
    definition.metadata.name = "Heading generation fixture";
    definition.progress!.title = "{{task_request}}";
    const repository = new DatabaseRepository();
    const saved = await getWorkflowService().save({
      graph: definition,
      userId: USER_ID,
      visibility: "private",
    });
    const authored = (await repository.getWorkflowGraph(saved.id, USER_ID))!;
    const id = await MCPEngine.getInstance(repository).executor.startWorkflow(
      authored,
      { task_request: "Obsolete visible heading" },
      USER_ID,
    );
    const initialRevision = (await repository.getExecution(id))!.revision;
    const dependencies = deps();
    const original = dependencies.executions.getManyForProgress.bind(dependencies.executions);
    let changed = false;
    jest
      .spyOn(dependencies.executions, "getManyForProgress")
      .mockImplementation(async (ids, reads, purpose) => {
        const result = await original(ids, reads, purpose);
        if (
          !changed &&
          purpose === "title" &&
          reads?.some((read) => read.variables?.includes("task_request"))
        ) {
          changed = true;
          getSqliteInstance()
            .prepare(
              "UPDATE workflowExecution SET context=json_set(context,'$.variables.task_request',?) WHERE executionId=?",
            )
            .run("Latest visible heading", id);
        }
        return result;
      });
    const page = await overviewPage(
      {
        userId: USER_ID,
        workflowId: saved.id,
        status: "active",
        search: "Latest visible",
        sort: "activity",
        limit: 1,
        offset: 0,
      },
      dependencies,
    );
    expect(changed).toBe(true);
    expect(page.total).toBe(1);
    expect(page.runs[0]).toMatchObject({ executionId: id, title: "Latest visible heading" });
    expect((await repository.getExecution(id))!.revision).toBe(initialRevision);
    const obsolete = await overviewPage(
      {
        userId: USER_ID,
        workflowId: saved.id,
        status: "active",
        search: "Obsolete visible",
        sort: "activity",
        limit: 1,
        offset: 0,
      },
      deps(),
    );
    expect(obsolete.total).toBe(0);
  });

  test("older definitions use one complete migration fallback and preserve literal title data", async () => {
    const definition = graph();
    definition.metadata.name = "Earlier schema heading fixture";
    definition.progress!.title = "{{task_text}}";
    const repository = new DatabaseRepository();
    const saved = await getWorkflowService().save({
      graph: definition,
      userId: USER_ID,
      visibility: "private",
    });
    const authored = (await repository.getWorkflowGraph(saved.id, USER_ID))!;
    const ids: string[] = [];
    for (let index = 0; index < 2; index++)
      ids.push(
        await MCPEngine.getInstance(repository).executor.startWorkflow(
          authored,
          {
            task_text: "Literal {{secret}} reference",
            secret: "Hidden expanded value",
          },
          USER_ID,
        ),
      );
    getSqliteInstance()
      .prepare("UPDATE workflow SET graph=json_remove(graph,'$.metadata.schemaVersion') WHERE id=?")
      .run(saved.id);
    const dependencies = deps();
    const fallback = jest.spyOn(dependencies.workflows, "getManyForUser");
    const query = {
      userId: USER_ID,
      workflowId: saved.id,
      status: "active" as const,
      search: "{{secret}}",
      sort: "activity" as const,
      limit: 1,
      offset: 2,
    };
    const page = await overviewPage(query, dependencies);
    expect(page.total).toBe(2);
    expect(page.runs).toEqual([]);
    expect(fallback.mock.calls.filter(([requested]) => requested.length > 0)).toEqual([
      [[saved.id], USER_ID],
    ]);
    const hidden = await overviewPage({ ...query, search: "Hidden expanded", offset: 0 }, deps());
    expect(hidden.total).toBe(0);
    const visible = await overviewPage({ ...query, offset: 0, limit: 10 }, deps());
    expect(visible.runs.map((run) => run.executionId).sort()).toEqual(ids.sort());
    expect(visible.runs.every((run) => run.title === "Literal {{secret}} reference")).toBe(true);
  });

  test.each(["context", "definition"])(
    "another SQLite connection changing %s cannot return stale heading membership",
    async (mutation) => {
      const definition = graph();
      definition.metadata.name = `Independent ${mutation} heading fixture`;
      definition.progress!.title = "{{task_request}}";
      const repository = new DatabaseRepository();
      const saved = await getWorkflowService().save({
        graph: definition,
        userId: USER_ID,
        visibility: "private",
      });
      const authored = (await repository.getWorkflowGraph(saved.id, USER_ID))!;
      const id = await MCPEngine.getInstance(repository).executor.startWorkflow(
        authored,
        { task_request: "Earlier heading generation" },
        USER_ID,
      );
      const before = (await repository.getExecution(id))!;
      const other = new Database(getSqliteInstance().name);
      const dependencies = deps();
      let changed = false;
      try {
        if (mutation === "context") {
          const original = dependencies.executions.getManyForProgress.bind(dependencies.executions);
          jest
            .spyOn(dependencies.executions, "getManyForProgress")
            .mockImplementation(async (ids, reads, purpose) => {
              const result = await original(ids, reads, purpose);
              if (
                !changed &&
                purpose === "title" &&
                reads?.some((read) => read.variables?.includes("task_request"))
              ) {
                changed = true;
                expect(
                  other
                    .prepare(
                      "UPDATE workflowExecution SET context=json_set(context,'$.variables.task_request',?) WHERE executionId=?",
                    )
                    .run("Latest heading generation", id).changes,
                ).toBe(1);
              }
              return result;
            });
        } else {
          const original = dependencies.workflows.getManyForTaskTitles.bind(dependencies.workflows);
          jest
            .spyOn(dependencies.workflows, "getManyForTaskTitles")
            .mockImplementation(async (...args) => {
              const result = await original(...args);
              if (!changed) {
                changed = true;
                expect(
                  other
                    .prepare(
                      "UPDATE workflow SET graph=json_set(graph,'$.progress.title',?) WHERE id=?",
                    )
                    .run("Latest heading generation", saved.id).changes,
                ).toBe(1);
              }
              return result;
            });
        }
        const query = {
          userId: USER_ID,
          workflowId: saved.id,
          status: "active" as const,
          search: "Latest heading generation",
          sort: "activity" as const,
          limit: 1,
          offset: 0,
        };
        const page = await overviewPage(query, dependencies);
        expect(changed).toBe(true);
        expect(page.total).toBe(1);
        expect(page.runs[0]).toMatchObject({ executionId: id, title: "Latest heading generation" });
        expect((await repository.getExecution(id))!.revision).toBe(before.revision);
        expect(
          (await overviewPage({ ...query, search: "Earlier heading generation" }, deps())).total,
        ).toBe(0);
      } finally {
        other.close();
      }
    },
  );

  test("unused context and visit payloads never cross the native compact-read boundary", async () => {
    const repository = new ExecutionRepository(getDatabase());
    const source = (await repository.get(executionIds[0]))!;
    const marker = "UNUSED_NATIVE_PAYLOAD_";
    source.globalContext.variables.unused = marker.repeat(20_000);
    source.globalContext.nodeStates.unused = marker.repeat(20_000);
    source.visits![0].changes.unused = marker.repeat(20_000);
    source.reminders = [
      { id: "unused", text: marker.repeat(20_000), status: "active", createdAt: 1, updatedAt: 1 },
    ];
    source.error = marker.repeat(20_000);
    source.errors = [
      {
        timestamp: 1,
        nodeId: "import",
        errorType: "handler",
        message: marker.repeat(20_000),
        input: marker.repeat(20_000),
      },
    ];
    await repository.save(source);
    const read = progressReadDependencies(workflowGraph);
    const { result: compact, native } = await nativeRead(() =>
      repository.getManyForProgress(
        [source.executionId],
        [{ executionId: source.executionId, ...read }],
      ),
    );
    expect(native).not.toContain(marker);
    expect(Buffer.byteLength(native)).toBeLessThan(4_000);
    expect(compact[0].visits).toHaveLength(source.visits!.length);
    expect(compact[0].visits![0].changes).toEqual({});
    expect(
      projectExecutionRun(workflowGraph, compact[0])?.nodes.map((node) => node.status),
    ).toEqual(projectExecutionRun(workflowGraph, source)?.nodes.map((node) => node.status));
    expect((await repository.get(source.executionId))!.globalContext.variables.unused).toBe(
      source.globalContext.variables.unused,
    );
  });

  test("one run's required cursor does not select another run's unrelated history payload", async () => {
    const repository = new ExecutionRepository(getDatabase());
    const second = (await repository.get(executionIds[1]))!;
    const marker = "UNRELATED_OTHER_PROGRESS_BINDING_";
    second.visits![0].changes.other_cursor = marker.repeat(20_000);
    await repository.save(second);
    const { result: runs, native } = await nativeRead(() =>
      repository.getManyForProgress(
        [executionIds[0], executionIds[1]],
        [
          { executionId: executionIds[0], variables: [], historyRoots: ["other_cursor"] },
          { executionId: executionIds[1], variables: [], historyRoots: [] },
        ],
      ),
    );
    expect(runs.find((run) => run.executionId === second.executionId)!.visits![0].changes).toEqual(
      {},
    );
    expect(JSON.stringify(runs)).not.toContain(marker);
    expect(native).not.toContain(marker);
  });

  test.each([
    { current: "\t500\n", total: undefined, start: 497 },
    { current: "500", total: "-12-", start: 497 },
    { current: 500, total: 200, start: 0 },
    { current: "-12-", total: undefined, start: 0 },
    { current: 601, total: 600, start: 0 },
  ])(
    "sparse native list windows preserve shared counter semantics for $current / $total",
    async ({ current, total, start }) => {
      const repository = new ExecutionRepository(getDatabase());
      const source = (await repository.get(executionIds[0]))!;
      source.globalContext.variables.tasks = Array.from({ length: 600 }, (_, index) => ({
        title: `Task ${index}`,
      }));
      source.globalContext.variables.cursor = current;
      source.globalContext.variables.total = total;
      await repository.save(source);
      const definition = structuredClone(workflowGraph);
      definition.progress!.nodes[0].list = {
        items: "tasks",
        current: "cursor",
        total: "total",
        title: "title",
      };
      const dependencies = deps();
      jest
        .spyOn(dependencies.workflows, "getManyForUser")
        .mockResolvedValue(
          new Map([[source.workflowId, { name: definition.metadata.name, graph: definition }]]),
        );
      const [row] = await overviewRows(USER_ID, [source.executionId], dependencies);
      const full = projectExecutionRun(definition, source)!.nodes[0].list!;
      expect(row.list?.done).toBe(full.done);
      expect(row.list?.total).toBe(full.total);
      expect(row.list?.items).toEqual(full.items!.slice(start, start + 5));
      expect(row.list?.items.map((item) => item.index)).toEqual([
        start,
        start + 1,
        start + 2,
        start + 3,
        start + 4,
      ]);
    },
  );

  test.each(["current", "done", "total"] as const)(
    "a %s counter under the items root remains available outside the visible window",
    async (counter) => {
      const repository = new ExecutionRepository(getDatabase());
      const source = (await repository.get(executionIds[0]))!;
      const tasks = Array.from({ length: 100 }, (_, index) => ({
        title: `Task ${index}`,
        counter: 0,
      }));
      tasks[99].counter = counter === "total" ? 120 : 21;
      source.globalContext.variables.tasks = tasks;
      source.globalContext.variables.cursor = 21;
      await repository.save(source);
      const definition = structuredClone(workflowGraph);
      definition.progress!.nodes[0].list = {
        items: "tasks",
        current: "cursor",
        title: "title",
        [counter]: "tasks[99].counter",
      };
      const dependencies = deps();
      jest
        .spyOn(dependencies.workflows, "getManyForUser")
        .mockResolvedValue(
          new Map([[source.workflowId, { name: definition.metadata.name, graph: definition }]]),
        );
      const [row] = await overviewRows(USER_ID, [source.executionId], dependencies);
      const full = projectExecutionRun(definition, source)!.nodes[0].list!;
      expect(row.list?.done).toBe(full.done);
      expect(row.list?.total).toBe(full.total);
      expect(row.list?.items).toEqual(full.items!.slice(18, 23));
      expect(row.list?.items.map((item) => item.index)).toEqual([18, 19, 20, 21, 22]);
      expect((await repository.get(source.executionId))!.globalContext.variables.tasks).toEqual(
        tasks,
      );
    },
  );

  test("an items root consumed by another block's counter is preserved for the whole progress read", async () => {
    const repository = new ExecutionRepository(getDatabase());
    const source = (await repository.get(executionIds[0]))!;
    const tasks = Array.from({ length: 100 }, (_, index) => ({
      title: `Task ${index}`,
      counter: index === 99 ? 21 : 0,
    }));
    source.globalContext.variables.tasks = tasks;
    source.globalContext.variables.cursor = 21;
    await repository.save(source);
    const definition = structuredClone(workflowGraph);
    definition.progress!.nodes[0].list = { items: "tasks", current: "cursor", title: "title" };
    definition.progress!.nodes[1].list = { current: "tasks[99].counter", total: "cursor" };
    const read = progressReadDependencies(definition, source.globalContext.variables);
    const [compact] = await repository.getManyForProgress(
      [source.executionId],
      [{ executionId: source.executionId, ...read }],
    );
    expect(compact.globalContext.variables.tasks).toEqual(tasks);
    expect(projectExecutionRun(definition, compact)!.nodes[1].list).toEqual(
      projectExecutionRun(definition, source)!.nodes[1].list,
    );
  });

  test.each([null, { counter: 21 }, "not an array", 7, false])(
    "stored non-array %p stays distinct from an authored array default",
    async (actual) => {
      const repository = new ExecutionRepository(getDatabase());
      const source = (await repository.get(executionIds[0]))!;
      source.globalContext.variables.tasks = actual;
      source.globalContext.variables.cursor = 1;
      await repository.save(source);
      const definition = structuredClone(workflowGraph);
      definition.variableRegistry = {
        ...definition.variableRegistry,
        tasks: {
          type: "array",
          description: "Default checklist",
          default: [{ title: "Default A" }, { title: "Default B" }],
        },
      };
      definition.progress!.nodes[0].list = { items: "tasks", current: "cursor", title: "title" };
      const read = progressReadDependencies(definition, source.globalContext.variables);
      const [compact] = await repository.getManyForProgress(
        [source.executionId],
        [{ executionId: source.executionId, ...read }],
      );
      expect(Object.hasOwn(compact.globalContext.variables, "tasks")).toBe(true);
      expect(compact.globalContext.variables.tasks).toEqual(actual);
      const dependencies = deps();
      jest
        .spyOn(dependencies.workflows, "getManyForUser")
        .mockResolvedValue(
          new Map([[source.workflowId, { name: definition.metadata.name, graph: definition }]]),
        );
      const [row] = await overviewRows(USER_ID, [source.executionId], dependencies);
      const full = projectExecutionRun(definition, source)!.nodes[0].list!;
      expect(full.items).toBeNull();
      expect(row.list?.items).toEqual([]);
      expect(row.list?.done).toBe(full.done);
      expect(row.list?.total).toBe(full.total);
      expect((await repository.get(source.executionId))!.globalContext.variables.tasks).toEqual(
        actual,
      );
    },
  );

  test("boolean variables retain their JSON type for strict template comparison", async () => {
    const repository = new ExecutionRepository(getDatabase());
    const source = (await repository.get(executionIds[0]))!;
    source.globalContext.variables.ready = true;
    await repository.save(source);
    const definition = structuredClone(workflowGraph);
    definition.progress!.nodes[0].label = "{{#eq ready 'true'}}Ready{{else}}Wrong type{{/eq}}";
    const dependencies = deps();
    jest
      .spyOn(dependencies.workflows, "getManyForUser")
      .mockResolvedValue(
        new Map([[source.workflowId, { name: definition.metadata.name, graph: definition }]]),
      );
    const [row] = await overviewRows(USER_ID, [source.executionId], dependencies);
    expect(row.stages?.labels[0]).toBe("Ready");
    expect(row.stages?.labels).toEqual(
      projectExecutionRun(definition, source)!.nodes.map((node) => node.label),
    );
  });

  test("boolean window items retain their titles and stored JSON type", async () => {
    const repository = new ExecutionRepository(getDatabase());
    const source = (await repository.get(executionIds[0]))!;
    const tasks = [true, false, 0, 1, "plain"];
    source.globalContext.variables.tasks = tasks;
    source.globalContext.variables.cursor = 2;
    await repository.save(source);
    const definition = structuredClone(workflowGraph);
    definition.progress!.nodes[0].list = { items: "tasks", current: "cursor" };
    const dependencies = deps();
    jest
      .spyOn(dependencies.workflows, "getManyForUser")
      .mockResolvedValue(
        new Map([[source.workflowId, { name: definition.metadata.name, graph: definition }]]),
      );
    const [row] = await overviewRows(USER_ID, [source.executionId], dependencies);
    expect(row.list?.items.map((item) => item.title)).toEqual(["true", "false", "0", "1", "plain"]);
    expect(row.list?.items).toEqual(projectExecutionRun(definition, source)!.nodes[0].list!.items);
    expect((await repository.get(source.executionId))!.globalContext.variables.tasks).toEqual(
      tasks,
    );
  });

  test("boolean history writes remain invalid counters instead of becoming numeric item indices", async () => {
    const repository = new ExecutionRepository(getDatabase());
    const source = (await repository.get(executionIds[0]))!;
    source.globalContext.variables.tasks = ["First", "Second"];
    source.globalContext.variables.cursor = 2;
    source.currentNodeId = "import";
    source.waitingForInputNodeId = "import";
    source.visits = [
      {
        seq: 0,
        nodeId: "start",
        exitKey: "default",
        changes: { cursor: true },
        enteredAt: 0,
        leftAt: 5,
      },
      {
        seq: 1,
        nodeId: "import",
        exitKey: "success",
        changes: { cursor: 2 },
        enteredAt: 10,
        leftAt: 30,
      },
      { seq: 2, nodeId: "import", exitKey: null, changes: {}, waited: true, enteredAt: 40 },
    ];
    await repository.save(source);
    const definition = structuredClone(workflowGraph);
    definition.progress!.nodes[0].list = { items: "tasks", current: "cursor" };
    const read = progressReadDependencies(definition, source.globalContext.variables);
    const [compact] = await repository.getManyForProgress(
      [source.executionId],
      [{ executionId: source.executionId, ...read }],
    );
    expect(compact.visits![0].changes.cursor).toBe(true);
    const full = projectExecutionRun(definition, source, { now: 100 })!;
    expect(projectExecutionRun(definition, compact, { now: 100 })!.nodes[0].list).toEqual(
      full.nodes[0].list,
    );
    expect(full.nodes[0].list?.items?.map((item) => item.durationMs)).toEqual([null, 60]);
  });

  test("runtime fragments, conditionals and dynamic indices retain current labels after dependency expansion", async () => {
    const repository = new ExecutionRepository(getDatabase());
    const source = (await repository.get(executionIds[0]))!;
    source.globalContext.variables.task_prompt =
      "{{#if ready}}{{chosen[index].name}}{{else}}Not ready{{/if}}";
    source.globalContext.variables.ready = true;
    source.globalContext.variables.index = 1;
    source.globalContext.variables.chosen = [{ name: "Earlier" }, { name: "Selected task" }];
    await repository.save(source);
    const definition = structuredClone(workflowGraph);
    definition.progress!.nodes[0].label = "{{task_prompt}}";
    const dependencies = deps();
    jest
      .spyOn(dependencies.workflows, "getManyForUser")
      .mockResolvedValue(
        new Map([[source.workflowId, { name: definition.metadata.name, graph: definition }]]),
      );
    const [row] = await overviewRows(USER_ID, [source.executionId], dependencies);
    expect(row.stages?.labels[0]).toBe("Selected task");
    expect(row.stages?.labels).toEqual(
      projectExecutionRun(definition, source)!.nodes.map((node) => node.label),
    );
  });

  test.each(["alternating", "continuously-new", "unchanged-generation", "growing-chain"])(
    "%s changing discovery fragments return a retryable conflict before the bounded sentinel",
    async (mode) => {
      const repository = new ExecutionRepository(getDatabase());
      const source = (await repository.get(executionIds[0]))!;
      source.globalContext.variables.task_prompt =
        mode === "growing-chain" ? "{{chain_0_prompt}}" : "{{left}}";
      source.globalContext.variables.chain_0_prompt = "Pending";
      source.globalContext.variables.left = "Left task";
      source.globalContext.variables.right = "Right task";
      await repository.save(source);
      const definition = structuredClone(workflowGraph);
      definition.progress!.nodes[0].label = "{{task_prompt}}";
      const dependencies = deps();
      jest
        .spyOn(dependencies.workflows, "getManyForUser")
        .mockResolvedValue(
          new Map([[source.workflowId, { name: definition.metadata.name, graph: definition }]]),
        );
      const original = dependencies.executions.getManyForProgress.bind(dependencies.executions);
      let discoveryReads = 0;
      jest
        .spyOn(dependencies.executions, "getManyForProgress")
        .mockImplementation(async (ids, reads) => {
          if (reads?.some((read) => !read.visits)) {
            discoveryReads += 1;
            if (discoveryReads === 10)
              throw new Error("Discovery did not terminate: bounded sentinel");
            const name =
              mode === "alternating" || mode === "unchanged-generation"
                ? discoveryReads % 2
                  ? "right"
                  : "left"
                : `selection_${discoveryReads}`;
            if (mode === "unchanged-generation") {
              // Context metadata writes can share a millisecond and leave the step generation
              // intact. Fragment values must also detect instability, not just row timestamps.
              getSqliteInstance()
                .prepare(
                  "UPDATE workflowExecution SET context = json_set(context, '$.variables.task_prompt', ?) WHERE executionId = ?",
                )
                .run(`{{${name}}}`, source.executionId);
            } else {
              const latest = (await repository.get(source.executionId))!;
              if (mode === "growing-chain") {
                // Extend the next unseen dependency while the already-read prefix stays stable.
                latest.globalContext.variables[`chain_${discoveryReads - 1}_prompt`] =
                  `{{chain_${discoveryReads}_prompt}}`;
                latest.globalContext.variables[`chain_${discoveryReads}_prompt`] = "Pending";
              } else {
                latest.globalContext.variables.task_prompt = `{{${name}}}`;
                latest.globalContext.variables[name] = `Task ${name}`;
              }
              await repository.save(latest);
            }
          }
          return original(ids, reads);
        });
      await expect(
        overviewRows(USER_ID, [source.executionId], dependencies),
      ).rejects.toBeInstanceOf(ConflictError);
      expect(discoveryReads).toBeLessThan(10);
    },
  );

  test("a stable long dependency closure keeps literal data text and completes without a blanket round limit", async () => {
    const repository = new ExecutionRepository(getDatabase());
    const source = (await repository.get(executionIds[0]))!;
    source.globalContext.variables.task_text = "Import the literal {{reference_0}} example";
    for (let index = 0; index < 12; index++) {
      source.globalContext.variables[`reference_${index}`] = `{{reference_${index + 1}}}`;
    }
    source.globalContext.variables.reference_12 = "Reference value";
    await repository.save(source);
    const definition = structuredClone(workflowGraph);
    definition.progress!.nodes[0].label = "{{task_text}}";
    const dependencies = deps();
    jest
      .spyOn(dependencies.workflows, "getManyForUser")
      .mockResolvedValue(
        new Map([[source.workflowId, { name: definition.metadata.name, graph: definition }]]),
      );
    const [row] = await overviewRows(USER_ID, [source.executionId], dependencies);
    expect(row.stages?.labels[0]).toBe("Import the literal {{reference_0}} example");
    expect(row.stages?.labels).toEqual(
      projectExecutionRun(definition, source)!.nodes.map((node) => node.label),
    );
  });

  test("a cursor changing between discovery and native list read uses the new coherent window", async () => {
    const repository = new ExecutionRepository(getDatabase());
    const source = (await repository.get(executionIds[0]))!;
    source.globalContext.variables.tasks = Array.from({ length: 600 }, (_, index) => ({
      title: `Task ${index}`,
    }));
    source.globalContext.variables.cursor = 3;
    await repository.save(source);
    const definition = structuredClone(workflowGraph);
    definition.progress!.nodes[0].list = { items: "tasks", current: "cursor", title: "title" };
    const dependencies = deps();
    jest
      .spyOn(dependencies.workflows, "getManyForUser")
      .mockResolvedValue(
        new Map([[source.workflowId, { name: definition.metadata.name, graph: definition }]]),
      );
    const original = dependencies.executions.getManyForProgress.bind(dependencies.executions);
    let moved = false;
    jest
      .spyOn(dependencies.executions, "getManyForProgress")
      .mockImplementation(async (ids, reads) => {
        if (!moved && reads?.some((read) => read.visits)) {
          moved = true;
          const latest = (await repository.get(source.executionId))!;
          latest.globalContext.variables.cursor = 500;
          await repository.save(latest);
        }
        return original(ids, reads);
      });
    const [row] = await overviewRows(USER_ID, [source.executionId], dependencies);
    expect(row.list?.done).toBe(499);
    expect(row.list?.items.map((item) => item.index)).toEqual([497, 498, 499, 500, 501]);
    expect(row.list?.items.find((item) => item.current)?.title).toBe("Task 499");
  });

  test("node-local cursor histories retain per-item durations across the native compact boundary", async () => {
    const repository = new ExecutionRepository(getDatabase());
    const source = (await repository.get(executionIds[0]))!;
    source.globalContext.variables.tasks = Array.from({ length: 9 }, (_, index) => ({
      title: `Task ${index}`,
    }));
    source.globalContext.variables.import = { counter: 2 };
    source.currentNodeId = "import";
    source.waitingForInputNodeId = "import";
    source.visits = [
      {
        seq: 0,
        nodeId: "start",
        exitKey: "default",
        changes: { "import.counter": 1 },
        enteredAt: 0,
        leftAt: 5,
      },
      {
        seq: 1,
        nodeId: "import",
        exitKey: "success",
        changes: { "import.counter": 2 },
        enteredAt: 10,
        leftAt: 30,
      },
      { seq: 2, nodeId: "import", exitKey: null, changes: {}, waited: true, enteredAt: 40 },
    ];
    await repository.save(source);
    const definition = structuredClone(workflowGraph);
    definition.progress!.nodes[0].list = {
      items: "tasks",
      current: "import.counter",
      title: "title",
    };
    const dependencies = { ...deps(), now: () => 100 };
    jest
      .spyOn(dependencies.workflows, "getManyForUser")
      .mockResolvedValue(
        new Map([[source.workflowId, { name: definition.metadata.name, graph: definition }]]),
      );
    const [row] = await overviewRows(USER_ID, [source.executionId], dependencies);
    expect(row.list?.done).toBe(1);
    expect(row.list?.items.map((item) => item.durationMs)).toEqual([20, 60, null, null, null]);
    expect(row.list?.items.find((item) => item.current)?.title).toBe("Task 1");
  });

  test("mixed completed and active descendant trees retain exact root counts within the membership CPU budget", async () => {
    const sqlite = getSqliteInstance();
    const source = (await new ExecutionRepository(getDatabase()).get(executionIds[0]))!;
    const prefix = "overview-mixed-shape-";
    const insert = sqlite.prepare(`INSERT INTO workflowExecution
      (executionId, workflowId, userId, state, context, visits, parentExecutionId, createdAt, updatedAt, lastActivityAt)
      VALUES (?, ?, ?, ?, '{}', '[]', ?, ?, ?, ?)`);
    const now = Date.UTC(2026, 9, 1);
    sqlite.transaction(() => {
      for (let index = 0; index < 1748; index++) {
        const parent =
          index < 70 ? index + 70 : index >= 307 && index < 811 ? 70 + ((index - 307) % 237) : null;
        insert.run(
          `${prefix}${index}`,
          source.workflowId,
          USER_ID,
          index < 307 ? "running" : "completed",
          parent === null ? null : `${prefix}${parent}`,
          now + index,
          now + index,
          now + index,
        );
      }
    })();
    try {
      const repository = new ExecutionOverviewRepository(sqlite);
      const measured = cpuTimeMs(() =>
        repository.page({
          userId: USER_ID,
          status: "active",
          search: prefix,
          sort: "activity",
          limit: 300,
          offset: 0,
        }),
      );
      expect(measured.result.total).toBe(237);
      expect(measured.result.roots).toHaveLength(237);
      expect(measured.result.nodes).toHaveLength(307);
      expect(measured.result.nodes.filter((node) => node.matches)).toHaveLength(307);
      expect(measured.cpuMs).toBeLessThan(500);
      expect(
        repository.page({
          userId: USER_ID,
          status: "active",
          search: prefix,
          sort: "activity",
          limit: 50,
          offset: 237,
        }),
      ).toEqual({ total: 237, roots: [], nodes: [] });
    } finally {
      sqlite.prepare("DELETE FROM workflowExecution WHERE executionId LIKE ?").run(`${prefix}%`);
    }
  });
});
