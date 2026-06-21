/**
 * Enhanced get_current_step Integration Tests
 * Tests idempotency and JSON schema formatting
 */

import { describe, test, expect, beforeAll } from "@jest/globals";
import { DatabaseRepository, WorkflowGraph } from "@mcp-moira/workflow-engine";

const TEST_USER_ID = "test-user-enhanced-step";

describe("get_current_step Enhanced", () => {
  let repository: DatabaseRepository;
  let getWorkflowService: typeof import("@mcp-moira/shared").getWorkflowService;

  beforeAll(async () => {
    repository = new DatabaseRepository();

    // Create test user
    const shared = await import("@mcp-moira/shared");
    getWorkflowService = shared.getWorkflowService;
    const { getDatabase, user } = shared;
    const db = getDatabase();
    const now = new Date().toISOString();

    try {
      await db.insert(user).values({
        id: TEST_USER_ID,
        email: `${TEST_USER_ID}@test.com`,
        name: "Test User",
        handle: TEST_USER_ID,
        emailVerified: false,
        createdAt: now,
        updatedAt: now,
      });
    } catch (error) {
      // User might already exist
    }
  });

  test("executeStep without input returns formatted directive identical to first call", async () => {
    // Create simple test workflow
    const workflow: WorkflowGraph = {
      id: `test-idempotent-${Date.now()}`,
      metadata: {
        name: "Idempotent Test",
        version: "1.0.0",
        description: "Test idempotency",
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
          directive: "Test task",
          completionCondition: "Done",
          inputSchema: {
            type: "object",
            required: ["field"],
            properties: {
              field: { type: "string", description: "Test field" },
            },
          },
          connections: { success: "end" },
        },
        {
          type: "end",
          id: "end",
        },
      ],
    };

    // Use WorkflowService to get the generated UUID
    const workflowService = getWorkflowService();
    const saveResult = await workflowService.save({
      graph: workflow,
      userId: TEST_USER_ID,
      visibility: "private",
    });
    const savedWorkflowId = saveResult.id;

    // Get the saved workflow with the correct ID
    const savedWorkflow = await repository.getWorkflowGraph(savedWorkflowId, TEST_USER_ID);

    // Start execution
    const universalExecutor = new (
      await import("@mcp-moira/workflow-engine")
    ).UniversalGraphExecutor(repository);
    const executionId = await universalExecutor.startWorkflow(
      savedWorkflow!,
      undefined,
      TEST_USER_ID,
    );

    // First executeStep without input
    const firstCall = await universalExecutor.executeStep(executionId, undefined);

    // Second executeStep without input (simulates get_current_step)
    const secondCall = await universalExecutor.executeStep(executionId, undefined);

    // Results should be identical
    expect(firstCall).toEqual(secondCall);
    expect(firstCall).toContain("Input Schema:");
    expect(firstCall).toContain("```json");

    // Cleanup
    await repository.deleteExecution(executionId);
    await repository.deleteWorkflow(savedWorkflowId, TEST_USER_ID);
  });

  test("JSON schema formatting shows all details for complex schemas", async () => {
    const workflow: WorkflowGraph = {
      id: `test-complex-format-${Date.now()}`,
      metadata: {
        name: "Complex Schema Format Test",
        version: "1.0.0",
        description: "Test complex schema formatting",
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
          directive: "Complex task",
          completionCondition: "Data provided",
          inputSchema: {
            type: "object",
            required: ["status", "items"],
            properties: {
              status: {
                type: "string",
                description: "Status field",
                enum: ["active", "inactive", "pending"],
              },
              items: {
                type: "array",
                description: "List of items",
                items: {
                  type: "object",
                  required: ["name"],
                  properties: {
                    name: { type: "string" },
                    nested: {
                      type: "object",
                      properties: {
                        level: {
                          type: "string",
                          enum: ["low", "medium", "high"],
                        },
                      },
                    },
                  },
                },
              },
            },
          },
          connections: { success: "end" },
        },
        {
          type: "end",
          id: "end",
        },
      ],
    };

    // Use WorkflowService to get the generated UUID
    const workflowService = getWorkflowService();
    const saveResult = await workflowService.save({
      graph: workflow,
      userId: TEST_USER_ID,
      visibility: "private",
    });
    const savedWorkflowId = saveResult.id;

    // Get the saved workflow with the correct ID
    const savedWorkflow = await repository.getWorkflowGraph(savedWorkflowId, TEST_USER_ID);

    const universalExecutor = new (
      await import("@mcp-moira/workflow-engine")
    ).UniversalGraphExecutor(repository);
    const executionId = await universalExecutor.startWorkflow(
      savedWorkflow!,
      undefined,
      TEST_USER_ID,
    );
    const output = await universalExecutor.executeStep(executionId, undefined);

    // Verify all schema details are present
    expect(output).toContain('"enum"');
    expect(output).toContain('"active"');
    expect(output).toContain('"inactive"');
    expect(output).toContain('"items"');
    expect(output).toContain('"nested"');
    expect(output).toContain('"level"');
    expect(output).toContain('"low"');
    expect(output).toContain('"medium"');
    expect(output).toContain('"high"');

    // Cleanup
    await repository.deleteExecution(executionId);
    await repository.deleteWorkflow(savedWorkflowId, TEST_USER_ID);
  });
});
