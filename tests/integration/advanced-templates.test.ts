/**
 * Advanced Templates Test - Variable Flow Between Steps
 * Tests template processing with variable setting and reading
 */

import { describe, test, expect } from "@jest/globals";

describe("Advanced Template Processing", () => {
  test("should process all template functions with variable flow", async () => {
    const { executor, repository } = await createTestExecutor();

    const workflow = await repository.getWorkflowGraph("advanced-templates-test", TEST_USER_ID);
    if (!workflow) throw new Error("advanced-templates-test workflow not found");

    const executionId = await executor.startWorkflow(workflow, undefined, TEST_USER_ID);

    // Step 1: Set variables directive
    const step1 = await executor.executeStep(executionId);
    expect(step1).toContain(
      "Set project variables: feature name, iteration counter, and user data",
    );

    // Step 2: Provide complex data structure
    const testData = {
      feature_name: "node-graph-refactor",
      iteration_counter: 3,
      max_allowed_iterations: 5,
      user: {
        name: "TestUser",
        email: "test@example.com",
      },
      config: {
        api: {
          key: "secret-key-123",
          timeout: 5000,
        },
        debug: true,
      },
      // Note: only fields defined in inputSchema are allowed (strict validation)
    };

    const step2 = await executor.executeStep(executionId, testData);

    // Step 3: Verify simple variable templates {{variableName}} (improved format without quotes)
    expect(step2).toContain(
      "Reading simple variables: Feature=node-graph-refactor, Counter=3, Max=5",
    );
    expect(step2).toContain("Feature=node-graph-refactor");
    expect(step2).toContain("Counter=3");
    expect(step2).toContain("Max=5");

    const step3 = await executor.executeStep(executionId, { acknowledged: true });

    // Step 4: Verify context dump {{context.variables}}
    expect(step3).toContain('"feature_name":"node-graph-refactor"');
    expect(step3).toContain('"iteration_counter":3');
    expect(step3).toContain('"user":{"name":"TestUser"');

    const step4 = await executor.executeStep(executionId, { acknowledged: true });

    // Step 5: Verify nested path templates {{nested.path}} (improved format without quotes)
    expect(step4).toContain(
      "Nested data: User name=TestUser, User email=test@example.com, API key=secret-key-123",
    );
    expect(step4).toContain("User name=TestUser");
    expect(step4).toContain("User email=test@example.com");
    expect(step4).toContain("API key=secret-key-123");

    const step5 = await executor.executeStep(executionId, { acknowledged: true });

    // Step 6: Verify mixed templates in complex sentence (improved format without quotes)
    expect(step5).toContain(
      "Mixed templates: Working on node-graph-refactor iteration 3 of 5 for user TestUser (test@example.com) using API secret-key-123",
    );
    expect(step5).toContain("Working on node-graph-refactor");
    expect(step5).toContain("iteration 3 of 5");
    expect(step5).toContain("for user TestUser");
    expect(step5).toContain("using API secret-key-123");

    // Final step: Workflow completion
    const step6 = await executor.executeStep(executionId, { acknowledged: true });
    expect(step6).toContain("Workflow completed successfully");

    // Verify final context preserved all data
    const finalState = await executor.getExecutionState(executionId);
    expect(finalState?.globalContext.variables.feature_name).toBe("node-graph-refactor");
    expect(finalState?.globalContext.variables.iteration_counter).toBe(3);
    expect((finalState?.globalContext.variables.user as any)?.name).toBe("TestUser");
    expect((finalState?.globalContext.variables.user as any)?.email).toBe("test@example.com");
    expect((finalState?.globalContext.variables.config as any)?.api?.key).toBe("secret-key-123");
    expect((finalState?.globalContext.variables.config as any)?.api?.timeout).toBe(5000);
    expect((finalState?.globalContext.variables.config as any)?.debug).toBe(true);
  });

  test("should process template variables with different data sets", async () => {
    const { executor, repository } = await createTestExecutor();

    const workflow = await repository.getWorkflowGraph("advanced-templates-test", TEST_USER_ID);
    if (!workflow) throw new Error("advanced-templates-test workflow not found");

    const executionId = await executor.startWorkflow(workflow, undefined, TEST_USER_ID);

    await executor.executeStep(executionId);

    // Test with alternative data set
    const testData = {
      feature_name: "auth-system",
      iteration_counter: 2,
      max_allowed_iterations: 4,
      user: { name: "Test User", email: "test@test.com" },
      config: { api: { key: "test-key" } },
      // Note: only fields defined in inputSchema are allowed
    };

    const step2 = await executor.executeStep(executionId, testData);

    // Verify template variables are correctly substituted
    expect(step2).toContain("Feature=auth-system");
    expect(step2).toContain("Counter=2");

    // Verify context dump works
    const step3 = await executor.executeStep(executionId, { acknowledged: true });
    expect(step3).toContain('"feature_name":"auth-system"');
  });
});
