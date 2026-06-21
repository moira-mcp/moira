/**
 * registry-converter — pure conversion of a workflow's legacy start-node
 * `initialData.variables` into the new global `variableRegistry`.
 *
 * Used by the production-workflow migration (Step 5) and reusable by tooling.
 * The conversion is idempotent: a workflow that already has a `variableRegistry`
 * is returned unchanged.
 */
import type { VariableRegistry, RegistryVariable } from "../types/graph-nodes.js";

/** Infer the JSON-Schema primitive type name from a default value. */
export function inferRegistryType(value: unknown): RegistryVariable["type"] {
  if (value === null || value === undefined) return "null";
  if (Array.isArray(value)) return "array";
  switch (typeof value) {
    case "string":
      return "string";
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    case "object":
      return "object";
    default:
      return "string";
  }
}

interface LegacyVariableDef {
  description?: string;
  value?: unknown;
}

interface WorkflowLike {
  variableRegistry?: VariableRegistry;
  nodes?: Array<{
    type?: string;
    initialData?: { variables?: Record<string, LegacyVariableDef> };
  }>;
}

export interface ConvertResult<T> {
  /** The (possibly) updated workflow. */
  workflow: T;
  /** True if a registry was created/updated by this call. */
  changed: boolean;
  /** Number of variables placed into the registry. */
  variableCount: number;
}

/**
 * Build a `variableRegistry` from a workflow's start-node `initialData.variables`.
 *
 * - Idempotent: if the workflow already has a `variableRegistry`, returns it unchanged
 *   (changed=false).
 * - Missing-tolerant: a workflow without a start node or without initialData.variables
 *   yields an empty registry (changed=true only if a registry field is added).
 * - The original `initialData.variables` are left intact (the engine still reads them
 *   during the transition; final cleanup happens in a later step).
 */
export function convertWorkflowToRegistry<T extends WorkflowLike>(workflow: T): ConvertResult<T> {
  if (!workflow || typeof workflow !== "object") {
    return { workflow, changed: false, variableCount: 0 };
  }

  // Idempotent: already migrated.
  if (workflow.variableRegistry && typeof workflow.variableRegistry === "object") {
    return {
      workflow,
      changed: false,
      variableCount: Object.keys(workflow.variableRegistry).length,
    };
  }

  const startNode = workflow.nodes?.find((n) => n?.type === "start");
  const legacyVars = startNode?.initialData?.variables;

  const registry: VariableRegistry = {};
  if (legacyVars && typeof legacyVars === "object") {
    for (const [name, def] of Object.entries(legacyVars)) {
      const description = typeof def?.description === "string" ? def.description : "";
      const entry: RegistryVariable = {
        type: inferRegistryType(def?.value),
        description,
      };
      if (def?.value !== undefined) {
        entry.default = def.value;
      }
      registry[name] = entry;
    }
  }

  return {
    workflow: { ...workflow, variableRegistry: registry },
    changed: true,
    variableCount: Object.keys(registry).length,
  };
}
