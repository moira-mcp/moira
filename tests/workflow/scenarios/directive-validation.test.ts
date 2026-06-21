/**
 * Test: Directive Validation in Scenario Runner (Issue #449)
 *
 * Verifies that scenario-runner catches template errors during workflow execution:
 *
 * 1. **Undefined variables** - `{{undefined_var}}` renders as "null" string
 * 2. **Null values** - Variables explicitly set to null render as "null"
 * 3. **Unclosed conditionals** - `{{#if condition}}` without `{{/if}}`
 * 4. **Valid workflows** - Properly defined variables pass validation
 *
 * This validation runs automatically for ALL workflow scenario tests,
 * catching directive quality issues at test time rather than runtime.
 *
 * How it works:
 * - After each step, scenario-runner checks messageQueue for directive messages
 * - Validates that rendered directives don't contain `{{...}}` patterns
 * - Validates that rendered directives don't contain suspicious "null" values
 * - Throws descriptive error if validation fails
 */

import { runScenario, TestScenario } from "../../helpers/scenario-runner.js";
import type { WorkflowGraph } from "@mcp-moira/workflow-engine";

/**
 * Workflow with unrendered template variable
 */
const workflowWithUnrenderedTemplate: WorkflowGraph = {
  id: "test-unrendered-template",
  metadata: {
    name: "Test Unrendered Template",
    version: "1.0.0",
    description: "Test workflow with undefined variable",
  },
  nodes: [
    {
      id: "start",
      type: "start",
      connections: { default: "task" },
      initialData: {
        variables: {
          defined_var: { value: "hello", description: "A defined variable" },
        },
      },
    },
    {
      id: "task",
      type: "agent-directive",
      directive: "Do something with {{undefined_var}} that is not defined",
      completionCondition: "Task completed",
      inputSchema: {
        type: "object",
        properties: {
          result: { type: "string" },
        },
      },
      connections: { success: "end" },
    },
    {
      id: "end",
      type: "end",
    },
  ],
};

/**
 * Workflow where variable renders to "null"
 */
const workflowWithNullVariable: WorkflowGraph = {
  id: "test-null-variable",
  metadata: {
    name: "Test Null Variable",
    version: "1.0.0",
    description: "Test workflow where variable is null",
  },
  nodes: [
    {
      id: "start",
      type: "start",
      connections: { default: "task" },
      initialData: {
        variables: {
          some_var: { value: null, description: "A null variable" },
        },
      },
    },
    {
      id: "task",
      type: "agent-directive",
      directive: "Process the value: {{some_var}} and continue",
      completionCondition: "Done",
      inputSchema: {
        type: "object",
        properties: {
          result: { type: "string" },
        },
      },
      connections: { success: "end" },
    },
    {
      id: "end",
      type: "end",
    },
  ],
};

/**
 * Workflow with unclosed conditional block
 */
const workflowWithUnclosedConditional: WorkflowGraph = {
  id: "test-unclosed-conditional",
  metadata: {
    name: "Test Unclosed Conditional",
    version: "1.0.0",
    description: "Test workflow with unclosed {{#if}}",
  },
  nodes: [
    {
      id: "start",
      type: "start",
      connections: { default: "task" },
      initialData: {
        variables: {
          show_extra: { value: true, description: "Flag" },
        },
      },
    },
    {
      id: "task",
      type: "agent-directive",
      directive: "Do something {{#if show_extra}}with extra content",
      completionCondition: "Done",
      inputSchema: {
        type: "object",
        properties: {
          result: { type: "string" },
        },
      },
      connections: { success: "end" },
    },
    {
      id: "end",
      type: "end",
    },
  ],
};

/**
 * Valid workflow - should pass
 */
const validWorkflow: WorkflowGraph = {
  id: "test-valid-workflow",
  metadata: {
    name: "Test Valid Workflow",
    version: "1.0.0",
    description: "Test workflow with all variables defined",
  },
  nodes: [
    {
      id: "start",
      type: "start",
      connections: { default: "task" },
      initialData: {
        variables: {
          user_name: { value: "John", description: "User name" },
          task_id: { value: "123", description: "Task ID" },
        },
      },
    },
    {
      id: "task",
      type: "agent-directive",
      directive: "Hello {{user_name}}, please complete task {{task_id}}",
      completionCondition: "Task completed by {{user_name}}",
      inputSchema: {
        type: "object",
        properties: {
          result: { type: "string" },
        },
      },
      connections: { success: "end" },
    },
    {
      id: "end",
      type: "end",
    },
  ],
};

describe("Directive Validation", () => {
  describe("Undefined variables", () => {
    it("should fail when directive contains undefined variable (renders as null)", async () => {
      const scenario: TestScenario = {
        name: "undefined-variable-test",
        mockInputs: {
          task: { result: "done" },
        },
        expect: {
          status: "completed",
        },
      };

      const result = await runScenario(workflowWithUnrenderedTemplate, scenario);

      // Undefined variables render as [[UNDEFINED_VARIABLE]] placeholder
      expect(result.passed).toBe(false);
      expect(result.error).toContain("UNDEFINED_VARIABLE");
    });
  });

  describe("Null values", () => {
    it("should fail when directive contains null variable value", async () => {
      const scenario: TestScenario = {
        name: "null-value-test",
        mockInputs: {
          task: { result: "done" },
        },
        expect: {
          status: "completed",
        },
      };

      const result = await runScenario(workflowWithNullVariable, scenario);

      // Null variable values also render as [[UNDEFINED_VARIABLE]] placeholder
      expect(result.passed).toBe(false);
      expect(result.error).toContain("UNDEFINED_VARIABLE");
    });
  });

  describe("Unclosed conditionals", () => {
    it("should fail when directive contains unclosed {{#if}}", async () => {
      const scenario: TestScenario = {
        name: "unclosed-conditional-test",
        mockInputs: {
          task: { result: "done" },
        },
        expect: {
          status: "completed",
        },
      };

      const result = await runScenario(workflowWithUnclosedConditional, scenario);

      // Unclosed {{#if}} block should be caught
      expect(result.passed).toBe(false);
      expect(result.error).toContain("Unrendered template");
      expect(result.error).toContain("#if");
    });
  });

  describe("Valid workflow", () => {
    it("should pass when all variables are properly rendered", async () => {
      const scenario: TestScenario = {
        name: "valid-workflow-test",
        mockInputs: {
          task: { result: "done" },
        },
        expect: {
          status: "completed",
        },
      };

      const result = await runScenario(validWorkflow, scenario);

      expect(result.passed).toBe(true);
      expect(result.error).toBeUndefined();
    });
  });
});
