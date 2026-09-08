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

type RunningExecution = {
  processId: string;
  attemptId: string;
  response: string;
};

function requiredId(response: string, label: "Process" | "Start attempt" | "Step attempt"): string {
  const id = response.match(new RegExp(`${label} ID:\\s*([a-f0-9-]+)`, "i"))?.[1];
  if (!id) throw new Error(`${label} ID missing from MCP response: ${response}`);
  return id;
}

async function startExecution(client: Client, workflowId: string): Promise<RunningExecution> {
  const preparation = await callMCPTool<string>(client, "start", {
    action: "prepare",
    parentExecutionId: "none",
    workflowId,
  });
  const response = await callMCPTool<string>(client, "start", {
    action: "execute",
    startAttemptId: requiredId(preparation, "Start attempt"),
  });
  return {
    processId: requiredId(response, "Process"),
    attemptId: requiredId(response, "Step attempt"),
    response,
  };
}

async function advanceExecution(
  client: Client,
  execution: RunningExecution,
  input: unknown,
): Promise<string> {
  const response = await callMCPTool<string>(client, "step", {
    processId: execution.processId,
    attemptId: execution.attemptId,
    input,
  });
  const nextAttempt = response.match(/Step attempt ID:\s*([a-f0-9-]+)/i)?.[1];
  if (nextAttempt) execution.attemptId = nextAttempt;
  execution.response = response;
  return response;
}

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
    const execution = await startExecution(client, workflowIds.SIMPLE_LINEAR);
    const result = execution.response;

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
    const execution = await startExecution(client, workflowIds.SIMPLE_LINEAR);
    const processId = execution.processId;

    // Execute step1
    const step1Result = await advanceExecution(client, execution, EXECUTION_INPUTS.STEP1_SIMPLE);

    // Should advance to step2
    expect(typeof step1Result).toBe("string");
    expect(step1Result).toContain("Your next task:");
    expect(step1Result).toContain("Complete step 2");

    // Execute step2
    const step2Result = await advanceExecution(client, execution, EXECUTION_INPUTS.STEP2_SIMPLE);

    // Should reach end
    expect(step2Result).toContain("Workflow completed");

    console.log(`✓ Execution completed: ${processId}`);
  });

  test("get_current_step returns current execution state", async () => {
    const execution = await startExecution(client, workflowIds.SIMPLE_LINEAR);
    const processId = execution.processId;

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
    await advanceExecution(client, execution, EXECUTION_INPUTS.STEP1_SIMPLE);

    // Get current step again
    const afterStep1 = await callMCPTool<string>(client, "session", {
      action: "current_step",
      executionId: processId,
    });

    expect(afterStep1).toContain("Complete step 2");
  });

  test("execute_step validates input schema", async () => {
    const execution = await startExecution(client, workflowIds.SIMPLE_LINEAR);

    // Try to execute with invalid input (missing required field)
    const result = await advanceExecution(
      client,
      execution,
      EXECUTION_INPUTS.INVALID_MISSING_REQUIRED,
    );

    // Invalid node input intentionally pauses with repair guidance.
    expect(result.toLowerCase()).toMatch(/validation|required|schema|invalid/);
  });

  test("execute_step marks missing-execution failures as MCP errors", async () => {
    const result = await client.callTool({
      name: "step",
      arguments: {
        processId: "00000000-0000-4000-8000-000000000000",
        attemptId: "00000000-0000-4000-8000-000000000001",
      },
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]).toMatchObject({ type: "text" });
    const text = (result.content[0] as { type: "text"; text: string }).text;
    expect(text.toLowerCase()).toMatch(/not found|expired|process/);
  });

  test("workflow execution preserves context variables", async () => {
    const execution = await startExecution(client, workflowIds.CONTEXT_PRESERVATION);
    const processId = execution.processId;

    // Execute with new data
    await advanceExecution(client, execution, EXECUTION_INPUTS.CONTEXT_DATA);

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
    const trueExecution = await startExecution(client, workflowIds.WITH_CONDITION);
    const trueProcessId = trueExecution.processId;

    // Execute setup node with testValue='yes' for TRUE path
    await advanceExecution(client, trueExecution, { testValue: "yes" });

    // Get current step - should have evaluated condition and be at true path
    const trueStep = await callMCPTool<string>(client, "session", {
      action: "current_step",
      executionId: trueProcessId,
    });

    expect(trueStep).toContain("True path execution");

    // Test FALSE path
    const falseExecution = await startExecution(client, workflowIds.WITH_CONDITION);
    const falseProcessId = falseExecution.processId;

    // Execute setup node with testValue='no' for FALSE path
    await advanceExecution(client, falseExecution, { testValue: "no" });

    const falseStep = await callMCPTool<string>(client, "session", {
      action: "current_step",
      executionId: falseProcessId,
    });

    expect(falseStep).toContain("False path execution");

    console.log("✓ Condition node branching works correctly");
  });

  test("multiple concurrent executions of same workflow", async () => {
    // Start 3 executions
    const [exec1, exec2, exec3] = await Promise.all([
      startExecution(client, workflowIds.SIMPLE_LINEAR),
      startExecution(client, workflowIds.SIMPLE_LINEAR),
      startExecution(client, workflowIds.SIMPLE_LINEAR),
    ]);
    const pid1 = exec1.processId;
    const pid2 = exec2.processId;
    const pid3 = exec3.processId;

    // All should have unique process IDs
    expect(pid1).not.toBe(pid2);
    expect(pid2).not.toBe(pid3);
    expect(pid1).not.toBe(pid3);

    // Execute one independently
    await advanceExecution(client, exec1, EXECUTION_INPUTS.STEP1_SIMPLE);

    // exec2 should still be at step1
    const exec2State = await callMCPTool<string>(client, "session", {
      action: "current_step",
      executionId: pid2,
    });

    expect(exec2State).toContain("Complete step 1");

    console.log("✓ Multiple concurrent executions work independently");
  });

  test("multi-step workflow executes sequentially", async () => {
    const execution = await startExecution(client, workflowIds.MULTI_STEP);
    const processId = execution.processId;

    // Execute all 5 steps
    for (let i = 1; i <= 5; i++) {
      const currentStep = await callMCPTool<string>(client, "session", {
        action: "current_step",
        executionId: processId,
      });

      expect(currentStep).toContain(`Complete step ${i}`);

      execution.attemptId = requiredId(currentStep, "Step attempt");
      const stepResult = await advanceExecution(client, execution, { result: `Step ${i} done` });

      // Last step should complete workflow
      if (i === 5) {
        expect(stepResult).toContain("Workflow completed");
      }
    }

    console.log("✓ Multi-step workflow executed sequentially");
  });
});
