import { beforeEach, describe, expect, test } from "@jest/globals";
import {
  canonicalJson,
  continuationFacts,
  continuationSurfaceDigest,
  diagnoseContinuation,
  InMemoryRepository,
  UniversalGraphExecutor,
  type ContinuationDiagnosis,
  type ExecutionAttempt,
  type WorkflowExecution,
  type WorkflowGraph,
} from "@mcp-moira/workflow-engine";

const USER_ID = "diagnosis-unit-user";

/**
 * The cause vocabulary, exercised one state at a time, and each cause's `blocks` value with it.
 *
 * Both halves matter. A cause that never fires reports a broken run as continuable and sends the
 * agent back into the failure it was escaping. A cause classified the wrong way is worse in the
 * other direction: `blocks` is the signal recovery reads to decide eligibility, so a non-blocking
 * cause flipped to blocking makes healthy runs repairable. Each row therefore puts the run into
 * exactly one state, and asserts the named cause, its `blocks` value, and the resulting verdict.
 */
function graph(): WorkflowGraph {
  return {
    id: "diagnosis-unit-workflow",
    metadata: { name: "Diagnosis", version: "1.0.0", description: "Cause vocabulary" },
    nodes: [
      { type: "start", id: "start", connections: { default: "task" } },
      {
        type: "agent-directive",
        id: "task",
        directive: "Do the work",
        completionCondition: "Done",
        connections: { success: "end" },
      },
      { type: "end", id: "end" },
    ],
  };
}

let repository: InMemoryRepository;
let execution: WorkflowExecution;
let presented: ExecutionAttempt;

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
  presented = (await repository.getCurrentExecutionAttempt(executionId, USER_ID))!;
});

function kinds(diagnosis: ContinuationDiagnosis): string[] {
  return diagnosis.causes.map((cause) => cause.kind);
}

describe("every cause a paused run can be refused for", () => {
  test("a healthy run is continuable and names no cause", async () => {
    const diagnosis = await diagnoseContinuation(repository, execution, presented);

    expect(diagnosis.continuable).toBe(true);
    expect(diagnosis.causes).toEqual([]);
  });

  test("a recorded error is reported as history, not as an obstacle", async () => {
    await repository.appendError(execution.executionId, {
      timestamp: Date.now(),
      nodeId: "task",
      errorType: "validation",
      message: "the agent answered with the wrong shape",
    });
    const withError = (await repository.getExecution(execution.executionId))!;

    const diagnosis = await diagnoseContinuation(repository, withError, presented);

    const cause = diagnosis.causes.find((entry) => entry.kind === "recorded_error");
    expect(cause?.blocks).toBe(false);
    // The engine's own retry path writes this, and errors are never cleared: a run that once had a
    // rejected answer must not be permanently unrepairable while step() keeps working.
    expect(diagnosis.continuable).toBe(true);
  });

  test("an attempt with no continuation binding is refused as unbound", async () => {
    const legacy: ExecutionAttempt = {
      ...presented,
      continuationDigest: null,
      continuationFacts: null,
    };

    const diagnosis = await diagnoseContinuation(repository, execution, legacy);

    expect(kinds(diagnosis)).toContain("attempt_unbound");
    expect(diagnosis.continuable).toBe(false);
  });

  test("a run with no presented attempt says so without calling the run broken", async () => {
    const diagnosis = await diagnoseContinuation(repository, execution, null);

    const cause = diagnosis.causes.find((entry) => entry.kind === "no_presented_attempt");
    expect(cause?.blocks).toBe(false);
    expect(diagnosis.continuable).toBe(true);
    expect(diagnosis.attempt).toBeNull();
  });

  test("an attempt another caller is executing is reported without calling the run broken", async () => {
    const executing: ExecutionAttempt = { ...presented, state: "executing" };

    const diagnosis = await diagnoseContinuation(repository, execution, executing);

    const cause = diagnosis.causes.find((entry) => entry.kind === "attempt_not_presented");
    expect(cause && "state" in cause ? cause.state : "").toBe("executing");
    expect(cause?.blocks).toBe(false);
    expect(diagnosis.continuable).toBe(true);
    expect(kinds(diagnosis)).not.toContain("continuation_changed");
  });

  test("an attempt whose outcome is unknown does block, unlike one merely being executed", async () => {
    const unknown: ExecutionAttempt = { ...presented, state: "outcome_unknown" };

    const diagnosis = await diagnoseContinuation(repository, execution, unknown);

    const cause = diagnosis.causes.find((entry) => entry.kind === "attempt_not_presented");
    expect(cause?.blocks).toBe(true);
    expect(diagnosis.continuable).toBe(false);
  });

  test("an attempt bound to another node is reported as foreign", async () => {
    const foreign: ExecutionAttempt = { ...presented, nodeId: "somewhere-else" };

    const diagnosis = await diagnoseContinuation(repository, execution, foreign);

    const cause = diagnosis.causes.find((entry) => entry.kind === "attempt_foreign");
    expect(cause && "attemptNodeId" in cause ? cause.attemptNodeId : "").toBe("somewhere-else");
    expect(diagnosis.continuable).toBe(false);
  });

  test("an execution that moved on past its presented attempt reports the revision gap", async () => {
    const behind: ExecutionAttempt = {
      ...presented,
      executionRevision: (presented.executionRevision ?? 0) - 1,
    };

    const diagnosis = await diagnoseContinuation(repository, execution, behind);

    const cause = diagnosis.causes.find((entry) => entry.kind === "execution_revision_advanced");
    expect(cause && "currentRevision" in cause ? cause.currentRevision : -1).toBe(
      execution.revision,
    );
    // current_step rebinds a revision-only stale presentation, so nothing here needs repair.
    expect(cause?.blocks).toBe(false);
    expect(diagnosis.continuable).toBe(true);
  });

  test("an unresolved reference is reported without making the run repairable", async () => {
    // Isolated on purpose: the reference is in the definition the run started from, so no other
    // cause fires. A row that also changed the definition would pass whichever way this cause is
    // classified, because the definition change blocks on its own.
    const referencing = new InMemoryRepository();
    const definition: WorkflowGraph = {
      ...graph(),
      id: "diagnosis-unresolved-workflow",
      nodes: graph().nodes.map((node) =>
        node.id === "task" ? { ...node, directive: "Do the work in {{deploymentTarget}}" } : node,
      ),
    };
    await referencing.saveWorkflow(definition, USER_ID);
    const executor = new UniversalGraphExecutor(referencing);
    const executionId = await executor.startWorkflow(definition, undefined, USER_ID);
    await executor.executeStep(executionId, undefined, undefined, {
      userId: USER_ID,
      createPresentation: true,
    });
    const referencingExecution = (await referencing.getExecution(executionId))!;
    const referencingAttempt = (await referencing.getCurrentExecutionAttempt(
      executionId,
      USER_ID,
    ))!;

    const diagnosis = await diagnoseContinuation(
      referencing,
      referencingExecution,
      referencingAttempt,
    );

    const cause = diagnosis.causes.find((entry) => entry.kind === "unresolved_references");
    expect(cause && "references" in cause ? cause.references : []).toEqual(["deploymentTarget"]);
    expect(cause?.blocks).toBe(false);
    expect(diagnosis.continuable).toBe(true);
    expect(kinds(diagnosis)).toEqual(["unresolved_references"]);
  });

  test("a run whose workflow definition is gone is refused, not reported healthy", async () => {
    await repository.deleteWorkflow(execution.workflowId, USER_ID);

    const diagnosis = await diagnoseContinuation(repository, execution, presented);

    const cause = diagnosis.causes.find((entry) => entry.kind === "workflow_unavailable");
    expect(cause && "workflowId" in cause ? cause.workflowId : "").toBe(execution.workflowId);
    expect(cause?.blocks).toBe(true);
    expect(diagnosis.continuable).toBe(false);
    expect(diagnosis.currentNodeExists).toBe(false);
  });

  test("an execution that is no longer running says so", async () => {
    const finished: WorkflowExecution = { ...execution, status: "completed" };

    const diagnosis = await diagnoseContinuation(repository, finished, presented);

    const cause = diagnosis.causes.find((entry) => entry.kind === "execution_not_running");
    expect(cause && "status" in cause ? cause.status : "").toBe("completed");
    expect(diagnosis.continuable).toBe(false);
  });

  test("an execution holding no current node says so, and that blocks", async () => {
    // A run that finished reports both this and its status; nothing else in the vocabulary covers
    // "there is no step to continue", so without this row the cause could be deleted or demoted to
    // non-blocking with every other row still green.
    const nowhere: WorkflowExecution = { ...execution, currentNodeId: undefined };

    const diagnosis = await diagnoseContinuation(repository, nowhere, presented);

    const cause = diagnosis.causes.find((entry) => entry.kind === "no_current_node");
    expect(cause?.blocks).toBe(true);
    expect(diagnosis.currentNodeId).toBeNull();
    expect(diagnosis.continuable).toBe(false);
  });

  test("a mismatch it cannot attribute says so rather than naming nothing", async () => {
    const changed: WorkflowGraph = {
      ...graph(),
      nodes: graph().nodes.map((node) =>
        node.id === "task" ? { ...node, directive: "Rewritten" } : node,
      ),
    };
    await repository.saveWorkflow(changed, USER_ID);
    const withoutFacts: ExecutionAttempt = { ...presented, continuationFacts: null };

    const diagnosis = await diagnoseContinuation(repository, execution, withoutFacts);

    expect(kinds(diagnosis)).toContain("continuation_changed_unattributable");
    expect(diagnosis.continuable).toBe(false);
  });

  test("a mismatch it can attribute names the facts instead", async () => {
    const changed: WorkflowGraph = {
      ...graph(),
      nodes: graph().nodes.map((node) =>
        node.id === "task" ? { ...node, directive: "Rewritten" } : node,
      ),
    };
    await repository.saveWorkflow(changed, USER_ID);

    const diagnosis = await diagnoseContinuation(repository, execution, presented);

    const cause = diagnosis.causes.find((entry) => entry.kind === "continuation_changed");
    expect(cause && "changed" in cause ? cause.changed : []).toEqual(["node.directive"]);
    expect(kinds(diagnosis)).not.toContain("continuation_changed_unattributable");
  });

  test("a rebound attempt for the current definition is continuable again", async () => {
    const changed: WorkflowGraph = {
      ...graph(),
      nodes: graph().nodes.map((node) =>
        node.id === "task" ? { ...node, directive: "Rewritten" } : node,
      ),
    };
    await repository.saveWorkflow(changed, USER_ID);
    const rebound: ExecutionAttempt = {
      ...presented,
      continuationDigest: continuationSurfaceDigest(changed, "task"),
      continuationFacts: canonicalJson(continuationFacts(changed, "task")),
    };

    const diagnosis = await diagnoseContinuation(repository, execution, rebound);

    expect(diagnosis.continuable).toBe(true);
    expect(diagnosis.attempt?.boundToCurrentDefinition).toBe(true);
  });
});
