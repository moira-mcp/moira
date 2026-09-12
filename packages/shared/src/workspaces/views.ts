import type { WorkspaceOperationRecord, WorkspaceResourceRecord } from "./resource-types.js";

/**
 * Sanitized workspace summary shared by the website and the MCP tools. It omits
 * connection and authorization generations, external owner/billing identifiers, the
 * operation marker, the provider resource name, claims and lifecycle capabilities.
 */
export interface WorkspaceSummaryView {
  workspace_id: string;
  provider: string;
  repository_id: string;
  repository: string;
  ref: string;
  machine: {
    name: string;
    display_name: string;
    operating_system: string;
    cpu_cores: number;
    memory_bytes: number;
    storage_bytes: number;
  };
  state: WorkspaceResourceRecord["state"];
  retention_policy: WorkspaceResourceRecord["retentionPolicy"];
  desired_state: WorkspaceResourceRecord["desiredState"];
  observed_state: WorkspaceResourceRecord["observedState"];
  generation: number;
  created_at: number;
  updated_at: number;
}

export function projectWorkspaceSummary(workspace: WorkspaceResourceRecord): WorkspaceSummaryView {
  return {
    workspace_id: workspace.id,
    provider: workspace.provider,
    repository_id: workspace.repositoryId,
    repository: workspace.repositoryFullName,
    ref: workspace.requestedRef,
    machine: {
      name: workspace.machine.name,
      display_name: workspace.machine.displayName,
      operating_system: workspace.machine.operatingSystem,
      cpu_cores: workspace.machine.cpuCores,
      memory_bytes: workspace.machine.memoryBytes,
      storage_bytes: workspace.machine.storageBytes,
    },
    state: workspace.state,
    retention_policy: workspace.retentionPolicy,
    desired_state: workspace.desiredState,
    observed_state: workspace.observedState,
    generation: workspace.generation,
    created_at: workspace.createdAt,
    updated_at: workspace.updatedAt,
  };
}

/** Metadata-only projection of one durable operation for website activity views. */
export interface WorkspaceOperationSummaryView {
  operation_id: string;
  workspace_id: string;
  kind: WorkspaceOperationRecord["kind"];
  state: WorkspaceOperationRecord["state"];
  input_bytes: number;
  output_bytes: number;
  exit_code: number | null;
  deadline_at: number;
  result_expires_at: number | null;
  created_at: number;
  updated_at: number;
}

export function projectWorkspaceOperationSummary(
  operation: WorkspaceOperationRecord,
): WorkspaceOperationSummaryView {
  return {
    operation_id: operation.id,
    workspace_id: operation.resourceId,
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

export type WorkspaceControlScope = "global" | `provider:${string}`;

/** Durable emergency control as shown to administrators. */
export interface WorkspaceControlView {
  scope: WorkspaceControlScope;
  disabled: boolean;
  reason: string | null;
  updated_at: number | null;
}

/**
 * The one rule every health surface applies: a disabled or administrator-stopped
 * feature is healthy, while invalid configuration or an unreachable connector degrades
 * the instance.
 */
export function isWorkspaceReadinessDegraded(
  readiness: Pick<WorkspaceReadinessView, "state">,
): boolean {
  return readiness.state === "misconfigured" || readiness.state === "connector_unavailable";
}

/**
 * What unauthenticated liveness surfaces may reveal: the readiness state, the
 * provider and whether it degrades the instance. Control reasons, backlog and capacity
 * figures stay on authenticated surfaces.
 */
export interface WorkspacePublicReadinessView {
  state: WorkspaceReadinessState;
  provider: string;
  degraded: boolean;
}

export function projectPublicWorkspaceReadiness(
  readiness: Pick<WorkspaceReadinessView, "state" | "provider">,
): WorkspacePublicReadinessView {
  return {
    state: readiness.state,
    provider: readiness.provider,
    degraded: isWorkspaceReadinessDegraded(readiness),
  };
}

export type WorkspaceReadinessState =
  "disabled" | "misconfigured" | "control_disabled" | "connector_unavailable" | "ready";

/**
 * One instance-level readiness decision shared by the website, administration,
 * backend health and MCP surfaces. It contains no user, workspace or operation
 * identifiers.
 */
export interface WorkspaceReadinessView {
  state: WorkspaceReadinessState;
  reason: string | null;
  provider: string;
  configuration: "absent" | "invalid" | "available";
  resources_enabled: boolean;
  controls: WorkspaceControlView[];
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
