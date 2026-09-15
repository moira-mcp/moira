import { beforeAll, afterEach, describe, expect, test } from "@jest/globals";
import {
  AuditAction,
  AuditRepository,
  getDatabase,
  getWorkflowService,
  user,
} from "@mcp-moira/shared";
import {
  DatabaseRepository,
  type ContinuationDiagnosis,
  type ContinuationRecoveryResult,
  type WorkflowGraph,
} from "@mcp-moira/workflow-engine";
import { MCPEngine } from "../../packages/mcp-server/src/core/mcp-engine.js";
import { requestContext } from "../../packages/mcp-server/src/core/request-context.js";
import { getSessionInfo } from "../../packages/mcp-server/src/tools/get-session-info.js";

const USER_ID = "continuation-recovery-user";
const OTHER_USER_ID = "continuation-recovery-other-user";

function workflow(name: string): WorkflowGraph {
  return {
    metadata: { name, version: "1.0.0", description: "Recovery test" },
    nodes: [
      { type: "start", id: "start", connections: { default: "task" } },
      {
        type: "agent-directive",
        id: "task",
        directive: "Do the work",
        completionCondition: "Done",
        connections: { success: "review" },
      },
      {
        type: "agent-directive",
        id: "review",
        directive: "Review the work in {{target}}",
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

/** A run paused on `task` with a presented attempt, as an agent would find it. */
async function pausedRun(name: string) {
  const repository = new DatabaseRepository();
  const saved = await getWorkflowService().save({
    graph: workflow(name),
    userId: USER_ID,
    visibility: "private",
  });
  const stored = (await repository.getWorkflowGraph(saved.id, USER_ID))!;
  const engine = MCPEngine.getInstance(repository);
  const executionId = await engine.executor.startWorkflow(stored, undefined, USER_ID);
  await engine.executor.executeStep(executionId, undefined, undefined, {
    userId: USER_ID,
    createPresentation: true,
  });
  return { repository, stored, executionId };
}

/** Break the run the way a catalog deploy does: change the node it is paused on. */
async function breakRun(repository: DatabaseRepository, stored: WorkflowGraph) {
  await repository.saveWorkflow(
    {
      ...stored,
      nodes: stored.nodes.map((node) =>
        node.id === "task" ? { ...node, directive: "Do entirely different work" } : node,
      ),
    },
    USER_ID,
  );
}

function recover(
  executionId: string,
  nodeId: string,
  variableValues?: Record<string, unknown>,
  asUser = USER_ID,
) {
  return requestContext.run({ userId: asUser }, () =>
    getSessionInfo({ action: "recover", executionId, nodeId, variableValues }),
  );
}

function attemptIdOf(presentation: string): string {
  return presentation.match(/Step attempt ID:\s*([a-f0-9-]+)/i)![1];
}

describe("recovering a run that cannot continue", () => {
  beforeAll(async () => {
    await createUser(USER_ID);
    await createUser(OTHER_USER_ID);
  });

  afterEach(() => MCPEngine.resetInstance());

  test("a broken run is returned to a named step and then actually continues", async () => {
    const { repository, stored, executionId } = await pausedRun("recovery-round-trip");
    await breakRun(repository, stored);

    const result = await recover(executionId, "review", { target: "staging" });
    const recovered = result.data as ContinuationRecoveryResult;

    expect({ success: result.success, error: result.error }).toEqual({
      success: true,
      error: undefined,
    });
    expect(recovered.nodeId).toBe("review");
    expect(recovered.appliedVariables).toEqual(["target"]);
    expect(recovered.presentation).toContain("Review the work in staging");

    // The round trip does not stop at the recovery response: the run must actually advance.
    const engine = MCPEngine.getInstance(repository);
    const next = await requestContext.run({ userId: USER_ID }, () =>
      engine.executeStep(executionId, {}, undefined, attemptIdOf(recovered.presentation)),
    );
    expect(next).toContain("completed");
  });

  test("the run is recovered at the very node a deploy changed, and continues there", async () => {
    // This is the scenario the task exists for: the definition changed under a run paused at that
    // node, and the repair is to resume where it already is, rebound to the definition as it stands.
    // It differs from moving elsewhere in the part most likely to break — the guarded move writes
    // the node it already holds while clearing the waiting field.
    const { repository, stored, executionId } = await pausedRun("recovery-same-node");
    await breakRun(repository, stored);

    const result = await recover(executionId, "task");
    const recovered = result.data as ContinuationRecoveryResult;

    expect({ success: result.success, error: result.error }).toEqual({
      success: true,
      error: undefined,
    });
    expect(recovered.nodeId).toBe("task");
    expect(recovered.presentation).toContain("Do entirely different work");

    const engine = MCPEngine.getInstance(repository);
    const next = await requestContext.run({ userId: USER_ID }, () =>
      engine.executeStep(executionId, {}, undefined, attemptIdOf(recovered.presentation)),
    );
    expect(next).toContain("Review the work in");
  });

  test("after recovery the run diagnoses as continuable", async () => {
    const { repository, stored, executionId } = await pausedRun("recovery-then-diagnose");
    await breakRun(repository, stored);
    await recover(executionId, "review", { target: "staging" });

    const diagnosis = (
      await requestContext.run({ userId: USER_ID }, () =>
        getSessionInfo({ action: "diagnose", executionId }),
      )
    ).data as ContinuationDiagnosis;

    expect(diagnosis.continuable).toBe(true);
    expect(diagnosis.currentNodeId).toBe("review");
  });

  test("a healthy run is refused and nothing about it changes", async () => {
    const { repository, executionId } = await pausedRun("recovery-healthy-refused");
    const before = (await repository.getExecution(executionId))!;
    const beforeAttempt = await repository.getCurrentExecutionAttempt(executionId, USER_ID);

    const result = await recover(executionId, "review", { target: "staging" });

    expect(result.success).toBe(false);
    expect(result.error).toContain("RECOVERY_REFUSED");
    expect(result.error).toContain("AGENT INSTRUCTIONS");
    expect(await repository.getExecution(executionId)).toEqual(before);
    expect(await repository.getCurrentExecutionAttempt(executionId, USER_ID)).toEqual(
      beforeAttempt,
    );
  });

  test("a run whose only cause is a recorded error is refused too", async () => {
    const { repository, executionId } = await pausedRun("recovery-recorded-error-refused");
    await repository.appendError(executionId, {
      timestamp: Date.now(),
      nodeId: "task",
      errorType: "validation",
      message: "the agent answered with the wrong shape",
    });
    const before = (await repository.getExecution(executionId))!;

    const result = await recover(executionId, "review", { target: "staging" });

    expect(result.success).toBe(false);
    expect(result.error).toContain("can continue without repair");
    expect((await repository.getExecution(executionId))!.revision).toBe(before.revision);
  });

  test("a run that reached its end is refused, and stays finished", async () => {
    // Recovery repairs a run that is trying to continue and cannot. A finished run is not trying,
    // and every guard downstream of the gate lets it through: its last attempt is closed, so the
    // in-progress check cannot see it, and the guarded write matches the stored terminal row. The
    // gate is the only thing standing between a finished run and being reopened at an arbitrary step.
    const { repository, executionId } = await pausedRun("recovery-completed-refused");
    const engine = MCPEngine.getInstance(repository);
    await requestContext.run({ userId: USER_ID }, async () => {
      const task = await engine.getCurrentStep(executionId);
      const review = await engine.executeStep(executionId, {}, undefined, attemptIdOf(task));
      await engine.executeStep(executionId, {}, undefined, attemptIdOf(review));
    });
    const before = (await repository.getExecution(executionId))!;
    expect(before.status).toBe("completed");

    const result = await recover(executionId, "task");

    expect(result.success).toBe(false);
    expect(result.error).toContain("already over");
    expect(await repository.getExecution(executionId)).toEqual(before);
    expect(await repository.getCurrentExecutionAttempt(executionId, USER_ID)).toBeNull();
  });

  test("a cancelled run is refused, and cancelling is not undone", async () => {
    // A cancelled run is stored as completed but keeps its current node, so it reaches the gate with
    // a different set of causes than a run that finished normally — and it is the case that matters
    // most, because reopening it would silently reverse the owner's own instruction to stop.
    const { repository, executionId } = await pausedRun("recovery-cancelled-refused");
    await repository.cancelExecution(executionId, {
      timestamp: Date.now(),
      nodeId: "task",
      errorType: "system",
      message: "the owner stopped this run",
    });
    const before = (await repository.getExecution(executionId))!;
    expect(before.status).toBe("completed");
    expect(before.currentNodeId).toBe("task");

    const result = await recover(executionId, "review", { target: "staging" });

    expect(result.success).toBe(false);
    expect(result.error).toContain("already over");
    // Distinguishable from the healthy-run refusal, which is the other reason a recovery comes back
    // refused without anything being wrong with the definition.
    expect(result.error).not.toContain("can continue without repair");
    expect(await repository.getExecution(executionId)).toEqual(before);
  });

  test("a cancelled run is still diagnosed, and still says why it cannot continue", async () => {
    // Refusing the mutation must not cost the explanation. Closing the gate by making the run's own
    // status a non-blocking cause would pass every refusal row above and silently delete this.
    const { repository, executionId } = await pausedRun("recovery-cancelled-diagnosed");
    await repository.cancelExecution(executionId, {
      timestamp: Date.now(),
      nodeId: "task",
      errorType: "system",
      message: "the owner stopped this run",
    });

    const diagnosis = (
      await requestContext.run({ userId: USER_ID }, () =>
        getSessionInfo({ action: "diagnose", executionId }),
      )
    ).data as ContinuationDiagnosis;

    expect(diagnosis.continuable).toBe(false);
    expect(diagnosis.causes.map((cause) => cause.kind)).toContain("execution_not_running");
  });

  test("an unknown node is refused, naming the nodes that exist", async () => {
    const { repository, stored, executionId } = await pausedRun("recovery-unknown-node");
    await breakRun(repository, stored);

    const result = await recover(executionId, "not-a-node", { target: "staging" });

    expect(result.success).toBe(false);
    expect(result.error).toContain("'not-a-node' is not in the current workflow");
    expect(result.error).toContain("review");
  });

  test("a node the run could never wait on is refused rather than run forward", async () => {
    const { repository, stored, executionId } = await pausedRun("recovery-non-resumable-node");
    await breakRun(repository, stored);
    const before = (await repository.getExecution(executionId))!;

    const result = await recover(executionId, "end", { target: "staging" });

    expect(result.success).toBe(false);
    expect(result.error).toContain("which a run never waits on");
    expect(result.error).toContain("Resume at one of");
    // Not completed, not advanced: recovery repairs, it does not run the workflow.
    expect(await repository.getExecution(executionId)).toEqual(before);
  });

  test("a recovery missing a value the target needs is refused, naming that value", async () => {
    const { repository, stored, executionId } = await pausedRun("recovery-missing-value");
    await breakRun(repository, stored);
    const before = (await repository.getExecution(executionId))!;

    const result = await recover(executionId, "review");

    expect(result.success).toBe(false);
    expect(result.error).toContain("unresolved references");
    expect(result.error).toContain("target");
    expect((await repository.getExecution(executionId))!.revision).toBe(before.revision);
  });

  test("a successful recovery is audited as a recovery, with the target node", async () => {
    const { repository, stored, executionId } = await pausedRun("recovery-audited");
    await breakRun(repository, stored);

    await recover(executionId, "review", { target: "staging" });

    const logs = await new AuditRepository(getDatabase()).list({
      action: AuditAction.EXECUTION_RECOVER,
    });
    const entry = logs.find((log) => log.resourceId === executionId);
    expect(entry).toBeDefined();
    expect(JSON.stringify(entry ?? {})).toContain("review");
  });

  test("another owner's execution is refused and nothing about it is revealed", async () => {
    const { executionId } = await pausedRun("recovery-foreign-owner");

    const result = await recover(executionId, "review", { target: "staging" }, OTHER_USER_ID);

    expect(result.success).toBe(false);
    expect(result.data).toBeUndefined();
    expect(result.error).not.toContain("review");
  });
});
