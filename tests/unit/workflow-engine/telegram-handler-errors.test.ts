/**
 * Unit tests for TelegramNotificationHandler error handling
 *
 * Tests cover:
 * - Handler adds actionable notifications to messageQueue on errors
 * - Handler uses correct error type in notifications
 * - Handler returns actionable error messages in result data
 * - Handler notifies about missing Telegram configuration
 */

import { describe, test, expect, beforeEach, afterEach, jest } from "@jest/globals";
import {
  TelegramNotificationHandler,
  AgentMessageQueue,
  TelegramErrorType,
  setTestClientFactory,
  resetClientFactory,
} from "@mcp-moira/workflow-engine";
import type {
  TelegramNotificationNode,
  ExecutionContext,
  TelegramError,
} from "@mcp-moira/workflow-engine";
import type { IDataRepository } from "@mcp-moira/workflow-engine";
import type { IGraphExecutionEngine } from "@mcp-moira/workflow-engine";

// Helper to create a minimal telegram notification node
function createTelegramNode(
  overrides: Partial<TelegramNotificationNode> = {},
): TelegramNotificationNode {
  return {
    type: "telegram-notification",
    id: "test-telegram-node",
    message: "Test notification: {{status}}",
    connections: { default: "next-node" },
    ...overrides,
  };
}

// Helper to create execution context
function createContext(overrides: Partial<ExecutionContext> = {}): ExecutionContext {
  return {
    variables: { status: "completed" },
    nodeStates: {},
    executionId: "test-exec-123",
    workflowId: "test-workflow",
    ...overrides,
  };
}

describe("TelegramNotificationHandler Error Handling", () => {
  let handler: TelegramNotificationHandler;
  let messageQueue: AgentMessageQueue;
  let mockEngine: IGraphExecutionEngine;

  // Mock repository that returns valid telegram settings by default
  let mockRepository: IDataRepository;

  beforeEach(() => {
    handler = new TelegramNotificationHandler();
    messageQueue = new AgentMessageQueue();

    mockEngine = {} as IGraphExecutionEngine;

    mockRepository = {
      getSetting: jest
        .fn<(userId: string, key: string) => Promise<unknown>>()
        .mockImplementation((_userId: string, key: string) => {
          if (key === "telegram.bot_token")
            return Promise.resolve("123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi");
          if (key === "telegram.chat_id") return Promise.resolve("12345");
          if (key === "telegram.enabled") return Promise.resolve(true);
          return Promise.resolve(null);
        }),
    } as unknown as IDataRepository;
  });

  afterEach(() => {
    resetClientFactory();
  });

  test("adds notification with actionable message when INVALID_CHAT_ID error occurs", async () => {
    // Mock TelegramClient that throws INVALID_CHAT_ID error
    setTestClientFactory(
      () =>
        ({
          getDefaultChatId: () => "12345",
          sendMessage: async () => {
            const error = new Error("Bad Request: chat not found") as TelegramError;
            error.type = TelegramErrorType.INVALID_CHAT_ID;
            throw error;
          },
          getRateLimitStatus: () => ({ allowed: true, currentCount: 0 }),
          sendMessageToDefault: async () => {
            throw new Error("not implemented");
          },
          testConnection: async () => true,
        }) as any,
    );

    const node = createTelegramNode();
    const context = createContext();

    const result = await handler.execute(node, context, messageQueue, mockRepository, mockEngine);

    // Handler should continue (graceful degradation)
    expect(result.action).toBe("continue");
    expect(result.data?.telegramNotificationFailed).toBe(true);
    expect(result.data?.errorType).toBe(TelegramErrorType.INVALID_CHAT_ID);

    // Actionable error message in result data
    expect(result.data?.errorMessage).toContain("send any message to your bot");

    // Notification added to messageQueue
    const flushed = messageQueue.flush("test-process");
    expect(flushed.totalMessages).toBe(1);
    expect(flushed.messages[0].type).toBe("notification");

    const notification = flushed.messages[0] as any;
    expect(notification.notificationText).toContain("send any message to your bot");
    expect(notification.status).toBe(TelegramErrorType.INVALID_CHAT_ID);
  });

  test("adds notification with actionable message when INVALID_TOKEN error occurs", async () => {
    setTestClientFactory(
      () =>
        ({
          getDefaultChatId: () => "12345",
          sendMessage: async () => {
            const error = new Error("Unauthorized") as TelegramError;
            error.type = TelegramErrorType.INVALID_TOKEN;
            throw error;
          },
          getRateLimitStatus: () => ({ allowed: true, currentCount: 0 }),
          sendMessageToDefault: async () => {
            throw new Error("not implemented");
          },
          testConnection: async () => true,
        }) as any,
    );

    const node = createTelegramNode();
    const context = createContext();

    const result = await handler.execute(node, context, messageQueue, mockRepository, mockEngine);

    expect(result.action).toBe("continue");
    expect(result.data?.errorType).toBe(TelegramErrorType.INVALID_TOKEN);
    expect(result.data?.errorMessage).toContain("@BotFather");

    const flushed = messageQueue.flush("test-process");
    expect(flushed.totalMessages).toBe(1);

    const notification = flushed.messages[0] as any;
    expect(notification.notificationText).toContain("@BotFather");
    expect(notification.status).toBe(TelegramErrorType.INVALID_TOKEN);
  });

  test("adds notification with actionable message when NETWORK_ERROR occurs", async () => {
    setTestClientFactory(
      () =>
        ({
          getDefaultChatId: () => "12345",
          sendMessage: async () => {
            const error = new Error("fetch failed") as TelegramError;
            error.type = TelegramErrorType.NETWORK_ERROR;
            throw error;
          },
          getRateLimitStatus: () => ({ allowed: true, currentCount: 0 }),
          sendMessageToDefault: async () => {
            throw new Error("not implemented");
          },
          testConnection: async () => true,
        }) as any,
    );

    const node = createTelegramNode();
    const context = createContext();

    const result = await handler.execute(node, context, messageQueue, mockRepository, mockEngine);

    expect(result.action).toBe("continue");
    expect(result.data?.errorType).toBe(TelegramErrorType.NETWORK_ERROR);
    expect(result.data?.errorMessage).toContain("Network error");

    const flushed = messageQueue.flush("test-process");
    expect(flushed.totalMessages).toBe(1);

    const notification = flushed.messages[0] as any;
    expect(notification.notificationText).toContain("Network error");
    expect(notification.status).toBe(TelegramErrorType.NETWORK_ERROR);
  });

  test("adds notification about configuring Telegram when bot token is not set", async () => {
    // Repository returns null for bot_token
    mockRepository = {
      getSetting: jest
        .fn<(userId: string, key: string) => Promise<unknown>>()
        .mockImplementation((_userId: string, key: string) => {
          if (key === "telegram.bot_token") return Promise.resolve(null);
          if (key === "telegram.chat_id") return Promise.resolve(null);
          if (key === "telegram.enabled") return Promise.resolve(true);
          return Promise.resolve(null);
        }),
    } as unknown as IDataRepository;

    const node = createTelegramNode();
    const context = createContext();

    const result = await handler.execute(node, context, messageQueue, mockRepository, mockEngine);

    // Handler should continue (not configured = skip, not error)
    expect(result.action).toBe("continue");
    expect(result.data?.telegramNotificationSent).toBe(false);

    // Notification about missing configuration
    const flushed = messageQueue.flush("test-process");
    expect(flushed.totalMessages).toBe(1);

    const notification = flushed.messages[0] as any;
    expect(notification.notificationText).toContain("Set up in Settings");
    expect(notification.status).toBe("configuration_error");
  });

  test("uses error connection when available and error occurs", async () => {
    setTestClientFactory(
      () =>
        ({
          getDefaultChatId: () => "12345",
          sendMessage: async () => {
            const error = new Error("API error") as TelegramError;
            error.type = TelegramErrorType.API_ERROR;
            throw error;
          },
          getRateLimitStatus: () => ({ allowed: true, currentCount: 0 }),
          sendMessageToDefault: async () => {
            throw new Error("not implemented");
          },
          testConnection: async () => true,
        }) as any,
    );

    const node = createTelegramNode({
      connections: { default: "next-node", error: "error-handler-node" },
    });
    const context = createContext();

    const result = await handler.execute(node, context, messageQueue, mockRepository, mockEngine);

    expect(result.action).toBe("continue");
    expect(result.outputPath).toBe("error");
    expect(result.data?.telegramNotificationFailed).toBe(true);
  });

  test("uses default connection when no error connection and error occurs", async () => {
    setTestClientFactory(
      () =>
        ({
          getDefaultChatId: () => "12345",
          sendMessage: async () => {
            const error = new Error("API error") as TelegramError;
            error.type = TelegramErrorType.API_ERROR;
            throw error;
          },
          getRateLimitStatus: () => ({ allowed: true, currentCount: 0 }),
          sendMessageToDefault: async () => {
            throw new Error("not implemented");
          },
          testConnection: async () => true,
        }) as any,
    );

    const node = createTelegramNode({
      connections: { default: "next-node" },
    });
    const context = createContext();

    const result = await handler.execute(node, context, messageQueue, mockRepository, mockEngine);

    expect(result.action).toBe("continue");
    expect(result.outputPath).toBe("default");
    expect(result.data?.telegramNotificationFailed).toBe(true);
  });
});
