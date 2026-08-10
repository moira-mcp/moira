import { ValidationError } from "@mcp-moira/shared";
import type { VariableRegistry } from "../types/graph-nodes.js";
import { SchemaValidator } from "./schema-validator.js";

export function validateDeclaredRegistryValues(
  values: Record<string, unknown>,
  registry: VariableRegistry | undefined,
  boundary: string,
  rejectUndeclared = false,
): Record<string, unknown> {
  const normalized = { ...values };
  if (!registry) return normalized;

  if (rejectUndeclared) {
    for (const name of Object.keys(normalized)) {
      if (!Object.prototype.hasOwnProperty.call(registry, name)) {
        throw new ValidationError(`Undeclared variable '${name}' at ${boundary}`, {
          validationContext: { input: normalized[name] },
        });
      }
    }
  }

  for (const [name, schema] of Object.entries(registry)) {
    if (Object.prototype.hasOwnProperty.call(normalized, name) && normalized[name] === undefined) {
      if (Object.prototype.hasOwnProperty.call(schema, "default")) {
        normalized[name] = structuredClone(schema.default);
      } else {
        delete normalized[name];
      }
    }
    if (!Object.prototype.hasOwnProperty.call(normalized, name)) continue;

    const result = SchemaValidator.validate(
      normalized[name],
      schema as unknown as Record<string, unknown>,
    );
    if (!result.isValid) {
      throw new ValidationError(`Invalid declared variable '${name}' at ${boundary}`, {
        validationContext: {
          schema,
          input: normalized[name],
          errors: result.errors || ["Registry validation failed"],
        },
      });
    }
  }
  return normalized;
}
