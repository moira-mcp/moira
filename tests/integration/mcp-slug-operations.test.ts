/**
 * MCP Slug Operations Integration Tests
 * Tests workflow slug-based resolution across MCP tools:
 * - Start workflow by slug
 * - Start workflow by handle/slug reference
 * - Manage workflow operations using slug
 * - Session tool returns workflow slug info
 */

import { describe, test, expect, beforeAll, afterAll } from "@jest/globals";
import { manageWorkflow } from "../../packages/mcp-server/src/tools/manage-workflow.js";
import { startWorkflow } from "../../packages/mcp-server/src/tools/start-workflow.js";
import { getSessionInfo } from "../../packages/mcp-server/src/tools/get-session-info.js";
import { runWithMCPContext } from "../../packages/mcp-server/src/core/request-context.js";
import { DatabaseRepository } from "@mcp-moira/workflow-engine";
import { getDatabase, user } from "@mcp-moira/shared";
import type { WorkflowGraph } from "@mcp-moira/workflow-engine";

const TEST_USER_ID = "test-slug-operations-user";
const TEST_USER_HANDLE = "test-slug-user";

// Simple test workflow
const testWorkflow: WorkflowGraph = {
  id: "test-slug-workflow",
  metadata: {
    name: "Test Slug Workflow",
    version: "1.0.0",
    description: "Workflow for testing slug-based operations",
  },
  nodes: [
    {
      id: "start",
      type: "start",
      connections: { default: "step-1" },
    },
    {
      id: "step-1",
      type: "agent-directive",
      directive: "Simple directive",
      completionCondition: "Done",
      connections: { success: "end" },
    },
    {
      id: "end",
      type: "end",
    },
  ],
};

describe("MCP Slug Operations Integration Tests", () => {
  let repository: DatabaseRepository;
  let workflowId: string;
  let workflowSlug: string;

  beforeAll(async () => {
    repository = new DatabaseRepository();

    // Create test user with handle
    const db = getDatabase();
    const now = new Date().toISOString();

    try {
      await db.insert(user).values({
        id: TEST_USER_ID,
        email: `${TEST_USER_ID}@test.com`,
        name: "Slug Operations Test User",
        handle: TEST_USER_HANDLE,
        emailVerified: false,
        createdAt: now,
        updatedAt: now,
      });
    } catch {
      // User might already exist
    }

    // Create test workflow and capture UUID and slug
    const createResult = await runWithMCPContext({ userId: TEST_USER_ID }, async () => {
      return manageWorkflow({
        action: "create",
        workflow: testWorkflow,
        overwrite: true,
      });
    });

    expect(createResult.success).toBe(true);
    workflowId = createResult.data.workflowId;
    workflowSlug = createResult.data.slug;
  });

  afterAll(async () => {
    // Cleanup test workflow
    try {
      await repository.deleteWorkflow(workflowId, TEST_USER_ID);
    } catch {
      // Ignore cleanup errors
    }
  });

  describe("Start workflow by slug", () => {
    test("starts workflow using slug instead of UUID", async () => {
      const result = await runWithMCPContext({ userId: TEST_USER_ID }, async () => {
        return startWorkflow({
          workflowId: workflowSlug,
          parentExecutionId: "none",
        });
      });

      expect(result.success).toBe(true);
      expect(result.data).toBeDefined();
      // Should contain the workflow directive
      expect(result.data).toContain("directive");
    });

    test("starts workflow using UUID", async () => {
      const result = await runWithMCPContext({ userId: TEST_USER_ID }, async () => {
        return startWorkflow({
          workflowId: workflowId,
          parentExecutionId: "none",
        });
      });

      expect(result.success).toBe(true);
      expect(result.data).toBeDefined();
    });

    test("starts workflow using handle/slug reference", async () => {
      const reference = `${TEST_USER_HANDLE}/${workflowSlug}`;

      const result = await runWithMCPContext({ userId: TEST_USER_ID }, async () => {
        return startWorkflow({
          workflowId: reference,
          parentExecutionId: "none",
        });
      });

      expect(result.success).toBe(true);
      expect(result.data).toBeDefined();
    });

    test("returns error for non-existent slug", async () => {
      const result = await runWithMCPContext({ userId: TEST_USER_ID }, async () => {
        return startWorkflow({
          workflowId: "non-existent-slug",
          parentExecutionId: "none",
        });
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("not found");
    });
  });

  describe("Manage workflow by slug", () => {
    test("get workflow using slug", async () => {
      const result = await runWithMCPContext({ userId: TEST_USER_ID }, async () => {
        return manageWorkflow({
          action: "get",
          workflowId: workflowSlug,
        });
      });

      expect(result.success).toBe(true);
      expect(result.data).toBeDefined();
      expect(result.data.metadata.name).toBe("Test Slug Workflow");
    });

    test("get-structure using slug", async () => {
      const result = await runWithMCPContext({ userId: TEST_USER_ID }, async () => {
        return manageWorkflow({
          action: "get-structure",
          workflowId: workflowSlug,
        });
      });

      expect(result.success).toBe(true);
      expect(result.data).toBeDefined();
      expect(result.data.metadata.name).toBe("Test Slug Workflow");
      expect(result.data.stats.totalNodes).toBe(3);
    });

    test("get-node using slug for workflowId", async () => {
      const result = await runWithMCPContext({ userId: TEST_USER_ID }, async () => {
        return manageWorkflow({
          action: "get-node",
          workflowId: workflowSlug,
          nodeId: "step-1",
        });
      });

      expect(result.success).toBe(true);
      expect(result.data).toBeDefined();
      expect(result.data.node).toBeDefined();
      expect(result.data.node.id).toBe("step-1");
      expect(result.data.node.directive).toBe("Simple directive");
    });

    test("search-nodes using slug", async () => {
      const result = await runWithMCPContext({ userId: TEST_USER_ID }, async () => {
        return manageWorkflow({
          action: "search-nodes",
          workflowId: workflowSlug,
          query: "directive",
        });
      });

      expect(result.success).toBe(true);
      expect(result.data).toBeDefined();
      expect(result.data.results).toBeDefined();
      expect(result.data.resultCount).toBeGreaterThan(0);
    });

    test("get-variable using slug", async () => {
      // First set a variable (variableValue is the actual value, stored as VariableInfo.value)
      await runWithMCPContext({ userId: TEST_USER_ID }, async () => {
        return manageWorkflow({
          action: "set-variable",
          workflowId: workflowSlug,
          variableName: "testVar",
          variableValue: "test-value",
        });
      });

      const result = await runWithMCPContext({ userId: TEST_USER_ID }, async () => {
        return manageWorkflow({
          action: "get-variable",
          workflowId: workflowSlug,
          variableName: "testVar",
        });
      });

      expect(result.success).toBe(true);
      expect(result.data).toBeDefined();
      expect(result.data.value).toBe("test-value");
    });

    test("edit using slug", async () => {
      const result = await runWithMCPContext({ userId: TEST_USER_ID }, async () => {
        return manageWorkflow({
          action: "edit",
          workflowId: workflowSlug,
          changes: {
            metadata: {
              description: "Updated description via slug",
            },
          },
        });
      });

      expect(result.success).toBe(true);

      // Verify the change
      const getResult = await runWithMCPContext({ userId: TEST_USER_ID }, async () => {
        return manageWorkflow({
          action: "get",
          workflowId: workflowSlug,
        });
      });

      expect(getResult.data.metadata.description).toBe("Updated description via slug");
    });

    test("list-nodes using slug", async () => {
      const result = await runWithMCPContext({ userId: TEST_USER_ID }, async () => {
        return manageWorkflow({
          action: "list-nodes",
          workflowId: workflowSlug,
        });
      });

      expect(result.success).toBe(true);
      expect(result.data).toBeDefined();
      expect(result.data.nodes).toBeDefined();
      expect(result.data.nodes.length).toBe(3);
    });
  });

  describe("Session tool with workflow slug", () => {
    test("executions list includes workflowSlug and workflowOwnerHandle", async () => {
      // First start a workflow to create an execution
      await runWithMCPContext({ userId: TEST_USER_ID }, async () => {
        return startWorkflow({
          workflowId: workflowSlug,
          parentExecutionId: "none",
          note: "Test execution for slug check",
        });
      });

      // Now list executions
      const result = await runWithMCPContext({ userId: TEST_USER_ID }, async () => {
        return getSessionInfo({
          action: "executions",
          status: ["running", "waiting"],
        });
      });

      expect(result.success).toBe(true);
      expect(result.data).toBeDefined();
      expect(result.data.executions.length).toBeGreaterThan(0);

      // Find our test execution
      const testExecution = result.data.executions.find(
        (e: { note?: string }) => e.note === "Test execution for slug check",
      );

      expect(testExecution).toBeDefined();
      expect(testExecution.workflowSlug).toBe(workflowSlug);
      expect(testExecution.workflowOwnerHandle).toBe(TEST_USER_HANDLE);
    });

    test("execution_context includes workflowSlug and workflowOwnerHandle", async () => {
      // First start a workflow
      const startResult = await runWithMCPContext({ userId: TEST_USER_ID }, async () => {
        return startWorkflow({
          workflowId: workflowSlug,
          parentExecutionId: "none",
        });
      });

      expect(startResult.success).toBe(true);

      // Get the execution ID from the response (extract from formatted text)
      const executions = await runWithMCPContext({ userId: TEST_USER_ID }, async () => {
        return getSessionInfo({
          action: "executions",
          status: ["running", "waiting"],
          limit: 1,
        });
      });

      expect(executions.data.executions.length).toBeGreaterThan(0);
      const executionId = executions.data.executions[0].executionId;

      // Get execution context
      const result = await runWithMCPContext({ userId: TEST_USER_ID }, async () => {
        return getSessionInfo({
          action: "execution_context",
          executionId,
        });
      });

      expect(result.success).toBe(true);
      expect(result.data).toBeDefined();
      expect(result.data.workflowSlug).toBe(workflowSlug);
      expect(result.data.workflowOwnerHandle).toBe(TEST_USER_HANDLE);
    });
  });

  describe("Handle/slug reference format", () => {
    test("get workflow using handle/slug reference", async () => {
      const reference = `${TEST_USER_HANDLE}/${workflowSlug}`;

      const result = await runWithMCPContext({ userId: TEST_USER_ID }, async () => {
        return manageWorkflow({
          action: "get",
          workflowId: reference,
        });
      });

      expect(result.success).toBe(true);
      expect(result.data).toBeDefined();
      expect(result.data.metadata.name).toBe("Test Slug Workflow");
    });

    test("returns error for invalid handle/slug reference", async () => {
      const result = await runWithMCPContext({ userId: TEST_USER_ID }, async () => {
        return manageWorkflow({
          action: "get",
          workflowId: "nonexistent-handle/nonexistent-slug",
        });
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("not found");
    });
  });
});
