/**
 * MCP E2E Tests - New Features (Stage 2-3)
 * Tests for: variable functions, diff, execution_note, conditional templates, array access
 */

import { describe, test, expect, beforeAll, afterAll } from "@jest/globals";
import { createAuthenticatedMCPClient, callMCPTool } from "../utils/mcp-auth.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

describe("MCP New Features E2E", () => {
  let client: Client;
  let cleanup: () => Promise<void>;
  const createdWorkflows: string[] = [];

  beforeAll(async () => {
    const mcpClient = await createAuthenticatedMCPClient();
    client = mcpClient.client;
    cleanup = mcpClient.cleanup;
  });

  afterAll(async () => {
    // Cleanup all created workflows
    for (const workflowId of createdWorkflows) {
      try {
        await callMCPTool(client, "manage", {
          action: "edit",
          workflowId,
          changes: { removeNodes: [] }, // Just to trigger cleanup
        });
      } catch (e) {
        // Ignore cleanup errors
      }
    }
    await cleanup();
  });

  describe("Variable Functions", () => {
    let testWorkflowId: string;

    beforeAll(async () => {
      // Create test workflow with initialData
      const result = await callMCPTool(client, "manage", {
        action: "create",
        workflow: {
          metadata: {
            name: "Variable Functions Test",
            version: "1.0.0",
            description: "Test workflow for variable functions",
          },
          variableRegistry: {
            existing_var: {
              type: "string",
              description: "Existing variable",
              default: "initial_value",
            },
            number_var: { type: "number", description: "Number variable", default: 42 },
            nested: {
              type: "object",
              description: "Nested object",
              default: { key: "nested_value" },
            },
          },
          nodes: [
            { type: "start", id: "start", connections: { default: "end" } },
            { type: "end", id: "end" },
          ],
        },
        overwrite: true,
      });
      testWorkflowId = result.workflowId;
      createdWorkflows.push(testWorkflowId);
    });

    test("list-variables returns all workflow variables", async () => {
      const result = await callMCPTool(client, "manage", {
        action: "list-variables",
        workflowId: testWorkflowId,
      });

      expect(result).toHaveProperty("variables");
      expect(Array.isArray(result.variables)).toBe(true);
      expect(result.variables.length).toBeGreaterThanOrEqual(3);

      const varNames = result.variables.map((v: any) => v.name);
      expect(varNames).toContain("existing_var");
      expect(varNames).toContain("number_var");
      expect(varNames).toContain("nested");
    });

    test("get-variable returns specific variable value", async () => {
      const result = await callMCPTool(client, "manage", {
        action: "get-variable",
        workflowId: testWorkflowId,
        variableName: "existing_var",
      });

      expect(result).toHaveProperty("value", "initial_value");
    });

    test("get-variable returns number correctly", async () => {
      const result = await callMCPTool(client, "manage", {
        action: "get-variable",
        workflowId: testWorkflowId,
        variableName: "number_var",
      });

      expect(result).toHaveProperty("value", 42);
    });

    test("get-variable returns nested object", async () => {
      const result = await callMCPTool(client, "manage", {
        action: "get-variable",
        workflowId: testWorkflowId,
        variableName: "nested",
      });

      expect(result).toHaveProperty("value");
      expect(result.value).toEqual({ key: "nested_value" });
    });

    test("set-variable creates new variable", async () => {
      const result = await callMCPTool(client, "manage", {
        action: "set-variable",
        workflowId: testWorkflowId,
        variableName: "new_var",
        variableValue: "new_value",
      });

      expect(result).toHaveProperty("success", true);

      // Verify it was set
      const getResult = await callMCPTool(client, "manage", {
        action: "get-variable",
        workflowId: testWorkflowId,
        variableName: "new_var",
      });
      expect(getResult).toHaveProperty("value", "new_value");
    });

    test("set-variable updates existing variable", async () => {
      await callMCPTool(client, "manage", {
        action: "set-variable",
        workflowId: testWorkflowId,
        variableName: "existing_var",
        variableValue: "updated_value",
      });

      const result = await callMCPTool(client, "manage", {
        action: "get-variable",
        workflowId: testWorkflowId,
        variableName: "existing_var",
      });

      expect(result).toHaveProperty("value", "updated_value");
    });

    test("delete-variable removes variable", async () => {
      // First create a variable to delete
      await callMCPTool(client, "manage", {
        action: "set-variable",
        workflowId: testWorkflowId,
        variableName: "to_delete",
        variableValue: "temp",
      });

      // Delete it
      const deleteResult = await callMCPTool(client, "manage", {
        action: "delete-variable",
        workflowId: testWorkflowId,
        variableName: "to_delete",
      });

      expect(deleteResult).toHaveProperty("success", true);

      // Verify it's gone
      const listResult = await callMCPTool(client, "manage", {
        action: "list-variables",
        workflowId: testWorkflowId,
      });

      const varNames = listResult.variables.map((v: any) => v.name);
      expect(varNames).not.toContain("to_delete");
    });
  });

  describe("Diff Action", () => {
    let workflow1Id: string;
    let workflow2Id: string;

    beforeAll(async () => {
      // Create two workflows for comparison
      const result1 = await callMCPTool(client, "manage", {
        action: "create",
        workflow: {
          metadata: {
            name: "Diff Test Workflow 1",
            version: "1.0.0",
            description: "First workflow for diff test",
          },
          nodes: [
            { type: "start", id: "start", connections: { default: "step1" } },
            {
              type: "agent-directive",
              id: "step1",
              directive: "Original directive",
              completionCondition: "Done",
              connections: { success: "end" },
            },
            { type: "end", id: "end" },
          ],
        },
      });
      workflow1Id = result1.workflowId;
      createdWorkflows.push(workflow1Id);

      const result2 = await callMCPTool(client, "manage", {
        action: "create",
        workflow: {
          metadata: {
            name: "Diff Test Workflow 2",
            version: "2.0.0",
            description: "Second workflow for diff test",
          },
          nodes: [
            { type: "start", id: "start", connections: { default: "step1" } },
            {
              type: "agent-directive",
              id: "step1",
              directive: "Modified directive",
              completionCondition: "Done",
              connections: { success: "step2" },
            },
            {
              type: "agent-directive",
              id: "step2",
              directive: "New step",
              completionCondition: "Done",
              connections: { success: "end" },
            },
            { type: "end", id: "end" },
          ],
        },
      });
      workflow2Id = result2.workflowId;
      createdWorkflows.push(workflow2Id);
    });

    test("diff action returns comparison results", async () => {
      const result = await callMCPTool(client, "manage", {
        action: "diff",
        workflowId: workflow1Id,
        compareWorkflowId: workflow2Id,
      });

      expect(result).toHaveProperty("summary");
      expect(result).toHaveProperty("details");
    });

    test("diff detects metadata changes", async () => {
      const result = await callMCPTool(client, "manage", {
        action: "diff",
        workflowId: workflow1Id,
        compareWorkflowId: workflow2Id,
      });

      expect(result.details.metadata).toBeDefined();
      // Version changed from 1.0.0 to 2.0.0
      expect(result.details.metadata.version).toBeDefined();
    });

    test("diff detects added nodes", async () => {
      const result = await callMCPTool(client, "manage", {
        action: "diff",
        workflowId: workflow1Id,
        compareWorkflowId: workflow2Id,
      });

      expect(result.details.addedNodes).toBeDefined();
      expect(result.details.addedNodes).toContain("step2");
    });

    test("diff detects modified nodes", async () => {
      const result = await callMCPTool(client, "manage", {
        action: "diff",
        workflowId: workflow1Id,
        compareWorkflowId: workflow2Id,
      });

      expect(result.details.modifiedNodes).toBeDefined();
      const step1Mod = result.details.modifiedNodes.find((n: any) => n.id === "step1");
      expect(step1Mod).toBeDefined();
    });

    test("diff with same workflow returns no changes", async () => {
      const result = await callMCPTool(client, "manage", {
        action: "diff",
        workflowId: workflow1Id,
        compareWorkflowId: workflow1Id,
      });

      // Same workflow should be identical
      expect(result.identical).toBe(true);
    });
  });

  describe("Execution Note Magic Variable", () => {
    let workflowId: string;

    beforeAll(async () => {
      const result = await callMCPTool(client, "manage", {
        action: "create",
        workflow: {
          metadata: {
            name: "Execution Note Test",
            version: "1.0.0",
            description: "Test workflow for execution_note magic variable",
          },
          nodes: [
            { type: "start", id: "start", connections: { default: "step1" } },
            {
              type: "agent-directive",
              id: "step1",
              directive: "Provide execution note",
              completionCondition: "Note provided",
              connections: { success: "end" },
              inputSchema: {
                type: "object",
                properties: {
                  result: { type: "string" },
                  execution_note: { type: "string" },
                },
                required: ["result"],
              },
            },
            { type: "end", id: "end" },
          ],
        },
        overwrite: true,
      });
      workflowId = result.workflowId;
      createdWorkflows.push(workflowId);
    });

    test("execution_note updates execution note when provided", async () => {
      // Start workflow
      const startResult = await callMCPTool<string>(client, "start", {
        workflowId,
        parentExecutionId: "none",
      });

      const processIdMatch = startResult.match(/Process ID: ([a-f0-9-]+)/);
      expect(processIdMatch).toBeDefined();
      const processId = processIdMatch![1];

      // Execute step with execution_note - workflow will complete (reach end node)
      await callMCPTool(client, "step", {
        processId,
        input: {
          result: "completed",
          execution_note: "Test execution note via magic variable",
        },
      });

      // Check execution context to verify note was updated
      // Use execution_context action which works for any execution state
      const contextResult = await callMCPTool(client, "session", {
        action: "execution_context",
        executionId: processId,
      });

      expect(contextResult.note).toBe("Test execution note via magic variable");
    });
  });

  describe("Session Update Note", () => {
    test("session update-note updates execution note", async () => {
      // Create and start a workflow
      const createResult = await callMCPTool(client, "manage", {
        action: "create",
        workflow: {
          metadata: {
            name: "Update Note Test",
            version: "1.0.0",
            description: "Test",
          },
          nodes: [
            { type: "start", id: "start", connections: { default: "step1" } },
            {
              type: "agent-directive",
              id: "step1",
              directive: "Test step",
              completionCondition: "Done",
              connections: { success: "end" },
              inputSchema: {
                type: "object",
                properties: { result: { type: "string" } },
                required: ["result"],
              },
            },
            { type: "end", id: "end" },
          ],
        },
        overwrite: true,
      });
      const workflowId = createResult.workflowId;
      createdWorkflows.push(workflowId);

      // Start workflow
      const startResult = await callMCPTool<string>(client, "start", {
        workflowId,
        parentExecutionId: "none",
      });
      const processId = startResult.match(/Process ID: ([a-f0-9-]+)/)![1];

      // Update note via session tool
      const updateResult = await callMCPTool(client, "session", {
        action: "update-note",
        executionId: processId,
        note: "Updated via session tool",
      });

      // update-note returns {executionId, note, message}
      expect(updateResult.note).toBe("Updated via session tool");
      expect(updateResult.message).toBe("Note updated successfully");

      // Verify note was updated via execution_context
      const contextResult = await callMCPTool(client, "session", {
        action: "execution_context",
        executionId: processId,
      });

      expect(contextResult.note).toBe("Updated via session tool");
    });
  });

  describe("Conditional Templates", () => {
    test("conditional template in directive works correctly", async () => {
      const createResult = await callMCPTool(client, "manage", {
        action: "create",
        workflow: {
          metadata: {
            name: "Conditional Template Test",
            version: "1.0.0",
            description: "Test conditional templates",
          },
          variableRegistry: {
            has_feature: {
              type: "boolean",
              description: "Feature flag set by collect, used in the conditional",
            },
          },
          nodes: [
            {
              type: "start",
              id: "start",
              connections: { default: "collect" },
            },
            {
              type: "agent-directive",
              id: "collect",
              directive: "Set has_feature flag",
              completionCondition: "Flag set",
              connections: { success: "use-conditional" },
              inputSchema: {
                type: "object",
                globalInputs: ["has_feature"],
                properties: {},
                required: ["has_feature"],
              },
            },
            {
              type: "agent-directive",
              id: "use-conditional",
              directive:
                "{{#if has_feature}}Feature enabled: run feature tests{{else}}Feature disabled: skip feature tests{{/if}}",
              completionCondition: "Directive processed",
              connections: { success: "end" },
              inputSchema: {
                type: "object",
                properties: { result: { type: "string" } },
                required: ["result"],
              },
            },
            { type: "end", id: "end" },
          ],
        },
        overwrite: true,
      });
      const workflowId = createResult.workflowId;
      createdWorkflows.push(workflowId);

      // Test with has_feature = true
      const startResult = await callMCPTool<string>(client, "start", {
        workflowId,
        parentExecutionId: "none",
      });
      const processId = startResult.match(/Process ID: ([a-f0-9-]+)/)![1];

      // Set has_feature = true
      await callMCPTool(client, "step", {
        processId,
        input: { has_feature: true },
      });

      // Get current step - directive should show "Feature enabled"
      const currentStep = await callMCPTool<string>(client, "session", {
        action: "current_step",
        executionId: processId,
      });

      expect(currentStep).toContain("Feature enabled");
      expect(currentStep).not.toContain("{{#if");
      expect(currentStep).not.toContain("{{else}}");
    });

    test("conditional template with false condition", async () => {
      const createResult = await callMCPTool(client, "manage", {
        action: "create",
        workflow: {
          metadata: {
            name: "Conditional Template False Test",
            version: "1.0.0",
            description: "Test conditional templates with false",
          },
          variableRegistry: {
            test_mode: {
              type: "boolean",
              description: "Test-mode flag set by collect, used in the conditional",
            },
          },
          nodes: [
            {
              type: "start",
              id: "start",
              connections: { default: "collect" },
            },
            {
              type: "agent-directive",
              id: "collect",
              directive: "Set test_mode flag",
              completionCondition: "Flag set",
              connections: { success: "use-conditional" },
              inputSchema: {
                type: "object",
                globalInputs: ["test_mode"],
                properties: {},
                required: ["test_mode"],
              },
            },
            {
              type: "agent-directive",
              id: "use-conditional",
              directive: "{{#if test_mode}}Run tests{{else}}Skip tests{{/if}}",
              completionCondition: "Done",
              connections: { success: "end" },
              inputSchema: {
                type: "object",
                properties: { result: { type: "string" } },
                required: ["result"],
              },
            },
            { type: "end", id: "end" },
          ],
        },
        overwrite: true,
      });
      const workflowId = createResult.workflowId;
      createdWorkflows.push(workflowId);

      const startResult = await callMCPTool<string>(client, "start", {
        workflowId,
        parentExecutionId: "none",
      });
      const processId = startResult.match(/Process ID: ([a-f0-9-]+)/)![1];

      // Set test_mode = false
      await callMCPTool(client, "step", {
        processId,
        input: { test_mode: false },
      });

      const currentStep = await callMCPTool<string>(client, "session", {
        action: "current_step",
        executionId: processId,
      });

      expect(currentStep).toContain("Skip tests");
      expect(currentStep).not.toContain("Run tests");
    });
  });

  describe("Array Index Access", () => {
    test("array[index].field template works in directive", async () => {
      const createResult = await callMCPTool(client, "manage", {
        action: "create",
        workflow: {
          metadata: {
            name: "Array Access Test",
            version: "1.0.0",
            description: "Test array[index].field template",
          },
          variableRegistry: {
            items: {
              type: "array",
              description: "Array of items",
              default: [
                { name: "First Item", value: 100 },
                { name: "Second Item", value: 200 },
                { name: "Third Item", value: 300 },
              ],
            },
          },
          nodes: [
            {
              type: "start",
              id: "start",
              connections: { default: "step1" },
            },
            {
              type: "agent-directive",
              id: "step1",
              directive: "Process item: {{items[1].name}} with value {{items[1].value}}",
              completionCondition: "Item processed",
              connections: { success: "end" },
              inputSchema: {
                type: "object",
                properties: { result: { type: "string" } },
                required: ["result"],
              },
            },
            { type: "end", id: "end" },
          ],
        },
        overwrite: true,
      });
      const workflowId = createResult.workflowId;
      createdWorkflows.push(workflowId);

      const startResult = await callMCPTool<string>(client, "start", {
        workflowId,
        parentExecutionId: "none",
      });

      // Directive should contain resolved array values
      expect(startResult).toContain("Second Item");
      expect(startResult).toContain("200");
      expect(startResult).not.toContain("{{items[1]");
    });

    test("array[index] without field works", async () => {
      const createResult = await callMCPTool(client, "manage", {
        action: "create",
        workflow: {
          metadata: {
            name: "Simple Array Test",
            version: "1.0.0",
            description: "Test simple array access",
          },
          variableRegistry: {
            tags: {
              type: "array",
              description: "Array of tags",
              default: ["alpha", "beta", "gamma"],
            },
          },
          nodes: [
            {
              type: "start",
              id: "start",
              connections: { default: "step1" },
            },
            {
              type: "agent-directive",
              id: "step1",
              directive: "First tag: {{tags[0]}}, Second tag: {{tags[1]}}",
              completionCondition: "Done",
              connections: { success: "end" },
              inputSchema: {
                type: "object",
                properties: { result: { type: "string" } },
                required: ["result"],
              },
            },
            { type: "end", id: "end" },
          ],
        },
        overwrite: true,
      });
      const workflowId = createResult.workflowId;
      createdWorkflows.push(workflowId);

      const startResult = await callMCPTool<string>(client, "start", {
        workflowId,
        parentExecutionId: "none",
      });

      expect(startResult).toContain("alpha");
      expect(startResult).toContain("beta");
      expect(startResult).not.toContain("{{tags[");
    });
  });

  describe("Parent Execution Continuation", () => {
    test("start with parentExecutionId links executions", async () => {
      // Create parent workflow
      const parentCreateResult = await callMCPTool(client, "manage", {
        action: "create",
        workflow: {
          metadata: {
            name: "Parent Workflow",
            version: "1.0.0",
            description: "Parent for continuation test",
          },
          nodes: [
            { type: "start", id: "start", connections: { default: "step1" } },
            {
              type: "agent-directive",
              id: "step1",
              directive: "Parent step",
              completionCondition: "Done",
              connections: { success: "end" },
              inputSchema: {
                type: "object",
                properties: { result: { type: "string" } },
                required: ["result"],
              },
            },
            { type: "end", id: "end" },
          ],
        },
        overwrite: true,
      });
      const parentWorkflowId = parentCreateResult.workflowId;
      createdWorkflows.push(parentWorkflowId);

      // Create child workflow
      const childCreateResult = await callMCPTool(client, "manage", {
        action: "create",
        workflow: {
          metadata: {
            name: "Child Workflow",
            version: "1.0.0",
            description: "Child for continuation test",
          },
          nodes: [
            { type: "start", id: "start", connections: { default: "step1" } },
            {
              type: "agent-directive",
              id: "step1",
              directive: "Child step",
              completionCondition: "Done",
              connections: { success: "end" },
              inputSchema: {
                type: "object",
                properties: { result: { type: "string" } },
                required: ["result"],
              },
            },
            { type: "end", id: "end" },
          ],
        },
        overwrite: true,
      });
      const childWorkflowId = childCreateResult.workflowId;
      createdWorkflows.push(childWorkflowId);

      // Start parent (parentExecutionId="none" for standalone)
      const parentStart = await callMCPTool<string>(client, "start", {
        workflowId: parentWorkflowId,
        parentExecutionId: "none",
      });
      const parentProcessId = parentStart.match(/Process ID: ([a-f0-9-]+)/)![1];

      // Start child with parentExecutionId
      const childStart = await callMCPTool<string>(client, "start", {
        workflowId: childWorkflowId,
        parentExecutionId: parentProcessId,
      });

      // Child should start successfully
      expect(childStart).toContain("Process ID:");
      const childProcessId = childStart.match(/Process ID: ([a-f0-9-]+)/)![1];

      // Complete child workflow
      const completionResult = await callMCPTool<string>(client, "step", {
        processId: childProcessId,
        input: { result: "child completed" },
      });

      // Completion should mention parent continuation
      expect(completionResult).toMatch(/parent|continue|reminder/i);
    });
  });
});
