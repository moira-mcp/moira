/**
 * SchemaValidator Agent Error Formatting Tests (Step 12)
 * Tests comprehensive validation error formatting for AI agents
 */

import { describe, test, expect } from "@jest/globals";
import { SchemaValidator } from "../../../packages/workflow-engine/src/utils/schema-validator.js";

describe("SchemaValidator.formatValidationErrorForAgent", () => {
  describe("basic formatting", () => {
    test("includes all required sections", () => {
      const schema = {
        type: "object",
        properties: {
          name: { type: "string", description: "User name" },
          age: { type: "number" },
        },
        required: ["name"],
      };
      const userInput = { age: "not a number" };
      const errors = ["Required field 'name' is missing"];

      const result = SchemaValidator.formatValidationErrorForAgent(schema, userInput, errors);

      // Check all sections are present
      expect(result).toContain("❌ VALIDATION ERROR");
      expect(result).toContain("EXPECTED INPUT FORMAT:");
      expect(result).toContain("YOUR INPUT:");
      expect(result).toContain("ERRORS:");
      expect(result).toContain("ACTION REQUIRED:");
    });

    test("shows expected schema format", () => {
      const schema = {
        type: "object",
        properties: {
          name: { type: "string", description: "User name" },
          count: { type: "number" },
        },
        required: ["name"],
      };
      const userInput = {};
      const errors = ["Required field 'name' is missing"];

      const result = SchemaValidator.formatValidationErrorForAgent(schema, userInput, errors);

      // Should show schema in agent-friendly format
      expect(result).toContain('"name"');
      expect(result).toContain("string");
      expect(result).toContain("required");
      expect(result).toContain("User name");
      expect(result).toContain('"count"');
      expect(result).toContain("number");
      expect(result).toContain("optional");
    });

    test("shows user input as JSON", () => {
      const schema = {
        type: "object",
        properties: {
          value: { type: "number" },
        },
        required: ["value"],
      };
      const userInput = { value: "wrong", extra: true };
      const errors = ["Field 'value' must be number"];

      const result = SchemaValidator.formatValidationErrorForAgent(schema, userInput, errors);

      expect(result).toContain('"value"');
      expect(result).toContain('"wrong"');
      expect(result).toContain('"extra"');
      expect(result).toContain("true");
    });

    test("shows all validation errors", () => {
      const schema = {
        type: "object",
        properties: {
          a: { type: "string" },
          b: { type: "number" },
        },
        required: ["a", "b"],
      };
      const userInput = {};
      const errors = ["Required field 'a' is missing", "Required field 'b' is missing"];

      const result = SchemaValidator.formatValidationErrorForAgent(schema, userInput, errors);

      expect(result).toContain("• Required field 'a' is missing");
      expect(result).toContain("• Required field 'b' is missing");
    });

    test("includes action required message", () => {
      const schema = { type: "object", properties: {} };
      const userInput = { garbage: true };
      const errors = ["Unknown field"];

      const result = SchemaValidator.formatValidationErrorForAgent(schema, userInput, errors);

      expect(result).toContain("Send a new input object with the correct structure");
      expect(result).toContain("Do not proceed until validation passes");
    });
  });

  describe("edge cases", () => {
    test("handles undefined schema (no inputSchema)", () => {
      const userInput = { data: "some value" };
      const errors = ["Input must be empty"];

      const result = SchemaValidator.formatValidationErrorForAgent(undefined, userInput, errors);

      expect(result).toContain("❌ VALIDATION ERROR");
      expect(result).toContain("no inputSchema defined");
      expect(result).toContain("empty input only");
    });

    test("handles null user input", () => {
      const schema = {
        type: "object",
        properties: { value: { type: "string" } },
        required: ["value"],
      };
      const errors = ["Required field 'value' is missing"];

      const result = SchemaValidator.formatValidationErrorForAgent(schema, null, errors);

      expect(result).toContain("YOUR INPUT:");
      expect(result).toContain("null");
    });

    test("handles empty errors array", () => {
      const schema = { type: "object", properties: {} };
      const userInput = {};
      const errors: string[] = [];

      const result = SchemaValidator.formatValidationErrorForAgent(schema, userInput, errors);

      // Should still have all sections even with no errors
      expect(result).toContain("ERRORS:");
    });

    test("truncates very long user input", () => {
      const schema = { type: "object", properties: {} };
      const userInput = { data: "x".repeat(1000) };
      const errors = ["Unknown field"];

      const result = SchemaValidator.formatValidationErrorForAgent(schema, userInput, errors);

      expect(result).toContain("...[truncated]");
      expect(result.length).toBeLessThan(2000);
    });

    test("removes VALIDATION ERROR prefix from individual errors", () => {
      const schema = { type: "object", properties: { x: { type: "number" } } };
      const userInput = { x: "string" };
      const errors = ["VALIDATION ERROR: Field 'x' must be number, got string"];

      const result = SchemaValidator.formatValidationErrorForAgent(schema, userInput, errors);

      // Should have header but not duplicate in errors list
      expect(result).toContain("❌ VALIDATION ERROR");
      expect(result).toContain("• Field 'x' must be number, got string");
      // Should NOT have double "VALIDATION ERROR"
      expect(result).not.toContain("• VALIDATION ERROR:");
    });
  });

  describe("enum values in schema", () => {
    test("shows enum values in expected format", () => {
      const schema = {
        type: "object",
        properties: {
          status: {
            type: "string",
            enum: ["active", "inactive", "pending"],
            description: "Current status",
          },
        },
        required: ["status"],
      };
      const userInput = { status: "invalid" };
      const errors = ["Field 'status' must be one of: active, inactive, pending"];

      const result = SchemaValidator.formatValidationErrorForAgent(schema, userInput, errors);

      expect(result).toContain("active");
      expect(result).toContain("inactive");
      expect(result).toContain("pending");
      expect(result).toContain("values:");
    });
  });
});

describe("SchemaValidator.formatSchemaForAgent", () => {
  test("formats simple object schema", () => {
    const schema = {
      type: "object",
      properties: {
        name: { type: "string" },
        age: { type: "number" },
      },
      required: ["name"],
    };

    const result = SchemaValidator.formatSchemaForAgent(schema);

    expect(result).toContain("{");
    expect(result).toContain("}");
    expect(result).toContain('"name"');
    expect(result).toContain("string (required)");
    expect(result).toContain('"age"');
    expect(result).toContain("number (optional)");
  });

  test("includes descriptions when present", () => {
    const schema = {
      type: "object",
      properties: {
        email: { type: "string", description: "User email address" },
      },
    };

    const result = SchemaValidator.formatSchemaForAgent(schema);

    expect(result).toContain("User email address");
  });

  test("includes enum values", () => {
    const schema = {
      type: "object",
      properties: {
        priority: { type: "string", enum: ["low", "medium", "high"] },
      },
    };

    const result = SchemaValidator.formatSchemaForAgent(schema);

    expect(result).toContain("low");
    expect(result).toContain("medium");
    expect(result).toContain("high");
  });

  test("handles empty schema", () => {
    const schema = {
      type: "object",
      properties: {},
    };

    const result = SchemaValidator.formatSchemaForAgent(schema);

    expect(result).toBe("null or {}");
  });

  test("handles schema without properties", () => {
    const schema = {
      type: "object",
    };

    const result = SchemaValidator.formatSchemaForAgent(schema);

    expect(result).toBe("null or {}");
  });

  test("surfaces array items, pattern and length constraints to the agent", () => {
    const schema = {
      type: "object",
      properties: {
        tags: { type: "array", items: { type: "string" }, minItems: 1 },
        path: { type: "string", pattern: "^/.+", minLength: 2 },
      },
      required: ["tags", "path"],
    };

    const result = SchemaValidator.formatSchemaForAgent(schema);

    expect(result).toContain("items: string");
    expect(result).toContain("minItems: 1");
    expect(result).toContain("pattern: ^/.+");
    expect(result).toContain("minLength: 2");
  });

  test("surfaces nested object fields and numeric bounds to the agent", () => {
    const schema = {
      type: "object",
      properties: {
        metric: {
          type: "object",
          properties: { name: { type: "string" }, target: { type: "number" } },
        },
        score: { type: "number", minimum: 0, maximum: 100 },
      },
    };

    const result = SchemaValidator.formatSchemaForAgent(schema);

    expect(result).toContain("fields: {name, target}");
    expect(result).toContain("min: 0");
    expect(result).toContain("max: 100");
  });
});
