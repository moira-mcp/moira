/**
 * SubgraphNode Agent Transparency Tests
 * Validates that agent sees child workflow steps as normal parent steps
 */

import { describe, test, expect, beforeEach, afterEach } from "@jest/globals";
import type { UniversalGraphExecutor, InMemoryRepository } from "@mcp-moira/workflow-engine";
import { WorkflowGraph } from "@mcp-moira/workflow-engine";

describe("SubgraphNode Agent Transparency Validation", () => {
  let executor: UniversalGraphExecutor;
  let repository: InMemoryRepository;

  beforeEach(async () => {
    const testEnv = await createTestExecutor();
    repository = testEnv.repository;
    executor = testEnv.executor;
  });

  afterEach(() => {
    if (global.gc) {
      global.gc();
    }
  });

  test("should maintain consistent processId across delegation", async () => {
    const childWorkflow: WorkflowGraph = {
      id: "transparency-child",
      metadata: {
        name: "Transparency Child",
        version: "1.0.0",
        description: "Child for transparency testing",
      },
      nodes: [
        { type: "start", id: "start", connections: { default: "child-step" } },
        {
          type: "agent-directive",
          id: "child-step",
          directive: "This is child workflow step",
          completionCondition: "Child step completed",
          inputSchema: {
            type: "object",
            globalInputs: ["input"],
            properties: {},
            required: ["input"],
          },
          connections: { success: "end" },
        },
        { type: "end", id: "end", finalOutput: ["input"] },
      ],
    };

    const parentWorkflow: WorkflowGraph = {
      id: "transparency-parent",
      metadata: {
        name: "Transparency Parent",
        version: "1.0.0",
        description: "Parent for transparency testing",
      },
      nodes: [
        { type: "start", id: "start", connections: { default: "subgraph" } },
        {
          type: "subgraph",
          id: "subgraph",
          graphId: "transparency-child",
          inputMapping: {},
          outputMapping: { input: "result" },
          connections: { success: "end", error: "error-end" },
        },
        { type: "end", id: "end", finalOutput: ["result"] },
        { type: "end", id: "error-end", finalOutput: ["error"] },
      ],
    };

    await repository.saveWorkflow(childWorkflow, "test-user-123");
    await repository.saveWorkflow(parentWorkflow, "test-user-123");

    const parentExecutionId = await executor.startWorkflow(
      parentWorkflow,
      undefined,
      "test-user-123",
    );

    // Agent should see child step with parent processId
    const step1 = await executor.executeStep(parentExecutionId);
    expect(step1).toContain("This is child workflow step");
    expect(step1).toContain(parentExecutionId.slice(0, 8)); // Should contain parent processId

    // Complete child workflow
    const step2 = await executor.executeStep(parentExecutionId, { input: "transparency test" });
    expect(step2).toContain("Workflow completed successfully");
    expect(step2).toContain(parentExecutionId.slice(0, 8)); // Still parent processId
  });

  test("should hide subgraph metadata from agent", async () => {
    const childWorkflow: WorkflowGraph = {
      id: "metadata-child",
      metadata: { name: "Secret Child", version: "1.0.0", description: "Child with metadata" },
      nodes: [
        { type: "start", id: "start", connections: { default: "secret-step" } },
        {
          type: "agent-directive",
          id: "secret-step",
          directive: "Agent should not see child workflow metadata",
          completionCondition: "Step completed",
          inputSchema: {
            type: "object",
            globalInputs: ["value"],
            properties: {},
            required: ["value"],
          },
          connections: { success: "end" },
        },
        { type: "end", id: "end", finalOutput: ["value"] },
      ],
    };

    const parentWorkflow: WorkflowGraph = {
      id: "metadata-parent",
      metadata: { name: "Parent Workflow", version: "1.0.0", description: "Parent workflow" },
      nodes: [
        { type: "start", id: "start", connections: { default: "subgraph" } },
        {
          type: "subgraph",
          id: "subgraph",
          graphId: "metadata-child",
          inputMapping: {},
          outputMapping: { value: "childValue" },
          connections: { success: "end", error: "error-end" },
        },
        { type: "end", id: "end", finalOutput: ["childValue"] },
        { type: "end", id: "error-end", finalOutput: ["error"] },
      ],
    };

    await repository.saveWorkflow(childWorkflow, "test-user-123");
    await repository.saveWorkflow(parentWorkflow, "test-user-123");

    const parentExecutionId = await executor.startWorkflow(
      parentWorkflow,
      undefined,
      "test-user-123",
    );

    // Agent sees child step but no subgraph metadata
    const step1 = await executor.executeStep(parentExecutionId);
    expect(step1).toContain("Agent should not see child workflow metadata");
    expect(step1).toContain(parentExecutionId.slice(0, 8)); // Should contain parent processId

    // Verify no subgraph metadata exposed to agent
    expect(step1).not.toContain("metadata-child");
    expect(step1).not.toContain("Secret Child");
    expect(step1).not.toContain("subgraph");
    expect(JSON.stringify(step1)).not.toContain("childExecutionId");
  });

  test("should validate step-by-step progression transparency", async () => {
    const multiStepChild: WorkflowGraph = {
      id: "multi-step-child",
      metadata: {
        name: "Multi Step Child",
        version: "1.0.0",
        description: "Child with multiple steps",
      },
      variableRegistry: {
        data1: { type: "string", description: "Step1 output, mapped out" },
        data2: { type: "string", description: "Step2 output, mapped out" },
        data3: { type: "string", description: "Step3 output, mapped out" },
      },
      nodes: [
        { type: "start", id: "start", connections: { default: "step1" } },
        {
          type: "agent-directive",
          id: "step1",
          directive: "First child step",
          completionCondition: "First completed",
          inputSchema: {
            type: "object",
            globalInputs: ["data1"],
            properties: {},
            required: ["data1"],
          },
          connections: { success: "step2" },
        },
        {
          type: "agent-directive",
          id: "step2",
          directive: "Second child step",
          completionCondition: "Second completed",
          inputSchema: {
            type: "object",
            globalInputs: ["data2"],
            properties: {},
            required: ["data2"],
          },
          connections: { success: "step3" },
        },
        {
          type: "agent-directive",
          id: "step3",
          directive: "Third child step",
          completionCondition: "Third completed",
          inputSchema: {
            type: "object",
            globalInputs: ["data3"],
            properties: {},
            required: ["data3"],
          },
          connections: { success: "end" },
        },
        { type: "end", id: "end", finalOutput: ["data1", "data2", "data3"] },
      ],
    };

    const parentWorkflow: WorkflowGraph = {
      id: "progression-parent",
      metadata: {
        name: "Progression Parent",
        version: "1.0.0",
        description: "Parent for step progression",
      },
      variableRegistry: {
        result1: { type: "string", description: "Mapped from child data1" },
        result2: { type: "string", description: "Mapped from child data2" },
        result3: { type: "string", description: "Mapped from child data3" },
      },
      nodes: [
        { type: "start", id: "start", connections: { default: "subgraph" } },
        {
          type: "subgraph",
          id: "subgraph",
          graphId: "multi-step-child",
          inputMapping: {},
          outputMapping: { data1: "result1", data2: "result2", data3: "result3" },
          connections: { success: "end", error: "error-end" },
        },
        { type: "end", id: "end", finalOutput: ["result1", "result2", "result3"] },
        { type: "end", id: "error-end", finalOutput: ["error"] },
      ],
    };

    await repository.saveWorkflow(multiStepChild, "test-user-123");
    await repository.saveWorkflow(parentWorkflow, "test-user-123");

    const parentExecutionId = await executor.startWorkflow(
      parentWorkflow,
      undefined,
      "test-user-123",
    );

    // Agent should see each child step progressively with same processId
    const step1 = await executor.executeStep(parentExecutionId);
    expect(step1).toContain("First child step");
    expect(step1).toContain(parentExecutionId.slice(0, 8)); // Should contain parent processId

    const step2 = await executor.executeStep(parentExecutionId, { data1: "first data" });
    expect(step2).toContain("Second child step");
    expect(step2).toContain(parentExecutionId.slice(0, 8)); // Should contain parent processId

    const step3 = await executor.executeStep(parentExecutionId, { data2: "second data" });
    expect(step3).toContain("Third child step");
    expect(step3).toContain(parentExecutionId.slice(0, 8)); // Should contain parent processId

    const step4 = await executor.executeStep(parentExecutionId, { data3: "third data" });
    expect(step4).toContain("Workflow completed successfully");
    // Final step should contain completion message, not necessarily match executionId format

    // Verify all child data mapped to parent
    const finalExecution = await executor.getExecutionState(parentExecutionId);
    expect(finalExecution?.globalContext.variables.result1).toBe("first data");
    expect(finalExecution?.globalContext.variables.result2).toBe("second data");
    expect(finalExecution?.globalContext.variables.result3).toBe("third data");
  });
});
