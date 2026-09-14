/**
 * Integration tests for human-readable agent message functionality
 * Tests formatted agent messages through the MCPEngine and a real (test) database
 */

import { describe, test, expect, beforeAll, afterAll } from "@jest/globals";
import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { getDatabase, getWorkflowService, user } from "@mcp-moira/shared";
import { DatabaseRepository, type WorkflowGraph } from "@mcp-moira/workflow-engine";
import { MCPEngine, type MCPEngineClass } from "../../packages/mcp-server/src/core/mcp-engine.js";
import { runWithMCPContext } from "../../packages/mcp-server/src/core/request-context.js";

const TEST_USER_ID = `agent-message-${Date.now()}`;
const FIXTURE_PATH = "./tests/workflows/simple-linear-test.json";

// Helper functions to parse string responses
function parseProcessId(response: string): string {
  const match = response.match(/Process ID: ([^\n]+)/);
  if (!match) {
    throw new Error("Process ID not found in response");
  }
  return match[1];
}

function parseDirective(response: string): string | null {
  const match = response.match(/Your next task: ([^\n]+)/);
  return match ? match[1] : null;
}

function parseCompletionCondition(response: string): string | null {
  const match = response.match(/Success criteria: ([^\n]+)/);
  return match ? match[1] : null;
}

describe("Agent Message Enhancement Integration Tests", () => {
  const repository = new DatabaseRepository();
  let engine: MCPEngineClass;
  let workflowId: string;
  const executionIds: string[] = [];

  beforeAll(async () => {
    const now = new Date().toISOString();
    await getDatabase()
      .insert(user)
      .values({
        id: TEST_USER_ID,
        email: `${TEST_USER_ID}@test.invalid`,
        name: "Agent Message Test User",
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
    engine = MCPEngine.getInstance(repository);
  });

  afterAll(async () => {
    for (const executionId of executionIds) {
      await repository.deleteExecution(executionId);
    }
    await repository.deleteWorkflow(workflowId, TEST_USER_ID);
    await getDatabase().delete(user).where(eq(user.id, TEST_USER_ID));
    MCPEngine.resetInstance();
  });

  async function startExecution(): Promise<string> {
    const response = await runWithMCPContext({ userId: TEST_USER_ID }, () =>
      engine.startWorkflow(workflowId),
    );
    executionIds.push(parseProcessId(response));
    return response;
  }

  function executeStep(processId: string, input: unknown): Promise<string> {
    return runWithMCPContext({ userId: TEST_USER_ID }, () =>
      engine.executeStep(processId, input, undefined),
    );
  }

  test("formats the first directive with task, success criteria and input schema", async () => {
    const response = await startExecution();

    expect(response).toContain("Process ID:");
    expect(parseDirective(response)).toBe("ПЕРВЫЙ ШАГ: Введи свое имя");
    expect(parseCompletionCondition(response)).toBe("Имя получено");
    // step1 declares an inputSchema, so the formatted message must render it
    expect(response).toContain("Input Schema:");
    expect(response).toContain("```json");
  });

  test("processes agent input and formats the next directive", async () => {
    const processId = parseProcessId(await startExecution());

    const stepResult = await executeStep(processId, { name: "Test User" });

    expect(parseDirective(stepResult)).toBe("ВТОРОЙ ШАГ: Поприветствуй пользователя по имени");
    expect(parseCompletionCondition(stepResult)).toBe("Приветствие сделано");
  });

  test("keeps message formatting through a complete workflow cycle", async () => {
    const processId = parseProcessId(await startExecution());

    const step1Result = await executeStep(processId, { name: "Integration Test User" });
    const step2Result = await executeStep(processId, { greeting: "Hello there!" });
    const step3Result = await executeStep(processId, { farewell: "Goodbye!" });

    expect(parseDirective(step1Result)).toContain("ВТОРОЙ ШАГ");
    expect(parseCompletionCondition(step1Result)).toBe("Приветствие сделано");
    expect(parseDirective(step2Result)).toContain("ТРЕТИЙ ШАГ");
    expect(parseCompletionCondition(step2Result)).toBe("Прощание сделано");
    expect(step3Result).toContain("Workflow completed successfully");
  });
});
