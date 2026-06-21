/**
 * Unit tests for Telegram inline keyboard types and utilities
 *
 * Tests cover:
 * - InlineKeyboardButton structure
 * - InlineKeyboardMarkup serialization
 * - buildApproveRejectKeyboard utility
 * - ReplyMarkup in SendMessageParams
 * - buildRequestBody with reply_markup
 */

import { describe, it, expect } from "@jest/globals";
import {
  buildApproveKeyboard,
  parseApproveCallback,
  TELEGRAM_CALLBACK_DATA_MAX_BYTES,
} from "@mcp-moira/workflow-engine";
import type {
  InlineKeyboardButton,
  InlineKeyboardMarkup,
  SendMessageParams,
} from "@mcp-moira/workflow-engine";

describe("Telegram Inline Keyboard", () => {
  describe("InlineKeyboardButton", () => {
    it("supports text-only button", () => {
      const button: InlineKeyboardButton = { text: "Click me" };
      expect(button.text).toBe("Click me");
      expect(button.callback_data).toBeUndefined();
      expect(button.url).toBeUndefined();
    });

    it("supports callback_data button", () => {
      const button: InlineKeyboardButton = {
        text: "Approve",
        callback_data: '{"action":"approve"}',
      };
      expect(button.text).toBe("Approve");
      expect(button.callback_data).toBe('{"action":"approve"}');
    });

    it("supports URL button", () => {
      const button: InlineKeyboardButton = {
        text: "Open Link",
        url: "https://example.com",
      };
      expect(button.text).toBe("Open Link");
      expect(button.url).toBe("https://example.com");
    });
  });

  describe("InlineKeyboardMarkup", () => {
    it("serializes single row of buttons", () => {
      const keyboard: InlineKeyboardMarkup = {
        inline_keyboard: [
          [
            { text: "A", callback_data: "a" },
            { text: "B", callback_data: "b" },
          ],
        ],
      };

      const json = JSON.stringify(keyboard);
      const parsed = JSON.parse(json);

      expect(parsed.inline_keyboard).toHaveLength(1);
      expect(parsed.inline_keyboard[0]).toHaveLength(2);
      expect(parsed.inline_keyboard[0][0].text).toBe("A");
      expect(parsed.inline_keyboard[0][1].text).toBe("B");
    });

    it("serializes multiple rows of buttons", () => {
      const keyboard: InlineKeyboardMarkup = {
        inline_keyboard: [
          [{ text: "Row 1 Button", callback_data: "r1" }],
          [{ text: "Row 2 Button", callback_data: "r2" }],
          [{ text: "Row 3 Button", callback_data: "r3" }],
        ],
      };

      const json = JSON.stringify(keyboard);
      const parsed = JSON.parse(json);

      expect(parsed.inline_keyboard).toHaveLength(3);
      expect(parsed.inline_keyboard[0][0].text).toBe("Row 1 Button");
      expect(parsed.inline_keyboard[2][0].text).toBe("Row 3 Button");
    });

    it("serializes empty keyboard", () => {
      const keyboard: InlineKeyboardMarkup = {
        inline_keyboard: [],
      };

      const json = JSON.stringify(keyboard);
      const parsed = JSON.parse(json);
      expect(parsed.inline_keyboard).toHaveLength(0);
    });
  });

  describe("buildApproveKeyboard", () => {
    it("creates single-button keyboard with approve only", () => {
      const keyboard = buildApproveKeyboard("exec-123", "node-456");

      expect(keyboard.inline_keyboard).toHaveLength(1);
      expect(keyboard.inline_keyboard[0]).toHaveLength(1);

      const approveBtn = keyboard.inline_keyboard[0][0];
      expect(approveBtn.text).toContain("Approve");
    });

    it("uses compact encoding with execution and node ID prefixes", () => {
      const keyboard = buildApproveKeyboard("exec-abc-full-id", "node-xyz-full-id");
      const approveData = keyboard.inline_keyboard[0][0].callback_data!;

      expect(approveData).toBe("a:exec-abc:node-xyz-ful");
    });

    it("callback_data is within 64-byte limit with short IDs", () => {
      const keyboard = buildApproveKeyboard("short-id", "node-1");
      for (const row of keyboard.inline_keyboard) {
        for (const btn of row) {
          const bytes = Buffer.byteLength(btn.callback_data!, "utf-8");
          expect(bytes).toBeLessThanOrEqual(TELEGRAM_CALLBACK_DATA_MAX_BYTES);
        }
      }
    });

    it("callback_data stays within 64-byte limit with real UUIDs", () => {
      const keyboard = buildApproveKeyboard(
        "550e8400-e29b-41d4-a716-446655440000",
        "lock-verify-pin-node",
      );
      for (const row of keyboard.inline_keyboard) {
        for (const btn of row) {
          const bytes = Buffer.byteLength(btn.callback_data!, "utf-8");
          expect(bytes).toBeLessThanOrEqual(TELEGRAM_CALLBACK_DATA_MAX_BYTES);
        }
      }
    });

    it("callback_data stays within 64-byte limit with maximum-length inputs", () => {
      const longExecId = "a".repeat(100);
      const longNodeId = "b".repeat(100);
      const keyboard = buildApproveKeyboard(longExecId, longNodeId);
      for (const row of keyboard.inline_keyboard) {
        for (const btn of row) {
          const bytes = Buffer.byteLength(btn.callback_data!, "utf-8");
          expect(bytes).toBeLessThanOrEqual(TELEGRAM_CALLBACK_DATA_MAX_BYTES);
        }
      }
    });
  });

  describe("parseApproveCallback", () => {
    it("parses approve callback", () => {
      const result = parseApproveCallback("a:550e8400:lock-verify");
      expect(result).toEqual({
        action: "approve",
        executionIdPrefix: "550e8400",
        nodeIdPrefix: "lock-verify",
      });
    });

    it("returns null for reject prefix (no longer supported)", () => {
      const result = parseApproveCallback("r:550e8400:lock-verify");
      expect(result).toBeNull();
    });

    it("returns null for invalid format", () => {
      expect(parseApproveCallback("invalid")).toBeNull();
      expect(parseApproveCallback("x:a:b")).toBeNull();
      expect(parseApproveCallback("a:b")).toBeNull();
    });

    it("roundtrips with buildApproveKeyboard", () => {
      const keyboard = buildApproveKeyboard(
        "550e8400-e29b-41d4-a716-446655440000",
        "lock-verify-pin",
      );
      const approveData = keyboard.inline_keyboard[0][0].callback_data!;

      const approve = parseApproveCallback(approveData);
      expect(approve).not.toBeNull();
      expect(approve!.executionIdPrefix).toBe("550e8400");
    });
  });

  describe("SendMessageParams with replyMarkup", () => {
    it("accepts replyMarkup field", () => {
      const params: SendMessageParams = {
        chatId: "12345",
        text: "Choose an option:",
        replyMarkup: {
          inline_keyboard: [[{ text: "Option A", callback_data: "a" }]],
        },
      };

      expect(params.replyMarkup).toBeDefined();
      expect(params.replyMarkup!.inline_keyboard).toHaveLength(1);
    });

    it("replyMarkup is optional", () => {
      const params: SendMessageParams = {
        chatId: "12345",
        text: "No buttons here",
      };

      expect(params.replyMarkup).toBeUndefined();
    });
  });

  describe("reply_markup JSON serialization for Telegram API", () => {
    it("serializes keyboard as JSON string for API body", () => {
      const keyboard: InlineKeyboardMarkup = {
        inline_keyboard: [
          [
            { text: "✅ Approve", callback_data: '{"action":"approve"}' },
            { text: "❌ Reject", callback_data: '{"action":"reject"}' },
          ],
        ],
      };

      // Telegram API expects reply_markup as JSON string
      const serialized = JSON.stringify(keyboard);
      expect(typeof serialized).toBe("string");

      // Parse back to verify structure
      const parsed = JSON.parse(serialized);
      expect(parsed.inline_keyboard[0][0].text).toBe("✅ Approve");
      expect(parsed.inline_keyboard[0][1].text).toBe("❌ Reject");
    });
  });
});
