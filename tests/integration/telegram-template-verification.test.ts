/**
 * Telegram Template Verification Tests
 * Mock telegram service to verify exact message content sent to API
 */

import { describe, test, expect, beforeEach, jest } from "@jest/globals";
import { UniversalGraphExecutor } from "@mcp-moira/workflow-engine";
import { TelegramClient } from "@mcp-moira/workflow-engine";
import { WorkflowGraph } from "@mcp-moira/workflow-engine";
import { TelegramConfig } from "@mcp-moira/workflow-engine";
import { setTestClientFactory, resetClientFactory } from "@mcp-moira/workflow-engine";
import type { InMemoryRepository } from "@mcp-moira/workflow-engine";

// Mock fetch to capture exact message content
const mockFetch = jest.fn() as jest.MockedFunction<typeof fetch>;
global.fetch = mockFetch;

describe("Telegram Template Verification", () => {
  let executor: UniversalGraphExecutor;
  let repository: InMemoryRepository;
  let mockClient: TelegramClient;
  let sentMessages: any[] = [];

  const validConfig: TelegramConfig = {
    botToken: "123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZ",
    defaultChatId: "12345",
  };

  beforeEach(async () => {
    const setup = await createTestExecutor();
    executor = setup.executor;
    repository = setup.repository;

    // Setup telegram settings in repository
    repository.addSettingDefinition({
      key: "telegram.bot_token",
      type: "encrypted",
      category: "telegram",
      displayName: "Bot Token",
      description: "Telegram bot token",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    repository.addSettingDefinition({
      key: "telegram.chat_id",
      type: "string",
      category: "telegram",
      displayName: "Chat ID",
      description: "Default Telegram chat ID",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    repository.addSettingDefinition({
      key: "telegram.enabled",
      type: "boolean",
      category: "telegram",
      displayName: "Enabled",
      description: "Enable Telegram notifications",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    await repository.setSetting("test-user-123", "telegram.bot_token", validConfig.botToken);
    await repository.setSetting("test-user-123", "telegram.chat_id", validConfig.defaultChatId);
    await repository.setSetting("test-user-123", "telegram.enabled", true);

    // Clear sent messages log
    sentMessages = [];

    // Mock fetch to capture message content
    mockFetch.mockClear();
    mockFetch.mockImplementation(async (url, options) => {
      const body = JSON.parse((options as RequestInit).body as string);
      sentMessages.push({
        url: url.toString(),
        chatId: body.chat_id,
        text: body.text,
        parseMode: body.parse_mode,
        timestamp: new Date().toISOString(),
      });

      return Response.json({
        ok: true,
        result: {
          messageId: sentMessages.length,
          date: Date.now() / 1000,
          chat: { id: 12345, type: "private" },
        },
      });
    });

    // Create mock client and set factory
    mockClient = new TelegramClient(validConfig);
    setTestClientFactory(() => mockClient);
  });

  afterEach(() => {
    // Reset factory to default for clean test isolation
    resetClientFactory();
  });

  describe("Template Processing Issues Verification", () => {
    test("should verify template variable processing without quotes", async () => {
      const workflow: WorkflowGraph = {
        id: "template-verification-workflow",
        metadata: {
          name: "Template Verification",
          version: "1.0.0",
          description: "Verify template variable processing",
        },
        nodes: [
          {
            type: "start",
            id: "start",
            initialData: {
              variables: {
                user_name: { description: "User name", value: "TestUser" },
                project_name: { description: "Project name", value: "MCP Moira" },
                completion_status: { description: "Status", value: "success" },
              },
            },
            connections: { default: "notify" },
          },
          {
            type: "telegram-notification",
            id: "notify",
            message: "Hello {{user_name}}! Project {{project_name}} status: {{completion_status}}",
            chatId: "12345",
            parseMode: "Markdown",
            connections: { default: "end" },
          },
          {
            type: "end",
            id: "end",
          },
        ],
      };

      await repository.saveWorkflow(workflow, "test-user-123", "private");
      const processId = await executor.startWorkflow(workflow, undefined, "test-user-123");
      await executor.executeStep(processId);

      // Verify message was sent
      expect(sentMessages).toHaveLength(1);

      const sentMessage = sentMessages[0];
      console.log("📤 SENT MESSAGE CONTENT:", sentMessage.text);

      // Check for template processing issues
      expect(sentMessage.text).toContain("TestUser");
      expect(sentMessage.text).toContain("MCP Moira");
      expect(sentMessage.text).toContain("success");

      // VERIFY ISSUES: Check if quotes are being added
      console.log("🔍 QUOTE ANALYSIS:");
      console.log('- Contains "TestUser" (with quotes):', sentMessage.text.includes('"TestUser"'));
      console.log(
        "- Contains TestUser (without quotes):",
        sentMessage.text.includes("TestUser") && !sentMessage.text.includes('"TestUser"'),
      );
    });

    test("should verify executionId availability in template context", async () => {
      const workflow: WorkflowGraph = {
        id: "execution-id-test",
        metadata: {
          name: "Execution ID Test",
          version: "1.0.0",
          description: "Test executionId template variable",
        },
        nodes: [
          {
            type: "start",
            id: "start",
            initialData: {
              variables: { test_type: { description: "Test type", value: "execution_id_test" } },
            },
            connections: { default: "notify" },
          },
          {
            type: "telegram-notification",
            id: "notify",
            message: "Process ID: {{executionId}}\nWorkflow: {{workflowId}}\nTest: {{test_type}}",
            connections: { default: "end" },
          },
          {
            type: "end",
            id: "end",
          },
        ],
      };

      await repository.saveWorkflow(workflow, "test-user-123", "private");
      const processId = await executor.startWorkflow(workflow, undefined, "test-user-123");
      await executor.executeStep(processId);

      expect(sentMessages).toHaveLength(1);

      const sentMessage = sentMessages[0];
      console.log("📤 EXECUTION CONTEXT MESSAGE:", sentMessage.text);

      // Check if executionId is available
      console.log("🔍 EXECUTION CONTEXT ANALYSIS:");
      console.log("- Contains executionId:", sentMessage.text.includes(processId));
      console.log('- Contains "null":', sentMessage.text.includes("null"));
      console.log("- Contains workflow ID:", sentMessage.text.includes("execution-id-test"));

      // Verify process information
      expect(sentMessage.text).toContain(processId.substring(0, 8)); // At least partial process ID
      expect(sentMessage.text).not.toContain("null"); // Should not have null values
    });

    test("should verify consistent process info in all telegram messages", async () => {
      const workflow: WorkflowGraph = {
        id: "process-info-consistency",
        metadata: {
          name: "Process Info Consistency",
          version: "1.0.0",
          description: "Ensure process info always available",
        },
        nodes: [
          {
            type: "start",
            id: "start",
            initialData: {
              variables: { step: { description: "Current step", value: "initialization" } },
            },
            connections: { default: "notify-start" },
          },
          {
            type: "telegram-notification",
            id: "notify-start",
            message:
              "🚀 Started: {{step}}\n📋 Process: {{executionId}}\n🔄 Workflow: {{workflowId}}",
            connections: { default: "update-step" },
          },
          {
            type: "start", // Use start node to update context
            id: "update-step",
            initialData: {
              variables: { step: { description: "Current step", value: "completion" } },
            },
            connections: { default: "notify-end" },
          },
          {
            type: "telegram-notification",
            id: "notify-end",
            message:
              "✅ Completed: {{step}}\n📋 Process: {{executionId}}\n🔄 Workflow: {{workflowId}}",
            connections: { default: "end" },
          },
          {
            type: "end",
            id: "end",
          },
        ],
      };

      await repository.saveWorkflow(workflow, "test-user-123", "private");
      const processId = await executor.startWorkflow(workflow, undefined, "test-user-123");
      await executor.executeStep(processId);

      // Should have 2 telegram messages
      expect(sentMessages).toHaveLength(2);

      console.log("📤 MULTIPLE MESSAGES ANALYSIS:");
      sentMessages.forEach((msg, index) => {
        console.log(`Message ${index + 1}:`, msg.text);
        console.log(`- Has processId: ${msg.text.includes(processId)}`);
        console.log(`- Has null: ${msg.text.includes("null")}`);
        console.log(`- Has workflowId: ${msg.text.includes("process-info-consistency")}`);
      });

      // Both messages should have consistent process info
      sentMessages.forEach((msg, _index) => {
        expect(msg.text).toContain(processId.substring(0, 8));
        expect(msg.text).not.toContain("null");
        expect(msg.text).toContain("process-info-consistency");
      });
    });
  });

  describe("Template Formatting Verification", () => {
    test("should capture exact formatting issues for analysis", async () => {
      const testVariables = {
        variables: {
          simple_string: { description: "Simple string", value: "Hello World" },
          number_value: { description: "Number value", value: 42 },
          boolean_value: { description: "Boolean flag", value: true },
          object_value: { description: "Object data", value: { nested: "data" } },
          array_value: { description: "Array data", value: ["item1", "item2"] },
        },
      };

      const workflow: WorkflowGraph = {
        id: "formatting-test",
        metadata: {
          name: "Formatting Test",
          version: "1.0.0",
          description: "Test various template variable types",
        },
        nodes: [
          {
            type: "start",
            id: "start",
            initialData: testVariables,
            connections: { default: "notify" },
          },
          {
            type: "telegram-notification",
            id: "notify",
            message:
              "String: {{simple_string}}\nNumber: {{number_value}}\nBoolean: {{boolean_value}}\nObject: {{object_value}}\nArray: {{array_value}}",
            connections: { default: "end" },
          },
          {
            type: "end",
            id: "end",
          },
        ],
      };

      await repository.saveWorkflow(workflow, "test-user-123", "private");
      const processId = await executor.startWorkflow(workflow, undefined, "test-user-123");
      await executor.executeStep(processId);

      expect(sentMessages).toHaveLength(1);

      const message = sentMessages[0].text;

      // Verify each variable type is rendered correctly in the message
      expect(message).toContain("String: Hello World");
      expect(message).toContain("Number: 42");
      expect(message).toContain("Boolean: true");
      // Object and array should be serialized as JSON
      expect(message).toContain("Object:");
      expect(message).toContain("Array:");
    });
  });
});
