/**
 * Workflow Execution Integration Tests
 * Tests complete workflow execution patterns (restored)
 */

import { describe, test, expect } from "@jest/globals";
import { WorkflowGraph } from "@mcp-moira/workflow-engine";
import { ConditionBuilder } from "@mcp-moira/workflow-engine";

describe("Workflow Execution Integration", () => {
  test("should execute simple linear workflow (minimal)", async () => {
    const { repository, executor } = await createTestExecutor();

    // Singleton engine already contains all handlers including subgraph

    // Create minimal workflow in code (for integration testing)
    const workflow: WorkflowGraph = {
      id: "test-minimal",
      metadata: {
        name: "Minimal Test",
        version: "1.0.0",
        description: "Minimal workflow for integration",
      },
      nodes: [
        {
          type: "start",
          id: "start",
          connections: { default: "ask-name" },
        },
        {
          type: "agent-directive",
          id: "ask-name",
          directive: "What is your name?",
          completionCondition: "Name provided",
          inputSchema: {
            type: "object",
            properties: { userName: { type: "string" } },
            required: ["userName"],
          },
          connections: { success: "end" },
        },
        {
          type: "end",
          id: "end",
          finalOutput: ["userName"],
        },
      ],
    };

    await repository.saveWorkflow(workflow, TEST_USER_ID);
    const executionId = await executor.startWorkflow(workflow, undefined, TEST_USER_ID);

    const step1 = await executor.executeStep(executionId);
    expect(step1).toContain("What is your name?");

    const step2 = await executor.executeStep(executionId, { userName: "TestUser" });
    expect(step2).toContain("Workflow completed successfully");
  });

  test("should execute conditional workflow with branching", async () => {
    const { repository, executor } = await createTestExecutor();

    // Conditional workflow with both branches
    const workflow: WorkflowGraph = {
      id: "test-branching",
      metadata: {
        name: "Branching Test",
        version: "1.0.0",
        description: "Test conditional branching",
      },
      variableRegistry: {
        score: {
          type: "number",
          description: "Test score produced by get-score, checked by the condition",
        },
      },
      nodes: [
        {
          type: "start",
          id: "start",
          connections: { default: "get-score" },
        },
        {
          type: "agent-directive",
          id: "get-score",
          directive: "Enter test score",
          completionCondition: "Score provided",
          inputSchema: {
            type: "object",
            globalInputs: ["score"],
            properties: {},
            required: ["score"],
          },
          connections: { success: "check-score" },
        },
        {
          type: "condition",
          id: "check-score",
          condition: ConditionBuilder.greaterThan(ConditionBuilder.contextPath("score"), 70),
          connections: {
            true: "congratulate",
            false: "encourage",
          },
        },
        {
          type: "agent-directive",
          id: "congratulate",
          directive: "Congratulate on excellent score",
          completionCondition: "Congratulations delivered",
          inputSchema: {
            type: "object",
            properties: { congratulation: { type: "string" } },
            additionalProperties: false,
          },
          connections: { success: "end" },
        },
        {
          type: "agent-directive",
          id: "encourage",
          directive: "Encourage to try again",
          completionCondition: "Encouragement given",
          inputSchema: {
            type: "object",
            properties: { encouragement: { type: "string" } },
            additionalProperties: false,
          },
          connections: { success: "end" },
        },
        {
          type: "end",
          id: "end",
          finalOutput: ["score"],
        },
      ],
    };

    await repository.saveWorkflow(workflow, TEST_USER_ID);

    // Test high score path
    const executionId1 = await executor.startWorkflow(workflow, undefined, TEST_USER_ID);
    const step1a = await executor.executeStep(executionId1);
    expect(step1a).toContain("Enter test score");

    const step1b = await executor.executeStep(executionId1, { score: 85 });
    expect(step1b).toContain("Congratulate on excellent score");

    const step1c = await executor.executeStep(executionId1, { congratulation: "done" });
    expect(step1c).toContain("Workflow completed successfully");

    // Test low score path
    const executionId2 = await executor.startWorkflow(workflow, undefined, TEST_USER_ID);
    await executor.executeStep(executionId2);

    const step2a = await executor.executeStep(executionId2, { score: 50 });
    expect(step2a).toContain("Encourage to try again");
  });

  test("should handle template processing in directives", async () => {
    const { repository, executor } = await createTestExecutor();

    // Template processing workflow
    const workflow: WorkflowGraph = {
      id: "test-templates",
      metadata: {
        name: "Template Test",
        version: "1.0.0",
        description: "Template processing test",
      },
      variableRegistry: {
        userName: {
          type: "string",
          description: "User name produced by get-name, used in the greeting",
        },
      },
      nodes: [
        {
          type: "start",
          id: "start",
          connections: { default: "get-name" },
        },
        {
          type: "agent-directive",
          id: "get-name",
          directive: "Enter your name",
          completionCondition: "Name provided",
          inputSchema: {
            type: "object",
            globalInputs: ["userName"],
            properties: {},
            required: ["userName"],
          },
          connections: { success: "greet" },
        },
        {
          type: "agent-directive",
          id: "greet",
          directive: "Hello {{userName}}! How are you?",
          completionCondition: "Greeting completed",
          connections: { success: "end" },
        },
        {
          type: "end",
          id: "end",
        },
      ],
    };

    await repository.saveWorkflow(workflow, TEST_USER_ID);
    const executionId = await executor.startWorkflow(workflow, undefined, TEST_USER_ID);

    await executor.executeStep(executionId);
    const step1 = await executor.executeStep(executionId, { userName: "Alice" });

    // Template should be processed: {{userName}} → Alice (improved format without quotes)
    expect(step1).toContain("Your next task: Hello Alice! How are you?");
  });

  test("declared-global node output is promoted to top level; non-declared stays node-local only", async () => {
    const { repository, executor } = await createTestExecutor();

    const workflow: WorkflowGraph = {
      id: "test-promotion",
      metadata: { name: "Promotion Test", version: "1.0.0", description: "Global promotion" },
      // Only globalOut is declared global; localOnly is not.
      variableRegistry: {
        globalOut: { type: "string", description: "Declared global produced by step1" },
      },
      nodes: [
        { type: "start", id: "start", connections: { default: "step1" } },
        {
          type: "agent-directive",
          id: "step1",
          directive: "Produce values",
          completionCondition: "Done",
          inputSchema: {
            type: "object",
            globalInputs: ["globalOut"],
            properties: { localOnly: { type: "string" } },
            required: ["globalOut", "localOnly"],
          },
          connections: { success: "end" },
        },
        { type: "end", id: "end" },
      ],
    };

    await repository.saveWorkflow(workflow, TEST_USER_ID);
    const executionId = await executor.startWorkflow(workflow, undefined, TEST_USER_ID);
    await executor.executeStep(executionId);
    await executor.executeStep(executionId, { globalOut: "G", localOnly: "L" });

    const state = await executor.getExecutionState(executionId);
    const vars = state!.globalContext.variables;

    // Declared global → promoted to the top level (bare-name scope).
    expect(vars.globalOut).toBe("G");
    // Non-declared output → NOT at the top level (no flat duplicate).
    expect(vars.localOnly).toBeUndefined();
    // Both are present in the node-local scope.
    const step1Scope = vars.step1 as Record<string, unknown>;
    expect(step1Scope.globalOut).toBe("G");
    expect(step1Scope.localOnly).toBe("L");
  });

  test("scalar agent-directive result is stored verbatim node-local, not key-routed or rejected", async () => {
    const { repository, executor } = await createTestExecutor();

    // inputSchema is a scalar (string const), so the result has no named keys to route.
    const workflow: WorkflowGraph = {
      id: "test-scalar-output",
      metadata: { name: "Scalar Output", version: "1.0.0", description: "Scalar agent result" },
      nodes: [
        { type: "start", id: "start", connections: { default: "ack" } },
        {
          type: "agent-directive",
          id: "ack",
          directive: "Acknowledge",
          completionCondition: "ok",
          inputSchema: { type: "string", const: "ok" },
          connections: { success: "end" },
        },
        { type: "end", id: "end" },
      ],
    };

    await repository.saveWorkflow(workflow, TEST_USER_ID);
    const executionId = await executor.startWorkflow(workflow, undefined, TEST_USER_ID);
    await executor.executeStep(executionId);

    // Must NOT throw "produced undeclared output key '0'" — the scalar is not iterated.
    const result = await executor.executeStep(executionId, "ok");
    expect(result).toContain("Workflow completed successfully");

    const state = await executor.getExecutionState(executionId);
    const vars = state!.globalContext.variables;
    // The raw scalar is stored under the node id; no positional '0'/'1' keys leaked to top level.
    expect(vars.ack).toBe("ok");
    expect(vars["0"]).toBeUndefined();
  });

  test("object result with an undeclared key is rejected", async () => {
    const { repository, executor } = await createTestExecutor();

    const workflow: WorkflowGraph = {
      id: "test-undeclared-key",
      metadata: { name: "Undeclared Key", version: "1.0.0", description: "Reject undeclared" },
      nodes: [
        { type: "start", id: "start", connections: { default: "step1" } },
        {
          type: "agent-directive",
          id: "step1",
          directive: "Produce a value",
          completionCondition: "Done",
          // Only `known` is a described local output; `surprise` is neither global nor local.
          inputSchema: {
            type: "object",
            properties: { known: { type: "string" } },
            required: ["known"],
          },
          connections: { success: "end" },
        },
        { type: "end", id: "end" },
      ],
    };

    await repository.saveWorkflow(workflow, TEST_USER_ID);
    const executionId = await executor.startWorkflow(workflow, undefined, TEST_USER_ID);
    await executor.executeStep(executionId);

    // additionalProperties:false (strict schema) blocks an undeclared key at validation; either way
    // an undeclared key must never silently land in context. Submitting a known-only object succeeds.
    const ok = await executor.executeStep(executionId, { known: "v" });
    expect(ok).toContain("Workflow completed successfully");

    const state = await executor.getExecutionState(executionId);
    const vars = state!.globalContext.variables;
    expect(vars.surprise).toBeUndefined();
    expect((vars.step1 as Record<string, unknown>).known).toBe("v");
  });
});
