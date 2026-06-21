/**
 * Validation Loop Tests - Creator-Validator Pattern
 * Tests improvement cycles with feedback loops
 */

import { describe, test, expect } from "@jest/globals";

describe("Validation Loop Pattern", () => {
  test("should complete validation loop with high score (single iteration)", async () => {
    const { repository, executor } = await createTestExecutor();

    const workflow = await repository.getWorkflowGraph("validation-loop-test", TEST_USER_ID);
    if (!workflow) throw new Error("validation-loop-test workflow not found");

    const executionId = await executor.startWorkflow(workflow, undefined, TEST_USER_ID);

    // Step 1: Creator directive
    const step1 = await executor.executeStep(executionId);
    expect(step1).toContain("Create a simple add function");

    // Step 2: Provide good code
    const step2 = await executor.executeStep(executionId, {
      code: "function add(a: number, b: number): number { return a + b; }",
      description: "Perfect function",
    });
    expect(step2).toContain(
      "Score the function 0-10. Scoring Criteria: Correctness (5pts), simplicity (5pts)",
    );
    expect(step2).toContain("Scoring Criteria");

    // Step 3: Validator gives high score → completion
    const step3 = await executor.executeStep(executionId, {
      score: 9,
      feedback: "Excellent function!",
    });
    expect(step3).toContain("Workflow completed successfully");
    const finalState = await executor.getExecutionState(executionId);
    expect(finalState?.globalContext.variables.code).toBe(
      "function add(a: number, b: number): number { return a + b; }",
    );
    expect(finalState?.globalContext.variables.score).toBe(9);
    expect(finalState?.globalContext.variables.feedback).toBe("Excellent function!");
  });

  test("should handle multiple iterations with improvement feedback", async () => {
    const { repository, executor } = await createTestExecutor();

    const workflow = await repository.getWorkflowGraph("validation-loop-test", TEST_USER_ID);
    if (!workflow) throw new Error("validation-loop-test workflow not found");

    const executionId = await executor.startWorkflow(workflow, undefined, TEST_USER_ID);

    // Step 1: Creator directive
    await executor.executeStep(executionId);

    // Step 2: Provide basic code
    const _step2 = await executor.executeStep(executionId, {
      code: "function add(a,b) { return a+b; }",
      description: "Basic function",
    });

    // Step 3: Validator gives low score → improvement needed
    const step3 = await executor.executeStep(executionId, {
      score: 5,
      feedback: "Missing type annotations",
    });
    expect(step3).toContain("Improve the function: Missing type annotations");
    expect(step3).toContain("Missing type annotations");

    // Step 4: Creator provides improved code
    const step4 = await executor.executeStep(executionId, {
      code: "function add(a: number, b: number): number { return a + b; }",
      description: "Typed function",
    });
    expect(step4).toContain(
      "Score the function 0-10. Scoring Criteria: Correctness (5pts), simplicity (5pts)",
    );

    // Step 5: Validator gives high score → completion
    const step5 = await executor.executeStep(executionId, {
      score: 9,
      feedback: "Perfect with types!",
    });
    expect(step5).toContain("Workflow completed successfully");
  });
});
