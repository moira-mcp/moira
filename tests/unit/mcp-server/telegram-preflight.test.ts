/**
 * Unit tests for Telegram pre-flight check in start-workflow
 * Issue #372: Pre-flight check when starting workflows with telegram nodes
 *
 * Tests cover:
 * - Telegram node detection in workflow graphs
 * - Synthetic response format when Telegram not configured
 * - skipTelegramCheck flag behavior
 * - Workflows without telegram nodes start normally
 */

import { describe, it, expect } from "@jest/globals";
import {
  workflowHasTelegramNodes,
  formatTelegramPreflightResponse,
} from "../../../packages/mcp-server/src/tools/start-workflow.js";
import { TELEGRAM } from "../../../packages/mcp-server/src/messages/en.js";

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

  describe("formatTelegramPreflightResponse", () => {
    it("includes directive text with workflow identifier", () => {
      const response = formatTelegramPreflightResponse("moira/test-workflow");
      expect(response).toContain("Your next task:");
      expect(response).toContain("Telegram notification nodes");
      expect(response).toContain("not configured");
    });

    it("includes skipTelegramCheck hint with the correct workflow ID", () => {
      const response = formatTelegramPreflightResponse("moira/my-workflow");
      expect(response).toContain("skipTelegramCheck: true");
      expect(response).toContain('workflowId: "moira/my-workflow"');
    });

    it("includes setup workflow reference", () => {
      const response = formatTelegramPreflightResponse("moira/test");
      expect(response).toContain("moira/telegram-setup");
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

  describe("TELEGRAM messages", () => {
    it("preflight_directive includes workflow ID parameter", () => {
      const message = TELEGRAM.preflight_directive("my-workflow-123");
      expect(message).toContain("my-workflow-123");
      expect(message).toContain("skipTelegramCheck: true");
    });

    it("preflight_completion_condition is defined", () => {
      expect(TELEGRAM.preflight_completion_condition).toBeDefined();
      expect(TELEGRAM.preflight_completion_condition.length).toBeGreaterThan(0);
    });
  });
});
