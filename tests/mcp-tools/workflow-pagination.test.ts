/**
 * MCP E2E Tests - Workflow Pagination
 * Tests: get_workflow_details with offset/limit parameters
 */

import { describe, test, expect, beforeAll, afterAll } from "@jest/globals";
import { createAuthenticatedMCPClient, callMCPTool } from "../utils/mcp-auth.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

describe("MCP Workflow Pagination E2E", () => {
  let client: Client;
  let cleanup: () => Promise<void>;
  let largeWorkflowId: string;

  beforeAll(async () => {
    const mcpClient = await createAuthenticatedMCPClient();
    client = mcpClient.client;
    cleanup = mcpClient.cleanup;

    // Find workflow with multiple nodes
    const listResult = await callMCPTool(client, "list", {});
    const workflows = listResult.workflows || listResult;
    for (const wf of workflows) {
      const rawDetails = await callMCPTool(client, "manage", {
        action: "get",
        workflowId: wf.id,
      });
      // Handle wrapped response {success, metadata, nodes, ...} or direct {id, metadata, nodes}
      const details = rawDetails.metadata ? rawDetails : rawDetails;
      const nodes = details.nodes || [];
      if (nodes.length >= 5) {
        largeWorkflowId = wf.id;
        break;
      }
    }
  });

  afterAll(async () => {
    await cleanup();
  });

  test("get_workflow_details without pagination returns all nodes", async () => {
    if (!largeWorkflowId) {
      console.warn("No large workflow available, skipping");
      return;
    }

    const rawResult = await callMCPTool(client, "manage", {
      action: "get",
      workflowId: largeWorkflowId,
    });

    // MCP tool returns wrapped response with success, validation, metadata, nodes
    expect(rawResult).toHaveProperty("success", true);
    expect(rawResult).toHaveProperty("metadata");
    expect(rawResult).toHaveProperty("nodes");
    expect(Array.isArray(rawResult.nodes)).toBe(true);
    expect(rawResult.nodes.length).toBeGreaterThanOrEqual(5);
  });

  test("get_workflow_details with pagination returns subset", async () => {
    if (!largeWorkflowId) {
      console.warn("No large workflow available, skipping");
      return;
    }

    const result = await callMCPTool(client, "manage", {
      action: "get",
      workflowId: largeWorkflowId,
      offset: 0,
      limit: 2,
    });

    expect(result).toHaveProperty("nodes");
    expect(result.nodes.length).toBe(2);
    expect(result).toHaveProperty("totalNodes");
    expect(result).toHaveProperty("hasMore");
    expect(result.totalNodes).toBeGreaterThanOrEqual(5);
    expect(result.hasMore).toBe(true);
  });

  test("pagination offset and limit work correctly", async () => {
    if (!largeWorkflowId) {
      console.warn("No large workflow available, skipping");
      return;
    }

    // Get first 2 nodes
    const page1 = await callMCPTool(client, "manage", {
      action: "get",
      workflowId: largeWorkflowId,
      offset: 0,
      limit: 2,
    });

    // Get next 2 nodes
    const page2 = await callMCPTool(client, "manage", {
      action: "get",
      workflowId: largeWorkflowId,
      offset: 2,
      limit: 2,
    });

    // Nodes should be different
    expect(page1.nodes[0].id).not.toBe(page2.nodes[0].id);

    // Total should be same
    expect(page1.totalNodes).toBe(page2.totalNodes);
  });

  test("metadata-only mode excludes nodes", async () => {
    if (!largeWorkflowId) {
      console.warn("No large workflow available, skipping");
      return;
    }

    const result = await callMCPTool(client, "manage", {
      action: "get",
      workflowId: largeWorkflowId,
      includeNodes: false,
    });

    expect(result).toHaveProperty("metadata");
    expect(result).not.toHaveProperty("nodes");
  });
});
