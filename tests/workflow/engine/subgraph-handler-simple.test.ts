/**
 * Simple SubgraphNodeHandler tests with proper mocks
 * Focus on basic functionality validation
 */

import { describe, test, expect, beforeEach, jest } from "@jest/globals";
import {
  SubgraphNodeHandler,
  IGraphExecutionEngine,
  IDataRepository,
  AgentMessageQueue,
  SubgraphNode,
  ExecutionContext,
  WorkflowGraph,
} from "@mcp-moira/workflow-engine";

describe("SubgraphNodeHandler - Basic Tests", () => {
  let handler: SubgraphNodeHandler;
  let mockRepository: IDataRepository;
  let mockEngine: IGraphExecutionEngine;

  beforeEach(() => {
    // Create simple mock repository with proper typing
    mockRepository = {
      getWorkflowGraph: jest
        .fn<(workflowId: string, userId: string) => Promise<WorkflowGraph | null>>()
        .mockResolvedValue({
          id: "child-workflow",
          metadata: { name: "Child", version: "1.0.0", description: "Test" },
          nodes: [
            { type: "start", id: "start", connections: { default: "end" } },
            { type: "end", id: "end" },
          ],
        }),
      getWorkflow: jest.fn(),
      saveWorkflow: jest.fn(),
      listWorkflows: jest.fn(),
      deleteWorkflow: jest.fn(),
      getExecution: jest.fn(),
      saveExecution: jest.fn(),
      deleteExecution: jest.fn(),
      listExecutions: jest.fn(),
      listUserExecutions: jest.fn(),
    } as IDataRepository;

    // Create mock engine with proper typing
    mockEngine = {
      executeGraph: jest.fn<() => Promise<any>>().mockResolvedValue({
        action: "complete",
        context: {
          variables: { result: "child completed" },
          nodeStates: {},
          executionId: "child-exec",
          workflowId: "child-workflow",
        },
      }),
    } as IGraphExecutionEngine;

    handler = new SubgraphNodeHandler();
  });

  test("should return correct node type", () => {
    expect(handler.getNodeType()).toBe("subgraph");
  });

  test("should validate subgraph node type", async () => {
    const invalidNode = {
      type: "start",
      id: "start",
      connections: { default: "next" },
    };

    const context: ExecutionContext = {
      variables: {},
      nodeStates: {},
      executionId: "test",
      workflowId: "test",
      userId: "test-user-123",
    };

    const mockQueue = new AgentMessageQueue();

    await expect(
      handler.execute(
        invalidNode as any,
        context,
        mockQueue,
        mockRepository,
        mockEngine,
        undefined,
      ),
    ).rejects.toThrow("SubgraphNodeHandler can only execute subgraph nodes");
  });

  test("should handle basic subgraph execution", async () => {
    const subgraphNode: SubgraphNode = {
      type: "subgraph",
      id: "test-subgraph",
      graphId: "child-workflow",
      inputMapping: {},
      outputMapping: {},
      connections: {
        success: "next-node",
      },
    };

    const context: ExecutionContext = {
      variables: {},
      nodeStates: {},
      executionId: "parent-exec",
      workflowId: "parent-workflow",
      userId: "test-user-123",
    };

    const result = await handler.execute(
      subgraphNode,
      context,
      new AgentMessageQueue(),
      mockRepository,
      mockEngine,
      undefined,
    );

    expect(result.action).toBe("continue"); // Child completes immediately
    expect(result.outputPath).toBe("success");
    expect(mockEngine.executeGraph).toHaveBeenCalled();
    expect(mockRepository.getWorkflowGraph).toHaveBeenCalledWith("child-workflow", "test-user-123");
  });

  test("should handle missing target workflow", async () => {
    const subgraphNode: SubgraphNode = {
      type: "subgraph",
      id: "test-subgraph",
      graphId: "missing-workflow",
      inputMapping: {},
      outputMapping: {},
      connections: {
        success: "next-node",
      },
    };

    const context: ExecutionContext = {
      variables: {},
      nodeStates: {},
      executionId: "test",
      workflowId: "test",
      userId: "test-user-123",
    };

    // Mock storage returns null for missing workflow
    (
      mockRepository.getWorkflowGraph as jest.Mock<
        (workflowId: string, userId: string) => Promise<WorkflowGraph | null>
      >
    ).mockResolvedValueOnce(null);

    await expect(
      handler.execute(
        subgraphNode,
        context,
        new AgentMessageQueue(),
        mockRepository,
        mockEngine,
        undefined,
      ),
    ).rejects.toThrow("Workflow 'missing-workflow' not found");
  });

  test("should handle subprocess continuation", async () => {
    const subgraphNode: SubgraphNode = {
      type: "subgraph",
      id: "test-subgraph",
      graphId: "child-workflow",
      inputMapping: {},
      outputMapping: {},
      connections: {
        success: "next-node",
      },
    };

    // Context with active subprocess
    const context: ExecutionContext = {
      variables: {
        _activeSubprocess: {
          subgraphNodeId: "test-subgraph",
          childExecutionId: "child-exec",
          childWorkflowId: "child-workflow",
          childContext: {
            variables: {},
            nodeStates: {},
            executionId: "child-exec",
            workflowId: "child-workflow",
          },
          targetWorkflow: {
            id: "child-workflow",
            metadata: { name: "Child", version: "1.0.0", description: "Test" },
            nodes: [
              { type: "start", id: "start", connections: { default: "end" } },
              { type: "end", id: "end" },
            ],
          },
        },
      },
      nodeStates: {},
      executionId: "parent-exec",
      workflowId: "parent-workflow",
      userId: "test-user-123",
    };

    const result = await handler.execute(
      subgraphNode,
      context,
      new AgentMessageQueue(),
      mockRepository,
      mockEngine,
      { input: "test" },
    );

    expect(result.action).toBe("continue"); // Subprocess completes
    expect(mockEngine.executeGraph).toHaveBeenCalled();
  });
});
