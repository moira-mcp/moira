/**
 * Reusable Mock Helpers for Consistent Test Mocking
 * Stage 13: MockEngine References Complete Fix
 */

import { jest } from "@jest/globals";
import { IGraphStorage, WorkflowGraph } from "@mcp-moira/workflow-engine";
import { AgentMessageQueue } from "@mcp-moira/workflow-engine";

/**
 * Create standardized mock storage for consistent testing
 */
export function createMockStorage(): IGraphStorage {
  return {
    getWorkflow: jest
      .fn<(workflowId: string) => Promise<WorkflowGraph | null>>()
      .mockResolvedValue({
        id: "test-workflow",
        metadata: { name: "Test", version: "1.0.0", description: "Test workflow" },
        nodes: [
          { type: "start", id: "start", connections: { default: "end" } },
          { type: "end", id: "end" },
        ],
      }),
    saveWorkflow: jest.fn<(graph: WorkflowGraph) => Promise<void>>(),
    listWorkflows: jest.fn<() => Promise<WorkflowGraph[]>>(),
    getExecution: jest.fn(),
    saveExecution: jest.fn(),
    deleteExecution: jest.fn(),
    listExecutions: jest.fn(),
    getWorkflowWithValidation: jest.fn(),
    listWorkflowsWithValidation: jest.fn(),
  } as IGraphStorage;
}

// createMockEngine УДАЛЕН - используй только real GraphExecutionEngine!

/**
 * Create mock message queue for testing
 */
export function createMockMessageQueue(): AgentMessageQueue {
  return new AgentMessageQueue();
}

/**
 * Create standardized execution context for testing
 */
export function createTestExecutionContext(overrides?: Partial<any>): any {
  return {
    variables: {},
    nodeStates: {},
    executionId: "test-execution",
    workflowId: "test-workflow",
    ...overrides,
  };
}

/**
 * Real engine helpers for 6-parameter handler interface testing - NO MOCKS!
 */
export class HandlerTestHelpers {
  static storage = createMockStorage();
  static messageQueue = createMockMessageQueue();
  static context = createTestExecutionContext();

  /**
   * Create real engine for testing
   */
  static async createRealEngine() {
    const { GraphExecutionEngine } = await import("@mcp-moira/workflow-engine");
    return new GraphExecutionEngine(this.storage);
  }

  /**
   * Reset all mocks for clean test state
   */
  static resetMocks() {
    jest.clearAllMocks();
    this.messageQueue = createMockMessageQueue();
    this.context = createTestExecutionContext();
  }

  /**
   * Execute handler with real engine - 6-parameter interface
   */
  static async executeHandler(handler: any, node: any, input?: unknown, contextOverrides?: any) {
    const testContext = { ...this.context, ...contextOverrides };
    const realEngine = this.createRealEngine();
    return handler.execute(node, testContext, this.messageQueue, this.storage, realEngine, input);
  }
}
