/**
 * API Tests - PATCH /api/workflows/:id/visibility
 * Tests changing workflow visibility after creation
 */

import { describe, test, expect, beforeAll, afterAll } from "@jest/globals";
import fetch from "node-fetch";
import { getTestBaseUrl } from "../utils/test-config.js";
import { formatSessionCookie, getAdminSessionCookie } from "../utils/mcp-auth.js";

const BASE_URL = getTestBaseUrl();

describe("PATCH /api/workflows/:id/visibility", () => {
  let authCookie: string;
  const createdWorkflows: string[] = [];

  beforeAll(async () => {
    authCookie = formatSessionCookie(BASE_URL, await getAdminSessionCookie(BASE_URL));
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
            name: "Visibility Patch Test",
            version: "1.0.0",
            description: "Test workflow for PATCH visibility",
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

  test("changes visibility from private to public", async () => {
    const workflowId = await createWorkflow("private");

    // Verify initial visibility
    const getInitial = await fetch(`${BASE_URL}/api/workflows/${workflowId}`, {
      headers: { Cookie: authCookie },
    });
    const initialData = (await getInitial.json()) as any;
    expect(initialData.data.fileInfo.visibility).toBe("private");

    // PATCH to public
    const patchResponse = await fetch(`${BASE_URL}/api/workflows/${workflowId}/visibility`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Cookie: authCookie,
      },
      body: JSON.stringify({ visibility: "public" }),
    });

    expect(patchResponse.status).toBe(200);
    const patchData = (await patchResponse.json()) as any;
    expect(patchData.success).toBe(true);
    expect(patchData.data.visibility).toBe("public");

    // Verify change persisted
    const getAfter = await fetch(`${BASE_URL}/api/workflows/${workflowId}`, {
      headers: { Cookie: authCookie },
    });
    const afterData = (await getAfter.json()) as any;
    expect(afterData.data.fileInfo.visibility).toBe("public");
  });

  test("changes visibility from public to private", async () => {
    const workflowId = await createWorkflow("public");

    // Verify initial visibility
    const getInitial = await fetch(`${BASE_URL}/api/workflows/${workflowId}`, {
      headers: { Cookie: authCookie },
    });
    const initialData = (await getInitial.json()) as any;
    expect(initialData.data.fileInfo.visibility).toBe("public");

    // PATCH to private
    const patchResponse = await fetch(`${BASE_URL}/api/workflows/${workflowId}/visibility`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Cookie: authCookie,
      },
      body: JSON.stringify({ visibility: "private" }),
    });

    expect(patchResponse.status).toBe(200);
    const patchData = (await patchResponse.json()) as any;
    expect(patchData.success).toBe(true);
    expect(patchData.data.visibility).toBe("private");

    // Verify change persisted
    const getAfter = await fetch(`${BASE_URL}/api/workflows/${workflowId}`, {
      headers: { Cookie: authCookie },
    });
    const afterData = (await getAfter.json()) as any;
    expect(afterData.data.fileInfo.visibility).toBe("private");
  });

  test("rejects invalid visibility value", async () => {
    const workflowId = await createWorkflow("private");

    const patchResponse = await fetch(`${BASE_URL}/api/workflows/${workflowId}/visibility`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Cookie: authCookie,
      },
      body: JSON.stringify({ visibility: "invalid" }),
    });

    expect(patchResponse.status).toBe(400);
    const errorData = (await patchResponse.json()) as any;
    expect(errorData.success).toBe(false);
  });

  test("rejects missing visibility value", async () => {
    const workflowId = await createWorkflow("private");

    const patchResponse = await fetch(`${BASE_URL}/api/workflows/${workflowId}/visibility`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Cookie: authCookie,
      },
      body: JSON.stringify({}),
    });

    expect(patchResponse.status).toBe(400);
  });

  test("returns 404 for non-existent workflow", async () => {
    const patchResponse = await fetch(
      `${BASE_URL}/api/workflows/non-existent-workflow-12345/visibility`,
      {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Cookie: authCookie,
        },
        body: JSON.stringify({ visibility: "public" }),
      },
    );

    expect(patchResponse.status).toBe(404);
  });

  test("requires authentication", async () => {
    const workflowId = await createWorkflow("private");

    const patchResponse = await fetch(`${BASE_URL}/api/workflows/${workflowId}/visibility`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        // No Cookie header
      },
      body: JSON.stringify({ visibility: "public" }),
    });

    expect(patchResponse.status).toBe(401);
  });
});
