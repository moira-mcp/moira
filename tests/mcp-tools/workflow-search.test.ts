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
        nodes: [
          { type: "start", id: "start", connections: { default: "end" } },
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
  });
});
