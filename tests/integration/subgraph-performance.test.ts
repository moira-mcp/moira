/**
 * SubgraphNode Performance and Memory Tests
 * Validates delegation overhead and resource management
 */

import { describe, test, expect, beforeEach, afterEach } from "@jest/globals";
import { WorkflowGraph } from "@mcp-moira/workflow-engine";
import type { UniversalGraphExecutor, InMemoryRepository } from "@mcp-moira/workflow-engine";

describe("SubgraphNode Performance Validation", () => {
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

  test("should validate delegation overhead is acceptable", async () => {
    // Simple child workflow
    const childWorkflow: WorkflowGraph = {
      id: "performance-child",
      metadata: {
        name: "Performance Child",
        version: "1.0.0",
        description: "Child for performance testing",
      },
      nodes: [
        { type: "start", id: "start", connections: { default: "quick-step" } },
        {
          type: "agent-directive",
          id: "quick-step",
          directive: "Quick performance step",
          completionCondition: "Quick completed",
          inputSchema: {
            type: "object",
            properties: { data: { type: "string" } },
            required: ["data"],
          },
          connections: { success: "end" },
        },
        { type: "end", id: "end", finalOutput: ["data"] },
      ],
    };

    // Parent with delegation
    const delegationWorkflow: WorkflowGraph = {
      id: "delegation-performance",
      metadata: {
        name: "Delegation Performance",
        version: "1.0.0",
        description: "Performance test with delegation",
      },
      nodes: [
        { type: "start", id: "start", connections: { default: "subgraph" } },
        {
          type: "subgraph",
          id: "subgraph",
          graphId: "performance-child",
          inputMapping: {},
          outputMapping: { data: "result" },
          connections: { success: "end", error: "error-end" },
        },
        { type: "end", id: "end", finalOutput: ["result"] },
        { type: "end", id: "error-end", finalOutput: ["error"] },
      ],
    };

    // Direct execution workflow (for comparison)
    const directWorkflow: WorkflowGraph = {
      id: "direct-performance",
      metadata: {
        name: "Direct Performance",
        version: "1.0.0",
        description: "Performance test without delegation",
      },
      nodes: [
        { type: "start", id: "start", connections: { default: "direct-step" } },
        {
          type: "agent-directive",
          id: "direct-step",
          directive: "Quick performance step",
          completionCondition: "Quick completed",
          inputSchema: {
            type: "object",
            properties: { data: { type: "string" } },
            required: ["data"],
          },
          connections: { success: "end" },
        },
        { type: "end", id: "end", finalOutput: ["data"] },
      ],
    };

    await repository.saveWorkflow(childWorkflow, "test-user-123", "private");
    await repository.saveWorkflow(delegationWorkflow, "test-user-123", "private");
    await repository.saveWorkflow(directWorkflow, "test-user-123", "private");

    // Test delegation performance
    const delegationStart = performance.now();
    const delegationId = await executor.startWorkflow(
      delegationWorkflow,
      undefined,
      "test-user-123",
    );
    const delegationStep1 = await executor.executeStep(delegationId);
    const delegationStep2 = await executor.executeStep(delegationId, { data: "delegation test" });
    const delegationEnd = performance.now();

    // Test direct performance
    const directStart = performance.now();
    const directId = await executor.startWorkflow(directWorkflow, undefined, "test-user-123");
    const directStep1 = await executor.executeStep(directId);
    const directStep2 = await executor.executeStep(directId, { data: "direct test" });
    const directEnd = performance.now();

    const delegationTime = delegationEnd - delegationStart;
    const directTime = directEnd - directStart;

    // Validate delegation overhead is reasonable
    // Under CI load, direct execution can be <5ms making ratio unstable
    // Use absolute max (1000ms) OR relative (50x) whichever is greater
    // Increased from 750ms to account for parallel test execution and remote Docker variance
    const maxAllowed = Math.max(directTime * 50, 1000);
    expect(delegationTime).toBeLessThan(maxAllowed);

    // Validate both produce same results (both should contain the same base directive)
    expect(delegationStep1).toContain("Quick performance step");
    expect(directStep1).toContain("Quick performance step");
    expect(delegationStep2).toContain("Workflow completed successfully");
    expect(directStep2).toContain("Workflow completed successfully");
  });

  test("should validate memory usage in long-running scenarios", async () => {
    const childWorkflow: WorkflowGraph = {
      id: "memory-child",
      metadata: { name: "Memory Child", version: "1.0.0", description: "Child for memory testing" },
      nodes: [
        { type: "start", id: "start", connections: { default: "memory-step" } },
        {
          type: "agent-directive",
          id: "memory-step",
          directive: "Memory test step {{iteration}}",
          completionCondition: "Memory step completed",
          inputSchema: {
            type: "object",
            properties: { data: { type: "string" } },
            required: ["data"],
          },
          connections: { success: "end" },
        },
        { type: "end", id: "end", finalOutput: ["data"] },
      ],
    };

    const parentWorkflow: WorkflowGraph = {
      id: "memory-parent",
      metadata: {
        name: "Memory Parent",
        version: "1.0.0",
        description: "Parent for memory testing",
      },
      nodes: [
        {
          type: "start",
          id: "start",
          initialData: { variables: { iteration: { description: "Iteration number", value: 1 } } },
          connections: { default: "subgraph" },
        },
        {
          type: "subgraph",
          id: "subgraph",
          graphId: "memory-child",
          inputMapping: { iteration: "iteration" },
          outputMapping: { data: "result" },
          connections: { success: "end", error: "error-end" },
        },
        { type: "end", id: "end", finalOutput: ["result"] },
        { type: "end", id: "error-end", finalOutput: ["error"] },
      ],
    };

    await repository.saveWorkflow(childWorkflow, "test-user-123", "private");
    await repository.saveWorkflow(parentWorkflow, "test-user-123", "private");

    // Run multiple iterations to test memory stability
    const memoryBefore = process.memoryUsage();

    for (let i = 0; i < 10; i++) {
      const executionId = await executor.startWorkflow(parentWorkflow, undefined, "test-user-123");
      const step1 = await executor.executeStep(executionId);
      expect(step1).toContain(`Memory test step ${1}`);

      const step2 = await executor.executeStep(executionId, { data: `iteration ${i}` });
      expect(step2).toContain("Workflow completed successfully");
    }

    const memoryAfter = process.memoryUsage();
    const memoryGrowth = memoryAfter.heapUsed - memoryBefore.heapUsed;

    // Validate memory growth is reasonable (less than 50MB for 10 iterations)
    expect(memoryGrowth).toBeLessThan(50 * 1024 * 1024);
  });
});
