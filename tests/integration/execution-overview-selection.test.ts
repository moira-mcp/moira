import { afterEach, beforeAll, describe, expect, jest, test } from "@jest/globals";
import {
  ExecutionOverviewRepository,
  ExecutionRepository,
  ExecutionNotificationRepository,
  WorkflowRepository,
  getDatabase,
  getSqliteInstance,
  getWorkflowService,
  metadataRevision,
  user,
} from "@mcp-moira/shared";
import { resolveOverviewQuery } from "@mcp-moira/shared/execution-management";
import {
  overviewPage,
  type OverviewRun,
} from "../../packages/web-backend/src/services/execution-overview.js";
import {
  DatabaseRepository,
  InMemoryRepository,
  type WorkflowGraph,
} from "@mcp-moira/workflow-engine";
import { MCPEngine } from "../../packages/mcp-server/src/core/mcp-engine.js";
import { requestContext } from "../../packages/mcp-server/src/core/request-context.js";
import { getSessionInfo } from "../../packages/mcp-server/src/tools/get-session-info.js";

const OWNER = "overview-selection-owner";
const OTHER = "overview-selection-other";
const NOW = Date.UTC(2026, 9, 3, 10, 50);
const DAY = 86_400_000;
const PREFIX = "selection-";
let workflowId: string;
const definition: WorkflowGraph = {
  metadata: { name: "Selection flow", version: "1.0.0", description: "Current work selection" },
  nodes: [
    { id: "start", type: "start", connections: { default: "work" } },
    {
      id: "work",
      type: "agent-directive",
      directive: "Work",
      completionCondition: "Done",
      connections: { success: "end" },
    },
    { id: "end", type: "end" },
  ],
};
function insert(
  id: string,
  options: {
    parent?: string;
    owner?: string;
    created?: number | null;
    activity?: number | null;
    status?: string;
    stopReason?: string;
    note?: string;
  } = {},
) {
  getSqliteInstance()
    .prepare(
      `INSERT INTO workflowExecution
    (executionId,workflowId,userId,state,parentExecutionId,createdAt,updatedAt,lastActivityAt,stopReason,note,context)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      PREFIX + id,
      workflowId,
      options.owner ?? OWNER,
      options.status ?? "running",
      options.parent ? PREFIX + options.parent : null,
      options.created === undefined ? NOW - DAY : options.created,
      NOW,
      options.activity === undefined ? NOW : options.activity,
      options.stopReason ?? null,
      options.note ?? "Selection",
      JSON.stringify({
        variables: {},
        nodeStates: {},
        executionId: PREFIX + id,
        workflowId,
        userId: options.owner ?? OWNER,
      }),
    );
}
function dependencies() {
  const db = getDatabase();
  return {
    overview: new ExecutionOverviewRepository(getSqliteInstance()),
    executions: new ExecutionRepository(db),
    workflows: new WorkflowRepository(db),
    notifications: new ExecutionNotificationRepository(db),
    now: () => NOW,
  };
}
function query(input: Parameters<typeof resolveOverviewQuery>[0] = { userId: OWNER }) {
  return resolveOverviewQuery({ ...input, userId: OWNER, limit: 100 }, NOW);
}

describe("current owned work before exact pagination", () => {
  beforeAll(async () => {
    for (const id of [OWNER, OTHER])
      await getDatabase()
        .insert(user)
        .values({
          id,
          email: `${id}@example.test`,
          handle: id,
          createdAt: new Date(NOW).toISOString(),
          updatedAt: new Date(NOW).toISOString(),
        })
        .onConflictDoNothing();
    workflowId = (
      await getWorkflowService().save({ graph: definition, userId: OWNER, visibility: "private" })
    ).id;
  });
  afterEach(() => {
    jest.restoreAllMocks();
    MCPEngine.resetInstance();
    getSqliteInstance()
      .prepare("DELETE FROM workflowExecution WHERE executionId LIKE ?")
      .run(`${PREFIX}%`);
  });

  test("real naming activity refreshes old work, while note bookkeeping does not; the seven-day boundary is inclusive", async () => {
    insert("renamed", { created: NOW - 40 * DAY, activity: NOW - 30 * DAY });
    insert("bookkeeping", { created: NOW - 40 * DAY, activity: NOW - 30 * DAY });
    insert("boundary", { activity: NOW - 7 * DAY });
    insert("outside", { activity: NOW - 7 * DAY - 1 });
    jest.spyOn(Date, "now").mockReturnValue(NOW);
    const repository = new ExecutionRepository(getDatabase());
    await repository.updateExecutionTaskTitle(
      PREFIX + "renamed",
      OWNER,
      0,
      metadataRevision(null),
      "Current import task",
    );
    await repository.updateNote(PREFIX + "bookkeeping", "Polling and notes changed today");
    const page = await overviewPage(query(), dependencies());
    expect(page.runs.map((row) => row.executionId).sort()).toEqual([
      PREFIX + "boundary",
      PREFIX + "renamed",
    ]);
    expect(page.runs.find((row) => row.executionId === PREFIX + "renamed")?.createdAt).toBe(
      NOW - 40 * DAY,
    );
    expect(page.evaluatedAt).toBe(NOW);
    expect(page.effectiveTime).toEqual({ kind: "period", period: "7d" });
  });

  test("an old stopped parent is only context for fresh work, unrelated siblings are pruned and all-child facts stay separate", async () => {
    insert("parent", {
      created: NOW - 40 * DAY,
      activity: NOW - 30 * DAY,
      status: "completed",
      stopReason: "Changed scope",
    });
    insert("fresh", { parent: "parent", created: NOW - 20 * DAY });
    insert("old-sibling", { parent: "parent", activity: NOW - 30 * DAY });
    const page = await overviewPage(query(), dependencies());
    expect(page.total).toBe(1);
    const [parent] = page.runs;
    expect(parent).toMatchObject({
      executionId: PREFIX + "parent",
      status: "stopped",
      matches: false,
      children: { total: 1, unfinished: 1 },
      childrenTotal: { total: 2, unfinished: 2 },
      subtreeActivityAt: NOW,
    });
    expect(parent.childRuns.map((row) => [row.executionId, row.matches])).toEqual([
      [PREFIX + "fresh", true],
    ]);
    expect(dependencies().overview.page({ ...query(), offset: 1 })).toEqual({
      total: 1,
      roots: [],
      nodes: [],
    });
  });

  test("filtered-out fresh descendants affect group idleness without lifting visible freshness", () => {
    insert("parent", { activity: NOW - 2 * DAY, note: "target" });
    insert("excluded-child", { parent: "parent", note: "other" });
    const overview = dependencies().overview;
    const visible = overview.page(query({ userId: OWNER, search: "target" }));
    expect(visible.nodes).toHaveLength(1);
    expect(visible.nodes[0]).toMatchObject({
      subtreeActivityAt: NOW - 2 * DAY,
      idleActivityAt: NOW,
    });
    expect(overview.page(query({ userId: OWNER, search: "target", idle: "1d" })).total).toBe(0);
  });

  test("same-hour roots and siblings use creation and ID; only a newer UTC hour moves an existing row", async () => {
    insert("newer-creation", { created: NOW - DAY, activity: NOW - 20 * 60_000 });
    insert("newer-milliseconds", { created: NOW - 2 * DAY, activity: NOW - 100 });
    const overview = dependencies().overview;
    const first = overview.page(query());
    expect(first.roots).toEqual([PREFIX + "newer-creation", PREFIX + "newer-milliseconds"]);
    getSqliteInstance()
      .prepare("UPDATE workflowExecution SET lastActivityAt=? WHERE executionId=?")
      .run(NOW + 60_000, PREFIX + "newer-milliseconds");
    expect(overview.page(query()).roots).toEqual(first.roots);
    getSqliteInstance()
      .prepare("UPDATE workflowExecution SET lastActivityAt=? WHERE executionId=?")
      .run(Date.UTC(2026, 9, 3, 11), PREFIX + "newer-milliseconds");
    expect(overview.page(query()).roots[0]).toBe(PREFIX + "newer-milliseconds");
    insert("parent", { activity: NOW - 30 * DAY });
    insert("b", { parent: "parent", created: NOW - DAY, activity: NOW - 100 });
    insert("a", { parent: "parent", created: NOW - DAY, activity: NOW - 20 * 60_000 });
    const page = await overviewPage(query(), dependencies());
    expect(
      page.runs
        .find((row) => row.executionId === PREFIX + "parent")
        ?.childRuns.map((row) => row.executionId),
    ).toEqual([PREFIX + "a", PREFIX + "b"]);
  });

  test("unknown dates stay null in all-time projection and never become recent by bookkeeping timestamps", async () => {
    insert("unknown", { created: null, activity: null });
    expect((await overviewPage(query(), dependencies())).total).toBe(0);
    const page = await overviewPage(query({ userId: OWNER, period: "all" }), dependencies());
    expect(page.runs[0]).toMatchObject({ createdAt: null, lastActivityAt: null });
  });

  test("a stored intentional-stop marker is terminal in the published capability even on a legacy active raw row", async () => {
    insert("legacy-stopped", { status: "running", stopReason: "" });
    const page = await overviewPage(query({ userId: OWNER, status: "stopped" }), dependencies());
    expect(page.total).toBe(1);
    expect(page.runs[0]).toMatchObject({
      executionId: PREFIX + "legacy-stopped",
      status: "stopped",
      stopReason: "",
      stopCapability: { available: false, revision: 0, reason: "terminal" },
    });
  });

  test("the public title action refuses the same legacy marked row the overview publishes as stopped", async () => {
    insert("legacy-stopped", { status: "running", stopReason: "" });
    const database = new DatabaseRepository();
    MCPEngine.getInstance(database);
    const before = await database.getExecution(PREFIX + "legacy-stopped");
    const result = await requestContext.run({ userId: OWNER }, () =>
      getSessionInfo({
        action: "update-task-title",
        executionId: PREFIX + "legacy-stopped",
        taskTitle: "Rename terminal work",
        expectedRevision: 0,
        expectedTaskIdentityRevision: metadataRevision(null),
      }),
    );
    const stored = (await database.getExecution(PREFIX + "legacy-stopped"))!;
    expect({
      success: result.success,
      title: stored.taskIdentity?.title ?? null,
      stopReason: stored.stopReason,
      rawStatus: stored.status,
      revision: stored.revision,
    }).toEqual({
      success: false,
      title: null,
      stopReason: "",
      rawStatus: "running",
      revision: 0,
    });
    expect(stored).toEqual(before);
  });

  test("the in-memory naming guard refuses the same stopped marker without changing identity or activity", async () => {
    insert("legacy-stopped", { status: "running", stopReason: "" });
    const database = new DatabaseRepository();
    const memory = new InMemoryRepository();
    await memory.saveExecution((await database.getExecution(PREFIX + "legacy-stopped"))!);
    const before = await memory.getExecution(PREFIX + "legacy-stopped");
    await expect(
      memory.updateExecutionTaskTitle(
        PREFIX + "legacy-stopped",
        OWNER,
        0,
        metadataRevision(null),
        "Rename terminal work",
      ),
    ).rejects.toThrow("Only active executions accept task title changes");
    expect(await memory.getExecution(PREFIX + "legacy-stopped")).toEqual(before);
  });

  test.each(["sql", "memory"])(
    "%s stop refuses a legacy marked active row without overwriting its recorded reason or state",
    async (storage) => {
      insert("legacy-terminal", { status: "running", stopReason: "" });
      const database = new DatabaseRepository();
      const original = (await database.getExecution(PREFIX + "legacy-terminal"))!;
      const repository = storage === "sql" ? database : new InMemoryRepository();
      if (storage === "memory") await repository.saveExecution(original);
      const beforeStop = await repository.getExecution(original.executionId);
      expect(beforeStop).toMatchObject({ status: "running", stopReason: "", revision: 0 });
      await expect(
        repository.stopExecution(
          original.executionId,
          OWNER,
          original.revision,
          "Overwrite history",
        ),
      ).rejects.toMatchObject({
        statusCode: 409,
        context: {
          stopRefusal: "terminal",
          stopCapability: { available: false, revision: 0, reason: "terminal" },
        },
      });
      expect(await repository.getExecution(original.executionId)).toEqual(beforeStop);
    },
  );

  test("valid ancestry deeper than32 retains every required ancestor and one exact root", () => {
    for (let index = 0; index < 80; index++)
      insert(`deep-${index}`, {
        parent: index ? `deep-${index - 1}` : undefined,
        activity: index === 79 ? NOW : NOW - 30 * DAY,
      });
    const page = dependencies().overview.page(query());
    expect(page.total).toBe(1);
    expect(page.roots).toEqual([PREFIX + "deep-0"]);
    expect(page.nodes).toHaveLength(80);
    expect(page.nodes.filter((row) => row.matches).map((row) => row.executionId)).toEqual([
      PREFIX + "deep-79",
    ]);
    expect(page.nodes.find((row) => row.executionId === PREFIX + "deep-79")?.depth).toBe(79);
  });

  test("self and multi-node cycles retain eligible work under deterministic cut roots, while missing/foreign parents end owner paths", async () => {
    insert("self", { parent: "self" });
    insert("cycle-a", { parent: "cycle-b" });
    insert("cycle-b", { parent: "cycle-c", activity: NOW - 30 * DAY });
    insert("cycle-c", { parent: "cycle-a", activity: NOW - 30 * DAY });
    insert("missing", { parent: "absent" });
    insert("foreign-parent", { owner: OTHER });
    insert("foreign-child", { parent: "foreign-parent" });
    const page = dependencies().overview.page(query());
    expect(page.total).toBe(4);
    expect(page.roots.sort()).toEqual(
      ["cycle-a", "foreign-child", "missing", "self"].map((id) => PREFIX + id),
    );
    expect(
      page.nodes
        .filter((row) => row.matches)
        .map((row) => row.executionId)
        .sort(),
    ).toEqual(["cycle-a", "foreign-child", "missing", "self"].map((id) => PREFIX + id));
    expect(page.nodes).toHaveLength(6);
    expect(
      page.nodes.find((row) => row.executionId === PREFIX + "cycle-a")?.parentExecutionId,
    ).toBeNull();
    expect(
      getSqliteInstance()
        .prepare("SELECT parentExecutionId FROM workflowExecution WHERE executionId=?")
        .get(PREFIX + "cycle-a"),
    ).toEqual({ parentExecutionId: PREFIX + "cycle-b" });
    expect(page.nodes.map((row) => row.executionId)).not.toContain(PREFIX + "foreign-parent");
    const displayed = await overviewPage(query(), dependencies());
    const flatten = (runs: OverviewRun[]): OverviewRun[] =>
      runs.flatMap((run) => [run, ...flatten(run.childRuns)]);
    expect(flatten(displayed.runs)).toHaveLength(6);
    expect(displayed.runs.find((run) => run.executionId === PREFIX + "cycle-a")).toMatchObject({
      parentExecutionId: PREFIX + "cycle-b",
      parent: null,
    });
    expect(displayed.runs.find((run) => run.executionId === PREFIX + "self")).toMatchObject({
      parentExecutionId: PREFIX + "self",
      parent: null,
    });
  });
});
