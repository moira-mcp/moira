import type { CodespaceOperationRecord, CodespaceResourceRecord } from "./resource-types.js";

/**
 * Sanitized codespace summary shared by the website and the MCP tools. It omits
 * connection and authorization generations, external owner/billing identifiers, the
 * operation marker, the provider resource name, claims and lifecycle capabilities.
 */
export interface CodespaceSummaryView {
  codespace_id: string;
  provider: string;
  repository_id: string;
  repository: string;
  /** The ref the codespace was created on. */
  requested_ref: string;
  /**
   * The ref the provider last reported checked out, which changes when an agent switches branches;
   * `null` until Moira has observed it or while the codespace is on a detached HEAD.
   */
  current_ref: string | null;
  machine: {
    name: string;
    display_name: string;
    operating_system: string;
    cpu_cores: number;
    memory_bytes: number;
    storage_bytes: number;
  };
  state: CodespaceResourceRecord["state"];
  retention_policy: CodespaceResourceRecord["retentionPolicy"];
  desired_state: CodespaceResourceRecord["desiredState"];
  observed_state: CodespaceResourceRecord["observedState"];
  generation: number;
  created_at: number;
  updated_at: number;
}

export function projectCodespaceSummary(codespace: CodespaceResourceRecord): CodespaceSummaryView {
  return {
    codespace_id: codespace.id,
    provider: codespace.provider,
    repository_id: codespace.repositoryId,
    repository: codespace.repositoryFullName,
    requested_ref: codespace.requestedRef,
    current_ref: codespace.observedRef,
    machine: {
      name: codespace.machine.name,
      display_name: codespace.machine.displayName,
      operating_system: codespace.machine.operatingSystem,
      cpu_cores: codespace.machine.cpuCores,
      memory_bytes: codespace.machine.memoryBytes,
      storage_bytes: codespace.machine.storageBytes,
    },
    state: codespace.state,
    retention_policy: codespace.retentionPolicy,
    desired_state: codespace.desiredState,
    observed_state: codespace.observedState,
    generation: codespace.generation,
    created_at: codespace.createdAt,
    updated_at: codespace.updatedAt,
  };
}

/** Metadata-only projection of one durable operation for website activity views. */
export interface CodespaceOperationSummaryView {
  operation_id: string;
  codespace_id: string;
  kind: CodespaceOperationRecord["kind"];
  state: CodespaceOperationRecord["state"];
  input_bytes: number;
  output_bytes: number;
  exit_code: number | null;
  deadline_at: number;
  result_expires_at: number | null;
  created_at: number;
  updated_at: number;
}

export function projectCodespaceOperationSummary(
  operation: CodespaceOperationRecord,
): CodespaceOperationSummaryView {
  return {
    operation_id: operation.id,
    codespace_id: operation.resourceId,
    kind: operation.kind,
    state: operation.state,
    input_bytes: operation.inputBytes,
    output_bytes: operation.outputBytes,
    exit_code: operation.exitCode,
    deadline_at: operation.deadlineAt,
    result_expires_at: operation.resultExpiresAt,
    created_at: operation.createdAt,
    updated_at: operation.updatedAt,
  };
}

export type CodespaceControlScope = "global" | `provider:${string}`;

/** Durable emergency control as shown to administrators. */
export interface CodespaceControlView {
  scope: CodespaceControlScope;
  disabled: boolean;
  reason: string | null;
  updated_at: number | null;
}

/**
 * The one rule every health surface applies: a disabled or administrator-stopped
 * feature is healthy, while invalid configuration or an unreachable connector degrades
 * the instance.
 */
export function isCodespaceReadinessDegraded(
  readiness: Pick<CodespaceReadinessView, "state">,
): boolean {
  return readiness.state === "misconfigured" || readiness.state === "connector_unavailable";
}

/**
 * What unauthenticated liveness surfaces may reveal: the readiness state, the
 * provider and whether it degrades the instance. Control reasons, backlog and capacity
 * figures stay on authenticated surfaces.
 */
export interface CodespacePublicReadinessView {
  state: CodespaceReadinessState;
  provider: string;
  degraded: boolean;
}

export function projectPublicCodespaceReadiness(
  readiness: Pick<CodespaceReadinessView, "state" | "provider">,
): CodespacePublicReadinessView {
  return {
    state: readiness.state,
    provider: readiness.provider,
    degraded: isCodespaceReadinessDegraded(readiness),
  };
}

export type CodespaceReadinessState =
  "disabled" | "misconfigured" | "control_disabled" | "connector_unavailable" | "ready";

/**
 * One instance-level readiness decision shared by the website, administration,
 * backend health and MCP surfaces. It contains no user, codespace or operation
 * identifiers.
 */
export interface CodespaceReadinessView {
  state: CodespaceReadinessState;
  reason: string | null;
  provider: string;
  configuration: "absent" | "invalid" | "available";
  resources_enabled: boolean;
  controls: CodespaceControlView[];
  connector: { state: "available" | "unavailable" | "not_applicable"; reason: string | null };
  reconciliation: {
    due_resources: number;
    due_operations: number;
    oldest_due_age_ms: number | null;
  };
  usage: {
    active_resources: number;
    max_active_resources: number;
    active_operations: number;
    max_active_operations: number | null;
    transfer_live_bytes: number;
    max_transfer_live_bytes: number | null;
  };
  checked_at: number;
}
