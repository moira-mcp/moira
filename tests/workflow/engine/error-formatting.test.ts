/**
 * Unit tests for enhanced error message formatting
 */

import { describe, test, expect } from "@jest/globals";
import { SchemaValidator } from "@mcp-moira/workflow-engine";

describe("Enhanced Error Formatting Tests", () => {
  test("formats type validation errors with fix instructions", () => {
    const mockError = {
      keyword: "type",
      instancePath: "/name",
      schema: "string",
      data: 123,
      message: "must be string",
    };

    const formatted = SchemaValidator.formatValidationError(mockError, {});

    expect(formatted).toMatchSnapshot("type-validation-error-string-number");
  });

  test("formats required field errors with fix instructions", () => {
    const mockError = {
      keyword: "required",
      instancePath: "",
      params: { missingProperty: "username" },
      message: "must have required property username",
    };

    const formatted = SchemaValidator.formatValidationError(mockError, {});

    expect(formatted).toMatchSnapshot("required-field-error-username");
  });

  test("formats enum validation errors with allowed values", () => {
    const mockError = {
      keyword: "enum",
      instancePath: "/status",
      schema: ["active", "inactive", "pending"],
      data: "unknown",
      message: "must be equal to one of the allowed values",
    };

    const formatted = SchemaValidator.formatValidationError(mockError, {});

    expect(formatted).toContain(
      'VALIDATION ERROR: Field \'status\' must be one of: ["active","inactive","pending"]',
    );
    expect(formatted).toContain('Got: "unknown"');
    expect(formatted).toContain("Use one of the allowed values");
  });

  test("formats length validation errors with specific guidance", () => {
    const minLengthError = {
      keyword: "minLength",
      instancePath: "/description",
      schema: 10,
      data: "short",
      message: "must be at least 10 characters long",
    };

    const formatted = SchemaValidator.formatValidationError(minLengthError, {});

    expect(formatted).toContain(
      "VALIDATION ERROR: Field 'description' must be at least 10 characters long",
    );
    expect(formatted).toContain("Got 5 characters");
    expect(formatted).toContain("Provide longer text");
  });

  test("formats number range validation errors", () => {
    const minimumError = {
      keyword: "minimum",
      instancePath: "/score",
      schema: 0,
      data: -5,
      message: "must be >= 0",
    };

    const formatted = SchemaValidator.formatValidationError(minimumError, {});

    expect(formatted).toContain("VALIDATION ERROR: Field 'score' must be at least 0");
    expect(formatted).toContain("Got: -5");
    expect(formatted).toContain("Provide number >= 0");
  });

  test("formats pattern validation errors with pattern info", () => {
    const patternError = {
      keyword: "pattern",
      instancePath: "/email",
      schema: "^[\\w-\\.]+@([\\w-]+\\.)+[\\w-]{2,4}$",
      data: "invalid-email",
      message: "must match pattern",
    };

    const formatted = SchemaValidator.formatValidationError(patternError, {});

    expect(formatted).toContain("VALIDATION ERROR: Field 'email' must match pattern");
    expect(formatted).toContain('Got: "invalid-email"');
    expect(formatted).toContain("Adjust format to match required pattern");
  });

  test("formats additional properties errors", () => {
    const additionalPropsError = {
      keyword: "additionalProperties",
      instancePath: "",
      params: { additionalProperty: "unknownField" },
      message: "must NOT have additional properties",
    };

    const formatted = SchemaValidator.formatValidationError(additionalPropsError, {});

    expect(formatted).toContain("VALIDATION ERROR: Unknown field 'unknownField' is not allowed");
    expect(formatted).toContain("Remove 'unknownField' or check field name spelling");
  });

  test("formats oneOf/anyOf validation errors", () => {
    const oneOfError = {
      keyword: "oneOf",
      instancePath: "/value",
      data: { invalid: "structure" },
      message: "must match exactly one schema in oneOf",
    };

    const formatted = SchemaValidator.formatValidationError(oneOfError, {});

    expect(formatted).toContain(
      "VALIDATION ERROR: Field 'value' doesn't match any allowed formats",
    );
    expect(formatted).toContain("Check expected input format");
  });

  test("formats unknown validation errors with fallback", () => {
    const unknownError = {
      keyword: "customKeyword",
      instancePath: "/customField",
      schema: "customValue",
      data: "testData",
      message: "custom validation failed",
    };

    const formatted = SchemaValidator.formatValidationError(unknownError, {});

    expect(formatted).toContain(
      "VALIDATION ERROR: custom validation failed in field 'customField'",
    );
    expect(formatted).toContain('Expected: customValue, Got: "testData"');
    expect(formatted).toContain("Adjust input to match expected format");
  });

  test("handles root level validation errors", () => {
    const rootError = {
      keyword: "type",
      instancePath: "",
      schema: "object",
      data: "not an object",
      message: "must be object",
    };

    const formatted = SchemaValidator.formatValidationError(rootError, {});

    expect(formatted).toContain("VALIDATION ERROR: Field 'root' must be object, got string");
    expect(formatted).toContain("Provide object value instead");
  });

  test("validates enhanced schema validator integration", () => {
    const testSchema = {
      type: "object",
      properties: {
        name: { type: "string", minLength: 3 },
        age: { type: "number", minimum: 0 },
        status: { type: "string", enum: ["active", "inactive"] },
      },
      required: ["name"],
    };

    // Test missing required field
    const missingResult = SchemaValidator.validate({}, testSchema);
    expect(missingResult.isValid).toBe(false);
    expect(missingResult.errors?.[0]).toContain(
      "VALIDATION ERROR: Required field 'name' is missing",
    );
    expect(missingResult.errors?.[0]).toContain("Add 'name' field");

    // Test invalid type
    const typeResult = SchemaValidator.validate({ name: 123 }, testSchema);
    expect(typeResult.isValid).toBe(false);
    expect(typeResult.errors?.[0]).toContain(
      "VALIDATION ERROR: Field 'name' must be string, got number",
    );

    // Test valid data
    const validResult = SchemaValidator.validate(
      {
        name: "John",
        age: 25,
        status: "active",
      },
      testSchema,
    );
    expect(validResult.isValid).toBe(true);
    expect(validResult.validatedData).toBeDefined();
  });
});
