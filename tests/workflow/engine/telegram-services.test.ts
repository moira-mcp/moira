/**
 * Unit Tests for Telegram Services
 * Test HTTP client and notification handler functionality
 */

import { describe, test, expect, beforeEach, jest } from "@jest/globals";
import { TelegramClient } from "@mcp-moira/workflow-engine";
import { TelegramNotificationHandler, AgentMessageQueue } from "@mcp-moira/workflow-engine";
import { TelegramConfig, TelegramErrorType, SendMessageParams } from "@mcp-moira/workflow-engine";
import { TelegramNotificationNode, ExecutionContext } from "@mcp-moira/workflow-engine";
import { IDataRepository, IGraphExecutionEngine } from "@mcp-moira/workflow-engine";

// Mock fetch for HTTP client tests
const mockFetch = jest.fn() as jest.MockedFunction<typeof fetch>;
global.fetch = mockFetch;

describe("Telegram Services", () => {
  describe("TelegramClient", () => {
    let client: TelegramClient;

    const validConfig: TelegramConfig = {
      botToken: "123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZ",
      defaultChatId: "12345",
      timeout: 1000,
    };

    beforeEach(() => {
      client = new TelegramClient(validConfig);
      mockFetch.mockClear();
    });

    describe("Configuration Validation", () => {
      test("should accept valid configuration", () => {
        expect(() => new TelegramClient(validConfig)).not.toThrow();
      });

      test("should reject missing bot token", () => {
        expect(
          () =>
            new TelegramClient({
              ...validConfig,
              botToken: "",
            }),
        ).toThrow("Bot token is required");
      });

      test("should reject invalid token format", () => {
        expect(
          () =>
            new TelegramClient({
              ...validConfig,
              botToken: "invalid-token",
            }),
        ).toThrow("Invalid bot token format");
      });

      test("should set default values", () => {
        const testConfig = { botToken: "123456789:ABC" };
        const testClient = new TelegramClient(testConfig);

        // Should not throw - means defaults were applied
        expect(testClient).toBeDefined();
      });
    });

    describe("Send Message Success Cases", () => {
      test("should send message successfully", async () => {
        const mockResponse = {
          ok: true,
          result: {
            messageId: 123,
            date: Date.now() / 1000,
            chat: { id: 12345, type: "private" },
          },
        };

        mockFetch.mockResolvedValueOnce(Response.json(mockResponse));

        const params: SendMessageParams = {
          chatId: "12345",
          text: "Test message",
        };

        const result = await client.sendMessage(params);

        expect(result).toEqual(mockResponse);
        expect(mockFetch).toHaveBeenCalledTimes(1);
      });

      test("should send message with formatting", async () => {
        mockFetch.mockResolvedValueOnce(Response.json({ ok: true, result: {} }));

        await client.sendMessage({
          chatId: "12345",
          text: "*Bold text*",
          parseMode: "Markdown",
          disableNotification: true,
        });

        const fetchCall = mockFetch.mock.calls[0];
        const body = JSON.parse((fetchCall[1] as RequestInit).body as string);

        expect(body.parse_mode).toBe("Markdown");
        expect(body.disable_notification).toBe(true);
      });

      test("should send to default chat", async () => {
        mockFetch.mockResolvedValueOnce(Response.json({ ok: true, result: {} }));

        await client.sendMessageToDefault("Test message");

        const fetchCall = mockFetch.mock.calls[0];
        const body = JSON.parse((fetchCall[1] as RequestInit).body as string);

        expect(body.chat_id).toBe("12345"); // Default chat ID
      });
    });

    describe("Error Handling", () => {
      test("should handle message too long error", async () => {
        const longMessage = "a".repeat(4097);

        await expect(
          client.sendMessage({
            chatId: "12345",
            text: longMessage,
          }),
        ).rejects.toMatchObject({
          type: TelegramErrorType.MESSAGE_TOO_LONG,
        });
      });

      test("should handle network errors", async () => {
        mockFetch.mockRejectedValueOnce(new TypeError("Network error"));

        await expect(
          client.sendMessage({
            chatId: "12345",
            text: "Test",
          }),
        ).rejects.toMatchObject({
          type: TelegramErrorType.NETWORK_ERROR,
        });
      });

      test("should handle timeout errors", async () => {
        // Mock fetch that never responds but honours the client's abort signal,
        // exactly like a real fetch does when the timeout fires
        mockFetch.mockImplementationOnce(
          (_url, init) =>
            new Promise<Response>((_resolve, reject) => {
              init?.signal?.addEventListener("abort", () => {
                const abortError = new Error("The operation was aborted");
                abortError.name = "AbortError";
                reject(abortError);
              });
            }),
        );

        const shortTimeoutClient = new TelegramClient({
          ...validConfig,
          timeout: 50, // Very short timeout
        });

        await expect(
          shortTimeoutClient.sendMessage({
            chatId: "12345",
            text: "Test",
          }),
        ).rejects.toMatchObject({
          type: TelegramErrorType.TIMEOUT_ERROR,
        });
      });

      test("should handle API errors", async () => {
        const errorResponse = new Response(
          JSON.stringify({
            ok: false,
            errorCode: 400,
            description: "Chat not found",
          }),
          {
            status: 400,
            statusText: "Bad Request",
          },
        );

        mockFetch.mockResolvedValueOnce(errorResponse);

        await expect(
          client.sendMessage({
            chatId: "invalid",
            text: "Test",
          }),
        ).rejects.toMatchObject({
          type: TelegramErrorType.INVALID_CHAT_ID,
        });
      });

      test("should handle unauthorized errors", async () => {
        const errorResponse = new Response(
          JSON.stringify({
            ok: false,
            errorCode: 401,
            description: "Unauthorized",
          }),
          {
            status: 401,
          },
        );

        mockFetch.mockResolvedValueOnce(errorResponse);

        await expect(
          client.sendMessage({
            chatId: "12345",
            text: "Test",
          }),
        ).rejects.toMatchObject({
          type: TelegramErrorType.INVALID_TOKEN,
        });
      });

      test("should handle rate limit errors", async () => {
        const errorResponse = new Response(
          JSON.stringify({
            ok: false,
            errorCode: 429,
            description: "Too Many Requests",
          }),
          {
            status: 429,
          },
        );

        mockFetch.mockResolvedValueOnce(errorResponse);

        await expect(
          client.sendMessage({
            chatId: "12345",
            text: "Test",
          }),
        ).rejects.toMatchObject({
          type: TelegramErrorType.RATE_LIMIT_EXCEEDED,
        });
      });

      test("should reject sendMessageToDefault without default chat ID", async () => {
        const clientWithoutDefault = new TelegramClient({
          botToken: "123456789:ABC",
        });

        await expect(clientWithoutDefault.sendMessageToDefault("Test")).rejects.toMatchObject({
          type: TelegramErrorType.INVALID_CHAT_ID,
        });
      });
    });

    describe("Utility Methods", () => {
      test("should test connection successfully", async () => {
        const result = await client.testConnection();
        expect(result).toBe(true);
      });
    });
  });

  describe("TelegramNotificationHandler", () => {
    let handler: TelegramNotificationHandler;
    let _mockClient: TelegramClient;
    let context: ExecutionContext;
    let mockRepository: IDataRepository;

    const validConfig: TelegramConfig = {
      botToken: "123456789:ABCDEFGH",
      defaultChatId: "12345",
    };

    beforeEach(() => {
      // Mock repository that returns telegram settings
      mockRepository = {
        getSetting: jest
          .fn<(userId: string, key: string) => Promise<unknown>>()
          .mockImplementation((userId: string, key: string) => {
            if (key === "telegram.bot_token") return Promise.resolve("123456789:ABCDEFGH");
            if (key === "telegram.chat_id") return Promise.resolve("12345");
            if (key === "telegram.enabled") return Promise.resolve(true);
            return Promise.resolve(null);
          }),
        getWorkflow: jest.fn<(workflowId: string) => Promise<unknown>>().mockResolvedValue({
          metadata: { name: "Test Workflow Name", version: "1.0.0", description: "test" },
        }),
      } as unknown as IDataRepository;

      _mockClient = new TelegramClient(validConfig);
      handler = new TelegramNotificationHandler();
      context = TestUtils.createTestContext({
        user_name: "TestUser",
        task: "Sample Task",
        result: "Success",
      });
      mockFetch.mockClear();
    });

    describe("Node Type Handling", () => {
      test("should handle correct node type", () => {
        const testNode: TelegramNotificationNode = {
          type: "telegram-notification",
          id: "test-telegram",
          message: "Test message",
          connections: { default: "next-node" },
        };

        expect(handler.canExecute(testNode, context)).toBe(true);
        expect(handler.getNodeType()).toBe("telegram-notification");
      });

      test("should reject incorrect node type", async () => {
        const wrongNode = {
          type: "start",
          id: "start",
          connections: { default: "next" },
        };

        const mockEngine = {} as IGraphExecutionEngine;
        await expect(
          handler.execute(
            wrongNode as any,
            context,
            new AgentMessageQueue(),
            mockRepository,
            mockEngine,
          ),
        ).rejects.toThrow(
          "TelegramNotificationHandler can only execute telegram-notification nodes",
        );
      });
    });

    describe("Successful Message Sending", () => {
      test("should send message with static chatId", async () => {
        mockFetch.mockResolvedValueOnce(
          Response.json({
            ok: true,
            result: {
              messageId: 123,
              date: Date.now() / 1000,
              chat: { id: 67890, type: "private" },
            },
          }),
        );

        const testNode: TelegramNotificationNode = {
          type: "telegram-notification",
          id: "test-telegram",
          message: "Hello World!",
          chatId: "67890",
          connections: { default: "next-node" },
        };

        const mockEngine = {} as IGraphExecutionEngine;
        const result = await handler.execute(
          testNode,
          context,
          new AgentMessageQueue(),
          mockRepository,
          mockEngine,
        );

        expect(result.action).toBe("continue");
        expect(result.outputPath).toBe("default");
        expect(result.data).toMatchObject({
          telegramNotificationSent: true,
          notificationTimestamp: expect.any(Number),
        });
        expect(mockFetch).toHaveBeenCalledTimes(1);
      });

      test("should process template variables in message", async () => {
        mockFetch.mockResolvedValueOnce(Response.json({ ok: true, result: {} }));

        const testNode: TelegramNotificationNode = {
          type: "telegram-notification",
          id: "test-telegram",
          message: "Hello {{user_name}}! Task {{task}} completed with {{result}}",
          chatId: "12345",
          connections: { default: "next-node" },
        };

        const mockEngine = {} as IGraphExecutionEngine;
        await handler.execute(
          testNode,
          context,
          new AgentMessageQueue(),
          mockRepository,
          mockEngine,
        );

        const fetchCall = mockFetch.mock.calls[0];
        const body = JSON.parse((fetchCall[1] as RequestInit).body as string);

        // Template should process correctly, under the heading and with no engine signature
        expect(body.text).toContain("Hello TestUser! Task Sample Task completed with Success");
        expect(body.text).not.toMatch(/📋 Process:|via MCP Moira/u);
        // The run page link must not unfold into a preview card of the login page.
        expect(body.link_preview_options).toEqual({ is_disabled: true });
      });

      test("should resolve workflow name in the heading", async () => {
        mockFetch.mockResolvedValueOnce(Response.json({ ok: true, result: {} }));

        const testNode: TelegramNotificationNode = {
          type: "telegram-notification",
          id: "test-telegram",
          message: "Test message",
          chatId: "12345",
          connections: { default: "next-node" },
        };

        const mockEngine = {} as IGraphExecutionEngine;
        await handler.execute(
          testNode,
          context,
          new AgentMessageQueue(),
          mockRepository,
          mockEngine,
        );

        const fetchCall = mockFetch.mock.calls[0];
        const body = JSON.parse((fetchCall[1] as RequestInit).body as string);

        // Should open with the resolved workflow name, not raw workflowId
        expect(body.text.startsWith("Test Workflow Name")).toBe(true);
        expect(mockRepository.getWorkflow).toHaveBeenCalled();
      });

      test("should fallback to workflowId when name resolution fails", async () => {
        mockFetch.mockResolvedValueOnce(Response.json({ ok: true, result: {} }));

        // Override getWorkflow to reject
        (mockRepository.getWorkflow as jest.Mock<() => Promise<unknown>>).mockRejectedValueOnce(
          new Error("not found"),
        );

        const testNode: TelegramNotificationNode = {
          type: "telegram-notification",
          id: "test-telegram",
          message: "Test message",
          chatId: "12345",
          connections: { default: "next-node" },
        };

        const mockEngine = {} as IGraphExecutionEngine;
        await handler.execute(
          testNode,
          context,
          new AgentMessageQueue(),
          mockRepository,
          mockEngine,
        );

        const fetchCall = mockFetch.mock.calls[0];
        const body = JSON.parse((fetchCall[1] as RequestInit).body as string);

        // Should fallback to raw workflowId from context
        expect(body.text.startsWith(context.workflowId)).toBe(true);
      });

      test("should use default chatId when not provided", async () => {
        mockFetch.mockResolvedValueOnce(Response.json({ ok: true, result: {} }));

        const testNode: TelegramNotificationNode = {
          type: "telegram-notification",
          id: "test-telegram",
          message: "Test message without chatId",
          connections: { default: "next-node" },
        };

        const mockEngine = {} as IGraphExecutionEngine;
        await handler.execute(
          testNode,
          context,
          new AgentMessageQueue(),
          mockRepository,
          mockEngine,
        );

        const fetchCall = mockFetch.mock.calls[0];
        const body = JSON.parse((fetchCall[1] as RequestInit).body as string);

        expect(body.chat_id).toBe("12345"); // Default from client config
      });

      test("should handle message formatting options", async () => {
        mockFetch.mockResolvedValueOnce(Response.json({ ok: true, result: {} }));

        const testNode: TelegramNotificationNode = {
          type: "telegram-notification",
          id: "test-telegram",
          message: "*Bold message*",
          chatId: "12345",
          parseMode: "Markdown",
          disableNotification: true,
          connections: { default: "next-node" },
        };

        const mockEngine = {} as IGraphExecutionEngine;
        await handler.execute(
          testNode,
          context,
          new AgentMessageQueue(),
          mockRepository,
          mockEngine,
        );

        const fetchCall = mockFetch.mock.calls[0];
        const body = JSON.parse((fetchCall[1] as RequestInit).body as string);

        expect(body.parse_mode).toBe("Markdown");
        expect(body.disable_notification).toBe(true);
      });
    });

    describe("Error Handling - Graceful Degradation", () => {
      test("should continue workflow on telegram API error (default connection)", async () => {
        const errorResponse = new Response(
          JSON.stringify({
            ok: false,
            errorCode: 400,
            description: "Chat not found",
          }),
          { status: 400 },
        );

        mockFetch.mockResolvedValueOnce(errorResponse);

        const testNode: TelegramNotificationNode = {
          type: "telegram-notification",
          id: "test-telegram",
          message: "Test message",
          chatId: "invalid-chat",
          connections: { default: "next-node" },
        };

        const mockEngine = {} as IGraphExecutionEngine;
        const result = await handler.execute(
          testNode,
          context,
          new AgentMessageQueue(),
          mockRepository,
          mockEngine,
        );

        expect(result.action).toBe("continue");
        expect(result.outputPath).toBe("default");
        expect(result.data).toMatchObject({
          telegramNotificationFailed: true,
          errorType: TelegramErrorType.INVALID_CHAT_ID,
        });
      });

      test("should use error connection when provided", async () => {
        mockFetch.mockRejectedValueOnce(new TypeError("Network error"));

        const testNode: TelegramNotificationNode = {
          type: "telegram-notification",
          id: "test-telegram",
          message: "Test message",
          chatId: "12345",
          connections: {
            default: "next-node",
            error: "error-handler",
          },
        };

        const mockEngine = {} as IGraphExecutionEngine;
        const result = await handler.execute(
          testNode,
          context,
          new AgentMessageQueue(),
          mockRepository,
          mockEngine,
        );

        expect(result.action).toBe("continue");
        expect(result.outputPath).toBe("error");
        expect(result.data).toMatchObject({
          telegramNotificationFailed: true,
          errorType: TelegramErrorType.NETWORK_ERROR,
        });
      });

      test("should handle missing chatId and no default", async () => {
        // Mock repository that returns bot token but no chat_id
        const repoWithoutChatId = {
          getSetting: jest
            .fn<(userId: string, key: string) => Promise<unknown>>()
            .mockImplementation((userId: string, key: string) => {
              if (key === "telegram.bot_token") return Promise.resolve("123456789:ABCDEFGH");
              if (key === "telegram.chat_id") return Promise.resolve(null); // No default chat ID
              if (key === "telegram.enabled") return Promise.resolve(true);
              return Promise.resolve(null);
            }),
        } as unknown as IDataRepository;

        const testNode: TelegramNotificationNode = {
          type: "telegram-notification",
          id: "test-telegram",
          message: "Test message",
          connections: { default: "next-node" },
        };

        const mockEngine = {} as IGraphExecutionEngine;
        const result = await handler.execute(
          testNode,
          context,
          new AgentMessageQueue(),
          repoWithoutChatId,
          mockEngine,
        );

        expect(result.action).toBe("continue");
        expect(result.data).toMatchObject({
          telegramNotificationFailed: true,
          errorType: TelegramErrorType.INVALID_CHAT_ID,
        });
      });

      test("should process chatId templates", async () => {
        mockFetch.mockResolvedValueOnce(Response.json({ ok: true, result: {} }));

        const contextWithChatId = TestUtils.createTestContext({
          user_chat_id: "98765",
        });

        const testNode: TelegramNotificationNode = {
          type: "telegram-notification",
          id: "test-telegram",
          message: "Template test",
          chatId: "{{user_chat_id}}",
          connections: { default: "next-node" },
        };

        const mockEngine = {} as IGraphExecutionEngine;
        await handler.execute(
          testNode,
          contextWithChatId,
          new AgentMessageQueue(),
          mockRepository,
          mockEngine,
        );

        const fetchCall = mockFetch.mock.calls[0];
        const body = JSON.parse((fetchCall[1] as RequestInit).body as string);

        expect(body.chat_id).toBe("98765");
      });
    });

    describe("Integration with Services", () => {
      test("should use provided telegram client", () => {
        const _customClient = new TelegramClient(validConfig);
        const customHandler = new TelegramNotificationHandler();

        expect(customHandler.getNodeType()).toBe("telegram-notification");
      });

      test("should deliver through the configured HTTP client", async () => {
        mockFetch.mockResolvedValueOnce(Response.json({ ok: true, result: {} }));

        const testNode: TelegramNotificationNode = {
          type: "telegram-notification",
          id: "test-telegram",
          message: "Rate limit test",
          chatId: "12345",
          connections: { default: "next-node" },
        };

        const mockEngine = {} as IGraphExecutionEngine;
        const result = await handler.execute(
          testNode,
          context,
          new AgentMessageQueue(),
          mockRepository,
          mockEngine,
        );

        expect(result.action).toBe("continue");
        expect(mockFetch).toHaveBeenCalledTimes(1);
      });
    });
  });
});
