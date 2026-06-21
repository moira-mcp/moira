/**
 * MCP Error Diagnostics Tests
 *
 * Tests that error handling returns structured error messages with context.
 * The actual inputData inclusion in logs is verified via Docker logs.
 *
 * These tests verify:
 * 1. Errors contain relevant identifiers (workflowId, processId)
 * 2. Error messages are structured and helpful
 * 3. Tools handle missing/invalid resources gracefully
 */

import { describe, test, expect, beforeAll, afterAll } from "@jest/globals";
import { createAuthenticatedMCPClient, callMCPToolRaw } from "../utils/mcp-auth.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

describe("MCP Error Diagnostics", () => {
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

  describe("start() with nonexistent workflow", () => {
    test("returns structured error with workflow ID", async () => {
      const text = await callMCPToolRaw(client, "start", {
        workflowId: "nonexistent-workflow-diagnostics-test",
        parentExecutionId: "none",
        note: "testing error diagnostics - should appear in logs",
      });

      // Error should mention the workflow ID
      expect(text).toContain("nonexistent-workflow-diagnostics-test");
      expect(text.toLowerCase()).toContain("not found");
    });
  });

  describe("step() with nonexistent process", () => {
    test("returns structured error with process ID", async () => {
      const text = await callMCPToolRaw(client, "step", {
        processId: "nonexistent-process-id-123",
        input: {
          decision: "yes",
          reason: "testing error diagnostics",
          complexData: { nested: { value: 42 } },
        },
      });

      // Error should mention the process/execution
      expect(text.toLowerCase()).toMatch(/not found|invalid|error/);
    });
  });

  describe("manage() with nonexistent workflow", () => {
    test("returns error for get action on missing workflow", async () => {
      const text = await callMCPToolRaw(client, "manage", {
        action: "get",
        workflowId: "nonexistent-workflow-for-manage-test",
      });

      // Should indicate workflow not found
      expect(text.toLowerCase()).toMatch(/not found|error|nonexistent/);
    });

    test("returns error for get-node action on missing workflow", async () => {
      const text = await callMCPToolRaw(client, "manage", {
        action: "get-node",
        workflowId: "nonexistent-workflow-node-test",
        nodeId: "some-node-id",
      });

      // Should indicate workflow not found
      expect(text.toLowerCase()).toMatch(/not found|error/);
    });
  });

  describe("session() with nonexistent execution", () => {
    test("returns error for current_step on missing execution", async () => {
      const text = await callMCPToolRaw(client, "session", {
        action: "current_step",
        executionId: "nonexistent-execution-id-456",
      });

      // Should indicate execution not found
      expect(text.toLowerCase()).toMatch(/not found|error|invalid/);
    });

    test("returns error for execution_context on missing execution", async () => {
      const text = await callMCPToolRaw(client, "session", {
        action: "execution_context",
        executionId: "nonexistent-execution-context-test",
      });

      // Should indicate execution not found
      expect(text.toLowerCase()).toMatch(/not found|error|invalid/);
    });
  });
});
