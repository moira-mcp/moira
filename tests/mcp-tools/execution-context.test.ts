/**
 * MCP E2E Tests - Execution Context Tools
 * Tests: get_execution_context
 */

import { describe, test, expect, beforeAll, afterAll } from "@jest/globals";
import {
  createAuthenticatedMCPClient,
  callMCPTool,
  startWorkflowExecutionState,
} from "../utils/mcp-auth.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

describe("MCP Execution Context Tools E2E", () => {
  let client: Client;
  let cleanup: () => Promise<void>;
  let testWorkflowId: string;
  let testExecutionId: string;

  beforeAll(async () => {
    const mcpClient = await createAuthenticatedMCPClient();
    client = mcpClient.client;
    cleanup = mcpClient.cleanup;

    // Dedicated workflow that pauses on an agent-directive, so the execution stays inspectable
    const created = await callMCPTool(client, "manage", {
      action: "create",
      workflow: {
        metadata: {
          name: "Execution Context Source",
          version: "1.0.0",
          description: "Workflow for the execution_context test",
        },
        nodes: [
          { type: "start", id: "start", connections: { default: "step" } },
          {
            type: "agent-directive",
            id: "step",
            directive: "Report back",
            completionCondition: "Reported",
            inputSchema: {
              type: "object",
              properties: { result: { type: "string" } },
              required: ["result"],
            },
            connections: { success: "end" },
          },
          { type: "end", id: "end" },
        ],
      },
    });
    expect(created).toHaveProperty("success", true);
    testWorkflowId = created.workflowId;

    const execution = await startWorkflowExecutionState(client, testWorkflowId);
    testExecutionId = execution.processId;
  });

  afterAll(async () => {
    await cleanup();
  });

  test("get_execution_context returns execution state", async () => {
    const context = await callMCPTool(client, "session", {
      action: "execution_context",
      executionId: testExecutionId,
    });

    expect(context).toHaveProperty("executionId", testExecutionId);
    expect(context).toHaveProperty("workflowId", testWorkflowId);
    expect(context).toHaveProperty("status");
    expect(context).toHaveProperty("context");

    expect(context.context).toHaveProperty("variables");
  });
});
