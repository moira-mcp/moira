/**
 * Validation Error Messages Tests (Step 1 feature #271)
 * Tests improved error message formatting for oneOf schemas
 */

import { describe, test, expect } from "@jest/globals";
import { GraphValidator } from "../../../packages/workflow-engine/src/validation/graph-validator.js";

describe("GraphValidator Error Messages", () => {
  const validator = new GraphValidator();

  describe("oneOf error filtering for agent-directive nodes", () => {
    test("shows only agent-directive errors for agent-directive node", async () => {
      const invalidWorkflow = {
        id: "test-invalid",
        metadata: {
          name: "Test",
          version: "1.0.0",
          description: "Test workflow",
        },
        nodes: [
          { id: "start", type: "start", connections: { default: "step" } },
          {
            id: "step",
            type: "agent-directive",
            // Missing required 'directive' field
            completionCondition: "Done",
            connections: { success: "end" },
          },
          { id: "end", type: "end" },
        ],
      };

      const result = await validator.validateWorkflow(invalidWorkflow);

      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);

      // Should mention agent-directive in error
      const errorMessages = result.errors.map((e) => e.message).join(" ");
      expect(errorMessages).toContain("directive");

      // Should NOT mention other node types like 'decision' or 'condition'
      expect(errorMessages).not.toContain("condition");
      expect(errorMessages).not.toContain("question");
    });

    test("error includes node ID for context", async () => {
      const invalidWorkflow = {
        id: "test-invalid",
        metadata: {
          name: "Test",
          version: "1.0.0",
          description: "Test workflow",
        },
        nodes: [
          { id: "start", type: "start", connections: { default: "my-step-node" } },
          {
            id: "my-step-node",
            type: "agent-directive",
            // Missing directive
            connections: { success: "end" },
          },
          { id: "end", type: "end" },
        ],
      };

      const result = await validator.validateWorkflow(invalidWorkflow);

      expect(result.valid).toBe(false);

      // Check if any error references the node
      const hasNodeContext = result.errors.some(
        (e) =>
          e.message.includes("my-step-node") ||
          e.message.includes("agent-directive") ||
          e.path?.includes("my-step-node"),
      );
      expect(hasNodeContext).toBe(true);
    });
  });

  describe("oneOf error filtering for subgraph nodes", () => {
    test("shows only subgraph errors for subgraph node", async () => {
      const invalidWorkflow = {
        id: "test-invalid",
        metadata: {
          name: "Test",
          version: "1.0.0",
          description: "Test workflow",
        },
        nodes: [
          { id: "start", type: "start", connections: { default: "sub" } },
          {
            id: "sub",
            type: "subgraph",
            // Missing required 'graphId', 'inputMapping', 'outputMapping' fields
            connections: { success: "end" },
          },
          { id: "end", type: "end" },
        ],
      };

      const result = await validator.validateWorkflow(invalidWorkflow);

      expect(result.valid).toBe(false);

      // Should have error about missing required fields for subgraph
      const errorMessages = result.errors.map((e) => e.message).join(" ");

      // Should mention subgraph-related error or required fields
      expect(
        errorMessages.includes("graphId") ||
          errorMessages.includes("subgraph") ||
          errorMessages.includes("required") ||
          errorMessages.includes("Missing"),
      ).toBe(true);

      // Should NOT mention unrelated types like directive
      expect(errorMessages).not.toContain("directive");
    });
  });

  describe("oneOf error filtering for condition nodes", () => {
    test("shows only condition errors for condition node", async () => {
      const invalidWorkflow = {
        id: "test-invalid",
        metadata: {
          name: "Test",
          version: "1.0.0",
          description: "Test workflow",
        },
        nodes: [
          { id: "start", type: "start", connections: { default: "check" } },
          {
            id: "check",
            type: "condition",
            // Missing required 'condition' field
            connections: { true: "end", false: "end" },
          },
          { id: "end", type: "end" },
        ],
      };

      const result = await validator.validateWorkflow(invalidWorkflow);

      expect(result.valid).toBe(false);

      // Should have error about missing condition
      const errorMessages = result.errors.map((e) => e.message).join(" ");
      expect(errorMessages.includes("condition") || errorMessages.includes("required")).toBe(true);
    });
  });

  describe("valid workflows pass validation", () => {
    test("workflow without a top-level id passes (id is server-assigned)", async () => {
      // Definition files omit the top-level id; the server assigns it on save.
      // validateUnified must therefore NOT require it at the schema level.
      const workflowWithoutId = {
        metadata: {
          name: "Test",
          version: "1.0.0",
          description: "Test workflow",
        },
        nodes: [
          { id: "start", type: "start", connections: { default: "step" } },
          {
            id: "step",
            type: "agent-directive",
            directive: "Do something",
            completionCondition: "Done",
            connections: { success: "end" },
          },
          { id: "end", type: "end" },
        ],
      };

      const result = await validator.validateUnified(workflowWithoutId);
      expect(result.valid).toBe(true);
      expect(result.issues.filter((i) => i.severity === "error")).toHaveLength(0);
    });

    test("valid agent-directive node passes", async () => {
      const validWorkflow = {
        id: "test-valid",
        metadata: {
          name: "Test",
          version: "1.0.0",
          description: "Test workflow",
        },
        nodes: [
          { id: "start", type: "start", connections: { default: "step" } },
          {
            id: "step",
            type: "agent-directive",
            directive: "Do something",
            completionCondition: "Done",
            connections: { success: "end" },
          },
          { id: "end", type: "end" },
        ],
      };

      const result = await validator.validateWorkflow(validWorkflow);
      expect(result.valid).toBe(true);
      expect(result.errors.length).toBe(0);
    });

    test("valid subgraph node passes", async () => {
      const validWorkflow = {
        id: "test-valid",
        metadata: {
          name: "Test",
          version: "1.0.0",
          description: "Test workflow",
        },
        nodes: [
          { id: "start", type: "start", connections: { default: "sub" } },
          {
            id: "sub",
            type: "subgraph",
            graphId: "some-workflow-id",
            inputMapping: {},
            outputMapping: {},
            connections: { success: "end" },
          },
          { id: "end", type: "end" },
        ],
      };

      const result = await validator.validateWorkflow(validWorkflow);
      expect(result.valid).toBe(true);
      expect(result.errors.length).toBe(0);
    });

    test("valid condition node passes", async () => {
      const validWorkflow = {
        id: "test-valid",
        metadata: {
          name: "Test",
          version: "1.0.0",
          description: "Test workflow",
        },
        variableRegistry: { x: { type: "number", description: "test var" } },
        nodes: [
          { id: "start", type: "start", connections: { default: "check" } },
          {
            id: "check",
            type: "condition",
            condition: { operator: "eq", left: { contextPath: "x" }, right: 1 },
            connections: { true: "end", false: "end" },
          },
          { id: "end", type: "end" },
        ],
      };

      const result = await validator.validateWorkflow(validWorkflow);
      expect(result.valid).toBe(true);
      expect(result.errors.length).toBe(0);
    });
  });

  describe("error message clarity", () => {
    test("error messages are actionable", async () => {
      const invalidWorkflow = {
        id: "test-invalid",
        metadata: {
          name: "Test",
          version: "1.0.0",
          description: "Test workflow",
        },
        nodes: [
          { id: "start", type: "start", connections: { default: "step" } },
          {
            id: "step",
            type: "agent-directive",
            // directive is missing
            connections: { success: "end" },
          },
          { id: "end", type: "end" },
        ],
      };

      const result = await validator.validateWorkflow(invalidWorkflow);

      expect(result.valid).toBe(false);

      // Errors should give actionable information
      for (const error of result.errors) {
        // Each error should have a clear message
        expect(error.message.length).toBeGreaterThan(10);

        // Should mention what's wrong
        const hasActionableContent =
          error.message.includes("required") ||
          error.message.includes("missing") ||
          error.message.includes("must") ||
          error.message.includes("should") ||
          error.message.includes("field");
        expect(hasActionableContent).toBe(true);
      }
    });
  });

  describe("declared-variable validation (Step 6)", () => {
    test("condition referencing an undeclared variable is a blocking error", async () => {
      const workflow = {
        metadata: { name: "Test", version: "1.0.0", description: "Test" },
        // No registry, no declared 'missing_var' anywhere.
        nodes: [
          { id: "start", type: "start", connections: { default: "check" } },
          {
            id: "check",
            type: "condition",
            condition: { operator: "eq", left: { contextPath: "missing_var" }, right: 1 },
            connections: { true: "end", false: "end" },
          },
          { id: "end", type: "end" },
        ],
      };

      const result = await validator.validateUnified(workflow);
      const errors = result.issues.filter((i) => i.severity === "error");
      expect(result.valid).toBe(false);
      expect(
        errors.some(
          (e) =>
            e.message.includes("condition references undeclared variable") &&
            e.message.includes("missing_var"),
        ),
      ).toBe(true);
    });

    test("condition referencing a node-id.name local passes", async () => {
      const workflow = {
        metadata: { name: "Test", version: "1.0.0", description: "Test" },
        nodes: [
          { id: "start", type: "start", connections: { default: "produce" } },
          {
            id: "produce",
            type: "agent-directive",
            directive: "Produce a value",
            completionCondition: "Done",
            connections: { success: "check" },
          },
          {
            id: "check",
            // Root segment 'produce' is a node id → valid node-local reference.
            type: "condition",
            condition: { operator: "eq", left: { contextPath: "produce.value" }, right: 1 },
            connections: { true: "end", false: "end" },
          },
          { id: "end", type: "end" },
        ],
      };

      const result = await validator.validateUnified(workflow);
      expect(result.issues.filter((i) => i.severity === "error")).toHaveLength(0);
    });

    test("template referencing a declared registry global passes", async () => {
      const workflow = {
        metadata: { name: "Test", version: "1.0.0", description: "Test" },
        variableRegistry: { greeting: { type: "string", description: "A greeting" } },
        nodes: [
          { id: "start", type: "start", connections: { default: "step" } },
          {
            id: "step",
            type: "agent-directive",
            directive: "Say {{greeting}} to the user.",
            completionCondition: "Done",
            connections: { success: "end" },
          },
          { id: "end", type: "end" },
        ],
      };

      const result = await validator.validateUnified(workflow);
      expect(result.issues.filter((i) => i.severity === "error")).toHaveLength(0);
    });

    test("template referencing a node-id.name local passes", async () => {
      const workflow = {
        metadata: { name: "Test", version: "1.0.0", description: "Test" },
        nodes: [
          { id: "start", type: "start", connections: { default: "produce" } },
          {
            id: "produce",
            type: "agent-directive",
            directive: "Produce a value",
            completionCondition: "Done",
            connections: { success: "consume" },
          },
          {
            id: "consume",
            type: "agent-directive",
            // Root segment 'produce' is a node id → valid node-local reference.
            directive: "The produced value is {{produce.value}}.",
            completionCondition: "Done",
            connections: { success: "end" },
          },
          { id: "end", type: "end" },
        ],
      };

      const result = await validator.validateUnified(workflow);
      expect(result.issues.filter((i) => i.severity === "error")).toHaveLength(0);
    });

    test("undeclared {{...}} inside a registry default value is a blocking error", async () => {
      // Registry default values are processed recursively at runtime, so embedded
      // references must resolve under the same rules (Step 7).
      const workflow = {
        metadata: { name: "Test", version: "1.0.0", description: "Test" },
        variableRegistry: {
          // 'missing_global' is referenced but not declared anywhere.
          prompt: {
            type: "string",
            description: "A prompt",
            default: "Use {{missing_global}} here",
          },
        },
        nodes: [
          { id: "start", type: "start", connections: { default: "step" } },
          {
            id: "step",
            type: "agent-directive",
            directive: "{{prompt}}",
            completionCondition: "Done",
            connections: { success: "end" },
          },
          { id: "end", type: "end" },
        ],
      };

      const result = await validator.validateUnified(workflow);
      const errors = result.issues.filter((i) => i.severity === "error");
      expect(
        errors.some(
          (e) => e.message.includes("missing_global") && e.message.includes("undeclared variable"),
        ),
      ).toBe(true);
    });

    test("JSON braces in a registry default value do not false-positive", async () => {
      // A default value containing a JSON example ({"type":"string"}) must not be flagged
      // as an unbalanced template bracket.
      const workflow = {
        metadata: { name: "Test", version: "1.0.0", description: "Test" },
        variableRegistry: {
          schema_doc: {
            type: "string",
            description: "Doc",
            default: 'inputSchema example: {"type":"array","items":{"type":"string"}}',
          },
        },
        nodes: [
          { id: "start", type: "start", connections: { default: "step" } },
          {
            id: "step",
            type: "agent-directive",
            directive: "{{schema_doc}}",
            completionCondition: "Done",
            connections: { success: "end" },
          },
          { id: "end", type: "end" },
        ],
      };

      const result = await validator.validateUnified(workflow);
      expect(result.issues.filter((i) => i.severity === "error")).toHaveLength(0);
    });
  });

  describe("block-helper variable validation", () => {
    // Helper: build a single-directive workflow with the given directive text and registry.
    const buildWorkflow = (directive: string, registry?: Record<string, unknown>) => ({
      metadata: { name: "Test", version: "1.0.0", description: "Test" },
      ...(registry ? { variableRegistry: registry } : {}),
      nodes: [
        { id: "start", type: "start", connections: { default: "step" } },
        {
          id: "step",
          type: "agent-directive",
          directive,
          completionCondition: "Done",
          connections: { success: "end" },
        },
        { id: "end", type: "end" },
      ],
    });

    const hasUndeclaredError = (
      result: { issues: { severity: string; message: string }[] },
      varName: string,
    ): boolean =>
      result.issues.some(
        (i) =>
          i.severity === "error" &&
          i.message.includes("undeclared variable") &&
          i.message.includes(varName),
      );

    test("undeclared variable inside {{#if}} is a blocking error", async () => {
      const result = await validator.validateUnified(
        buildWorkflow("{{#if offline_mode}}offline{{/if}}"),
      );
      expect(result.valid).toBe(false);
      expect(hasUndeclaredError(result, "offline_mode")).toBe(true);
    });

    test("undeclared variable inside {{#unless}} is a blocking error", async () => {
      const result = await validator.validateUnified(
        buildWorkflow("{{#unless offline_mode}}online{{/unless}}"),
      );
      expect(hasUndeclaredError(result, "offline_mode")).toBe(true);
    });

    test("undeclared variable inside {{#each}} is a blocking error", async () => {
      const result = await validator.validateUnified(
        buildWorkflow("{{#each missing_items}}{{this}}{{/each}}"),
      );
      expect(hasUndeclaredError(result, "missing_items")).toBe(true);
    });

    test("undeclared variable inside {{#eq}} is a blocking error", async () => {
      const result = await validator.validateUnified(
        buildWorkflow("{{#eq mode 'fast'}}fast{{/eq}}"),
      );
      expect(hasUndeclaredError(result, "mode")).toBe(true);
    });

    test("declared registry variable inside {{#if}} passes", async () => {
      const result = await validator.validateUnified(
        buildWorkflow("{{#if offline_mode}}offline{{/if}}", {
          offline_mode: { type: "boolean", description: "Offline flag", default: false },
        }),
      );
      expect(result.issues.filter((i) => i.severity === "error")).toHaveLength(0);
    });

    test("node-id.name local inside {{#if}} passes", async () => {
      const workflow = {
        metadata: { name: "Test", version: "1.0.0", description: "Test" },
        nodes: [
          { id: "start", type: "start", connections: { default: "produce" } },
          {
            id: "produce",
            type: "agent-directive",
            directive: "Produce a flag",
            completionCondition: "Done",
            connections: { success: "consume" },
          },
          {
            id: "consume",
            type: "agent-directive",
            // Root segment 'produce' is a node id → valid node-local reference.
            directive: "{{#if produce.flag}}set{{/if}}",
            completionCondition: "Done",
            connections: { success: "end" },
          },
          { id: "end", type: "end" },
        ],
      };
      const result = await validator.validateUnified(workflow);
      expect(result.issues.filter((i) => i.severity === "error")).toHaveLength(0);
    });

    test("{{else}} and {{this}} inside helper blocks do not false-positive", async () => {
      const result = await validator.validateUnified(
        buildWorkflow("{{#if shown}}{{#each shown}}{{this}}{{else}}none{{/each}}{{/if}}", {
          shown: { type: "array", description: "Items", default: [] },
        }),
      );
      expect(result.issues.filter((i) => i.severity === "error")).toHaveLength(0);
    });

    test("nested block helpers each validate their variable argument", async () => {
      // Outer var declared, inner var undeclared → only the inner one is reported.
      const result = await validator.validateUnified(
        buildWorkflow("{{#if outer}}{{#unless inner_missing}}x{{/unless}}{{/if}}", {
          outer: { type: "boolean", description: "Outer flag", default: true },
        }),
      );
      expect(hasUndeclaredError(result, "inner_missing")).toBe(true);
      expect(hasUndeclaredError(result, "outer")).toBe(false);
    });
  });
});
