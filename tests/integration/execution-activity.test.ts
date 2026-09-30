import { afterEach, beforeAll, describe, expect, test } from "@jest/globals";
import { readFileSync } from "node:fs";
import {
  executionActivity,
  ExecutionRepository,
  getDatabase,
  getLockService,
  getSqliteInstance,
  getWorkflowService,
  metadataRevision,
  user,
} from "@mcp-moira/shared";
import {
  adjustmentVisit,
  DatabaseRepository,
  ExecutionMutationCoordinator,
  workflowGraphDigest,
  type WorkflowGraph,
} from "@mcp-moira/workflow-engine";
import { MCPEngine } from "../../packages/mcp-server/src/core/mcp-engine.js";
import { requestContext } from "../../packages/mcp-server/src/core/request-context.js";
import { getSessionInfo } from "../../packages/mcp-server/src/tools/get-session-info.js";

/**
 * `lastActivityAt` and `refusalCount` are stored by every writer that changes what they are derived
 * from, and by no other. Each case plants a sentinel in the stored column and reads the stored row
 * after the write: a writer that should move the column stores exactly the derivation of the facts
 * it stored, one that should not leaves the sentinel.
 */

const USER_ID = "execution-activity-user";
const SENTINEL = 1;

type Engine = ReturnType<typeof MCPEngine.getInstance>;

function graph(name: string): WorkflowGraph {
  return {
    metadata: { name, version: "1.0.0", description: "Activity test" },
    variableRegistry: {
      target: { type: "string", description: "Where the release goes" },
    },
    nodes: [
      { type: "start", id: "start", connections: { default: "draft" } },
      {
        type: "agent-directive",
        id: "draft",
        directive: "Draft the release notes",
        completionCondition: "Drafted",
        connections: { success: "review" },
      },
      {
        type: "agent-directive",
        id: "review",
        directive: "Review the release notes",
        completionCondition: "Reviewed",
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

interface StoredRow {
  lastActivityAt: number | null;
  refusalCount: number;
  visits: string;
  errors: string | null;
  completedAt: number | null;
}

function stored(executionId: string): StoredRow {
  const row = getSqliteInstance()
    .prepare(
      "SELECT lastActivityAt, refusalCount, visits, errors, completedAt FROM workflowExecution WHERE executionId = ?",
    )
    .get(executionId) as StoredRow | undefined;
  if (!row) throw new Error(`Execution ${executionId} is not stored`);
  return row;
}

/** What the stored facts say the two columns must be. */
function derived(row: StoredRow) {
  return executionActivity({
    visits: JSON.parse(row.visits),
    completedAt: row.completedAt,
    errors: row.errors ? JSON.parse(row.errors) : [],
  });
}

function plant(executionId: string, column: "lastActivityAt" | "refusalCount"): void {
  getSqliteInstance()
    .prepare(`UPDATE workflowExecution SET ${column} = ? WHERE executionId = ?`)
    .run(SENTINEL, executionId);
}

function attemptIdOf(presentation: string): string {
  return presentation.match(/Step attempt ID:\s*([a-f0-9-]+)/i)![1];
}

async function saveWorkflow(name: string) {
  const repository = new DatabaseRepository();
  const saved = await getWorkflowService().save({
    graph: graph(name),
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

describe("the stored activity columns follow the writes that change their facts", () => {
  beforeAll(async () => {
    await createUser(USER_ID);
  });

  afterEach(() => MCPEngine.resetInstance());

  test("a start stores both from the start's own facts", async () => {
    const { engine, workflow } = await saveWorkflow("activity-start");
    const { executionId } = await startRun(engine, workflow);
    const row = stored(executionId);
    expect(row.lastActivityAt).not.toBeNull();
    expect({ lastActivityAt: row.lastActivityAt, refusalCount: row.refusalCount }).toEqual(
      derived(row),
    );
  });

  test.each([
    [
      "an agent step",
      async ({ engine, executionId, presentation }: Moved) => {
        await engine.executor.executeStep(executionId, {}, undefined, {
          userId: USER_ID,
          attemptId: attemptIdOf(presentation),
        });
      },
    ],
    [
      "a run-page answer",
      async ({ engine, executionId }: Moved) => {
        await engine.executor.executeStep(executionId, {}, undefined, {
          userId: USER_ID,
          answeredBy: { role: "user", userId: USER_ID },
          createPresentation: true,
        });
      },
    ],
    [
      "a variable the agent sets",
      async ({ repository, executionId }: Moved) => {
        const run = (await repository.getExecution(executionId))!;
        await repository.updateExecutionContext(
          executionId,
          { variables: { target: "staging" } },
          run.revision,
          metadataRevision(run.globalContext),
          adjustmentVisit(run, { target: "staging" }, { role: "agent", userId: USER_ID }),
        );
      },
    ],
    [
      "a variable a person sets on the run page",
      async ({ repository, executionId }: Moved) => {
        const run = (await repository.getExecution(executionId))!;
        await repository.updateExecutionContext(
          executionId,
          { variables: { target: "production" } },
          run.revision,
          metadataRevision(run.globalContext),
          adjustmentVisit(run, { target: "production" }, { role: "user", userId: USER_ID }),
        );
      },
    ],
    [
      "a recovery",
      async ({ repository, workflow, executionId }: Moved) => {
        await repository.saveWorkflow(
          {
            ...workflow,
            nodes: workflow.nodes.map((node) =>
              node.id === "draft" ? { ...node, directive: "Draft something else" } : node,
            ),
          },
          USER_ID,
        );
        const result = await requestContext.run({ userId: USER_ID }, () =>
          getSessionInfo({ action: "recover", executionId, nodeId: "review" }),
        );
        expect(result.success).toBe(true);
      },
    ],
    [
      "a cancellation",
      async ({ engine, executionId }: Moved) => {
        await engine.executor.cancelExecution(executionId);
        expect(stored(executionId).completedAt).not.toBeNull();
      },
    ],
  ])("%s moves lastActivityAt to what the stored facts derive", async (name, act) => {
    const setup = await saveWorkflow(`activity-moves-${name}`);
    const run = await startRun(setup.engine, setup.workflow);
    plant(run.executionId, "lastActivityAt");
    await act({ ...setup, ...run });
    const row = stored(run.executionId);
    expect(row.lastActivityAt).toBe(derived(row).lastActivityAt);
    expect(row.lastActivityAt).toBeGreaterThan(SENTINEL);
  });

  test("a cancellation of a run whose start outcome is unknown moves it to the cancellation", async () => {
    const { repository, engine, workflow } = await saveWorkflow("activity-cancel-start");
    const prepared = await new ExecutionMutationCoordinator(repository).prepareStart(
      USER_ID,
      workflow,
      { note: null, parentExecutionId: null, skipNotificationCheck: true },
    );
    const claim = await repository.claimStartExecutionAttempt({
      attemptId: prepared.attemptId,
      userId: USER_ID,
      workflowId: workflow.id!,
      workflowVersion: workflow.metadata.version,
      workflowDigest: workflowGraphDigest(workflow),
      ownerId: "activity-cancel-start-owner",
      now: 1_000,
      leaseMs: 30_000,
      execution: engine.executor.createWorkflowExecution(
        workflow,
        undefined,
        USER_ID,
        undefined,
        undefined,
        prepared.reservedExecutionId,
      ),
    });
    if (claim.kind !== "claimed") throw new Error(`Start was not claimed: ${claim.kind}`);
    await repository.markExecutionAttemptOutcomeUnknown(
      prepared.attemptId,
      "activity-cancel-start-owner",
      claim.fence,
      2_000,
    );
    const executionId = prepared.reservedExecutionId;
    plant(executionId, "lastActivityAt");
    const before = (await repository.getExecution(executionId))!;
    expect(
      await repository.cancelExecutionWithStartAttempt(executionId, USER_ID, before.revision, {
        timestamp: 3_000,
        nodeId: "start",
        errorType: "system",
        message: "Cancelled",
      }),
    ).toBe(true);
    const row = stored(executionId);
    expect(row.lastActivityAt).toBe(derived(row).lastActivityAt);
    expect(row.lastActivityAt).toBeGreaterThanOrEqual(3_000);
    expect(row.refusalCount).toBe(1);
  });

  test.each([
    [
      "a note",
      async ({ repository, executionId }: Moved) => {
        await repository.updateExecutionNote(executionId, "Release 4.2");
      },
    ],
    [
      "a reminder",
      async ({ repository, executionId }: Moved) => {
        const run = (await repository.getExecution(executionId))!;
        await repository.mutateExecutionReminder(
          executionId,
          USER_ID,
          run.revision,
          metadataRevision(run.reminders ?? []),
          { action: "add", text: "Tell the team" },
        );
      },
    ],
    [
      "a new parent",
      async ({ repository, engine, workflow, executionId }: Moved) => {
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
      "a journal entry",
      async ({ repository, executionId }: Moved) => {
        await repository.appendError(executionId, {
          timestamp: Date.now(),
          nodeId: "draft",
          errorType: "validation",
          message: "The answer did not match the schema",
        });
      },
    ],
    [
      "a lock",
      async ({ executionId }: Moved) => {
        await getLockService().createLock({
          executionId,
          nodeId: "draft",
          reason: "Confirm the release",
          lockedBy: USER_ID,
        });
      },
    ],
    [
      "the agent's question",
      async ({ executionId }: Moved) => {
        const result = await requestContext.run({ userId: USER_ID }, () =>
          getSessionInfo({ action: "await-user", executionId, question: "Ship on Friday?" }),
        );
        expect(result.success).toBe(true);
      },
    ],
  ])("%s leaves lastActivityAt alone", async (name, act) => {
    const setup = await saveWorkflow(`activity-stays-${name}`);
    const run = await startRun(setup.engine, setup.workflow);
    plant(run.executionId, "lastActivityAt");
    await act({ ...setup, ...run });
    expect(stored(run.executionId).lastActivityAt).toBe(SENTINEL);
  });

  test("refusals are counted as the journal grows and reset with it; degradations do not count", async () => {
    const { repository, engine, workflow } = await saveWorkflow("activity-refusals");
    const { executionId } = await startRun(engine, workflow);
    const entry = (errorType: "validation" | "degradation") => ({
      timestamp: Date.now(),
      nodeId: "draft",
      errorType,
      message: errorType === "validation" ? "Refused" : "Accepted without behaviour text",
    });
    await repository.appendError(executionId, entry("validation"));
    expect(stored(executionId).refusalCount).toBe(1);
    await repository.appendError(executionId, entry("degradation"));
    expect(stored(executionId).refusalCount).toBe(1);
    await repository.appendError(executionId, entry("validation"));
    expect(stored(executionId).refusalCount).toBe(2);

    await new ExecutionRepository(getDatabase()).clearErrors(executionId);
    expect(stored(executionId).refusalCount).toBe(0);

    plant(executionId, "refusalCount");
    await engine.executor.cancelExecution(executionId);
    // The cancellation's own entry is the journal's one refusal now.
    expect(stored(executionId).refusalCount).toBe(derived(stored(executionId)).refusalCount);
    expect(stored(executionId).refusalCount).toBe(1);
  });

  test("the migration fills existing rows with the same formula", async () => {
    const { repository, engine, workflow } = await saveWorkflow("activity-backfill");
    const finished = await startRun(engine, workflow);
    await engine.executor.executeStep(finished.executionId, {}, undefined, {
      userId: USER_ID,
      attemptId: attemptIdOf(finished.presentation),
    });
    await repository.appendError(finished.executionId, {
      timestamp: Date.now(),
      nodeId: "review",
      errorType: "validation",
      message: "Refused",
    });
    await engine.executor.cancelExecution(finished.executionId);
    const fresh = await startRun(engine, workflow);
    const ids = [finished.executionId, fresh.executionId];
    const expected = ids.map((id) => derived(stored(id)));

    // A row written before the columns existed: forget them, then run the migration's fill.
    const sqlite = getSqliteInstance();
    const forget = sqlite.prepare(
      "UPDATE workflowExecution SET lastActivityAt = NULL, refusalCount = 0 WHERE executionId = ?",
    );
    for (const id of ids) forget.run(id);
    const migration = readFileSync(
      "packages/web-backend/drizzle/0047_execution_activity.sql",
      "utf8",
    );
    const fill = migration
      .split("--> statement-breakpoint")
      .map((statement) => statement.trim())
      .find((statement) => statement.startsWith("UPDATE"))!;
    sqlite.exec(fill);

    expect(
      ids
        .map((id) => stored(id))
        .map(({ lastActivityAt, refusalCount }) => ({
          lastActivityAt,
          refusalCount,
        })),
    ).toEqual(expected);
    expect(expected[0].refusalCount).toBe(2);
  });
});

interface Moved {
  repository: DatabaseRepository;
  engine: Engine;
  workflow: WorkflowGraph;
  executionId: string;
  presentation: string;
}
