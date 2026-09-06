/** Value preparation shared by manifest admission and every repository implementation. */

import * as AjvModule from "ajv";
import { DECLARED_SCHEMA_AJV_OPTIONS, declaredSchemaProblem } from "./declared-schema.js";

type ExtensionSettingType = "string" | "number" | "boolean" | "json" | "encrypted";

export interface ExtensionSettingValueContract {
  key: string;
  type: ExtensionSettingType;
  validation?: string | Record<string, unknown> | null;
}

export type PreparedExtensionSettingValue =
  { value: unknown; problem: null } | { value: undefined; problem: string };

// Ajv ships as CommonJS; the engine constructs it through the module default elsewhere too.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ajv = new (AjvModule as any).default(DECLARED_SCHEMA_AJV_OPTIONS);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const validators = new Map<string, any>();

function jsonValueProblem(
  value: unknown,
  path = "/",
  ancestors = new Set<object>(),
): string | null {
  if (value === null || typeof value === "string" || typeof value === "boolean") return null;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return `${path} must be a finite JSON number`;
    if (Object.is(value, -0)) return `${path} must round-trip as the same JSON number`;
    return null;
  }
  if (typeof value !== "object") return `${path} must be a JSON value`;
  if (ancestors.has(value)) return `${path} must not contain a JSON cycle`;

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) {
        return `${path} must be a plain JSON array`;
      }
      const keys = Object.keys(value);
      if (keys.length !== value.length || keys.some((key) => !/^(0|[1-9]\d*)$/.test(key))) {
        return `${path} must be a dense JSON array without extra properties`;
      }
      const ownKeys = Reflect.ownKeys(value);
      if (
        ownKeys.length !== value.length + 1 ||
        !ownKeys.every(
          (key) =>
            key === "length" ||
            (typeof key === "string" && /^(0|[1-9]\d*)$/.test(key) && Number(key) < value.length),
        )
      ) {
        return `${path} must not contain properties that JSON serialization can invoke or omit`;
      }
      if (typeof (value as { toJSON?: unknown }).toJSON === "function") {
        return `${path} must not define inherited JSON serialization behavior`;
      }
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || !("value" in descriptor)) {
          return `${path}/${index} must be a stable JSON array value`;
        }
        const problem = jsonValueProblem(descriptor.value, `${path}/${index}`, ancestors);
        if (problem) return problem;
      }
      return null;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      return `${path} must be a plain JSON object`;
    }
    const keys = Object.keys(value);
    if (Reflect.ownKeys(value).length !== keys.length) {
      return `${path} must not contain properties that JSON serialization omits`;
    }
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor)) {
        return `${path}/${key} must be a stable JSON object value`;
      }
      const problem = jsonValueProblem(descriptor.value, `${path}/${key}`, ancestors);
      if (problem) return problem;
    }
    return null;
  } finally {
    ancestors.delete(value);
  }
}

function normalizeDeclaredType(
  type: ExtensionSettingType,
  input: unknown,
): PreparedExtensionSettingValue {
  switch (type) {
    case "string":
    case "encrypted":
      return typeof input === "string"
        ? { value: input, problem: null }
        : { value: undefined, problem: `must be a ${type} string` };
    case "number": {
      const value =
        typeof input === "number" ? input : typeof input === "string" ? Number(input) : NaN;
      return (typeof input === "string" && input.trim() === "") || !Number.isFinite(value)
        ? { value: undefined, problem: "must be a finite number" }
        : { value, problem: null };
    }
    case "boolean":
      if (typeof input === "boolean") return { value: input, problem: null };
      if (input === "true" || input === "1") return { value: true, problem: null };
      if (input === "false" || input === "0") return { value: false, problem: null };
      return { value: undefined, problem: "must be a boolean (true, false, 1, or 0)" };
    case "json": {
      let value = input;
      if (typeof input === "string") {
        try {
          value = JSON.parse(input);
        } catch (error) {
          return {
            value: undefined,
            problem: `must be valid JSON: ${error instanceof Error ? error.message : String(error)}`,
          };
        }
      }
      const problem = jsonValueProblem(value);
      if (problem) return { value: undefined, problem };
      try {
        // Return the JSON projection that will be stored. The check above guarantees serialization
        // cannot omit, transform or invoke user-defined behavior, and parsing here makes that
        // invariant explicit for every later consumer.
        return { value: JSON.parse(JSON.stringify(value)), problem: null };
      } catch (error) {
        return {
          value: undefined,
          problem: `must be a JSON value: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    }
  }
}

function schemaObject(validation: ExtensionSettingValueContract["validation"]): {
  schema?: Record<string, unknown>;
  problem?: string;
} {
  if (!validation) return {};
  if (typeof validation !== "string") return { schema: validation };
  try {
    const parsed = JSON.parse(validation);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { problem: "declared validation schema is not a JSON Schema object" };
    }
    return { schema: parsed as Record<string, unknown> };
  } catch (error) {
    return {
      problem: `declared validation schema is not valid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
}

function schemaProblem(contract: ExtensionSettingValueContract, value: unknown): string | null {
  const parsed = schemaObject(contract.validation);
  if (parsed.problem) return parsed.problem;
  if (!parsed.schema) return null;

  const declaredProblem = declaredSchemaProblem(parsed.schema);
  if (declaredProblem) {
    return `declared validation schema is not a usable JSON Schema: ${declaredProblem}`;
  }

  const serialised = JSON.stringify(parsed.schema);
  const cacheKey = `${contract.key}\u0000${serialised}`;
  let validate = validators.get(cacheKey);
  if (!validate) {
    try {
      validate = ajv.compile(parsed.schema);
    } catch (error) {
      return `declared validation schema could not be compiled: ${
        error instanceof Error ? error.message : String(error)
      }`;
    }
    validators.set(cacheKey, validate);
  }

  if (validate(value)) return null;
  const errors = (validate.errors ?? []) as Array<{
    instancePath?: string;
    message?: string;
    params?: Record<string, unknown>;
  }>;
  return errors
    .map((issue) => {
      const named =
        issue.params && typeof issue.params.additionalProperty === "string"
          ? ` '${issue.params.additionalProperty}'`
          : issue.params && typeof issue.params.missingProperty === "string"
            ? ` '${issue.params.missingProperty}'`
            : "";
      return `${issue.instancePath || "/"} ${issue.message ?? "is invalid"}${named}`;
    })
    .join("; ");
}

/**
 * Normalize a settings-screen/API value to its declared type, then apply the optional schema.
 * The type is mandatory even when the manifest supplies no additional schema.
 */
export function prepareExtensionSettingValue(
  contract: ExtensionSettingValueContract,
  input: unknown,
): PreparedExtensionSettingValue {
  const normalized = normalizeDeclaredType(contract.type, input);
  if (normalized.problem) return normalized;
  const problem = schemaProblem(contract, normalized.value);
  return problem ? { value: undefined, problem } : { value: normalized.value, problem: null };
}

export function validateExtensionSettingValue(
  contract: ExtensionSettingValueContract,
  input: unknown,
): string | null {
  return prepareExtensionSettingValue(contract, input).problem;
}
