import { beforeAll, afterEach, describe, expect, test } from "@jest/globals";
import { getDatabase, getWorkflowService, user } from "@mcp-moira/shared";
import {
  DatabaseRepository,
  type ContinuationCause,
  type ContinuationDiagnosis,
  type WorkflowGraph,
} from "@mcp-moira/workflow-engine";
import { MCPEngine } from "../../packages/mcp-server/src/core/mcp-engine.js";
import { requestContext } from "../../packages/mcp-server/src/core/request-context.js";
import { getSessionInfo } from "../../packages/mcp-server/src/tools/get-session-info.js";

const USER_ID = "continuation-diagnosis-user";
const OTHER_USER_ID = "continuation-diagnosis-other-user";

function workflow(name: string): WorkflowGraph {
  return {
    metadata: { name, version: "1.0.0", description: "Diagnosis test" },
    variableRegistry: {
      target: { type: "string", description: "Where the work lands" },
    },
    nodes: [
      { type: "start", id: "start", connections: { default: "task" } },
      {
        type: "agent-directive",
        id: "task",
        directive: "Do the work",
        completionCondition: "Done",
        inputSchema: {
          type: "object",
          properties: { summary: { type: "string" } },
          globalInputs: ["target"],
        },
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
    .values({
      id,
      email: `${id}@example.test`,
      handle: id,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing();
}

/** Start a run and leave it paused on `task` with a presented attempt, as an agent would find it. */
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
  return { repository, workflowId: saved.id, stored, executionId };
}

async function diagnose(executionId: string, asUser = USER_ID) {
  return requestContext.run({ userId: asUser }, () =>
    getSessionInfo({ action: "diagnose", executionId }),
  );
}

function causeKinds(diagnosis: ContinuationDiagnosis): string[] {
  return diagnosis.causes.map((cause: ContinuationCause) => cause.kind);
}

describe("diagnosing why a paused run cannot continue", () => {
  beforeAll(async () => {
    await createUser(USER_ID);
    await createUser(OTHER_USER_ID);
  });

  afterEach(() => MCPEngine.resetInstance());

  test("a healthy paused run reports itself continuable and names no cause", async () => {
    const { executionId } = await pausedRun("diagnosis-healthy");

    const result = await diagnose(executionId);
    const diagnosis = result.data as ContinuationDiagnosis;

    expect(result.success).toBe(true);
    expect(diagnosis.continuable).toBe(true);
    expect(diagnosis.causes).toEqual([]);
    expect(diagnosis.currentNodeId).toBe("task");
    expect(diagnosis.currentNodeExists).toBe(true);
    expect(diagnosis.attempt?.boundToCurrentDefinition).toBe(true);
  });

  test("a metadata-only redeploy still reports the run continuable", async () => {
    const { repository, stored, executionId } = await pausedRun("diagnosis-metadata-only");
    await repository.saveWorkflow(
      { ...stored, metadata: { ...stored.metadata, version: "2.0.0", tags: ["reorganised"] } },
      USER_ID,
    );

    const diagnosis = (await diagnose(executionId)).data as ContinuationDiagnosis;

    expect(diagnosis.continuable).toBe(true);
    expect(diagnosis.causes).toEqual([]);
  });

  test.each([
    ["node.directive", (node: Record<string, unknown>) => (node.directive = "Do other work")],
    [
      "node.completionCondition",
      (node: Record<string, unknown>) => (node.completionCondition = "Something else"),
    ],
    [
      "node.inputSchema",
      (node: Record<string, unknown>) => {
        (node.inputSchema as { properties: Record<string, unknown> }).properties.extra = {
          type: "string",
        };
      },
    ],
    [
      "node.connections",
      (node: Record<string, unknown>) => (node.connections = { success: "start" }),
    ],
  ])("names %s as the fact that changed, not a generic mismatch", async (fact, mutate) => {
    const { repository, stored, executionId } = await pausedRun(`diagnosis-${fact}`);
    const changed = structuredClone(stored);
    mutate(changed.nodes.find((node) => node.id === "task")! as unknown as Record<string, unknown>);
    await repository.saveWorkflow(changed, USER_ID);

    const diagnosis = (await diagnose(executionId)).data as ContinuationDiagnosis;

    expect(diagnosis.continuable).toBe(false);
    const cause = diagnosis.causes.find((entry) => entry.kind === "continuation_changed");
    expect(cause).toBeDefined();
    expect(cause && "changed" in cause ? cause.changed : []).toEqual([fact]);
    expect(diagnosis.attempt?.boundToCurrentDefinition).toBe(false);
  });

  test("names the registry entry the paused node declares when only that entry changed", async () => {
    const { repository, stored, executionId } = await pausedRun("diagnosis-registry");
    await repository.saveWorkflow(
      {
        ...stored,
        variableRegistry: {
          target: { type: "string", description: "Where the work lands", enum: ["a", "b"] },
        },
      },
      USER_ID,
    );

    const diagnosis = (await diagnose(executionId)).data as ContinuationDiagnosis;

    const cause = diagnosis.causes.find((entry) => entry.kind === "continuation_changed");
    expect(cause && "changed" in cause ? cause.changed : []).toEqual(["registry.target"]);
  });

  test("reports the paused node as absent when it was deleted", async () => {
    const { repository, stored, executionId } = await pausedRun("diagnosis-deleted-node");
    await repository.saveWorkflow(
      {
        ...stored,
        nodes: [
          { type: "start", id: "start", connections: { default: "end" } },
          { type: "end", id: "end" },
        ],
      },
      USER_ID,
    );

    const diagnosis = (await diagnose(executionId)).data as ContinuationDiagnosis;

    expect(diagnosis.currentNodeExists).toBe(false);
    expect(causeKinds(diagnosis)).toContain("node_missing");
    expect(diagnosis.continuable).toBe(false);
  });

  test("names a reference the presented step cannot resolve from the context", async () => {
    const { repository, stored, executionId } = await pausedRun("diagnosis-unresolved-reference");
    const changed = structuredClone(stored);
    const node = changed.nodes.find((candidate) => candidate.id === "task")! as unknown as {
      directive: string;
    };
    node.directive = "Do the work in {{deploymentTarget}}";
    await repository.saveWorkflow(changed, USER_ID);

    const diagnosis = (await diagnose(executionId)).data as ContinuationDiagnosis;

    const cause = diagnosis.causes.find((entry) => entry.kind === "unresolved_references");
    expect(cause && "references" in cause ? cause.references : []).toEqual(["deploymentTarget"]);
  });

  test("reports a recorded execution error", async () => {
    const { repository, executionId } = await pausedRun("diagnosis-recorded-error");
    await repository.appendError(executionId, {
      timestamp: Date.now(),
      nodeId: "task",
      errorType: "validation",
      message: "the agent answered with the wrong shape",
    });

    const diagnosis = (await diagnose(executionId)).data as ContinuationDiagnosis;

    const cause = diagnosis.causes.find((entry) => entry.kind === "recorded_error");
    expect(cause && "message" in cause ? cause.message : "").toBe(
      "the agent answered with the wrong shape",
    );
    expect(cause?.blocks).toBe(false);
    expect(diagnosis.continuable).toBe(true);
  });

  test("refuses another owner's execution and reveals nothing about it", async () => {
    const { executionId } = await pausedRun("diagnosis-foreign-owner");

    const result = await diagnose(executionId, OTHER_USER_ID);

    expect(result.success).toBe(false);
    expect(result.data).toBeUndefined();
    expect(result.error).not.toContain("task");
    expect(result.error).not.toContain("Do the work");
  });
});
