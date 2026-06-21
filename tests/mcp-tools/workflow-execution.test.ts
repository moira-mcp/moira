/**
 * MCP E2E Tests - Workflow Execution
 * Tests: start_workflow, execute_step, get_current_step
 */

import { describe, test, expect, beforeAll, afterAll } from "@jest/globals";
import { createAuthenticatedMCPClient, callMCPTool } from "../utils/mcp-auth.js";
import { MCP_TEST_WORKFLOWS } from "../fixtures/mcp-workflows.js";
import { MCP_TEST_DATA } from "../fixtures/mcp-test-data.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

const { SIMPLE_LINEAR, WITH_CONDITION, CONTEXT_PRESERVATION, MULTI_STEP } = MCP_TEST_WORKFLOWS;
const { EXECUTION_INPUTS, EXPECTED_VALUES } = MCP_TEST_DATA;

describe("MCP Workflow Execution Tools E2E", () => {
  let client: Client;
  let cleanup: () => Promise<void>;
  const createdWorkflows: string[] = [];

  // Store workflow IDs dynamically assigned by the server
  const workflowIds: Record<string, string> = {};

  beforeAll(async () => {
    const mcpClient = await createAuthenticatedMCPClient();
    client = mcpClient.client;
    cleanup = mcpClient.cleanup;

    // Create test workflows and capture their assigned IDs
    const workflowsToCreate = [
      { key: "SIMPLE_LINEAR", workflow: SIMPLE_LINEAR.workflow },
      { key: "WITH_CONDITION", workflow: WITH_CONDITION.workflow },
      { key: "CONTEXT_PRESERVATION", workflow: CONTEXT_PRESERVATION.workflow },
      { key: "MULTI_STEP", workflow: MULTI_STEP.workflow },
    ];

    for (const { key, workflow } of workflowsToCreate) {
      // Remove the id from the workflow object - server will generate UUID
      const { id: _removed, ...workflowWithoutId } = workflow as { id?: string } & Record<
        string,
        unknown
      >;
      const createResult = await callMCPTool<{ workflowId: string }>(client, "manage", {
        action: "create",
        workflow: workflowWithoutId,
      });
      workflowIds[key] = createResult.workflowId;
      createdWorkflows.push(createResult.workflowId);
    }
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

  test("start_workflow creates new execution", async () => {
    const result = await callMCPTool<string>(client, "start", {
      parentExecutionId: "none",
      workflowId: workflowIds.SIMPLE_LINEAR,
    });

    // start_workflow returns formatted text with process info
    expect(typeof result).toBe("string");
    expect(result).toContain("Process ID:");
    expect(result).toContain("Your next task:");
    expect(result).toContain("Success criteria:");
    expect(result).toContain("Input Schema:");

    // Extract process ID from response
    const processIdMatch = result.match(/Process ID: ([a-f0-9-]+)/);
    expect(processIdMatch).toBeDefined();

    console.log(`✓ Started execution: ${processIdMatch![1]}`);
  });

  test("execute_step advances workflow execution", async () => {
    // Start execution
    const startResult = await callMCPTool<string>(client, "start", {
      parentExecutionId: "none",
      workflowId: workflowIds.SIMPLE_LINEAR,
    });

    // Extract process ID
    const processIdMatch = startResult.match(/Process ID: ([a-f0-9-]+)/);
    expect(processIdMatch).toBeDefined();
    const processId = processIdMatch![1];

    // Execute step1
    const step1Result = await callMCPTool<string>(client, "step", {
      processId,
      input: EXECUTION_INPUTS.STEP1_SIMPLE,
    });

    // Should advance to step2
    expect(typeof step1Result).toBe("string");
    expect(step1Result).toContain("Your next task:");
    expect(step1Result).toContain("Complete step 2");

    // Execute step2
    const step2Result = await callMCPTool<string>(client, "step", {
      processId,
      input: EXECUTION_INPUTS.STEP2_SIMPLE,
    });

    // Should reach end
    expect(step2Result).toContain("Workflow completed");

    console.log(`✓ Execution completed: ${processId}`);
  });

  test("get_current_step returns current execution state", async () => {
    // Start execution
    const startResult = await callMCPTool<string>(client, "start", {
      parentExecutionId: "none",
      workflowId: workflowIds.SIMPLE_LINEAR,
    });

    const processIdMatch = startResult.match(/Process ID: ([a-f0-9-]+)/);
    const processId = processIdMatch![1];

    // Get current step
    const currentStep = await callMCPTool<string>(client, "session", {
      action: "current_step",
      executionId: processId,
    });

    // Should return step1 info
    expect(typeof currentStep).toBe("string");
    expect(currentStep).toContain("Your next task:");
    expect(currentStep).toContain("Complete step 1");

    // Execute one step
    await callMCPTool(client, "step", {
      processId,
      input: EXECUTION_INPUTS.STEP1_SIMPLE,
    });

    // Get current step again
    const afterStep1 = await callMCPTool<string>(client, "session", {
      action: "current_step",
      executionId: processId,
    });

    expect(afterStep1).toContain("Complete step 2");
  });

  test("execute_step validates input schema", async () => {
    // Start execution
    const startResult = await callMCPTool<string>(client, "start", {
      parentExecutionId: "none",
      workflowId: workflowIds.SIMPLE_LINEAR,
    });

    const processIdMatch = startResult.match(/Process ID: ([a-f0-9-]+)/);
    const processId = processIdMatch![1];

    // Try to execute with invalid input (missing required field)
    const result = await callMCPTool<string>(client, "step", {
      processId,
      input: EXECUTION_INPUTS.INVALID_MISSING_REQUIRED,
    });

    // Should return error message about validation
    expect(result.toLowerCase()).toMatch(/validation|required|schema|invalid/);
  });

  test("workflow execution preserves context variables", async () => {
    // Start execution
    const startResult = await callMCPTool<string>(client, "start", {
      parentExecutionId: "none",
      workflowId: workflowIds.CONTEXT_PRESERVATION,
    });

    const processIdMatch = startResult.match(/Process ID: ([a-f0-9-]+)/);
    const processId = processIdMatch![1];

    // Execute with new data
    await callMCPTool(client, "step", {
      processId,
      input: EXECUTION_INPUTS.CONTEXT_DATA,
    });

    // Check execution context
    const context = await callMCPTool(client, "session", {
      action: "execution_context",
      executionId: processId,
    });

    // get_execution_context returns {executionId, workflowId, context: {variables}}
    expect(context.context.variables).toHaveProperty(
      "sharedValue",
      EXPECTED_VALUES.SHARED_VALUE_FROM_START,
    );
    expect(context.context.variables).toHaveProperty(
      "newValue",
      EXECUTION_INPUTS.CONTEXT_DATA.newValue,
    );
    expect(context.context.variables).toHaveProperty(
      "incrementedCounter",
      EXECUTION_INPUTS.CONTEXT_DATA.incrementedCounter,
    );

    console.log("✓ Context variables preserved across steps");
  });

  test("workflow with condition node branches correctly", async () => {
    // Test TRUE path
    const trueExecution = await callMCPTool<string>(client, "start", {
      parentExecutionId: "none",
      workflowId: workflowIds.WITH_CONDITION,
    });

    const trueProcessId = trueExecution.match(/Process ID: ([a-f0-9-]+)/)![1];

    // Execute setup node with testValue='yes' for TRUE path
    await callMCPTool(client, "step", {
      processId: trueProcessId,
      input: { testValue: "yes" },
    });

    // Get current step - should have evaluated condition and be at true path
    const trueStep = await callMCPTool<string>(client, "session", {
      action: "current_step",
      executionId: trueProcessId,
    });

    expect(trueStep).toContain("True path execution");

    // Test FALSE path
    const falseExecution = await callMCPTool<string>(client, "start", {
      parentExecutionId: "none",
      workflowId: workflowIds.WITH_CONDITION,
    });

    const falseProcessId = falseExecution.match(/Process ID: ([a-f0-9-]+)/)![1];

    // Execute setup node with testValue='no' for FALSE path
    await callMCPTool(client, "step", {
      processId: falseProcessId,
      input: { testValue: "no" },
    });

    const falseStep = await callMCPTool<string>(client, "session", {
      action: "current_step",
      executionId: falseProcessId,
    });

    expect(falseStep).toContain("False path execution");

    console.log("✓ Condition node branching works correctly");
  });

  test("multiple concurrent executions of same workflow", async () => {
    // Start 3 executions
    const exec1 = await callMCPTool<string>(client, "start", {
      parentExecutionId: "none",
      workflowId: workflowIds.SIMPLE_LINEAR,
    });

    const exec2 = await callMCPTool<string>(client, "start", {
      parentExecutionId: "none",
      workflowId: workflowIds.SIMPLE_LINEAR,
    });

    const exec3 = await callMCPTool<string>(client, "start", {
      parentExecutionId: "none",
      workflowId: workflowIds.SIMPLE_LINEAR,
    });

    // Extract process IDs (with null checks for concurrent execution reliability)
    const match1 = exec1.match(/Process ID: ([a-f0-9-]+)/);
    const match2 = exec2.match(/Process ID: ([a-f0-9-]+)/);
    const match3 = exec3.match(/Process ID: ([a-f0-9-]+)/);
    expect(match1).not.toBeNull();
    expect(match2).not.toBeNull();
    expect(match3).not.toBeNull();
    const pid1 = match1![1];
    const pid2 = match2![1];
    const pid3 = match3![1];

    // All should have unique process IDs
    expect(pid1).not.toBe(pid2);
    expect(pid2).not.toBe(pid3);
    expect(pid1).not.toBe(pid3);

    // Execute one independently
    await callMCPTool(client, "step", {
      processId: pid1,
      input: EXECUTION_INPUTS.STEP1_SIMPLE,
    });

    // exec2 should still be at step1
    const exec2State = await callMCPTool<string>(client, "session", {
      action: "current_step",
      executionId: pid2,
    });

    expect(exec2State).toContain("Complete step 1");

    console.log("✓ Multiple concurrent executions work independently");
  });

  test("multi-step workflow executes sequentially", async () => {
    const startResult = await callMCPTool<string>(client, "start", {
      parentExecutionId: "none",
      workflowId: workflowIds.MULTI_STEP,
    });

    const processId = startResult.match(/Process ID: ([a-f0-9-]+)/)![1];

    // Execute all 5 steps
    for (let i = 1; i <= 5; i++) {
      const currentStep = await callMCPTool<string>(client, "session", {
        action: "current_step",
        executionId: processId,
      });

      expect(currentStep).toContain(`Complete step ${i}`);

      const stepResult = await callMCPTool(client, "step", {
        processId,
        input: { result: `Step ${i} done` },
      });

      // Last step should complete workflow
      if (i === 5) {
        expect(stepResult).toContain("Workflow completed");
      }
    }

    console.log("✓ Multi-step workflow executed sequentially");
  });
});
