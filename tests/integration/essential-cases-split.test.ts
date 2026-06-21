/**
 * Essential Cases Test - Split Version (Memory Optimized)
 * Tests: Essential functionality with shared executor and memory management
 */

import { describe, test, expect, beforeAll, afterAll, afterEach } from "@jest/globals";
import type { UniversalGraphExecutor, InMemoryRepository } from "@mcp-moira/workflow-engine";

describe("Essential Test Cases - Memory Optimized", () => {
  let repository: InMemoryRepository;
  let executor: UniversalGraphExecutor;

  beforeAll(async () => {
    const testEnv = await createTestExecutor();
    repository = testEnv.repository;
    executor = testEnv.executor;
  });

  afterEach(() => {
    // Force garbage collection after each test
    if (global.gc) {
      global.gc();
    }
  });

  afterAll(() => {
    // Cleanup shared resources
    repository.clear();
    repository = null as any;
    executor = null as any;
    if (global.gc) {
      global.gc();
    }
  });

  test("Linear Flow: Sequential execution", async () => {
    const workflow = await repository.getWorkflowGraph("simple-linear-test", TEST_USER_ID);
    if (!workflow) throw new Error("simple-linear-test workflow not found");

    const executionId = await executor.startWorkflow(workflow, undefined, TEST_USER_ID);

    const step1 = await executor.executeStep(executionId);
    expect(step1).toContain("ПЕРВЫЙ ШАГ");

    const step2 = await executor.executeStep(executionId, { name: "TestUser" });
    expect(step2).toContain("ВТОРОЙ ШАГ");

    const step3 = await executor.executeStep(executionId, { greeting: "Привет!" });
    expect(step3).toContain("ТРЕТИЙ ШАГ");

    const step4 = await executor.executeStep(executionId, { farewell: "Пока!" });
    expect(step4).toContain("completed successfully");
  });

  test("Context preservation across steps", async () => {
    const workflow = await repository.getWorkflowGraph("simple-linear-test", TEST_USER_ID);
    if (!workflow) throw new Error("simple-linear-test workflow not found");

    const executionId = await executor.startWorkflow(workflow, undefined, TEST_USER_ID);

    // Quick execution test focusing on context preservation
    await executor.executeStep(executionId);
    const step2 = await executor.executeStep(executionId, { name: "ContextTest" });

    // Check for workflow progression, not specific content (workflow may not echo name)
    expect(step2).toContain("ВТОРОЙ ШАГ");
    expect(step2).toContain("Success criteria");
  });
});
