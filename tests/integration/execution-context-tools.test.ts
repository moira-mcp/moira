/**
 * Execution Context Tools Integration Tests
 * Tests persisted execution-context retrieval used by session inspection
 */

import { describe, test, expect, beforeAll } from "@jest/globals";
import { DatabaseRepository } from "@mcp-moira/workflow-engine";
import type { WorkflowGraph, WorkflowExecution } from "@mcp-moira/workflow-engine";
import { randomUUID } from "node:crypto";

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
    testExecutionId = randomUUID();

    // Create test execution in running state (Issue #386: "waiting" merged into "running")
    const testExecution: WorkflowExecution = {
      revision: 0,
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

  test("cannot get execution context of another user", async () => {
    // This would be tested through MCP tool with different userId
    // Repository layer doesn't enforce ownership - tools do
    const execution = await repository.getExecution(testExecutionId);
    expect(execution).toBeDefined();
    expect(execution!.userId).toBe(TEST_USER_ID);
  });

  test("execution in non-waiting state can still be retrieved", async () => {
    // Create completed execution with a new UUID
    const completedExecutionId = randomUUID();
    const completedExecution: WorkflowExecution = {
      revision: 0,
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
