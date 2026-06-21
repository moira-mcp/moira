/**
 * MCP Lock Step Integration Tests
 *
 * Tests step() behavior with locked executions at MCP protocol level:
 * - Lock creation pauses with clear agent instructions
 * - Invalid PIN returns error and keeps lock active
 * - Step without PIN on active lock returns lock_active with instructions
 *
 * Lock architecture: simple block/unblock gate with single "unlocked" path.
 * PIN unlock and Telegram approval tested at workflow scenario level
 * (tests/workflow/scenarios/lock-node.test.ts).
 */

import { describe, test, expect, beforeAll, afterAll } from "@jest/globals";
import { createAuthenticatedMCPClient, callMCPToolRaw } from "../utils/mcp-auth.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

/**
 * Build a test workflow with lock node and single unlocked end state.
 */
function buildLockTestWorkflow() {
  return {
    metadata: {
      name: "Lock Step Integration Test",
      version: "1.0.0",
      description: "Tests MCP step() with lock nodes",
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
        reason: "Approval required before proceeding",
        connections: {
          unlocked: "end-success",
        },
      },
      {
        type: "end",
        id: "end-success",
        finalOutput: ["lockResolution"],
      },
    ],
  };
}

describe("MCP Lock Step Integration", () => {
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
   * Helper: create workflow via manage tool
   */
  async function createTestWorkflow(): Promise<string> {
    const workflow = buildLockTestWorkflow();
    const result = await callMCPToolRaw(client, "manage", {
      action: "create",
      workflow,
    });
    // Response is JSON with workflowId
    const parsed = JSON.parse(result);
    return parsed.workflowId;
  }

  /**
   * Helper: start workflow → auto-advances through start → pauses at lock node
   * Returns { processId, response }
   */
  async function startAndGetLockResponse(
    workflowId: string,
  ): Promise<{ processId: string; response: string }> {
    const response = await callMCPToolRaw(client, "start", {
      workflowId,
      parentExecutionId: "none",
      skipTelegramCheck: true,
    });

    const match = response.match(/Process ID: ([a-f0-9-]+)/);
    if (!match) {
      throw new Error(`Could not extract processId from start response: ${response.slice(0, 200)}`);
    }

    return { processId: match[1], response };
  }

  describe("Lock creation via start()", () => {
    test("start() pauses at lock node with agent instructions", async () => {
      const workflowId = await createTestWorkflow();
      const { response } = await startAndGetLockResponse(workflowId);

      expect(response).toContain("Process ID:");
      expect(response).toContain("NOTIFICATION:");
      expect(response).toContain("Execution locked");
      expect(response).toContain("lock_created");
      // Agent should know HOW to provide PIN
      expect(response).toContain("pin");
      expect(response).toContain("step(processId");
    });
  });

  describe("PIN validation via step()", () => {
    test("invalid PIN returns error and keeps lock active", async () => {
      const workflowId = await createTestWorkflow();
      const { processId } = await startAndGetLockResponse(workflowId);

      // Try invalid PIN
      const response = await callMCPToolRaw(client, "step", {
        processId,
        input: { pin: "000000" },
      });

      expect(response).toContain("NOTIFICATION:");
      expect(response).toContain("Invalid PIN");
      expect(response).toContain("pin_invalid");
    });
  });

  describe("Step without PIN on active lock", () => {
    test("step() without PIN returns lock_active with instructions", async () => {
      const workflowId = await createTestWorkflow();
      const { processId } = await startAndGetLockResponse(workflowId);

      // Call step without any input — lock still active
      const response = await callMCPToolRaw(client, "step", { processId });

      expect(response).toContain("Process ID:");
      expect(response).toContain("NOTIFICATION:");
      expect(response).toContain("lock_active");
      expect(response).toContain("pin");
    });
  });

  describe("Malformed Telegram token resilience", () => {
    test("lock step still creates the lock when the user's bot token is malformed", async () => {
      // A lock node sends the PIN via Telegram. Constructing the Telegram client
      // validates the bot-token format and throws on a malformed token. A bad
      // stored token must NOT crash start() — the lock must still be created and
      // the step must pause for PIN entry (PIN remains available via the lock
      // service / Telegram approval).
      try {
        await callMCPToolRaw(client, "settings", {
          action: "set",
          key: "telegram.bot_token",
          value: "not-a-valid-token",
        });
        await callMCPToolRaw(client, "settings", {
          action: "set",
          key: "telegram.chat_id",
          value: "12345",
        });

        const workflowId = await createTestWorkflow();
        const response = await startAndGetLockResponse(workflowId);

        // start() did not crash on the malformed token; lock was created.
        expect(response.response).toContain("Process ID:");
        expect(response.response).toContain("lock_created");
        expect(response.response).not.toContain("Invalid bot token format");
      } finally {
        // Clean up the settings so other suites (which auth as the same admin
        // user) are not affected by a leftover malformed token.
        await callMCPToolRaw(client, "settings", {
          action: "delete",
          key: "telegram.bot_token",
        }).catch(() => undefined);
        await callMCPToolRaw(client, "settings", {
          action: "delete",
          key: "telegram.chat_id",
        }).catch(() => undefined);
      }
    });
  });
});
