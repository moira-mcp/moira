/**
 * Node Type Validation Tests (#430 - Step 4)
 *
 * Tests that GraphValidator.validateUnified() catches node-type-specific
 * semantic issues: condition operator validation, inputSchema validation,
 * expression syntax validation.
 */

import { describe, test, expect } from "@jest/globals";
import { GraphValidator } from "../../../packages/workflow-engine/src/validation/graph-validator.js";

// Base valid workflow to extend with specific test nodes
function makeWorkflow(nodes: object[]) {
  return {
    id: "test",
    metadata: { name: "Test", version: "1.0.0", description: "Test" },
    // Declare the variables these structural tests reference via contextPath, so the
    // declared-variable validation (a name must be in the registry or a node-id.name)
    // does not flag them — these tests exercise operator structure, not declarations.
    variableRegistry: {
      count: { type: "number", description: "test var" },
      error: { type: "string", description: "test var" },
      user: { type: "object", description: "test var" },
    },
    nodes,
  };
}

// Minimal valid workflow skeleton
function validSkeleton(extraNodes: object[] = []) {
  return makeWorkflow([
    {
      id: "start",
      type: "start",
      connections: {
        default: extraNodes.length > 0 ? extraNodes[0]!["id" as keyof object] : "end",
      },
    },
    ...extraNodes,
    { id: "end", type: "end" },
  ]);
}

describe("Node Type Validation", () => {
  const validator = new GraphValidator();

  describe("ConditionNode operator validation", () => {
    test("valid condition with eq operator passes", async () => {
      const wf = validSkeleton([
        {
          id: "cond",
          type: "condition",
          condition: { operator: "eq", left: "a", right: "b" },
          connections: { true: "end", false: "end" },
        },
      ]);

      const result = await validator.validateUnified(wf);
      expect(result.valid).toBe(true);
      const nodeErrors = result.issues.filter((i) => i.type === "node" && i.severity === "error");
      expect(nodeErrors).toHaveLength(0);
    });

    test("invalid operator 'equals' is rejected", async () => {
      const wf = validSkeleton([
        {
          id: "cond",
          type: "condition",
          condition: { operator: "equals", left: "a", right: "b" },
          connections: { true: "end", false: "end" },
        },
      ]);

      const result = await validator.validateUnified(wf);
      const opError = result.issues.find(
        (i) => i.nodeId === "cond" && i.message.includes("invalid condition operator"),
      );
      expect(opError).toBeDefined();
      expect(opError!.message).toContain("equals");
    });

    test("binary operator without left operand is rejected", async () => {
      const wf = validSkeleton([
        {
          id: "cond",
          type: "condition",
          condition: { operator: "gt", right: 5 },
          connections: { true: "end", false: "end" },
        },
      ]);

      const result = await validator.validateUnified(wf);
      const leftError = result.issues.find(
        (i) => i.nodeId === "cond" && i.message.includes("left"),
      );
      expect(leftError).toBeDefined();
    });

    test("binary operator without right operand is rejected", async () => {
      const wf = validSkeleton([
        {
          id: "cond",
          type: "condition",
          condition: { operator: "lt", left: { contextPath: "count" } },
          connections: { true: "end", false: "end" },
        },
      ]);

      const result = await validator.validateUnified(wf);
      const rightError = result.issues.find(
        (i) => i.nodeId === "cond" && i.message.includes("right"),
      );
      expect(rightError).toBeDefined();
    });

    test("exists operator without value is rejected", async () => {
      const wf = validSkeleton([
        {
          id: "cond",
          type: "condition",
          condition: { operator: "exists" },
          connections: { true: "end", false: "end" },
        },
      ]);

      const result = await validator.validateUnified(wf);
      const valError = result.issues.find(
        (i) => i.nodeId === "cond" && i.message.includes("value"),
      );
      expect(valError).toBeDefined();
    });

    test("and operator without conditions array is rejected", async () => {
      const wf = validSkeleton([
        {
          id: "cond",
          type: "condition",
          condition: { operator: "and" },
          connections: { true: "end", false: "end" },
        },
      ]);

      const result = await validator.validateUnified(wf);
      const condError = result.issues.find(
        (i) => i.nodeId === "cond" && i.message.includes("conditions"),
      );
      expect(condError).toBeDefined();
    });

    test("or operator with empty conditions array is rejected", async () => {
      const wf = validSkeleton([
        {
          id: "cond",
          type: "condition",
          condition: { operator: "or", conditions: [] },
          connections: { true: "end", false: "end" },
        },
      ]);

      const result = await validator.validateUnified(wf);
      const condError = result.issues.find(
        (i) => i.nodeId === "cond" && i.message.includes("non-empty"),
      );
      expect(condError).toBeDefined();
    });

    test("not operator without condition is rejected", async () => {
      const wf = validSkeleton([
        {
          id: "cond",
          type: "condition",
          condition: { operator: "not" },
          connections: { true: "end", false: "end" },
        },
      ]);

      const result = await validator.validateUnified(wf);
      const notError = result.issues.find((i) => i.nodeId === "cond" && i.message.includes("not"));
      expect(notError).toBeDefined();
    });

    test("nested conditions are validated recursively", async () => {
      const wf = validSkeleton([
        {
          id: "cond",
          type: "condition",
          condition: {
            operator: "and",
            conditions: [{ operator: "eq", left: "a", right: "b" }, { operator: "invalid_op" }],
          },
          connections: { true: "end", false: "end" },
        },
      ]);

      const result = await validator.validateUnified(wf);
      const nestedError = result.issues.find(
        (i) => i.nodeId === "cond" && i.message.includes("invalid condition operator"),
      );
      expect(nestedError).toBeDefined();
      expect(nestedError!.field).toContain("conditions[1]");
    });

    test("valid complex nested condition passes", async () => {
      const wf = validSkeleton([
        {
          id: "cond",
          type: "condition",
          condition: {
            operator: "and",
            conditions: [
              { operator: "gt", left: { contextPath: "count" }, right: 0 },
              {
                operator: "not",
                condition: { operator: "exists", value: { contextPath: "error" } },
              },
            ],
          },
          connections: { true: "end", false: "end" },
        },
      ]);

      const result = await validator.validateUnified(wf);
      const nodeErrors = result.issues.filter((i) => i.type === "node" && i.severity === "error");
      expect(nodeErrors).toHaveLength(0);
    });

    test("all valid operators are accepted", async () => {
      const operators = ["eq", "neq", "gt", "gte", "lt", "lte", "contains"];
      for (const op of operators) {
        const wf = validSkeleton([
          {
            id: "cond",
            type: "condition",
            condition: { operator: op, left: "a", right: "b" },
            connections: { true: "end", false: "end" },
          },
        ]);

        const result = await validator.validateUnified(wf);
        const opErrors = result.issues.filter(
          (i) => i.nodeId === "cond" && i.type === "node" && i.severity === "error",
        );
        expect(opErrors).toHaveLength(0);
      }
    });
  });

  describe("AgentDirectiveNode inputSchema validation", () => {
    test("valid inputSchema passes", async () => {
      const wf = validSkeleton([
        {
          id: "step",
          type: "agent-directive",
          directive: "Do something",
          completionCondition: "Done",
          inputSchema: {
            type: "object",
            properties: { answer: { type: "string" } },
            required: ["answer"],
          },
          connections: { success: "end" },
        },
      ]);

      const result = await validator.validateUnified(wf);
      const schemaErrors = result.issues.filter(
        (i) => i.nodeId === "step" && i.field === "inputSchema",
      );
      expect(schemaErrors).toHaveLength(0);
    });

    test("invalid inputSchema is rejected", async () => {
      const wf = validSkeleton([
        {
          id: "step",
          type: "agent-directive",
          directive: "Do something",
          completionCondition: "Done",
          inputSchema: {
            type: "invalid-type-that-ajv-rejects",
          },
          connections: { success: "end" },
        },
      ]);

      const result = await validator.validateUnified(wf);
      const schemaError = result.issues.find(
        (i) => i.nodeId === "step" && i.field === "inputSchema",
      );
      expect(schemaError).toBeDefined();
      expect(schemaError!.message).toContain("invalid JSON Schema");
    });

    test("node without inputSchema passes", async () => {
      const wf = validSkeleton([
        {
          id: "step",
          type: "agent-directive",
          directive: "Do something",
          completionCondition: "Done",
          connections: { success: "end" },
        },
      ]);

      const result = await validator.validateUnified(wf);
      expect(result.valid).toBe(true);
    });
  });

  describe("ExpressionNode syntax validation", () => {
    test("valid expressions pass", async () => {
      const wf = validSkeleton([
        {
          id: "expr",
          type: "expression",
          expressions: ["counter = counter + 1", "total = a * b + c"],
          connections: { default: "end" },
        },
      ]);

      const result = await validator.validateUnified(wf);
      const exprErrors = result.issues.filter(
        (i) => i.nodeId === "expr" && i.type === "node" && i.severity === "error",
      );
      expect(exprErrors).toHaveLength(0);
    });

    test("unbalanced parentheses are rejected", async () => {
      const wf = validSkeleton([
        {
          id: "expr",
          type: "expression",
          expressions: ["result = (a + b * (c - d)"],
          connections: { default: "end" },
        },
      ]);

      const result = await validator.validateUnified(wf);
      const parenError = result.issues.find(
        (i) => i.nodeId === "expr" && i.message.includes("unbalanced parentheses"),
      );
      expect(parenError).toBeDefined();
    });

    test("balanced parentheses pass", async () => {
      const wf = validSkeleton([
        {
          id: "expr",
          type: "expression",
          expressions: ["result = (a + b) * (c - d)"],
          connections: { default: "end" },
        },
      ]);

      const result = await validator.validateUnified(wf);
      const parenErrors = result.issues.filter(
        (i) => i.nodeId === "expr" && i.message.includes("parentheses"),
      );
      expect(parenErrors).toHaveLength(0);
    });

    test("multiple expressions validated individually", async () => {
      const wf = validSkeleton([
        {
          id: "expr",
          type: "expression",
          expressions: ["a = 1", "b = (c + d"],
          connections: { default: "end" },
        },
      ]);

      const result = await validator.validateUnified(wf);
      const parenError = result.issues.find(
        (i) => i.nodeId === "expr" && i.field === "expressions[1]",
      );
      expect(parenError).toBeDefined();
    });
  });

  describe("Cross-node-type validation", () => {
    test("workflow with multiple valid node types passes", async () => {
      const wf = makeWorkflow([
        { id: "start", type: "start", connections: { default: "cond" } },
        {
          id: "cond",
          type: "condition",
          condition: { operator: "exists", value: { contextPath: "user" } },
          connections: { true: "step", false: "end" },
        },
        {
          id: "step",
          type: "agent-directive",
          directive: "Process",
          completionCondition: "Done",
          connections: { success: "expr" },
        },
        {
          id: "expr",
          type: "expression",
          expressions: ["counter = counter + 1"],
          connections: { default: "end" },
        },
        { id: "end", type: "end" },
      ]);

      const result = await validator.validateUnified(wf);
      expect(result.valid).toBe(true);
      const nodeErrors = result.issues.filter((i) => i.type === "node" && i.severity === "error");
      expect(nodeErrors).toHaveLength(0);
    });

    test("workflow with multiple invalid nodes reports all issues", async () => {
      const wf = makeWorkflow([
        { id: "start", type: "start", connections: { default: "cond" } },
        {
          id: "cond",
          type: "condition",
          condition: { operator: "invalid" },
          connections: { true: "expr", false: "end" },
        },
        {
          id: "expr",
          type: "expression",
          expressions: ["a = (b + c"],
          connections: { default: "end" },
        },
        { id: "end", type: "end" },
      ]);

      const result = await validator.validateUnified(wf);
      const nodeIssues = result.issues.filter((i) => i.type === "node");
      // At least one issue from condition (invalid operator) and one from expression (unbalanced parens)
      expect(nodeIssues.length).toBeGreaterThanOrEqual(2);
      expect(nodeIssues.some((i) => i.nodeId === "cond")).toBe(true);
      expect(nodeIssues.some((i) => i.nodeId === "expr")).toBe(true);
    });

    test("workflow with multiple start nodes is rejected", async () => {
      const wf = makeWorkflow([
        { id: "start1", type: "start", connections: { default: "end" } },
        { id: "start2", type: "start", connections: { default: "end" } },
        { id: "end", type: "end" },
      ]);

      const result = await validator.validateUnified(wf);
      const startError = result.issues.find(
        (i) => i.type === "structure" && i.message.includes("exactly one start node"),
      );
      expect(startError).toBeDefined();
      expect(startError!.severity).toBe("error");
      expect(startError!.message).toContain("start1");
      expect(startError!.message).toContain("start2");
    });

    test("condition node with extra connection keys is rejected by schema", async () => {
      const wf = makeWorkflow([
        { id: "start", type: "start", connections: { default: "cond" } },
        {
          id: "cond",
          type: "condition",
          condition: { operator: "eq", left: "a", right: "b" },
          connections: { true: "end", false: "end", other: "end" },
        },
        { id: "end", type: "end" },
      ]);

      const result = await validator.validateUnified(wf);
      expect(result.valid).toBe(false);
      // AJV should reject the extra "other" connection key
      const schemaError = result.issues.find((i) => i.type === "schema" && i.nodeId === "cond");
      expect(schemaError).toBeDefined();
    });

    test("subgraph self-reference is an error, not warning", async () => {
      const wf = makeWorkflow([
        { id: "start", type: "start", connections: { default: "sub" } },
        {
          id: "sub",
          type: "subgraph",
          graphId: "test",
          inputMapping: {},
          outputMapping: {},
          connections: { success: "end" },
        },
        { id: "end", type: "end" },
      ]);

      const result = await validator.validateUnified(wf);
      const selfRef = result.issues.find(
        (i) => i.nodeId === "sub" && i.message.includes("references itself"),
      );
      expect(selfRef).toBeDefined();
      expect(selfRef!.severity).toBe("error");
    });
  });
});
