/**
 * Scenario-based Tests for Conditional Branching Workflows
 */

import { describe, test, expect } from "@jest/globals";
import { runScenario, type TestScenario } from "../../helpers/scenario-runner.js";
import type { WorkflowGraph } from "@mcp-moira/workflow-engine";

// Workflow defined inline for simplicity
const workflow: WorkflowGraph = {
  id: "scenario-test-conditional",
  metadata: {
    name: "Conditional Scenario Test",
    version: "1.0.0",
    description: "Workflow for scenario-based testing with branching",
  },
  // `value` is produced by get-input and read by the condition by bare name → declared global.
  variableRegistry: {
    value: { type: "string", description: "Value entered by the user, checked by the condition" },
  },
  nodes: [
    {
      type: "start",
      id: "start",
      connections: { default: "get-input" },
    },
    {
      type: "agent-directive",
      id: "get-input",
      directive: "Enter a value",
      completionCondition: "Value provided",
      inputSchema: {
        type: "object",
        globalInputs: ["value"],
        properties: {},
        required: ["value"],
      },
      connections: { success: "check-value" },
    },
    {
      type: "condition",
      id: "check-value",
      condition: {
        operator: "eq",
        left: { contextPath: "value" },
        right: "yes",
      },
      connections: {
        true: "success-end",
        false: "failure-end",
      },
    },
    {
      type: "end",
      id: "success-end",
    },
    {
      type: "end",
      id: "failure-end",
    },
  ],
};

describe("Conditional Branching Scenarios", () => {
  test("happy path: yes input reaches success-end", async () => {
    const scenario: TestScenario = {
      name: "happy-path-yes",
      description: 'User inputs "yes", reaches success-end',
      mockInputs: {
        "get-input": { value: "yes" },
      },
      expect: {
        reaches: ["start", "get-input", "check-value", "success-end"],
        avoids: ["failure-end"],
        status: "completed",
        contextContains: {
          value: "yes",
        },
      },
    };

    const result = await runScenario(workflow, scenario);

    expect(result.passed).toBe(true);
    expect(result.status).toBe("completed");
    expect(result.visitedNodes).toContain("success-end");
    expect(result.visitedNodes).not.toContain("failure-end");
  });

  test("alternative path: no input reaches failure-end", async () => {
    const scenario: TestScenario = {
      name: "alternative-path-no",
      description: 'User inputs "no", reaches failure-end',
      mockInputs: {
        "get-input": { value: "no" },
      },
      expect: {
        reaches: ["start", "get-input", "check-value", "failure-end"],
        avoids: ["success-end"],
        status: "completed",
        contextContains: {
          value: "no",
        },
      },
    };

    const result = await runScenario(workflow, scenario);

    expect(result.passed).toBe(true);
    expect(result.status).toBe("completed");
    expect(result.visitedNodes).toContain("failure-end");
    expect(result.visitedNodes).not.toContain("success-end");
  });

  test("context tracking: value persists through workflow", async () => {
    const scenario: TestScenario = {
      name: "context-tracking",
      mockInputs: {
        "get-input": { value: "test-value" },
      },
      expect: {
        status: "completed",
        contextContains: {
          value: "test-value",
        },
      },
    };

    const result = await runScenario(workflow, scenario);

    expect(result.passed).toBe(true);
    expect(result.finalContext.value).toBe("test-value");
  });
});
