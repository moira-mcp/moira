/**
 * Unit tests for ordinary notification and trusted Telegram pre-flight behavior.
 */

import { describe, it, expect, jest } from "@jest/globals";
import {
  formatCommunicationPreflightResponse,
  formatLockTelegramPreflightResponse,
  hasConfiguredCommunicationChannel,
  resolveSkipNotificationCheck,
  workflowHasTelegramNodes,
  workflowHasUserNotificationNodes,
  workflowHasLockNodes,
  formatTelegramPreflightResponse,
} from "../../../packages/mcp-server/src/tools/start-workflow.js";
import { TELEGRAM } from "../../../packages/mcp-server/src/messages/en.js";
import {
  CommunicationChannelRegistry,
  type CommunicationChannelAdapter,
  type IDataRepository,
} from "@mcp-moira/workflow-engine";

describe("Telegram Pre-flight Check", () => {
  describe("workflowHasTelegramNodes", () => {
    it("detects telegram-notification nodes in workflow", () => {
      const nodes = [
        { type: "start", id: "start" },
        { type: "agent-directive", id: "step1" },
        { type: "telegram-notification", id: "notify" },
        { type: "end", id: "end" },
      ];
      expect(workflowHasTelegramNodes(nodes)).toBe(true);
    });

    it("returns false for workflows without telegram nodes", () => {
      const nodes = [
        { type: "start", id: "start" },
        { type: "agent-directive", id: "step1" },
        { type: "condition", id: "check" },
        { type: "end", id: "end" },
      ];
      expect(workflowHasTelegramNodes(nodes)).toBe(false);
    });

    it("returns false for empty nodes array", () => {
      expect(workflowHasTelegramNodes([])).toBe(false);
    });

    it("detects multiple telegram nodes", () => {
      const nodes = [
        { type: "start", id: "start" },
        { type: "telegram-notification", id: "notify1" },
        { type: "agent-directive", id: "step1" },
        { type: "telegram-notification", id: "notify2" },
        { type: "end", id: "end" },
      ];
      expect(workflowHasTelegramNodes(nodes)).toBe(true);
    });

    it("does not match similar but different node types", () => {
      const nodes = [
        { type: "start", id: "start" },
        { type: "telegram", id: "wrong" },
        { type: "notification", id: "also-wrong" },
        { type: "end", id: "end" },
      ];
      expect(workflowHasTelegramNodes(nodes)).toBe(false);
    });
  });

  describe("workflowHasUserNotificationNodes", () => {
    it("detects only the provider-neutral node type", () => {
      expect(workflowHasUserNotificationNodes([{ type: "user-notification" }])).toBe(true);
      expect(workflowHasUserNotificationNodes([{ type: "telegram-notification" }])).toBe(false);
    });
  });

  describe("ordinary communication pre-flight", () => {
    const adapter = (
      id: string,
      isConfigured: CommunicationChannelAdapter["isConfigured"],
    ): CommunicationChannelAdapter => ({
      id,
      provider: id,
      capabilities: { text: true, image: false, document: false, trusted: false },
      metadata: {
        title: id,
        origin: id === "telegram" ? "builtin" : "extension",
        settingKeys: [`${id}.enabled`],
      },
      isConfigured,
      async deliver() {},
    });
    const repository = {
      async getSetting<T>(_userId: string, key: string): Promise<T | null> {
        return (key === "webhook.enabled" ? true : null) as T | null;
      },
    } as IDataRepository;

    it("accepts a configured non-Telegram adapter for a generic workflow", async () => {
      const registry = new CommunicationChannelRegistry([
        adapter("telegram", async () => false),
        adapter("webhook", async (configuration) =>
          Boolean(await configuration.get("webhook.enabled")),
        ),
      ]);

      await expect(hasConfiguredCommunicationChannel(registry, repository, "user-1")).resolves.toBe(
        true,
      );
      await expect(
        hasConfiguredCommunicationChannel(registry, repository, "user-1", "telegram"),
      ).resolves.toBe(false);
    });

    it("treats adapter failures as unavailable without blocking another configured channel", async () => {
      const registry = new CommunicationChannelRegistry([
        adapter("broken", async () => {
          throw new Error("secret provider diagnostic");
        }),
        adapter("webhook", async () => true),
      ]);

      await expect(hasConfiguredCommunicationChannel(registry, repository, "user-1")).resolves.toBe(
        true,
      );
      await expect(
        hasConfiguredCommunicationChannel(registry, repository, "user-1", "broken"),
      ).resolves.toBe(false);
    });

    it("bounds a non-settling adapter and aborts its configuration check", async () => {
      jest.useFakeTimers();
      let observedSignal: AbortSignal | undefined;
      try {
        const registry = new CommunicationChannelRegistry([
          adapter("stalled", async (_configuration, signal) => {
            observedSignal = signal;
            return new Promise<boolean>(() => {});
          }),
        ]);

        const result = hasConfiguredCommunicationChannel(registry, repository, "user-1");
        await jest.advanceTimersByTimeAsync(10_000);

        await expect(result).resolves.toBe(false);
        expect(observedSignal?.aborted).toBe(true);
      } finally {
        jest.useRealTimers();
      }
    });

    it("provides channel-neutral settings guidance and the canonical skip field", () => {
      const response = formatCommunicationPreflightResponse("moira/generic");
      expect(response).toContain("Settings > Notifications");
      expect(response).toContain("skipNotificationCheck: true");
      expect(response).toContain('workflowId: "moira/generic"');
      expect(response).not.toContain("skipTelegramCheck: true");
    });

    it("keeps the legacy alias compatible and rejects contradictory flags", () => {
      expect(resolveSkipNotificationCheck({ skipNotificationCheck: true })).toBe(true);
      expect(resolveSkipNotificationCheck({ skipTelegramCheck: true })).toBe(true);
      expect(
        resolveSkipNotificationCheck({ skipNotificationCheck: true, skipTelegramCheck: true }),
      ).toBe(true);
      expect(() =>
        resolveSkipNotificationCheck({ skipNotificationCheck: true, skipTelegramCheck: false }),
      ).toThrow("must not disagree");
    });
  });

  describe("workflowHasLockNodes", () => {
    it("detects lock nodes independently of notification nodes", () => {
      expect(
        workflowHasLockNodes([
          { type: "start" },
          { type: "lock" },
          { type: "telegram-notification" },
        ]),
      ).toBe(true);
      expect(workflowHasLockNodes([{ type: "telegram-notification" }])).toBe(false);
    });
  });

  describe("formatTelegramPreflightResponse", () => {
    it("includes directive text with workflow identifier", () => {
      const response = formatTelegramPreflightResponse("moira/test-workflow");
      expect(response).toContain("Your next task:");
      expect(response).toContain("Telegram notification nodes");
      expect(response).toContain("not configured");
    });

    it("includes the canonical skipNotificationCheck hint with the correct workflow ID", () => {
      const response = formatTelegramPreflightResponse("moira/my-workflow");
      expect(response).toContain("skipNotificationCheck: true");
      expect(response).not.toContain("skipTelegramCheck: true");
      expect(response).toContain('workflowId: "moira/my-workflow"');
    });

    it("includes setup workflow reference", () => {
      const response = formatTelegramPreflightResponse("moira/test");
      expect(response).toContain(
        'start({ workflowId: "moira/telegram-setup", parentExecutionId: "none", skipNotificationCheck: true })',
      );
    });

    it("includes success criteria", () => {
      const response = formatTelegramPreflightResponse("moira/test");
      expect(response).toContain("Success criteria:");
    });

    it("includes BotFather setup instructions", () => {
      const response = formatTelegramPreflightResponse("moira/test");
      expect(response).toContain("@BotFather");
      expect(response).toContain("bot token");
      expect(response).toContain("chat ID");
    });
  });

  describe("formatLockTelegramPreflightResponse", () => {
    it("requires trusted delivery without offering the notification bypass", () => {
      const response = formatLockTelegramPreflightResponse("moira/locked", "missing");
      expect(response).toContain("lock nodes");
      expect(response).toContain("not configured");
      expect(response).toContain("skipNotificationCheck");
      expect(response).toContain("cannot bypass");
      expect(response).not.toContain("skipNotificationCheck: true");
      expect(response).not.toContain("skipTelegramCheck: true");
    });

    it("distinguishes malformed configuration", () => {
      expect(formatLockTelegramPreflightResponse("moira/locked", "invalid")).toContain(
        "configuration is invalid",
      );
    });
  });

  describe("TELEGRAM messages", () => {
    it("preflight_directive includes workflow ID parameter", () => {
      const message = TELEGRAM.preflight_directive("my-workflow-123");
      expect(message).toContain("my-workflow-123");
      expect(message).toContain("Settings > Notifications");
      expect(message).toContain("skipNotificationCheck: true");
      expect(message).not.toContain("skipTelegramCheck: true");
    });

    it("preflight_completion_condition is defined", () => {
      expect(TELEGRAM.preflight_completion_condition).toBeDefined();
      expect(TELEGRAM.preflight_completion_condition.length).toBeGreaterThan(0);
    });
  });
});
