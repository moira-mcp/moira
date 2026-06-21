/**
 * Parent Execution Continuation Integration Tests
 * Tests the parentExecutionId functionality for linked workflow executions (#263)
 *
 * Covers:
 * - Starting workflow with parentExecutionId
 * - Continuation reminder in completion response
 * - Parent execution info persistence
 */

import { describe, test, expect, beforeEach, afterEach } from "@jest/globals";
import { UniversalGraphExecutor } from "../../packages/workflow-engine/src/core/universal-graph-executor.js";
import { InMemoryRepository } from "../../packages/workflow-engine/src/storage/in-memory-repository.js";
import { WorkflowGraph } from "../../packages/workflow-engine/src/interfaces/core-interfaces.js";
import { randomUUID } from "crypto";

const TEST_USER_ID = "test-user-parent-exec";

// Issue #369: All nodes that accept input MUST have inputSchema
const SIMPLE_RESULT_SCHEMA = {
  type: "object",
  properties: {
    result: { type: "string" },
  },
  additionalProperties: false,
};

async function createTestExecutor() {
  const repository = new InMemoryRepository();
  const executor = new UniversalGraphExecutor(repository);
  return { repository, executor };
}

describe("Parent Execution Continuation", () => {
  let repository: InMemoryRepository;
  let executor: UniversalGraphExecutor;

  beforeEach(async () => {
    const setup = await createTestExecutor();
    repository = setup.repository;
    executor = setup.executor;
  });

  afterEach(async () => {
    // Cleanup handled by in-memory repository going out of scope
  });

  test("should store parentExecutionId when starting workflow", async () => {
    const workflow: WorkflowGraph = {
      id: "test-child-workflow",
      metadata: {
        name: "Child Workflow",
        version: "1.0.0",
        description: "Test child workflow",
      },
      nodes: [
        {
          type: "start",
          id: "start",
          connections: { default: "task" },
        },
        {
          type: "agent-directive",
          id: "task",
          directive: "Do something",
          completionCondition: "Done",
          connections: { success: "end" },
        },
        {
          type: "end",
          id: "end",
        },
      ],
    };

    await repository.saveWorkflow(workflow, TEST_USER_ID);

    // Start workflow with parentExecutionId
    const parentId = randomUUID();
    const executionId = await executor.startWorkflow(
      workflow,
      undefined,
      TEST_USER_ID,
      "Child execution",
      parentId,
    );

    // Verify parentExecutionId is stored
    const execution = await executor.getExecutionState(executionId);
    expect(execution).not.toBeNull();
    expect(execution!.parentExecutionId).toBe(parentId);
  });

  test("should show continuation reminder when child workflow completes", async () => {
    const workflow: WorkflowGraph = {
      id: "test-simple-child",
      metadata: {
        name: "Simple Child",
        version: "1.0.0",
        description: "Simple workflow for completion test",
      },
      nodes: [
        {
          type: "start",
          id: "start",
          connections: { default: "task" },
        },
        {
          type: "agent-directive",
          id: "task",
          directive: "Complete this task",
          completionCondition: "Task done",
          inputSchema: SIMPLE_RESULT_SCHEMA,
          connections: { success: "end" },
        },
        {
          type: "end",
          id: "end",
        },
      ],
    };

    await repository.saveWorkflow(workflow, TEST_USER_ID);

    // Start as child workflow
    const parentId = randomUUID();
    const childId = await executor.startWorkflow(
      workflow,
      undefined,
      TEST_USER_ID,
      "Child execution",
      parentId,
    );

    // Execute to get to waiting state
    await executor.executeStep(childId);

    // Complete the task (moves to end node which completes workflow)
    const completionResponse = await executor.executeStep(childId, { result: "done" });

    // Verify continuation reminder is in response
    expect(completionResponse).toContain("CONTINUATION REMINDER");
    expect(completionResponse).toContain("Parent execution awaits continuation");
    expect(completionResponse).toContain(parentId);
    expect(completionResponse).toContain(`step(processId: "${parentId}")`);
  });

  test("should NOT show continuation reminder when workflow has no parent", async () => {
    const workflow: WorkflowGraph = {
      id: "test-standalone",
      metadata: {
        name: "Standalone Workflow",
        version: "1.0.0",
        description: "Workflow without parent",
      },
      nodes: [
        {
          type: "start",
          id: "start",
          connections: { default: "task" },
        },
        {
          type: "agent-directive",
          id: "task",
          directive: "Complete this",
          completionCondition: "Done",
          inputSchema: SIMPLE_RESULT_SCHEMA,
          connections: { success: "end" },
        },
        {
          type: "end",
          id: "end",
        },
      ],
    };

    await repository.saveWorkflow(workflow, TEST_USER_ID);

    // Start WITHOUT parentExecutionId
    const executionId = await executor.startWorkflow(
      workflow,
      undefined,
      TEST_USER_ID,
      "Standalone execution",
    );

    // Execute to completion
    await executor.executeStep(executionId);
    const completionResponse = await executor.executeStep(executionId, { result: "done" });

    // Verify NO continuation reminder
    expect(completionResponse).toContain("Workflow completed successfully");
    expect(completionResponse).not.toContain("CONTINUATION REMINDER");
    expect(completionResponse).not.toContain("Parent execution");
  });

  test("should store null parentExecutionId when not provided", async () => {
    const workflow: WorkflowGraph = {
      id: "test-no-parent",
      metadata: {
        name: "No Parent Workflow",
        version: "1.0.0",
        description: "Test workflow without parent",
      },
      nodes: [
        {
          type: "start",
          id: "start",
          connections: { default: "end" },
        },
        {
          type: "end",
          id: "end",
        },
      ],
    };

    await repository.saveWorkflow(workflow, TEST_USER_ID);

    // Start without parentExecutionId
    const executionId = await executor.startWorkflow(
      workflow,
      undefined,
      TEST_USER_ID,
      "Test note",
    );

    const execution = await executor.getExecutionState(executionId);
    expect(execution).not.toBeNull();
    expect(execution!.parentExecutionId).toBeNull();
  });

  test("should link parent and child executions for full cycle", async () => {
    // Create parent workflow
    const parentWorkflow: WorkflowGraph = {
      id: "test-parent-workflow",
      metadata: {
        name: "Parent Workflow",
        version: "1.0.0",
        description: "Parent workflow for cycle test",
      },
      nodes: [
        {
          type: "start",
          id: "start",
          connections: { default: "step1" },
        },
        {
          type: "agent-directive",
          id: "step1",
          directive: "First step before child",
          completionCondition: "Done",
          inputSchema: SIMPLE_RESULT_SCHEMA,
          connections: { success: "step2" },
        },
        {
          type: "agent-directive",
          id: "step2",
          directive: "Second step after child returns",
          completionCondition: "Done",
          inputSchema: SIMPLE_RESULT_SCHEMA,
          connections: { success: "end" },
        },
        {
          type: "end",
          id: "end",
        },
      ],
    };

    // Create child workflow
    const childWorkflow: WorkflowGraph = {
      id: "test-child-workflow-cycle",
      metadata: {
        name: "Child Workflow",
        version: "1.0.0",
        description: "Child workflow for cycle test",
      },
      nodes: [
        {
          type: "start",
          id: "start",
          connections: { default: "child-task" },
        },
        {
          type: "agent-directive",
          id: "child-task",
          directive: "Child task",
          completionCondition: "Child done",
          inputSchema: SIMPLE_RESULT_SCHEMA,
          connections: { success: "end" },
        },
        {
          type: "end",
          id: "end",
        },
      ],
    };

    await repository.saveWorkflow(parentWorkflow, TEST_USER_ID);
    await repository.saveWorkflow(childWorkflow, TEST_USER_ID);

    // 1. Start parent workflow
    const parentId = await executor.startWorkflow(
      parentWorkflow,
      undefined,
      TEST_USER_ID,
      "Parent execution",
    );

    // 2. Execute parent step 1
    await executor.executeStep(parentId);
    await executor.executeStep(parentId, { result: "step1 done" });

    // Parent is now at step2 (Issue #386: "waiting" merged into "running")
    let parentState = await executor.getExecutionState(parentId);
    expect(parentState!.status).toBe("running");
    expect(parentState!.currentNodeId).toBe("step2");

    // 3. Start child workflow with parent link
    const childId = await executor.startWorkflow(
      childWorkflow,
      undefined,
      TEST_USER_ID,
      "Child execution",
      parentId,
    );

    // Verify link
    const childState = await executor.getExecutionState(childId);
    expect(childState!.parentExecutionId).toBe(parentId);

    // 4. Complete child workflow
    await executor.executeStep(childId);
    const childCompletion = await executor.executeStep(childId, { result: "child done" });

    // Verify continuation reminder
    expect(childCompletion).toContain("CONTINUATION REMINDER");
    expect(childCompletion).toContain(parentId);

    // 5. Continue parent workflow
    const parentCompletion = await executor.executeStep(parentId, { result: "step2 done" });

    // Parent should complete without continuation reminder (it has no parent)
    expect(parentCompletion).toContain("Workflow completed successfully");
    expect(parentCompletion).not.toContain("CONTINUATION REMINDER");

    // Verify final states
    parentState = await executor.getExecutionState(parentId);
    expect(parentState!.status).toBe("completed");

    const finalChildState = await executor.getExecutionState(childId);
    expect(finalChildState!.status).toBe("completed");
  });
});
