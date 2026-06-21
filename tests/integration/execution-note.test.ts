/**
 * Execution Note Field Integration Tests
 * Tests the note field functionality in workflow executions (#238, #264)
 *
 * Covers:
 * - Initial note when starting workflow
 * - Magic variable execution_note in step input
 * - updateExecutionNote repository method
 */

import { describe, test, expect } from "@jest/globals";
import { WorkflowGraph } from "@mcp-moira/workflow-engine";

// Issue #369: All nodes that accept input MUST have inputSchema
const SIMPLE_RESULT_SCHEMA = {
  type: "object",
  properties: {
    result: { type: "string" },
    execution_note: { type: "string", maxLength: 500 },
    other_field: { type: "string" },
  },
  additionalProperties: false,
};

describe("Execution Note Field", () => {
  test("should save and retrieve note when starting workflow", async () => {
    const { repository, executor } = await createTestExecutor();

    const workflow: WorkflowGraph = {
      id: "test-note-workflow",
      metadata: {
        name: "Note Test",
        version: "1.0.0",
        description: "Test note field functionality",
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

    // Start workflow with note
    const testNote = "Platform improvements feature - issue #238";
    const executionId = await executor.startWorkflow(workflow, undefined, TEST_USER_ID, testNote);

    // Verify note is saved in execution
    const execution = await executor.getExecutionState(executionId);
    expect(execution).not.toBeNull();
    expect(execution!.note).toBe(testNote);
  });

  test("should save execution without note when not provided", async () => {
    const { repository, executor } = await createTestExecutor();

    const workflow: WorkflowGraph = {
      id: "test-no-note-workflow",
      metadata: {
        name: "No Note Test",
        version: "1.0.0",
        description: "Test workflow without note",
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

    // Start workflow without note
    const executionId = await executor.startWorkflow(workflow, undefined, TEST_USER_ID);

    // Verify note is null/undefined
    const execution = await executor.getExecutionState(executionId);
    expect(execution).not.toBeNull();
    expect(execution!.note).toBeFalsy(); // null or undefined
  });

  test("should preserve note through workflow execution steps", async () => {
    const { repository, executor } = await createTestExecutor();

    const workflow: WorkflowGraph = {
      id: "test-note-persistence",
      metadata: {
        name: "Note Persistence Test",
        version: "1.0.0",
        description: "Test note persists through execution",
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
          directive: "First step",
          completionCondition: "Step 1 done",
          inputSchema: SIMPLE_RESULT_SCHEMA,
          connections: { success: "step2" },
        },
        {
          type: "agent-directive",
          id: "step2",
          directive: "Second step",
          completionCondition: "Step 2 done",
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

    const testNote = "Multi-step execution test";
    const executionId = await executor.startWorkflow(workflow, undefined, TEST_USER_ID, testNote);

    // Execute first step
    await executor.executeStep(executionId);
    await executor.executeStep(executionId, { result: "step1 done" });

    // Verify note is still preserved
    const execution = await executor.getExecutionState(executionId);
    expect(execution!.note).toBe(testNote);

    // Complete workflow
    await executor.executeStep(executionId, { result: "step2 done" });

    // Note should still be there even after completion
    const completedExecution = await executor.getExecutionState(executionId);
    expect(completedExecution!.note).toBe(testNote);
    expect(completedExecution!.status).toBe("completed");
  });

  test("should handle empty string note as no note", async () => {
    const { repository, executor } = await createTestExecutor();

    const workflow: WorkflowGraph = {
      id: "test-empty-note",
      metadata: {
        name: "Empty Note Test",
        version: "1.0.0",
        description: "Test empty string note handling",
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

    // Start workflow with empty note - should be treated as null
    const executionId = await executor.startWorkflow(workflow, undefined, TEST_USER_ID, "");

    const execution = await executor.getExecutionState(executionId);
    expect(execution).not.toBeNull();
    // Empty string should become null
    expect(execution!.note).toBeNull();
  });

  test("should update note via execution_note magic variable in step input", async () => {
    const { repository, executor } = await createTestExecutor();

    const workflow: WorkflowGraph = {
      id: "test-magic-note-update",
      metadata: {
        name: "Magic Note Update Test",
        version: "1.0.0",
        description: "Test execution_note magic variable",
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
          directive: "First step",
          completionCondition: "Done",
          inputSchema: SIMPLE_RESULT_SCHEMA,
          connections: { success: "step2" },
        },
        {
          type: "agent-directive",
          id: "step2",
          directive: "Second step",
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

    // Start workflow with initial note
    const initialNote = "Initial note";
    const executionId = await executor.startWorkflow(
      workflow,
      undefined,
      TEST_USER_ID,
      initialNote,
    );

    // Execute first step - get to waiting state
    await executor.executeStep(executionId);

    // Verify initial note
    let execution = await executor.getExecutionState(executionId);
    expect(execution!.note).toBe(initialNote);

    // Execute step with execution_note magic variable to update note
    const updatedNote = "Updated via magic variable";
    await executor.executeStep(executionId, {
      result: "step1 done",
      execution_note: updatedNote,
    });

    // Verify note was updated
    execution = await executor.getExecutionState(executionId);
    expect(execution!.note).toBe(updatedNote);
  });

  test("should update note via repository updateExecutionNote method", async () => {
    const { repository, executor } = await createTestExecutor();

    const workflow: WorkflowGraph = {
      id: "test-repo-note-update",
      metadata: {
        name: "Repository Note Update Test",
        version: "1.0.0",
        description: "Test updateExecutionNote repository method",
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

    // Start workflow with initial note
    const initialNote = "Initial note";
    const executionId = await executor.startWorkflow(
      workflow,
      undefined,
      TEST_USER_ID,
      initialNote,
    );

    // Verify initial note
    let execution = await executor.getExecutionState(executionId);
    expect(execution!.note).toBe(initialNote);

    // Update note via repository method
    const updatedNote = "Updated via repository";
    await repository.updateExecutionNote(executionId, updatedNote);

    // Verify note was updated
    execution = await executor.getExecutionState(executionId);
    expect(execution!.note).toBe(updatedNote);
  });

  test("should pass execution_note through to graph engine for validation", async () => {
    // NOTE: execution_note is NO LONGER stripped - it passes through for inputSchema validation
    // This allows workflows to require execution_note in their inputSchema
    const { repository, executor } = await createTestExecutor();

    const workflow: WorkflowGraph = {
      id: "test-note-passthrough",
      metadata: {
        name: "Note Passthrough Test",
        version: "1.0.0",
        description: "Test that execution_note passes through to graph engine",
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
          directive: "First step",
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

    const executionId = await executor.startWorkflow(workflow, undefined, TEST_USER_ID);

    // Execute first step - get to waiting state
    await executor.executeStep(executionId);

    // Execute step with execution_note and other data
    await executor.executeStep(executionId, {
      result: "step1 done",
      execution_note: "This note should be stored",
      other_field: "This should be in context",
    });

    // Verify note was updated
    const execution = await executor.getExecutionState(executionId);
    expect(execution!.note).toBe("This note should be stored");

    // Verify execution_note IS in the node-local scope (no longer stripped).
    // Node outputs live under their node id (context.variables[nodeId]); they are not
    // duplicated at the top level unless declared as registry globals.
    const step1Scope = execution!.globalContext.variables.step1 as Record<string, unknown>;
    expect(step1Scope).toHaveProperty("execution_note");
    expect(step1Scope.execution_note).toBe("This note should be stored");
  });

  test("should ignore invalid execution_note (too long)", async () => {
    const { repository, executor } = await createTestExecutor();

    const workflow: WorkflowGraph = {
      id: "test-note-validation",
      metadata: {
        name: "Note Validation Test",
        version: "1.0.0",
        description: "Test that too-long notes are ignored",
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
          directive: "First step",
          completionCondition: "Done",
          inputSchema: {
            type: "object",
            properties: {
              result: { type: "string" },
              // Note: execution_note has no maxLength here - maxLength is checked by executor
              // not inputSchema validation. Too-long notes are ignored, not rejected.
              execution_note: { type: "string" },
            },
            additionalProperties: false,
          },
          connections: { success: "end" },
        },
        {
          type: "end",
          id: "end",
        },
      ],
    };

    await repository.saveWorkflow(workflow, TEST_USER_ID);

    const initialNote = "Initial note";
    const executionId = await executor.startWorkflow(
      workflow,
      undefined,
      TEST_USER_ID,
      initialNote,
    );

    // Execute first step - get to waiting state
    await executor.executeStep(executionId);

    // Try to update with too-long note (>500 chars)
    const tooLongNote = "x".repeat(501);
    await executor.executeStep(executionId, {
      result: "step1 done",
      execution_note: tooLongNote,
    });

    // Verify note was NOT updated (kept initial)
    const execution = await executor.getExecutionState(executionId);
    expect(execution!.note).toBe(initialNote);
  });
});
