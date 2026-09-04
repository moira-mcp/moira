/**
 * MCP E2E Tests - Workflow Search
 * Tests: list workflows with search parameter including hyphen character (#246)
 */

import { describe, test, expect, beforeAll, afterAll } from "@jest/globals";
import { createAuthenticatedMCPClient, callMCPTool } from "../utils/mcp-auth.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

describe("MCP Workflow Search E2E", () => {
  let client: Client;
  let cleanup: () => Promise<void>;
  let testWorkflowId: string;
  let testWorkflowSlug: string;
  // Use a unique workflow name with hyphen for search tests
  const testWorkflowName = `Test-Search-Hyphen-Workflow-${Date.now()}`;

  beforeAll(async () => {
    const mcpClient = await createAuthenticatedMCPClient();
    client = mcpClient.client;
    cleanup = mcpClient.cleanup;

    // Create a test workflow with hyphen in name (UUID is auto-generated)
    const createResult = await callMCPTool(client, "manage", {
      action: "create",
      workflow: {
        metadata: {
          name: testWorkflowName,
          version: "1.0.0",
          description: "Test workflow for hyphen search functionality",
        },
        variableRegistry: {
          topic: {
            type: "string",
            description: "Topic used by the registered manage action test",
            default: "contracts",
          },
        },
        nodes: [
          { type: "start", id: "start", connections: { default: "analysis" } },
          {
            type: "agent-directive",
            id: "analysis",
            directive: "Analyze the {{topic}} contract.",
            completionCondition: "The contract is analyzed.",
            connections: { success: "end" },
          },
          { type: "end", id: "end" },
        ],
      },
    });

    expect(createResult).toHaveProperty("success", true);
    expect(createResult).toHaveProperty("workflowId");
    expect(createResult).toHaveProperty("slug");
    testWorkflowId = createResult.workflowId;
    testWorkflowSlug = createResult.slug;
  });

  afterAll(async () => {
    // Delete test workflow
    if (testWorkflowId) {
      try {
        await callMCPTool(client, "manage", {
          action: "edit",
          workflowId: testWorkflowId,
          changes: {}, // This will fail, but we can use a delete approach
        });
      } catch {
        // Ignore cleanup errors
      }
    }
    await cleanup();
  });

  test("search by workflow name with hyphen returns results", async () => {
    // Search using the hyphenated name pattern
    const result = await callMCPTool(client, "list", {
      search: "Test-Search-Hyphen-Workflow",
    });

    expect(result).toHaveProperty("workflows");
    expect(result.workflows.length).toBeGreaterThanOrEqual(1);
    expect(result).toEqual(
      expect.objectContaining({
        offset: 0,
        limit: 20,
        returnedCount: result.workflows.length,
        hasMore: false,
        nextOffset: null,
      }),
    );

    // Match by slug since list id is now "handle/slug" format, not UUID
    const found = result.workflows.find((w: { slug: string }) => w.slug === testWorkflowSlug);
    expect(found).toBeDefined();
    expect(found.slug).toBe(testWorkflowSlug);
  });

  test("list response includes version field", async () => {
    // Search for our test workflow by name
    const result = await callMCPTool(client, "list", {
      search: testWorkflowName,
    });

    expect(result).toHaveProperty("workflows");
    expect(result.workflows.length).toBeGreaterThanOrEqual(1);

    // Match by slug since list id is now "handle/slug" format, not UUID
    const found = result.workflows.find((w: { slug: string }) => w.slug === testWorkflowSlug);
    expect(found).toBeDefined();
    expect(found).toHaveProperty("version");
    expect(found.version).toBe("1.0.0");
  });

  test("search by partial name with hyphen returns results", async () => {
    const result = await callMCPTool(client, "list", {
      search: "Search-Hyphen-Workflow",
    });

    expect(result).toHaveProperty("workflows");
    expect(result.workflows.length).toBeGreaterThanOrEqual(1);

    // Match by slug since list id is now "handle/slug" format, not UUID
    const found = result.workflows.find((w: { slug: string }) => w.slug === testWorkflowSlug);
    expect(found).toBeDefined();
  });

  test("search by partial name works", async () => {
    const result = await callMCPTool(client, "list", {
      search: "Hyphen-Workflow",
    });

    expect(result).toHaveProperty("workflows");
    expect(result.workflows.length).toBeGreaterThanOrEqual(1);

    // Match by slug since list id is now "handle/slug" format, not UUID
    const found = result.workflows.find((w: { slug: string }) => w.slug === testWorkflowSlug);
    expect(found).toBeDefined();
  });

  test("search is case insensitive for name", async () => {
    const result = await callMCPTool(client, "list", {
      search: "TEST-SEARCH-HYPHEN-WORKFLOW",
    });

    // SQLite LIKE is case-insensitive by default for ASCII
    expect(result).toHaveProperty("workflows");
    expect(result.workflows.length).toBeGreaterThanOrEqual(1);
  });

  test("search returns empty for non-matching query", async () => {
    const result = await callMCPTool(client, "list", {
      search: "nonexistent-workflow-xyz123",
    });

    expect(result).toHaveProperty("workflows");
    expect(result.workflows.length).toBe(0);
    expect(result.total).toBe(0);
    expect(result).toEqual(
      expect.objectContaining({
        offset: 0,
        limit: 20,
        returnedCount: 0,
        hasMore: false,
        nextOffset: null,
      }),
    );
  });

  test("registered manage calls expose node discovery, variable analysis, and visibility state", async () => {
    const listed = await callMCPTool(client, "manage", {
      action: "list-nodes",
      workflowId: testWorkflowId,
      typeFilter: "agent-directive",
      includePreview: true,
      previewLength: 12,
    });
    expect(listed).toEqual(
      expect.objectContaining({
        success: true,
        nodeCount: 1,
        nodes: [
          expect.objectContaining({
            id: "analysis",
            type: "agent-directive",
            directivePreview: expect.stringContaining("Analyze"),
          }),
        ],
      }),
    );

    const selected = await callMCPTool(client, "manage", {
      action: "get-nodes",
      workflowId: testWorkflowId,
      nodeIds: ["start", "analysis"],
    });
    expect(selected).toEqual(
      expect.objectContaining({
        success: true,
        requestedCount: 2,
        foundCount: 2,
      }),
    );
    expect(selected.nodes.map((node: { id: string }) => node.id)).toEqual(["start", "analysis"]);

    const variables = await callMCPTool(client, "manage", {
      action: "analyze-variables",
      workflowId: testWorkflowId,
    });
    expect(variables).toEqual(
      expect.objectContaining({
        success: true,
        analysis: expect.objectContaining({
          topic: expect.objectContaining({
            sources: [expect.objectContaining({ type: "registry" })],
          }),
        }),
      }),
    );

    const madePublic = await callMCPTool(client, "manage", {
      action: "set-visibility",
      workflowId: testWorkflowId,
      visibility: "public",
    });
    expect(madePublic).toEqual(
      expect.objectContaining({ previousVisibility: "private", newVisibility: "public" }),
    );

    const publicWorkflow = await callMCPTool(client, "manage", {
      action: "get",
      workflowId: testWorkflowId,
      includeNodes: false,
      includeValidation: false,
    });
    expect(publicWorkflow.visibility).toBe("public");

    const madePrivate = await callMCPTool(client, "manage", {
      action: "set-visibility",
      workflowId: testWorkflowId,
      visibility: "private",
    });
    expect(madePrivate).toEqual(
      expect.objectContaining({ previousVisibility: "public", newVisibility: "private" }),
    );
  });
});
