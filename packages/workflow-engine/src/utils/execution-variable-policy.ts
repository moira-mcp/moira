import { ConflictError, ValidationError } from "@mcp-moira/shared";
import type { WorkflowGraph } from "../interfaces/core-interfaces.js";
import type { WorkflowExecution } from "../types/base-types.js";
import { PathResolver } from "./path-resolver.js";
import { validateDeclaredRegistryValues } from "./registry-value-validator.js";

export interface ExecutionVariableFilters {
  names?: string[];
  search?: string;
  types?: string[];
  editable?: boolean;
  hasValue?: boolean;
  writePhase?: "current" | "other";
}

export function queryExecutionVariables(
  execution: WorkflowExecution,
  graph: WorkflowGraph,
  filters: ExecutionVariableFilters = {},
) {
  const registry = graph.variableRegistry ?? {};
  const policy = graph.runtimePolicy?.externalVariableWrites ?? {};
  const requested = new Set(filters.names ?? []);
  const search = filters.search?.toLowerCase();
  const variables = Object.entries(registry)
    .map(([name, schema]) => {
      const hasValue = Object.prototype.hasOwnProperty.call(
        execution.globalContext.variables,
        name,
      );
      const rule = policy[name];
      const phaseAllowed =
        !!rule &&
        (!rule.allowedNodeIds || rule.allowedNodeIds.includes(execution.currentNodeId ?? ""));
      const editable =
        execution.status === "running" &&
        execution.waitingForInputNodeId === execution.currentNodeId &&
        phaseAllowed;
      return {
        name,
        description: schema.description,
        type: schema.type,
        schema,
        hasValue,
        value: hasValue ? execution.globalContext.variables[name] : undefined,
        editable,
        externalWritePolicy: rule ?? null,
        writePhase: editable ? "current" : rule && !phaseAllowed ? "other" : null,
        denialReason: editable
          ? null
          : !rule
            ? "policy_denied"
            : !phaseAllowed
              ? "phase_denied"
              : "execution_not_paused",
      };
    })
    .filter(
      (item) =>
        (!requested.size || requested.has(item.name)) &&
        (!search ||
          item.name.toLowerCase().includes(search) ||
          item.description.toLowerCase().includes(search)) &&
        (!filters.types?.length || filters.types.includes(item.type)) &&
        (filters.editable === undefined || item.editable === filters.editable) &&
        (filters.hasValue === undefined || item.hasValue === filters.hasValue) &&
        (!filters.writePhase || item.writePhase === filters.writePhase),
    )
    .sort((a, b) => a.name.localeCompare(b.name));
  return {
    variables,
    unknownNames: [...requested].filter((name) => !(name in registry)),
    revision: execution.revision,
    appliedFilters: filters,
  };
}

export function prepareExecutionVariableWrite(
  execution: WorkflowExecution,
  graph: WorkflowGraph,
  name: string,
  value: unknown,
  expectedRevision: number,
): WorkflowExecution {
  assertExecutionVariableWriteAllowed(execution, graph, name, expectedRevision);
  const registry = graph.variableRegistry!;
  validateDeclaredRegistryValues({ [name]: value }, registry, "execution.set-variable", true);
  const updated = structuredClone(execution);
  updated.globalContext.variables[name] = value;
  updated.updatedAt = Date.now();
  return updated;
}

function assertExecutionVariableWriteAllowed(
  execution: WorkflowExecution,
  graph: WorkflowGraph,
  name: string,
  expectedRevision: number,
): void {
  if (execution.status !== "running" || execution.waitingForInputNodeId !== execution.currentNodeId)
    throw new ValidationError("Execution must be running and paused");
  const registry = graph.variableRegistry;
  const rule = graph.runtimePolicy?.externalVariableWrites?.[name];
  if (
    !registry?.[name] ||
    !rule ||
    (rule.allowedNodeIds && !rule.allowedNodeIds.includes(execution.currentNodeId ?? ""))
  )
    throw new ValidationError("Variable is not externally editable at this step");
  if (execution.revision !== expectedRevision)
    throw new ConflictError("Execution revision is stale");
}

export function prepareExecutionVariablePathWrite(
  execution: WorkflowExecution,
  graph: WorkflowGraph,
  path: Array<string | number>,
  value: unknown,
  expectedRevision: number,
): WorkflowExecution {
  if (path.length === 0 || typeof path[0] !== "string")
    throw new ValidationError("Variable path must start with a declared variable name");
  const forbidden = new Set(["__proto__", "constructor", "prototype"]);
  if (path.some((segment) => typeof segment === "string" && forbidden.has(segment)))
    throw new ValidationError("Variable path contains a forbidden segment");

  const name = path[0];
  assertExecutionVariableWriteAllowed(execution, graph, name, expectedRevision);
  const updated = structuredClone(execution);
  const pathText = path
    .map((segment, index) =>
      typeof segment === "number" ? `[${segment}]` : index === 0 ? segment : `.${segment}`,
    )
    .join("");
  PathResolver.setVariablePath(updated.globalContext.variables, pathText, value);
  validateDeclaredRegistryValues(
    { [name]: updated.globalContext.variables[name] },
    graph.variableRegistry!,
    "execution.set-variable-path",
    true,
  );
  updated.updatedAt = Date.now();
  return updated;
}
