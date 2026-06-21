/**
 * Tests for flexible JSON parser shared utility
 * Tests parseFlexibleJSON, convertSingleQuotesToDoubleQuotes, addQuotesToUnquotedKeys,
 * and wrapSchemaWithAutoparse
 */

import { describe, it, expect } from "@jest/globals";
import {
  parseFlexibleJSON,
  convertSingleQuotesToDoubleQuotes,
  wrapSchemaWithAutoparse,
} from "../../../packages/mcp-server/src/utils/flexible-json-parser.js";
import { z } from "zod";

describe("Input Parser Core Functions", () => {
  describe("convertSingleQuotesToDoubleQuotes", () => {
    it("should convert simple single quotes to double quotes", () => {
      const input = "{'field': 'value'}";
      const result = convertSingleQuotesToDoubleQuotes(input);
      expect(result).toBe('{"field": "value"}');
    });

    it("should handle mixed quotes", () => {
      const input = "{'field1': \"double quoted\", \"field2\": 'single quoted'}";
      const result = convertSingleQuotesToDoubleQuotes(input);
      expect(result).toBe('{"field1": "double quoted", "field2": "single quoted"}');
    });

    it("should handle embedded quotes in strings", () => {
      const input = "{'field': 'value with \"embedded\" quotes'}";
      const result = convertSingleQuotesToDoubleQuotes(input);
      expect(result).toBe('{"field": "value with \\"embedded\\" quotes"}');
    });

    it("should handle escaped quotes", () => {
      const input = "{'field': 'value with \\'escaped\\' quote'}";
      const result = convertSingleQuotesToDoubleQuotes(input);
      expect(result).toBe('{"field": "value with \\"escaped\\" quote"}');
    });

    it("should handle arrays", () => {
      const input = "['item1', 'item2', 'item3']";
      const result = convertSingleQuotesToDoubleQuotes(input);
      expect(result).toBe('["item1", "item2", "item3"]');
    });

    it("should handle nested objects", () => {
      const input = "{'parent': {'child': 'value'}}";
      const result = convertSingleQuotesToDoubleQuotes(input);
      expect(result).toBe('{"parent": {"child": "value"}}');
    });
  });

  describe("parseFlexibleJSON", () => {
    it("should parse standard JSON", () => {
      const result = parseFlexibleJSON('{"field": "value", "number": 42}');
      expect(result).toEqual({ field: "value", number: 42 });
    });

    it("should parse single quote JSON", () => {
      const result = parseFlexibleJSON("{'field': 'value', 'number': 42}");
      expect(result).toEqual({ field: "value", number: 42 });
    });

    it("should handle simple escaped JSON (realistic case)", () => {
      // Test that escaped strings are handled gracefully - return as object with value
      const result = parseFlexibleJSON("\"{'field': 'value'}\"");
      expect(result).toEqual("{'field': 'value'}"); // Returns the unescaped string
    });

    it("should parse single quote arrays", () => {
      const result = parseFlexibleJSON("['item1', 'item2', 42]");
      expect(result).toEqual(["item1", "item2", 42]);
    });

    it("should handle mixed quotes in objects", () => {
      const result = parseFlexibleJSON("{'field1': \"value1\", \"field2\": 'value2'}");
      expect(result).toEqual({ field1: "value1", field2: "value2" });
    });

    it("should handle nested mixed quote objects", () => {
      const result = parseFlexibleJSON("{'parent': {'child': \"nested value\"}}");
      expect(result).toEqual({ parent: { child: "nested value" } });
    });

    it("should handle JavaScript object notation", () => {
      const result = parseFlexibleJSON("{field: 'value', count: 123}");
      expect(result).toEqual({ field: "value", count: 123 });
    });

    it("should throw on truly invalid JSON", () => {
      expect(() => parseFlexibleJSON("not json at all")).toThrow();
    });

    it("should throw on malformed brackets", () => {
      expect(() => parseFlexibleJSON('{"field": "value"')).toThrow();
    });
  });

  describe("Real world scenarios", () => {
    it("should handle Python dict format", () => {
      const result = parseFlexibleJSON("{'feature_name': 'test-feature', 'complexity': 5}");
      expect(result).toEqual({ feature_name: "test-feature", complexity: 5 });
    });

    it("should handle JavaScript console output", () => {
      const result = parseFlexibleJSON("{name: 'John', age: 30, active: true}");
      expect(result).toEqual({ name: "John", age: 30, active: true });
    });

    it("should handle escaped single quote JSON gracefully", () => {
      // Escaped single quote JSON returns unescaped string (handled gracefully)
      const result = parseFlexibleJSON('"' + "{'field': 'value'}" + '"');
      expect(result).toEqual("{'field': 'value'}");
    });
  });
});

describe("wrapSchemaWithAutoparse", () => {
  it("should auto-parse stringified JSON object for z.object() fields", () => {
    const schema = wrapSchemaWithAutoparse({
      data: z.object({ name: z.string(), count: z.number() }),
    });
    const wrapped = z.object(schema);
    const result = wrapped.parse({ data: '{"name": "test", "count": 42}' });
    expect(result.data).toEqual({ name: "test", count: 42 });
  });

  it("should pass through native objects unchanged", () => {
    const schema = wrapSchemaWithAutoparse({
      data: z.object({ name: z.string() }),
    });
    const wrapped = z.object(schema);
    const result = wrapped.parse({ data: { name: "test" } });
    expect(result.data).toEqual({ name: "test" });
  });

  it("should auto-parse stringified JSON array for z.array() fields", () => {
    const schema = wrapSchemaWithAutoparse({
      items: z.array(z.string()),
    });
    const wrapped = z.object(schema);
    const result = wrapped.parse({ items: '["a", "b", "c"]' });
    expect(result.items).toEqual(["a", "b", "c"]);
  });

  it("should handle optional z.object() fields with string input", () => {
    const schema = wrapSchemaWithAutoparse({
      data: z.object({ name: z.string() }).optional(),
    });
    const wrapped = z.object(schema);
    const result = wrapped.parse({ data: '{"name": "test"}' });
    expect(result.data).toEqual({ name: "test" });
  });

  it("should handle optional z.object() fields with undefined", () => {
    const schema = wrapSchemaWithAutoparse({
      data: z.object({ name: z.string() }).optional(),
    });
    const wrapped = z.object(schema);
    const result = wrapped.parse({});
    expect(result.data).toBeUndefined();
  });

  it("should not modify z.string() fields", () => {
    const schema = wrapSchemaWithAutoparse({
      name: z.string(),
    });
    const wrapped = z.object(schema);
    const result = wrapped.parse({ name: '{"not": "parsed"}' });
    expect(result.name).toBe('{"not": "parsed"}');
  });

  it("should not modify z.any() fields", () => {
    const schema = wrapSchemaWithAutoparse({
      value: z.any(),
    });
    const wrapped = z.object(schema);
    const result = wrapped.parse({ value: '{"kept": "as-is"}' });
    expect(result.value).toBe('{"kept": "as-is"}');
  });

  it("should not modify z.union() fields that include z.string()", () => {
    const schema = wrapSchemaWithAutoparse({
      input: z.union([z.string(), z.record(z.any())]),
    });
    const wrapped = z.object(schema);
    const result = wrapped.parse({ input: '{"kept": "as-string"}' });
    expect(result.input).toBe('{"kept": "as-string"}');
  });

  it("should auto-parse single-quote JSON for z.object() fields", () => {
    const schema = wrapSchemaWithAutoparse({
      data: z.object({ name: z.string() }),
    });
    const wrapped = z.object(schema);
    const result = wrapped.parse({ data: "{'name': 'test'}" });
    expect(result.data).toEqual({ name: "test" });
  });

  it("should auto-parse z.record() fields from string", () => {
    const schema = wrapSchemaWithAutoparse({
      metadata: z.record(z.unknown()),
    });
    const wrapped = z.object(schema);
    const result = wrapped.parse({ metadata: '{"key": "value"}' });
    expect(result.metadata).toEqual({ key: "value" });
  });

  it("should let invalid JSON fall through to Zod validation error", () => {
    const schema = wrapSchemaWithAutoparse({
      data: z.object({ name: z.string() }),
    });
    const wrapped = z.object(schema);
    expect(() => wrapped.parse({ data: "not valid json" })).toThrow();
  });

  describe("Claude Code manage tool simulation", () => {
    it("should accept stringified workflow parameter", () => {
      const workflowSchema = z.object({
        metadata: z.object({
          name: z.string(),
          version: z.string(),
          description: z.string(),
        }),
        nodes: z.array(z.record(z.unknown())),
      });

      const schema = wrapSchemaWithAutoparse({
        action: z.enum(["create", "edit"]),
        workflow: workflowSchema.optional(),
      });
      const wrapped = z.object(schema);

      const stringifiedWorkflow = JSON.stringify({
        metadata: { name: "Test", version: "1.0.0", description: "A test" },
        nodes: [{ id: "start", type: "start" }],
      });

      const result = wrapped.parse({ action: "create", workflow: stringifiedWorkflow });
      expect(result.workflow).toEqual({
        metadata: { name: "Test", version: "1.0.0", description: "A test" },
        nodes: [{ id: "start", type: "start" }],
      });
    });

    it("should accept stringified changes parameter", () => {
      const changesSchema = z.object({
        metadata: z.object({ name: z.string().optional() }).optional(),
        addNodes: z.array(z.record(z.unknown())).optional(),
      });

      const schema = wrapSchemaWithAutoparse({
        action: z.enum(["create", "edit"]),
        changes: changesSchema.optional(),
      });
      const wrapped = z.object(schema);

      const stringifiedChanges = JSON.stringify({
        metadata: { name: "Updated" },
        addNodes: [{ id: "new-node", type: "action" }],
      });

      const result = wrapped.parse({ action: "edit", changes: stringifiedChanges });
      expect(result.changes).toEqual({
        metadata: { name: "Updated" },
        addNodes: [{ id: "new-node", type: "action" }],
      });
    });
  });
});
