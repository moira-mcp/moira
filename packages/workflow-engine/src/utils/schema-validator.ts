/**
 * Schema validation utility for workflow steps
 */

import AjvDefault from "ajv";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const Ajv = (AjvDefault as any).default || AjvDefault;

const ajv = new Ajv({
  allErrors: true,
  verbose: true,
  strict: false,
});

export function validateSchema(data: unknown, schema: Record<string, unknown>): boolean {
  try {
    const validate = ajv.compile(schema);
    return validate(data);
  } catch {
    return false;
  }
}

export class SchemaValidator {
  /**
   * Validate input against a JSON Schema
   * @param data The data to validate
   * @param schema The JSON Schema to validate against
   * @returns Validation result with success status and errors if any
   */
  static validate(
    data: unknown,
    schema: Record<string, unknown>,
  ): {
    isValid: boolean;
    errors?: string[];
    validatedData?: unknown;
  } {
    try {
      const validate = ajv.compile(schema);
      const isValid = validate(data);

      if (!isValid) {
        const errors = validate.errors?.map((err: unknown) =>
          SchemaValidator.formatValidationError(err, schema),
        ) || ["Unknown validation error"];

        return {
          isValid: false,
          errors,
        };
      }

      return {
        isValid: true,
        validatedData: data,
      };
    } catch (error) {
      return {
        isValid: false,
        errors: [error instanceof Error ? error.message : "Schema compilation error"],
      };
    }
  }

  /**
   * Format validation error into human-readable message with fix instructions
   * @param error AJV validation error object
   * @param schema Original JSON schema for context
   * @returns Human-readable error message with fix instructions
   */
  static formatValidationError(error: unknown, _schema: Record<string, unknown>): string {
    // Type guard for AJV error object structure
    if (!error || typeof error !== "object") {
      return "Invalid validation error format";
    }

    const ajvError = error as {
      instancePath?: string;
      keyword?: string;
      schema?: unknown;
      data?: unknown;
      message?: string;
      params?: Record<string, unknown>;
    };
    const field = ajvError.instancePath ? ajvError.instancePath.replace("/", "") : "root";
    const keyword = ajvError.keyword;
    const expectedValue = ajvError.schema;
    const receivedValue = ajvError.data;
    const receivedType = typeof receivedValue;

    // Base error components
    const fieldName = field || "input";
    const expected = expectedValue || "valid value";
    const received = receivedValue !== undefined ? JSON.stringify(receivedValue) : "undefined";

    switch (keyword) {
      case "type":
        return (
          `VALIDATION ERROR: Field '${fieldName}' must be ${expected}, got ${receivedType}. ` +
          `Provide ${expected} value instead.`
        );

      case "required": {
        const missingProperty = ajvError.params?.missingProperty;
        return (
          `VALIDATION ERROR: Required field '${missingProperty}' is missing. ` +
          `Add '${missingProperty}' field to your input.`
        );
      }

      case "enum": {
        const allowedValues = ajvError.schema;
        return (
          `VALIDATION ERROR: Field '${fieldName}' must be one of: ${JSON.stringify(allowedValues)}. ` +
          `Got: ${received}. Use one of the allowed values.`
        );
      }

      case "minLength": {
        const minLength = ajvError.schema;
        const actualLength = (ajvError.data as string)?.length || 0;
        return (
          `VALIDATION ERROR: Field '${fieldName}' must be at least ${minLength} characters long. ` +
          `Got ${actualLength} characters. Provide longer text.`
        );
      }

      case "maxLength": {
        const maxLength = ajvError.schema;
        const currentLength = (ajvError.data as string)?.length || 0;
        return (
          `VALIDATION ERROR: Field '${fieldName}' must be no more than ${maxLength} characters long. ` +
          `Got ${currentLength} characters. Shorten the text.`
        );
      }

      case "minimum": {
        const minimum = ajvError.schema;
        return (
          `VALIDATION ERROR: Field '${fieldName}' must be at least ${minimum}. ` +
          `Got: ${received}. Provide number >= ${minimum}.`
        );
      }

      case "maximum": {
        const maximum = ajvError.schema;
        return (
          `VALIDATION ERROR: Field '${fieldName}' must be no more than ${maximum}. ` +
          `Got: ${received}. Provide number <= ${maximum}.`
        );
      }

      case "pattern": {
        const pattern = ajvError.schema;
        return (
          `VALIDATION ERROR: Field '${fieldName}' must match pattern ${pattern}. ` +
          `Got: ${received}. Adjust format to match required pattern.`
        );
      }

      case "additionalProperties": {
        const extraProp = ajvError.params?.additionalProperty;
        return (
          `VALIDATION ERROR: Unknown field '${extraProp}' is not allowed. ` +
          `Remove '${extraProp}' or check field name spelling.`
        );
      }

      case "oneOf":
      case "anyOf":
        return (
          `VALIDATION ERROR: Field '${fieldName}' doesn't match any allowed formats. ` +
          `Got: ${received}. Check expected input format.`
        );

      default: {
        // Fallback for other validation errors
        const message = ajvError.message || "Validation failed";
        return (
          `VALIDATION ERROR: ${message} in field '${fieldName}'. ` +
          `Expected: ${expected}, Got: ${received}. Adjust input to match expected format.`
        );
      }
    }
  }

  /**
   * Enforce strict schema by injecting additionalProperties: false
   * into object schemas that don't already specify it.
   * This prevents agents from sending extra fields that silently
   * become workflow variables via Object.assign.
   *
   * Handles: top-level objects, nested properties, array items.
   * Respects existing additionalProperties settings.
   */
  static enforceStrictSchema(schema: Record<string, unknown>): Record<string, unknown> {
    if (!schema || typeof schema !== "object") return schema;

    const result = { ...schema };
    const type = result.type;
    const isObjectType = type === "object" || (Array.isArray(type) && type.includes("object"));

    // Inject additionalProperties: false for object types with properties
    if (isObjectType && result.properties && !("additionalProperties" in result)) {
      result.additionalProperties = false;
    }

    // Recurse into properties
    if (result.properties && typeof result.properties === "object") {
      const props = result.properties as Record<string, Record<string, unknown>>;
      const newProps: Record<string, Record<string, unknown>> = {};
      for (const [key, prop] of Object.entries(props)) {
        newProps[key] = SchemaValidator.enforceStrictSchema(prop);
      }
      result.properties = newProps;
    }

    // Recurse into array items
    if (result.items && typeof result.items === "object" && !Array.isArray(result.items)) {
      result.items = SchemaValidator.enforceStrictSchema(result.items as Record<string, unknown>);
    }

    return result;
  }

  /**
   * Get a human-readable description of a schema
   * @param schema The JSON Schema
   * @returns Human-readable description
   */
  static describeSchema(schema: Record<string, unknown>): string {
    const type = schema.type || "any";
    const properties = schema.properties as Record<string, Record<string, unknown>> | undefined;
    const required = schema.required as string[];

    if (type === "object" && properties) {
      const fields = Object.entries(properties).map(([key, prop]) => {
        const fieldType = prop.type || "any";
        const isRequired = required?.includes(key) ? " (required)" : " (optional)";
        const enumValues = Array.isArray(prop.enum) ? ` [${prop.enum.join(", ")}]` : "";
        const description = typeof prop.description === "string" ? ` - ${prop.description}` : "";
        return `  - ${key}: ${fieldType}${enumValues}${isRequired}${description}`;
      });

      return `Object with fields:\n${fields.join("\n")}`;
    }

    return `Type: ${type}`;
  }

  /**
   * Format schema as JSON example for agents
   * Shows each field with type, required/optional, and description
   * @param schema The JSON Schema
   * @returns JSON-like format string for agent understanding
   */
  static formatSchemaForAgent(schema: Record<string, unknown>): string {
    const properties = schema.properties as Record<string, Record<string, unknown>> | undefined;
    const required = (schema.required as string[]) || [];

    if (!properties || Object.keys(properties).length === 0) {
      // Empty schema - accepts null or {}
      return "null or {}";
    }

    const lines: string[] = ["{"];
    const entries = Object.entries(properties);

    entries.forEach(([key, prop], index) => {
      const fieldType = prop.type || "any";
      const isRequired = required.includes(key);
      const requiredLabel = isRequired ? "required" : "optional";
      const constraints = SchemaValidator.formatConstraints(prop);
      const description = typeof prop.description === "string" ? ` - ${prop.description}` : "";
      const comma = index < entries.length - 1 ? "," : "";

      lines.push(
        `  "${key}": "${fieldType} (${requiredLabel}${constraints})${description}"${comma}`,
      );
    });

    lines.push("}");
    return lines.join("\n");
  }

  /**
   * Render a property's value constraints so the agent sees what its response must satisfy.
   * Without this the agent is validated against constraints (items/pattern/minLength/...) it was
   * never shown, causing avoidable retry loops.
   */
  private static formatConstraints(prop: Record<string, unknown>): string {
    const parts: string[] = [];
    if (Array.isArray(prop.enum)) parts.push(`values: [${prop.enum.join(", ")}]`);
    if (prop.items && typeof prop.items === "object") {
      const itemSchema = prop.items as Record<string, unknown>;
      const itemType = itemSchema.type ?? "any";
      const itemEnum = Array.isArray(itemSchema.enum) ? ` of [${itemSchema.enum.join(", ")}]` : "";
      parts.push(`items: ${itemType}${itemEnum}`);
    }
    if (prop.properties && typeof prop.properties === "object") {
      const keys = Object.keys(prop.properties as Record<string, unknown>);
      if (keys.length > 0) parts.push(`fields: {${keys.join(", ")}}`);
    }
    if (typeof prop.pattern === "string") parts.push(`pattern: ${prop.pattern}`);
    if (typeof prop.format === "string") parts.push(`format: ${prop.format}`);
    if (typeof prop.minLength === "number") parts.push(`minLength: ${prop.minLength}`);
    if (typeof prop.maxLength === "number") parts.push(`maxLength: ${prop.maxLength}`);
    if (typeof prop.minItems === "number") parts.push(`minItems: ${prop.minItems}`);
    if (typeof prop.minimum === "number") parts.push(`min: ${prop.minimum}`);
    if (typeof prop.maximum === "number") parts.push(`max: ${prop.maximum}`);
    return parts.length > 0 ? `, ${parts.join(", ")}` : "";
  }

  /**
   * Format validation error comprehensively for AI agents
   * Includes: schema description, user input, specific errors, action required
   * This format is designed to be clear even for simpler models (Haiku, GPT-3.5)
   *
   * @param schema The JSON Schema that was used for validation
   * @param userInput The actual input that failed validation
   * @param errors List of specific validation error messages
   * @returns Comprehensive error message for agent
   */
  static formatValidationErrorForAgent(
    schema: Record<string, unknown> | undefined,
    userInput: unknown,
    errors: string[],
  ): string {
    const sections: string[] = [];

    // Header
    sections.push("❌ VALIDATION ERROR - Your input doesn't match the required schema");
    sections.push("");

    // Expected format section
    sections.push("EXPECTED INPUT FORMAT:");
    if (schema) {
      sections.push(this.formatSchemaForAgent(schema));
    } else {
      sections.push("null or {} (no inputSchema defined - node accepts empty input only)");
    }
    sections.push("");

    // User input section
    sections.push("YOUR INPUT:");
    try {
      const inputStr = JSON.stringify(userInput, null, 2);
      // Truncate very long inputs
      const maxLength = 500;
      if (inputStr.length > maxLength) {
        sections.push(inputStr.substring(0, maxLength) + "...[truncated]");
      } else {
        sections.push(inputStr);
      }
    } catch {
      sections.push(String(userInput));
    }
    sections.push("");

    // Errors section
    sections.push("ERRORS:");
    errors.forEach((error) => {
      // Remove "VALIDATION ERROR:" prefix if present (avoid duplication)
      const cleanError = error.replace(/^VALIDATION ERROR:\s*/i, "");
      sections.push(`• ${cleanError}`);
    });
    sections.push("");

    // Action required section
    sections.push("ACTION REQUIRED:");
    sections.push(
      "Send a new input object with the correct structure. Do not proceed until validation passes.",
    );

    return sections.join("\n");
  }
}
