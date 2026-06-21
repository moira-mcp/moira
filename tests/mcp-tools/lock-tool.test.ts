/**
 * MCP Lock Tool Tests
 *
 * Tests the MCP "lock" tool (manage-locks.ts) actions:
 * - lock: programmatically create a lock on a running execution
 * - status: check if execution has active lock
 * - list: list all locks for execution
 * - unlock: validate PIN and unlock
 *
 * Also tests:
 * - step() blocked when agent-created lock is active
 * - MCP session tool lock enrichment (executions + execution_context)
 */

import { describe, test, expect, beforeAll, afterAll } from "@jest/globals";
import { createAuthenticatedMCPClient, callMCPTool, callMCPToolRaw } from "../utils/mcp-auth.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

/**
 * Build a workflow with a lock node for testing.
 */
function buildLockWorkflow() {
  return {
    metadata: {
      name: "Lock Tool Test Workflow",
      version: "1.0.0",
      description: "Tests MCP lock tool actions",
    },
    nodes: [
      {
        type: "start",
        id: "start",
        connections: { default: "lock-gate" },
      },
      {
        type: "lock",
        id: "lock-gate",
        reason: "Testing lock tool actions",
        connections: {
          unlocked: "end-ok",
        },
      },
      {
        type: "end",
        id: "end-ok",
        finalOutput: ["lockResolution"],
      },
    ],
  };
}

describe("MCP Lock Tool", () => {
  let client: Client;
  let cleanup: () => Promise<void>;

  beforeAll(async () => {
    const mcpClient = await createAuthenticatedMCPClient();
    client = mcpClient.client;
    cleanup = mcpClient.cleanup;
  });

  afterAll(async () => {
    await cleanup();
  });

  /**
   * Helper: create and start a workflow that pauses at lock node
   */
  async function createLockedExecution(): Promise<{ processId: string; workflowId: string }> {
    const result = await callMCPTool(client, "manage", {
      action: "create",
      workflow: buildLockWorkflow(),
    });
    const workflowId = result.workflowId;

    const startRaw = await callMCPToolRaw(client, "start", {
      workflowId,
      parentExecutionId: "none",
    });

    const processIdMatch = startRaw.match(/Process ID:\s*([a-f0-9-]+)/i);
    expect(processIdMatch).not.toBeNull();
    const processId = processIdMatch![1];

    return { processId, workflowId };
  }

  describe("lock tool - status action", () => {
    test("returns locked=true for execution with active lock", async () => {
      const { processId } = await createLockedExecution();

      const result = await callMCPTool(client, "lock", {
        action: "status",
        executionId: processId,
      });

      expect(result.locked).toBe(true);
      expect(result.lock).toBeDefined();
      expect(result.lock.executionId).toBe(processId);
      expect(result.lock.nodeId).toBe("lock-gate");
      expect(result.lock.reason).toBe("Testing lock tool actions");
      expect(result.lock.status).toBe("active");
      expect(result.lock.lockId).toBeDefined();
      expect(result.lock.createdAt).toBeDefined();
    });

    test("returns locked=false for execution without lock", async () => {
      // Create a simple workflow without lock node
      const simpleWorkflow = {
        metadata: {
          name: "No Lock Workflow",
          version: "1.0.0",
          description: "No lock node",
        },
        nodes: [
          { type: "start", id: "start", connections: { default: "step1" } },
          {
            type: "agent-directive",
            id: "step1",
            directive: "Do something",
            completionCondition: "Done",
            connections: { success: "end" },
          },
          { type: "end", id: "end" },
        ],
      };

      const createResult = await callMCPTool(client, "manage", {
        action: "create",
        workflow: simpleWorkflow,
      });

      const startRaw = await callMCPToolRaw(client, "start", {
        workflowId: createResult.workflowId,
        parentExecutionId: "none",
      });
      const processIdMatch = startRaw.match(/Process ID:\s*([a-f0-9-]+)/i);
      const processId = processIdMatch![1];

      const result = await callMCPTool(client, "lock", {
        action: "status",
        executionId: processId,
      });

      expect(result.locked).toBe(false);
      expect(result.lock).toBeUndefined();
    });
  });

  describe("lock tool - list action", () => {
    test("lists locks for execution with active lock", async () => {
      const { processId } = await createLockedExecution();

      const result = await callMCPTool(client, "lock", {
        action: "list",
        executionId: processId,
      });

      expect(result.locks).toBeDefined();
      expect(Array.isArray(result.locks)).toBe(true);
      expect(result.total).toBeGreaterThanOrEqual(1);

      const activeLock = result.locks.find((l: { status: string }) => l.status === "active");
      expect(activeLock).toBeDefined();
      expect(activeLock.nodeId).toBe("lock-gate");
      expect(activeLock.reason).toBe("Testing lock tool actions");
    });
  });

  describe("lock tool - unlock action", () => {
    test("rejects invalid PIN", async () => {
      const { processId } = await createLockedExecution();

      const result = await callMCPToolRaw(client, "lock", {
        action: "unlock",
        executionId: processId,
        pin: "000000",
      });

      // Should fail with invalid PIN
      expect(result).toContain("Invalid PIN");
    });

    test("requires PIN parameter", async () => {
      const { processId } = await createLockedExecution();

      const result = await callMCPToolRaw(client, "lock", {
        action: "unlock",
        executionId: processId,
      });

      expect(result).toContain("PIN is required");
    });
  });

  describe("lock tool - lock (create) action", () => {
    /**
     * Helper: create an execution that pauses at an agent-directive node (no lock node)
     */
    async function createUnlockedExecution(): Promise<{ processId: string }> {
      const simpleWorkflow = {
        metadata: {
          name: "Agent Lock Test Workflow",
          version: "1.0.0",
          description: "For testing agent-created locks",
        },
        nodes: [
          { type: "start", id: "start", connections: { default: "step1" } },
          {
            type: "agent-directive",
            id: "step1",
            directive: "Wait here",
            completionCondition: "Done",
            connections: { success: "end" },
          },
          { type: "end", id: "end" },
        ],
      };

      const createResult = await callMCPTool(client, "manage", {
        action: "create",
        workflow: simpleWorkflow,
      });

      const startRaw = await callMCPToolRaw(client, "start", {
        workflowId: createResult.workflowId,
        parentExecutionId: "none",
      });

      const processIdMatch = startRaw.match(/Process ID:\s*([a-f0-9-]+)/i);
      expect(processIdMatch).not.toBeNull();
      return { processId: processIdMatch![1] };
    }

    test("creates a lock on a running execution", async () => {
      const { processId } = await createUnlockedExecution();

      const result = await callMCPTool(client, "lock", {
        action: "lock",
        executionId: processId,
        reason: "Agent review needed",
      });

      expect(result.lockId).toBeDefined();
      expect(result.pin).toBeUndefined();
      expect(result.locked).toBe(true);

      // Verify lock status
      const status = await callMCPTool(client, "lock", {
        action: "status",
        executionId: processId,
      });
      expect(status.locked).toBe(true);
      expect(status.lock.reason).toBe("Agent review needed");
    });

    test("prevents double-locking", async () => {
      const { processId } = await createUnlockedExecution();

      // First lock succeeds
      await callMCPTool(client, "lock", {
        action: "lock",
        executionId: processId,
        reason: "First lock",
      });

      // Second lock fails
      const result = await callMCPToolRaw(client, "lock", {
        action: "lock",
        executionId: processId,
        reason: "Second lock",
      });
      expect(result).toContain("already has an active lock");
    });

    test("requires reason parameter", async () => {
      const { processId } = await createUnlockedExecution();

      const result = await callMCPToolRaw(client, "lock", {
        action: "lock",
        executionId: processId,
      });
      expect(result).toContain("reason is required");
    });

    test("step() is blocked when agent-created lock is active", async () => {
      const { processId } = await createUnlockedExecution();

      // Create a lock
      await callMCPTool(client, "lock", {
        action: "lock",
        executionId: processId,
        reason: "Block steps",
      });

      // Try to execute step — should be blocked
      const stepResult = await callMCPToolRaw(client, "step", {
        processId,
        input: "anything",
      });
      expect(stepResult).toContain("locked");
      expect(stepResult).toContain("unlock");
    });
  });
});

describe("MCP Session Lock Enrichment", () => {
  let client: Client;
  let cleanup: () => Promise<void>;

  beforeAll(async () => {
    const mcpClient = await createAuthenticatedMCPClient();
    client = mcpClient.client;
    cleanup = mcpClient.cleanup;
  });

  afterAll(async () => {
    await cleanup();
  });

  /**
   * Helper: create locked execution
   */
  async function createLockedExecution(): Promise<string> {
    const workflow = buildLockWorkflow();
    const createResult = await callMCPTool(client, "manage", {
      action: "create",
      workflow,
    });

    const startRaw = await callMCPToolRaw(client, "start", {
      workflowId: createResult.workflowId,
      parentExecutionId: "none",
    });

    const match = startRaw.match(/Process ID:\s*([a-f0-9-]+)/i);
    expect(match).not.toBeNull();
    return match![1];
  }

  describe("session executions - locked status", () => {
    test("locked execution shows status 'locked' in executions list", async () => {
      const processId = await createLockedExecution();

      const result = await callMCPTool(client, "session", {
        action: "executions",
        status: ["locked"],
      });

      expect(result.executions).toBeDefined();
      // Find our execution in the list
      const found = result.executions.find(
        (e: { executionId: string }) => e.executionId === processId,
      );
      expect(found).toBeDefined();
      expect(found.status).toBe("locked");
    });
  });

  describe("session execution_context - locked status and activeLock", () => {
    test("execution_context returns locked status and activeLock object", async () => {
      const processId = await createLockedExecution();

      const result = await callMCPToolRaw(client, "session", {
        action: "execution_context",
        executionId: processId,
      });

      // The execution_context response should contain "locked" status
      expect(result).toContain('"locked"');
      // Should contain activeLock info
      expect(result).toContain("activeLock");
      expect(result).toContain("lockId");
      expect(result).toContain("lock-gate");
    });
  });
});
