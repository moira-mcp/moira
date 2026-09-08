/**
 * Usability of a JSON Schema an extension manifest declares.
 *
 * A manifest carries schemas Moira compiles later — for a node's configuration, its input and
 * output, and for the value of a declared setting. "Is an object" is not the same question as "can
 * be compiled": `{"type": "banana"}` and `{"required": "text"}` are perfectly good JSON objects and
 * not schemas at all. Without this check the defect surfaces far from the manifest, as an exception
 * thrown inside whichever consumer compiled it first, and an installation reads that as Moira being
 * broken rather than as a defect of the bundle.
 */

import * as AjvModule from "ajv";
export { canonicalJson } from "@mcp-moira/shared";
import { canonicalJson } from "@mcp-moira/shared";

/**
 * Options every Ajv instance that compiles an extension-declared schema must use.
 *
 * `addUsedSchema: false` is the substantive one. By default Ajv registers a compiled schema under
 * its `$id`, and a second, different schema carrying the same `$id` is then refused with
 * `schema with key or id "…" already exists` — a failure about the instance's history rather than
 * about the schema. Two extensions, or two settings of one extension, may easily carry the same
 * `$id`; without this option the check below would accept a manifest that a consumer with a
 * long-lived instance later refuses. Every consumer of a declared schema builds its instance with
 * these options, so what the manifest check accepts is what they can compile.
 */
export const DECLARED_SCHEMA_AJV_OPTIONS = {
  // Declared schemas validate request-controlled values in production. Fail fast so one adversarial
  // value cannot force Ajv to allocate an error for every bad branch/property.
  allErrors: false,
  strict: false,
  addUsedSchema: false,
} as const;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ajv = new (AjvModule as any).default(DECLARED_SCHEMA_AJV_OPTIONS);

const MAX_DECLARED_SCHEMA_DEPTH = 16;
const MAX_DECLARED_SCHEMA_ENTRIES = 512;
const MAX_DECLARED_SCHEMA_ARRAY_ITEMS = 256;
const FORBIDDEN_SCHEMA_KEYWORDS = new Set([
  "$ref",
  "$recursiveRef",
  "$dynamicRef",
  "pattern",
  "patternProperties",
]);
const SCHEMA_MAP_KEYWORDS = new Set([
  "properties",
  "$defs",
  "definitions",
  "dependencies",
  "dependentSchemas",
]);
const SCHEMA_ARRAY_KEYWORDS = new Set(["allOf", "anyOf", "oneOf", "prefixItems"]);
const SCHEMA_VALUE_KEYWORDS = new Set([
  "items",
  "additionalItems",
  "additionalProperties",
  "contains",
  "not",
  "if",
  "then",
  "else",
  "propertyNames",
  "contentSchema",
  "unevaluatedItems",
  "unevaluatedProperties",
]);

function declaredSchemaSafetyProblem(schema: unknown): string | null {
  const structureProblem = declaredSchemaStructureProblem(schema);
  if (structureProblem) return structureProblem;

  const schemas: Array<{ value: unknown; path: string }> = [{ value: schema, path: "$" }];
  while (schemas.length > 0) {
    const current = schemas.pop()!;
    if (!current.value || typeof current.value !== "object" || Array.isArray(current.value)) {
      continue;
    }
    for (const [key, nested] of Object.entries(current.value as Record<string, unknown>)) {
      if (FORBIDDEN_SCHEMA_KEYWORDS.has(key)) {
        return `keyword '${key}' is not allowed in extension-declared schemas (${current.path})`;
      }
      if (
        SCHEMA_MAP_KEYWORDS.has(key) &&
        nested &&
        typeof nested === "object" &&
        !Array.isArray(nested)
      ) {
        for (const [name, childSchema] of Object.entries(nested as Record<string, unknown>)) {
          schemas.push({
            value: childSchema,
            path: `${current.path}.${key}[${JSON.stringify(name)}]`,
          });
        }
      } else if (SCHEMA_ARRAY_KEYWORDS.has(key) && Array.isArray(nested)) {
        nested.forEach((childSchema, index) => {
          schemas.push({ value: childSchema, path: `${current.path}.${key}[${index}]` });
        });
      } else if (SCHEMA_VALUE_KEYWORDS.has(key)) {
        if (Array.isArray(nested)) {
          nested.forEach((childSchema, index) => {
            schemas.push({ value: childSchema, path: `${current.path}.${key}[${index}]` });
          });
        } else {
          schemas.push({ value: nested, path: `${current.path}.${key}` });
        }
      }
    }
  }
  return null;
}

function declaredSchemaStructureProblem(schema: unknown): string | null {
  const stack: Array<{ value: unknown; depth: number; path: string }> = [
    { value: schema, depth: 0, path: "$" },
  ];
  let entries = 0;

  while (stack.length > 0) {
    const current = stack.pop()!;
    if (current.depth > MAX_DECLARED_SCHEMA_DEPTH) {
      return `schema exceeds maximum depth ${MAX_DECLARED_SCHEMA_DEPTH} at ${current.path}`;
    }
    if (current.value === null || typeof current.value !== "object") continue;
    if (Array.isArray(current.value)) {
      if (current.value.length > MAX_DECLARED_SCHEMA_ARRAY_ITEMS) {
        return `schema array exceeds ${MAX_DECLARED_SCHEMA_ARRAY_ITEMS} items at ${current.path}`;
      }
      entries += current.value.length;
      for (let index = 0; index < current.value.length; index += 1) {
        stack.push({
          value: current.value[index],
          depth: current.depth + 1,
          path: `${current.path}[${index}]`,
        });
      }
    } else {
      const members = Object.entries(current.value as Record<string, unknown>);
      entries += members.length;
      for (const [key, nested] of members) {
        stack.push({ value: nested, depth: current.depth + 1, path: `${current.path}.${key}` });
      }
    }
    if (entries > MAX_DECLARED_SCHEMA_ENTRIES) {
      return `schema exceeds ${MAX_DECLARED_SCHEMA_ENTRIES} structural entries`;
    }
  }
  return null;
}

/**
 * The reason a declared schema cannot be used, or null when it compiles.
 *
 * One instance is enough because it registers nothing: with `addUsedSchema: false` compiling the
 * same `$id` twice is not an error, so this check answers about the schema alone — exactly the
 * question the consumers ask when they compile it later.
 */
export function declaredSchemaProblem(schema: unknown): string | null {
  const safetyProblem = declaredSchemaSafetyProblem(schema);
  if (safetyProblem) return safetyProblem;
  try {
    ajv.compile(schema);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}
