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

  test("a future step added by a workflow update recovers missing expression state", async () => {
    const { repository, stored, executionId } = await pausedRun("recovery-future-expression");
    await repository.saveWorkflow(
      {
        ...stored,
        metadata: { ...stored.metadata, version: "2.0.0" },
        variableRegistry: {
          plan_units: {
            type: "array",
            description: "Approved units",
            items: {
              type: "object",
              required: ["title"],
              properties: { title: { type: "string" } },
            },
          },
          unit_index: { type: "integer", description: "Current zero-based unit index" },
          current_title: { type: "string", description: "Current unit title" },
        },
        nodes: stored.nodes.map((node) =>
          node.id === "review"
            ? {
                ...node,
                directive: "Review the work",
                inputSchema: {
                  type: "object",
                  properties: {
                    approved: { type: "boolean" },
                    summary: { type: "string" },
                  },
                  required: ["approved"],
                  allOf: [
                    {
                      if: { properties: { approved: { const: true } }, required: ["approved"] },
                      then: { required: ["summary"] },
                    },
                  ],
                },
                expressions: ["unit_index = 0", "current_title = plan_units[unit_index].title"],
              }
            : node,
        ),
      },
      USER_ID,
    );

    const engine = MCPEngine.getInstance(repository);
    const task = await requestContext.run({ userId: USER_ID }, () =>
      engine.getCurrentStep(executionId),
    );
    const review = await requestContext.run({ userId: USER_ID }, () =>
      engine.executeStep(executionId, {}, undefined, attemptIdOf(task)),
    );
    expect(review).toContain("Review the work");
    const resumedStep = await requestContext.run({ userId: USER_ID }, () =>
      getSessionInfo({ action: "current_step", executionId }),
    );
    expect(resumedStep.success).toBe(true);
    expect(resumedStep.data).toContain("RECOVERY REQUIRED");
    expect(resumedStep.data).toContain("plan_units");

    const rejected = await requestContext.run({ userId: USER_ID }, () =>
      engine.executeStep(
        executionId,
        { approved: true, summary: "Reviewed" },
        undefined,
        attemptIdOf(review),
      ),
    );
    expect(rejected).toContain("STEP_BLOCKED");
    expect(rejected).toContain("plan_units");
    expect(rejected).toContain('session({ action: "recover"');

    const diagnosis = (
      await requestContext.run({ userId: USER_ID }, () =>
        getSessionInfo({ action: "diagnose", executionId }),
      )
    ).data as ContinuationDiagnosis;
    expect(diagnosis.attempt?.boundToCurrentDefinition).toBe(true);
    expect(diagnosis.continuable).toBe(false);
    expect(diagnosis.causes).toContainEqual({
      kind: "missing_expression_variables",
      nodeId: "review",
      variables: ["plan_units"],
      blocks: true,
    });

    const beforeRecovery = (await repository.getExecution(executionId))!;
    const missingValue = await recover(executionId, "review");
    expect(missingValue.success).toBe(false);
    expect(missingValue.error).toContain("plan_units");
    const invalidValue = await recover(executionId, "review", { plan_units: "not a plan" });
    expect(invalidValue.success).toBe(false);
    expect(invalidValue.error).toContain("Invalid declared variable 'plan_units'");
    expect(await repository.getExecution(executionId)).toEqual(beforeRecovery);

    const recoveredResult = await recover(executionId, "review", {
      plan_units: [{ title: "Ground the current unit" }],
    });
    expect({ success: recoveredResult.success, error: recoveredResult.error }).toEqual({
      success: true,
      error: undefined,
    });
    const recovered = recoveredResult.data as ContinuationRecoveryResult;
    const afterRecovery = (await repository.getExecution(executionId))!;
    expect(afterRecovery.visits?.slice(0, beforeRecovery.visits?.length)).toEqual(
      beforeRecovery.visits,
    );
    const finished = await requestContext.run({ userId: USER_ID }, () =>
      engine.executeStep(
        executionId,
        { approved: true, summary: "Reviewed" },
        undefined,
        attemptIdOf(recovered.presentation),
      ),
    );
    expect(finished).toContain("completed");
    expect((await repository.getExecution(executionId))?.status).toBe("completed");
  });

  test("a composed empty-answer schema recovers missing expression state", async () => {
    const { repository, stored, executionId } = await pausedRun("recovery-composed-empty-answer");
    await repository.saveWorkflow(
      {
        ...stored,
        variableRegistry: {
          plan_units: {
            type: "array",
            description: "Approved units",
            items: {
              type: "object",
              required: ["title"],
              properties: { title: { type: "string" } },
            },
          },
          current_title: { type: "string", description: "Current unit title" },
        },
        nodes: stored.nodes.map((node) =>
          node.id === "review"
            ? {
                ...node,
                directive: "Review the work",
                inputSchema: {
                  oneOf: [
                    {
                      type: "object",
                      additionalProperties: false,
                      maxProperties: 0,
                    },
                  ],
                },
                expressions: ["current_title = plan_units[0].title"],
              }
            : node,
        ),
      },
      USER_ID,
    );

    const engine = MCPEngine.getInstance(repository);
    const task = await requestContext.run({ userId: USER_ID }, () =>
      engine.getCurrentStep(executionId),
    );
    const review = await requestContext.run({ userId: USER_ID }, () =>
      engine.executeStep(executionId, {}, undefined, attemptIdOf(task)),
    );
    expect(review).toContain("Review the work");

    const current = await requestContext.run({ userId: USER_ID }, () =>
      getSessionInfo({ action: "current_step", executionId }),
    );
    expect(current.success).toBe(true);
    expect(current.data).toContain("RECOVERY REQUIRED");
    expect(current.data).toContain("plan_units");
    const rejected = await requestContext.run({ userId: USER_ID }, () =>
      engine.executeStep(executionId, {}, undefined, attemptIdOf(current.data as string)),
    );
    expect(rejected).toContain("STEP_BLOCKED");
    expect(rejected).toContain("plan_units");
    const diagnosis = (
      await requestContext.run({ userId: USER_ID }, () =>
        getSessionInfo({ action: "diagnose", executionId }),
      )
    ).data as ContinuationDiagnosis;
    expect(diagnosis.continuable).toBe(false);
    expect(diagnosis.causes).toContainEqual({
      kind: "missing_expression_variables",
      nodeId: "review",
      variables: ["plan_units"],
      blocks: true,
    });

    const before = (await repository.getExecution(executionId))!;
    const missingValue = await recover(executionId, "review");
    expect(missingValue.success).toBe(false);
    expect(missingValue.error).toContain("plan_units");
    expect(await repository.getExecution(executionId)).toEqual(before);
    const recovery = await recover(executionId, "review", {
      plan_units: [{ title: "From saved state" }],
    });
    expect(recovery.success).toBe(true);
    const recovered = recovery.data as ContinuationRecoveryResult;

    const finished = await requestContext.run({ userId: USER_ID }, () =>
      engine.executeStep(executionId, {}, undefined, attemptIdOf(recovered.presentation)),
    );
    expect(finished).toContain("completed");
    expect((await repository.getExecution(executionId))?.status).toBe("completed");
  });

  test("an open answer cannot replace an undeclared saved expression root", async () => {
    const { repository, stored, executionId } = await pausedRun("recovery-open-answer");
    await repository.saveWorkflow(
      {
        ...stored,
        variableRegistry: {
          plan_units: {
            type: "array",
            description: "Approved units",
            items: { type: "object", properties: { title: { type: "string" } } },
          },
          current_title: { type: "string", description: "Current unit title" },
        },
        nodes: stored.nodes.map((node) =>
          node.id === "review"
            ? {
                ...node,
                directive: "Review the work",
                inputSchema: { type: "object" },
                expressions: ["current_title = plan_units[0].title"],
              }
            : node,
        ),
      },
      USER_ID,
    );

    const engine = MCPEngine.getInstance(repository);
    const task = await requestContext.run({ userId: USER_ID }, () =>
      engine.getCurrentStep(executionId),
    );
    const review = await requestContext.run({ userId: USER_ID }, () =>
      engine.executeStep(executionId, {}, undefined, attemptIdOf(task)),
    );
    expect(review).toContain("Review the work");

    const current = await requestContext.run({ userId: USER_ID }, () =>
      getSessionInfo({ action: "current_step", executionId }),
    );
    expect(current.success).toBe(true);
    expect(current.data).toContain("RECOVERY REQUIRED");
    expect(current.data).toContain("plan_units");

    const rejected = await requestContext.run({ userId: USER_ID }, () =>
      engine.executeStep(executionId, {}, undefined, attemptIdOf(review)),
    );
    expect(rejected).toContain("STEP_BLOCKED");
    const diagnosis = (
      await requestContext.run({ userId: USER_ID }, () =>
        getSessionInfo({ action: "diagnose", executionId }),
      )
    ).data as ContinuationDiagnosis;
    expect(diagnosis.causes).toContainEqual({
      kind: "missing_expression_variables",
      nodeId: "review",
      variables: ["plan_units"],
      blocks: true,
    });

    const recovered = await recover(executionId, "review", {
      plan_units: [{ title: "From saved state" }],
    });
    expect(recovered.success).toBe(true);
    const presentation = (recovered.data as ContinuationRecoveryResult).presentation;
    const finished = await requestContext.run({ userId: USER_ID }, () =>
      engine.executeStep(executionId, {}, undefined, attemptIdOf(presentation)),
    );
    expect(finished).toContain("completed");
    expect((await repository.getExecution(executionId))?.status).toBe("completed");

    const updated = (await repository.getWorkflowGraph(stored.id!, USER_ID))!;
    const secondExecutionId = await engine.executor.startWorkflow(updated, undefined, USER_ID);
    await engine.executor.executeStep(secondExecutionId, undefined, undefined, {
      userId: USER_ID,
      createPresentation: true,
    });
    const secondTask = await requestContext.run({ userId: USER_ID }, () =>
      engine.getCurrentStep(secondExecutionId),
    );
    const secondReview = await requestContext.run({ userId: USER_ID }, () =>
      engine.executeStep(secondExecutionId, {}, undefined, attemptIdOf(secondTask)),
    );
    await expect(
      requestContext.run({ userId: USER_ID }, () =>
        engine.executeStep(
          secondExecutionId,
          { plan_units: [{ title: "Only in the answer" }] },
          undefined,
          attemptIdOf(secondReview),
        ),
      ),
    ).rejects.toThrow("produced undeclared output key 'plan_units'");
    expect((await repository.getExecution(secondExecutionId))?.status).not.toBe("completed");
  });

  test.each([
    {
      name: "maxProperties excludes the declared field",
      inputSchema: {
        type: "object",
        properties: { plan_units: { type: "array" } },
        maxProperties: 0,
      },
    },
    {
      name: "a false property schema excludes the declared field",
      inputSchema: { type: "object", properties: { plan_units: false } },
    },
    {
      name: "not required excludes the declared field",
      inputSchema: {
        type: "object",
        properties: { plan_units: { type: "array" } },
        not: { required: ["plan_units"] },
      },
    },
    {
      name: "an allOf branch excludes the declared field",
      inputSchema: {
        type: "object",
        properties: { plan_units: { type: "array" } },
        allOf: [{ maxProperties: 0 }],
      },
    },
  ])("a schema that $name still permits same-node recovery", async (scenario) => {
    const base = workflow(`recovery-forbidden-answer-${scenario.name}`);
    const saved = await getWorkflowService().save({
      graph: {
        ...base,
        variableRegistry: {
          plan_units: {
            type: "array",
            description: "Approved units",
            items: { type: "object", properties: { estimate: { type: "number" } } },
          },
          result: { type: "number", description: "Computed result" },
        },
        nodes: base.nodes.map((node) =>
          node.id === "task"
            ? {
                ...node,
                inputSchema: scenario.inputSchema,
                expressions: ["result = plan_units[0].estimate"],
              }
            : node,
        ),
      },
      userId: USER_ID,
      visibility: "private",
    });
    const repository = new DatabaseRepository();
    const stored = (await repository.getWorkflowGraph(saved.id, USER_ID))!;
    const engine = MCPEngine.getInstance(repository);
    const executionId = await engine.executor.startWorkflow(stored, undefined, USER_ID);
    await engine.executor.executeStep(executionId, undefined, undefined, {
      userId: USER_ID,
      createPresentation: true,
    });
    const task = await requestContext.run({ userId: USER_ID }, () =>
      engine.getCurrentStep(executionId),
    );
    const invalid = await requestContext.run({ userId: USER_ID }, () =>
      engine.executeStep(
        executionId,
        { plan_units: [{ estimate: 1 }] },
        undefined,
        attemptIdOf(task),
      ),
    );
    expect(invalid).toContain("VALIDATION ERROR");

    const rejected = await requestContext.run({ userId: USER_ID }, () =>
      engine.executeStep(executionId, {}, undefined, attemptIdOf(invalid)),
    );
    expect(rejected).toContain("STEP_BLOCKED");
    expect(rejected).toContain("plan_units");
    const diagnosis = (
      await requestContext.run({ userId: USER_ID }, () =>
        getSessionInfo({ action: "diagnose", executionId }),
      )
    ).data as ContinuationDiagnosis;
    expect(diagnosis.causes).toContainEqual({
      kind: "missing_expression_variables",
      nodeId: "task",
      variables: ["plan_units"],
      blocks: true,
    });

    const before = (await repository.getExecution(executionId))!;
    const missing = await recover(executionId, "task");
    expect(missing.success).toBe(false);
    expect(await repository.getExecution(executionId)).toEqual(before);
    const recovery = await recover(executionId, "task", { plan_units: [{ estimate: 1 }] });
    expect(recovery.success).toBe(true);
    const presentation = (recovery.data as ContinuationRecoveryResult).presentation;
    const advanced = await requestContext.run({ userId: USER_ID }, () =>
      engine.executeStep(executionId, {}, undefined, attemptIdOf(presentation)),
    );
    expect(advanced).toContain("Review the work");
  });

  test.each([
    {
      name: "a later expression",
      expressions: ["result = 12 / divisor", "result = result + plan_units[0].estimate"],
    },
    {
      name: "a later read in the same expression",
      expressions: ["result = 12 / divisor + plan_units[0].estimate"],
    },
  ])("an answer fault before $name remains the immediate retry reason", async (scenario) => {
    const base = workflow(`recovery-first-failure-${scenario.name}`);
    const saved = await getWorkflowService().save({
      graph: {
        ...base,
        variableRegistry: {
          result: { type: "number", description: "Computed result" },
          plan_units: {
            type: "array",
            description: "Approved units",
            items: { type: "object", properties: { estimate: { type: "number" } } },
          },
        },
        nodes: base.nodes.map((node) =>
          node.id === "task"
            ? {
                ...node,
                inputSchema: {
                  type: "object",
                  properties: { divisor: { type: "number" } },
                  required: ["divisor"],
                },
                expressions: scenario.expressions,
              }
            : node,
        ),
      },
      userId: USER_ID,
      visibility: "private",
    });
    const repository = new DatabaseRepository();
    const stored = (await repository.getWorkflowGraph(saved.id, USER_ID))!;
    const engine = MCPEngine.getInstance(repository);
    const executionId = await engine.executor.startWorkflow(stored, undefined, USER_ID);
    await engine.executor.executeStep(executionId, undefined, undefined, {
      userId: USER_ID,
      createPresentation: true,
    });
    const task = await requestContext.run({ userId: USER_ID }, () =>
      engine.getCurrentStep(executionId),
    );
    const rejected = await requestContext.run({ userId: USER_ID }, () =>
      engine.executeStep(executionId, { divisor: 0 }, undefined, attemptIdOf(task)),
    );
    expect(rejected).toContain("Division by zero");
    expect(rejected).toContain("Please retry with correct input");
    expect(rejected).not.toContain("STEP_BLOCKED");

    const diagnosis = (
      await requestContext.run({ userId: USER_ID }, () =>
        getSessionInfo({ action: "diagnose", executionId }),
      )
    ).data as ContinuationDiagnosis;
    expect(diagnosis.causes).toContainEqual({
      kind: "missing_expression_variables",
      nodeId: "task",
      variables: ["plan_units"],
      blocks: true,
    });
    const recovery = await recover(executionId, "task", {
      plan_units: [{ estimate: 1 }],
    });
    expect(recovery.success).toBe(true);
    const presentation = (recovery.data as ContinuationRecoveryResult).presentation;
    const corrected = await requestContext.run({ userId: USER_ID }, () =>
      engine.executeStep(executionId, { divisor: 2 }, undefined, attemptIdOf(presentation)),
    );
    expect(corrected).toContain("Review the work");
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

  test("an actual malformed answer remains a retry, not a recovery opportunity", async () => {
    const { repository, executionId } = await pausedRun("recovery-invalid-answer-refused");
    const engine = MCPEngine.getInstance(repository);
    const task = await requestContext.run({ userId: USER_ID }, () =>
      engine.getCurrentStep(executionId),
    );
    const rejected = await requestContext.run({ userId: USER_ID }, () =>
      engine.executeStep(executionId, { unexpected: true }, undefined, attemptIdOf(task)),
    );
    expect(rejected).toContain("VALIDATION ERROR");

    const diagnosis = (
      await requestContext.run({ userId: USER_ID }, () =>
        getSessionInfo({ action: "diagnose", executionId }),
      )
    ).data as ContinuationDiagnosis;
    expect(diagnosis.continuable).toBe(true);
    expect(diagnosis.causes.map((cause) => cause.kind)).toContain("recorded_error");
    const recovery = await recover(executionId, "task", { target: "staging" });
    expect(recovery.success).toBe(false);
    expect(recovery.error).toContain("can continue without repair");
  });

  test("an expression failure the agent can fix in its answer does not unlock recovery", async () => {
    const base = workflow("recovery-answer-fixable");
    const saved = await getWorkflowService().save({
      graph: {
        ...base,
        variableRegistry: {
          divisor: { type: "number", description: "Optional answer input" },
          result: { type: "number", description: "Computed result" },
        },
        nodes: base.nodes.map((node) =>
          node.id === "task"
            ? {
                ...node,
                inputSchema: {
                  type: "object",
                  properties: { divisor: { type: "number" } },
                  additionalProperties: false,
                },
                expressions: ["result = 12 / divisor"],
              }
            : node,
        ),
      },
      userId: USER_ID,
      visibility: "private",
    });
    const repository = new DatabaseRepository();
    const stored = (await repository.getWorkflowGraph(saved.id, USER_ID))!;
    const engine = MCPEngine.getInstance(repository);
    const executionId = await engine.executor.startWorkflow(stored, undefined, USER_ID);
    await engine.executor.executeStep(executionId, undefined, undefined, {
      userId: USER_ID,
      createPresentation: true,
    });
    const task = await requestContext.run({ userId: USER_ID }, () =>
      engine.getCurrentStep(executionId),
    );
    const rejected = await requestContext.run({ userId: USER_ID }, () =>
      engine.executeStep(executionId, {}, undefined, attemptIdOf(task)),
    );
    expect(rejected).toContain("Variable 'divisor' is not defined or is null");

    const diagnosis = (
      await requestContext.run({ userId: USER_ID }, () =>
        getSessionInfo({ action: "diagnose", executionId }),
      )
    ).data as ContinuationDiagnosis;
    expect(diagnosis.continuable).toBe(true);
    const recovery = await recover(executionId, "task", { divisor: 2 });
    expect(recovery.success).toBe(false);

    const corrected = await requestContext.run({ userId: USER_ID }, () =>
      engine.executeStep(executionId, { divisor: 2 }, undefined, attemptIdOf(rejected)),
    );
    expect(corrected).toContain("Review the work");
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

  test("a refused recovery is audited as a refusal, with the reason", async () => {
    // The refusal changed nothing, which is why it is worth recording: repeated refusals on one
    // execution are what a reader looking for misuse of a privileged action would search for, and a
    // trail holding only the successes cannot show them.
    const { executionId } = await pausedRun("recovery-refusal-audited");

    await recover(executionId, "review", { target: "staging" });

    const logs = await new AuditRepository(getDatabase()).list({
      action: AuditAction.EXECUTION_RECOVER,
    });
    const entry = logs.find((log) => log.resourceId === executionId);
    expect(entry).toBeDefined();
    expect(JSON.stringify(entry ?? {})).toContain("run_not_broken");
  });

  test("another owner's execution is refused and nothing about it is revealed", async () => {
    const { executionId } = await pausedRun("recovery-foreign-owner");

    const result = await recover(executionId, "review", { target: "staging" }, OTHER_USER_ID);

    expect(result.success).toBe(false);
    expect(result.data).toBeUndefined();
    expect(result.error).not.toContain("review");
  });
});
