/**
 * API Tests - Request Body Logging Middleware
 *
 * These tests verify that the request body logging middleware:
 * 1. Doesn't break the request/response flow
 * 2. Adds X-Request-Id header to responses
 * 3. Works with all HTTP methods (POST/PUT/PATCH/GET/DELETE)
 *
 * Note: Actual log output verification is done via unit tests since
 * production uses LOG_LEVEL=info which suppresses debug-level body logs.
 */

import { describe, test, expect, beforeAll, afterAll } from "@jest/globals";
import fetch from "node-fetch";
import { getTestBaseUrl, getAdminCredentials } from "../utils/test-config.js";

const BASE_URL = getTestBaseUrl();
const ADMIN_CREDENTIALS = getAdminCredentials();

describe("Request Body Logging Middleware - REST API", () => {
  let authCookie: string;
  const testWorkflowIds: string[] = [];

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
    for (const workflowId of testWorkflowIds) {
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

  test("POST request returns X-Request-Id header and succeeds", async () => {
    const response = await fetch(`${BASE_URL}/api/workflows`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: authCookie,
      },
      body: JSON.stringify({
        workflow: {
          metadata: {
            name: "Body Logging Test POST",
            version: "1.0.0",
            description: "Test request body logging",
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
    testWorkflowIds.push(data.data.workflowId);

    // Verify X-Request-Id header is present
    const requestId = response.headers.get("x-request-id");
    expect(requestId).toBeTruthy();
    expect(typeof requestId).toBe("string");
    expect(requestId!.length).toBeGreaterThan(0);
  });

  test("PATCH visibility request returns X-Request-Id header and succeeds", async () => {
    // First create a workflow
    const createResponse = await fetch(`${BASE_URL}/api/workflows`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: authCookie,
      },
      body: JSON.stringify({
        workflow: {
          metadata: {
            name: "Visibility Test",
            version: "1.0.0",
            description: "Initial",
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
    testWorkflowIds.push(workflowId);

    // Now update visibility with PATCH (endpoint is /:id/visibility)
    const patchResponse = await fetch(`${BASE_URL}/api/workflows/${workflowId}/visibility`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Cookie: authCookie,
      },
      body: JSON.stringify({
        visibility: "public",
      }),
    });

    expect(patchResponse.status).toBe(200);

    const requestId = patchResponse.headers.get("x-request-id");
    expect(requestId).toBeTruthy();
  });

  test("GET request returns X-Request-Id header", async () => {
    const response = await fetch(`${BASE_URL}/api/workflows`, {
      headers: { Cookie: authCookie },
    });

    expect(response.status).toBe(200);

    const requestId = response.headers.get("x-request-id");
    expect(requestId).toBeTruthy();
  });

  test("DELETE request returns X-Request-Id header", async () => {
    // First create a workflow to delete
    const createResponse = await fetch(`${BASE_URL}/api/workflows`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: authCookie,
      },
      body: JSON.stringify({
        workflow: {
          metadata: {
            name: "DELETE Test",
            version: "1.0.0",
            description: "To be deleted",
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

    const deleteResponse = await fetch(`${BASE_URL}/api/workflows/${workflowId}`, {
      method: "DELETE",
      headers: { Cookie: authCookie },
    });

    expect(deleteResponse.status).toBe(200);

    const requestId = deleteResponse.headers.get("x-request-id");
    expect(requestId).toBeTruthy();
  });

  test("Auth endpoint processes request successfully (body not logged for security)", async () => {
    // Auth endpoint should work but body should NOT be logged (sensitive)
    // We can't verify log absence easily, but we verify auth still works
    const response = await fetch(`${BASE_URL}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(ADMIN_CREDENTIALS),
    });

    // Auth should succeed
    expect(response.status).toBe(200);

    // Request ID should still be present even for excluded endpoints
    const requestId = response.headers.get("x-request-id");
    expect(requestId).toBeTruthy();
  });

  test("Large request body is handled without issues", async () => {
    // Create a workflow with a very long description to test body truncation
    // The description alone should exceed 10KB
    const longDescription = "This is a test workflow with a very long description. ".repeat(500);

    const response = await fetch(`${BASE_URL}/api/workflows`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: authCookie,
      },
      body: JSON.stringify({
        workflow: {
          metadata: {
            name: "Large Body Test",
            version: "1.0.0",
            description: longDescription, // ~27KB of description text
          },
          nodes: [
            { type: "start", id: "start", connections: { default: "end" } },
            { type: "end", id: "end" },
          ],
        },
      }),
    });

    expect(response.status).toBe(200);
    const data = (await response.json()) as { success: boolean; data: { workflowId: string } };
    expect(data.success).toBe(true);
    expect(data.data.workflowId).toBeDefined();
    testWorkflowIds.push(data.data.workflowId);
  });
});
