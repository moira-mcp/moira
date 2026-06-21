/**
 * Error Logging Flow Integration Tests (Issue #386)
 * Tests that errors are logged to execution.errors array without failing execution
 */

import { describe, test, expect, beforeEach, afterEach } from "@jest/globals";
import type {
  WorkflowGraph,
  UniversalGraphExecutor,
  InMemoryRepository,
} from "@mcp-moira/workflow-engine";

describe("Error Logging Flow (Issue #386)", () => {
  let executor: UniversalGraphExecutor;
  let repository: InMemoryRepository;

  beforeEach(async () => {
    const setup = await createTestExecutor();
    executor = setup.executor;
    repository = setup.repository;
  });

  afterEach(() => {
    if (global.gc) {
      global.gc();
    }
  });

  describe("Validation Error Handling", () => {
    test("validation error is logged to errors array and execution continues", async () => {
      // Workflow with required schema
      const workflow: WorkflowGraph = {
        id: "validation-test",
        metadata: {
          name: "Validation Test",
          version: "1.0.0",
          description: "Test validation errors",
        },
        nodes: [
          { type: "start", id: "start", connections: { default: "step" } },
          {
            type: "agent-directive",
            id: "step",
            directive: "Provide required data",
            completionCondition: "Data provided",
            inputSchema: {
              type: "object",
              properties: {
                name: { type: "string" },
                age: { type: "number" },
              },
              required: ["name", "age"],
            },
            connections: { success: "end" },
          },
          { type: "end", id: "end" },
        ],
      };

      await repository.saveWorkflow(workflow, "test-user-123", "public");

      // Start workflow
      const executionId = await executor.startWorkflow(workflow, undefined, "test-user-123");

      // First step - get directive
      const step1 = await executor.executeStep(executionId);
      expect(step1).toContain("Provide required data");

      // Send invalid input (missing required 'age' field)
      const step2 = await executor.executeStep(executionId, { name: "John" });

      // Should get validation error message
      expect(step2).toContain("VALIDATION ERROR");
      expect(step2).toContain("required");

      // Check execution is still running (not failed)
      const execution = await executor.getExecutionState(executionId);
      expect(execution).not.toBeNull();
      expect(execution!.status).not.toBe("failed");
      expect(["running", "waiting"]).toContain(execution!.status);

      // Check error was logged
      expect(execution!.errors).toBeDefined();
      expect(execution!.errors!.length).toBeGreaterThan(0);
      expect(execution!.errors![0].errorType).toBe("validation");
      expect(execution!.errors![0].nodeId).toBe("step");

      // Retry with valid input
      const step3 = await executor.executeStep(executionId, { name: "John", age: 30 });
      expect(step3).toContain("Workflow completed successfully");

      // Verify final state
      const finalExecution = await executor.getExecutionState(executionId);
      expect(finalExecution!.status).toBe("completed");
      // Error should still be in history
      expect(finalExecution!.errors!.length).toBeGreaterThan(0);
    });
  });

  describe("Multiple Errors Accumulation", () => {
    test("consecutive errors accumulate in errors array", async () => {
      const workflow: WorkflowGraph = {
        id: "accumulation-test",
        metadata: {
          name: "Accumulation Test",
          version: "1.0.0",
          description: "Test error accumulation",
        },
        nodes: [
          { type: "start", id: "start", connections: { default: "step" } },
          {
            type: "agent-directive",
            id: "step",
            directive: "Provide valid number",
            completionCondition: "Number provided",
            inputSchema: {
              type: "object",
              properties: { value: { type: "number" } },
              required: ["value"],
            },
            connections: { success: "end" },
          },
          { type: "end", id: "end" },
        ],
      };

      await repository.saveWorkflow(workflow, "test-user-123", "public");

      const executionId = await executor.startWorkflow(workflow, undefined, "test-user-123");

      // Get directive
      await executor.executeStep(executionId);

      // Send multiple invalid inputs
      await executor.executeStep(executionId, { value: "not-a-number" });
      await executor.executeStep(executionId, {}); // missing required
      await executor.executeStep(executionId, { wrong_field: 123 }); // wrong field

      // Check all errors accumulated
      const execution = await executor.getExecutionState(executionId);
      expect(execution!.errors).toBeDefined();
      expect(execution!.errors!.length).toBe(3);

      // All should be validation errors
      execution!.errors!.forEach((error) => {
        expect(error.errorType).toBe("validation");
        expect(error.nodeId).toBe("step");
        expect(error.timestamp).toBeDefined();
      });

      // Verify timestamps are ascending
      for (let i = 1; i < execution!.errors!.length; i++) {
        expect(execution!.errors![i].timestamp).toBeGreaterThanOrEqual(
          execution!.errors![i - 1].timestamp,
        );
      }

      // Finally succeed
      await executor.executeStep(executionId, { value: 42 });

      const finalExecution = await executor.getExecutionState(executionId);
      expect(finalExecution!.status).toBe("completed");
      // Errors remain in history
      expect(finalExecution!.errors!.length).toBe(3);
    });
  });

  describe("Error Type Categorization", () => {
    test("validation errors have errorType 'validation'", async () => {
      const workflow: WorkflowGraph = {
        id: "type-validation",
        metadata: { name: "Type Test", version: "1.0.0", description: "Test error types" },
        nodes: [
          { type: "start", id: "start", connections: { default: "step" } },
          {
            type: "agent-directive",
            id: "step",
            directive: "Test",
            completionCondition: "Done",
            inputSchema: {
              type: "object",
              properties: { data: { type: "string" } },
              required: ["data"],
            },
            connections: { success: "end" },
          },
          { type: "end", id: "end" },
        ],
      };

      await repository.saveWorkflow(workflow, "test-user-123", "public");

      const executionId = await executor.startWorkflow(workflow, undefined, "test-user-123");
      await executor.executeStep(executionId);

      // Send invalid input to trigger validation error
      await executor.executeStep(executionId, { data: 123 }); // should be string

      const execution = await executor.getExecutionState(executionId);
      expect(execution!.errors![0].errorType).toBe("validation");
    });
  });

  describe("Execution Status Behavior", () => {
    test("execution does not transition to 'failed' status on errors", async () => {
      const workflow: WorkflowGraph = {
        id: "status-test",
        metadata: { name: "Status Test", version: "1.0.0", description: "Test status behavior" },
        nodes: [
          { type: "start", id: "start", connections: { default: "step" } },
          {
            type: "agent-directive",
            id: "step",
            directive: "Test",
            completionCondition: "Done",
            inputSchema: {
              type: "object",
              properties: { value: { type: "string" } },
              required: ["value"],
            },
            connections: { success: "end" },
          },
          { type: "end", id: "end" },
        ],
      };

      await repository.saveWorkflow(workflow, "test-user-123", "public");

      const executionId = await executor.startWorkflow(workflow, undefined, "test-user-123");
      await executor.executeStep(executionId);

      // Trigger many errors
      for (let i = 0; i < 5; i++) {
        await executor.executeStep(executionId, { wrong: "data" });
      }

      // Status should never be 'failed'
      const execution = await executor.getExecutionState(executionId);
      expect(execution!.status).not.toBe("failed");
      expect(["running", "waiting"]).toContain(execution!.status);

      // Errors should be accumulated
      expect(execution!.errors!.length).toBe(5);
    });
  });

  describe("Error Context (Input Sanitization)", () => {
    test("error includes sanitized input data", async () => {
      const workflow: WorkflowGraph = {
        id: "input-test",
        metadata: { name: "Input Test", version: "1.0.0", description: "Test input in errors" },
        nodes: [
          { type: "start", id: "start", connections: { default: "step" } },
          {
            type: "agent-directive",
            id: "step",
            directive: "Test",
            completionCondition: "Done",
            inputSchema: {
              type: "object",
              properties: { name: { type: "string" } },
              required: ["name"],
            },
            connections: { success: "end" },
          },
          { type: "end", id: "end" },
        ],
      };

      await repository.saveWorkflow(workflow, "test-user-123", "public");

      const executionId = await executor.startWorkflow(workflow, undefined, "test-user-123");
      await executor.executeStep(executionId);

      // Send invalid input with some data
      await executor.executeStep(executionId, { wrong_field: "some_value", extra: 123 });

      const execution = await executor.getExecutionState(executionId);
      expect(execution!.errors![0].input).toBeDefined();
      // Sanitized input should be present (not necessarily full original)
    });
  });

  describe("Cancellation Behavior", () => {
    test("cancelled execution is marked as completed with system error in log", async () => {
      const workflow: WorkflowGraph = {
        id: "cancel-test",
        metadata: { name: "Cancel Test", version: "1.0.0", description: "Test cancellation" },
        nodes: [
          { type: "start", id: "start", connections: { default: "step" } },
          {
            type: "agent-directive",
            id: "step",
            directive: "Wait for input",
            completionCondition: "Input received",
            connections: { success: "end" },
          },
          { type: "end", id: "end" },
        ],
      };

      await repository.saveWorkflow(workflow, "test-user-123", "public");

      const executionId = await executor.startWorkflow(workflow, undefined, "test-user-123");
      await executor.executeStep(executionId);

      // Cancel while waiting
      await executor.cancelExecution(executionId);

      const execution = await executor.getExecutionState(executionId);
      // Should be completed, not failed
      expect(execution!.status).toBe("completed");
      // Should have cancellation in errors
      expect(execution!.errors).toBeDefined();
      expect(execution!.errors!.length).toBeGreaterThan(0);
      expect(execution!.errors![0].errorType).toBe("system");
      expect(execution!.errors![0].message).toContain("cancelled");
    });
  });
});
