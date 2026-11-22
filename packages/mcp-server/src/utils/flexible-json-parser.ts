/**
 * Flexible JSON parser with auto-parse preprocessing for MCP tools
 *
 * Handles common agent serialization quirks:
 * - Stringified JSON objects (Claude Code bug where objects become strings)
 * - Single-quote JSON (Python dict format)
 * - Unquoted keys (JavaScript object notation)
 * - Escaped JSON strings
 *
 * @module flexible-json-parser
 */

import { z } from "zod";

/**
 * Enhanced JSON parser supporting user-friendly formats
 * Supports: {'field': 'value'}, escaped JSON strings, mixed quote formats
 */
export function parseFlexibleJSON(input: string, depth: number = 0): unknown {
  const trimmed = input.trim();

  // First try standard JSON parsing (fastest path for well-formed JSON)
  try {
    return JSON.parse(trimmed);
  } catch {
    // If standard parsing fails, try flexible parsing
  }

  // Handle escaped JSON strings: "{\"field\": \"value\"}" or "{'field': 'value'}"
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      const unescaped = JSON.parse(trimmed); // This unescapes the outer quotes
      if (typeof unescaped === "string") {
        // Try to parse the inner string as JSON first
        try {
          return JSON.parse(unescaped);
        } catch (innerError) {
          // If standard JSON parsing fails, try flexible parsing on the unescaped string
          if (depth < 2) {
            const innerTrimmed = unescaped.trim();
            if (
              (innerTrimmed.startsWith("{") && innerTrimmed.endsWith("}")) ||
              (innerTrimmed.startsWith("[") && innerTrimmed.endsWith("]"))
            ) {
              try {
                let jsonCompatible = convertSingleQuotesToDoubleQuotes(innerTrimmed);
                jsonCompatible = addQuotesToUnquotedKeys(jsonCompatible);
                return JSON.parse(jsonCompatible);
              } catch {
                throw innerError;
              }
            }
          }
          throw innerError;
        }
      }
      return unescaped;
    } catch {
      // Continue to next parsing strategy
    }
  }

  // Handle single quote JSON and JavaScript object notation
  if (
    (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
    (trimmed.startsWith("[") && trimmed.endsWith("]"))
  ) {
    try {
      let jsonCompatible = convertSingleQuotesToDoubleQuotes(trimmed);
      jsonCompatible = addQuotesToUnquotedKeys(jsonCompatible);
      return JSON.parse(jsonCompatible);
    } catch {
      // Continue to next parsing strategy
    }
  }

  // If all parsing strategies fail, throw error
  throw new Error(`Unable to parse input as JSON: ${trimmed.substring(0, 100)}...`);
}

/**
 * Convert single quotes to double quotes for JSON compatibility
 * Handles mixed quote scenarios and preserves strings properly
 */
export function convertSingleQuotesToDoubleQuotes(input: string): string {
  let result = "";
  let inString = false;
  let stringDelimiter = "";
  let i = 0;

  while (i < input.length) {
    const char = input[i];
    const nextChar = input[i + 1];

    if (!inString) {
      if (char === '"' || char === "'") {
        inString = true;
        stringDelimiter = char;
        result += '"';
      } else {
        result += char;
      }
    } else {
      if (char === "\\" && nextChar) {
        if (nextChar === stringDelimiter) {
          result += '\\"';
          i++;
        } else {
          result += char + nextChar;
          i++;
        }
      } else if (char === stringDelimiter) {
        inString = false;
        stringDelimiter = "";
        result += '"';
      } else {
        if (char === '"') {
          result += '\\"';
        } else {
          result += char;
        }
      }
    }
    i++;
  }

  return result;
}

/**
 * Add quotes to unquoted JavaScript object keys
 * Converts {key: 'value'} to {"key": 'value'}
 */
export function addQuotesToUnquotedKeys(input: string): string {
  return input.replace(/(\{|\s*,\s*)([a-zA-Z_$][a-zA-Z0-9_$]*)\s*:/g, '$1"$2":');
}

/**
 * Wrap a Zod input schema map so that any z.object() or z.array() fields
 * automatically parse stringified JSON before validation.
 *
 * This fixes the Claude Code bug where JSON objects are serialized as strings
 * when calling MCP tools. The preprocessing runs inside Zod's parse pipeline
 * (via z.preprocess), so it happens BEFORE schema validation.
 *
 * The public JSON Schema is exported from the original tool schema, before
 * preprocessing, so clients still discover the structured input contract.
 */
export function wrapSchemaWithAutoparse(
  inputSchema: Record<string, z.ZodTypeAny>,
): Record<string, z.ZodTypeAny> {
  const result: Record<string, z.ZodTypeAny> = {};
  for (const [key, value] of Object.entries(inputSchema)) {
    result[key] = wrapFieldWithAutoparse(value);
  }
  return result;
}

/**
 * Preserve the original object's unknown-key policy and refinements when preparing
 * its fields for SDK registration, including grouped tool union branches.
 */
export function wrapToolSchemaWithAutoparse(inputSchema: z.ZodTypeAny): z.ZodTypeAny {
  if (inputSchema instanceof z.ZodUnion) {
    return inputSchema.clone({
      ...inputSchema.def,
      options: inputSchema.options.map((option) =>
        option instanceof z.ZodType ? wrapToolSchemaWithAutoparse(option) : option,
      ),
    });
  }
  if (!(inputSchema instanceof z.ZodObject)) return inputSchema;
  const shape = wrapSchemaWithAutoparse(inputSchema.shape);
  return inputSchema.safeExtend(shape);
}

/**
 * Recursively wrap a single Zod field with JSON auto-parsing if it expects
 * an object or array type. Handles optional/default wrappers.
 */
function wrapFieldWithAutoparse(schema: z.ZodTypeAny): z.ZodTypeAny {
  // Unwrap only for classification. Validation must keep the original wrappers,
  // including lazy default factories and optional/null semantics.
  let structured: z.core.$ZodType = schema;
  while (
    structured instanceof z.ZodOptional ||
    structured instanceof z.ZodDefault ||
    structured instanceof z.ZodNullable
  ) {
    structured = structured.unwrap();
  }

  // Object and array schemas: wrap with z.preprocess to auto-parse strings
  if (
    structured instanceof z.ZodObject ||
    structured instanceof z.ZodArray ||
    structured instanceof z.ZodRecord
  ) {
    const preprocessed = z.preprocess((val: unknown) => {
      if (typeof val === "string") {
        try {
          return parseFlexibleJSON(val);
        } catch {
          return val; // let Zod validation produce the appropriate error
        }
      }
      return val;
    }, schema);
    return schema.description ? preprocessed.describe(schema.description) : preprocessed;
  }

  return schema;
}
