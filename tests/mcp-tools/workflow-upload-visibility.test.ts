/**
 * API Tests - Upload workflow via token with visibility parameter
 * Tests visibility field in multipart form upload
 */

import { describe, test, expect, beforeAll, afterAll } from "@jest/globals";
import fetch from "node-fetch";
import FormData from "form-data";
import { getTestBaseUrl, getTestFetchUrl, getAdminCredentials } from "../utils/test-config.js";
import {
  createAuthenticatedMCPClient,
  callMCPTool,
  parseTokenResponse,
} from "../utils/mcp-auth.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

const BASE_URL = getTestBaseUrl();
const FETCH_URL = getTestFetchUrl();
const ADMIN_CREDENTIALS = getAdminCredentials();

describe("Upload workflow via token with visibility parameter", () => {
  let authCookie: string;
  let mcpClient: Client;
  let cleanupMcp: () => Promise<void>;
  const createdWorkflows: string[] = [];

  beforeAll(async () => {
    // Sign in for REST API
    const signinResponse = await fetch(`${FETCH_URL}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(ADMIN_CREDENTIALS),
    });

    const cookies = signinResponse.headers.get("set-cookie");
    if (!cookies) {
      throw new Error("No session cookie received from sign-in");
    }
    authCookie = cookies;

    // Create MCP client for token generation
    const mcp = await createAuthenticatedMCPClient();
    mcpClient = mcp.client;
    cleanupMcp = mcp.cleanup;
  });

  afterAll(async () => {
    // Cleanup created workflows
    for (const workflowId of createdWorkflows) {
      try {
        await fetch(`${FETCH_URL}/api/workflows/${workflowId}`, {
          method: "DELETE",
          headers: { Cookie: authCookie },
        });
      } catch {
        // Ignore cleanup errors
      }
    }

    await cleanupMcp();
  });

  /**
   * Helper to get upload token via MCP
   */
  async function getUploadToken(): Promise<string> {
    const rawResult = await callMCPTool<string>(mcpClient, "token", {
      action: "upload",
      ttlMinutes: 60,
    });
    const result = parseTokenResponse(rawResult);
    return result.token;
  }

  /**
   * Helper to create workflow JSON
   */
  function createWorkflowJson(suffix: string): object {
    return {
      metadata: {
        name: `Upload Visibility Test ${suffix}`,
        version: "1.0.0",
        description: "Test workflow for upload visibility",
      },
      nodes: [
        { type: "start", id: "start", connections: { default: "end" } },
        { type: "end", id: "end" },
      ],
    };
  }

  test("upload with visibility=public creates public workflow", async () => {
    const token = await getUploadToken();
    const workflowJson = createWorkflowJson(`public-${Date.now()}`);

    const form = new FormData();
    form.append("workflow", Buffer.from(JSON.stringify(workflowJson)), {
      filename: "workflow.json",
      contentType: "application/json",
    });
    form.append("visibility", "public");

    const response = await fetch(`${FETCH_URL}/api/public/workflows/upload/${token}`, {
      method: "POST",
      body: form,
      headers: form.getHeaders(),
    });

    expect(response.status).toBe(200);
    const data = (await response.json()) as any;
    expect(data.success).toBe(true);
    expect(data.data.workflowId).toBeDefined();
    const workflowId = data.data.workflowId;
    createdWorkflows.push(workflowId);

    // Verify visibility is public via MCP (same user who owns the token)
    const verifyResult = await callMCPTool(mcpClient, "manage", {
      action: "get",
      workflowId,
    });
    expect(verifyResult).toHaveProperty("visibility", "public");
  });

  test("upload with visibility=private creates private workflow", async () => {
    const token = await getUploadToken();
    const workflowJson = createWorkflowJson(`private-${Date.now()}`);

    const form = new FormData();
    form.append("workflow", Buffer.from(JSON.stringify(workflowJson)), {
      filename: "workflow.json",
      contentType: "application/json",
    });
    form.append("visibility", "private");

    const response = await fetch(`${FETCH_URL}/api/public/workflows/upload/${token}`, {
      method: "POST",
      body: form,
      headers: form.getHeaders(),
    });

    expect(response.status).toBe(200);
    const data = (await response.json()) as any;
    expect(data.success).toBe(true);
    expect(data.data.workflowId).toBeDefined();
    const workflowId = data.data.workflowId;
    createdWorkflows.push(workflowId);

    // Verify visibility is private via MCP
    const verifyResult = await callMCPTool(mcpClient, "manage", {
      action: "get",
      workflowId,
    });
    expect(verifyResult).toHaveProperty("visibility", "private");
  });

  test("upload without visibility defaults to private", async () => {
    const token = await getUploadToken();
    const workflowJson = createWorkflowJson(`default-${Date.now()}`);

    const form = new FormData();
    form.append("workflow", Buffer.from(JSON.stringify(workflowJson)), {
      filename: "workflow.json",
      contentType: "application/json",
    });
    // No visibility field

    const response = await fetch(`${FETCH_URL}/api/public/workflows/upload/${token}`, {
      method: "POST",
      body: form,
      headers: form.getHeaders(),
    });

    expect(response.status).toBe(200);
    const data = (await response.json()) as any;
    expect(data.success).toBe(true);
    expect(data.data.workflowId).toBeDefined();
    const workflowId = data.data.workflowId;
    createdWorkflows.push(workflowId);

    // Verify visibility defaults to private via MCP
    const verifyResult = await callMCPTool(mcpClient, "manage", {
      action: "get",
      workflowId,
    });
    expect(verifyResult).toHaveProperty("visibility", "private");
  });

  test("upload with invalid visibility returns error", async () => {
    const token = await getUploadToken();
    const workflowJson = createWorkflowJson(`invalid-${Date.now()}`);

    const form = new FormData();
    form.append("workflow", Buffer.from(JSON.stringify(workflowJson)), {
      filename: "workflow.json",
      contentType: "application/json",
    });
    form.append("visibility", "invalid_value");

    const response = await fetch(`${FETCH_URL}/api/public/workflows/upload/${token}`, {
      method: "POST",
      body: form,
      headers: form.getHeaders(),
    });

    expect(response.status).toBe(400);
    const data = (await response.json()) as any;
    expect(data.success).toBe(false);
    expect(data.error.message).toContain("visibility");
  });
});
