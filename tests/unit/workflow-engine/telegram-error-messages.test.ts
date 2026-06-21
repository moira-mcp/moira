/**
 * Unit tests for Telegram error message utility functions
 *
 * Tests cover:
 * - getActionableTelegramErrorMessage returns correct messages per error type
 * - classifyTelegramError correctly classifies TelegramError, Error, and unknown values
 */

import { describe, it, expect } from "@jest/globals";
import {
  TelegramErrorType,
  getActionableTelegramErrorMessage,
  classifyTelegramError,
} from "@mcp-moira/workflow-engine";
import type { TelegramError } from "@mcp-moira/workflow-engine";

describe("Telegram Error Messages", () => {
  describe("getActionableTelegramErrorMessage", () => {
    it("INVALID_CHAT_ID returns message about sending message to bot", () => {
      const message = getActionableTelegramErrorMessage(TelegramErrorType.INVALID_CHAT_ID);
      expect(message).toContain("send any message to your bot");
    });

    it("INVALID_TOKEN returns message about @BotFather", () => {
      const message = getActionableTelegramErrorMessage(TelegramErrorType.INVALID_TOKEN);
      expect(message).toContain("@BotFather");
    });

    it("NETWORK_ERROR returns message about network error", () => {
      const message = getActionableTelegramErrorMessage(TelegramErrorType.NETWORK_ERROR);
      expect(message).toContain("Network error");
    });

    it("RATE_LIMIT_EXCEEDED returns message about rate limit", () => {
      const message = getActionableTelegramErrorMessage(TelegramErrorType.RATE_LIMIT_EXCEEDED);
      expect(message).toContain("rate limit");
    });

    it("TIMEOUT_ERROR returns message about timeout", () => {
      const message = getActionableTelegramErrorMessage(TelegramErrorType.TIMEOUT_ERROR);
      expect(message).toContain("timed out");
    });

    it("MESSAGE_TOO_LONG returns message mentioning 4096 limit", () => {
      const message = getActionableTelegramErrorMessage(TelegramErrorType.MESSAGE_TOO_LONG);
      expect(message).toContain("4096");
    });

    it("TEMPLATE_ERROR includes original message when provided", () => {
      const original = "Variable {{foo}} not found";
      const message = getActionableTelegramErrorMessage(TelegramErrorType.TEMPLATE_ERROR, original);
      expect(message).toContain(original);
      expect(message).toContain("Template processing error");
    });

    it("TEMPLATE_ERROR uses fallback when no original message", () => {
      const message = getActionableTelegramErrorMessage(TelegramErrorType.TEMPLATE_ERROR);
      expect(message).toContain("unknown");
    });

    it("API_ERROR includes original message when provided", () => {
      const original = "Bad Request: can't parse entities";
      const message = getActionableTelegramErrorMessage(TelegramErrorType.API_ERROR, original);
      expect(message).toContain(original);
    });

    it("API_ERROR uses generic fallback when no original message", () => {
      const message = getActionableTelegramErrorMessage(TelegramErrorType.API_ERROR);
      expect(message).toBe("Telegram notification failed");
    });
  });

  describe("classifyTelegramError", () => {
    it("classifies TelegramError with INVALID_CHAT_ID type", () => {
      const error = new Error("Chat not found") as TelegramError;
      error.type = TelegramErrorType.INVALID_CHAT_ID;

      const result = classifyTelegramError(error);
      expect(result.errorType).toBe(TelegramErrorType.INVALID_CHAT_ID);
      expect(result.message).toContain("send any message to your bot");
    });

    it("classifies TelegramError with INVALID_TOKEN type", () => {
      const error = new Error("Unauthorized") as TelegramError;
      error.type = TelegramErrorType.INVALID_TOKEN;

      const result = classifyTelegramError(error);
      expect(result.errorType).toBe(TelegramErrorType.INVALID_TOKEN);
      expect(result.message).toContain("@BotFather");
    });

    it("classifies TelegramError with NETWORK_ERROR type", () => {
      const error = new Error("fetch failed") as TelegramError;
      error.type = TelegramErrorType.NETWORK_ERROR;

      const result = classifyTelegramError(error);
      expect(result.errorType).toBe(TelegramErrorType.NETWORK_ERROR);
      expect(result.message).toContain("Network error");
    });

    it("classifies TelegramError with RATE_LIMIT_EXCEEDED type", () => {
      const error = new Error("Too Many Requests") as TelegramError;
      error.type = TelegramErrorType.RATE_LIMIT_EXCEEDED;

      const result = classifyTelegramError(error);
      expect(result.errorType).toBe(TelegramErrorType.RATE_LIMIT_EXCEEDED);
      expect(result.message).toContain("rate limit");
    });

    it("classifies TelegramError with TIMEOUT_ERROR type", () => {
      const error = new Error("Aborted") as TelegramError;
      error.type = TelegramErrorType.TIMEOUT_ERROR;

      const result = classifyTelegramError(error);
      expect(result.errorType).toBe(TelegramErrorType.TIMEOUT_ERROR);
      expect(result.message).toContain("timed out");
    });

    it("classifies TelegramError with MESSAGE_TOO_LONG type", () => {
      const error = new Error("Message too long: 5000 chars") as TelegramError;
      error.type = TelegramErrorType.MESSAGE_TOO_LONG;

      const result = classifyTelegramError(error);
      expect(result.errorType).toBe(TelegramErrorType.MESSAGE_TOO_LONG);
      expect(result.message).toContain("4096");
    });

    it("classifies generic Error as API_ERROR", () => {
      const error = new Error("Something unexpected happened");

      const result = classifyTelegramError(error);
      expect(result.errorType).toBe(TelegramErrorType.API_ERROR);
      expect(result.message).toContain("Something unexpected happened");
    });

    it("classifies non-Error value as API_ERROR with generic message", () => {
      const result = classifyTelegramError("string error");
      expect(result.errorType).toBe(TelegramErrorType.API_ERROR);
      expect(result.message).toBe("Telegram notification failed");
    });

    it("classifies null as API_ERROR with generic message", () => {
      const result = classifyTelegramError(null);
      expect(result.errorType).toBe(TelegramErrorType.API_ERROR);
      expect(result.message).toBe("Telegram notification failed");
    });

    it("classifies undefined as API_ERROR with generic message", () => {
      const result = classifyTelegramError(undefined);
      expect(result.errorType).toBe(TelegramErrorType.API_ERROR);
      expect(result.message).toBe("Telegram notification failed");
    });
  });
});
