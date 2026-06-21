/**
 * Tests for SchemaValidator.enforceStrictSchema() and strict validation behavior
 *
 * Verifies that:
 * 1. Extra fields are rejected when additionalProperties is injected
 * 2. Valid fields still pass validation
 * 3. Nodes without inputSchema still work (EMPTY_INPUT_SCHEMA)
 * 4. Nested object schemas get strict validation
 * 5. Array item schemas get strict validation
 * 6. Existing additionalProperties settings are respected
 */

import { SchemaValidator } from "../../../packages/workflow-engine/src/utils/schema-validator.js";

describe("SchemaValidator.enforceStrictSchema", () => {
  describe("top-level object schemas", () => {
    it("should inject additionalProperties: false into object schema with properties", () => {
      const schema = {
        type: "object",
        properties: {
          name: { type: "string" },
          age: { type: "number" },
        },
        required: ["name"],
      };

      const strict = SchemaValidator.enforceStrictSchema(schema);

      expect(strict.additionalProperties).toBe(false);
      expect(strict.properties).toBeDefined();
      expect(strict.required).toEqual(["name"]);
    });

    it("should inject for type array including object", () => {
      const schema = {
        type: ["object", "null"],
        properties: {
          value: { type: "string" },
        },
      };

      const strict = SchemaValidator.enforceStrictSchema(schema);
      expect(strict.additionalProperties).toBe(false);
    });

    it("should NOT inject when additionalProperties already set to false", () => {
      const schema = {
        type: "object",
        properties: { x: { type: "string" } },
        additionalProperties: false,
      };

      const strict = SchemaValidator.enforceStrictSchema(schema);
      expect(strict.additionalProperties).toBe(false);
    });

    it("should respect existing additionalProperties: true", () => {
      const schema = {
        type: "object",
        properties: { x: { type: "string" } },
        additionalProperties: true,
      };

      const strict = SchemaValidator.enforceStrictSchema(schema);
      expect(strict.additionalProperties).toBe(true);
    });

    it("should NOT inject for object without properties", () => {
      const schema = { type: "object" };

      const strict = SchemaValidator.enforceStrictSchema(schema);
      expect(strict.additionalProperties).toBeUndefined();
    });

    it("should NOT inject for non-object types", () => {
      const schema = { type: "string" };

      const strict = SchemaValidator.enforceStrictSchema(schema);
      expect(strict.additionalProperties).toBeUndefined();
    });
  });

  describe("nested object schemas", () => {
    it("should inject into nested property schemas", () => {
      const schema = {
        type: "object",
        properties: {
          user: {
            type: "object",
            properties: {
              name: { type: "string" },
            },
          },
        },
      };

      const strict = SchemaValidator.enforceStrictSchema(schema);
      expect(strict.additionalProperties).toBe(false);

      const userProp = (strict.properties as Record<string, Record<string, unknown>>).user;
      expect(userProp.additionalProperties).toBe(false);
    });
  });

  describe("array item schemas", () => {
    it("should inject into array items with object type", () => {
      const schema = {
        type: "object",
        properties: {
          items: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string" },
              },
            },
          },
        },
      };

      const strict = SchemaValidator.enforceStrictSchema(schema);
      const itemsProp = (strict.properties as Record<string, Record<string, unknown>>).items;
      const arrayItems = itemsProp.items as Record<string, unknown>;
      expect(arrayItems.additionalProperties).toBe(false);
    });
  });
});

describe("Strict validation integration", () => {
  it("should reject extra fields when enforceStrictSchema is applied", () => {
    const schema = SchemaValidator.enforceStrictSchema({
      type: "object",
      properties: {
        name: { type: "string" },
      },
      required: ["name"],
    });

    const result = SchemaValidator.validate({ name: "test", extraField: "bad" }, schema);

    expect(result.isValid).toBe(false);
    expect(result.errors).toBeDefined();
    expect(result.errors!.some((e) => e.includes("extraField"))).toBe(true);
  });

  it("should accept valid data with only declared fields", () => {
    const schema = SchemaValidator.enforceStrictSchema({
      type: "object",
      properties: {
        name: { type: "string" },
        count: { type: "number" },
      },
      required: ["name"],
    });

    const result = SchemaValidator.validate({ name: "test", count: 5 }, schema);
    expect(result.isValid).toBe(true);
  });

  it("should accept empty object for schema with no required fields", () => {
    const schema = SchemaValidator.enforceStrictSchema({
      type: "object",
      properties: {
        optional: { type: "string" },
      },
    });

    const result = SchemaValidator.validate({}, schema);
    expect(result.isValid).toBe(true);
  });

  it("should accept null for nullable object schema", () => {
    const schema = SchemaValidator.enforceStrictSchema({
      type: ["object", "null"],
      properties: {
        name: { type: "string" },
      },
    });

    const result = SchemaValidator.validate(null, schema);
    expect(result.isValid).toBe(true);
  });

  it("should reject extra fields in nested objects", () => {
    const schema = SchemaValidator.enforceStrictSchema({
      type: "object",
      properties: {
        user: {
          type: "object",
          properties: {
            name: { type: "string" },
          },
        },
      },
    });

    const result = SchemaValidator.validate({ user: { name: "test", hack: "evil" } }, schema);
    expect(result.isValid).toBe(false);
    expect(result.errors!.some((e) => e.includes("hack"))).toBe(true);
  });

  it("should reject extra fields in array items", () => {
    const schema = SchemaValidator.enforceStrictSchema({
      type: "object",
      properties: {
        list: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
            },
          },
        },
      },
    });

    const result = SchemaValidator.validate({ list: [{ id: "1", extra: true }] }, schema);
    expect(result.isValid).toBe(false);
  });

  it("should not modify original schema object", () => {
    const original = {
      type: "object" as const,
      properties: {
        name: { type: "string" },
      },
    };

    SchemaValidator.enforceStrictSchema(original);

    // Original should NOT have additionalProperties
    expect((original as Record<string, unknown>).additionalProperties).toBeUndefined();
  });
});
