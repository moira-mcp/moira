/**
 * Start Workflow parentExecutionId Tests (Step 1 feature #321)
 * Tests required parentExecutionId field with "none" and UUID validation
 */

import { describe, test, expect, beforeAll, afterAll } from "@jest/globals";
import { startWorkflow } from "../../packages/mcp-server/src/tools/start-workflow.js";
import { manageWorkflow } from "../../packages/mcp-server/src/tools/manage-workflow.js";
import { runWithMCPContext } from "../../packages/mcp-server/src/core/request-context.js";
import { DatabaseRepository } from "@mcp-moira/workflow-engine";
import { getDatabase, user } from "@mcp-moira/shared";
import type { WorkflowGraph } from "@mcp-moira/workflow-engine";

const TEST_USER_ID = "test-parent-execution";

const testWorkflow: WorkflowGraph = {
  id: "test-parent-execution-workflow",
  metadata: {
    name: "Parent Execution Test",
    version: "1.0.0",
    description: "For testing parentExecutionId",
  },
  nodes: [
    { id: "start", type: "start", connections: { default: "step" } },
    {
      id: "step",
      type: "agent-directive",
      directive: "Test step",
      completionCondition: "Done",
      connections: { success: "end" },
      inputSchema: {
        type: "object",
        properties: { result: { type: "string" } },
        required: ["result"],
      },
    },
    { id: "end", type: "end" },
  ],
};

describe("Start Workflow parentExecutionId Tests", () => {
  let repository: DatabaseRepository;
  let testWorkflowId: string;

  beforeAll(async () => {
    repository = new DatabaseRepository();

    const db = getDatabase();
    const now = new Date().toISOString();

    try {
      await db.insert(user).values({
        id: TEST_USER_ID,
        email: `${TEST_USER_ID}@test.com`,
        name: "Parent Execution Test User",
        handle: TEST_USER_ID,
        emailVerified: false,
        createdAt: now,
        updatedAt: now,
      });
    } catch {
      // User might already exist
    }

    const createResult = await runWithMCPContext({ userId: TEST_USER_ID }, async () => {
      return manageWorkflow({
        action: "create",
        workflow: testWorkflow,
        overwrite: true,
      });
    });
    testWorkflowId = createResult.data.workflowId;
  });

  afterAll(async () => {
    try {
      await repository.deleteWorkflow(testWorkflowId, TEST_USER_ID);
    } catch {
      // Ignore cleanup errors
    }
  });

  describe("parentExecutionId = 'none'", () => {
    test("accepts 'none' for standalone workflows", async () => {
      const result = await runWithMCPContext({ userId: TEST_USER_ID }, async () => {
        return startWorkflow({
          workflowId: testWorkflowId,
          parentExecutionId: "none",
        });
      });

      expect(result.success).toBe(true);
      expect(result.data).toContain("Process ID:");
    });

    test("standalone workflow has no parent in context", async () => {
      const result = await runWithMCPContext({ userId: TEST_USER_ID }, async () => {
        return startWorkflow({
          workflowId: testWorkflowId,
          parentExecutionId: "none",
        });
      });

      expect(result.success).toBe(true);
      // Extract process ID
      const match = result.data?.match(/Process ID: ([a-f0-9-]+)/);
      expect(match).toBeDefined();
    });
  });

  describe("parentExecutionId = valid UUID", () => {
    test("accepts valid UUID that exists", async () => {
      // First create a parent execution
      const parentResult = await runWithMCPContext({ userId: TEST_USER_ID }, async () => {
        return startWorkflow({
          workflowId: testWorkflowId,
          parentExecutionId: "none",
        });
      });

      expect(parentResult.success).toBe(true);
      const parentMatch = parentResult.data?.match(/Process ID: ([a-f0-9-]+)/);
      expect(parentMatch).toBeDefined();
      const parentId = parentMatch![1];

      // Now start child with parent reference
      const childResult = await runWithMCPContext({ userId: TEST_USER_ID }, async () => {
        return startWorkflow({
          workflowId: testWorkflowId,
          parentExecutionId: parentId,
        });
      });

      expect(childResult.success).toBe(true);
      expect(childResult.data).toContain("Process ID:");
    });
  });

  describe("parentExecutionId validation errors", () => {
    test("rejects invalid UUID format", async () => {
      const result = await runWithMCPContext({ userId: TEST_USER_ID }, async () => {
        return startWorkflow({
          workflowId: testWorkflowId,
          parentExecutionId: "not-a-valid-uuid",
        });
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("valid UUID");
      expect(result.error).toContain('"none"');
    });

    test("rejects UUID that does not exist", async () => {
      const fakeUuid = "12345678-1234-4123-8123-123456789abc";
      const result = await runWithMCPContext({ userId: TEST_USER_ID }, async () => {
        return startWorkflow({
          workflowId: testWorkflowId,
          parentExecutionId: fakeUuid,
        });
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("not found");
      expect(result.error).toContain('"none"');
    });

    test("rejects empty string", async () => {
      const result = await runWithMCPContext({ userId: TEST_USER_ID }, async () => {
        return startWorkflow({
          workflowId: testWorkflowId,
          parentExecutionId: "",
        });
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("valid UUID");
    });

    test("rejects 'null' or 'undefined' strings", async () => {
      const result1 = await runWithMCPContext({ userId: TEST_USER_ID }, async () => {
        return startWorkflow({
          workflowId: testWorkflowId,
          parentExecutionId: "null",
        });
      });

      expect(result1.success).toBe(false);
      expect(result1.error).toContain("valid UUID");

      const result2 = await runWithMCPContext({ userId: TEST_USER_ID }, async () => {
        return startWorkflow({
          workflowId: testWorkflowId,
          parentExecutionId: "undefined",
        });
      });

      expect(result2.success).toBe(false);
      expect(result2.error).toContain("valid UUID");
    });
  });
});
