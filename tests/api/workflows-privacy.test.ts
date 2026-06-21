/**
 * Integration API Tests - Workflow Privacy Defaults
 * Verify workflows are created private by default via REST API
 */

import { describe, test, expect, beforeAll, afterAll } from "@jest/globals";
import fetch from "node-fetch";
import { getTestBaseUrl, getAdminCredentials } from "../utils/test-config.js";

const BASE_URL = getTestBaseUrl();
const ADMIN_CREDENTIALS = getAdminCredentials();

describe("Workflows Privacy Defaults - REST API", () => {
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
      } catch (e) {
        // Ignore cleanup errors
      }
    }
  });

  test("POST /api/workflows defaults to private visibility", async () => {
    const response = await fetch(`${BASE_URL}/api/workflows`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: authCookie,
      },
      body: JSON.stringify({
        workflow: {
          metadata: {
            name: "Privacy Default Test",
            version: "1.0.0",
            description: "Test default private visibility",
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
    expect(data.success).toBe(true);
    // Workflow ID is now auto-generated UUID
    expect(data.data.workflowId).toBeDefined();
    const workflowId = data.data.workflowId;

    // Verify visibility by fetching the workflow
    const getResponse = await fetch(`${BASE_URL}/api/workflows/${workflowId}`, {
      headers: { Cookie: authCookie },
    });
    expect(getResponse.status).toBe(200);
    const getBody = (await getResponse.json()) as any;
    expect(getBody.data.fileInfo.visibility).toBe("private");

    createdWorkflows.push(workflowId);
  });

  test("POST /api/workflows respects explicit private visibility", async () => {
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
            name: "Explicit Private Test",
            version: "1.0.0",
            description: "Test explicit private visibility",
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
    expect(data.success).toBe(true);
    expect(data.data.workflowId).toBeDefined();
    const workflowId = data.data.workflowId;

    // Verify visibility by fetching the workflow
    const getResponse = await fetch(`${BASE_URL}/api/workflows/${workflowId}`, {
      headers: { Cookie: authCookie },
    });
    expect(getResponse.status).toBe(200);
    const getBody = (await getResponse.json()) as any;
    expect(getBody.data.fileInfo.visibility).toBe("private");

    createdWorkflows.push(workflowId);
  });

  test("POST /api/workflows accepts public visibility when specified", async () => {
    const response = await fetch(`${BASE_URL}/api/workflows`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: authCookie,
      },
      body: JSON.stringify({
        visibility: "public",
        workflow: {
          metadata: {
            name: "Public Test",
            version: "1.0.0",
            description: "Test public visibility",
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
    expect(data.success).toBe(true);
    expect(data.data.workflowId).toBeDefined();
    const workflowId = data.data.workflowId;

    // Verify visibility by fetching the workflow
    const getResponse = await fetch(`${BASE_URL}/api/workflows/${workflowId}`, {
      headers: { Cookie: authCookie },
    });
    expect(getResponse.status).toBe(200);
    const getBody = (await getResponse.json()) as any;
    expect(getBody.data.fileInfo.visibility).toBe("public");

    createdWorkflows.push(workflowId);
  });

  test("POST /api/workflows can update workflow with explicit visibility", async () => {
    // Create public workflow
    const createResponse = await fetch(`${BASE_URL}/api/workflows`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: authCookie,
      },
      body: JSON.stringify({
        visibility: "public",
        workflow: {
          metadata: {
            name: "Update Visibility Test",
            version: "1.0.0",
            description: "Original description",
          },
          nodes: [
            { type: "start", id: "start", connections: { default: "end" } },
            { type: "end", id: "end" },
          ],
        },
      }),
    });

    expect(createResponse.status).toBe(200);
    const createData = (await createResponse.json()) as any;
    const workflowId = createData.data.workflowId;
    createdWorkflows.push(workflowId);

    // Update workflow with explicit visibility to keep it public
    // Need to use the UUID returned by create for the update
    const updateResponse = await fetch(`${BASE_URL}/api/workflows`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: authCookie,
      },
      body: JSON.stringify({
        id: workflowId,
        overwrite: true,
        visibility: "public",
        workflow: {
          id: workflowId,
          metadata: {
            name: "Updated Name",
            version: "1.0.0",
            description: "Updated description",
          },
          nodes: [
            { type: "start", id: "start", connections: { default: "end" } },
            { type: "end", id: "end" },
          ],
        },
      }),
    });

    expect(updateResponse.status).toBe(200);
    const updateData = (await updateResponse.json()) as any;
    expect(updateData.success).toBe(true);

    // Verify visibility is still public
    const getResponse = await fetch(`${BASE_URL}/api/workflows/${workflowId}`, {
      headers: { Cookie: authCookie },
    });
    expect(getResponse.status).toBe(200);
    const getBody = (await getResponse.json()) as any;
    expect(getBody.data.fileInfo.visibility).toBe("public");
    expect(getBody.data.workflow.metadata.name).toBe("Updated Name");
  });
});
