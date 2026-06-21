/**
 * Unit Tests for Node Handlers
 * Test individual node handler functionality
 */

import { describe, test, expect } from "@jest/globals";
import {
  StartNodeHandler,
  EndNodeHandler,
  AgentDirectiveHandler,
  ConditionHandler,
  TeleportHandler,
  AgentMessageQueue,
  DirectiveMessage,
} from "@mcp-moira/workflow-engine";
import {
  StartNode,
  EndNode,
  AgentDirectiveNode,
  ConditionNode,
  TeleportNode,
  ConditionBuilder,
} from "@mcp-moira/workflow-engine";
import { IGraphStorage, IGraphExecutionEngine } from "@mcp-moira/workflow-engine";

describe("Node Handlers", () => {
  describe("StartNodeHandler", () => {
    test("should execute start node and continue to next", async () => {
      const handler = new StartNodeHandler();
      const context = TestUtils.createTestContext();

      const startNode: StartNode = {
        type: "start",
        id: "start",
        initialData: {
          variables: {
            initialized: { description: "Initialization flag", value: true },
          },
        },
        connections: { default: "next-node" },
      };

      const mockStorage = {} as IGraphStorage;
      const mockEngine = {} as IGraphExecutionEngine;
      const result = await handler.execute(
        startNode,
        context,
        new AgentMessageQueue(),
        mockStorage,
        mockEngine,
      );

      expect(result.nodeId).toBe("start");
      expect(result.action).toBe("continue");
      expect(result.outputPath).toBe("default");
      expect(result.data).toEqual({ initialized: true });
    });

    test("should merge initial data and input", async () => {
      const handler = new StartNodeHandler();
      const context = TestUtils.createTestContext({ existing: "value" });

      const startNode: StartNode = {
        type: "start",
        id: "start",
        initialData: {
          variables: {
            fromNode: { description: "Value from node", value: "initial" },
          },
        },
        connections: { default: "next" },
      };

      const mockStorage = {} as IGraphStorage;
      const mockEngine = {} as IGraphExecutionEngine;
      const result = await handler.execute(
        startNode,
        context,
        new AgentMessageQueue(),
        mockStorage,
        mockEngine,
        { fromInput: "input" },
      );

      expect(result.data).toEqual({
        fromNode: "initial",
        fromInput: "input",
      });
    });
  });

  describe("EndNodeHandler", () => {
    test("should complete workflow with final output", async () => {
      const handler = new EndNodeHandler();
      const context = TestUtils.createTestContext({
        result: "success",
        score: 95,
        temp: "should not include",
      });

      const endNode: EndNode = {
        type: "end",
        id: "end",
        finalOutput: ["result", "score"],
      };

      const mockStorage = {} as IGraphStorage;
      const mockEngine = {} as IGraphExecutionEngine;
      const result = await handler.execute(
        endNode,
        context,
        new AgentMessageQueue(),
        mockStorage,
        mockEngine,
      );

      expect(result.nodeId).toBe("end");
      expect(result.action).toBe("complete");
      expect(result.outputPath).toBe("");
      expect(result.data).toEqual({
        result: "success",
        score: 95,
      });
    });

    test("should include all variables if no finalOutput specified", async () => {
      const handler = new EndNodeHandler();
      const context = TestUtils.createTestContext({
        var1: "value1",
        var2: "value2",
      });

      const endNode: EndNode = {
        type: "end",
        id: "end",
      };

      const mockStorage = {} as IGraphStorage;
      const mockEngine = {} as IGraphExecutionEngine;
      const result = await handler.execute(
        endNode,
        context,
        new AgentMessageQueue(),
        mockStorage,
        mockEngine,
      );

      expect(result.data).toEqual({
        var1: "value1",
        var2: "value2",
      });
    });
  });

  describe("ConditionHandler", () => {
    test("should evaluate simple condition and continue", async () => {
      const handler = new ConditionHandler();
      const context = TestUtils.createTestContext({ score: 85 });

      const conditionNode: ConditionNode = {
        type: "condition",
        id: "score-check",
        condition: ConditionBuilder.greaterThan(ConditionBuilder.contextPath("score"), 70),
        connections: {
          true: "high-score",
          false: "low-score",
        },
      };

      const mockStorage = {} as IGraphStorage;
      const mockEngine = {} as IGraphExecutionEngine;
      const result = await handler.execute(
        conditionNode,
        context,
        new AgentMessageQueue(),
        mockStorage,
        mockEngine,
      );

      expect(result.nodeId).toBe("score-check");
      expect(result.action).toBe("continue");
      expect(result.outputPath).toBe("true");
      expect(result.data).toMatchObject({
        conditionResult: true,
      });
    });

    test("should handle false condition", async () => {
      const handler = new ConditionHandler();
      const context = TestUtils.createTestContext({ score: 50 });

      const conditionNode: ConditionNode = {
        type: "condition",
        id: "score-check",
        condition: ConditionBuilder.greaterThan(ConditionBuilder.contextPath("score"), 70),
        connections: {
          true: "high-score",
          false: "low-score",
        },
      };

      const mockStorage = {} as IGraphStorage;
      const mockEngine = {} as IGraphExecutionEngine;
      const result = await handler.execute(
        conditionNode,
        context,
        new AgentMessageQueue(),
        mockStorage,
        mockEngine,
      );

      expect(result.outputPath).toBe("false");
      expect(result.data).toMatchObject({
        conditionResult: false,
      });
    });

    test("should handle AND compound condition", async () => {
      const handler = new ConditionHandler();
      const context = TestUtils.createTestContext({ score: 8, status: "approved" });

      const conditionNode: ConditionNode = {
        type: "condition",
        id: "and-check",
        condition: {
          operator: "and",
          conditions: [
            {
              operator: "gte",
              left: { contextPath: "score" },
              right: 7,
            },
            {
              operator: "eq",
              left: { contextPath: "status" },
              right: "approved",
            },
          ],
        } as any,
        connections: {
          true: "success",
          false: "failure",
        },
      };

      const mockStorage = {} as IGraphStorage;
      const mockEngine = {} as IGraphExecutionEngine;
      const result = await handler.execute(
        conditionNode,
        context,
        new AgentMessageQueue(),
        mockStorage,
        mockEngine,
      );

      expect(result.outputPath).toBe("true");
      expect(result.data).toMatchObject({
        conditionResult: true,
      });
    });

    test("should handle OR compound condition", async () => {
      const handler = new ConditionHandler();
      const context = TestUtils.createTestContext({ priority: "high", urgent: false });

      const conditionNode: ConditionNode = {
        type: "condition",
        id: "or-check",
        condition: {
          operator: "or",
          conditions: [
            {
              operator: "eq",
              left: { contextPath: "priority" },
              right: "high",
            },
            {
              operator: "eq",
              left: { contextPath: "urgent" },
              right: true,
            },
          ],
        } as any,
        connections: {
          true: "success",
          false: "failure",
        },
      };

      const mockStorage = {} as IGraphStorage;
      const mockEngine = {} as IGraphExecutionEngine;
      const result = await handler.execute(
        conditionNode,
        context,
        new AgentMessageQueue(),
        mockStorage,
        mockEngine,
      );

      expect(result.outputPath).toBe("true"); // priority is 'high'
      expect(result.data).toMatchObject({
        conditionResult: true,
      });
    });

    test("should handle NOT compound condition", async () => {
      const handler = new ConditionHandler();
      const context = TestUtils.createTestContext({ status: "enabled" });

      const conditionNode: ConditionNode = {
        type: "condition",
        id: "not-check",
        condition: {
          operator: "not",
          condition: {
            operator: "eq",
            left: { contextPath: "status" },
            right: "disabled",
          },
        } as any,
        connections: {
          true: "success",
          false: "failure",
        },
      };

      const mockStorage = {} as IGraphStorage;
      const mockEngine = {} as IGraphExecutionEngine;
      const result = await handler.execute(
        conditionNode,
        context,
        new AgentMessageQueue(),
        mockStorage,
        mockEngine,
      );

      expect(result.outputPath).toBe("true"); // NOT (status == 'disabled') = true
      expect(result.data).toMatchObject({
        conditionResult: true,
      });
    });
  });

  describe("AgentDirectiveHandler", () => {
    test("should return pause and add message to queue when no input", async () => {
      const handler = new AgentDirectiveHandler();
      const mockQueue = new AgentMessageQueue();
      const context = TestUtils.createTestContext();

      const agentNode: AgentDirectiveNode = {
        type: "agent-directive",
        id: "ask-user",
        directive: "What is your name?",
        completionCondition: "Name provided",
        inputSchema: {
          type: "object",
          properties: { userName: { type: "string" } },
          required: ["userName"],
        },
        connections: { success: "next" },
      };

      const mockStorage = {} as IGraphStorage;
      const mockEngine = {} as IGraphExecutionEngine;
      const result = await handler.execute(agentNode, context, mockQueue, mockStorage, mockEngine);

      expect(result.action).toBe("pause");
      const queueResponse = mockQueue.flush("test-process");
      expect(queueResponse.messages).toHaveLength(1);
      expect((queueResponse.messages[0] as DirectiveMessage).directive).toBe("What is your name?");
    });

    test("should validate input and continue on success", async () => {
      const handler = new AgentDirectiveHandler();
      const mockQueue = new AgentMessageQueue();
      const context = TestUtils.createTestContext();

      const agentNode: AgentDirectiveNode = {
        type: "agent-directive",
        id: "ask-user",
        directive: "What is your name?",
        completionCondition: "Name provided",
        inputSchema: {
          type: "object",
          properties: { userName: { type: "string" } },
          required: ["userName"],
        },
        connections: { success: "next" },
      };

      const mockStorage = {} as IGraphStorage;
      const mockEngine = {} as IGraphExecutionEngine;
      const result = await handler.execute(agentNode, context, mockQueue, mockStorage, mockEngine, {
        userName: "TestUser",
      });

      expect(result.action).toBe("continue");
      expect(result.outputPath).toBe("success");
      expect(result.data).toEqual({ userName: "TestUser" });
    });

    test("should throw validation errors directly", async () => {
      const handler = new AgentDirectiveHandler();
      const mockQueue = new AgentMessageQueue();
      const context = TestUtils.createTestContext();

      const agentNode: AgentDirectiveNode = {
        type: "agent-directive",
        id: "ask-user",
        directive: "What is your name?",
        completionCondition: "Name provided",
        inputSchema: {
          type: "object",
          properties: { userName: { type: "string" } },
          required: ["userName"],
        },
        connections: { success: "next" },
      };

      const mockStorage = {} as IGraphStorage;
      const mockEngine = {} as IGraphExecutionEngine;

      // Validation errors should be thrown, not queued
      // Step 12: New error message format includes rich context
      await expect(
        handler.execute(agentNode, context, mockQueue, mockStorage, mockEngine, { userName: 123 }),
      ).rejects.toThrow("Input validation failed");
    });
  });

  describe("TeleportHandler", () => {
    test("should return pause and add message to queue when no input", async () => {
      const handler = new TeleportHandler();
      const mockQueue = new AgentMessageQueue();
      const context = TestUtils.createTestContext();

      const teleportNode: TeleportNode = {
        type: "teleport",
        id: "teleport-replan",
        directive: "Rewrite the plan from scratch",
        completionCondition: "New plan created",
        hint: "Use when current plan needs restructuring",
        inputSchema: {
          type: "object",
          properties: { reason: { type: "string" } },
          required: ["reason"],
        },
        connections: { success: "plan-node" },
      };

      const mockStorage = {} as IGraphStorage;
      const mockEngine = {} as IGraphExecutionEngine;
      const result = await handler.execute(
        teleportNode,
        context,
        mockQueue,
        mockStorage,
        mockEngine,
      );

      expect(result.action).toBe("pause");
      const queueResponse = mockQueue.flush("test-process");
      expect(queueResponse.messages).toHaveLength(1);
      expect((queueResponse.messages[0] as DirectiveMessage).directive).toBe(
        "Rewrite the plan from scratch",
      );
    });

    test("should validate input and continue on success", async () => {
      const handler = new TeleportHandler();
      const mockQueue = new AgentMessageQueue();
      const context = TestUtils.createTestContext();

      const teleportNode: TeleportNode = {
        type: "teleport",
        id: "teleport-replan",
        directive: "Rewrite the plan",
        completionCondition: "Done",
        hint: "Use for replanning",
        inputSchema: {
          type: "object",
          properties: { reason: { type: "string" } },
          required: ["reason"],
        },
        connections: { success: "next" },
      };

      const mockStorage = {} as IGraphStorage;
      const mockEngine = {} as IGraphExecutionEngine;
      const result = await handler.execute(
        teleportNode,
        context,
        mockQueue,
        mockStorage,
        mockEngine,
        { reason: "Plan is outdated" },
      );

      expect(result.action).toBe("continue");
      expect(result.outputPath).toBe("success");
      expect(result.data).toEqual({ reason: "Plan is outdated" });
    });

    test("should throw validation error on invalid input", async () => {
      const handler = new TeleportHandler();
      const mockQueue = new AgentMessageQueue();
      const context = TestUtils.createTestContext();

      const teleportNode: TeleportNode = {
        type: "teleport",
        id: "teleport-replan",
        directive: "Rewrite the plan",
        completionCondition: "Done",
        hint: "Use for replanning",
        inputSchema: {
          type: "object",
          properties: { reason: { type: "string" } },
          required: ["reason"],
        },
        connections: { success: "next" },
      };

      const mockStorage = {} as IGraphStorage;
      const mockEngine = {} as IGraphExecutionEngine;

      await expect(
        handler.execute(teleportNode, context, mockQueue, mockStorage, mockEngine, {
          reason: 123,
        }),
      ).rejects.toThrow("Input validation failed");
    });

    test("should process templates in directive", async () => {
      const handler = new TeleportHandler();
      const mockQueue = new AgentMessageQueue();
      const context = TestUtils.createTestContext({ step_name: "Authentication" });

      const teleportNode: TeleportNode = {
        type: "teleport",
        id: "teleport-replan",
        directive: "Rewrite the plan for {{step_name}}",
        completionCondition: "Plan rewritten for {{step_name}}",
        hint: "Use for replanning",
        connections: { success: "next" },
      };

      const mockStorage = {} as IGraphStorage;
      const mockEngine = {} as IGraphExecutionEngine;
      await handler.execute(teleportNode, context, mockQueue, mockStorage, mockEngine);

      const queueResponse = mockQueue.flush("test-process");
      expect((queueResponse.messages[0] as DirectiveMessage).directive).toBe(
        "Rewrite the plan for Authentication",
      );
      expect((queueResponse.messages[0] as DirectiveMessage).completionCondition).toBe(
        "Plan rewritten for Authentication",
      );
    });

    test("should reject empty input when no inputSchema defined", async () => {
      const handler = new TeleportHandler();
      const mockQueue = new AgentMessageQueue();
      const context = TestUtils.createTestContext();

      const teleportNode: TeleportNode = {
        type: "teleport",
        id: "teleport-replan",
        directive: "Do something",
        completionCondition: "Done",
        hint: "Use for replanning",
        connections: { success: "next" },
      };

      const mockStorage = {} as IGraphStorage;
      const mockEngine = {} as IGraphExecutionEngine;

      // With no inputSchema, non-empty objects should be rejected (empty schema)
      await expect(
        handler.execute(teleportNode, context, mockQueue, mockStorage, mockEngine, {
          extra: "data",
        }),
      ).rejects.toThrow("Input validation failed");
    });
  });
});
