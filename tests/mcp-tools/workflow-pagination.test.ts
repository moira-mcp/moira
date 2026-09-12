/**
 * MCP E2E Tests - Workflow Pagination
 * Tests: get_workflow_details with offset/limit parameters
 */

import { describe, test, expect, beforeAll, afterAll } from "@jest/globals";
import { createAuthenticatedMCPClient, callMCPTool } from "../utils/mcp-auth.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

const STEP_COUNT = 4;
const TOTAL_NODES = STEP_COUNT + 2; // start + steps + end

describe("MCP Workflow Pagination E2E", () => {
  let client: Client;
  let cleanup: () => Promise<void>;
  let largeWorkflowId: string;

  beforeAll(async () => {
    const mcpClient = await createAuthenticatedMCPClient();
    client = mcpClient.client;
    cleanup = mcpClient.cleanup;

    // Dedicated workflow with a known node count so every pagination assertion is exact
    const steps = Array.from({ length: STEP_COUNT }, (_, index) => ({
      type: "agent-directive",
      id: `step-${index + 1}`,
      directive: `Do step ${index + 1}`,
      completionCondition: `Step ${index + 1} done`,
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      connections: { success: index + 1 < STEP_COUNT ? `step-${index + 2}` : "end" },
    }));
    const created = await callMCPTool(client, "manage", {
      action: "create",
      workflow: {
        metadata: {
          name: "Pagination Source",
          version: "1.0.0",
          description: "Workflow with enough nodes to paginate",
        },
        nodes: [
          { type: "start", id: "start", connections: { default: "step-1" } },
          ...steps,
          { type: "end", id: "end" },
        ],
      },
    });
    expect(created).toHaveProperty("success", true);
    largeWorkflowId = created.workflowId;
  });

  afterAll(async () => {
    await cleanup();
  });

  test("get_workflow_details without pagination returns all nodes", async () => {
    const rawResult = await callMCPTool(client, "manage", {
      action: "get",
      workflowId: largeWorkflowId,
    });

    // MCP tool returns wrapped response with success, validation, metadata, nodes
    expect(rawResult).toHaveProperty("success", true);
    expect(rawResult).toHaveProperty("metadata");
    expect(Array.isArray(rawResult.nodes)).toBe(true);
    expect(rawResult.nodes).toHaveLength(TOTAL_NODES);
  });

  test("get_workflow_details with pagination returns subset", async () => {
    const result = await callMCPTool(client, "manage", {
      action: "get",
      workflowId: largeWorkflowId,
      offset: 0,
      limit: 2,
    });

    expect(result.nodes).toHaveLength(2);
    expect(result.totalNodes).toBe(TOTAL_NODES);
    expect(result.hasMore).toBe(true);
  });

  test("pagination offset and limit work correctly", async () => {
    const page1 = await callMCPTool(client, "manage", {
      action: "get",
      workflowId: largeWorkflowId,
      offset: 0,
      limit: 2,
    });
    const page2 = await callMCPTool(client, "manage", {
      action: "get",
      workflowId: largeWorkflowId,
      offset: 2,
      limit: 2,
    });

    const pageIds = (page: { nodes: Array<{ id: string }> }) => page.nodes.map((n) => n.id);
    expect(pageIds(page1)).toHaveLength(2);
    expect(pageIds(page2)).toHaveLength(2);
    expect(new Set([...pageIds(page1), ...pageIds(page2)]).size).toBe(4);
    expect(page1.totalNodes).toBe(TOTAL_NODES);
    expect(page2.totalNodes).toBe(TOTAL_NODES);
  });

  test("metadata-only mode excludes nodes", async () => {
    const result = await callMCPTool(client, "manage", {
      action: "get",
      workflowId: largeWorkflowId,
      includeNodes: false,
    });

    expect(result).toHaveProperty("metadata");
    expect(result).not.toHaveProperty("nodes");
  });
});
