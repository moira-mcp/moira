/**
 * Integration tests for input enhancement functionality
 * Tests parseInputData at the execute_step tool boundary against a real (test) database:
 * JSON strings, objects, primitives, malformed strings and null must all reach schema validation.
 */

import { describe, test, expect, beforeAll, afterAll } from "@jest/globals";
import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { getDatabase, getWorkflowService, user } from "@mcp-moira/shared";
import { DatabaseRepository, type WorkflowGraph } from "@mcp-moira/workflow-engine";
import { MCPEngine } from "../../packages/mcp-server/src/core/mcp-engine.js";
import { runWithMCPContext } from "../../packages/mcp-server/src/core/request-context.js";
import { executeStep } from "../../packages/mcp-server/src/tools/execute-step.js";
import { startWorkflow } from "../../packages/mcp-server/src/tools/start-workflow.js";

const TEST_USER_ID = `input-enhancement-${Date.now()}`;
const FIXTURE_PATH = "./tests/workflows/simple-linear-test.json";

function requiredId(response: string, label: "Process" | "Step attempt"): string {
  const id = response.match(new RegExp(`${label} ID:\\s*([a-f0-9-]+)`, "i"))?.[1];
  if (!id) throw new Error(`${label} ID missing from response: ${response}`);
  return id;
}

describe("Input Enhancement Integration Tests", () => {
  const repository = new DatabaseRepository();
  let workflowId: string;
  const executionIds: string[] = [];

  beforeAll(async () => {
    const now = new Date().toISOString();
    await getDatabase()
      .insert(user)
      .values({
        id: TEST_USER_ID,
        email: `${TEST_USER_ID}@test.invalid`,
        name: "Input Enhancement Test User",
        handle: TEST_USER_ID,
        emailVerified: true,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing();

    const graph = JSON.parse(readFileSync(FIXTURE_PATH, "utf-8")) as WorkflowGraph;
    const saved = await getWorkflowService().save({
      graph,
      userId: TEST_USER_ID,
      visibility: "private",
    });
    workflowId = saved.id;
    MCPEngine.getInstance(repository);
  });

  afterAll(async () => {
    for (const executionId of executionIds) {
      await repository.deleteExecution(executionId);
    }
    await repository.deleteWorkflow(workflowId, TEST_USER_ID);
    await getDatabase().delete(user).where(eq(user.id, TEST_USER_ID));
    MCPEngine.resetInstance();
  });

  /** Start a fresh execution paused at step1 (requires { name }) and return its ids */
  async function startAtStep1(): Promise<{ processId: string; attemptId: string }> {
    const started = await runWithMCPContext({ userId: TEST_USER_ID }, () =>
      startWorkflow({ workflowId, parentExecutionId: "none" }),
    );
    expect(started.success).toBe(true);
    const processId = requiredId(String(started.data), "Process");
    executionIds.push(processId);
    return { processId, attemptId: requiredId(String(started.data), "Step attempt") };
  }

  function step(processId: string, attemptId: string, input: unknown) {
    return runWithMCPContext({ userId: TEST_USER_ID }, () =>
      executeStep({ processId, attemptId, input }),
    );
  }

  test("parses a JSON string input and advances the workflow", async () => {
    const { processId, attemptId } = await startAtStep1();

    const result = await step(processId, attemptId, '{"name": "Integration Test User"}');

    expect(result.success).toBe(true);
    expect(result.data).toContain("Your next task: ВТОРОЙ ШАГ");
    await expect(repository.getExecution(processId)).resolves.toMatchObject({
      currentNodeId: "step2",
    });
  });

  test("accepts a direct object input and advances the workflow", async () => {
    const { processId, attemptId } = await startAtStep1();

    const result = await step(processId, attemptId, { name: "Direct Object User" });

    expect(result.success).toBe(true);
    expect(result.data).toContain("Your next task: ВТОРОЙ ШАГ");
    await expect(repository.getExecution(processId)).resolves.toMatchObject({
      currentNodeId: "step2",
    });
  });

  test.each<[string, unknown]>([
    ["nested object without the required field", { data: { user: "Test User" } }],
    ["primitive number", 42],
    ["malformed JSON string", "invalid { json"],
    ["null", null],
  ])("rejects %s against the step schema and keeps the execution paused", async (_label, input) => {
    const { processId, attemptId } = await startAtStep1();

    const result = await step(processId, attemptId, input);

    // parseInputData normalised the value into an object that lacks `name`; schema validation
    // answers with feedback (success stays true) and the execution remains on step1
    expect(result.success).toBe(true);
    expect(result.data).toMatch(/name/);
    expect(result.data).not.toContain("ВТОРОЙ ШАГ");
    await expect(repository.getExecution(processId)).resolves.toMatchObject({
      currentNodeId: "step1",
    });
  });
});
