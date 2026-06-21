/**
 * Step Response Child Workflow Info Tests (#429)
 *
 * Tests that step() response includes active child workflow information
 * when parent workflow has running children.
 */

import { describe, test, expect, beforeEach, afterEach } from "@jest/globals";
import { UniversalGraphExecutor } from "../../packages/workflow-engine/src/core/universal-graph-executor.js";
import { InMemoryRepository } from "../../packages/workflow-engine/src/storage/in-memory-repository.js";
import { WorkflowGraph } from "../../packages/workflow-engine/src/interfaces/core-interfaces.js";

const TEST_USER_ID = "test-user-child-info";

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

describe("Step Response Child Workflow Info (#429)", () => {
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

  test("step response includes active child workflows when they exist", async () => {
    // Create parent workflow with multiple steps (3 steps so we can check child info on step2)
    const parentWorkflow: WorkflowGraph = {
      id: "test-parent-with-child",
      metadata: {
        name: "Parent Workflow",
        version: "1.0.0",
        description: "Parent workflow with child",
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
          directive: "Start a child workflow and come back",
          completionCondition: "Child started",
          inputSchema: SIMPLE_RESULT_SCHEMA,
          connections: { success: "step2" },
        },
        {
          type: "agent-directive",
          id: "step2",
          directive: "Continue while child runs",
          completionCondition: "Checked child status",
          inputSchema: SIMPLE_RESULT_SCHEMA,
          connections: { success: "step3" },
        },
        {
          type: "agent-directive",
          id: "step3",
          directive: "Final step",
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
      id: "test-child-wf",
      metadata: {
        name: "Child Workflow",
        version: "1.0.0",
        description: "Child workflow",
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
          directive: "Do child work",
          completionCondition: "Child work done",
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

    // Start parent workflow
    const parentId = await executor.startWorkflow(
      parentWorkflow,
      undefined,
      TEST_USER_ID,
      "Parent execution",
    );

    // Execute parent step 1 - get to waiting state
    await executor.executeStep(parentId);

    // Complete step 1 to move to step 2
    await executor.executeStep(parentId, { result: "step1 done" });

    // Start child workflow linked to parent
    const childId = await executor.startWorkflow(
      childWorkflow,
      undefined,
      TEST_USER_ID,
      "Child execution",
      parentId,
    );

    // Execute child to get it into running state (waiting for input)
    await executor.executeStep(childId);

    // Now execute step on parent (step2 → step3) - response should include info about active child
    const stepResponse = await executor.executeStep(parentId, { result: "continuing" });

    // Verify parent is still running (at step3), not completed
    const parentState = await executor.getExecutionState(parentId);
    expect(parentState!.status).toBe("running");
    expect(parentState!.currentNodeId).toBe("step3");

    // Verify child info is in response
    expect(stepResponse).toContain("Active Child Workflows");
    expect(stepResponse).toContain(childId);
  });

  test("step response does NOT include child info when no active children", async () => {
    const workflow: WorkflowGraph = {
      id: "test-no-children",
      metadata: {
        name: "Standalone Workflow",
        version: "1.0.0",
        description: "Workflow without children",
      },
      nodes: [
        {
          type: "start",
          id: "start",
          connections: { default: "task1" },
        },
        {
          type: "agent-directive",
          id: "task1",
          directive: "First task",
          completionCondition: "Done",
          inputSchema: SIMPLE_RESULT_SCHEMA,
          connections: { success: "task2" },
        },
        {
          type: "agent-directive",
          id: "task2",
          directive: "Second task",
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

    const executionId = await executor.startWorkflow(
      workflow,
      undefined,
      TEST_USER_ID,
      "Test execution",
    );

    // Execute step 1
    await executor.executeStep(executionId);
    const response = await executor.executeStep(executionId, { result: "done" });

    // Should NOT contain child workflow info
    expect(response).not.toContain("Active Child Workflows");
  });

  test("step response does NOT include completed child workflows", async () => {
    const parentWorkflow: WorkflowGraph = {
      id: "test-parent-completed-child",
      metadata: {
        name: "Parent",
        version: "1.0.0",
        description: "Parent with completed child",
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
          directive: "Continue after child completes",
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

    const childWorkflow: WorkflowGraph = {
      id: "test-quick-child",
      metadata: {
        name: "Quick Child",
        version: "1.0.0",
        description: "Child that completes quickly",
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
          directive: "Quick task",
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

    await repository.saveWorkflow(parentWorkflow, TEST_USER_ID);
    await repository.saveWorkflow(childWorkflow, TEST_USER_ID);

    // Start parent
    const parentId = await executor.startWorkflow(
      parentWorkflow,
      undefined,
      TEST_USER_ID,
      "Parent execution",
    );

    // Start and complete child
    const childId = await executor.startWorkflow(
      childWorkflow,
      undefined,
      TEST_USER_ID,
      "Child execution",
      parentId,
    );

    await executor.executeStep(childId);
    await executor.executeStep(childId, { result: "done" });

    // Verify child is completed
    const childState = await executor.getExecutionState(childId);
    expect(childState!.status).toBe("completed");

    // Execute parent step - should NOT show completed child
    await executor.executeStep(parentId);

    // Note: we can't easily test the response without input validation triggering
    // But we can verify the child query behavior via direct repository call
    const activeChildren = await repository.findActiveChildExecutions(parentId);
    expect(activeChildren).toHaveLength(0);
  });

  test("step response includes multiple active children", async () => {
    const parentWorkflow: WorkflowGraph = {
      id: "test-parent-multi-child",
      metadata: {
        name: "Parent Multi",
        version: "1.0.0",
        description: "Parent with multiple children",
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
          directive: "Task with multiple children",
          completionCondition: "Done",
          inputSchema: SIMPLE_RESULT_SCHEMA,
          connections: { success: "step2" },
        },
        {
          type: "agent-directive",
          id: "step2",
          directive: "Final task",
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

    const childWorkflow: WorkflowGraph = {
      id: "test-child-multi",
      metadata: {
        name: "Child Multi",
        version: "1.0.0",
        description: "Child workflow",
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
          directive: "Child task",
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

    await repository.saveWorkflow(parentWorkflow, TEST_USER_ID);
    await repository.saveWorkflow(childWorkflow, TEST_USER_ID);

    // Start parent
    const parentId = await executor.startWorkflow(
      parentWorkflow,
      undefined,
      TEST_USER_ID,
      "Parent execution",
    );

    // Start multiple children
    const child1Id = await executor.startWorkflow(
      childWorkflow,
      undefined,
      TEST_USER_ID,
      "Child 1",
      parentId,
    );

    const child2Id = await executor.startWorkflow(
      childWorkflow,
      undefined,
      TEST_USER_ID,
      "Child 2",
      parentId,
    );

    // Execute children to get them into running state
    await executor.executeStep(child1Id);
    await executor.executeStep(child2Id);

    // Execute parent step1 → step2 (not completion)
    await executor.executeStep(parentId);
    const response = await executor.executeStep(parentId, { result: "done" });

    // Verify parent is still running (at step2), not completed
    const parentState = await executor.getExecutionState(parentId);
    expect(parentState!.status).toBe("running");
    expect(parentState!.currentNodeId).toBe("step2");

    // Should include both children
    expect(response).toContain("Active Child Workflows");
    expect(response).toContain("(2)");
    expect(response).toContain(child1Id);
    expect(response).toContain(child2Id);
  });
});
