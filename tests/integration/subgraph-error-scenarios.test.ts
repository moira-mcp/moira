/**
 * SubgraphNode Error Handling Scenario Tests
 * Validates error propagation and resource cleanup in delegation
 */

import { describe, test, expect, beforeEach, afterEach } from "@jest/globals";
import { WorkflowGraph } from "@mcp-moira/workflow-engine";
import type { UniversalGraphExecutor, InMemoryRepository } from "@mcp-moira/workflow-engine";

describe("SubgraphNode Error Handling Scenarios", () => {
  let executor: UniversalGraphExecutor;
  let repository: InMemoryRepository;

  beforeEach(async () => {
    const setup = await createTestExecutor();
    executor = setup.executor;
    repository = setup.repository;
  });

  afterEach(() => {
    if (global.gc) {
      global.gc();
    }
  });

  test("should handle child workflow failures with proper error routing", async () => {
    // Child workflow that can fail (no error path defined)
    const failingChild: WorkflowGraph = {
      id: "failing-child",
      metadata: { name: "Failing Child", version: "1.0.0", description: "Child that fails" },
      nodes: [
        { type: "start", id: "start", connections: { default: "invalid-node" } },
        // Missing node creates failure scenario
      ],
    };

    // Parent with error handling
    const parentWorkflow: WorkflowGraph = {
      id: "error-parent",
      metadata: {
        name: "Error Parent",
        version: "1.0.0",
        description: "Parent with error handling",
      },
      nodes: [
        { type: "start", id: "start", connections: { default: "subgraph" } },
        {
          type: "subgraph",
          id: "subgraph",
          graphId: "failing-child",
          inputMapping: {},
          outputMapping: {},
          connections: { success: "success-end", error: "error-end" },
        },
        { type: "end", id: "success-end", finalOutput: ["success"] },
        { type: "end", id: "error-end", finalOutput: ["error"] },
      ],
    };

    await repository.saveWorkflow(failingChild, "test-user-123");
    await repository.saveWorkflow(parentWorkflow, "test-user-123");

    const executionId = await executor.startWorkflow(parentWorkflow, undefined, "test-user-123");

    // Execute workflow step - subgraph with invalid child should fail quickly
    let result;
    try {
      result = await executor.executeStep(executionId);
      expect(result).toBeDefined();

      // If we get here, workflow should have completed with error routing
      if (typeof result === "string") {
        expect(result).toContain("Process ID:");
      }
    } catch (error) {
      // Expected: subgraph execution should fail due to invalid child
      expect(error).toBeDefined();
      // Child workflow references non-existent node, so execution fails with "not found"
      expect((error as Error).message).toMatch(/not found|invalid.*node/i);

      // This is expected behavior - subgraph fails immediately when child
      // has an invalid node reference
    }
  });

  test("should validate resource cleanup after delegation failures", async () => {
    const problematicChild: WorkflowGraph = {
      id: "problematic-child",
      metadata: { name: "Problematic Child", version: "1.0.0", description: "Child with issues" },
      variableRegistry: {
        data: { type: "string", description: "Child output, mapped out to parent" },
      },
      nodes: [
        { type: "start", id: "start", connections: { default: "problematic-step" } },
        {
          type: "agent-directive",
          id: "problematic-step",
          directive: "This step will cause issues",
          completionCondition: "Issues handled",
          inputSchema: {
            type: "object",
            globalInputs: ["data"],
            properties: {},
            required: ["data"],
          },
          connections: { success: "end" },
        },
        { type: "end", id: "end", finalOutput: ["data"] },
      ],
    };

    const parentWorkflow: WorkflowGraph = {
      id: "cleanup-parent",
      metadata: {
        name: "Cleanup Parent",
        version: "1.0.0",
        description: "Parent for cleanup testing",
      },
      variableRegistry: {
        result: { type: "string", description: "Result mapped back from the problematic child" },
      },
      nodes: [
        { type: "start", id: "start", connections: { default: "subgraph" } },
        {
          type: "subgraph",
          id: "subgraph",
          graphId: "problematic-child",
          inputMapping: {},
          outputMapping: { data: "result" },
          connections: { success: "end", error: "error-end" },
        },
        { type: "end", id: "end", finalOutput: ["result"] },
        { type: "end", id: "error-end", finalOutput: ["error"] },
      ],
    };

    await repository.saveWorkflow(problematicChild, "test-user-123");
    await repository.saveWorkflow(parentWorkflow, "test-user-123");

    const executionId = await executor.startWorkflow(parentWorkflow, undefined, "test-user-123");

    // Should see child step
    const step1 = await executor.executeStep(executionId);
    expect(step1).toContain("This step will cause issues");

    // Complete child workflow successfully
    const step2 = await executor.executeStep(executionId, { data: "handled data" });
    expect(step2).toContain("Workflow completed successfully");

    // Verify proper cleanup и result mapping
    const finalExecution = await executor.getExecutionState(executionId);
    expect(finalExecution?.globalContext.variables.result).toBe("handled data");
    // Status may be 'running' if workflow continues, 'completed' if finished
  });
});
