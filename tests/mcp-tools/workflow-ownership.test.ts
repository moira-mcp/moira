/**
 * MCP E2E Tests - Workflow Ownership & Security
 * Tests: visibility, ownership, authorization for manage actions
 *
 * Issue #11: Security tests for workflow ownership
 */

import { describe, test, expect, beforeAll, afterAll } from "@jest/globals";
import {
  createAuthenticatedMCPClient,
  callMCPTool,
  callMCPToolRaw,
  createTestUserViaApi,
} from "../utils/mcp-auth.js";
import { getTestFetchUrl } from "../utils/test-config.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

describe("MCP Workflow Ownership & Security E2E", () => {
  // Admin client (owner of workflows)
  let adminClient: Client;
  let adminCleanup: () => Promise<void>;

  // Second user client (non-owner)
  let userClient: Client;
  let userCleanup: () => Promise<void>;

  const testWorkflows: string[] = [];
  const timestamp = Date.now();

  // Test user credentials
  const testUserEmail = `security-test-${timestamp}@test.local`;
  const testUserPassword = "SecureTest123!";

  beforeAll(async () => {
    const fetchUrl = getTestFetchUrl();

    // Create admin client (uses default admin credentials)
    const adminMcp = await createAuthenticatedMCPClient();
    adminClient = adminMcp.client;
    adminCleanup = adminMcp.cleanup;

    // Create test user via API
    await createTestUserViaApi(
      fetchUrl,
      testUserEmail,
      testUserPassword,
      "Security Test User",
      true, // verify email
    );

    // Create second user's MCP client
    const userMcp = await createAuthenticatedMCPClient({
      email: testUserEmail,
      password: testUserPassword,
    });
    userClient = userMcp.client;
    userCleanup = userMcp.cleanup;
  });

  afterAll(async () => {
    await userCleanup();
    await adminCleanup();
  });

  describe("Private Workflow Access Control", () => {
    let privateWorkflowId: string;

    beforeAll(async () => {
      // Admin creates a private workflow
      const createResult = await callMCPTool(adminClient, "manage", {
        action: "create",
        workflow: {
          visibility: "private",
          metadata: {
            name: "Private Security Test",
            version: "1.0.0",
            description: "Private workflow for security testing",
          },
          nodes: [
            { type: "start", id: "start", connections: { default: "step1" } },
            {
              type: "agent-directive",
              id: "step1",
              directive: "Do something",
              completionCondition: "Done",
              connections: { success: "end" },
            },
            { type: "end", id: "end" },
          ],
        },
      });
      privateWorkflowId = createResult.workflowId;
      testWorkflows.push(privateWorkflowId);
    });

    test("owner can read own private workflow", async () => {
      const result = await callMCPTool(adminClient, "manage", {
        action: "get",
        workflowId: privateWorkflowId,
      });

      // Response uses workflowId not id
      expect(result).toHaveProperty("workflowId", privateWorkflowId);
      expect(result).toHaveProperty("visibility", "private");
      expect(result.metadata.name).toBe("Private Security Test");
    });

    test("owner can edit own private workflow", async () => {
      const result = await callMCPTool(adminClient, "manage", {
        action: "edit",
        workflowId: privateWorkflowId,
        changes: {
          metadata: {
            description: "Updated description by owner",
          },
        },
      });

      expect(result).toHaveProperty("success", true);
    });

    test("non-owner cannot read private workflow", async () => {
      const result = await callMCPTool<string>(userClient, "manage", {
        action: "get",
        workflowId: privateWorkflowId,
      });

      // Should return error message
      expect(typeof result).toBe("string");
      expect(result.toLowerCase()).toMatch(
        /not found|access denied|forbidden|unauthorized|private/,
      );
    });

    test("non-owner cannot edit private workflow", async () => {
      const result = await callMCPTool<string>(userClient, "manage", {
        action: "edit",
        workflowId: privateWorkflowId,
        changes: {
          metadata: {
            description: "Malicious update attempt",
          },
        },
      });

      // Should return error message
      expect(typeof result).toBe("string");
      expect(result.toLowerCase()).toMatch(
        /not found|access denied|forbidden|unauthorized|cannot|private/,
      );
    });

    // Note: With UUID-based workflow IDs, users cannot specify IDs directly,
    // so the "overwrite with same ID" attack vector is no longer possible.
    // The system generates unique UUIDs for each workflow.

    test("private workflow not visible in list for non-owner", async () => {
      const result = await callMCPTool(userClient, "list", {});
      const workflows = result.workflows || result;

      const found = workflows.find((w: any) => w.id === privateWorkflowId);
      expect(found).toBeUndefined();
    });
  });

  describe("Public Workflow Access Control", () => {
    let publicWorkflowId: string;
    let publicWorkflowSlug: string;

    beforeAll(async () => {
      // Admin creates a public workflow
      const createResult = await callMCPTool(adminClient, "manage", {
        action: "create",
        workflow: {
          visibility: "public",
          metadata: {
            name: "Public Security Test",
            version: "1.0.0",
            description: "Public workflow for security testing",
          },
          nodes: [
            { type: "start", id: "start", connections: { default: "step1" } },
            {
              type: "agent-directive",
              id: "step1",
              directive: "Public step",
              completionCondition: "Done",
              connections: { success: "end" },
            },
            { type: "end", id: "end" },
          ],
        },
      });
      publicWorkflowId = createResult.workflowId;
      publicWorkflowSlug = createResult.slug;
      testWorkflows.push(publicWorkflowId);
    });

    test("non-owner can read public workflow", async () => {
      const result = await callMCPTool(userClient, "manage", {
        action: "get",
        workflowId: publicWorkflowId,
      });

      expect(result).toHaveProperty("workflowId", publicWorkflowId);
      expect(result).toHaveProperty("visibility", "public");
      expect(result.metadata.name).toBe("Public Security Test");
    });

    test("non-owner cannot edit public workflow", async () => {
      const result = await callMCPTool<string>(userClient, "manage", {
        action: "edit",
        workflowId: publicWorkflowId,
        changes: {
          metadata: {
            description: "Unauthorized edit attempt",
          },
        },
      });

      // Should return error - can read but not edit
      expect(typeof result).toBe("string");
      expect(result.toLowerCase()).toMatch(
        /access denied|forbidden|unauthorized|cannot|permission|not allowed|owned/,
      );
    });

    // Note: With UUID-based workflow IDs, users cannot specify IDs directly,
    // so the "overwrite with same ID" attack vector is no longer possible.
    // The system generates unique UUIDs for each workflow.

    test("public workflow visible in list for non-owner", async () => {
      const result = await callMCPTool(userClient, "list", {});
      const workflows = result.workflows || result;

      // Match by slug since list id is now "handle/slug" format, not UUID
      const found = workflows.find((w: any) => w.slug === publicWorkflowSlug);
      expect(found).toBeDefined();
      expect(found.name).toBe("Public Security Test");
    });

    test("owner can edit own public workflow", async () => {
      const result = await callMCPTool(adminClient, "manage", {
        action: "edit",
        workflowId: publicWorkflowId,
        changes: {
          metadata: {
            description: "Updated by owner",
          },
        },
      });

      expect(result).toHaveProperty("success", true);
    });
  });

  describe("User Own Workflows", () => {
    let userOwnWorkflowId: string;

    test("user can create own workflow", async () => {
      const result = await callMCPTool(userClient, "manage", {
        action: "create",
        workflow: {
          visibility: "private",
          metadata: {
            name: "User Own Workflow",
            version: "1.0.0",
            description: "Created by non-admin user",
          },
          nodes: [
            { type: "start", id: "start", connections: { default: "end" } },
            { type: "end", id: "end" },
          ],
        },
      });

      expect(result).toHaveProperty("success", true);
      expect(result).toHaveProperty("workflowId");
      userOwnWorkflowId = result.workflowId;
      testWorkflows.push(userOwnWorkflowId);
    });

    test("user can read own workflow", async () => {
      expect(userOwnWorkflowId).toBeDefined();
      const result = await callMCPTool(userClient, "manage", {
        action: "get",
        workflowId: userOwnWorkflowId,
      });

      expect(result).toHaveProperty("workflowId", userOwnWorkflowId);
      expect(result.metadata.name).toBe("User Own Workflow");
    });

    test("user can edit own workflow", async () => {
      expect(userOwnWorkflowId).toBeDefined();
      const result = await callMCPTool(userClient, "manage", {
        action: "edit",
        workflowId: userOwnWorkflowId,
        changes: {
          metadata: {
            description: "Updated by owner",
          },
        },
      });

      expect(result).toHaveProperty("success", true);
    });

    test("admin cannot edit user private workflow", async () => {
      expect(userOwnWorkflowId).toBeDefined();
      // Admin should not be able to edit other users' private workflows
      // This tests that admin doesn't have super-powers over user content
      const result = await callMCPTool<string>(adminClient, "manage", {
        action: "edit",
        workflowId: userOwnWorkflowId,
        changes: {
          metadata: {
            description: "Admin trying to edit user workflow",
          },
        },
      });

      // Admin should get access denied for other users' private workflows
      expect(typeof result).toBe("string");
      expect(result.toLowerCase()).toMatch(
        /not found|access denied|forbidden|unauthorized|cannot|permission/,
      );
    });
  });

  describe("Workflow Execution Security", () => {
    let privateExecWorkflowId: string;

    beforeAll(async () => {
      // Admin creates a private workflow
      const createResult = await callMCPTool(adminClient, "manage", {
        action: "create",
        workflow: {
          visibility: "private",
          metadata: {
            name: "Private Execution Test",
            version: "1.0.0",
            description: "Private workflow for execution security testing",
          },
          nodes: [
            { type: "start", id: "start", connections: { default: "step1" } },
            {
              type: "agent-directive",
              id: "step1",
              directive: "Confirm execution",
              completionCondition: "Confirmed",
              connections: { success: "end" },
            },
            { type: "end", id: "end" },
          ],
        },
      });
      privateExecWorkflowId = createResult.workflowId;
      testWorkflows.push(privateExecWorkflowId);
    });

    test("non-owner cannot start private workflow", async () => {
      const result = await callMCPToolRaw(userClient, "start", {
        parentExecutionId: "none",
        workflowId: privateExecWorkflowId,
      });

      // Should not be able to start private workflow of another user
      expect(result.toLowerCase()).toMatch(
        /not found|access denied|forbidden|unauthorized|cannot|private|error/,
      );
    });

    test("owner can start own private workflow", async () => {
      const result = await callMCPToolRaw(adminClient, "start", {
        parentExecutionId: "none",
        workflowId: privateExecWorkflowId,
      });

      // Start returns text format: "Process ID: xxx\nYour next task:..."
      expect(result).toMatch(/Process ID:/);
      expect(result).toMatch(/Confirm execution/);
    });
  });

  describe("Variable Functions Security", () => {
    let varWorkflowId: string;

    beforeAll(async () => {
      // Admin creates workflow with variables
      const createResult = await callMCPTool(adminClient, "manage", {
        action: "create",
        workflow: {
          visibility: "private",
          metadata: {
            name: "Variable Security Test",
            version: "1.0.0",
            description: "Private workflow for variable security testing",
          },
          variableRegistry: {
            secret_data: {
              type: "string",
              description: "Secret data",
              default: "confidential_value",
            },
          },
          nodes: [
            { type: "start", id: "start", connections: { default: "end" } },
            { type: "end", id: "end" },
          ],
        },
      });
      varWorkflowId = createResult.workflowId;
      testWorkflows.push(varWorkflowId);
    });

    test("non-owner cannot access workflow variables", async () => {
      const result = await callMCPTool<string>(userClient, "manage", {
        action: "list-variables",
        workflowId: varWorkflowId,
      });

      // Should not be able to list variables of another user's private workflow
      expect(typeof result).toBe("string");
      expect(result.toLowerCase()).toMatch(
        /not found|access denied|forbidden|unauthorized|cannot|private|error/,
      );
    });

    test("non-owner cannot get specific variable", async () => {
      const result = await callMCPTool<string>(userClient, "manage", {
        action: "get-variable",
        workflowId: varWorkflowId,
        variableName: "secret_data",
      });

      expect(typeof result).toBe("string");
      expect(result.toLowerCase()).toMatch(
        /not found|access denied|forbidden|unauthorized|cannot|private|error/,
      );
    });

    test("non-owner cannot set variable in others workflow", async () => {
      const result = await callMCPTool<string>(userClient, "manage", {
        action: "set-variable",
        workflowId: varWorkflowId,
        variableName: "injected_var",
        variableValue: "malicious_value",
      });

      expect(typeof result).toBe("string");
      expect(result.toLowerCase()).toMatch(
        /not found|access denied|forbidden|unauthorized|cannot|private|error/,
      );
    });

    test("non-owner cannot delete variable in others workflow", async () => {
      const result = await callMCPTool<string>(userClient, "manage", {
        action: "delete-variable",
        workflowId: varWorkflowId,
        variableName: "secret_data",
      });

      expect(typeof result).toBe("string");
      expect(result.toLowerCase()).toMatch(
        /not found|access denied|forbidden|unauthorized|cannot|private|error/,
      );
    });

    test("owner can access own workflow variables", async () => {
      const result = await callMCPTool(adminClient, "manage", {
        action: "list-variables",
        workflowId: varWorkflowId,
      });

      expect(result).toHaveProperty("variables");
      const varNames = result.variables.map((v: any) => v.name);
      expect(varNames).toContain("secret_data");
    });
  });

  describe("Diff Action Security", () => {
    let diffPrivateWorkflowId: string;

    beforeAll(async () => {
      const createResult = await callMCPTool(adminClient, "manage", {
        action: "create",
        workflow: {
          visibility: "private",
          metadata: {
            name: "Diff Private Test",
            version: "1.0.0",
            description: "Private workflow for diff security testing",
          },
          nodes: [
            { type: "start", id: "start", connections: { default: "end" } },
            { type: "end", id: "end" },
          ],
        },
      });
      diffPrivateWorkflowId = createResult.workflowId;
      testWorkflows.push(diffPrivateWorkflowId);
    });

    test("non-owner cannot diff private workflows", async () => {
      // Try to use diff action on private workflow
      const result = await callMCPTool<string>(userClient, "manage", {
        action: "diff",
        workflowId: diffPrivateWorkflowId,
        compareWorkflowId: diffPrivateWorkflowId,
      });

      // Should not be able to access private workflow for diff
      expect(typeof result).toBe("string");
      expect(result.toLowerCase()).toMatch(
        /not found|access denied|forbidden|unauthorized|cannot|private|error/,
      );
    });

    test("owner can diff own private workflow", async () => {
      const result = await callMCPTool(adminClient, "manage", {
        action: "diff",
        workflowId: diffPrivateWorkflowId,
        compareWorkflowId: diffPrivateWorkflowId,
      });

      expect(result).toHaveProperty("identical", true);
    });
  });
});
