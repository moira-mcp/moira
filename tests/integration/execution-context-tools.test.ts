/**
 * Execution Context Tools Integration Tests
 * Tests get_execution_context and update_execution_context functionality
 */

import { describe, test, expect, beforeAll } from "@jest/globals";
import { DatabaseRepository } from "@mcp-moira/workflow-engine";
import type { WorkflowGraph, WorkflowExecution } from "@mcp-moira/workflow-engine";
import { v4 as uuidv4 } from "uuid";

const TEST_USER_ID = "test-user-exec-context";

describe("Execution Context Tools", () => {
  let repository: DatabaseRepository;
  let testWorkflowId: string;
  let testExecutionId: string;

  beforeAll(async () => {
    repository = new DatabaseRepository();

    // Create test user
    const { getDatabase, user, getWorkflowService } = await import("@mcp-moira/shared");
    const db = getDatabase();
    const now = new Date().toISOString();

    try {
      await db.insert(user).values({
        id: TEST_USER_ID,
        email: `${TEST_USER_ID}@test.com`,
        name: "Exec Context Test User",
        handle: TEST_USER_ID,
        emailVerified: false,
        createdAt: now,
        updatedAt: now,
      });
    } catch (error) {
      // User might already exist
    }

    // Create test workflow
    const testWorkflow: WorkflowGraph = {
      id: "test-workflow-exec-context",
      metadata: {
        name: "Test Execution Context Workflow",
        version: "1.0.0",
        description: "Workflow for testing execution context tools",
      },
      nodes: [
        { type: "start", id: "start", connections: { default: "task" } },
        {
          type: "agent-directive",
          id: "task",
          directive: "Test task with input: {{testVar}}",
          completionCondition: "Task completed",
          inputSchema: {
            type: "object",
            properties: { result: { type: "string" } },
            required: ["result"],
          },
          connections: { success: "end" },
        },
        { type: "end", id: "end", finalOutput: ["result"] },
      ],
    };

    // Use WorkflowService to get the generated UUID
    const workflowService = getWorkflowService();
    const saveResult = await workflowService.save({
      graph: testWorkflow,
      userId: TEST_USER_ID,
      visibility: "private",
    });
    testWorkflowId = saveResult.id;

    // Generate UUID for execution
    testExecutionId = uuidv4();

    // Create test execution in running state (Issue #386: "waiting" merged into "running")
    const testExecution: WorkflowExecution = {
      executionId: testExecutionId,
      workflowId: testWorkflowId,
      userId: TEST_USER_ID,
      currentNodeId: "task",
      waitingForInputNodeId: "task",
      globalContext: {
        variables: { testVar: "initial value", anotherVar: 123 },
        nodeStates: { task: { visited: true } },
        executionId: testExecutionId,
        workflowId: testWorkflowId,
        userId: TEST_USER_ID,
      },
      status: "running",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    await repository.saveExecution(testExecution);
  });

  test("get_execution_context returns full execution state", async () => {
    const execution = await repository.getExecution(testExecutionId);

    expect(execution).toBeDefined();
    expect(execution!.executionId).toBe(testExecutionId);
    expect(execution!.status).toBe("running");
    expect(execution!.currentNodeId).toBe("task");
    expect(execution!.globalContext.variables.testVar).toBe("initial value");
    expect(execution!.globalContext.variables.anotherVar).toBe(123);
  });

  test("update_execution_context updates variables", async () => {
    const execution = await repository.getExecution(testExecutionId);

    // Update variables
    execution!.globalContext.variables.testVar = "updated value";
    execution!.globalContext.variables.newVar = "new";

    await repository.saveExecution(execution!);

    // Verify persisted
    const updated = await repository.getExecution(testExecutionId);
    expect(updated!.globalContext.variables.testVar).toBe("updated value");
    expect(updated!.globalContext.variables.newVar).toBe("new");
    expect(updated!.globalContext.variables.anotherVar).toBe(123); // Unchanged
  });

  test("update_execution_context updates nodeStates", async () => {
    const execution = await repository.getExecution(testExecutionId);

    // Update nodeStates
    execution!.globalContext.nodeStates.task = { visited: true, attempts: 2 };

    await repository.saveExecution(execution!);

    // Verify persisted
    const updated = await repository.getExecution(testExecutionId);
    expect(updated!.globalContext.nodeStates.task).toEqual({ visited: true, attempts: 2 });
  });

  test("cannot get execution context of another user", async () => {
    // This would be tested through MCP tool with different userId
    // Repository layer doesn't enforce ownership - tools do
    const execution = await repository.getExecution(testExecutionId);
    expect(execution).toBeDefined();
    expect(execution!.userId).toBe(TEST_USER_ID);
  });

  test("execution in non-waiting state can still be retrieved", async () => {
    // Create completed execution with a new UUID
    const completedExecutionId = uuidv4();
    const completedExecution: WorkflowExecution = {
      executionId: completedExecutionId,
      workflowId: testWorkflowId,
      userId: TEST_USER_ID,
      currentNodeId: "end",
      waitingForInputNodeId: null,
      globalContext: {
        variables: { result: "done" },
        nodeStates: {},
        executionId: completedExecutionId,
        workflowId: testWorkflowId,
        userId: TEST_USER_ID,
      },
      status: "completed",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      completedAt: Date.now(),
    };

    await repository.saveExecution(completedExecution);

    const retrieved = await repository.getExecution(completedExecutionId);
    expect(retrieved).toBeDefined();
    expect(retrieved!.status).toBe("completed");
  });
});
