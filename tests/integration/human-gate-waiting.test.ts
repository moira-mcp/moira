import { afterEach, beforeAll, describe, expect, test } from "@jest/globals";
import {
  getDatabase,
  getSqliteInstance,
  getWorkflowService,
  user,
  WorkflowReconciliationRepository,
} from "@mcp-moira/shared";
import {
  DatabaseRepository,
  ExecutionMutationCoordinator,
  workflowGraphDigest,
  type WorkflowGraph,
} from "@mcp-moira/workflow-engine";
import { MCPEngine } from "../../packages/mcp-server/src/core/mcp-engine.js";
import { requestContext } from "../../packages/mcp-server/src/core/request-context.js";
import { getSessionInfo } from "../../packages/mcp-server/src/tools/get-session-info.js";
import { startWorkflow } from "../../packages/mcp-server/src/tools/start-workflow.js";

/**
 * `gateWaiting` is decided by the engine and stored by every writer of the execution row. These
 * tests read the stored row, not the projection, because the projection could reach the same
 * answer from the graph alone — the stored flag is what list filters and notifications rely on.
 */

const USER_ID = "human-gate-waiting-user";

type Engine = ReturnType<typeof MCPEngine.getInstance>;

type GateOptions = {
  gated?: boolean;
  conditional?: boolean;
  firstStepGated?: boolean;
  requireDecision?: boolean;
  loopOnAgain?: boolean;
};

function graph(name: string, options: GateOptions = {}): WorkflowGraph {
  const {
    gated = true,
    conditional = true,
    firstStepGated = false,
    requireDecision = false,
    loopOnAgain = false,
  } = options;
  const humanGate = gated
    ? {
        label: "Approve the plan",
        ...(conditional
          ? {
              when: {
                operator: "neq" as const,
                left: { contextPath: "operating_mode" },
                right: "autonomous",
              },
            }
          : {}),
      }
    : undefined;
  return {
    metadata: { name, version: "1.0.0", description: "Human gate test" },
    variableRegistry: {
      operating_mode: { type: "string", description: "How the run treats the person" },
    },
    nodes: [
      {
        type: "start",
        id: "start",
        connections: { default: firstStepGated ? "approve" : "draft" },
      },
      {
        type: "agent-directive",
        id: "draft",
        directive: "Draft the plan",
        completionCondition: "Drafted",
        connections: { success: "approve" },
      },
      {
        type: "agent-directive",
        id: "approve",
        directive: "Present the plan and wait for the person's decision",
        completionCondition: "Decided",
        ...(humanGate ? { humanGate } : {}),
        ...(requireDecision
          ? {
              inputSchema: {
                type: "object",
                properties: { decision: { type: "string" } },
                required: ["decision"],
              },
            }
          : {}),
        ...(loopOnAgain
          ? {
              cases: [
                {
                  when: {
                    operator: "eq" as const,
                    left: { contextPath: "approve.decision" },
                    right: "again",
                  },
                  output: "again",
                },
              ],
            }
          : {}),
        connections: loopOnAgain ? { success: "finish", again: "approve" } : { success: "finish" },
      },
      {
        type: "agent-directive",
        id: "finish",
        directive: "Finish the work",
        completionCondition: "Finished",
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

function storedGateWaiting(executionId: string): number {
  const row = getSqliteInstance()
    .prepare("SELECT gateWaiting FROM workflowExecution WHERE executionId = ?")
    .get(executionId) as { gateWaiting: number } | undefined;
  if (!row) throw new Error(`Execution ${executionId} is not stored`);
  return row.gateWaiting;
}

function attemptIdOf(presentation: string): string {
  const value = presentation.match(/Step attempt ID:\s*([a-f0-9-]+)/i)?.[1];
  if (!value) throw new Error(`Missing step attempt: ${presentation}`);
  return value;
}

async function saveWorkflow(name: string, options?: GateOptions) {
  const repository = new DatabaseRepository();
  const saved = await getWorkflowService().save({
    graph: graph(name, options),
    userId: USER_ID,
    visibility: "private",
  });
  const stored = (await repository.getWorkflowGraph(saved.id, USER_ID))!;
  return { repository, stored, engine: MCPEngine.getInstance(repository) };
}

/** Start a run and let the engine present its first step, as the run page answer path does. */
async function startRun(
  engine: Engine,
  stored: WorkflowGraph,
  operatingMode: "interactive" | "autonomous" = "interactive",
) {
  const executionId = await engine.executor.startWorkflow(
    stored,
    { operating_mode: operatingMode },
    USER_ID,
  );
  const presentation = await engine.executor.executeStep(executionId, undefined, undefined, {
    userId: USER_ID,
    createPresentation: true,
  });
  return { executionId, presentation };
}

/** Submit the current step as an agent does: through its step attempt. */
function agentStep(engine: Engine, executionId: string, presentation: string) {
  return engine.executor.executeStep(executionId, {}, undefined, {
    userId: USER_ID,
    attemptId: attemptIdOf(presentation),
  });
}

describe("gateWaiting is stored by every writer of the execution row", () => {
  beforeAll(async () => {
    await createUser(USER_ID);
  });

  afterEach(() => MCPEngine.resetInstance());

  test("an agent step into a gated step sets it and the step that leaves the gate clears it", async () => {
    const { engine, stored } = await saveWorkflow("gate-agent-step");
    const { executionId, presentation } = await startRun(engine, stored);
    expect(storedGateWaiting(executionId)).toBe(0);

    const atGate = await agentStep(engine, executionId, presentation);
    expect(storedGateWaiting(executionId)).toBe(1);

    await agentStep(engine, executionId, atGate);
    expect(storedGateWaiting(executionId)).toBe(0);
  });

  test("a gate whose condition does not hold when the run arrives leaves it unset", async () => {
    const { engine, stored } = await saveWorkflow("gate-autonomous");
    const { executionId, presentation } = await startRun(engine, stored, "autonomous");

    await agentStep(engine, executionId, presentation);
    expect(storedGateWaiting(executionId)).toBe(0);
  });

  test("an unconditional gate waits in any mode", async () => {
    const { engine, stored } = await saveWorkflow("gate-unconditional", { conditional: false });
    const { executionId, presentation } = await startRun(engine, stored, "autonomous");

    await agentStep(engine, executionId, presentation);
    expect(storedGateWaiting(executionId)).toBe(1);
  });

  test("an answer from the run page that moves the run into the gate sets it", async () => {
    const { engine, stored } = await saveWorkflow("gate-web-answer");
    const { executionId } = await startRun(engine, stored);

    await engine.executor.executeStep(executionId, {}, undefined, {
      userId: USER_ID,
      answeredBy: { role: "user", userId: USER_ID },
      createPresentation: true,
    });
    expect(storedGateWaiting(executionId)).toBe(1);
  });

  test("a start whose first step is the gate stores it set", async () => {
    const { stored } = await saveWorkflow("gate-start", { firstStepGated: true });
    const prepared = await requestContext.run({ userId: USER_ID }, () =>
      startWorkflow({
        action: "prepare",
        workflowId: stored.id!,
        parentExecutionId: "none",
        skipNotificationCheck: true,
      }),
    );
    const startAttemptId = prepared.data!.match(/Start attempt ID:\s*([a-f0-9-]+)/i)![1];
    const started = await requestContext.run({ userId: USER_ID }, () =>
      startWorkflow({ action: "execute", startAttemptId }),
    );
    const executionId = started.data!.match(/Process ID:\s*([a-f0-9-]+)/i)![1];

    // No operating mode was given, so the gate's `neq autonomous` condition holds.
    expect(storedGateWaiting(executionId)).toBe(1);
  });

  test("recovering a run onto the gate sets it", async () => {
    const { repository, engine, stored } = await saveWorkflow("gate-recovery");
    const { executionId } = await startRun(engine, stored);
    // Break the run the way a deploy can: change the step it is paused on.
    await repository.saveWorkflow(
      {
        ...stored,
        nodes: stored.nodes.map((node) =>
          node.id === "draft" ? { ...node, directive: "Draft something else" } : node,
        ),
      },
      USER_ID,
    );

    const result = await requestContext.run({ userId: USER_ID }, () =>
      getSessionInfo({ action: "recover", executionId, nodeId: "approve" }),
    );
    expect(result.success).toBe(true);
    expect(storedGateWaiting(executionId)).toBe(1);
  });
});

describe("the decision is taken when the run arrives at the gate", () => {
  beforeAll(async () => {
    await createUser(USER_ID);
  });

  afterEach(() => MCPEngine.resetInstance());

  test("a refused answer on the gate keeps the arrival decision", async () => {
    const { engine, stored } = await saveWorkflow("gate-refused-answer", { requireDecision: true });
    const { executionId, presentation } = await startRun(engine, stored);
    const atGate = await agentStep(engine, executionId, presentation);
    expect(storedGateWaiting(executionId)).toBe(1);
    // The run's variables move after arrival: the gate's condition no longer holds.
    getSqliteInstance()
      .prepare(
        "UPDATE workflowExecution SET context = json_set(context, '$.variables.operating_mode', 'autonomous') WHERE executionId = ?",
      )
      .run(executionId);

    // An answer without the required decision is refused; the run stays on the same open wait.
    await agentStep(engine, executionId, atGate);
    const row = getSqliteInstance()
      .prepare(
        "SELECT currentNodeId, waitingForInputNodeId FROM workflowExecution WHERE executionId = ?",
      )
      .get(executionId) as { currentNodeId: string; waitingForInputNodeId: string };
    expect(row).toEqual({ currentNodeId: "approve", waitingForInputNodeId: "approve" });
    expect(storedGateWaiting(executionId)).toBe(1);
  });

  test("a loop back to the gate is a new arrival and decides again", async () => {
    const { engine, stored } = await saveWorkflow("gate-loop-back", {
      requireDecision: true,
      loopOnAgain: true,
    });
    const { executionId, presentation } = await startRun(engine, stored);
    const atGate = await agentStep(engine, executionId, presentation);
    expect(storedGateWaiting(executionId)).toBe(1);
    getSqliteInstance()
      .prepare(
        "UPDATE workflowExecution SET context = json_set(context, '$.variables.operating_mode', 'autonomous') WHERE executionId = ?",
      )
      .run(executionId);

    // A valid answer routes back to the same step through a new visit: the condition is read again.
    await engine.executor.executeStep(executionId, { decision: "again" }, undefined, {
      userId: USER_ID,
      attemptId: attemptIdOf(atGate),
    });
    const row = getSqliteInstance()
      .prepare(
        "SELECT currentNodeId, waitingForInputNodeId FROM workflowExecution WHERE executionId = ?",
      )
      .get(executionId) as { currentNodeId: string; waitingForInputNodeId: string };
    expect(row).toEqual({ currentNodeId: "approve", waitingForInputNodeId: "approve" });
    expect(storedGateWaiting(executionId)).toBe(0);
  });
});

describe("a new definition re-decides runs already paused on the step", () => {
  beforeAll(async () => {
    await createUser(USER_ID);
  });

  afterEach(() => MCPEngine.resetInstance());

  async function runPausedOnUnmarkedApproval(name: string) {
    const { engine, stored } = await saveWorkflow(name, { gated: false });
    const { executionId, presentation } = await startRun(engine, stored);
    const atApproval = await agentStep(engine, executionId, presentation);
    expect(storedGateWaiting(executionId)).toBe(0);
    return { engine, stored, executionId, atApproval };
  }

  test("saving a version that marks the step sets it, and the run still continues by an ordinary step", async () => {
    const { engine, stored, executionId, atApproval } =
      await runPausedOnUnmarkedApproval("gate-version-mark");
    const marked = graph("gate-version-mark");
    await getWorkflowService().save({
      graph: { ...marked, id: stored.id, metadata: { ...marked.metadata, version: "1.1.0" } },
      userId: USER_ID,
      visibility: "private",
    });
    expect(storedGateWaiting(executionId)).toBe(1);

    // The mark is not part of what the paused attempt is bound to: the same attempt still steps.
    await agentStep(engine, executionId, atApproval);
    expect(storedGateWaiting(executionId)).toBe(0);
    const row = getSqliteInstance()
      .prepare("SELECT currentNodeId FROM workflowExecution WHERE executionId = ?")
      .get(executionId) as { currentNodeId: string };
    expect(row.currentNodeId).toBe("finish");
  });

  test("a save that leaves the gate alone keeps the arrival decision; one that changes the gate re-decides", async () => {
    const { engine, stored } = await saveWorkflow("gate-version-unrelated");
    const { executionId, presentation } = await startRun(engine, stored);
    await agentStep(engine, executionId, presentation);
    expect(storedGateWaiting(executionId)).toBe(1);
    // The run's variables move after arrival: the gate's condition no longer holds.
    getSqliteInstance()
      .prepare(
        "UPDATE workflowExecution SET context = json_set(context, '$.variables.operating_mode', 'autonomous') WHERE executionId = ?",
      )
      .run(executionId);

    const base = graph("gate-version-unrelated");
    const save = (definition: WorkflowGraph, version: string) =>
      getWorkflowService().save({
        graph: { ...definition, id: stored.id, metadata: { ...definition.metadata, version } },
        userId: USER_ID,
        visibility: "private",
      });
    const retitled = {
      ...base,
      nodes: base.nodes.map((node) =>
        node.id === "finish" ? { ...node, directive: "Finish and report" } : node,
      ),
    } as WorkflowGraph;
    await save(retitled, "1.1.0");
    expect(storedGateWaiting(executionId)).toBe(1);

    const relabelled = {
      ...retitled,
      nodes: retitled.nodes.map((node) =>
        node.id === "approve"
          ? {
              ...node,
              humanGate: { ...(node as { humanGate: object }).humanGate, label: "Approve it" },
            }
          : node,
      ),
    } as WorkflowGraph;
    await save(relabelled, "1.2.0");
    expect(storedGateWaiting(executionId)).toBe(0);
  });

  test("saving a version that unmarks the step clears it", async () => {
    const { engine, stored } = await saveWorkflow("gate-version-unmark");
    const { executionId, presentation } = await startRun(engine, stored);
    await agentStep(engine, executionId, presentation);
    expect(storedGateWaiting(executionId)).toBe(1);

    const unmarked = graph("gate-version-unmark", { gated: false });
    await getWorkflowService().save({
      graph: { ...unmarked, id: stored.id, metadata: { ...unmarked.metadata, version: "1.1.0" } },
      userId: USER_ID,
      visibility: "private",
    });
    expect(storedGateWaiting(executionId)).toBe(0);
  });

  test.each([["present"], ["deleted"]] as const)(
    "catalog reconciliation that marks the step as %s sets it",
    async (lifecycle) => {
      const { stored, executionId } = await runPausedOnUnmarkedApproval(
        `gate-reconciliation-${lifecycle}`,
      );
      const marked = graph(`gate-reconciliation-${lifecycle}`);
      const slug = (
        getSqliteInstance().prepare("SELECT slug FROM workflow WHERE id = ?").get(stored.id) as {
          slug: string;
        }
      ).slug;

      new WorkflowReconciliationRepository(getSqliteInstance()).apply({
        preconditions: [],
        conflictPreconditions: [],
        baselinePreconditions: [],
        workflows: [
          {
            owner: USER_ID,
            slug,
            workflowId: stored.id,
            state: {
              lifecycle,
              content: {
                graph: {
                  ...marked,
                  metadata: { ...marked.metadata, version: "1.1.0" },
                } as unknown as Record<string, unknown>,
                visibility: "private",
              },
            },
          },
        ],
        baselines: [],
        conflicts: [],
        clearConflicts: [],
      });
      expect(storedGateWaiting(executionId)).toBe(1);
    },
  );
});

describe("a run that ends while waiting at the gate", () => {
  beforeAll(async () => {
    await createUser(USER_ID);
  });

  afterEach(() => MCPEngine.resetInstance());

  test("cancelling it clears the flag, so a completed run never claims to wait", async () => {
    const { engine, stored } = await saveWorkflow("gate-cancel");
    const { executionId, presentation } = await startRun(engine, stored);
    await agentStep(engine, executionId, presentation);
    expect(storedGateWaiting(executionId)).toBe(1);

    await engine.executor.cancelExecution(executionId);
    expect(storedGateWaiting(executionId)).toBe(0);
  });

  test("cancelling a run whose start outcome is unknown clears the flag", async () => {
    const { repository, engine, stored } = await saveWorkflow("gate-cancel-start", {
      firstStepGated: true,
    });
    const prepared = await new ExecutionMutationCoordinator(repository).prepareStart(
      USER_ID,
      stored,
      { note: null, parentExecutionId: null, skipNotificationCheck: true },
    );
    // The claimed start stores whatever the engine decided; mark it waiting so the cancel has
    // something to clear.
    const execution = {
      ...engine.executor.createWorkflowExecution(
        stored,
        undefined,
        USER_ID,
        undefined,
        undefined,
        prepared.reservedExecutionId,
      ),
      gateWaiting: true,
    };
    const claim = await repository.claimStartExecutionAttempt({
      attemptId: prepared.attemptId,
      userId: USER_ID,
      workflowId: stored.id!,
      workflowVersion: stored.metadata.version,
      workflowDigest: workflowGraphDigest(stored),
      ownerId: "gate-cancel-start-owner",
      now: 1_000,
      leaseMs: 30_000,
      execution,
    });
    if (claim.kind !== "claimed") throw new Error(`Start was not claimed: ${claim.kind}`);
    await repository.markExecutionAttemptOutcomeUnknown(
      prepared.attemptId,
      "gate-cancel-start-owner",
      claim.fence,
      2_000,
    );
    expect(storedGateWaiting(prepared.reservedExecutionId)).toBe(1);

    const before = (await repository.getExecution(prepared.reservedExecutionId))!;
    expect(
      await repository.cancelExecutionWithStartAttempt(
        prepared.reservedExecutionId,
        USER_ID,
        before.revision,
        { timestamp: 3_000, nodeId: "start", errorType: "system", message: "Cancelled" },
      ),
    ).toBe(true);
    expect(storedGateWaiting(prepared.reservedExecutionId)).toBe(0);
  });
});
