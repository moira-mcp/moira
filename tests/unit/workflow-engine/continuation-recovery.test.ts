import { beforeEach, describe, expect, test } from "@jest/globals";
import {
  InMemoryRepository,
  recoverContinuation,
  UniversalGraphExecutor,
  type WorkflowExecution,
  type WorkflowGraph,
} from "@mcp-moira/workflow-engine";

const USER_ID = "recovery-unit-user";

/**
 * The refusal paths, one state per row, against the in-memory repository — including the two a
 * concurrent caller produces, which the tool-level tests cannot reach without racing. Each row
 * asserts the refusal *and* that the run was left alone, because a refusal that changed something
 * is the failure this gate exists to prevent.
 */
function graph(): WorkflowGraph {
  return {
    id: "recovery-unit-workflow",
    metadata: { name: "Recovery", version: "1.0.0", description: "Refusal paths" },
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

let repository: InMemoryRepository;
let execution: WorkflowExecution;
let present: (executionId: string) => Promise<string>;

beforeEach(async () => {
  repository = new InMemoryRepository();
  const definition = graph();
  await repository.saveWorkflow(definition, USER_ID);
  const executor = new UniversalGraphExecutor(repository);
  const executionId = await executor.startWorkflow(definition, undefined, USER_ID);
  await executor.executeStep(executionId, undefined, undefined, {
    userId: USER_ID,
    createPresentation: true,
  });
  execution = (await repository.getExecution(executionId))!;
  present = (id) =>
    executor.executeStep(id, undefined, undefined, { userId: USER_ID, createPresentation: true });
});

/** Break the run the way a catalog deploy does: rewrite the node it is paused on. */
async function breakRun(): Promise<void> {
  const changed = graph();
  await repository.saveWorkflow(
    {
      ...changed,
      nodes: changed.nodes.map((node) =>
        node.id === "task" ? { ...node, directive: "Do entirely different work" } : node,
      ),
    },
    USER_ID,
  );
}

describe("refusing to recover a run that does not need it", () => {
  test("a run that can continue is refused and left untouched", async () => {
    const before = await repository.getExecution(execution.executionId);
    const beforeAttempt = await repository.getCurrentExecutionAttempt(
      execution.executionId,
      USER_ID,
    );

    const outcome = await recoverContinuation(repository, execution, "review", {}, present);

    expect(outcome.outcome).toBe("refused");
    expect(outcome.outcome === "refused" ? outcome.refusal.kind : "").toBe("run_not_broken");
    expect(await repository.getExecution(execution.executionId)).toEqual(before);
    expect(await repository.getCurrentExecutionAttempt(execution.executionId, USER_ID)).toEqual(
      beforeAttempt,
    );
  });

  test("an unknown node is refused, naming the nodes that exist", async () => {
    await breakRun();

    const outcome = await recoverContinuation(repository, execution, "nowhere", {}, present);

    const refusal = outcome.outcome === "refused" ? outcome.refusal : null;
    expect(refusal?.kind).toBe("unknown_node");
    expect(refusal && "availableNodeIds" in refusal ? refusal.availableNodeIds : []).toEqual([
      "end",
      "review",
      "start",
      "task",
    ]);
  });

  test("a target that would still be unresolved is refused, naming what is missing", async () => {
    await breakRun();

    const outcome = await recoverContinuation(repository, execution, "review", {}, present);

    const refusal = outcome.outcome === "refused" ? outcome.refusal : null;
    expect(refusal?.kind).toBe("missing_variables");
    expect(refusal && "references" in refusal ? refusal.references : []).toEqual(["target"]);
  });

  test("a recovery is refused while another caller is executing the attempt", async () => {
    // Claim the attempt the way an agent's step does, then break the run: the claim holds, so
    // recovery meets a live owner rather than a stale presentation.
    const attempt = (await repository.getCurrentExecutionAttempt(execution.executionId, USER_ID))!;
    const claimed = await repository.claimExecutionAttempt({
      attemptId: attempt.attemptId,
      userId: USER_ID,
      executionId: execution.executionId,
      executionRevision: execution.revision,
      nodeId: execution.currentNodeId!,
      workflowId: execution.workflowId,
      continuationDigest: attempt.continuationDigest!,
      inputFingerprint: "fingerprint",
      ownerId: "another-caller",
      now: Date.now(),
      leaseMs: 30_000,
    });
    expect(claimed.kind).toBe("claimed");
    await breakRun();
    const before = await repository.getExecution(execution.executionId);

    const outcome = await recoverContinuation(
      repository,
      execution,
      "review",
      { target: "staging" },
      present,
    );

    expect(outcome.outcome === "refused" ? outcome.refusal.kind : "").toBe("attempt_in_progress");
    expect(await repository.getExecution(execution.executionId)).toEqual(before);
  });

  test("a recovery is refused when the execution moved under the caller", async () => {
    await breakRun();
    const stale: WorkflowExecution = { ...execution, revision: execution.revision - 1 };
    const before = await repository.getExecution(execution.executionId);

    const outcome = await recoverContinuation(
      repository,
      stale,
      "review",
      { target: "staging" },
      present,
    );

    expect(outcome.outcome === "refused" ? outcome.refusal.kind : "").toBe("execution_changed");
    expect(await repository.getExecution(execution.executionId)).toEqual(before);
  });

  test("a node the run could never wait on is refused rather than run forward", async () => {
    await breakRun();
    const before = await repository.getExecution(execution.executionId);

    const outcome = await recoverContinuation(repository, execution, "end", {}, present);

    const refusal = outcome.outcome === "refused" ? outcome.refusal : null;
    expect(refusal?.kind).toBe("node_not_resumable");
    expect(refusal && "resumableNodeIds" in refusal ? refusal.resumableNodeIds : []).toEqual([
      "review",
      "task",
    ]);
    // The run must be exactly as it was — not completed, not advanced past anything in between.
    expect(await repository.getExecution(execution.executionId)).toEqual(before);
  });

  test("the guarded write leaves the run holding an attempt at the target", async () => {
    await breakRun();

    await recoverContinuation(repository, execution, "review", { target: "staging" }, present);

    // Whatever happens to the rendering afterwards, the run waits on the node it was moved to and
    // holds a presented attempt: current_step can present it and step() has an id to use.
    const moved = (await repository.getExecution(execution.executionId))!;
    expect(moved.waitingForInputNodeId).toBe("review");
    expect(moved.currentNodeId).toBe("review");
    const attempt = await repository.getCurrentExecutionAttempt(execution.executionId, USER_ID);
    expect(attempt?.state).toBe("presented");
    expect(attempt?.nodeId).toBe("review");
    // Bound to the revision the move produced, so it is usable as it stands rather than needing a
    // rebind before the run can continue.
    expect(attempt?.executionRevision).toBe(moved.revision);
  });

  test("a run whose definition is gone is refused with no node to resume from", async () => {
    await repository.deleteWorkflow(execution.workflowId, USER_ID);
    const before = await repository.getExecution(execution.executionId);

    const outcome = await recoverContinuation(repository, execution, "task", {}, present);

    expect(outcome.outcome === "refused" ? outcome.refusal.kind : "").toBe("workflow_unavailable");
    expect(await repository.getExecution(execution.executionId)).toEqual(before);
  });

  test("a run is recovered at the node it is already paused on", async () => {
    await breakRun();

    const outcome = await recoverContinuation(repository, execution, "task", {}, present);

    expect(outcome.outcome).toBe("recovered");
    const moved = (await repository.getExecution(execution.executionId))!;
    expect(moved.currentNodeId).toBe("task");
    expect(moved.revision).toBeGreaterThan(execution.revision);
    expect(outcome.outcome === "recovered" ? outcome.result.presentation : "").toContain(
      "Do entirely different work",
    );
  });

  test("a broken run is moved to the named node with the values it needs", async () => {
    await breakRun();

    const outcome = await recoverContinuation(
      repository,
      execution,
      "review",
      { target: "staging" },
      present,
    );

    expect(outcome.outcome).toBe("recovered");
    const moved = (await repository.getExecution(execution.executionId))!;
    expect(moved.currentNodeId).toBe("review");
    expect(moved.globalContext.variables.target).toBe("staging");
    expect(moved.revision).toBeGreaterThan(execution.revision);
  });
});
