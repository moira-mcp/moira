/**
 * Unit Tests for Expression Handler
 * Tests the expression node handler
 */

import { describe, test, expect } from "@jest/globals";
import { ExpressionHandler, AgentMessageQueue, ExpressionNode } from "@mcp-moira/workflow-engine";
import { IGraphStorage, IGraphExecutionEngine } from "@mcp-moira/workflow-engine";

describe("ExpressionHandler", () => {
  const handler = new ExpressionHandler();
  const mockStorage = {} as IGraphStorage;
  const mockEngine = {} as IGraphExecutionEngine;

  test("should return correct node type", () => {
    expect(handler.getNodeType()).toBe("expression");
  });

  test("should execute single expression", async () => {
    const context = TestUtils.createTestContext({ x: 10 });

    const expressionNode: ExpressionNode = {
      type: "expression",
      id: "calc-1",
      expressions: ["y = x + 5"],
      connections: { default: "next-node" },
    };

    const result = await handler.execute(
      expressionNode,
      context,
      new AgentMessageQueue(),
      mockStorage,
      mockEngine,
    );

    expect(result.nodeId).toBe("calc-1");
    expect(result.action).toBe("continue");
    expect(result.outputPath).toBe("default");
    expect(result.data).toEqual({ y: 15 });
  });

  test("should execute multiple expressions in order", async () => {
    const context = TestUtils.createTestContext({ a: 5, b: 3 });

    const expressionNode: ExpressionNode = {
      type: "expression",
      id: "calc-multi",
      expressions: ["sum = a + b", "product = a * b", "ratio = sum / product"],
      connections: { default: "next-node" },
    };

    const result = await handler.execute(
      expressionNode,
      context,
      new AgentMessageQueue(),
      mockStorage,
      mockEngine,
    );

    expect(result.action).toBe("continue");
    expect(result.data).toEqual({
      sum: 8, // 5 + 3
      product: 15, // 5 * 3
      ratio: 8 / 15, // 8 / 15
    });
  });

  test("should use previous assignment in subsequent expression", async () => {
    const context = TestUtils.createTestContext({ base: 10 });

    const expressionNode: ExpressionNode = {
      type: "expression",
      id: "chain-calc",
      expressions: [
        "step1 = base * 2",
        "step2 = step1 + 5", // Uses step1 from previous expression
      ],
      connections: { default: "next-node" },
    };

    const result = await handler.execute(
      expressionNode,
      context,
      new AgentMessageQueue(),
      mockStorage,
      mockEngine,
    );

    expect(result.data).toEqual({
      step1: 20, // 10 * 2
      step2: 25, // 20 + 5
    });
  });

  test("should handle increment pattern", async () => {
    const context = TestUtils.createTestContext({ iteration: 3 });

    const expressionNode: ExpressionNode = {
      type: "expression",
      id: "increment",
      expressions: ["iteration = iteration + 1"],
      connections: { default: "next-node" },
    };

    const result = await handler.execute(
      expressionNode,
      context,
      new AgentMessageQueue(),
      mockStorage,
      mockEngine,
    );

    expect(result.data).toEqual({ iteration: 4 });
  });

  test("should handle reset pattern", async () => {
    const context = TestUtils.createTestContext({ counter: 10 });

    const expressionNode: ExpressionNode = {
      type: "expression",
      id: "reset",
      expressions: ["counter = 1"],
      connections: { default: "next-node" },
    };

    const result = await handler.execute(
      expressionNode,
      context,
      new AgentMessageQueue(),
      mockStorage,
      mockEngine,
    );

    expect(result.data).toEqual({ counter: 1 });
  });

  test("should handle nested context paths", async () => {
    const context = TestUtils.createTestContext({
      plan: { current_step: 5, total_steps: 10 },
    });

    const expressionNode: ExpressionNode = {
      type: "expression",
      id: "nested-calc",
      expressions: ["next_step = plan.current_step + 1"],
      connections: { default: "next-node" },
    };

    const result = await handler.execute(
      expressionNode,
      context,
      new AgentMessageQueue(),
      mockStorage,
      mockEngine,
    );

    expect(result.data).toEqual({ next_step: 6 });
  });

  test("should throw ValidationError on undefined variable (no error connection)", async () => {
    const context = TestUtils.createTestContext({});

    const expressionNode: ExpressionNode = {
      type: "expression",
      id: "undefined-var",
      expressions: ["result = unknown_var + 1"],
      connections: { default: "next-node" },
    };

    // With "Throw Early" architecture: no error connection = throw to boundary
    await expect(
      handler.execute(expressionNode, context, new AgentMessageQueue(), mockStorage, mockEngine),
    ).rejects.toThrow(/unknown_var/);
  });

  test("should use error connection if available", async () => {
    const context = TestUtils.createTestContext({});

    const expressionNode: ExpressionNode = {
      type: "expression",
      id: "with-error-conn",
      expressions: ["result = missing + 1"],
      connections: {
        default: "next-node",
        error: "error-handler",
      },
    };

    const result = await handler.execute(
      expressionNode,
      context,
      new AgentMessageQueue(),
      mockStorage,
      mockEngine,
    );

    expect(result.action).toBe("continue");
    expect(result.outputPath).toBe("error");
    expect(result.data).toMatchObject({
      expressionError: expect.any(String),
      failedExpression: "result = missing + 1",
      failedIndex: 0,
    });
  });

  test("should throw ValidationError on division by zero (no error connection)", async () => {
    const context = TestUtils.createTestContext({ x: 0 });

    const expressionNode: ExpressionNode = {
      type: "expression",
      id: "div-zero",
      expressions: ["result = 10 / x"],
      connections: { default: "next-node" },
    };

    // With "Throw Early" architecture: no error connection = throw to boundary
    await expect(
      handler.execute(expressionNode, context, new AgentMessageQueue(), mockStorage, mockEngine),
    ).rejects.toThrow(/Division by zero/);
  });

  test("should throw ValidationError on first error in multiple expressions (no error connection)", async () => {
    const context = TestUtils.createTestContext({ a: 5 });

    const expressionNode: ExpressionNode = {
      type: "expression",
      id: "stop-on-error",
      expressions: [
        "first = a * 2",
        "second = unknown + 1", // This will fail
        "third = first + 10", // This should not execute
      ],
      connections: { default: "next-node" },
    };

    // With "Throw Early" architecture: no error connection = throw to boundary
    await expect(
      handler.execute(expressionNode, context, new AgentMessageQueue(), mockStorage, mockEngine),
    ).rejects.toThrow(/index 1/); // Failed at second expression
  });

  test("should handle expression with parentheses", async () => {
    const context = TestUtils.createTestContext({ a: 2, b: 3, c: 4 });

    const expressionNode: ExpressionNode = {
      type: "expression",
      id: "parens",
      expressions: ["result = (a + b) * c"],
      connections: { default: "next-node" },
    };

    const result = await handler.execute(
      expressionNode,
      context,
      new AgentMessageQueue(),
      mockStorage,
      mockEngine,
    );

    expect(result.data).toEqual({ result: 20 }); // (2 + 3) * 4 = 20
  });

  test("should throw when called with non-expression node", async () => {
    const context = TestUtils.createTestContext({});

    const notExpressionNode = {
      type: "start",
      id: "start",
      connections: { default: "next" },
    };

    await expect(
      handler.execute(
        notExpressionNode as any,
        context,
        new AgentMessageQueue(),
        mockStorage,
        mockEngine,
      ),
    ).rejects.toThrow("ExpressionHandler can only execute expression nodes");
  });

  test("canExecute should return true for expression nodes", () => {
    const context = TestUtils.createTestContext({});

    const expressionNode: ExpressionNode = {
      type: "expression",
      id: "test",
      expressions: ["x = 1"],
      connections: { default: "next" },
    };

    expect(handler.canExecute(expressionNode, context)).toBe(true);
  });

  test("canExecute should return false for non-expression nodes", () => {
    const context = TestUtils.createTestContext({});

    const startNode = {
      type: "start",
      id: "start",
      connections: { default: "next" },
    };

    expect(handler.canExecute(startNode as any, context)).toBe(false);
  });
});
