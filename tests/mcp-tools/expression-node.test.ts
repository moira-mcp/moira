/**
 * MCP E2E Tests - Expression Node
 * Tests expression node execution through MCP workflow
 */

import { describe, test, expect, beforeAll, afterAll } from "@jest/globals";
import { createAuthenticatedMCPClient, callMCPTool } from "../utils/mcp-auth.js";
import { MCP_TEST_WORKFLOWS } from "../fixtures/mcp-workflows.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

const { WITH_EXPRESSION, EXPRESSION_CHAIN, EXPRESSION_WITH_NESTED_PATH } = MCP_TEST_WORKFLOWS;

describe("MCP Expression Node E2E", () => {
  let client: Client;
  let cleanup: () => Promise<void>;
  const createdWorkflows: string[] = [];

  // Mapping from fixture key to actual workflow ID
  let withExpressionId: string;
  let expressionChainId: string;
  let expressionNestedId: string;

  beforeAll(async () => {
    const mcpClient = await createAuthenticatedMCPClient();
    client = mcpClient.client;
    cleanup = mcpClient.cleanup;

    // Create test workflows and capture returned IDs
    // Helper to create workflow without hardcoded id
    const createWorkflow = async (workflow: {
      id: string;
      metadata: object;
      nodes: readonly unknown[];
    }) => {
      const { id: _id, ...workflowWithoutId } = workflow;
      const result = await callMCPTool<{ workflowId: string }>(client, "manage", {
        action: "create",
        workflow: workflowWithoutId,
      });
      return result.workflowId;
    };

    withExpressionId = await createWorkflow(WITH_EXPRESSION.workflow);
    createdWorkflows.push(withExpressionId);

    expressionChainId = await createWorkflow(EXPRESSION_CHAIN.workflow);
    createdWorkflows.push(expressionChainId);

    expressionNestedId = await createWorkflow(EXPRESSION_WITH_NESTED_PATH.workflow);
    createdWorkflows.push(expressionNestedId);
  });

  afterAll(async () => {
    // Cleanup all created workflows
    for (const workflowId of createdWorkflows) {
      try {
        await callMCPTool(client, "manage", { workflowId });
      } catch (e) {
        // Ignore cleanup errors
      }
    }
    await cleanup();
  });

  test("expression node evaluates arithmetic and updates context", async () => {
    // Start workflow with expression node
    const startResult = await callMCPTool<string>(client, "start", {
      parentExecutionId: "none",
      workflowId: withExpressionId,
    });

    // Extract process ID
    const processIdMatch = startResult.match(/Process ID: ([a-f0-9-]+)/);
    expect(processIdMatch).toBeDefined();
    const processId = processIdMatch![1];

    // Expression node should have already executed (auto-advance)
    // Now we should be at the 'verify' agent-directive node
    // The directive should contain the computed values from expression
    expect(startResult).toContain("Counter is now 1"); // counter = counter + 1 (0+1=1)
    expect(startResult).toContain("result is 3"); // result = counter * multiplier (1*3=3)

    console.log(`✓ Expression node evaluated: counter=1, result=3`);
  });

  test("expression node results available in context", async () => {
    // Start workflow
    const startResult = await callMCPTool<string>(client, "start", {
      parentExecutionId: "none",
      workflowId: withExpressionId,
    });

    const processIdMatch = startResult.match(/Process ID: ([a-f0-9-]+)/);
    const processId = processIdMatch![1];

    // Check execution context contains expression results
    const context = await callMCPTool(client, "session", {
      action: "execution_context",
      executionId: processId,
    });

    // Verify expression results in context
    expect(context.context.variables).toHaveProperty("counter", 1);
    expect(context.context.variables).toHaveProperty("result", 3);
    expect(context.context.variables).toHaveProperty("multiplier", 3); // from initialData

    console.log("✓ Expression results stored in context");
  });

  test("multiple expression nodes chain correctly", async () => {
    // Start workflow with chain of expression nodes
    const startResult = await callMCPTool<string>(client, "start", {
      parentExecutionId: "none",
      workflowId: expressionChainId,
    });

    const processIdMatch = startResult.match(/Process ID: ([a-f0-9-]+)/);
    const processId = processIdMatch![1];

    // All expression nodes should have executed
    // Final values: step_index=2, iteration=1
    // init: step_index=1, iteration=1
    // increment: iteration=2
    // advance: step_index=2, iteration=1 (reset)
    expect(startResult).toContain("step_index=2");
    expect(startResult).toContain("iteration=1");

    // Verify in context
    const context = await callMCPTool(client, "session", {
      action: "execution_context",
      executionId: processId,
    });

    expect(context.context.variables).toHaveProperty("step_index", 2);
    expect(context.context.variables).toHaveProperty("iteration", 1);

    console.log("✓ Expression chain executed: step_index=2, iteration=1");
  });

  test("expression node handles nested context paths", async () => {
    // Start workflow with nested path expression
    const startResult = await callMCPTool<string>(client, "start", {
      parentExecutionId: "none",
      workflowId: expressionNestedId,
    });

    const processIdMatch = startResult.match(/Process ID: ([a-f0-9-]+)/);
    const processId = processIdMatch![1];

    // Expression: next_step = plan.current_step + 1 (5 + 1 = 6)
    expect(startResult).toContain("next_step=6");

    // Verify in context
    const context = await callMCPTool(client, "session", {
      action: "execution_context",
      executionId: processId,
    });

    expect(context.context.variables).toHaveProperty("next_step", 6);
    expect(context.context.variables.plan).toEqual({
      current_step: 5,
      total_steps: 10,
    });

    console.log("✓ Nested path expression evaluated: next_step=6");
  });

  test("expression node workflow completes successfully", async () => {
    // Start workflow
    const startResult = await callMCPTool<string>(client, "start", {
      parentExecutionId: "none",
      workflowId: withExpressionId,
    });

    const processIdMatch = startResult.match(/Process ID: ([a-f0-9-]+)/);
    const processId = processIdMatch![1];

    // Execute the verify step
    const stepResult = await callMCPTool<string>(client, "step", {
      processId,
      input: { confirmation: "counter=1, result=3" },
    });

    // Should complete workflow
    expect(stepResult).toContain("Workflow completed");

    console.log("✓ Expression node workflow completed successfully");
  });
});
