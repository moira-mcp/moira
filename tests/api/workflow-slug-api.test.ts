/**
 * API Tests - Workflow Slug Operations
 * Tests slug-based workflow access and slug update endpoints
 *
 * IMPORTANT: Tests run against Docker by default (localhost:DOCKER_PORT from .env)
 * Override with TEST_BASE_URL env variable for other environments
 */

import { describe, test, expect, beforeAll, afterAll } from "@jest/globals";
import { getTestBaseUrl, getAdminCredentials } from "../utils/test-config.js";

const BASE_URL = getTestBaseUrl();
const ADMIN_CREDENTIALS = getAdminCredentials();

describe("Workflow Slug API", () => {
  let authCookie: string;
  const createdWorkflows: string[] = [];

  beforeAll(async () => {
    // Sign in and get session cookie
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
  });

  afterAll(async () => {
    // Cleanup created workflows
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
   * Helper to create a test workflow with optional slug
   * Returns the auto-generated workflow ID and slug
   */
  async function createWorkflow(
    visibility: "public" | "private",
    customSlug?: string,
  ): Promise<{ workflowId: string; slug: string }> {
    const response = await fetch(`${BASE_URL}/api/workflows`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: authCookie,
      },
      body: JSON.stringify({
        visibility,
        slug: customSlug,
        workflow: {
          metadata: {
            name: "Slug Test Workflow",
            version: "1.0.0",
            description: "Test workflow for slug operations",
          },
          nodes: [
            { type: "start", id: "start", connections: { default: "end" } },
            { type: "end", id: "end" },
          ],
        },
      }),
    });

    expect(response.status).toBe(200);
    const data = (await response.json()) as any;
    const workflowId = data.data.workflowId;
    createdWorkflows.push(workflowId);

    return {
      workflowId,
      slug: data.data?.slug || customSlug || workflowId,
    };
  }

  describe("GET /api/workflows/:id - slug in response", () => {
    test("returns slug and ownerHandle in workflow response", async () => {
      const { workflowId } = await createWorkflow("private");

      const response = await fetch(`${BASE_URL}/api/workflows/${workflowId}`, {
        headers: { Cookie: authCookie },
      });

      expect(response.status).toBe(200);
      const data = (await response.json()) as any;

      expect(data.success).toBe(true);
      expect(data.data.fileInfo).toBeDefined();
      expect(data.data.fileInfo.slug).toBeDefined();
      expect(typeof data.data.fileInfo.slug).toBe("string");
      expect(data.data.fileInfo.ownerHandle).toBeDefined();
      expect(typeof data.data.fileInfo.ownerHandle).toBe("string");
    });
  });

  describe("GET /api/workflows - list includes slug", () => {
    test("returns slug and ownerHandle in workflow list", async () => {
      await createWorkflow("public");

      const response = await fetch(`${BASE_URL}/api/workflows`, {
        headers: { Cookie: authCookie },
      });

      expect(response.status).toBe(200);
      const data = (await response.json()) as any;

      expect(data.success).toBe(true);
      expect(data.data.workflows).toBeDefined();
      expect(data.data.workflows.length).toBeGreaterThan(0);

      // Check first workflow has slug and ownerHandle
      const workflow = data.data.workflows[0];
      expect(workflow.slug).toBeDefined();
      expect(typeof workflow.slug).toBe("string");
      expect(workflow.ownerHandle).toBeDefined();
      expect(typeof workflow.ownerHandle).toBe("string");
    });
  });

  describe("POST /api/workflows - create with custom slug", () => {
    test("creates workflow with custom slug", async () => {
      const customSlug = `custom-slug-${Date.now()}`;
      const { workflowId } = await createWorkflow("private", customSlug);

      const response = await fetch(`${BASE_URL}/api/workflows/${workflowId}`, {
        headers: { Cookie: authCookie },
      });

      expect(response.status).toBe(200);
      const data = (await response.json()) as any;
      expect(data.data.fileInfo.slug).toBe(customSlug);
    });

    test("rejects invalid slug format", async () => {
      const workflowId = `test-invalid-slug-${Date.now()}`;

      const response = await fetch(`${BASE_URL}/api/workflows`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: authCookie,
        },
        body: JSON.stringify({
          id: workflowId,
          visibility: "private",
          slug: "ab", // Too short
          workflow: {
            metadata: {
              name: "Invalid Slug Test",
              version: "1.0.0",
              description: "Test",
            },
            nodes: [
              { type: "start", id: "start", connections: { default: "end" } },
              { type: "end", id: "end" },
            ],
          },
        }),
      });

      expect(response.status).toBe(400);
      const data = (await response.json()) as any;
      expect(data.success).toBe(false);
    });

    test("rejects slug with invalid characters", async () => {
      const workflowId = `test-invalid-chars-${Date.now()}`;

      const response = await fetch(`${BASE_URL}/api/workflows`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: authCookie,
        },
        body: JSON.stringify({
          id: workflowId,
          visibility: "private",
          slug: "my_slug_with_underscores!", // Invalid chars
          workflow: {
            metadata: {
              name: "Invalid Chars Test",
              version: "1.0.0",
              description: "Test",
            },
            nodes: [
              { type: "start", id: "start", connections: { default: "end" } },
              { type: "end", id: "end" },
            ],
          },
        }),
      });

      expect(response.status).toBe(400);
      const data = (await response.json()) as any;
      expect(data.success).toBe(false);
    });
  });

  describe("PATCH /api/workflows/:id/slug", () => {
    test("updates workflow slug successfully", async () => {
      const { workflowId } = await createWorkflow("private");
      const newSlug = `updated-slug-${Date.now()}`;

      const patchResponse = await fetch(`${BASE_URL}/api/workflows/${workflowId}/slug`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Cookie: authCookie,
        },
        body: JSON.stringify({ slug: newSlug }),
      });

      expect(patchResponse.status).toBe(200);
      const patchData = (await patchResponse.json()) as any;
      expect(patchData.success).toBe(true);
      expect(patchData.data.slug).toBe(newSlug);

      // Verify change persisted
      const getResponse = await fetch(`${BASE_URL}/api/workflows/${workflowId}`, {
        headers: { Cookie: authCookie },
      });
      const getData = (await getResponse.json()) as any;
      expect(getData.data.fileInfo.slug).toBe(newSlug);
    });

    test("rejects invalid slug format", async () => {
      const { workflowId } = await createWorkflow("private");

      const patchResponse = await fetch(`${BASE_URL}/api/workflows/${workflowId}/slug`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Cookie: authCookie,
        },
        body: JSON.stringify({ slug: "ab" }), // Too short
      });

      expect(patchResponse.status).toBe(400);
      const data = (await patchResponse.json()) as any;
      expect(data.success).toBe(false);
    });

    test("rejects missing slug", async () => {
      const { workflowId } = await createWorkflow("private");

      const patchResponse = await fetch(`${BASE_URL}/api/workflows/${workflowId}/slug`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Cookie: authCookie,
        },
        body: JSON.stringify({}),
      });

      expect(patchResponse.status).toBe(400);
    });

    test("rejects duplicate slug for same user", async () => {
      const slug1 = `slug-conflict-${Date.now()}`;
      const slug2 = `slug-conflict-${Date.now() + 1}`;

      // Create first workflow with slug1
      await createWorkflow("private", slug1);

      // Create second workflow with slug2
      const { workflowId: workflow2Id } = await createWorkflow("private", slug2);

      // Try to update second workflow to use slug1
      const patchResponse = await fetch(`${BASE_URL}/api/workflows/${workflow2Id}/slug`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Cookie: authCookie,
        },
        body: JSON.stringify({ slug: slug1 }),
      });

      expect(patchResponse.status).toBe(409);
      const data = (await patchResponse.json()) as any;
      expect(data.success).toBe(false);
    });

    test("returns 404 for non-existent workflow", async () => {
      const patchResponse = await fetch(
        `${BASE_URL}/api/workflows/non-existent-workflow-12345/slug`,
        {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            Cookie: authCookie,
          },
          body: JSON.stringify({ slug: "valid-slug" }),
        },
      );

      expect(patchResponse.status).toBe(404);
    });

    test("requires authentication", async () => {
      const { workflowId } = await createWorkflow("private");

      const patchResponse = await fetch(`${BASE_URL}/api/workflows/${workflowId}/slug`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          // No Cookie header
        },
        body: JSON.stringify({ slug: "new-slug" }),
      });

      expect(patchResponse.status).toBe(401);
    });
  });

  describe("GET /api/workflows/:handle/:slug", () => {
    test("retrieves public workflow by handle/slug reference", async () => {
      const customSlug = `ref-test-${Date.now()}`;
      const { workflowId } = await createWorkflow("public", customSlug);

      // First get the owner's handle
      const workflowResponse = await fetch(`${BASE_URL}/api/workflows/${workflowId}`, {
        headers: { Cookie: authCookie },
      });
      const workflowData = (await workflowResponse.json()) as any;
      const ownerHandle = workflowData.data.fileInfo.ownerHandle;

      // Retrieve by handle/slug (canonical format)
      const response = await fetch(`${BASE_URL}/api/workflows/${ownerHandle}/${customSlug}`, {
        headers: { Cookie: authCookie },
      });

      expect(response.status).toBe(200);
      const data = (await response.json()) as any;
      expect(data.success).toBe(true);
      expect(data.data.fileInfo.id).toBe(workflowId);
      expect(data.data.fileInfo.slug).toBe(customSlug);
    });

    test("returns 404 for non-existent handle", async () => {
      const response = await fetch(`${BASE_URL}/api/workflows/non-existent-handle/some-slug`, {
        headers: { Cookie: authCookie },
      });

      expect(response.status).toBe(404);
    });

    test("returns 404 for non-existent slug under valid handle", async () => {
      // Create a workflow to ensure user has a handle
      const { workflowId } = await createWorkflow("public");

      // Get handle
      const workflowResponse = await fetch(`${BASE_URL}/api/workflows/${workflowId}`, {
        headers: { Cookie: authCookie },
      });
      const workflowData = (await workflowResponse.json()) as any;
      const ownerHandle = workflowData.data.fileInfo.ownerHandle;

      // Try non-existent slug
      const response = await fetch(`${BASE_URL}/api/workflows/${ownerHandle}/non-existent-slug`, {
        headers: { Cookie: authCookie },
      });

      expect(response.status).toBe(404);
    });

    test("denies access to private workflow via handle/slug", async () => {
      const customSlug = `private-ref-${Date.now()}`;
      const { workflowId } = await createWorkflow("private", customSlug);

      // Get handle
      const workflowResponse = await fetch(`${BASE_URL}/api/workflows/${workflowId}`, {
        headers: { Cookie: authCookie },
      });
      const workflowData = (await workflowResponse.json()) as any;
      const ownerHandle = workflowData.data.fileInfo.ownerHandle;

      // Create a second user to try accessing the private workflow
      const secondUserEmail = `ref-access-test-${Date.now()}@example.com`;
      const secondUserPassword = "TestPass123!";

      await fetch(`${BASE_URL}/api/auth/sign-up/email`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: secondUserEmail,
          password: secondUserPassword,
          name: "Second Test User",
          acceptedTermsAt: new Date().toISOString(),
          acceptedNotRussianResidentAt: new Date().toISOString(),
        }),
      });

      // Verify email via admin
      const usersRes = await fetch(
        `${BASE_URL}/api/admin/users?search=${encodeURIComponent(secondUserEmail)}&limit=10`,
        {
          headers: { Cookie: authCookie },
        },
      );
      const usersData = (await usersRes.json()) as any;
      const secondUser = usersData.data.users.find((u: any) => u.email === secondUserEmail);
      if (secondUser) {
        await fetch(`${BASE_URL}/api/admin/users/${secondUser.id}/verify-email`, {
          method: "POST",
          headers: { Cookie: authCookie },
        });
      }

      // Login as second user
      const loginRes = await fetch(`${BASE_URL}/api/auth/sign-in/email`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: secondUserEmail,
          password: secondUserPassword,
        }),
      });
      const secondUserCookie = loginRes.headers.get("set-cookie") || "";

      // Try to access private workflow with different user
      const response = await fetch(`${BASE_URL}/api/workflows/${ownerHandle}/${customSlug}`, {
        headers: { Cookie: secondUserCookie },
      });

      // Should return 404 (not 403) to avoid leaking existence info
      expect(response.status).toBe(404);
    });
  });
});
