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
 * - step() blocked when an owner-created lock is active
 * - MCP session tool lock enrichment (executions + execution_context)
 */

import { describe, test, expect, beforeAll, afterAll } from "@jest/globals";
import {
  createAuthenticatedMCPClient,
  callMCPTool,
  callMCPToolRaw,
  createTestUserViaApi,
  signInUser,
} from "../utils/mcp-auth.js";
import { getTestFetchUrl } from "../utils/test-config.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

const LOCK_TOOL_USER_EMAIL = `lock-tool-${Date.now()}@test.local`;
const LOCK_TOOL_USER_PASSWORD = "LockToolTest123!";
let lockToolUserSetup: Promise<void> | undefined;

function ensureLockToolUser(baseUrl: string): Promise<void> {
  lockToolUserSetup ??= createTestUserViaApi(
    baseUrl,
    LOCK_TOOL_USER_EMAIL,
    LOCK_TOOL_USER_PASSWORD,
    "Lock Tool Test User",
  ).then(() => undefined);
  return lockToolUserSetup;
}

function sessionCookieHeader(baseUrl: string, sessionCookie: string): string {
  const cookieName = baseUrl.startsWith("https://")
    ? "__Secure-better-auth.session_token"
    : "better-auth.session_token";
  return `${cookieName}=${sessionCookie}`;
}

async function deleteOwnedWorkflows(workflowIds: string[], sessionCookie: string): Promise<void> {
  const baseUrl = getTestFetchUrl();
  for (const workflowId of workflowIds) {
    const response = await fetch(`${baseUrl}/api/workflows/${workflowId}`, {
      method: "DELETE",
      headers: { Cookie: sessionCookieHeader(baseUrl, sessionCookie) },
    });
    if (!response.ok && response.status !== 404) {
      throw new Error(`Failed to clean workflow ${workflowId}: ${response.status}`);
    }
  }
}

async function unlockOwnedLocks(
  locks: Array<{ executionId: string; lockId: string }>,
  sessionCookie: string,
): Promise<void> {
  const baseUrl = getTestFetchUrl();
  for (const lock of locks) {
    const response = await fetch(
      `${baseUrl}/api/executions/${lock.executionId}/locks/${lock.lockId}/unlock`,
      {
        method: "POST",
        headers: { Cookie: sessionCookieHeader(baseUrl, sessionCookie) },
      },
    );
    if (!response.ok) {
      throw new Error(`Failed to clean lock ${lock.lockId}: ${response.status}`);
    }
  }
}

/**
 * Build a workflow with a lock node for testing.
 */
function buildWaitingWorkflow() {
  return {
    metadata: {
      name: `Lock Tool Test Workflow ${Date.now()}`,
      version: "1.0.0",
      description: "Tests MCP lock tool actions",
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
        directive: "Wait here",
        completionCondition: "Done",
        connections: { success: "end-ok" },
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
  let sessionCookie = "";
  const workflowIds: string[] = [];
  const createdLocks: Array<{ executionId: string; lockId: string }> = [];

  beforeAll(async () => {
    const baseUrl = getTestFetchUrl();
    await ensureLockToolUser(baseUrl);
    const mcpClient = await createAuthenticatedMCPClient({
      email: LOCK_TOOL_USER_EMAIL,
      password: LOCK_TOOL_USER_PASSWORD,
    });
    client = mcpClient.client;
    cleanup = mcpClient.cleanup;
    sessionCookie = await signInUser(baseUrl, LOCK_TOOL_USER_EMAIL, LOCK_TOOL_USER_PASSWORD);
  });

  afterAll(async () => {
    await unlockOwnedLocks(createdLocks, sessionCookie);
    await deleteOwnedWorkflows(workflowIds, sessionCookie);
    await cleanup();
  });

  /** Helper: create and start a workflow that pauses at an agent step. */
  async function createUnlockedExecution(): Promise<{ processId: string; workflowId: string }> {
    const result = await callMCPTool(client, "manage", {
      action: "create",
      workflow: buildWaitingWorkflow(),
    });
    const workflowId = result.workflowId;
    workflowIds.push(workflowId);

    const startRaw = await callMCPToolRaw(client, "start", {
      workflowId,
      parentExecutionId: "none",
    });

    const processIdMatch = startRaw.match(/Process ID:\s*([a-f0-9-]+)/i);
    expect(processIdMatch).not.toBeNull();
    const processId = processIdMatch![1];

    return { processId, workflowId };
  }

  async function createLockedExecution(): Promise<{
    processId: string;
    workflowId: string;
    pin: string;
  }> {
    const execution = await createUnlockedExecution();
    const baseUrl = getTestFetchUrl();
    const response = await fetch(`${baseUrl}/api/executions/${execution.processId}/lock`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: sessionCookieHeader(baseUrl, sessionCookie),
      },
      body: JSON.stringify({ reason: "Testing lock tool actions" }),
    });
    expect(response.ok).toBe(true);
    const body = (await response.json()) as { data: { lockId: string; pin: string } };
    expect(body.data.pin).toMatch(/^\d{6}$/);
    createdLocks.push({ executionId: execution.processId, lockId: body.data.lockId });
    return { ...execution, pin: body.data.pin };
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
      expect(result.lock.nodeId).toBe("step1");
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
      workflowIds.push(createResult.workflowId);

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
      expect(activeLock.nodeId).toBe("step1");
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
    test("fails closed when trusted Telegram delivery is unavailable", async () => {
      const { processId } = await createUnlockedExecution();

      await callMCPToolRaw(client, "settings", {
        action: "set",
        key: "telegram.bot_token",
        value: "malformed-token",
      });
      await callMCPToolRaw(client, "settings", {
        action: "set",
        key: "telegram.chat_id",
        value: "12345",
      });

      const result = await callMCPToolRaw(client, "lock", {
        action: "lock",
        executionId: processId,
        reason: "Agent review needed",
      });

      expect(result).toContain("Trusted Telegram PIN delivery");
      expect(result).not.toMatch(/\b\d{6}\b/);

      const status = await callMCPTool(client, "lock", {
        action: "status",
        executionId: processId,
      });
      expect(status.locked).toBe(false);
    });

    test("prevents double-locking", async () => {
      const { processId } = await createLockedExecution();

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

    test("step() is blocked when an owner-created lock is active", async () => {
      const { processId } = await createLockedExecution();

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
  let sessionCookie = "";
  const workflowIds: string[] = [];
  const createdLocks: Array<{ executionId: string; lockId: string }> = [];

  beforeAll(async () => {
    const baseUrl = getTestFetchUrl();
    await ensureLockToolUser(baseUrl);
    const mcpClient = await createAuthenticatedMCPClient({
      email: LOCK_TOOL_USER_EMAIL,
      password: LOCK_TOOL_USER_PASSWORD,
    });
    client = mcpClient.client;
    cleanup = mcpClient.cleanup;
    sessionCookie = await signInUser(baseUrl, LOCK_TOOL_USER_EMAIL, LOCK_TOOL_USER_PASSWORD);
  });

  afterAll(async () => {
    await unlockOwnedLocks(createdLocks, sessionCookie);
    await deleteOwnedWorkflows(workflowIds, sessionCookie);
    await cleanup();
  });

  /**
   * Helper: create locked execution
   */
  async function createLockedExecution(): Promise<string> {
    const createResult = await callMCPTool(client, "manage", {
      action: "create",
      workflow: buildWaitingWorkflow(),
    });
    workflowIds.push(createResult.workflowId);

    const startRaw = await callMCPToolRaw(client, "start", {
      workflowId: createResult.workflowId,
      parentExecutionId: "none",
    });

    const match = startRaw.match(/Process ID:\s*([a-f0-9-]+)/i);
    expect(match).not.toBeNull();
    const processId = match![1];
    const baseUrl = getTestFetchUrl();
    const response = await fetch(`${baseUrl}/api/executions/${processId}/lock`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: sessionCookieHeader(baseUrl, sessionCookie),
      },
      body: JSON.stringify({ reason: "Session enrichment" }),
    });
    expect(response.ok).toBe(true);
    const body = (await response.json()) as { data: { lockId: string } };
    createdLocks.push({ executionId: processId, lockId: body.data.lockId });
    return processId;
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
      expect(result).toContain("step1");
    });
  });
});
