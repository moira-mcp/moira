import { effectiveCodespaceLimits } from "./resource-policy.js";
import type {
  CodespaceOperationRecord,
  CodespaceResourcePolicy,
  CodespaceResourceRecord,
} from "./resource-types.js";

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

/**
 * One user's codespace limits beside their current use, as both the website and the MCP `list`
 * result present them. Every limit is the value Moira enforces (see `effectiveCodespaceLimits`);
 * usage counts only this user's own codespaces, operations and transfers, except the instance-wide
 * codespace count the instance ceiling is measured against, which readiness already reports.
 */
export interface CodespaceLimitsView {
  codespaces: {
    /** Codespaces the user holds; stopped ones and ones still being created or cleaned up count. */
    held: number;
    max_per_user: number;
    instance_held: number;
    max_instance: number;
    create_throttle_seconds: number;
  };
  machine_ceiling: { cpu_cores: number; memory_bytes: number; storage_bytes: number };
  operations: {
    active: number;
    max_concurrent_per_user: number;
    max_input_bytes: number;
    max_stdout_bytes: number;
    max_stderr_bytes: number;
    max_retained_output_bytes: number;
    max_duration_seconds: number;
    max_background_seconds: number;
  };
  transfers: {
    used_bytes: number;
    objects: number;
    /** Bytes of transfers still being reserved or claimed. */
    inflight_bytes: number;
    max_bytes_per_user: number;
    max_inflight_bytes_per_user: number;
    max_objects_per_user: number;
    max_file_bytes: number;
    ttl_seconds: number;
  };
  lifecycle: {
    retention_days: number;
    start_wait_seconds: number;
    idle: { auto_stop_enabled: boolean; timeout_minutes: number; provider_max_minutes: number };
  };
  /** What the provider reveals about its own quota and billing; GitHub reveals nothing to Moira. */
  provider: { billing: "unavailable" };
}

export function projectCodespaceLimits(input: {
  policy: CodespaceResourcePolicy;
  held: number;
  instanceHeld: number;
  activeOperations: number;
  transfers: { objects: number; bytes: number; inflightBytes: number };
  idle: { autoStopEnabled: boolean; idleTimeoutMinutes: number };
  providerIdleMaxMinutes: number;
}): CodespaceLimitsView {
  const { policy } = input;
  const limits = effectiveCodespaceLimits(policy);
  const seconds = (milliseconds: number) => Math.floor(milliseconds / 1000);
  return {
    codespaces: {
      held: input.held,
      max_per_user: policy.maxActivePerUser,
      instance_held: input.instanceHeld,
      max_instance: policy.maxActiveGlobal,
      create_throttle_seconds: seconds(policy.createThrottleMs),
    },
    machine_ceiling: {
      cpu_cores: policy.maxCpuCores,
      memory_bytes: policy.maxMemoryBytes,
      storage_bytes: policy.maxStorageBytes,
    },
    operations: {
      active: input.activeOperations,
      max_concurrent_per_user: limits.operations.maxConcurrentPerUser,
      max_input_bytes: limits.operations.maxInputBytes,
      max_stdout_bytes: limits.operations.maxStdoutBytes,
      max_stderr_bytes: limits.operations.maxStderrBytes,
      max_retained_output_bytes: limits.operations.maxRetainedOutputBytes,
      max_duration_seconds: seconds(limits.operations.maxDurationMs),
      max_background_seconds: seconds(limits.operations.maxBackgroundMs),
    },
    transfers: {
      used_bytes: input.transfers.bytes,
      objects: input.transfers.objects,
      inflight_bytes: input.transfers.inflightBytes,
      max_bytes_per_user: limits.transfers.maxBytesPerUser,
      max_inflight_bytes_per_user: limits.transfers.maxInflightBytesPerUser,
      max_objects_per_user: limits.transfers.maxObjectsPerUser,
      max_file_bytes: limits.transfers.maxFileBytes,
      ttl_seconds: seconds(limits.transfers.ttlMs),
    },
    lifecycle: {
      retention_days: Math.floor(limits.persistentRetentionMs / (24 * 60 * 60_000)),
      start_wait_seconds: seconds(policy.startWaitMs),
      idle: {
        auto_stop_enabled: input.idle.autoStopEnabled,
        timeout_minutes: input.idle.idleTimeoutMinutes,
        provider_max_minutes: input.providerIdleMaxMinutes,
      },
    },
    provider: { billing: "unavailable" },
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
    max_active_operations: number;
    transfer_live_bytes: number;
    max_transfer_live_bytes: number;
  };
  checked_at: number;
}
