/**
 * API Tests - Upload workflow via token with visibility parameter
 * Tests visibility field in multipart form upload
 */

import { describe, test, expect, beforeAll, afterAll } from "@jest/globals";
import fetch from "node-fetch";
import FormData from "form-data";
import { getTestFetchUrl } from "../utils/test-config.js";
import {
  createAuthenticatedMCPClient,
  callMCPTool,
  getAdminSessionCookie,
  parseTokenResponse,
  formatSessionCookie,
} from "../utils/mcp-auth.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

const FETCH_URL = getTestFetchUrl();

describe("Upload workflow via token with visibility parameter", () => {
  let authCookie: string;
  let mcpClient: Client;
  let cleanupMcp: () => Promise<void>;
  const createdWorkflows: string[] = [];

  beforeAll(async () => {
    // Admin session for REST cleanup
    authCookie = formatSessionCookie(FETCH_URL, await getAdminSessionCookie(FETCH_URL));

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
   * Helper to upload a workflow JSON through a fresh token, optionally with a visibility field
   */
  async function uploadWorkflow(suffix: string, visibility?: string) {
    const token = await getUploadToken();
    const workflowJson = {
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

    const form = new FormData();
    form.append("workflow", Buffer.from(JSON.stringify(workflowJson)), {
      filename: "workflow.json",
      contentType: "application/json",
    });
    if (visibility !== undefined) form.append("visibility", visibility);

    return fetch(`${FETCH_URL}/api/public/workflows/upload/${token}`, {
      method: "POST",
      body: form,
      headers: form.getHeaders(),
    });
  }

  test.each([
    ["public", "public"],
    ["private", "private"],
    [undefined, "private"], // no visibility field → default
  ])("upload with visibility=%s creates a %s workflow", async (visibility, expected) => {
    const response = await uploadWorkflow(`${visibility ?? "default"}-${Date.now()}`, visibility);

    expect(response.status).toBe(200);
    const data = (await response.json()) as any;
    expect(data.success).toBe(true);
    expect(data.data.workflowId).toBeDefined();
    const workflowId = data.data.workflowId;
    createdWorkflows.push(workflowId);

    // Verify visibility via MCP (same user who owns the token)
    const verifyResult = await callMCPTool(mcpClient, "manage", {
      action: "get",
      workflowId,
    });
    expect(verifyResult).toHaveProperty("visibility", expected);
  });

  test("upload with invalid visibility returns error", async () => {
    const response = await uploadWorkflow(`invalid-${Date.now()}`, "invalid_value");

    expect(response.status).toBe(400);
    const data = (await response.json()) as any;
    expect(data.success).toBe(false);
    expect(data.error.message).toContain("visibility");
  });
});
