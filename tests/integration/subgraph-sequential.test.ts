/**
 * Sequential SubgraphNode Tests
 * Validates multiple subgraph nodes друг за другом
 */

import { describe, test, expect, beforeEach, afterEach } from "@jest/globals";
import type { UniversalGraphExecutor, InMemoryRepository } from "@mcp-moira/workflow-engine";
import { WorkflowGraph } from "@mcp-moira/workflow-engine";

describe("Sequential SubgraphNode Validation", () => {
  let executor: UniversalGraphExecutor;
  let repository: InMemoryRepository;

  beforeEach(async () => {
    const testEnv = await createTestExecutor();
    repository = testEnv.repository;
    executor = testEnv.executor;
  });

  afterEach(() => {
    // Memory cleanup
    if (global.gc) {
      global.gc();
    }
  });

  test("should handle multiple sequential subgraphs transparently", async () => {
    // First child workflow
    const child1: WorkflowGraph = {
      id: "sequential-child-1",
      metadata: { name: "Sequential Child 1", version: "1.0.0", description: "First child" },
      variableRegistry: {
        input1: { type: "string", description: "First child output, mapped out to parent" },
      },
      nodes: [
        { type: "start", id: "start", connections: { default: "step1" } },
        {
          type: "agent-directive",
          id: "step1",
          directive: "First subgraph step",
          completionCondition: "First completed",
          inputSchema: {
            type: "object",
            globalInputs: ["input1"],
            properties: {},
            required: ["input1"],
          },
          connections: { success: "end" },
        },
        { type: "end", id: "end", finalOutput: ["input1"] },
      ],
    };

    // Second child workflow
    const child2: WorkflowGraph = {
      id: "sequential-child-2",
      metadata: { name: "Sequential Child 2", version: "1.0.0", description: "Second child" },
      variableRegistry: {
        fromFirst: { type: "string", description: "Mapped in from first child's result" },
        input2: { type: "string", description: "Second child output, mapped out to parent" },
      },
      nodes: [
        { type: "start", id: "start", connections: { default: "step2" } },
        {
          type: "agent-directive",
          id: "step2",
          directive: "Second subgraph step: {{fromFirst}}",
          completionCondition: "Second completed",
          inputSchema: {
            type: "object",
            globalInputs: ["input2"],
            properties: {},
            required: ["input2"],
          },
          connections: { success: "end" },
        },
        { type: "end", id: "end", finalOutput: ["input2", "fromFirst"] },
      ],
    };

    // Parent workflow with sequential subgraphs
    const parentWorkflow: WorkflowGraph = {
      id: "sequential-parent",
      metadata: {
        name: "Sequential Parent",
        version: "1.0.0",
        description: "Parent with sequential subgraphs",
      },
      variableRegistry: {
        result1: {
          type: "string",
          description: "First subgraph result (also mapped into subgraph2)",
        },
        result2: { type: "string", description: "Second subgraph result" },
      },
      nodes: [
        { type: "start", id: "start", connections: { default: "subgraph1" } },
        {
          type: "subgraph",
          id: "subgraph1",
          graphId: "sequential-child-1",
          inputMapping: {},
          outputMapping: { input1: "result1" },
          connections: { success: "subgraph2", error: "error-end" },
        },
        {
          type: "subgraph",
          id: "subgraph2",
          graphId: "sequential-child-2",
          inputMapping: { result1: "fromFirst" },
          outputMapping: { input2: "result2" },
          connections: { success: "end", error: "error-end" },
        },
        { type: "end", id: "end", finalOutput: ["result1", "result2"] },
        { type: "end", id: "error-end", finalOutput: ["error"] },
      ],
    };

    await repository.saveWorkflow(child1, "test-user-123");
    await repository.saveWorkflow(child2, "test-user-123");
    await repository.saveWorkflow(parentWorkflow, "test-user-123");

    const executionId = await executor.startWorkflow(parentWorkflow, undefined, "test-user-123");

    // First subgraph step
    const step1 = await executor.executeStep(executionId);
    expect(step1).toContain("First subgraph step");
    expect(step1).toContain(executionId.slice(0, 8)); // Should contain executionId

    // Complete first subgraph
    const step2 = await executor.executeStep(executionId, { input1: "first result" });
    expect(step2).toContain("Second subgraph step: first result"); // Template from first subgraph
    expect(step2).toContain(executionId.slice(0, 8)); // Should contain executionId

    // Complete second subgraph
    const step3 = await executor.executeStep(executionId, { input2: "second result" });
    expect(step3).toContain("Workflow completed successfully");

    // Verify sequential context mapping
    const finalExecution = await executor.getExecutionState(executionId);
    expect(finalExecution?.globalContext.variables.result1).toBe("first result");
    expect(finalExecution?.globalContext.variables.result2).toBe("second result");
  });
});
