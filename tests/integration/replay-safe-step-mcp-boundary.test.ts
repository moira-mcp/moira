import { afterEach, describe, expect, test } from "@jest/globals";
import { InMemoryRepository, type WorkflowGraph } from "@mcp-moira/workflow-engine";
import { MCPEngine } from "../../packages/mcp-server/src/core/mcp-engine.js";
import { requestContext } from "../../packages/mcp-server/src/core/request-context.js";
import { executeStep } from "../../packages/mcp-server/src/tools/execute-step.js";

const USER_ID = "replay-boundary-user";

describe("replay-safe step MCP boundary", () => {
  afterEach(() => MCPEngine.resetInstance());

  test("parses input, carries the attempt, replays exactly, and formats conflicts as MCP errors", async () => {
    const repository = new InMemoryRepository();
    const graph: WorkflowGraph = {
      id: "replay-boundary-workflow",
      metadata: { name: "Boundary", version: "1.0.0", description: "Boundary test" },
      nodes: [
        { type: "start", id: "start", connections: { default: "task" } },
        {
          type: "agent-directive",
          id: "task",
          directive: "Provide answer",
          completionCondition: "Answer provided",
          inputSchema: {
            type: "object",
            properties: { answer: { type: "string" } },
            required: ["answer"],
            additionalProperties: false,
          },
          connections: { success: "end" },
        },
        { type: "end", id: "end" },
      ],
    };
    await repository.saveWorkflow(graph, USER_ID);
    const engine = MCPEngine.getInstance(repository);
    const executionId = await engine.executor.startWorkflow(graph, undefined, USER_ID);
    const presentation = await engine.executor.executeStep(executionId, undefined, undefined, {
      userId: USER_ID,
      createPresentation: true,
    });
    const attemptId = presentation.match(/Step attempt ID:\s*([a-f0-9-]+)/i)?.[1];
    expect(attemptId).toBeDefined();

    const preHotfixMetadataState = (await repository.getExecution(executionId))!;
    preHotfixMetadataState.note = "metadata changed by an older server";
    await repository.saveExecution(preHotfixMetadataState);
    const stale = await requestContext.run({ userId: USER_ID }, () =>
      executeStep({ processId: executionId, attemptId: attemptId!, input: { answer: "ok" } }),
    );
    expect(stale.success).toBe(false);
    expect(stale.error).toContain("ATTEMPT_STALE");
    expect(stale.error).toContain("session({ action: 'current_step'");
    expect(stale.error?.toLowerCase()).not.toContain("stop");
    const recovered = await requestContext.run({ userId: USER_ID }, () =>
      engine.getCurrentStep(executionId),
    );
    const recoveredAttemptId = recovered.match(/Step attempt ID:\s*([a-f0-9-]+)/i)?.[1];
    expect(recoveredAttemptId).toBe(attemptId);

    const original = await requestContext.run({ userId: USER_ID }, () =>
      executeStep({
        processId: executionId,
        attemptId: recoveredAttemptId!,
        input: "{answer: 'ok'}",
      }),
    );
    expect(original).toEqual(
      expect.objectContaining({ success: true, data: expect.stringContaining("completed") }),
    );
    const replay = await requestContext.run({ userId: USER_ID }, () =>
      executeStep({ processId: executionId, attemptId: attemptId!, input: { answer: "ok" } }),
    );
    expect(replay).toEqual(original);

    const conflict = await requestContext.run({ userId: USER_ID }, () =>
      executeStep({ processId: executionId, attemptId: attemptId!, input: { answer: "changed" } }),
    );
    expect(conflict.success).toBe(false);
    expect(conflict.error).toContain("ATTEMPT_CONFLICT");

    const stateBeforeEvictedRetry = await repository.getExecution(executionId);
    expect(await repository.cleanupExecutionAttempts(Date.now() + 8 * 24 * 60 * 60 * 1_000)).toBe(
      1,
    );
    expect(await repository.getExecutionAttempt(attemptId!)).toBeNull();
    const expired = await requestContext.run({ userId: USER_ID }, () =>
      executeStep({ processId: executionId, attemptId: attemptId!, input: { answer: "ok" } }),
    );
    expect(expired.success).toBe(false);
    expect(expired.error).toContain("ATTEMPT_INVALID_OR_EXPIRED");
    expect(await repository.getExecution(executionId)).toEqual(stateBeforeEvictedRetry);
  });
});
