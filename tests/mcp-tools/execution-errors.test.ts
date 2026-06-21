/**
 * MCP E2E Tests - Execution Errors Array
 * Tests: Issue #386 - errors array in execution context and list
 */

import { describe, test, expect, beforeAll, afterAll } from "@jest/globals";
import { createAuthenticatedMCPClient, callMCPTool } from "../utils/mcp-auth.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

describe("MCP Execution Errors Array E2E", () => {
  let client: Client;
  let cleanup: () => Promise<void>;
  let testExecutionId: string;
  let testWorkflowId: string;

  beforeAll(async () => {
    const mcpClient = await createAuthenticatedMCPClient();
    client = mcpClient.client;
    cleanup = mcpClient.cleanup;

    // Create a test workflow with input validation
    const createResult = await callMCPTool(client, "manage", {
      action: "create",
      workflow: {
        id: `test-errors-${Date.now()}`,
        metadata: {
          name: "Test Errors Workflow",
          version: "1.0.0",
          description: "Workflow for testing errors array",
        },
        nodes: [
          { type: "start", id: "start", connections: { default: "step1" } },
          {
            type: "agent-directive",
            id: "step1",
            directive: "Provide valid input",
            completionCondition: "Valid input received",
            inputSchema: {
              type: "object",
              properties: {
                requiredField: { type: "string" },
              },
              required: ["requiredField"],
            },
            connections: { success: "end" },
          },
          { type: "end", id: "end" },
        ],
      },
    });
    console.log("[Test] Create result:", JSON.stringify(createResult, null, 2));
    testWorkflowId = createResult.workflowId;
    console.log("[Test] testWorkflowId:", testWorkflowId);

    // Start the workflow
    const startResult = await callMCPTool(client, "start", {
      workflowId: testWorkflowId,
      parentExecutionId: "none",
    });
    console.log("[Test] Start result:", startResult);

    // Extract processId from text response (format: "Process ID: xxx\nYour next task: ...")
    const processIdMatch = startResult.match(/Process ID: ([a-f0-9-]+)/);
    expect(processIdMatch).toBeDefined();
    testExecutionId = processIdMatch![1];
    console.log("[Test] testExecutionId:", testExecutionId);
  });

  afterAll(async () => {
    await cleanup();
  });

  test("execution_context includes errors array (initially empty)", async () => {
    const context = await callMCPTool(client, "session", {
      action: "execution_context",
      executionId: testExecutionId,
    });

    expect(context).toHaveProperty("executionId", testExecutionId);
    expect(context).toHaveProperty("errors");
    // Initial state: no errors
    expect(Array.isArray(context.errors)).toBe(true);
    expect(context.errors.length).toBe(0);
  });

  test("validation error is added to errors array", async () => {
    // Send invalid input (missing required field)
    await callMCPTool(client, "step", {
      processId: testExecutionId,
      input: { wrongField: "value" },
    });

    // Check execution context for error
    const context = await callMCPTool(client, "session", {
      action: "execution_context",
      executionId: testExecutionId,
    });

    expect(context.errors).toBeDefined();
    expect(context.errors.length).toBeGreaterThan(0);

    const lastError = context.errors[context.errors.length - 1];
    expect(lastError).toHaveProperty("timestamp");
    expect(lastError).toHaveProperty("nodeId");
    expect(lastError).toHaveProperty("errorType", "validation");
    expect(lastError).toHaveProperty("message");
    // Check that sanitized input is included
    expect(lastError).toHaveProperty("input");
  });

  test("executions list includes errorCount", async () => {
    const result = await callMCPTool(client, "session", {
      action: "executions",
      status: ["running", "waiting", "completed"],
    });

    expect(result.executions).toBeDefined();
    expect(result.executions.length).toBeGreaterThan(0);

    // Find our test execution
    const testExec = result.executions.find(
      (e: { executionId: string }) => e.executionId === testExecutionId,
    );
    expect(testExec).toBeDefined();
    expect(testExec).toHaveProperty("errorCount");
    expect(testExec.errorCount).toBeGreaterThanOrEqual(1);
  });

  test("multiple errors accumulate in errors array", async () => {
    // Get current error count
    const contextBefore = await callMCPTool(client, "session", {
      action: "execution_context",
      executionId: testExecutionId,
    });
    const errorCountBefore = contextBefore.errors.length;

    // Send another invalid input
    await callMCPTool(client, "step", {
      processId: testExecutionId,
      input: { anotherWrongField: 123 },
    });

    // Check that error was added
    const contextAfter = await callMCPTool(client, "session", {
      action: "execution_context",
      executionId: testExecutionId,
    });

    expect(contextAfter.errors.length).toBe(errorCountBefore + 1);
  });

  test("status filter backward compatibility - waiting maps to running", async () => {
    // Old clients may send 'waiting' - should work due to backward compatibility
    const result = await callMCPTool(client, "session", {
      action: "executions",
      status: ["waiting"],
    });

    // Should return waiting executions (legacy behavior still works)
    expect(result.executions).toBeDefined();
    // Our test execution should be in waiting status
    const hasWaiting = result.executions.some(
      (e: { executionId: string }) => e.executionId === testExecutionId,
    );
    expect(hasWaiting).toBe(true);
  });
});
