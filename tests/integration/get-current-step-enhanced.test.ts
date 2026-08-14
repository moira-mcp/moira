/**
 * Enhanced get_current_step Integration Tests
 * Tests idempotency and JSON schema formatting
 */

import { describe, test, expect, beforeAll, afterEach } from "@jest/globals";
import { DatabaseRepository, WorkflowGraph } from "@mcp-moira/workflow-engine";
import { MCPEngine } from "../../packages/mcp-server/src/core/mcp-engine.js";
import { requestContext } from "../../packages/mcp-server/src/core/request-context.js";
import { executeStep } from "../../packages/mcp-server/src/tools/execute-step.js";
import { getSessionInfo } from "../../packages/mcp-server/src/tools/get-session-info.js";

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

  afterEach(() => {
    MCPEngine.resetInstance();
  });

  test("unsupported presentation leaves agent-directive execution on its established path", async () => {
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

    const graphEngine = (
      universalExecutor as unknown as {
        graphEngine: {
          nodeHandlers: Map<string, { getNodeType: () => string; execute: () => Promise<never> }>;
        };
      }
    ).graphEngine;
    graphEngine.nodeHandlers.set("agent-directive", {
      getNodeType: () => "agent-directive",
      execute: async () => {
        throw new Error("unsupported waiting handler was executed");
      },
    });
    const beforeUnsupportedPresentation = await repository.getExecution(executionId);
    await expect(universalExecutor.presentCurrentStep(executionId)).resolves.toBeNull();
    await expect(repository.getExecution(executionId)).resolves.toEqual(
      beforeUnsupportedPresentation,
    );

    // Cleanup
    await repository.deleteExecution(executionId);
    await repository.deleteWorkflow(savedWorkflowId, TEST_USER_ID);
  });

  test("current_step re-presents materialize without advancing, while step completes it", async () => {
    const workflow: WorkflowGraph = {
      id: `test-materialize-current-step-${Date.now()}`,
      metadata: {
        name: "Materialize current-step test",
        version: "1.0.0",
        description: "Read-only current-step behavior",
      },
      variableRegistry: {
        readme: {
          type: "string",
          description: "README source",
          default: "# Materialized",
        },
      },
      nodes: [
        { type: "start", id: "start", connections: { default: "materialize" } },
        {
          type: "materialize",
          id: "materialize",
          basePath: "./runtime-output",
          files: [{ path: "README.md", from: "readme" }],
          connections: { success: "end" },
        },
        { type: "end", id: "end" },
      ],
    };

    const saveResult = await getWorkflowService().save({
      graph: workflow,
      userId: TEST_USER_ID,
      visibility: "private",
    });
    const savedWorkflowId = saveResult.id;
    const savedWorkflow = await repository.getWorkflowGraph(savedWorkflowId, TEST_USER_ID);
    const engine = MCPEngine.getInstance(repository);
    const executionId = await engine.executor.startWorkflow(
      savedWorkflow!,
      undefined,
      TEST_USER_ID,
    );

    try {
      const firstDirective = await engine.executor.executeStep(executionId);
      expect(firstDirective).toContain("Materialize 1 file into");
      const beforeRead = await repository.getExecution(executionId);
      expect(beforeRead).toMatchObject({
        status: "running",
        currentNodeId: "materialize",
        waitingForInputNodeId: "materialize",
      });

      const sessionResult = await requestContext.run({ userId: TEST_USER_ID }, () =>
        getSessionInfo({ action: "current_step", executionId }),
      );
      expect(sessionResult.success).toBe(true);
      expect(sessionResult.data).toEqual(expect.stringContaining("Materialize 1 file into"));
      expect(sessionResult.data).toEqual(expect.stringContaining("README.md"));
      const afterRead = await repository.getExecution(executionId);
      expect(afterRead).toEqual(beforeRead);

      const completion = await requestContext.run({ userId: TEST_USER_ID }, () =>
        executeStep({ processId: executionId }),
      );
      expect(completion.success).toBe(true);
      expect(completion.data).toContain("Workflow completed successfully");
      await expect(repository.getExecution(executionId)).resolves.toMatchObject({
        status: "completed",
        currentNodeId: null,
      });
    } finally {
      await repository.deleteExecution(executionId);
      await repository.deleteWorkflow(savedWorkflowId, TEST_USER_ID);
    }
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
