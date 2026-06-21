/**
 * Step on Completed Workflow Integration Tests
 * Tests graceful handling of step() called on already completed workflow (#429)
 *
 * Covers:
 * - step() on completed workflow throws ValidationError (operational, WARN level)
 * - Error message includes child workflow processId when active children exist
 * - Error message indicates no children when none exist
 */

import { describe, test, expect, beforeEach } from "@jest/globals";
import { UniversalGraphExecutor } from "../../packages/workflow-engine/src/core/universal-graph-executor.js";
import { InMemoryRepository } from "../../packages/workflow-engine/src/storage/in-memory-repository.js";
import { WorkflowGraph } from "../../packages/workflow-engine/src/interfaces/core-interfaces.js";
import { ValidationError } from "@mcp-moira/shared";

const TEST_USER_ID = "test-user-completed-step";

async function createTestExecutor() {
  const repository = new InMemoryRepository();
  const executor = new UniversalGraphExecutor(repository);
  return { repository, executor };
}

// Simple workflow that completes in one step (no input required)
const SIMPLE_WORKFLOW: WorkflowGraph = {
  id: "test-simple-complete",
  metadata: {
    name: "Simple Complete",
    version: "1.0.0",
    description: "Completes immediately after start",
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

// Workflow with one step before end
const ONE_STEP_WORKFLOW: WorkflowGraph = {
  id: "test-one-step",
  metadata: {
    name: "One Step",
    version: "1.0.0",
    description: "One step workflow",
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
      inputSchema: {
        type: "object",
        properties: { result: { type: "string" } },
        required: ["result"],
      },
      connections: { success: "end" },
    },
    {
      type: "end",
      id: "end",
    },
  ],
};

describe("Step on Completed Workflow (#429)", () => {
  let repository: InMemoryRepository;
  let executor: UniversalGraphExecutor;

  beforeEach(async () => {
    const setup = await createTestExecutor();
    repository = setup.repository;
    executor = setup.executor;
  });

  test("should throw ValidationError when calling step() on completed workflow", async () => {
    await repository.saveWorkflow(ONE_STEP_WORKFLOW, TEST_USER_ID);

    // Start and complete the workflow
    const executionId = await executor.startWorkflow(ONE_STEP_WORKFLOW, undefined, TEST_USER_ID);

    // First step: get directive
    await executor.executeStep(executionId);
    // Second step: provide input → completes
    const completionResult = await executor.executeStep(executionId, { result: "done" });
    expect(completionResult).toContain("Workflow completed successfully");

    // Now calling step() again should throw ValidationError
    await expect(executor.executeStep(executionId)).rejects.toThrow(ValidationError);
    await expect(executor.executeStep(executionId)).rejects.toThrow("Workflow already completed");
  });

  test("should include 'No active child workflows' when no children exist", async () => {
    await repository.saveWorkflow(ONE_STEP_WORKFLOW, TEST_USER_ID);

    const executionId = await executor.startWorkflow(ONE_STEP_WORKFLOW, undefined, TEST_USER_ID);

    await executor.executeStep(executionId);
    await executor.executeStep(executionId, { result: "done" });

    // Call step on completed workflow - no children
    try {
      await executor.executeStep(executionId);
      fail("Should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      expect((error as ValidationError).message).toContain("No active child workflows");
      expect((error as ValidationError).isOperational).toBe(true);
    }
  });

  test("should include active child workflow processId in error message", async () => {
    await repository.saveWorkflow(ONE_STEP_WORKFLOW, TEST_USER_ID);

    // Start parent workflow and complete it
    const parentId = await executor.startWorkflow(ONE_STEP_WORKFLOW, undefined, TEST_USER_ID);

    await executor.executeStep(parentId);
    await executor.executeStep(parentId, { result: "done" });

    // Start a child workflow that references the parent (still running)
    const childId = await executor.startWorkflow(
      ONE_STEP_WORKFLOW,
      undefined,
      TEST_USER_ID,
      "Child workflow",
      parentId,
    );

    // Child is running (started but not completed)
    const childExecution = await repository.getExecution(childId);
    expect(childExecution?.status).toBe("running");
    expect(childExecution?.parentExecutionId).toBe(parentId);

    // Now step() on completed parent should mention the child
    try {
      await executor.executeStep(parentId);
      fail("Should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      const message = (error as ValidationError).message;
      expect(message).toContain("Workflow already completed");
      expect(message).toContain("Active child workflow");
      expect(message).toContain(childId);
    }
  });

  test("should not include completed child workflows in error message", async () => {
    await repository.saveWorkflow(ONE_STEP_WORKFLOW, TEST_USER_ID);

    // Start parent and complete it
    const parentId = await executor.startWorkflow(ONE_STEP_WORKFLOW, undefined, TEST_USER_ID);
    await executor.executeStep(parentId);
    await executor.executeStep(parentId, { result: "done" });

    // Start and complete a child workflow
    const childId = await executor.startWorkflow(
      ONE_STEP_WORKFLOW,
      undefined,
      TEST_USER_ID,
      "Child workflow",
      parentId,
    );
    await executor.executeStep(childId);
    await executor.executeStep(childId, { result: "child done" });

    // Child is completed
    const childExecution = await repository.getExecution(childId);
    expect(childExecution?.status).toBe("completed");

    // step() on parent should say no active children (child is completed)
    try {
      await executor.executeStep(parentId);
      fail("Should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      expect((error as ValidationError).message).toContain("No active child workflows");
    }
  });

  test("error should be operational (isOperational=true) for WARN logging", async () => {
    await repository.saveWorkflow(ONE_STEP_WORKFLOW, TEST_USER_ID);

    const executionId = await executor.startWorkflow(ONE_STEP_WORKFLOW, undefined, TEST_USER_ID);
    await executor.executeStep(executionId);
    await executor.executeStep(executionId, { result: "done" });

    try {
      await executor.executeStep(executionId);
      fail("Should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      // ValidationError has isOperational=true by definition
      // This ensures it gets logged as WARN, not ERROR
      expect((error as ValidationError).isOperational).toBe(true);
      expect((error as ValidationError).code).toBe("VALIDATION_ERROR");
    }
  });
});
