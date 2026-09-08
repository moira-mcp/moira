/**
 * Enhanced get_current_step Integration Tests
 * Tests idempotency and JSON schema formatting
 */

import { describe, test, expect, beforeAll, afterEach } from "@jest/globals";
import {
  DatabaseRepository,
  ExecutionMutationCoordinator,
  type PresentedExecutionAttempt,
  WorkflowGraph,
} from "@mcp-moira/workflow-engine";
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

  test("current_step adopts a legacy agent-directive attempt without advancing it", async () => {
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

    expect(firstCall).toContain("Input Schema:");
    expect(firstCall).toContain("```json");
    const beforeRecovery = await repository.getExecution(executionId);
    MCPEngine.getInstance(repository);
    const [left, right] = await Promise.all(
      [0, 1].map(() =>
        requestContext.run({ userId: TEST_USER_ID }, () =>
          getSessionInfo({ action: "current_step", executionId }),
        ),
      ),
    );
    expect(left.success).toBe(true);
    expect(right.success).toBe(true);
    const leftAttempt = String(left.data).match(/Step attempt ID:\s*([a-f0-9-]+)/i)?.[1];
    const rightAttempt = String(right.data).match(/Step attempt ID:\s*([a-f0-9-]+)/i)?.[1];
    expect(leftAttempt).toBeDefined();
    expect(rightAttempt).toBe(leftAttempt);
    expect(await repository.getExecution(executionId)).toEqual(beforeRecovery);
    expect(
      (await repository.getCurrentExecutionAttempt(executionId, TEST_USER_ID))?.attemptId,
    ).toBe(leftAttempt);

    const completion = await requestContext.run({ userId: TEST_USER_ID }, () =>
      executeStep({ processId: executionId, attemptId: leftAttempt!, input: { field: "done" } }),
    );
    expect(completion.success).toBe(true);
    expect(completion.data).toContain("Workflow completed successfully");

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

      const currentAttempt = String(sessionResult.data).match(
        /Step attempt ID:\s*([a-f0-9-]+)/i,
      )?.[1];
      expect(currentAttempt).toBeDefined();
      const completion = await requestContext.run({ userId: TEST_USER_ID }, () =>
        executeStep({ processId: executionId, attemptId: currentAttempt! }),
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

  test("current_step rebinds a persisted revision-only stale attempt", async () => {
    const workflow: WorkflowGraph = {
      id: `test-stale-current-step-${Date.now()}`,
      metadata: { name: "Stale current step", version: "1.0.0", description: "Recovery" },
      nodes: [
        { type: "start", id: "start", connections: { default: "task" } },
        {
          type: "agent-directive",
          id: "task",
          directive: "Recover this task",
          completionCondition: "Done",
          connections: { success: "end" },
        },
        { type: "end", id: "end" },
      ],
    };
    const saved = await getWorkflowService().save({
      graph: workflow,
      userId: TEST_USER_ID,
      visibility: "private",
    });
    const graph = (await repository.getWorkflowGraph(saved.id, TEST_USER_ID))!;
    const executor = new (await import("@mcp-moira/workflow-engine")).UniversalGraphExecutor(
      repository,
    );
    const executionId = await executor.startWorkflow(graph, undefined, TEST_USER_ID);
    await executor.executeStep(executionId);
    const execution = (await repository.getExecution(executionId))!;
    const stale = new ExecutionMutationCoordinator(repository).newPresentedAttempt(
      execution,
      graph,
      null,
    );
    stale.executionRevision -= 1;
    await repository.createPresentedExecutionAttempt(stale);
    const before = await repository.getExecution(executionId);

    const recovered = await executor.presentCurrentStep(executionId);
    expect(recovered).toContain(`Step attempt ID: ${stale.attemptId}`);
    expect(await repository.getExecution(executionId)).toEqual(before);
    expect((await repository.getExecutionAttempt(stale.attemptId))?.executionRevision).toBe(
      execution.revision,
    );
    await expect(
      executor.executeStep(executionId, {}, undefined, {
        userId: TEST_USER_ID,
        attemptId: stale.attemptId,
      }),
    ).resolves.toContain("Workflow completed successfully");

    await repository.deleteExecution(executionId);
    await repository.deleteWorkflow(saved.id, TEST_USER_ID);
  });

  test.each([
    { binding: "node", patch: { nodeId: "obsolete-task" } },
    { binding: "workflow version", patch: { workflowVersion: "0.9.0" } },
    { binding: "workflow digest", patch: { workflowDigest: "0".repeat(64) } },
  ])(
    "current_step reports a stale $binding binding without recommending its ID",
    async ({ binding, patch }: { binding: string; patch: Partial<PresentedExecutionAttempt> }) => {
      const workflow: WorkflowGraph = {
        id: `test-binding-stale-current-step-${binding.replaceAll(" ", "-")}-${Date.now()}`,
        metadata: { name: "Binding-stale current step", version: "1.0.0", description: "Recovery" },
        nodes: [
          { type: "start", id: "start", connections: { default: "task" } },
          {
            type: "agent-directive",
            id: "task",
            directive: "Current task",
            completionCondition: "Done",
            connections: { success: "end" },
          },
          { type: "end", id: "end" },
        ],
      };
      const saved = await getWorkflowService().save({
        graph: workflow,
        userId: TEST_USER_ID,
        visibility: "private",
      });
      const graph = (await repository.getWorkflowGraph(saved.id, TEST_USER_ID))!;
      const executor = new (await import("@mcp-moira/workflow-engine")).UniversalGraphExecutor(
        repository,
      );
      const executionId = await executor.startWorkflow(graph, undefined, TEST_USER_ID);
      await executor.executeStep(executionId);
      const execution = (await repository.getExecution(executionId))!;
      const stale = new ExecutionMutationCoordinator(repository).newPresentedAttempt(
        execution,
        graph,
        null,
      );
      Object.assign(stale, patch);
      await repository.createPresentedExecutionAttempt(stale);
      MCPEngine.getInstance(repository);

      const result = await requestContext.run({ userId: TEST_USER_ID }, () =>
        getSessionInfo({ action: "current_step", executionId }),
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain("CURRENT_PRESENTATION_STALE");
      expect(result.error).toContain("Do not use or retry that attempt");
      expect(result.error).not.toContain("legacy execution");
      expect(result.error).not.toContain(`Step attempt ID: ${stale.attemptId}`);

      await repository.deleteExecution(executionId);
      await repository.deleteWorkflow(saved.id, TEST_USER_ID);
    },
  );

  test("a public variable write preserves the presented attempt and step revision", async () => {
    const workflow: WorkflowGraph = {
      id: `test-variable-attempt-${Date.now()}`,
      metadata: { name: "Variable attempt", version: "1.0.0", description: "Recovery" },
      variableRegistry: {
        editable: { type: "string", description: "Editable", default: "old" },
      },
      runtimePolicy: { externalVariableWrites: { editable: { allowedNodeIds: ["task"] } } },
      nodes: [
        { type: "start", id: "start", connections: { default: "task" } },
        {
          type: "agent-directive",
          id: "task",
          directive: "Finish",
          completionCondition: "Done",
          connections: { success: "end" },
        },
        { type: "end", id: "end" },
      ],
    };
    const saved = await getWorkflowService().save({
      graph: workflow,
      userId: TEST_USER_ID,
      visibility: "private",
    });
    const graph = (await repository.getWorkflowGraph(saved.id, TEST_USER_ID))!;
    const engine = MCPEngine.getInstance(repository);
    const executionId = await engine.executor.startWorkflow(graph, undefined, TEST_USER_ID);
    const presentation = await engine.executor.executeStep(executionId, undefined, undefined, {
      userId: TEST_USER_ID,
      createPresentation: true,
    });
    const attemptId = presentation.match(/Step attempt ID:\s*([a-f0-9-]+)/i)?.[1];
    const before = (await repository.getExecution(executionId))!;

    const variables = await requestContext.run({ userId: TEST_USER_ID }, () =>
      getSessionInfo({ action: "variables", executionId }),
    );
    const queried = variables.data as { revision: number; contextRevision: string };
    const changed = await requestContext.run({ userId: TEST_USER_ID }, () =>
      getSessionInfo({
        action: "set-variable",
        executionId,
        variableName: "editable",
        variableValue: "new",
        expectedRevision: queried.revision,
        expectedContextRevision: queried.contextRevision,
      }),
    );
    expect(changed).toMatchObject({
      success: true,
      data: { revision: before.revision, value: "new" },
    });
    expect((await repository.getExecution(executionId))?.revision).toBe(before.revision);
    expect(
      (await repository.getCurrentExecutionAttempt(executionId, TEST_USER_ID))?.attemptId,
    ).toBe(attemptId);

    await expect(
      requestContext.run({ userId: TEST_USER_ID }, () =>
        executeStep({ processId: executionId, attemptId: attemptId!, input: {} }),
      ),
    ).resolves.toMatchObject({ success: true, data: expect.stringContaining("completed") });

    await repository.deleteExecution(executionId);
    await repository.deleteWorkflow(saved.id, TEST_USER_ID);
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
