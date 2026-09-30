import { afterAll, afterEach, beforeAll, describe, expect, test } from "@jest/globals";
import Database from "better-sqlite3";
import {
  deleteUserAccount,
  ExecutionChangeRepository,
  ExecutionRepository,
  getDatabase,
  getLockService,
  getSqliteInstance,
  getWorkflowService,
  metadataRevision,
  user,
  WorkflowReconciliationRepository,
} from "@mcp-moira/shared";
import {
  adjustmentVisit,
  DatabaseRepository,
  type WorkflowGraph,
} from "@mcp-moira/workflow-engine";
import { MCPEngine } from "../../packages/mcp-server/src/core/mcp-engine.js";
import { requestContext } from "../../packages/mcp-server/src/core/request-context.js";
import { getSessionInfo } from "../../packages/mcp-server/src/tools/get-session-info.js";
import { startWorkflow } from "../../packages/mcp-server/src/tools/start-workflow.js";

/**
 * Every writer of an execution row records its change in the feed inside its own transaction, and
 * every way a run can disappear records `deleted` first. The feed is read here through a second,
 * read-only connection to the same database — as the web backend reads what the MCP server wrote.
 */

const USER_ID = "execution-change-feed-user";

type Engine = ReturnType<typeof MCPEngine.getInstance>;

function graph(name: string, gated = false): WorkflowGraph {
  return {
    metadata: { name, version: "1.0.0", description: "Change feed test" },
    variableRegistry: {
      target: { type: "string", description: "Where the orders go" },
    },
    nodes: [
      { type: "start", id: "start", connections: { default: "draft" } },
      {
        type: "agent-directive",
        id: "draft",
        directive: "Map the order columns",
        completionCondition: "Mapped",
        connections: { success: "approve" },
      },
      {
        type: "agent-directive",
        id: "approve",
        directive: "Show the mapping and wait for the decision",
        completionCondition: "Decided",
        ...(gated ? { humanGate: { label: "Approve the mapping" } } : {}),
        connections: { success: "end" },
      },
      { type: "end", id: "end" },
    ],
  };
}

async function createUser(id: string): Promise<void> {
  const now = new Date().toISOString();
  await getDatabase()
    .insert(user)
    .values({ id, email: `${id}@example.test`, handle: id, createdAt: now, updatedAt: now })
    .onConflictDoNothing();
}

let reader: Database.Database;
let feed: ExecutionChangeRepository;

/** The kinds recorded for a run after `seq`, oldest first, read on the second connection. */
function kindsAfter(executionId: string, seq: number): string[] {
  return (
    reader
      .prepare("SELECT kind FROM executionChange WHERE executionId = ? AND seq > ? ORDER BY seq")
      .all(executionId, seq) as Array<{ kind: string }>
  ).map((row) => row.kind);
}

async function saveWorkflow(name: string, gated = false) {
  const repository = new DatabaseRepository();
  const saved = await getWorkflowService().save({
    graph: graph(name, gated),
    userId: USER_ID,
    visibility: "private",
  });
  const workflow = (await repository.getWorkflowGraph(saved.id, USER_ID))!;
  return { repository, workflow, engine: MCPEngine.getInstance(repository) };
}

async function startRun(engine: Engine, workflow: WorkflowGraph) {
  const executionId = await engine.executor.startWorkflow(workflow, {}, USER_ID);
  const presentation = await engine.executor.executeStep(executionId, undefined, undefined, {
    userId: USER_ID,
    createPresentation: true,
  });
  return { executionId, presentation };
}

function attemptIdOf(presentation: string): string {
  return presentation.match(/Step attempt ID:\s*([a-f0-9-]+)/i)![1];
}

interface Setup {
  repository: DatabaseRepository;
  engine: Engine;
  workflow: WorkflowGraph;
  executionId: string;
  presentation: string;
}

describe("the change feed records every write of a run", () => {
  beforeAll(async () => {
    await createUser(USER_ID);
    reader = new Database(getSqliteInstance().name, { readonly: true });
    feed = new ExecutionChangeRepository(reader);
  });

  afterAll(() => {
    reader.close();
  });
  afterEach(() => MCPEngine.resetInstance());

  test("a start records the run as created", async () => {
    const { engine, workflow } = await saveWorkflow("feed-start");
    const before = feed.latestSeq();
    const executionId = await engine.executor.startWorkflow(workflow, {}, USER_ID);
    expect(kindsAfter(executionId, before)[0]).toBe("created");
  });

  test("a start through MCP records the run as created", async () => {
    const { workflow } = await saveWorkflow("feed-mcp-start");
    const before = feed.latestSeq();
    const prepared = await requestContext.run({ userId: USER_ID }, () =>
      startWorkflow({
        action: "prepare",
        workflowId: workflow.id!,
        parentExecutionId: "none",
        skipNotificationCheck: true,
      }),
    );
    const startAttemptId = prepared.data!.match(/Start attempt ID:\s*([a-f0-9-]+)/i)![1];
    const started = await requestContext.run({ userId: USER_ID }, () =>
      startWorkflow({ action: "execute", startAttemptId }),
    );
    const executionId = started.data!.match(/Process ID:\s*([a-f0-9-]+)/i)![1];
    expect(kindsAfter(executionId, before)[0]).toBe("created");
  });

  test.each([
    [
      "an agent step",
      "activity",
      async ({ engine, executionId, presentation }: Setup) => {
        await engine.executor.executeStep(executionId, {}, undefined, {
          userId: USER_ID,
          attemptId: attemptIdOf(presentation),
        });
      },
    ],
    [
      "a run-page answer",
      "activity",
      async ({ engine, executionId }: Setup) => {
        await engine.executor.executeStep(executionId, {}, undefined, {
          userId: USER_ID,
          answeredBy: { role: "user", userId: USER_ID },
          createPresentation: true,
        });
      },
    ],
    [
      "a variable set on the run",
      "activity",
      async ({ repository, executionId }: Setup) => {
        const run = (await repository.getExecution(executionId))!;
        await repository.updateExecutionContext(
          executionId,
          { variables: { target: "staging" } },
          run.revision,
          metadataRevision(run.globalContext),
          adjustmentVisit(run, { target: "staging" }, { role: "user", userId: USER_ID }),
        );
      },
    ],
    [
      "a recovery",
      "activity",
      async ({ repository, workflow, executionId }: Setup) => {
        await repository.saveWorkflow(
          {
            ...workflow,
            nodes: workflow.nodes.map((node) =>
              node.id === "draft" ? { ...node, directive: "Map other columns" } : node,
            ),
          },
          USER_ID,
        );
        const result = await requestContext.run({ userId: USER_ID }, () =>
          getSessionInfo({ action: "recover", executionId, nodeId: "approve" }),
        );
        expect(result.success).toBe(true);
      },
    ],
    [
      "a cancellation",
      "status",
      async ({ engine, executionId }: Setup) => {
        await engine.executor.cancelExecution(executionId);
      },
    ],
    [
      "a note",
      "meta",
      async ({ repository, executionId }: Setup) => {
        await repository.updateExecutionNote(executionId, "Import March orders");
      },
    ],
    [
      "a new parent",
      "meta",
      async ({ repository, engine, workflow, executionId }: Setup) => {
        const parent = await startRun(engine, workflow);
        const run = (await repository.getExecution(executionId))!;
        await repository.setExecutionParent(
          executionId,
          parent.executionId,
          USER_ID,
          run.revision,
          metadataRevision(run.parentExecutionId ?? null),
        );
      },
    ],
    [
      "a reminder",
      "meta",
      async ({ repository, executionId }: Setup) => {
        const run = (await repository.getExecution(executionId))!;
        await repository.mutateExecutionReminder(
          executionId,
          USER_ID,
          run.revision,
          metadataRevision(run.reminders ?? []),
          { action: "add", text: "Tell the warehouse" },
        );
      },
    ],
    [
      "a journal entry",
      "status",
      async ({ repository, executionId }: Setup) => {
        await repository.appendError(executionId, {
          timestamp: Date.now(),
          nodeId: "draft",
          errorType: "validation",
          message: "The answer did not match the schema",
        });
      },
    ],
    [
      "the agent's question",
      "status",
      async ({ executionId }: Setup) => {
        const result = await requestContext.run({ userId: USER_ID }, () =>
          getSessionInfo({ action: "await-user", executionId, question: "Which currency?" }),
        );
        expect(result.success).toBe(true);
      },
    ],
  ])("%s records %s", async (name, kind, act) => {
    const setup = await saveWorkflow(`feed-${name}`);
    const run = await startRun(setup.engine, setup.workflow);
    const before = feed.latestSeq();
    await act({ ...setup, ...run });
    expect(kindsAfter(run.executionId, before)).toContain(kind);
  });

  test("a lock and its release each record a lock change", async () => {
    const { engine, workflow } = await saveWorkflow("feed-lock");
    const { executionId } = await startRun(engine, workflow);
    const before = feed.latestSeq();
    const created = await getLockService().createLock({
      executionId,
      nodeId: "draft",
      reason: "Confirm the import",
      lockedBy: USER_ID,
    });
    await getLockService().ownerUnlock(created.lockId, USER_ID);
    expect(kindsAfter(executionId, before)).toEqual(["lock", "lock"]);
  });

  test("clearing the journal records a status change", async () => {
    const { repository, engine, workflow } = await saveWorkflow("feed-clear-errors");
    const { executionId } = await startRun(engine, workflow);
    await repository.appendError(executionId, {
      timestamp: Date.now(),
      nodeId: "draft",
      errorType: "validation",
      message: "Refused",
    });
    const before = feed.latestSeq();
    await new ExecutionRepository(getDatabase()).clearErrors(executionId);
    expect(kindsAfter(executionId, before)).toEqual(["status"]);
  });

  test("a version that marks the step a run stands on records a status change", async () => {
    const { workflow, engine } = await saveWorkflow("feed-version");
    const { executionId, presentation } = await startRun(engine, workflow);
    await engine.executor.executeStep(executionId, {}, undefined, {
      userId: USER_ID,
      attemptId: attemptIdOf(presentation),
    });
    const before = feed.latestSeq();
    const marked = graph("feed-version", true);
    await getWorkflowService().save({
      graph: { ...marked, id: workflow.id, metadata: { ...marked.metadata, version: "1.1.0" } },
      userId: USER_ID,
      visibility: "private",
    });
    expect(kindsAfter(executionId, before)).toEqual(["status"]);
  });

  test("a write refused by its guard records nothing", async () => {
    const { repository, engine, workflow } = await saveWorkflow("feed-refused");
    const { executionId } = await startRun(engine, workflow);
    const run = (await repository.getExecution(executionId))!;
    const before = feed.latestSeq();
    await expect(
      repository.updateExecutionContext(
        executionId,
        { variables: { target: "staging" } },
        run.revision + 1,
        metadataRevision(run.globalContext),
      ),
    ).rejects.toThrow();
    expect(kindsAfter(executionId, before)).toEqual([]);
  });
});

describe("every way a run disappears records it as deleted first", () => {
  beforeAll(async () => {
    await createUser(USER_ID);
    reader = new Database(getSqliteInstance().name, { readonly: true });
    feed = new ExecutionChangeRepository(reader);
  });

  afterAll(() => {
    reader.close();
  });
  afterEach(() => MCPEngine.resetInstance());

  test("deleting a run", async () => {
    const { engine, workflow } = await saveWorkflow("feed-delete-run");
    const { executionId } = await startRun(engine, workflow);
    const before = feed.latestSeq();
    await new ExecutionRepository(getDatabase()).delete(executionId);
    expect(kindsAfter(executionId, before)).toEqual(["deleted"]);
  });

  test("the retention cleanup", async () => {
    const { engine, workflow } = await saveWorkflow("feed-retention");
    const { executionId } = await startRun(engine, workflow);
    await engine.executor.cancelExecution(executionId);
    const before = feed.latestSeq();
    await new ExecutionRepository(getDatabase()).deleteCompletedOlderThan(
      new Date(Date.now() + 60_000),
    );
    expect(kindsAfter(executionId, before)).toEqual(["deleted"]);
  });

  test("a hard delete of the workflow", async () => {
    const { engine, workflow } = await saveWorkflow("feed-hard-delete");
    const { executionId } = await startRun(engine, workflow);
    const before = feed.latestSeq();
    await getWorkflowService().hardDelete(workflow.id!, USER_ID);
    expect(kindsAfter(executionId, before)).toEqual(["deleted"]);
  });

  test("catalog reconciliation removing the workflow", async () => {
    const { engine, workflow } = await saveWorkflow("feed-reconcile-delete");
    const { executionId } = await startRun(engine, workflow);
    const slug = (
      getSqliteInstance().prepare("SELECT slug FROM workflow WHERE id = ?").get(workflow.id) as {
        slug: string;
      }
    ).slug;
    const before = feed.latestSeq();
    new WorkflowReconciliationRepository(getSqliteInstance()).apply({
      preconditions: [],
      conflictPreconditions: [],
      baselinePreconditions: [],
      workflows: [
        { owner: USER_ID, slug, workflowId: workflow.id, state: { lifecycle: "absent" } },
      ],
      baselines: [],
      conflicts: [],
      clearConflicts: [],
    } as unknown as Parameters<WorkflowReconciliationRepository["apply"]>[0]);
    expect(kindsAfter(executionId, before)).toEqual(["deleted"]);
  });

  test("deleting the user, including another user's runs of the user's workflow", async () => {
    const owner = "execution-change-feed-owner";
    await createUser(owner);
    const repository = new DatabaseRepository();
    const saved = await getWorkflowService().save({
      graph: graph("feed-user-delete"),
      userId: owner,
      visibility: "public",
    });
    const workflow = (await repository.getWorkflowGraph(saved.id, owner))!;
    const engine = MCPEngine.getInstance(repository);
    const own = await engine.executor.startWorkflow(workflow, {}, owner);
    const others = await engine.executor.startWorkflow(workflow, {}, USER_ID);
    const before = feed.latestSeq();
    deleteUserAccount(getDatabase(), owner);
    expect(kindsAfter(own, before)).toEqual(["deleted"]);
    expect(kindsAfter(others, before)).toEqual(["deleted"]);
  });
});

describe("a cursor older than what the feed keeps is expired", () => {
  test("once events after a cursor are trimmed, the cursor is expired; a current one is not", () => {
    const sqlite = getSqliteInstance();
    const writer = new ExecutionChangeRepository(sqlite);
    // Trim everything: nothing is kept, and only the latest number is current.
    writer.deleteOlderThan(Number.MAX_SAFE_INTEGER);
    const latest = writer.latestSeq();
    expect(writer.isExpired(latest - 1)).toBe(true);
    expect(writer.isExpired(latest)).toBe(false);
    // A new event: a cursor just before it can still catch up, an older one cannot.
    sqlite
      .prepare(
        "INSERT INTO executionChange (executionId, userId, kind, at) VALUES (?, ?, 'meta', ?)",
      )
      .run("feed-trim-run", USER_ID, Date.now());
    expect(writer.isExpired(latest)).toBe(false);
    expect(writer.isExpired(latest - 1)).toBe(true);
  });

  test("a cursor ahead of the latest event, as after restoring an older database, is expired", () => {
    const writer = new ExecutionChangeRepository(getSqliteInstance());
    expect(writer.isExpired(writer.latestSeq() + 1)).toBe(true);
  });
});
