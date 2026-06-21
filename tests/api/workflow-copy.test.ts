/**
 * API Tests - POST /api/workflows/:id/copy
 * Tests copying workflows as templates
 */

import { describe, test, expect, beforeAll, afterAll } from "@jest/globals";
import fetch from "node-fetch";
import { getTestBaseUrl, getAdminCredentials } from "../utils/test-config.js";

const BASE_URL = getTestBaseUrl();
const ADMIN_CREDENTIALS = getAdminCredentials();

describe("POST /api/workflows/:id/copy", () => {
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
   * Helper to create a test workflow
   * Returns the auto-generated workflow ID
   */
  async function createWorkflow(visibility: "public" | "private"): Promise<string> {
    const response = await fetch(`${BASE_URL}/api/workflows`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: authCookie,
      },
      body: JSON.stringify({
        visibility,
        workflow: {
          metadata: {
            name: "Copy Source Workflow",
            version: "1.0.0",
            description: "Test workflow for copy operation",
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
    return workflowId;
  }

  test("copies workflow with default name", async () => {
    const sourceId = await createWorkflow("public");

    const response = await fetch(`${BASE_URL}/api/workflows/${sourceId}/copy`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: authCookie,
      },
      body: JSON.stringify({}),
    });

    expect(response.status).toBe(200);
    const result = (await response.json()) as {
      success: boolean;
      data: {
        workflowId: string;
        sourceWorkflowId: string;
        metadata: { name: string };
        visibility: string;
      };
    };

    expect(result.success).toBe(true);
    expect(result.data.sourceWorkflowId).toBe(sourceId);
    // Workflow IDs are UUIDs
    expect(result.data.workflowId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(result.data.metadata.name).toBe("Copy Source Workflow (copy)");
    expect(result.data.visibility).toBe("private");

    // Track for cleanup
    createdWorkflows.push(result.data.workflowId);
  });

  test("copies workflow with custom name", async () => {
    const sourceId = await createWorkflow("public");

    const response = await fetch(`${BASE_URL}/api/workflows/${sourceId}/copy`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: authCookie,
      },
      body: JSON.stringify({ newName: "My Custom Copy" }),
    });

    expect(response.status).toBe(200);
    const result = (await response.json()) as {
      success: boolean;
      data: {
        workflowId: string;
        metadata: { name: string };
      };
    };

    expect(result.success).toBe(true);
    expect(result.data.metadata.name).toBe("My Custom Copy");

    // Track for cleanup
    createdWorkflows.push(result.data.workflowId);
  });

  test("copies private workflow owned by user", async () => {
    const sourceId = await createWorkflow("private");

    const response = await fetch(`${BASE_URL}/api/workflows/${sourceId}/copy`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: authCookie,
      },
      body: JSON.stringify({}),
    });

    expect(response.status).toBe(200);
    const result = (await response.json()) as {
      success: boolean;
      data: { workflowId: string };
    };

    expect(result.success).toBe(true);

    // Track for cleanup
    createdWorkflows.push(result.data.workflowId);
  });

  test("returns 404 for non-existent workflow", async () => {
    const response = await fetch(`${BASE_URL}/api/workflows/non-existent-workflow/copy`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: authCookie,
      },
      body: JSON.stringify({}),
    });

    expect(response.status).toBe(404);
  });

  test("requires authentication", async () => {
    const sourceId = await createWorkflow("public");

    const response = await fetch(`${BASE_URL}/api/workflows/${sourceId}/copy`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // No auth cookie
      },
      body: JSON.stringify({}),
    });

    expect(response.status).toBe(401);
  });

  test("copied workflow has new unique ID", async () => {
    const sourceId = await createWorkflow("public");

    // Create two copies
    const response1 = await fetch(`${BASE_URL}/api/workflows/${sourceId}/copy`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: authCookie,
      },
      body: JSON.stringify({}),
    });

    const response2 = await fetch(`${BASE_URL}/api/workflows/${sourceId}/copy`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: authCookie,
      },
      body: JSON.stringify({}),
    });

    const result1 = (await response1.json()) as { data: { workflowId: string } };
    const result2 = (await response2.json()) as { data: { workflowId: string } };

    expect(result1.data.workflowId).not.toBe(result2.data.workflowId);
    expect(result1.data.workflowId).not.toBe(sourceId);
    expect(result2.data.workflowId).not.toBe(sourceId);

    // Track for cleanup
    createdWorkflows.push(result1.data.workflowId);
    createdWorkflows.push(result2.data.workflowId);
  });
});
