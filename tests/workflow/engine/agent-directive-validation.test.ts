/**
 * Agent Directive Validation Tests
 * Integration tests for AgentDirectiveHandler validation behavior
 */

import { describe, test, expect } from "@jest/globals";
import {
  AgentDirectiveHandler,
  AgentDirectiveNode,
  AgentMessageQueue,
  IGraphExecutionEngine,
} from "@mcp-moira/workflow-engine";
import type { IDataRepository } from "@mcp-moira/workflow-engine";
import { TestUtils } from "../../utils/test-helpers.js";

describe("Agent Directive Validation", () => {
  const handler = new AgentDirectiveHandler();
  const mockRepository = {} as IDataRepository;
  const mockEngine = {} as IGraphExecutionEngine;

  const createTestNode = (inputSchema?: Record<string, unknown>): AgentDirectiveNode => ({
    type: "agent-directive",
    id: "test-node",
    directive: "Test directive",
    completionCondition: "Test completed",
    inputSchema,
    connections: { success: "end" },
  });

  describe("✅ Successful Validation", () => {
    test("should continue when valid data provided", async () => {
      const node = createTestNode({
        type: "object",
        properties: {
          name: { type: "string" },
          score: { type: "number" },
        },
        required: ["name", "score"],
      });
      const context = TestUtils.createTestContext();

      const result = await handler.execute(
        node,
        context,
        new AgentMessageQueue(),
        mockRepository,
        mockEngine,
        {
          name: "TestName",
          score: 95,
        },
      );

      expect(result.action).toBe("continue");
      expect(result.outputPath).toBe("success");
      expect(result.data).toEqual({ name: "TestName", score: 95 });
    });

    test("should continue when empty object provided (no schema = confirmation)", async () => {
      const node = createTestNode(); // No inputSchema
      const context = TestUtils.createTestContext();

      // Empty object {} is valid confirmation for nodes without inputSchema
      const result = await handler.execute(
        node,
        context,
        new AgentMessageQueue(),
        mockRepository,
        mockEngine,
        {},
      );

      // Empty object = confirmation, should continue
      expect(result.action).toBe("continue");
      expect(result.outputPath).toBe("success");
    });

    test("should pause when null input provided (first call)", async () => {
      const node = createTestNode(); // No inputSchema
      const context = TestUtils.createTestContext();

      // null = first call, show directive
      const result = await handler.execute(
        node,
        context,
        new AgentMessageQueue(),
        mockRepository,
        mockEngine,
        null,
      );

      // null input = first call, pause to show directive
      expect(result.action).toBe("pause");
    });

    test("should pause when undefined input provided (first call)", async () => {
      const node = createTestNode(); // No inputSchema
      const context = TestUtils.createTestContext();

      // undefined = first call, show directive
      const result = await handler.execute(
        node,
        context,
        new AgentMessageQueue(),
        mockRepository,
        mockEngine,
        undefined,
      );

      // undefined input = first call, pause to show directive
      expect(result.action).toBe("pause");
    });

    test("should pause when no input provided", async () => {
      const node = createTestNode({
        type: "object",
        properties: { name: { type: "string" } },
        required: ["name"],
      });
      const context = TestUtils.createTestContext();
      const messageQueue = new AgentMessageQueue();

      const result = await handler.execute(node, context, messageQueue, mockRepository, mockEngine);

      expect(result.action).toBe("pause");
      const queueResponse = messageQueue.flush("test-process");
      expect(queueResponse.messages).toHaveLength(1);
    });
  });

  describe("❌ Validation Failures", () => {
    test("should reject arbitrary input when no schema specified (issue #369)", async () => {
      const node = createTestNode(); // No inputSchema
      const context = TestUtils.createTestContext();
      const messageQueue = new AgentMessageQueue();

      // Issue #369: When no inputSchema defined, only empty input allowed
      // Garbage data MUST be rejected to prevent pollution of context
      // Step 12: New error format uses "Input validation failed" message with rich context
      await expect(
        handler.execute(node, context, messageQueue, mockRepository, mockEngine, {
          garbage: 123,
          random_bool: true,
          whatever: [1, 2, 3],
        }),
      ).rejects.toThrow("Input validation failed");
    });

    test("should throw validation error for invalid data", async () => {
      const node = createTestNode({
        type: "object",
        properties: { name: { type: "string" } },
        required: ["name"],
      });
      const context = TestUtils.createTestContext();
      const messageQueue = new AgentMessageQueue();

      // Validation errors should be thrown directly to MCP layer
      // Step 12: New error format uses "Input validation failed" message with rich context
      await expect(
        handler.execute(node, context, messageQueue, mockRepository, mockEngine, { name: 123 }),
      ).rejects.toThrow("Input validation failed");
    });

    test("should throw validation error for missing required fields", async () => {
      const node = createTestNode({
        type: "object",
        properties: {
          name: { type: "string" },
          email: { type: "string" },
        },
        required: ["name", "email"],
      });
      const context = TestUtils.createTestContext();
      const messageQueue = new AgentMessageQueue();

      // Missing required field should throw
      // Step 12: New error format uses "Input validation failed" message with rich context
      await expect(
        handler.execute(node, context, messageQueue, mockRepository, mockEngine, {
          name: "TestName",
        }),
      ).rejects.toThrow("Input validation failed");
    });
  });

  describe("🎯 Integration Tests", () => {
    test("should integrate with SchemaValidator correctly", async () => {
      const node = createTestNode({
        type: "object",
        properties: {
          complexData: {
            type: "object",
            properties: {
              nested: { type: "string" },
            },
            required: ["nested"],
          },
        },
        required: ["complexData"],
      });
      const context = TestUtils.createTestContext();

      // Valid nested object
      const validResult = await handler.execute(
        node,
        context,
        new AgentMessageQueue(),
        mockRepository,
        mockEngine,
        {
          complexData: { nested: "value" },
        },
      );
      expect(validResult.action).toBe("continue");

      // Invalid nested object should throw
      // Step 12: New error format uses "Input validation failed" message with rich context
      await expect(
        handler.execute(node, context, new AgentMessageQueue(), mockRepository, mockEngine, {
          complexData: { nested: 123 },
        }),
      ).rejects.toThrow("Input validation failed");
    });
  });
});
