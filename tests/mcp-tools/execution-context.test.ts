/**
 * MCP E2E Tests - Execution Context Tools
 * Tests: get_execution_context
 */

import { describe, test, expect, beforeAll, afterAll } from "@jest/globals";
import { createAuthenticatedMCPClient, callMCPTool } from "../utils/mcp-auth.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

describe("MCP Execution Context Tools E2E", () => {
  let client: Client;
  let cleanup: () => Promise<void>;
  let testExecutionId: string;

  beforeAll(async () => {
    const mcpClient = await createAuthenticatedMCPClient();
    client = mcpClient.client;
    cleanup = mcpClient.cleanup;

    // Start a test workflow to get execution
    const listResult = await callMCPTool(client, "list", {});
    const workflows = listResult.workflows || listResult;
    if (workflows && workflows.length > 0) {
      const startResult = await callMCPTool(client, "start", {
        workflowId: workflows[0].id,
        parentExecutionId: "none",
      });
      testExecutionId = startResult.processId;
    }
  });

  afterAll(async () => {
    await cleanup();
  });

  test("get_execution_context returns execution state", async () => {
    if (!testExecutionId) {
      console.warn("No execution available, skipping");
      return;
    }

    const context = await callMCPTool(client, "session", {
      action: "execution_context",
      executionId: testExecutionId,
    });

    expect(context).toHaveProperty("executionId", testExecutionId);
    expect(context).toHaveProperty("workflowId");
    expect(context).toHaveProperty("status");
    expect(context).toHaveProperty("context");

    expect(context.context).toHaveProperty("variables");
  });

  // test('update_execution_context modifies variables', async () => {
  //   if (!testExecutionId) {
  //     console.warn('No execution available, skipping');
  //     return;
  //   }
  //
  //   // Get current context
  //   const _beforeUpdate = await callMCPTool(client, 'get_execution_context', {
  //     executionId: testExecutionId
  //   });
  //
  //   // Update context variables
  //   const testVariable = { test_key: 'test_value_' + Date.now() };
  //
  //   const updateResult = await callMCPTool(client, 'update_execution_context', {
  //     executionId: testExecutionId,
  //     variables: testVariable
  //   });
  //
  //   expect(updateResult).toHaveProperty('success', true);
  //
  //   // Verify update persisted
  //   const afterUpdate = await callMCPTool(client, 'get_execution_context', {
  //     executionId: testExecutionId
  //   });
  //
  //   expect(afterUpdate.context.variables).toMatchObject(testVariable);
  // });
});
