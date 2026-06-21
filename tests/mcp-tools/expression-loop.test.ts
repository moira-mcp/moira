/**
 * MCP E2E Tests - Expression Loop
 * Tests expression node in loop with 5 iterations
 */

import { describe, test, expect, beforeAll, afterAll } from "@jest/globals";
import { createAuthenticatedMCPClient, callMCPTool } from "../utils/mcp-auth.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

/**
 * Minimal loop workflow to test expression node in loop.
 * Structure: start → expression → agent-directive → condition → (true: expression, false: end)
 *
 * CRITICAL: This tests the bug where agent-directive is skipped when
 * condition(true) → expression → agent-directive path is taken.
 */
const LOOP_WORKFLOW = {
  id: "mcp-test-expression-loop",
  workflow: {
    id: "mcp-test-expression-loop",
    metadata: {
      name: "MCP Test: Expression Loop",
      version: "2.0.0",
      description: "Minimal loop with 5 iterations - tests condition→expression→directive path",
    },
    variableRegistry: {
      iteration: { type: "number", description: "Current iteration (accumulator)", default: 0 },
      max_iterations: { type: "number", description: "Maximum iterations", default: 5 },
    },
    nodes: [
      {
        type: "start",
        id: "start",
        connections: { default: "increment" },
      },
      {
        type: "expression",
        id: "increment",
        expressions: ["iteration = iteration + 1"],
        connections: { default: "show-iteration" },
      },
      {
        type: "agent-directive",
        id: "show-iteration",
        directive: "Iteration {{iteration}} of {{max_iterations}}",
        completionCondition: "ok",
        inputSchema: {
          type: "string",
          const: "ok",
        },
        connections: { success: "check-loop" },
      },
      {
        type: "condition",
        id: "check-loop",
        condition: {
          operator: "lt",
          left: { contextPath: "iteration" },
          right: { contextPath: "max_iterations" },
        },
        connections: {
          true: "increment",
          false: "end",
        },
      },
      {
        type: "end",
        id: "end",
      },
    ],
  },
};

describe("MCP Expression Loop E2E", () => {
  let client: Client;
  let cleanup: () => Promise<void>;

  beforeAll(async () => {
    const mcpClient = await createAuthenticatedMCPClient();
    client = mcpClient.client;
    cleanup = mcpClient.cleanup;

    // Create test workflow
    await callMCPTool(client, "manage", {
      action: "create",
      workflow: LOOP_WORKFLOW.workflow,
      overwrite: true,
    });
  });

  afterAll(async () => {
    try {
      await callMCPTool(client, "manage", { workflowId: LOOP_WORKFLOW.id });
    } catch (e) {
      // Ignore cleanup errors
    }
    await cleanup();
  });

  test("expression loop executes exactly 5 iterations with stop on each", async () => {
    // Start workflow
    const startResult = await callMCPTool<string>(client, "start", {
      parentExecutionId: "none",
      workflowId: LOOP_WORKFLOW.id,
    });

    const processIdMatch = startResult.match(/Process ID: ([a-f0-9-]+)/);
    expect(processIdMatch).toBeDefined();
    const processId = processIdMatch![1];

    // Should start at iteration 1
    expect(startResult).toContain("Iteration 1 of 5");

    // Execute iterations 1-5, each should stop and show correct iteration number
    for (let expectedIteration = 1; expectedIteration <= 5; expectedIteration++) {
      // Check current context
      const context = await callMCPTool<{ context: { variables: { iteration: number } } }>(
        client,
        "session",
        {
          action: "execution_context",
          executionId: processId,
        },
      );

      expect(context.context.variables.iteration).toBe(expectedIteration);

      // Submit step - send JSON-encoded string to preserve string type through parseInputData
      const stepResult = await callMCPTool<string>(client, "step", {
        processId,
        input: '"ok"',
      });

      if (expectedIteration < 5) {
        // Should show next iteration (this is where the bug happens - workflow completes instead)
        expect(stepResult).toContain(`Iteration ${expectedIteration + 1} of 5`);
      } else {
        // Should complete workflow
        expect(stepResult).toContain("Workflow completed");
      }
    }

    // Verify final state
    const finalContext = await callMCPTool<{
      status: string;
      context: { variables: { iteration: number } };
    }>(client, "session", {
      action: "execution_context",
      executionId: processId,
    });

    expect(finalContext.status).toBe("completed");
    expect(finalContext.context.variables.iteration).toBe(5);
  });
});
