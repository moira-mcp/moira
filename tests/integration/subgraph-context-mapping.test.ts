/**
 * SubgraphNode Context Mapping Tests
 * Validates correct variable flow between parent and child workflows
 */

import { describe, test, expect, beforeEach, afterEach } from "@jest/globals";
import { WorkflowGraph } from "@mcp-moira/workflow-engine";
import type { UniversalGraphExecutor, InMemoryRepository } from "@mcp-moira/workflow-engine";

describe("SubgraphNode Context Mapping Validation", () => {
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

  test("should correctly map parent variables to child context", async () => {
    const childWorkflow: WorkflowGraph = {
      id: "input-mapping-child",
      metadata: {
        name: "Input Mapping Child",
        version: "1.0.0",
        description: "Child for input mapping",
      },
      variableRegistry: {
        mappedValue: { type: "string", description: "Value mapped in from the parent" },
        result: { type: "string", description: "Child result, mapped out to the parent" },
      },
      nodes: [
        { type: "start", id: "start", connections: { default: "child-step" } },
        {
          type: "agent-directive",
          id: "child-step",
          directive: "Use mapped value: {{mappedValue}}",
          completionCondition: "Value used",
          inputSchema: {
            type: "object",
            globalInputs: ["result"],
            properties: {},
            required: ["result"],
          },
          connections: { success: "end" },
        },
        { type: "end", id: "end", finalOutput: ["result", "mappedValue"] },
      ],
    };

    const parentWorkflow: WorkflowGraph = {
      id: "input-mapping-parent",
      metadata: {
        name: "Input Mapping Parent",
        version: "1.0.0",
        description: "Parent for input mapping",
      },
      variableRegistry: {
        parentValue: { type: "string", description: "Parent value", default: "test-value" },
        secretValue: { type: "string", description: "Secret", default: "should-not-leak" },
        childResult: { type: "string", description: "Result mapped back from the child subgraph" },
      },
      nodes: [
        {
          type: "start",
          id: "start",
          connections: { default: "subgraph" },
        },
        {
          type: "subgraph",
          id: "subgraph",
          graphId: "input-mapping-child",
          inputMapping: { parentValue: "mappedValue" }, // Only map parentValue
          outputMapping: { result: "childResult" },
          connections: { success: "end", error: "error-end" },
        },
        { type: "end", id: "end", finalOutput: ["childResult", "secretValue"] },
        { type: "end", id: "error-end", finalOutput: ["error"] },
      ],
    };

    await repository.saveWorkflow(childWorkflow, "test-user-123", "private");
    await repository.saveWorkflow(parentWorkflow, "test-user-123", "private");

    const executionId = await executor.startWorkflow(parentWorkflow, undefined, "test-user-123");

    // Child should see mapped value in directive template
    const step1 = await executor.executeStep(executionId);
    expect(step1).toContain("Use mapped value: test-value"); // Template resolved

    // Complete child workflow
    const step2 = await executor.executeStep(executionId, { result: "child output" });
    expect(step2).toContain("Workflow completed successfully");

    // Verify context mapping and isolation
    const finalExecution = await executor.getExecutionState(executionId);
    expect(finalExecution?.globalContext.variables.childResult).toBe("child output");
    expect(finalExecution?.globalContext.variables.secretValue).toBe("should-not-leak"); // Preserved
    expect(finalExecution?.globalContext.variables.mappedValue).toBeUndefined(); // Not leaked back
  });

  test("should validate context isolation prevents leakage", async () => {
    const childWorkflow: WorkflowGraph = {
      id: "isolation-child",
      metadata: {
        name: "Isolation Child",
        version: "1.0.0",
        description: "Child for isolation testing",
      },
      variableRegistry: {
        childSecret: {
          type: "string",
          description: "Secret",
          default: "should-not-leak-to-parent",
        },
        publicData: { type: "string", description: "Public data, mapped out to the parent" },
      },
      nodes: [
        {
          type: "start",
          id: "start",
          connections: { default: "child-step" },
        },
        {
          type: "agent-directive",
          id: "child-step",
          directive: "Child step with secret data",
          completionCondition: "Step completed",
          inputSchema: {
            type: "object",
            globalInputs: ["publicData"],
            properties: {},
            required: ["publicData"],
          },
          connections: { success: "end" },
        },
        { type: "end", id: "end", finalOutput: ["publicData"] }, // Only public data in output
      ],
    };

    const parentWorkflow: WorkflowGraph = {
      id: "isolation-parent",
      metadata: {
        name: "Isolation Parent",
        version: "1.0.0",
        description: "Parent for isolation testing",
      },
      variableRegistry: {
        mappedPublic: { type: "string", description: "Public data mapped back from the child" },
      },
      nodes: [
        { type: "start", id: "start", connections: { default: "subgraph" } },
        {
          type: "subgraph",
          id: "subgraph",
          graphId: "isolation-child",
          inputMapping: {},
          outputMapping: { publicData: "mappedPublic" },
          connections: { success: "end", error: "error-end" },
        },
        { type: "end", id: "end", finalOutput: ["mappedPublic"] },
        { type: "end", id: "error-end", finalOutput: ["error"] },
      ],
    };

    await repository.saveWorkflow(childWorkflow, "test-user-123", "private");
    await repository.saveWorkflow(parentWorkflow, "test-user-123", "private");

    const executionId = await executor.startWorkflow(parentWorkflow, undefined, "test-user-123");

    const step1 = await executor.executeStep(executionId);
    expect(step1).toContain("Child step with secret data");

    const step2 = await executor.executeStep(executionId, { publicData: "public output" });
    expect(step2).toContain("Workflow completed successfully");

    // Verify secret data doesn't leak to parent
    const finalExecution = await executor.getExecutionState(executionId);
    expect(finalExecution?.globalContext.variables.mappedPublic).toBe("public output");
    expect(finalExecution?.globalContext.variables.childSecret).toBeUndefined(); // Not leaked
    expect(finalExecution?.globalContext.variables.publicData).toBeUndefined(); // Not leaked
  });
});
