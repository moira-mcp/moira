import { afterEach, beforeAll, describe, expect, test } from "@jest/globals";
import { randomUUID } from "node:crypto";
import { getDatabase, getWorkflowService, user } from "@mcp-moira/shared";
import {
  DatabaseRepository,
  type ContinuationDiagnosis,
  type ContinuationRecoveryResult,
  type WorkflowGraph,
} from "@mcp-moira/workflow-engine";
import { MCPEngine } from "../../packages/mcp-server/src/core/mcp-engine.js";
import { requestContext } from "../../packages/mcp-server/src/core/request-context.js";
import { getSessionInfo } from "../../packages/mcp-server/src/tools/get-session-info.js";

const OWNER = "workflow-history-continuation";

function graph(name: string, task: string, review: string): WorkflowGraph {
  return {
    metadata: { name, version: "1.0.0", description: "Owned history continuation fixture" },
    nodes: [
      { type: "start", id: "start", connections: { default: "task" } },
      {
        type: "agent-directive",
        id: "task",
        directive: task,
        completionCondition: "Task completed",
        inputSchema: { type: "object", properties: {} },
        connections: { success: "review" },
      },
      {
        type: "agent-directive",
        id: "review",
        directive: review,
        completionCondition: "Review completed",
        inputSchema: { type: "object", properties: {} },
        connections: { success: "end" },
      },
      { type: "end", id: "end" },
    ],
  };
}

function attempt(presentation: string): string {
  const found = presentation.match(/Step attempt ID:\s*([a-f0-9-]+)/i);
  if (!found) throw new Error("The actual step did not return its attempt identity");
  return found[1];
}

function asOwner<T>(work: () => T): T {
  return requestContext.run({ userId: OWNER }, work);
}

async function pausedOnCurrentDefinition(changedTask: boolean) {
  const name = `History continuation ${randomUUID().slice(0, 8)}`;
  const service = getWorkflowService();
  const old = await service.save({
    graph: graph(name, "Historical task", "Historical review"),
    userId: OWNER,
    visibility: "private",
  });
  const current = await service.save({
    graph: {
      ...graph(name, changedTask ? "Current task" : "Historical task", "Current review"),
      id: old.id,
    },
    userId: OWNER,
    expectedRevision: old.revision,
  });
  const repository = new DatabaseRepository();
  const stored = await repository.getWorkflowGraph(current.id, OWNER);
  if (!stored) throw new Error("The owned saved workflow is missing");
  const engine = MCPEngine.getInstance(repository);
  const executionId = await engine.executor.startWorkflow(stored, undefined, OWNER);
  await engine.executor.executeStep(executionId, undefined, undefined, {
    userId: OWNER,
    createPresentation: true,
  });
  const presentation = await asOwner(() => engine.getCurrentStep(executionId));
  return { service, repository, engine, old, current, executionId, presentation };
}

describe("continuing existing runs after restoring workflow content history", () => {
  beforeAll(async () => {
    const now = new Date().toISOString();
    await getDatabase()
      .insert(user)
      .values({
        id: OWNER,
        email: `${OWNER}@example.test`,
        handle: OWNER,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing();
  });

  afterEach(() => MCPEngine.resetInstance());

  test("a compatible restore keeps the presented step usable and executes the restored future step", async () => {
    const f = await pausedOnCurrentDefinition(false);
    await f.service.rollback(f.current.id, OWNER, f.old.historyRevision, f.current.revision);

    const diagnosis = await asOwner(() =>
      getSessionInfo({ action: "diagnose", executionId: f.executionId }),
    );
    expect(diagnosis.success).toBe(true);
    expect((diagnosis.data as ContinuationDiagnosis).continuable).toBe(true);

    const review = await asOwner(() =>
      f.engine.executeStep(f.executionId, {}, undefined, attempt(f.presentation)),
    );
    expect(review).toContain("Historical review");
    expect(review).not.toContain("Current review");
    const finished = await asOwner(() =>
      f.engine.executeStep(f.executionId, {}, undefined, attempt(review)),
    );
    expect(finished).toContain("completed");
    expect((await f.repository.getExecution(f.executionId))?.status).toBe("completed");
  });

  test("an incompatible restore requires diagnosis and explicit recovery before that same run continues", async () => {
    const f = await pausedOnCurrentDefinition(true);
    await f.service.rollback(f.current.id, OWNER, f.old.historyRevision, f.current.revision);

    const result = await asOwner(() =>
      getSessionInfo({ action: "diagnose", executionId: f.executionId }),
    );
    expect(result.success).toBe(true);
    const diagnosis = result.data as ContinuationDiagnosis;
    expect(diagnosis.continuable).toBe(false);
    expect(diagnosis.attempt?.boundToCurrentDefinition).toBe(false);
    expect(diagnosis.causes).toContainEqual(
      expect.objectContaining({
        kind: "continuation_changed",
        blocks: true,
        changed: ["node.directive"],
      }),
    );

    const recovery = await asOwner(() =>
      getSessionInfo({ action: "recover", executionId: f.executionId, nodeId: "review" }),
    );
    expect({ success: recovery.success, error: recovery.error }).toEqual({
      success: true,
      error: undefined,
    });
    const recovered = recovery.data as ContinuationRecoveryResult;
    expect(recovered.presentation).toContain("Historical review");
    const finished = await asOwner(() =>
      f.engine.executeStep(f.executionId, {}, undefined, attempt(recovered.presentation)),
    );
    expect(finished).toContain("completed");
    expect((await f.repository.getExecution(f.executionId))?.status).toBe("completed");
  });
});
