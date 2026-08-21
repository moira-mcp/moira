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

export const ORDERED_UNIQUE_REFERENCES_KEYWORD = "xOrderedUniqueReferences";
export const EVIDENCE_BOUNDARY_KEYWORD = "xEvidenceBoundary";
export const PRESERVE_PLAN_PREFIX_KEYWORD = "xPreservePlanPrefix";
export const CONTEXT_PATH_SUFFIXES_KEYWORD = "xContextPathSuffixes";

/** Register the reusable cross-item contract for ordered plans. */
export function registerWorkflowSchemaKeywords(instance: {
  addKeyword(definition: Record<string, unknown>): unknown;
}): void {
  instance.addKeyword({
    keyword: ORDERED_UNIQUE_REFERENCES_KEYWORD,
    type: "array",
    schemaType: "object",
    errors: true,
    compile(schema: unknown) {
      const config = schema as { idProperty?: unknown; referencesProperty?: unknown };
      const idProperty = config.idProperty;
      const referencesProperty = config.referencesProperty;
      if (typeof idProperty !== "string" || typeof referencesProperty !== "string") {
        throw new Error(
          `${ORDERED_UNIQUE_REFERENCES_KEYWORD} requires string idProperty and referencesProperty`,
        );
      }

      const validate = (data: unknown): boolean => {
        if (!Array.isArray(data)) return true;
        const seen = new Set<string>();
        for (let index = 0; index < data.length; index += 1) {
          const item = data[index];
          if (!item || typeof item !== "object" || Array.isArray(item)) continue;
          const record = item as Record<string, unknown>;
          const id = record[idProperty];
          if (typeof id !== "string") continue;
          if (seen.has(id)) {
            (validate as { errors?: unknown[] }).errors = [
              {
                keyword: ORDERED_UNIQUE_REFERENCES_KEYWORD,
                instancePath: `/${index}/${idProperty}`,
                schema,
                params: { duplicateId: id },
                message: `must be unique; duplicate identity ${JSON.stringify(id)}`,
              },
            ];
            return false;
          }
          const references = record[referencesProperty];
          if (Array.isArray(references)) {
            for (const reference of references) {
              if (typeof reference === "string" && !seen.has(reference)) {
                (validate as { errors?: unknown[] }).errors = [
                  {
                    keyword: ORDERED_UNIQUE_REFERENCES_KEYWORD,
                    instancePath: `/${index}/${referencesProperty}`,
                    schema,
                    params: { invalidReference: reference },
                    message: `must reference an earlier identity; got ${JSON.stringify(reference)}`,
                  },
                ];
                return false;
              }
            }
          }
          seen.add(id);
        }
        (validate as { errors?: unknown[] }).errors = undefined;
        return true;
      };
      return validate;
    },
  });
  instance.addKeyword({
    keyword: EVIDENCE_BOUNDARY_KEYWORD,
    schemaType: "object",
    valid: true,
  });
  instance.addKeyword({
    keyword: PRESERVE_PLAN_PREFIX_KEYWORD,
    schemaType: "object",
    valid: true,
  });
  instance.addKeyword({
    keyword: CONTEXT_PATH_SUFFIXES_KEYWORD,
    schemaType: "object",
    valid: true,
  });
}

registerWorkflowSchemaKeywords(ajv);

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
    context?: Record<string, unknown>,
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

      const contextualError = SchemaValidator.validateEvidenceBoundary(data, schema, context);
      if (contextualError) {
        return { isValid: false, errors: [contextualError] };
      }
      const prefixError = SchemaValidator.validatePlanPrefix(data, schema, context);
      if (prefixError) {
        return { isValid: false, errors: [prefixError] };
      }
      const pathError = SchemaValidator.validateContextPathSuffixes(data, schema, context);
      if (pathError) {
        return { isValid: false, errors: [pathError] };
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

  private static validateEvidenceBoundary(
    data: unknown,
    schema: Record<string, unknown>,
    context?: Record<string, unknown>,
  ): string | undefined {
    const rawConfig = schema[EVIDENCE_BOUNDARY_KEYWORD];
    if (!rawConfig || typeof rawConfig !== "object" || Array.isArray(rawConfig)) return undefined;
    if (!data || typeof data !== "object" || Array.isArray(data)) return undefined;

    const config = rawConfig as Record<string, unknown>;
    const response = data as Record<string, unknown>;
    const reachProperty = String(config.reachProperty ?? "final_repair_reach");
    const boundaryProperty = String(config.boundaryProperty ?? "repair_from");
    const planProperty = String(config.planProperty ?? "steps");
    const ledgerProperty = String(config.ledgerProperty ?? "evidence_ledger");
    const workReach = String(config.workReach ?? "work");
    const checkedReaches = Array.isArray(config.checkedReaches)
      ? new Set(config.checkedReaches.filter((value): value is string => typeof value === "string"))
      : new Set(["task", "plan", workReach]);
    const reach = response[reachProperty];
    if (typeof reach !== "string" || !checkedReaches.has(reach)) return undefined;

    const boundary = response[boundaryProperty];
    const ledger = response[ledgerProperty];
    const plan = Array.isArray(response[planProperty])
      ? response[planProperty]
      : context?.[planProperty];
    if (!Number.isInteger(boundary) || !Array.isArray(ledger) || !Array.isArray(plan)) {
      return `VALIDATION ERROR: ${EVIDENCE_BOUNDARY_KEYWORD} requires integer '${boundaryProperty}', array '${ledgerProperty}', and an available '${planProperty}' plan.`;
    }

    const numericBoundary = boundary as number;
    const expectedLength = reach === workReach ? numericBoundary + 1 : numericBoundary;
    if (numericBoundary < 0 || numericBoundary > plan.length || ledger.length !== expectedLength) {
      return `VALIDATION ERROR: '${ledgerProperty}' must contain exactly ${expectedLength} ordered record(s) for '${reach}' at ${boundaryProperty}=${numericBoundary}; got ${ledger.length}.`;
    }

    const seen = new Set<string>();
    const contextPlan = context?.[planProperty];
    const contextLedger = context?.[ledgerProperty];
    if (!Array.isArray(contextPlan) || !Array.isArray(contextLedger)) {
      return `VALIDATION ERROR: ${EVIDENCE_BOUNDARY_KEYWORD} requires current context arrays '${planProperty}' and '${ledgerProperty}'.`;
    }
    for (let index = 0; index < ledger.length; index += 1) {
      const planItem = plan[index] as Record<string, unknown> | undefined;
      const record = ledger[index] as Record<string, unknown> | undefined;
      const expectedId = planItem?.id;
      const itemId = record?.item_id;
      if (typeof expectedId !== "string" || itemId !== expectedId || seen.has(itemId as string)) {
        return `VALIDATION ERROR: '${ledgerProperty}' record ${index} must uniquely match plan item ${JSON.stringify(expectedId)} in order.`;
      }
      seen.add(itemId as string);
      if (index < numericBoundary) {
        if (!SchemaValidator.deepEqual(plan[index], contextPlan[index])) {
          return `VALIDATION ERROR: protected plan prefix item ${index} differs from current context.`;
        }
        if (!SchemaValidator.deepEqual(record, contextLedger[index])) {
          return `VALIDATION ERROR: protected evidence prefix record ${index} differs from current context.`;
        }
      }
      if (index === numericBoundary && reach === workReach && record?.status !== "verified") {
        return `VALIDATION ERROR: corrected work record at ${boundaryProperty}=${numericBoundary} must have status 'verified' before independent item review.`;
      }
    }
    return undefined;
  }

  private static validatePlanPrefix(
    data: unknown,
    schema: Record<string, unknown>,
    context?: Record<string, unknown>,
  ): string | undefined {
    const rawConfig = schema[PRESERVE_PLAN_PREFIX_KEYWORD];
    if (!rawConfig || typeof rawConfig !== "object" || Array.isArray(rawConfig)) return undefined;
    if (!data || typeof data !== "object" || Array.isArray(data)) return undefined;
    const config = rawConfig as Record<string, unknown>;
    const planProperty = String(config.planProperty ?? "steps");
    const boundaryProperty = String(config.boundaryContextProperty ?? "current_step");
    const responsePlan = (data as Record<string, unknown>)[planProperty];
    // A response that does not carry the plan cannot mutate its protected prefix.
    // Variant schemas remain responsible for requiring the plan when a route edits it.
    if (responsePlan === undefined) return undefined;
    const currentPlan = context?.[planProperty];
    const boundary = context?.[boundaryProperty];
    if (
      !Array.isArray(responsePlan) ||
      !Array.isArray(currentPlan) ||
      !Number.isInteger(boundary)
    ) {
      return `VALIDATION ERROR: ${PRESERVE_PLAN_PREFIX_KEYWORD} requires response plan '${planProperty}', current plan, and integer context '${boundaryProperty}'.`;
    }
    const prefixLength = boundary as number;
    if (
      prefixLength < 0 ||
      responsePlan.length < prefixLength ||
      currentPlan.length < prefixLength
    ) {
      return `VALIDATION ERROR: replacement plan must retain the complete ${prefixLength}-item protected prefix.`;
    }
    for (let index = 0; index < prefixLength; index += 1) {
      if (!SchemaValidator.deepEqual(responsePlan[index], currentPlan[index])) {
        return `VALIDATION ERROR: protected plan prefix item ${index} differs from current context.`;
      }
    }
    return undefined;
  }

  private static validateContextPathSuffixes(
    data: unknown,
    schema: Record<string, unknown>,
    context?: Record<string, unknown>,
  ): string | undefined {
    const rawConfig = schema[CONTEXT_PATH_SUFFIXES_KEYWORD];
    if (!rawConfig || typeof rawConfig !== "object" || Array.isArray(rawConfig)) return undefined;
    if (!data || typeof data !== "object" || Array.isArray(data)) return undefined;

    const config = rawConfig as Record<string, unknown>;
    const baseContextProperty = config.baseContextProperty;
    const rawProperties = config.properties;
    if (
      typeof baseContextProperty !== "string" ||
      !rawProperties ||
      typeof rawProperties !== "object" ||
      Array.isArray(rawProperties)
    ) {
      return `VALIDATION ERROR: ${CONTEXT_PATH_SUFFIXES_KEYWORD} requires string 'baseContextProperty' and object 'properties'.`;
    }

    const rawBase = context?.[baseContextProperty];
    if (typeof rawBase !== "string") {
      return `VALIDATION ERROR: ${CONTEXT_PATH_SUFFIXES_KEYWORD} requires string context '${baseContextProperty}'.`;
    }
    const executionId = context?.executionId;
    const workflowId = context?.workflowId;
    const base = rawBase
      .replaceAll("{{executionId}}", typeof executionId === "string" ? executionId : "")
      .replaceAll("{{workflowId}}", typeof workflowId === "string" ? workflowId : "")
      .replace(/\/$/, "");
    if (base.includes("{{") || base.includes("}}")) {
      return `VALIDATION ERROR: ${CONTEXT_PATH_SUFFIXES_KEYWORD} could not resolve context '${baseContextProperty}'.`;
    }

    const response = data as Record<string, unknown>;
    for (const [property, rawSuffix] of Object.entries(rawProperties as Record<string, unknown>)) {
      if (typeof rawSuffix !== "string" || !rawSuffix.startsWith("/")) {
        return `VALIDATION ERROR: ${CONTEXT_PATH_SUFFIXES_KEYWORD} property '${property}' requires an absolute path suffix beginning with '/'.`;
      }
      const expected = `${base}${rawSuffix}`;
      if (response[property] !== expected) {
        return `VALIDATION ERROR: Field '${property}' must equal the current execution path ${JSON.stringify(expected)}.`;
      }
    }
    return undefined;
  }

  private static deepEqual(left: unknown, right: unknown): boolean {
    if (Object.is(left, right)) return true;
    if (Array.isArray(left) || Array.isArray(right)) {
      if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length)
        return false;
      return left.every((value, index) => SchemaValidator.deepEqual(value, right[index]));
    }
    if (!left || !right || typeof left !== "object" || typeof right !== "object") return false;
    const leftRecord = left as Record<string, unknown>;
    const rightRecord = right as Record<string, unknown>;
    const leftKeys = Object.keys(leftRecord).sort();
    const rightKeys = Object.keys(rightRecord).sort();
    if (!SchemaValidator.deepEqual(leftKeys, rightKeys)) return false;
    return leftKeys.every((key) => SchemaValidator.deepEqual(leftRecord[key], rightRecord[key]));
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
   * Includes schema description, specific errors, and the required corrective action.
   * Rejected payloads are deliberately never echoed.
   * This format is designed to be clear even for simpler models (Haiku, GPT-3.5)
   *
   * @param schema The JSON Schema that was used for validation
   * @param _userInput Rejected input (accepted for call-site compatibility, never rendered)
   * @param errors List of specific validation error messages
   * @returns Comprehensive error message for agent
   */
  static formatValidationErrorForAgent(
    schema: Record<string, unknown> | undefined,
    _userInput: unknown,
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
