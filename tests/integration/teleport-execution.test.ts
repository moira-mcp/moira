/**
 * Teleport Execution Integration Tests
 * Tests teleportTo jump logic in workflow execution
 *
 * Covers:
 * - Successful teleport to a teleport node
 * - Error: teleport to non-existent node
 * - Error: teleport to non-teleport node
 * - Teleport preserves execution context variables
 * - Teleport hints appear in system reminder
 */

import { describe, test, expect } from "@jest/globals";
import { UniversalGraphExecutor } from "../../packages/workflow-engine/src/core/universal-graph-executor.js";
import { InMemoryRepository } from "../../packages/workflow-engine/src/storage/in-memory-repository.js";
import { WorkflowGraph } from "../../packages/workflow-engine/src/interfaces/core-interfaces.js";
import { ValidationError } from "@mcp-moira/shared";

const TEST_USER_ID = "test-user-teleport";

async function createTestExecutor() {
  const repository = new InMemoryRepository();
  const executor = new UniversalGraphExecutor(repository);
  return { repository, executor };
}

// Workflow with a teleport node for re-planning
const WORKFLOW_WITH_TELEPORT: WorkflowGraph = {
  id: "test-teleport-workflow",
  metadata: {
    name: "Teleport Test",
    version: "1.0.0",
    description: "Workflow with teleport node",
  },
  nodes: [
    {
      type: "start",
      id: "start",
      initialData: {
        variables: {
          step_name: { value: "initial", description: "Current step" },
        },
      },
      connections: { default: "main-task" },
    },
    {
      type: "agent-directive",
      id: "main-task",
      directive: "Do the main task: {{step_name}}",
      completionCondition: "Task done",
      inputSchema: {
        type: "object",
        properties: { result: { type: "string" } },
        required: ["result"],
      },
      connections: { success: "end" },
    },
    {
      type: "teleport",
      id: "replan",
      hint: "Use this to re-plan the work when requirements change",
      directive: "Provide the new plan",
      completionCondition: "New plan provided",
      inputSchema: {
        type: "object",
        properties: { new_plan: { type: "string" } },
        required: ["new_plan"],
      },
      connections: { success: "main-task" },
    },
    {
      type: "end",
      id: "end",
      finalOutput: ["step_name"],
    },
  ],
};

describe("Teleport Execution", () => {
  test("should teleport to a teleport node and present its directive", async () => {
    const { repository, executor } = await createTestExecutor();
    await repository.saveWorkflow(WORKFLOW_WITH_TELEPORT, TEST_USER_ID);

    const executionId = await executor.startWorkflow(
      WORKFLOW_WITH_TELEPORT,
      undefined,
      TEST_USER_ID,
    );

    // Step 1: get the main-task directive
    const step1 = await executor.executeStep(executionId);
    expect(step1).toContain("Do the main task");

    // Teleport to replan node instead of providing input
    const teleportResult = await executor.executeStep(executionId, undefined, "replan");
    expect(teleportResult).toContain("Provide the new plan");
    expect(teleportResult).toContain("New plan provided");
  });

  test("should throw ValidationError for non-existent teleport target", async () => {
    const { repository, executor } = await createTestExecutor();
    await repository.saveWorkflow(WORKFLOW_WITH_TELEPORT, TEST_USER_ID);

    const executionId = await executor.startWorkflow(
      WORKFLOW_WITH_TELEPORT,
      undefined,
      TEST_USER_ID,
    );

    await executor.executeStep(executionId);

    await expect(executor.executeStep(executionId, undefined, "nonexistent-node")).rejects.toThrow(
      ValidationError,
    );
    await expect(executor.executeStep(executionId, undefined, "nonexistent-node")).rejects.toThrow(
      "not found in workflow",
    );
  });

  test("should throw ValidationError when teleporting to non-teleport node", async () => {
    const { repository, executor } = await createTestExecutor();
    await repository.saveWorkflow(WORKFLOW_WITH_TELEPORT, TEST_USER_ID);

    const executionId = await executor.startWorkflow(
      WORKFLOW_WITH_TELEPORT,
      undefined,
      TEST_USER_ID,
    );

    await executor.executeStep(executionId);

    // Try to teleport to an agent-directive node
    await expect(executor.executeStep(executionId, undefined, "main-task")).rejects.toThrow(
      ValidationError,
    );
    await expect(executor.executeStep(executionId, undefined, "main-task")).rejects.toThrow(
      "not a teleport node",
    );
  });

  test("should preserve execution context variables after teleport", async () => {
    const { repository, executor } = await createTestExecutor();
    await repository.saveWorkflow(WORKFLOW_WITH_TELEPORT, TEST_USER_ID);

    const executionId = await executor.startWorkflow(
      WORKFLOW_WITH_TELEPORT,
      undefined,
      TEST_USER_ID,
    );

    // Step 1: get main-task directive (step_name = "initial" from start node)
    const step1 = await executor.executeStep(executionId);
    expect(step1).toContain("initial");

    // Teleport to replan
    const teleportResult = await executor.executeStep(executionId, undefined, "replan");
    expect(teleportResult).toContain("Provide the new plan");

    // Provide new plan — teleport node's success connection goes to main-task
    const afterReplan = await executor.executeStep(executionId, { new_plan: "revised plan" });
    // main-task should still have step_name from context
    expect(afterReplan).toContain("Do the main task");
    expect(afterReplan).toContain("initial");
  });

  test("should include teleport hints in step response", async () => {
    const { repository, executor } = await createTestExecutor();
    await repository.saveWorkflow(WORKFLOW_WITH_TELEPORT, TEST_USER_ID);

    const executionId = await executor.startWorkflow(
      WORKFLOW_WITH_TELEPORT,
      undefined,
      TEST_USER_ID,
    );

    // Step 1 response should contain teleport hints
    const step1 = await executor.executeStep(executionId);
    expect(step1).toContain("Available Teleport Jumps");
    expect(step1).toContain("replan");
    expect(step1).toContain("re-plan the work when requirements change");
  });

  test("should not include teleport hints when workflow has no teleport nodes", async () => {
    const { repository, executor } = await createTestExecutor();

    const simpleWorkflow: WorkflowGraph = {
      id: "test-no-teleport",
      metadata: {
        name: "No Teleport",
        version: "1.0.0",
        description: "Workflow without teleport nodes",
      },
      nodes: [
        { type: "start", id: "start", connections: { default: "task" } },
        {
          type: "agent-directive",
          id: "task",
          directive: "Do something",
          completionCondition: "Done",
          connections: { success: "end" },
        },
        { type: "end", id: "end" },
      ],
    };

    await repository.saveWorkflow(simpleWorkflow, TEST_USER_ID);
    const executionId = await executor.startWorkflow(simpleWorkflow, undefined, TEST_USER_ID);

    const step1 = await executor.executeStep(executionId);
    expect(step1).not.toContain("Available Teleport Jumps");
  });

  test("should continue normal execution after teleport and input", async () => {
    const { repository, executor } = await createTestExecutor();
    await repository.saveWorkflow(WORKFLOW_WITH_TELEPORT, TEST_USER_ID);

    const executionId = await executor.startWorkflow(
      WORKFLOW_WITH_TELEPORT,
      undefined,
      TEST_USER_ID,
    );

    // Get initial directive
    await executor.executeStep(executionId);

    // Teleport to replan
    await executor.executeStep(executionId, undefined, "replan");

    // Provide replan input → should go to main-task via success connection
    await executor.executeStep(executionId, { new_plan: "new plan" });

    // Provide main-task input → should complete workflow
    const completion = await executor.executeStep(executionId, { result: "done" });
    expect(completion).toContain("Workflow completed successfully");
  });
});
