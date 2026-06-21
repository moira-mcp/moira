/**
 * MCP JSON Formatting Tests
 * Verifies that MCP tool responses return formatted JSON (2-space indent)
 */

import { describe, test, expect, beforeAll, afterAll } from "@jest/globals";
import { createAuthenticatedMCPClient, callMCPTool, callMCPToolRaw } from "../utils/mcp-auth.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

describe("MCP JSON Formatting", () => {
  let client: Client;
  let cleanup: () => Promise<void>;
  let testWorkflowId: string;

  beforeAll(async () => {
    const mcpClient = await createAuthenticatedMCPClient();
    client = mcpClient.client;
    cleanup = mcpClient.cleanup;

    // Create a test workflow for JSON formatting tests
    const result = await callMCPTool(client, "manage", {
      action: "create",
      workflow: {
        metadata: {
          name: "JSON Formatting Test",
          version: "1.0.0",
          description: "Test workflow for JSON formatting verification",
        },
        nodes: [
          { type: "start", id: "start", connections: { default: "step1" } },
          {
            type: "agent-directive",
            id: "step1",
            directive: "Test step",
            completionCondition: "Done",
            connections: { success: "end" },
          },
          { type: "end", id: "end" },
        ],
      },
    });
    testWorkflowId = result.workflowId;
  });

  afterAll(async () => {
    await cleanup();
  });

  test("list tool returns formatted JSON", async () => {
    const rawResponse = await callMCPToolRaw(client, "list", {});

    // Verify JSON is formatted with 2-space indent
    expect(rawResponse).toContain("\n");
    expect(rawResponse).toMatch(/^\{\n {2}"/); // Starts with 2-space indent

    // Re-stringify should match original
    const parsed = JSON.parse(rawResponse);
    const reformatted = JSON.stringify(parsed, null, 2);
    expect(rawResponse).toBe(reformatted);
  });

  test("manage(get) tool returns formatted JSON", async () => {
    // Use test workflow created in beforeAll
    const rawResponse = await callMCPToolRaw(client, "manage", {
      action: "get",
      workflowId: testWorkflowId,
      includeNodes: false,
    });

    // Verify JSON is formatted
    expect(rawResponse).toContain("\n");
    expect(rawResponse).toMatch(/^\{\n {2}"/);

    const parsed = JSON.parse(rawResponse);
    const reformatted = JSON.stringify(parsed, null, 2);
    expect(rawResponse).toBe(reformatted);
  });

  test("settings(list) tool returns formatted JSON", async () => {
    const rawResponse = await callMCPToolRaw(client, "settings", {
      action: "list",
    });

    // Verify JSON is formatted
    expect(rawResponse).toContain("\n");

    const parsed = JSON.parse(rawResponse);
    const reformatted = JSON.stringify(parsed, null, 2);
    expect(rawResponse).toBe(reformatted);
  });

  test("session(user) returns formatted JSON", async () => {
    const rawResponse = await callMCPToolRaw(client, "session", {
      action: "user",
    });

    // Verify JSON is formatted
    expect(rawResponse).toContain("\n");

    const parsed = JSON.parse(rawResponse);
    const reformatted = JSON.stringify(parsed, null, 2);
    expect(rawResponse).toBe(reformatted);
  });

  test("manage(get-structure) returns formatted JSON", async () => {
    // Use test workflow created in beforeAll
    const rawResponse = await callMCPToolRaw(client, "manage", {
      action: "get-structure",
      workflowId: testWorkflowId,
    });

    // Verify JSON is formatted
    expect(rawResponse).toContain("\n");
    expect(rawResponse).toMatch(/^\{\n {2}"/);

    const parsed = JSON.parse(rawResponse);
    const reformatted = JSON.stringify(parsed, null, 2);
    expect(rawResponse).toBe(reformatted);
  });
});
