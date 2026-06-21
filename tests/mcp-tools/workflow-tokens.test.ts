/**
 * MCP E2E Tests - Workflow Token Tools
 * Tests: create_workflow_token (upload/download actions)
 * Plus HTTP endpoint tests with supertest
 */

import { describe, test, expect, beforeAll, afterAll } from "@jest/globals";
import {
  createAuthenticatedMCPClient,
  callMCPTool,
  parseTokenResponse,
  createTestUserViaApi,
} from "../utils/mcp-auth.js";
import { getTestBaseUrl } from "../utils/test-config.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import request from "supertest";
import { writeFileSync, unlinkSync, mkdirSync } from "fs";
import { join } from "path";

const BASE_URL = getTestBaseUrl();

describe("MCP Workflow Token Tools E2E", () => {
  let client: Client;
  let cleanup: () => Promise<void>;

  beforeAll(async () => {
    const mcpClient = await createAuthenticatedMCPClient();
    client = mcpClient.client;
    cleanup = mcpClient.cleanup;
  });

  afterAll(async () => {
    await cleanup();
  });

  test("create_workflow_token upload action generates valid token", async () => {
    const rawResult = await callMCPTool<string>(client, "token", {
      action: "upload",
      ttlMinutes: 60,
    });

    const result = parseTokenResponse(rawResult);

    expect(result).toHaveProperty("token");
    expect(result).toHaveProperty("uploadUrl");
    expect(result).toHaveProperty("expiresAt");

    expect(result.token).toMatch(/^[a-zA-Z0-9-]+$/);
    expect(result.uploadUrl).toContain("/api/public/workflows/upload/");
    expect(result.uploadUrl).toContain(result.token);
  });

  test("create_workflow_token download action generates valid token", async () => {
    // Get a workflow ID first
    const listResult = await callMCPTool(client, "list", {});
    const workflows = listResult.workflows || listResult;
    if (!workflows || workflows.length === 0) {
      console.warn("No workflows available, skipping download token test");
      return;
    }

    const workflowId = workflows[0].id;

    const rawResult = await callMCPTool<string>(client, "token", {
      action: "download",
      workflowId,
      ttlMinutes: 60,
    });

    const result = parseTokenResponse(rawResult);

    expect(result).toHaveProperty("token");
    expect(result).toHaveProperty("downloadUrl");
    expect(result).toHaveProperty("expiresAt");

    expect(result.token).toMatch(/^[a-zA-Z0-9-]+$/);
    expect(result.downloadUrl).toContain("/api/public/workflows/download/");
    expect(result.downloadUrl).toContain(result.token);
  });
});

describe("HTTP Token Endpoints E2E (Supertest)", () => {
  let client: Client;
  let cleanup: () => Promise<void>;
  let uploadToken: string;
  let downloadToken: string;
  let testWorkflowId: string;
  const tempDir = join(process.cwd(), "claude-temp-files");

  beforeAll(async () => {
    mkdirSync(tempDir, { recursive: true });
    const mcpClient = await createAuthenticatedMCPClient();
    client = mcpClient.client;
    cleanup = mcpClient.cleanup;

    // Create upload token via MCP
    const uploadRaw = await callMCPTool<string>(client, "token", {
      action: "upload",
    });
    const uploadResult = parseTokenResponse(uploadRaw);
    uploadToken = uploadResult.token;

    // Create a dedicated workflow for download token test (to avoid race conditions)
    // This ensures the workflow exists regardless of other tests' state
    const createResult = await callMCPTool(client, "manage", {
      action: "create",
      workflow: {
        id: `test-download-workflow-${Date.now()}`,
        metadata: {
          name: "Test Download Workflow",
          version: "1.0.0",
          description: "Workflow for download token test",
        },
        nodes: [
          { type: "start", id: "start", connections: { default: "end" } },
          { type: "end", id: "end" },
        ],
      },
    });
    testWorkflowId = createResult.workflowId;

    // Create download token for our dedicated workflow
    const downloadRaw = await callMCPTool<string>(client, "token", {
      action: "download",
      workflowId: testWorkflowId,
    });
    const downloadResult = parseTokenResponse(downloadRaw);
    downloadToken = downloadResult.token;
  });

  afterAll(async () => {
    await cleanup();
  });

  test("POST /api/public/workflows/upload/:token uploads workflow file", async () => {
    // Create test workflow file (no id - server generates UUID)
    const testWorkflow = {
      metadata: {
        name: "Test Upload Workflow",
        version: "1.0.0",
        description: "Test workflow for upload",
      },
      nodes: [
        { type: "start", id: "start", connections: { default: "end" } },
        { type: "end", id: "end" },
      ],
    };

    const tempFile = join("/tmp", "test-workflow.json");
    writeFileSync(tempFile, JSON.stringify(testWorkflow, null, 2));

    try {
      const response = await request(BASE_URL)
        .post(`/api/public/workflows/upload/${uploadToken}`)
        .attach("workflow", tempFile)
        .expect(200);

      expect(response.body).toHaveProperty("success", true);
      expect(response.body.data).toHaveProperty("workflowId");

      // Capture the returned workflowId
      const uploadedWorkflowId = response.body.data.workflowId;

      // Verify workflow exists via MCP get (more reliable than list)
      const verifyResult = await callMCPTool(client, "manage", {
        action: "get",
        workflowId: uploadedWorkflowId,
      });
      expect(verifyResult).toHaveProperty("workflowId", uploadedWorkflowId);
      expect(verifyResult.metadata.name).toBe("Test Upload Workflow");
    } finally {
      unlinkSync(tempFile);
    }
  });

  test("GET /api/public/workflows/download/:token downloads formatted JSON", async () => {
    // downloadToken and testWorkflowId are always set in beforeAll (dedicated workflow created)
    expect(downloadToken).toBeDefined();
    expect(testWorkflowId).toBeDefined();

    const response = await request(BASE_URL)
      .get(`/api/public/workflows/download/${downloadToken}`)
      .expect(200)
      .expect("Content-Type", /json/);

    // Downloaded workflow contains internal UUID, not handle/slug format
    expect(response.body).toHaveProperty("id");
    expect(response.body).toHaveProperty("metadata");
    expect(response.body).toHaveProperty("nodes");

    // Verify JSON is formatted with 2-space indent (not compact/minified)
    const rawText = response.text;
    expect(rawText).toContain("\n"); // Multi-line
    expect(rawText).toMatch(/^\{\n {2}"/); // Starts with "{\n  " (2-space indent)
    // Re-stringify with 2-space indent should match original
    const reparsed = JSON.stringify(JSON.parse(rawText), null, 2);
    expect(rawText).toBe(reparsed);
  });

  test("token reuse is prevented (single-use)", async () => {
    // Create new upload token
    const tokenRaw = await callMCPTool<string>(client, "token", {
      action: "upload",
    });
    const tokenResult = parseTokenResponse(tokenRaw);
    const singleUseToken = tokenResult.token;

    // No id - server generates UUID
    const testWorkflow = {
      metadata: { name: "Test", version: "1.0.0", description: "Test" },
      nodes: [
        { type: "start", id: "start", connections: { default: "end" } },
        { type: "end", id: "end" },
      ],
    };

    const tempFile = join("/tmp", "test-single-use.json");
    writeFileSync(tempFile, JSON.stringify(testWorkflow));

    try {
      // First upload - should succeed
      await request(BASE_URL)
        .post(`/api/public/workflows/upload/${singleUseToken}`)
        .attach("workflow", tempFile)
        .expect(200);

      // Second upload with same token - should fail (401)
      await request(BASE_URL)
        .post(`/api/public/workflows/upload/${singleUseToken}`)
        .attach("workflow", tempFile)
        .expect(401);
    } finally {
      unlinkSync(tempFile);
    }
  });

  test("invalid token returns 401", async () => {
    await request(BASE_URL).get("/api/public/workflows/download/invalid-token-12345").expect(401);
  });

  test("upload with forceNew=true creates new workflow ignoring id in JSON", async () => {
    // First, create a workflow
    const originalWorkflow = {
      metadata: {
        name: "Original ForceNew Test",
        version: "1.0.0",
        description: "Test for forceNew parameter",
      },
      nodes: [
        { type: "start", id: "start", connections: { default: "end" } },
        { type: "end", id: "end" },
      ],
    };

    // Create original workflow via MCP (server generates UUID)
    const createResult = await callMCPTool(client, "manage", {
      action: "create",
      workflow: originalWorkflow,
    });
    const originalId = createResult.workflowId;

    // Get new upload token
    const tokenRaw = await callMCPTool<string>(client, "token", {
      action: "upload",
    });
    const tokenResult = parseTokenResponse(tokenRaw);

    // Create workflow JSON with original ID - forceNew should ignore it
    const workflowWithId = {
      id: originalId,
      ...originalWorkflow,
    };

    // Upload workflow with forceNew=true - should create copy ignoring the id
    const tempFile = join("/tmp", "test-forcenew.json");
    writeFileSync(tempFile, JSON.stringify(workflowWithId));

    try {
      const response = await request(BASE_URL)
        .post(`/api/public/workflows/upload/${tokenResult.token}`)
        .attach("workflow", tempFile)
        .field("forceNew", "true")
        .expect(200);

      expect(response.body.success).toBe(true);
      const newId = response.body.data.workflowId;

      // New workflow should have different ID than original
      expect(newId).not.toBe(originalId);

      // Verify original workflow still exists unchanged
      const originalCheck = await callMCPTool(client, "manage", {
        action: "get",
        workflowId: originalId,
      });
      expect(originalCheck.metadata.name).toBe("Original ForceNew Test");

      // Verify new workflow was created
      const newCheck = await callMCPTool(client, "manage", {
        action: "get",
        workflowId: newId,
      });
      expect(newCheck.metadata.name).toBe("Original ForceNew Test");
    } finally {
      unlinkSync(tempFile);
    }
  });

  test("upload with forceNew=false respects existing id (update behavior)", async () => {
    // Create a workflow first
    const workflow = {
      metadata: {
        name: "Initial Version",
        version: "1.0.0",
        description: "Test for update behavior",
      },
      nodes: [
        { type: "start", id: "start", connections: { default: "end" } },
        { type: "end", id: "end" },
      ],
    };

    // Create original (server generates UUID)
    const createResult = await callMCPTool(client, "manage", {
      action: "create",
      workflow,
    });
    const workflowId = createResult.workflowId;

    // Get upload token
    const tokenRaw = await callMCPTool<string>(client, "token", {
      action: "upload",
    });
    const tokenResult = parseTokenResponse(tokenRaw);

    // Upload updated version with actual ID and forceNew=false (default)
    const updated = {
      id: workflowId, // Use actual workflow ID
      metadata: { ...workflow.metadata, name: "Updated Version" },
      nodes: workflow.nodes,
    };

    const tempFile = join("/tmp", "test-update.json");
    writeFileSync(tempFile, JSON.stringify(updated));

    try {
      const response = await request(BASE_URL)
        .post(`/api/public/workflows/upload/${tokenResult.token}`)
        .attach("workflow", tempFile)
        .field("forceNew", "false")
        .expect(200);

      expect(response.body.success).toBe(true);
      // Should return same ID (updated, not new)
      expect(response.body.data.workflowId).toBe(workflowId);

      // Verify workflow was updated
      const check = await callMCPTool(client, "manage", {
        action: "get",
        workflowId,
      });
      expect(check.metadata.name).toBe("Updated Version");
    } finally {
      unlinkSync(tempFile);
    }
  });

  test("adminOverride requires admin privileges", async () => {
    // This test verifies server-side admin check for adminOverride
    // When non-admin tries adminOverride, should get 403

    // First create a workflow owned by admin (current user)
    const workflowId = `admin-override-test-${Date.now()}`;
    const workflow = {
      id: workflowId,
      metadata: {
        name: "Admin Override Test",
        version: "1.0.0",
        description: "Test adminOverride parameter",
      },
      nodes: [
        { type: "start", id: "start", connections: { default: "end" } },
        { type: "end", id: "end" },
      ],
    };

    await callMCPTool(client, "manage", {
      action: "create",
      workflow,
    });

    // Get upload token (as admin - should work with adminOverride)
    const tokenRaw = await callMCPTool<string>(client, "token", {
      action: "upload",
    });
    const tokenResult = parseTokenResponse(tokenRaw);

    const tempFile = join(
      process.cwd(),
      "claude-temp-files",
      `test-admin-override-${Date.now()}.json`,
    );
    writeFileSync(tempFile, JSON.stringify(workflow));

    try {
      // Admin user with adminOverride=true should succeed
      const response = await request(BASE_URL)
        .post(`/api/public/workflows/upload/${tokenResult.token}`)
        .attach("workflow", tempFile)
        .field("adminOverride", "true")
        .expect(200);

      expect(response.body.success).toBe(true);
    } finally {
      unlinkSync(tempFile);
    }
  });

  test("ownership conflict error includes hint about forceNew and adminOverride", async () => {
    // This test verifies the enhanced error message when a user tries to modify
    // someone else's workflow - should include hints about forceNew and adminOverride

    // Admin creates a workflow (server generates UUID)
    const workflow = {
      metadata: {
        name: "Ownership Conflict Test",
        version: "1.0.0",
        description: "Test ownership conflict error message",
      },
      nodes: [
        { type: "start", id: "start", connections: { default: "end" } },
        { type: "end", id: "end" },
      ],
    };

    // Admin creates the workflow (gets ownership), get actual ID
    const createResult = await callMCPTool(client, "manage", {
      action: "create",
      workflow,
    });
    const workflowId = createResult.workflowId;

    // Create a non-admin user
    const nonAdminEmail = `ownership-test-${Date.now()}@test.com`;
    const nonAdminPassword = "TestPass123";
    await createTestUserViaApi(
      BASE_URL,
      nonAdminEmail,
      nonAdminPassword,
      "Ownership Test User",
      true,
    );

    // Create MCP client for non-admin user
    const nonAdminMcp = await createAuthenticatedMCPClient({
      email: nonAdminEmail,
      password: nonAdminPassword,
    });

    try {
      // Non-admin gets upload token
      const tokenRaw = await callMCPTool<string>(nonAdminMcp.client, "token", {
        action: "upload",
      });
      const tokenResult = parseTokenResponse(tokenRaw);

      // Workflow JSON with the admin's workflow ID
      const conflictWorkflow = {
        id: workflowId, // Admin's workflow ID
        metadata: {
          name: "Trying to overwrite",
          version: "2.0.0",
          description: "This should fail with helpful error",
        },
        nodes: [
          { type: "start", id: "start", connections: { default: "end" } },
          { type: "end", id: "end" },
        ],
      };

      const tempFile = join(
        process.cwd(),
        "claude-temp-files",
        `test-ownership-conflict-${Date.now()}.json`,
      );
      writeFileSync(tempFile, JSON.stringify(conflictWorkflow));

      try {
        // Non-admin tries to modify admin's workflow - should get 403 with helpful hints
        const response = await request(BASE_URL)
          .post(`/api/public/workflows/upload/${tokenResult.token}`)
          .attach("workflow", tempFile)
          .expect(403);

        // Verify error message contains all expected hints
        const errorMessage = response.body.error.message;
        expect(errorMessage).toContain("Access denied");
        expect(errorMessage).toContain("owned by another user");
        expect(errorMessage).toContain("forceNew=true");
        expect(errorMessage).toContain("adminOverride=true");
        expect(errorMessage).toContain("create your own copy");
      } finally {
        unlinkSync(tempFile);
      }
    } finally {
      await nonAdminMcp.cleanup();
    }
  });

  test("non-admin with adminOverride gets 403 Forbidden", async () => {
    // This test verifies that non-admin users cannot use adminOverride
    // They should receive 403 Forbidden error

    // Create a workflow owned by admin
    const workflowId = `non-admin-override-test-${Date.now()}`;
    const workflow = {
      id: workflowId,
      metadata: {
        name: "Non-Admin Override Test",
        version: "1.0.0",
        description: "Test that non-admin cannot use adminOverride",
      },
      nodes: [
        { type: "start", id: "start", connections: { default: "end" } },
        { type: "end", id: "end" },
      ],
    };

    // Admin creates the workflow
    await callMCPTool(client, "manage", {
      action: "create",
      workflow,
    });

    // Create a non-admin user
    const nonAdminEmail = `non-admin-${Date.now()}@test.com`;
    const nonAdminPassword = "TestPass123";
    await createTestUserViaApi(BASE_URL, nonAdminEmail, nonAdminPassword, "Non Admin User", true);

    // Create MCP client for non-admin user
    const nonAdminMcp = await createAuthenticatedMCPClient({
      email: nonAdminEmail,
      password: nonAdminPassword,
    });

    try {
      // Non-admin gets upload token
      const tokenRaw = await callMCPTool<string>(nonAdminMcp.client, "token", {
        action: "upload",
      });
      const tokenResult = parseTokenResponse(tokenRaw);

      const tempFile = join(
        process.cwd(),
        "claude-temp-files",
        `test-non-admin-override-${Date.now()}.json`,
      );
      writeFileSync(tempFile, JSON.stringify(workflow));

      try {
        // Non-admin tries to use adminOverride=true - should get 403
        const response = await request(BASE_URL)
          .post(`/api/public/workflows/upload/${tokenResult.token}`)
          .attach("workflow", tempFile)
          .field("adminOverride", "true")
          .expect(403);

        // Verify error message
        expect(response.body.error.message).toContain("Admin override requires admin privileges");
      } finally {
        unlinkSync(tempFile);
      }
    } finally {
      await nonAdminMcp.cleanup();
    }
  });
});
