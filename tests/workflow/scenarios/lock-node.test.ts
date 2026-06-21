/**
 * Lock Node Scenario Tests
 *
 * Tests the lock node type that creates PIN-based execution gates.
 * Uses a mock LockHandler (injected via engineSetup) to avoid DB dependencies.
 *
 * Paths:
 *   start → lock-gate →
 *     (unlocked): end-success
 *
 * Coverage: lock creation, PIN unlock flows
 */

import { runScenario, type TestScenario } from "../../helpers/scenario-runner.js";
import type { WorkflowGraph, GraphNode, ExecutionContext } from "@mcp-moira/workflow-engine";
import type { INodeHandler } from "@mcp-moira/workflow-engine";
import type { IDataRepository } from "@mcp-moira/workflow-engine";
import type { IGraphExecutionEngine } from "@mcp-moira/workflow-engine";
import type { AgentMessageQueue } from "@mcp-moira/workflow-engine";

interface NodeExecutionResult {
  nodeId: string;
  action: "continue" | "pause" | "error" | "complete";
  outputPath?: string;
  data?: Record<string, unknown>;
  error?: string;
}

/**
 * Mock LockHandler for scenario tests.
 * Simulates lock lifecycle without DB dependencies.
 * First visit: pauses (lock created). Second visit: checks PIN from input.
 */
class MockLockHandler implements INodeHandler {
  private lockStates = new Map<string, { status: string }>();

  getNodeType(): string {
    return "lock";
  }

  canExecute(node: GraphNode): boolean {
    return node.type === "lock";
  }

  async execute(
    node: GraphNode,
    context: ExecutionContext,
    messageQueue: AgentMessageQueue,
    _repository: IDataRepository,
    _engine: IGraphExecutionEngine,
    input?: unknown,
  ): Promise<NodeExecutionResult> {
    const lockNode = node as GraphNode & {
      reason: string;
      connections: { unlocked: string };
    };

    const lockKey = `${context.executionId}:${node.id}`;
    const existingLock = this.lockStates.get(lockKey);

    if (!existingLock) {
      // First visit: create lock, store state, pause
      this.lockStates.set(lockKey, { status: "active" });
      context.variables["_lockId"] = `mock-lock-${lockKey}`;
      messageQueue.addNotification(
        node.id,
        `Execution locked: ${lockNode.reason}. PIN sent via Telegram. Provide PIN via step(processId, { pin: "YOUR_PIN" }) or wait for Telegram approval.`,
        "lock_created",
      );
      return {
        nodeId: node.id,
        action: "pause",
        data: {
          lockId: `mock-lock-${lockKey}`,
          lockStatus: "active",
          reason: lockNode.reason,
          message: "Execution locked. PIN sent via Telegram. Provide PIN to unlock.",
        },
      };
    }

    // Subsequent visit: check input
    if (input && typeof input === "object" && "pin" in input) {
      const pin = String((input as Record<string, unknown>).pin);

      // Simulate PIN validation: "123456" is the correct PIN
      if (pin === "123456") {
        existingLock.status = "unlocked";
        return {
          nodeId: node.id,
          action: "continue",
          outputPath: "unlocked",
          data: { lockResolution: "unlocked", lockId: `mock-lock-${lockKey}` },
        };
      }

      // Wrong PIN — still active, retry
      messageQueue.addNotification(
        node.id,
        `Invalid PIN. Provide PIN via step(processId, { pin: "YOUR_PIN" }).`,
        "pin_invalid",
      );
      return {
        nodeId: node.id,
        action: "pause",
        data: {
          lockId: `mock-lock-${lockKey}`,
          lockStatus: "active",
          message: "Invalid PIN. Try again.",
        },
      };
    }

    // No input — still waiting
    messageQueue.addNotification(
      node.id,
      `Execution locked. Provide PIN via step(processId, { pin: "YOUR_PIN" }) or wait for Telegram approval.`,
      "lock_active",
    );
    return {
      nodeId: node.id,
      action: "pause",
      data: {
        lockId: `mock-lock-${lockKey}`,
        lockStatus: "active",
        message: "Waiting for PIN validation or lock resolution",
      },
    };
  }
}

/**
 * Build a test workflow with a lock node and one end state (unlocked)
 */
function buildLockWorkflow(): WorkflowGraph {
  return {
    metadata: { name: "Lock Test Workflow", version: "1.0.0", description: "Tests lock node" },
    nodes: [
      {
        type: "start",
        id: "start",
        connections: { default: "lock-gate" },
      },
      {
        type: "lock",
        id: "lock-gate",
        reason: "Approval required for deployment",
        connections: {
          unlocked: "end-success",
        },
      },
      {
        type: "end",
        id: "end-success",
        finalOutput: ["lockResolution"],
      },
    ] as unknown as WorkflowGraph["nodes"],
  };
}

function createMockLockHandler(): MockLockHandler {
  return new MockLockHandler();
}

describe("Lock Node Scenarios", () => {
  describe("Unlock flow (correct PIN)", () => {
    it("should create lock, pause, then unlock on correct PIN", async () => {
      const workflow = buildLockWorkflow();
      const scenario: TestScenario = {
        name: "Correct PIN unlock",
        description: "Lock pauses execution, then correct PIN unlocks and continues",
        mockInputs: {
          "lock-gate": { pin: "123456" },
        },
        expect: {
          status: "completed",
          reaches: ["lock-gate", "end-success"],
        },
      };

      const result = await runScenario(workflow, scenario, {
        engineSetup: (engine) => {
          const handlers = (engine as any).nodeHandlers as Map<string, any>;
          handlers.set("lock", createMockLockHandler());
        },
      });

      expect(result.passed).toBe(true);
      if (!result.passed) {
        console.error("FAILED:", result.scenario, result.error, result.failedExpectations);
      }
    });
  });

  describe("Wrong PIN keeps lock active", () => {
    it("should not reject on wrong PIN (no max attempts)", async () => {
      const workflow = buildLockWorkflow();

      // Array inputs cycle by visit count:
      // Visit 0: lock created (input ignored), Visit 1: wrong PIN, Visit 2: correct PIN
      const scenario: TestScenario = {
        name: "Wrong then correct PIN",
        description: "Wrong PIN keeps lock active, correct PIN unlocks",
        mockInputs: {
          "lock-gate": [
            { pin: "ignored" }, // Visit 0: lock creation (input not checked)
            { pin: "999999" }, // Visit 1: wrong PIN
            { pin: "123456" }, // Visit 2: correct PIN
          ],
        },
        expect: {
          status: "completed",
          reaches: ["lock-gate", "end-success"],
        },
      };

      const result = await runScenario(workflow, scenario, {
        engineSetup: (engine) => {
          const handlers = (engine as any).nodeHandlers as Map<string, any>;
          handlers.set("lock", createMockLockHandler());
        },
      });

      expect(result.passed).toBe(true);
      if (!result.passed) {
        console.error("FAILED:", result.scenario, result.error, result.failedExpectations);
      }
    });
  });

  describe("Context variables", () => {
    it("should store _lockId in context after lock creation", async () => {
      const workflow = buildLockWorkflow();
      const scenario: TestScenario = {
        name: "Context lockId storage",
        description: "Lock stores _lockId in context for persistence across pauses",
        mockInputs: {
          "lock-gate": { pin: "123456" },
        },
        expect: {
          status: "completed",
          reaches: ["lock-gate", "end-success"],
        },
      };

      const result = await runScenario(workflow, scenario, {
        engineSetup: (engine) => {
          const handlers = (engine as any).nodeHandlers as Map<string, any>;
          handlers.set("lock", createMockLockHandler());
        },
      });

      expect(result.passed).toBe(true);
      if (!result.passed) {
        console.error("FAILED:", result.scenario, result.error, result.failedExpectations);
      }
      // Verify _lockId was stored in context
      expect(result.finalContext._lockId).toBeDefined();
      expect(typeof result.finalContext._lockId).toBe("string");
      expect((result.finalContext._lockId as string).startsWith("mock-lock-")).toBe(true);
    });
  });
});
