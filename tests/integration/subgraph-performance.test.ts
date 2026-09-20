/**
 * SubgraphNode Performance and Memory Tests
 * Validates delegation overhead and resource management
 */

import { describe, test, expect, beforeEach, afterEach } from "@jest/globals";
import { spawnSync } from "node:child_process";
import path from "node:path";
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
    // Measure retained memory in an isolated process with explicit GC. Measuring the shared Jest
    // worker conflates this workload with whichever suites happened to grow V8's heap before it.
    const benchmark = spawnSync(
      process.execPath,
      [
        "--expose-gc",
        "--import",
        "tsx",
        path.resolve("tests/helpers/subgraph-memory-benchmark.ts"),
      ],
      { cwd: process.cwd(), encoding: "utf8", timeout: 30_000 },
    );
    expect(benchmark.error).toBeUndefined();
    expect(benchmark.status).toBe(0);
    const lastLine = benchmark.stdout.trim().split("\n").at(-1);
    const { heapGrowth } = JSON.parse(lastLine ?? "") as { heapGrowth: number };
    expect(heapGrowth).toBeLessThan(50 * 1024 * 1024);
  });
});
