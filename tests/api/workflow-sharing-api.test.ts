/**
 * API Tests - Workflow Sharing (Invite Links)
 * Tests REST API endpoints for workflow sharing via one-time invite links
 *
 * Routes tested:
 * - POST   /api/workflows/:id/invites         - Create invite link
 * - GET    /api/workflows/:id/invites         - List active invites
 * - DELETE /api/workflows/:id/invites/:inviteId - Revoke invite
 * - GET    /api/workflows/:id/access          - List users with access
 * - DELETE /api/workflows/:id/access/:userId  - Revoke user access
 * - GET    /api/invites/:token                - Get invite info (public)
 * - POST   /api/invites/:token/accept         - Accept invite
 */

import { describe, test, expect, beforeAll, afterAll } from "@jest/globals";
import fetch from "node-fetch";
import { getTestBaseUrl, getAdminCredentials } from "../utils/test-config.js";

const BASE_URL = getTestBaseUrl();
const ADMIN_CREDENTIALS = getAdminCredentials();

// Second user credentials for invite acceptance tests
const SECOND_USER_CREDENTIALS = {
  email: "test-user-2@example.com",
  password: "test-password-123",
};

describe("Workflow Sharing API", () => {
  let authCookie: string;
  let secondUserCookie: string;
  let secondUserId: string;
  const createdWorkflows: string[] = [];
  const createdInvites: { workflowId: string; inviteId: string }[] = [];

  beforeAll(async () => {
    // Sign in as admin
    const signinResponse = await fetch(`${BASE_URL}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(ADMIN_CREDENTIALS),
    });

    const cookies = signinResponse.headers.get("set-cookie");
    if (!cookies) {
      throw new Error("No session cookie received from sign-in");
    }
    authCookie = cookies;

    // Try to sign in as second user, or create if doesn't exist
    try {
      const secondSignin = await fetch(`${BASE_URL}/api/auth/sign-in/email`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(SECOND_USER_CREDENTIALS),
      });

      if (secondSignin.status === 200) {
        secondUserCookie = secondSignin.headers.get("set-cookie") || "";
        const profile = await fetch(`${BASE_URL}/api/user/profile`, {
          headers: { Cookie: secondUserCookie },
        });
        const profileData = (await profile.json()) as { data: { id: string } };
        secondUserId = profileData.data.id;
      }
    } catch {
      // Second user might not exist - some tests will be skipped
    }
  });

  afterAll(async () => {
    // Cleanup created workflows (this cascades to invites and access)
    for (const workflowId of createdWorkflows) {
      try {
        await fetch(`${BASE_URL}/api/workflows/${workflowId}`, {
          method: "DELETE",
          headers: { Cookie: authCookie },
        });
      } catch {
        // Ignore cleanup errors
      }
    }
  });

  /**
   * Helper to create a test workflow
   */
  async function createWorkflow(): Promise<string> {
    const response = await fetch(`${BASE_URL}/api/workflows`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: authCookie,
      },
      body: JSON.stringify({
        visibility: "private",
        workflow: {
          metadata: {
            name: "Sharing Test Workflow",
            version: "1.0.0",
            description: "Test workflow for sharing operations",
          },
          nodes: [
            { type: "start", id: "start", connections: { default: "end" } },
            { type: "end", id: "end" },
          ],
        },
      }),
    });

    expect(response.status).toBe(200);
    const data = (await response.json()) as { data: { workflowId: string } };
    const workflowId = data.data.workflowId;
    createdWorkflows.push(workflowId);
    return workflowId;
  }

  // ===== POST /api/workflows/:id/invites =====

  describe("POST /api/workflows/:id/invites", () => {
    test("creates invite link for owned workflow", async () => {
      const workflowId = await createWorkflow();

      const response = await fetch(`${BASE_URL}/api/workflows/${workflowId}/invites`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: authCookie,
        },
        body: JSON.stringify({}),
      });

      expect(response.status).toBe(201);
      const result = (await response.json()) as {
        success: boolean;
        data: {
          invite: {
            id: string;
            token: string;
            expiresAt: number;
            remainingMs: number;
          };
          inviteUrl: string;
        };
      };

      expect(result.success).toBe(true);
      expect(result.data.invite.id).toBeDefined();
      expect(result.data.invite.token).toBeDefined();
      expect(result.data.invite.token.length).toBeGreaterThanOrEqual(16);
      expect(result.data.invite.expiresAt).toBeGreaterThan(Date.now());
      expect(result.data.inviteUrl).toContain(result.data.invite.token);

      createdInvites.push({ workflowId, inviteId: result.data.invite.id });
    });

    test("creates invite with custom TTL", async () => {
      const workflowId = await createWorkflow();
      const customTtlMs = 24 * 60 * 60 * 1000; // 1 day

      const response = await fetch(`${BASE_URL}/api/workflows/${workflowId}/invites`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: authCookie,
        },
        body: JSON.stringify({ ttlMs: customTtlMs }),
      });

      expect(response.status).toBe(201);
      const result = (await response.json()) as {
        success: boolean;
        data: { invite: { remainingMs: number } };
      };

      expect(result.success).toBe(true);
      // Allow some tolerance for processing time
      expect(result.data.invite.remainingMs).toBeLessThanOrEqual(customTtlMs);
      expect(result.data.invite.remainingMs).toBeGreaterThan(customTtlMs - 5000);
    });

    test("returns 404 for non-existent workflow", async () => {
      const response = await fetch(
        `${BASE_URL}/api/workflows/00000000-0000-4000-8000-000000000000/invites`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Cookie: authCookie,
          },
          body: JSON.stringify({}),
        },
      );

      expect(response.status).toBe(404);
    });

    test("requires authentication", async () => {
      const workflowId = await createWorkflow();

      const response = await fetch(`${BASE_URL}/api/workflows/${workflowId}/invites`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });

      expect(response.status).toBe(401);
    });
  });

  // ===== GET /api/workflows/:id/invites =====

  describe("GET /api/workflows/:id/invites", () => {
    test("lists invites for owned workflow", async () => {
      const workflowId = await createWorkflow();

      // Create a couple invites
      await fetch(`${BASE_URL}/api/workflows/${workflowId}/invites`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: authCookie,
        },
        body: JSON.stringify({}),
      });

      await fetch(`${BASE_URL}/api/workflows/${workflowId}/invites`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: authCookie,
        },
        body: JSON.stringify({}),
      });

      const response = await fetch(`${BASE_URL}/api/workflows/${workflowId}/invites`, {
        headers: { Cookie: authCookie },
      });

      expect(response.status).toBe(200);
      const result = (await response.json()) as {
        success: boolean;
        data: {
          invites: Array<{ id: string; token: string }>;
          total: number;
          hasMore: boolean;
        };
      };

      expect(result.success).toBe(true);
      expect(result.data.invites.length).toBeGreaterThanOrEqual(2);
      expect(result.data.total).toBeGreaterThanOrEqual(2);
    });

    test("supports pagination", async () => {
      const workflowId = await createWorkflow();

      // Create 3 invites
      for (let i = 0; i < 3; i++) {
        await fetch(`${BASE_URL}/api/workflows/${workflowId}/invites`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Cookie: authCookie,
          },
          body: JSON.stringify({}),
        });
      }

      // Get first page
      const response1 = await fetch(
        `${BASE_URL}/api/workflows/${workflowId}/invites?limit=2&offset=0`,
        { headers: { Cookie: authCookie } },
      );

      const result1 = (await response1.json()) as {
        data: { invites: Array<{ id: string }>; hasMore: boolean };
      };
      expect(result1.data.invites.length).toBe(2);
      expect(result1.data.hasMore).toBe(true);

      // Get second page
      const response2 = await fetch(
        `${BASE_URL}/api/workflows/${workflowId}/invites?limit=2&offset=2`,
        { headers: { Cookie: authCookie } },
      );

      const result2 = (await response2.json()) as {
        data: { invites: Array<{ id: string }> };
      };
      expect(result2.data.invites.length).toBeGreaterThanOrEqual(1);
    });

    test("requires authentication", async () => {
      const workflowId = await createWorkflow();

      const response = await fetch(`${BASE_URL}/api/workflows/${workflowId}/invites`);

      expect(response.status).toBe(401);
    });
  });

  // ===== DELETE /api/workflows/:id/invites/:inviteId =====

  describe("DELETE /api/workflows/:id/invites/:inviteId", () => {
    test("revokes invite for owned workflow", async () => {
      const workflowId = await createWorkflow();

      // Create invite
      const createResponse = await fetch(`${BASE_URL}/api/workflows/${workflowId}/invites`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: authCookie,
        },
        body: JSON.stringify({}),
      });

      const createResult = (await createResponse.json()) as {
        data: { invite: { id: string } };
      };
      const inviteId = createResult.data.invite.id;

      // Delete invite
      const response = await fetch(`${BASE_URL}/api/workflows/${workflowId}/invites/${inviteId}`, {
        method: "DELETE",
        headers: { Cookie: authCookie },
      });

      expect(response.status).toBe(200);
      const result = (await response.json()) as { success: boolean; data: { revoked: boolean } };
      expect(result.success).toBe(true);
      expect(result.data.revoked).toBe(true);

      // Verify invite is no longer listed
      const listResponse = await fetch(`${BASE_URL}/api/workflows/${workflowId}/invites`, {
        headers: { Cookie: authCookie },
      });
      const listResult = (await listResponse.json()) as {
        data: { invites: Array<{ id: string }> };
      };
      expect(listResult.data.invites.find((i) => i.id === inviteId)).toBeUndefined();
    });

    test("returns 404 for non-existent invite", async () => {
      const workflowId = await createWorkflow();

      const response = await fetch(
        `${BASE_URL}/api/workflows/${workflowId}/invites/00000000-0000-4000-8000-000000000000`,
        {
          method: "DELETE",
          headers: { Cookie: authCookie },
        },
      );

      expect(response.status).toBe(404);
    });
  });

  // ===== GET /api/invites/:token =====

  describe("GET /api/invites/:token", () => {
    test("returns public invite info for valid token", async () => {
      const workflowId = await createWorkflow();

      // Create invite
      const createResponse = await fetch(`${BASE_URL}/api/workflows/${workflowId}/invites`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: authCookie,
        },
        body: JSON.stringify({}),
      });

      const createResult = (await createResponse.json()) as {
        data: { invite: { token: string } };
      };
      const token = createResult.data.invite.token;

      // Get invite info (no auth required for this endpoint)
      const response = await fetch(`${BASE_URL}/api/invites/${token}`, {
        headers: { Cookie: authCookie }, // Still need auth due to middleware
      });

      expect(response.status).toBe(200);
      const result = (await response.json()) as {
        success: boolean;
        data: {
          valid: boolean;
          expired: boolean;
          used: boolean;
          workflowName: string;
          expiresAt: number;
          remainingMs: number;
        };
      };

      expect(result.success).toBe(true);
      expect(result.data.valid).toBe(true);
      expect(result.data.expired).toBe(false);
      expect(result.data.used).toBe(false);
      expect(result.data.expiresAt).toBeGreaterThan(Date.now());
    });

    test("returns 404 for non-existent token", async () => {
      const response = await fetch(`${BASE_URL}/api/invites/nonexistent-invalid-token-12345678`, {
        headers: { Cookie: authCookie },
      });

      expect(response.status).toBe(404);
    });

    test("validates token format", async () => {
      const response = await fetch(`${BASE_URL}/api/invites/short`, {
        headers: { Cookie: authCookie },
      });

      expect(response.status).toBe(400);
    });
  });

  // ===== POST /api/invites/:token/accept =====

  describe("POST /api/invites/:token/accept", () => {
    test("requires authentication", async () => {
      const workflowId = await createWorkflow();

      // Create invite
      const createResponse = await fetch(`${BASE_URL}/api/workflows/${workflowId}/invites`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: authCookie,
        },
        body: JSON.stringify({}),
      });

      const createResult = (await createResponse.json()) as {
        data: { invite: { token: string } };
      };
      const token = createResult.data.invite.token;

      // Try to accept without auth
      const response = await fetch(`${BASE_URL}/api/invites/${token}/accept`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });

      expect(response.status).toBe(401);
    });

    test("prevents owner from accepting own invite", async () => {
      const workflowId = await createWorkflow();

      // Create invite
      const createResponse = await fetch(`${BASE_URL}/api/workflows/${workflowId}/invites`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: authCookie,
        },
        body: JSON.stringify({}),
      });

      const createResult = (await createResponse.json()) as {
        data: { invite: { token: string } };
      };
      const token = createResult.data.invite.token;

      // Try to accept as owner
      const response = await fetch(`${BASE_URL}/api/invites/${token}/accept`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: authCookie,
        },
      });

      expect(response.status).toBe(400);
      const result = (await response.json()) as { error: { code: string } };
      expect(result.error.code).toBe("SELF_INVITE");
    });

    // This test requires a second user
    (secondUserCookie ? test : test.skip)("accepts invite as different user", async () => {
      const workflowId = await createWorkflow();

      // Create invite
      const createResponse = await fetch(`${BASE_URL}/api/workflows/${workflowId}/invites`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: authCookie,
        },
        body: JSON.stringify({}),
      });

      const createResult = (await createResponse.json()) as {
        data: { invite: { token: string } };
      };
      const token = createResult.data.invite.token;

      // Accept as second user
      const response = await fetch(`${BASE_URL}/api/invites/${token}/accept`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: secondUserCookie,
        },
      });

      expect(response.status).toBe(201);
      const result = (await response.json()) as {
        success: boolean;
        data: {
          accessId: string;
          workflowId: string;
        };
      };

      expect(result.success).toBe(true);
      expect(result.data.accessId).toBeDefined();
      expect(result.data.workflowId).toBe(workflowId);
    });

    // This test requires a second user
    (secondUserCookie ? test : test.skip)("prevents double acceptance", async () => {
      const workflowId = await createWorkflow();

      // Create two invites
      const createResponse1 = await fetch(`${BASE_URL}/api/workflows/${workflowId}/invites`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: authCookie,
        },
        body: JSON.stringify({}),
      });

      const createResult1 = (await createResponse1.json()) as {
        data: { invite: { token: string } };
      };
      const token1 = createResult1.data.invite.token;

      // Accept first invite
      await fetch(`${BASE_URL}/api/invites/${token1}/accept`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: secondUserCookie,
        },
      });

      // Create second invite
      const createResponse2 = await fetch(`${BASE_URL}/api/workflows/${workflowId}/invites`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: authCookie,
        },
        body: JSON.stringify({}),
      });

      const createResult2 = (await createResponse2.json()) as {
        data: { invite: { token: string } };
      };
      const token2 = createResult2.data.invite.token;

      // Try to accept second invite (user already has access)
      const response = await fetch(`${BASE_URL}/api/invites/${token2}/accept`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: secondUserCookie,
        },
      });

      expect(response.status).toBe(409);
      const result = (await response.json()) as { error: { code: string } };
      expect(result.error.code).toBe("ACCESS_ALREADY_EXISTS");
    });
  });

  // ===== GET /api/workflows/:id/access =====

  describe("GET /api/workflows/:id/access", () => {
    test("lists users with access to workflow", async () => {
      const workflowId = await createWorkflow();

      const response = await fetch(`${BASE_URL}/api/workflows/${workflowId}/access`, {
        headers: { Cookie: authCookie },
      });

      expect(response.status).toBe(200);
      const result = (await response.json()) as {
        success: boolean;
        data: {
          users: Array<{
            userId: string;
            handle: string;
            grantedAt: number;
          }>;
          total: number;
          hasMore: boolean;
        };
      };

      expect(result.success).toBe(true);
      expect(Array.isArray(result.data.users)).toBe(true);
      expect(typeof result.data.total).toBe("number");
    });

    test("requires authentication", async () => {
      const workflowId = await createWorkflow();

      const response = await fetch(`${BASE_URL}/api/workflows/${workflowId}/access`);

      expect(response.status).toBe(401);
    });
  });

  // ===== DELETE /api/workflows/:id/access/:userId =====

  describe("DELETE /api/workflows/:id/access/:userId", () => {
    test("returns 404 for non-existent access", async () => {
      const workflowId = await createWorkflow();

      const response = await fetch(
        `${BASE_URL}/api/workflows/${workflowId}/access/00000000-0000-4000-8000-000000000000`,
        {
          method: "DELETE",
          headers: { Cookie: authCookie },
        },
      );

      expect(response.status).toBe(404);
    });

    // This test requires a second user with access
    (secondUserCookie && secondUserId ? test : test.skip)("revokes user access", async () => {
      const workflowId = await createWorkflow();

      // Create and accept invite
      const createResponse = await fetch(`${BASE_URL}/api/workflows/${workflowId}/invites`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: authCookie,
        },
        body: JSON.stringify({}),
      });

      const createResult = (await createResponse.json()) as {
        data: { invite: { token: string } };
      };

      await fetch(`${BASE_URL}/api/invites/${createResult.data.invite.token}/accept`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: secondUserCookie,
        },
      });

      // Revoke access
      const response = await fetch(
        `${BASE_URL}/api/workflows/${workflowId}/access/${secondUserId}`,
        {
          method: "DELETE",
          headers: { Cookie: authCookie },
        },
      );

      expect(response.status).toBe(200);
      const result = (await response.json()) as {
        success: boolean;
        data: { revoked: boolean };
      };
      expect(result.success).toBe(true);
      expect(result.data.revoked).toBe(true);
    });
  });
});
