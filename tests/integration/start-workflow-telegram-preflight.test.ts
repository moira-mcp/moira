/**
 * Integration tests for Telegram pre-flight check in start-workflow
 * Issue #372: Pre-flight check when starting workflows with telegram nodes
 *
 * Tests with real database:
 * - Workflow with telegram nodes + no telegram settings → synthetic response (no execution created)
 * - Workflow with telegram nodes + skipTelegramCheck → normal start (execution created)
 * - Workflow without telegram nodes → normal start regardless of settings
 * - Workflow with telegram nodes + configured settings → normal start
 */

import { describe, test, expect, beforeAll, afterAll } from "@jest/globals";
import { startWorkflow } from "../../packages/mcp-server/src/tools/start-workflow.js";
import { manageWorkflow } from "../../packages/mcp-server/src/tools/manage-workflow.js";
import { runWithMCPContext } from "../../packages/mcp-server/src/core/request-context.js";
import { DatabaseRepository } from "@mcp-moira/workflow-engine";
import { getDatabase, user } from "@mcp-moira/shared";
import type { WorkflowGraph } from "@mcp-moira/workflow-engine";

const TEST_USER_ID = "test-telegram-preflight";
const TEST_USER_CONFIGURED = "test-telegram-configured";

/** Workflow WITH telegram-notification nodes (public so multiple users can access) */
const workflowWithTelegram: WorkflowGraph = {
  id: "test-telegram-preflight-wf",
  metadata: {
    name: "Telegram Preflight Test",
    version: "1.0.0",
    description: "Workflow with telegram notifications for pre-flight testing",
  },
  variableRegistry: {
    step1_result: { type: "string", description: "Result of step1 for the notification" },
  },
  nodes: [
    { id: "start", type: "start", connections: { default: "step1" } },
    {
      id: "step1",
      type: "agent-directive",
      directive: "Do something",
      completionCondition: "Done",
      connections: { success: "notify" },
    },
    {
      id: "notify",
      type: "telegram-notification",
      message: "Task completed: {{step1_result}}",
      connections: { default: "end" },
    },
    { id: "end", type: "end" },
  ],
};

/** Workflow WITHOUT telegram-notification nodes */
const workflowWithoutTelegram: WorkflowGraph = {
  id: "test-no-telegram-preflight-wf",
  metadata: {
    name: "No Telegram Test",
    version: "1.0.0",
    description: "Workflow without telegram for pre-flight testing",
  },
  nodes: [
    { id: "start", type: "start", connections: { default: "step1" } },
    {
      id: "step1",
      type: "agent-directive",
      directive: "Do something",
      completionCondition: "Done",
      connections: { success: "end" },
    },
    { id: "end", type: "end" },
  ],
};

const workflowWithLock: WorkflowGraph = {
  id: "test-lock-preflight-wf",
  metadata: {
    name: "Lock Preflight Test",
    version: "1.0.0",
    description: "Workflow with mandatory trusted lock delivery",
  },
  nodes: [
    { id: "start", type: "start", connections: { default: "step1" } },
    {
      id: "step1",
      type: "agent-directive",
      directive: "Prepare for the lock.",
      completionCondition: "Ready.",
      connections: { success: "lock-gate" },
    },
    {
      id: "lock-gate",
      type: "lock",
      reason: "Approval required",
      connections: { unlocked: "end" },
    },
    { id: "end", type: "end" },
  ],
};

const workflowWithNotificationAndLock: WorkflowGraph = {
  ...workflowWithLock,
  id: "test-notification-lock-preflight-wf",
  metadata: { ...workflowWithLock.metadata, name: "Notification and Lock Preflight Test" },
  nodes: [
    ...workflowWithLock.nodes.slice(0, 2),
    {
      id: "notify",
      type: "telegram-notification",
      message: "Preparing approval",
      connections: { default: "lock-gate" },
    },
    ...workflowWithLock.nodes.slice(2),
  ],
};

describe("Start Workflow Telegram Pre-flight Check", () => {
  let repository: DatabaseRepository;
  let telegramWorkflowId: string;
  let noTelegramWorkflowId: string;
  let lockWorkflowId: string;
  let combinedWorkflowId: string;

  beforeAll(async () => {
    repository = new DatabaseRepository();
    const db = getDatabase();
    const now = new Date().toISOString();

    // Create test users
    for (const userId of [TEST_USER_ID, TEST_USER_CONFIGURED]) {
      try {
        await db.insert(user).values({
          id: userId,
          email: `${userId}@test.com`,
          name: `Test User ${userId}`,
          handle: userId,
          emailVerified: false,
          createdAt: now,
          updatedAt: now,
        });
      } catch {
        // User might already exist
      }
    }

    // Configure telegram for the "configured" user
    await repository.setSetting(
      TEST_USER_CONFIGURED,
      "telegram.bot_token",
      "123456:test-bot-token-123",
    );
    await repository.setSetting(TEST_USER_CONFIGURED, "telegram.chat_id", "123456789");

    // Create test workflows
    const createResult1 = await runWithMCPContext({ userId: TEST_USER_ID }, async () => {
      return manageWorkflow({
        action: "create",
        workflow: { ...workflowWithTelegram, visibility: "public" },
        overwrite: true,
      });
    });
    telegramWorkflowId = createResult1.data.workflowId;

    const createResult2 = await runWithMCPContext({ userId: TEST_USER_ID }, async () => {
      return manageWorkflow({
        action: "create",
        workflow: workflowWithoutTelegram,
        overwrite: true,
      });
    });
    noTelegramWorkflowId = createResult2.data.workflowId;

    const createResult3 = await runWithMCPContext({ userId: TEST_USER_ID }, async () =>
      manageWorkflow({
        action: "create",
        workflow: { ...workflowWithLock, visibility: "public" },
        overwrite: true,
      }),
    );
    lockWorkflowId = createResult3.data.workflowId;

    const createResult4 = await runWithMCPContext({ userId: TEST_USER_ID }, async () =>
      manageWorkflow({
        action: "create",
        workflow: { ...workflowWithNotificationAndLock, visibility: "public" },
        overwrite: true,
      }),
    );
    combinedWorkflowId = createResult4.data.workflowId;
  });

  afterAll(async () => {
    try {
      await repository.deleteWorkflow(telegramWorkflowId, TEST_USER_ID);
      await repository.deleteWorkflow(noTelegramWorkflowId, TEST_USER_ID);
      await repository.deleteWorkflow(lockWorkflowId, TEST_USER_ID);
      await repository.deleteWorkflow(combinedWorkflowId, TEST_USER_ID);
    } catch {
      // Ignore cleanup errors
    }
  });

  describe("Workflow with telegram nodes, no telegram settings", () => {
    test("returns synthetic directive response (no execution created)", async () => {
      const result = await runWithMCPContext({ userId: TEST_USER_ID }, async () => {
        return startWorkflow({
          workflowId: telegramWorkflowId,
          parentExecutionId: "none",
        });
      });

      expect(result.success).toBe(true);
      // Synthetic response: contains directive about telegram not configured
      expect(result.data).toContain("Telegram notification nodes");
      expect(result.data).toContain("not configured");
      expect(result.data).toContain("skipTelegramCheck: true");
      // Should NOT contain a Process ID (no execution created)
      expect(result.data).not.toContain("Process ID:");
    });

    test("synthetic response includes setup workflow reference", async () => {
      const result = await runWithMCPContext({ userId: TEST_USER_ID }, async () => {
        return startWorkflow({
          workflowId: telegramWorkflowId,
          parentExecutionId: "none",
        });
      });

      expect(result.success).toBe(true);
      expect(result.data).toContain("moira/telegram-setup");
    });

    test("synthetic response includes the workflow ID for skip hint", async () => {
      const result = await runWithMCPContext({ userId: TEST_USER_ID }, async () => {
        return startWorkflow({
          workflowId: telegramWorkflowId,
          parentExecutionId: "none",
        });
      });

      expect(result.success).toBe(true);
      expect(result.data).toContain(telegramWorkflowId);
    });
  });

  describe("skipTelegramCheck flag", () => {
    test("bypasses check and starts workflow normally", async () => {
      const result = await runWithMCPContext({ userId: TEST_USER_ID }, async () => {
        return startWorkflow({
          workflowId: telegramWorkflowId,
          parentExecutionId: "none",
          skipTelegramCheck: true,
        });
      });

      expect(result.success).toBe(true);
      // Normal workflow start: contains Process ID
      expect(result.data).toContain("Process ID:");
      // Should NOT contain pre-flight message
      expect(result.data).not.toContain("not configured");
    });

    test("cannot bypass mandatory delivery for a lock-only workflow", async () => {
      const result = await runWithMCPContext({ userId: TEST_USER_ID }, () =>
        startWorkflow({
          workflowId: lockWorkflowId,
          parentExecutionId: "none",
          skipTelegramCheck: true,
        }),
      );

      expect(result.success).toBe(true);
      expect(result.data).toContain("lock nodes");
      expect(result.data).toContain("skipTelegramCheck cannot bypass");
      expect(result.data).not.toContain("Process ID:");
    });

    test("cannot bypass a lock when notification and lock nodes are combined", async () => {
      const result = await runWithMCPContext({ userId: TEST_USER_ID }, () =>
        startWorkflow({
          workflowId: combinedWorkflowId,
          parentExecutionId: "none",
          skipTelegramCheck: true,
        }),
      );

      expect(result.success).toBe(true);
      expect(result.data).toContain("lock nodes");
      expect(result.data).not.toContain("Process ID:");
    });
  });

  describe("Workflow without telegram nodes", () => {
    test("starts normally regardless of telegram settings", async () => {
      const result = await runWithMCPContext({ userId: TEST_USER_ID }, async () => {
        return startWorkflow({
          workflowId: noTelegramWorkflowId,
          parentExecutionId: "none",
        });
      });

      expect(result.success).toBe(true);
      // Normal workflow start
      expect(result.data).toContain("Process ID:");
      // Should NOT contain the pre-flight directive message
      expect(result.data).not.toContain("Telegram notification nodes");
      expect(result.data).not.toContain("skipTelegramCheck");
    });
  });

  describe("Workflow with telegram nodes, configured settings", () => {
    test("starts normally when telegram is configured", async () => {
      const result = await runWithMCPContext({ userId: TEST_USER_CONFIGURED }, async () => {
        return startWorkflow({
          workflowId: telegramWorkflowId,
          parentExecutionId: "none",
        });
      });

      expect(result.success).toBe(true);
      // Normal workflow start
      expect(result.data).toContain("Process ID:");
      // Should NOT contain the pre-flight directive message
      expect(result.data).not.toContain("Telegram notification nodes");
      expect(result.data).not.toContain("skipTelegramCheck");
    });
  });

  describe("Workflow with lock nodes", () => {
    test("starts when trusted Telegram configuration has a valid shape", async () => {
      const result = await runWithMCPContext({ userId: TEST_USER_CONFIGURED }, () =>
        startWorkflow({ workflowId: lockWorkflowId, parentExecutionId: "none" }),
      );

      expect(result.success).toBe(true);
      expect(result.data).toContain("Process ID:");
      expect(result.data).toContain("Prepare for the lock");
    });

    test("rejects malformed configuration before creating an execution", async () => {
      await repository.setSetting(TEST_USER_CONFIGURED, "telegram.bot_token", "malformed");
      try {
        const result = await runWithMCPContext({ userId: TEST_USER_CONFIGURED }, () =>
          startWorkflow({
            workflowId: lockWorkflowId,
            parentExecutionId: "none",
            skipTelegramCheck: true,
          }),
        );
        expect(result.success).toBe(true);
        expect(result.data).toContain("configuration is invalid");
        expect(result.data).not.toContain("Process ID:");
      } finally {
        await repository.setSetting(
          TEST_USER_CONFIGURED,
          "telegram.bot_token",
          "123456:test-bot-token-123",
        );
      }
    });
  });
});
