/**
 * MCP E2E Tests - Workflow Sharing Actions
 * Tests: create-invite, list-access, list-invites, revoke-access, revoke-invite
 *
 * Issue #433: Workflow sharing via invite links
 */

import { describe, test, expect, beforeAll, afterAll } from "@jest/globals";
import {
  createAuthenticatedMCPClient,
  callMCPTool,
  createTestUserViaApi,
} from "../utils/mcp-auth.js";
import { MCP_TEST_DATA } from "../fixtures/mcp-test-data.js";
import { getTestBaseUrl } from "../utils/test-config.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

const { CRUD_WORKFLOWS } = MCP_TEST_DATA;

describe("MCP Workflow Sharing Tools E2E", () => {
  let ownerClient: Client;
  let ownerCleanup: () => Promise<void>;

  let recipientClient: Client;
  let recipientCleanup: () => Promise<void>;

  let testWorkflowId: string;
  let testWorkflowSlug: string;
  const createdWorkflows: string[] = [];

  // Unique test user credentials
  const recipientEmail = `share-test-${Date.now()}@example.com`;
  const recipientPassword = "testpass123";
  let recipientUserId: string;

  beforeAll(async () => {
    const baseUrl = getTestBaseUrl();

    // Create owner client (admin user)
    const ownerMcp = await createAuthenticatedMCPClient();
    ownerClient = ownerMcp.client;
    ownerCleanup = ownerMcp.cleanup;

    // Create recipient user and client
    const recipientUser = await createTestUserViaApi(
      baseUrl,
      recipientEmail,
      recipientPassword,
      "Share Test User",
      true, // verifyEmail
    );
    recipientUserId = recipientUser.userId;

    const recipientMcp = await createAuthenticatedMCPClient({
      email: recipientEmail,
      password: recipientPassword,
    });
    recipientClient = recipientMcp.client;
    recipientCleanup = recipientMcp.cleanup;

    // Create a test workflow for sharing tests
    const workflow = {
      ...CRUD_WORKFLOWS.SIMPLE_CREATE,
      id: `share-test-${Date.now()}`,
      metadata: {
        ...CRUD_WORKFLOWS.SIMPLE_CREATE.metadata,
        name: "Sharing Test Workflow",
        description: "Workflow for testing sharing functionality",
      },
    };

    const result = await callMCPTool(ownerClient, "manage", {
      action: "create",
      workflow,
    });

    testWorkflowId = result.workflowId;
    testWorkflowSlug = result.slug;
    createdWorkflows.push(testWorkflowId);
  });

  afterAll(async () => {
    // Cleanup workflows
    for (const workflowId of createdWorkflows) {
      try {
        // Delete workflow (no delete action in manage, would need to check if supported)
      } catch {
        // Ignore cleanup errors
      }
    }

    await ownerCleanup?.();
    await recipientCleanup?.();
  });

  describe("create-invite", () => {
    test("owner can create invite for owned workflow", async () => {
      const result = await callMCPTool(ownerClient, "manage", {
        action: "create-invite",
        workflowId: testWorkflowId,
      });

      expect(result).toHaveProperty("success", true);
      expect(result).toHaveProperty("workflowId", testWorkflowId);
      expect(result).toHaveProperty("invite");
      expect(result.invite).toHaveProperty("id");
      expect(result.invite).toHaveProperty("token");
      expect(result.invite).toHaveProperty("expiresAt");
      expect(result.invite).toHaveProperty("remainingMs");
      expect(result).toHaveProperty("inviteUrl");
      expect(result.inviteUrl).toContain("/invites/");
      expect(result.inviteUrl).toContain(result.invite.token);
    });

    test("owner can create invite with custom TTL", async () => {
      const customTtlMs = 1000 * 60 * 60 * 24; // 1 day

      const result = await callMCPTool(ownerClient, "manage", {
        action: "create-invite",
        workflowId: testWorkflowId,
        ttlMs: customTtlMs,
      });

      expect(result).toHaveProperty("success", true);
      expect(result.invite.remainingMs).toBeLessThanOrEqual(customTtlMs);
      expect(result.invite.remainingMs).toBeGreaterThan(customTtlMs - 5000); // Allow 5s tolerance
    });

    test("non-owner cannot create invite", async () => {
      const result = await callMCPTool(recipientClient, "manage", {
        action: "create-invite",
        workflowId: testWorkflowId,
      });

      // Error returns as string or object with success: false
      if (typeof result === "string") {
        expect(result).toMatch(/not found|denied|access/i);
      } else {
        expect(result).toHaveProperty("success", false);
      }
    });

    test("create-invite requires workflowId", async () => {
      const result = await callMCPTool(ownerClient, "manage", {
        action: "create-invite",
      });

      // Error returns as string or object with success: false
      if (typeof result === "string") {
        expect(result).toMatch(/workflow.*id|required/i);
      } else {
        expect(result).toHaveProperty("success", false);
        expect(result.error).toContain("Workflow ID");
      }
    });
  });

  describe("list-invites", () => {
    let createdInviteId: string;

    beforeAll(async () => {
      // Create an invite to list
      const createResult = await callMCPTool(ownerClient, "manage", {
        action: "create-invite",
        workflowId: testWorkflowId,
      });
      createdInviteId = createResult.invite.id;
    });

    test("owner can list invites for workflow", async () => {
      const result = await callMCPTool(ownerClient, "manage", {
        action: "list-invites",
        workflowId: testWorkflowId,
      });

      expect(result).toHaveProperty("success", true);
      expect(result).toHaveProperty("totalCount");
      expect(result).toHaveProperty("invites");
      expect(Array.isArray(result.invites)).toBe(true);
      expect(result.totalCount).toBeGreaterThan(0);

      // Should find our created invite
      const foundInvite = result.invites.find((inv: { id: string }) => inv.id === createdInviteId);
      expect(foundInvite).toBeDefined();
    });

    test("list-invites filters active only by default", async () => {
      const result = await callMCPTool(ownerClient, "manage", {
        action: "list-invites",
        workflowId: testWorkflowId,
      });

      expect(result).toHaveProperty("success", true);
      expect(result).toHaveProperty("activeOnly", true);

      // All invites should be unused (active)
      for (const invite of result.invites) {
        expect(invite.usedAt).toBeNull();
      }
    });

    test("non-owner cannot list invites", async () => {
      const result = await callMCPTool(recipientClient, "manage", {
        action: "list-invites",
        workflowId: testWorkflowId,
      });

      // Error returns as string or object with success: false
      if (typeof result === "string") {
        expect(result).toMatch(/not found|denied|access/i);
      } else {
        expect(result).toHaveProperty("success", false);
      }
    });
  });

  describe("revoke-invite", () => {
    let inviteToRevoke: string;

    beforeAll(async () => {
      // Create an invite to revoke
      const createResult = await callMCPTool(ownerClient, "manage", {
        action: "create-invite",
        workflowId: testWorkflowId,
      });
      inviteToRevoke = createResult.invite.id;
    });

    test("owner can revoke invite", async () => {
      const result = await callMCPTool(ownerClient, "manage", {
        action: "revoke-invite",
        inviteId: inviteToRevoke,
      });

      expect(result).toHaveProperty("success", true);
      expect(result).toHaveProperty("inviteId", inviteToRevoke);

      // Verify invite no longer listed
      const listResult = await callMCPTool(ownerClient, "manage", {
        action: "list-invites",
        workflowId: testWorkflowId,
      });

      const found = listResult.invites.find((inv: { id: string }) => inv.id === inviteToRevoke);
      expect(found).toBeUndefined();
    });

    test("revoke-invite requires inviteId", async () => {
      const result = await callMCPTool(ownerClient, "manage", {
        action: "revoke-invite",
      });

      // Error returns as string or object with success: false
      if (typeof result === "string") {
        expect(result).toMatch(/inviteId|required/i);
      } else {
        expect(result).toHaveProperty("success", false);
        expect(result.error).toContain("inviteId");
      }
    });

    test("non-owner cannot revoke invite", async () => {
      // Create a new invite
      const createResult = await callMCPTool(ownerClient, "manage", {
        action: "create-invite",
        workflowId: testWorkflowId,
      });

      const result = await callMCPTool(recipientClient, "manage", {
        action: "revoke-invite",
        inviteId: createResult.invite.id,
      });

      // Error returns as string or object with success: false
      if (typeof result === "string") {
        expect(result).toMatch(/not found|denied|access/i);
      } else {
        expect(result).toHaveProperty("success", false);
      }
    });
  });

  describe("list-access and revoke-access", () => {
    // Note: These tests need invite acceptance to work, which requires REST API
    // For now, we test the empty state and error cases

    test("list-access works on workflow with no shares", async () => {
      // Create a fresh workflow with no shares
      const workflow = {
        ...CRUD_WORKFLOWS.SIMPLE_CREATE,
        id: `no-shares-${Date.now()}`,
        metadata: {
          ...CRUD_WORKFLOWS.SIMPLE_CREATE.metadata,
          name: "No Shares Workflow",
        },
      };

      const createResult = await callMCPTool(ownerClient, "manage", {
        action: "create",
        workflow,
      });
      createdWorkflows.push(createResult.workflowId);

      const result = await callMCPTool(ownerClient, "manage", {
        action: "list-access",
        workflowId: createResult.workflowId,
      });

      expect(result).toHaveProperty("success", true);
      expect(result).toHaveProperty("totalCount", 0);
      expect(result).toHaveProperty("users");
      expect(result.users).toHaveLength(0);
    });

    test("non-owner cannot list access", async () => {
      const result = await callMCPTool(recipientClient, "manage", {
        action: "list-access",
        workflowId: testWorkflowId,
      });

      // Error returns as string or object with success: false
      if (typeof result === "string") {
        expect(result).toMatch(/not found|denied|access/i);
      } else {
        expect(result).toHaveProperty("success", false);
      }
    });

    test("revoke-access requires targetUserId", async () => {
      const result = await callMCPTool(ownerClient, "manage", {
        action: "revoke-access",
        workflowId: testWorkflowId,
      });

      // Error returns as string or object with success: false
      if (typeof result === "string") {
        expect(result).toMatch(/targetUserId|required/i);
      } else {
        expect(result).toHaveProperty("success", false);
        expect(result.error).toContain("targetUserId");
      }
    });

    test("revoke-access fails for non-existent access", async () => {
      const result = await callMCPTool(ownerClient, "manage", {
        action: "revoke-access",
        workflowId: testWorkflowId,
        targetUserId: "non-existent-user-id",
      });

      // Error returns as string or object with success: false
      if (typeof result === "string") {
        expect(result).toMatch(/not found|access/i);
      } else {
        expect(result).toHaveProperty("success", false);
      }
    });
  });

  describe("workflow identifier resolution", () => {
    test("create-invite works with slug", async () => {
      const result = await callMCPTool(ownerClient, "manage", {
        action: "create-invite",
        workflowId: testWorkflowSlug,
      });

      expect(result).toHaveProperty("success", true);
      expect(result).toHaveProperty("workflowId");
      expect(result).toHaveProperty("invite.token");
    });

    test("list-access works with slug", async () => {
      const result = await callMCPTool(ownerClient, "manage", {
        action: "list-access",
        workflowId: testWorkflowSlug,
      });

      expect(result).toHaveProperty("success", true);
    });

    test("list-invites works with slug", async () => {
      const result = await callMCPTool(ownerClient, "manage", {
        action: "list-invites",
        workflowId: testWorkflowSlug,
      });

      expect(result).toHaveProperty("success", true);
    });
  });
});
