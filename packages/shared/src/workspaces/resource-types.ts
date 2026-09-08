export const WORKSPACE_PROVIDER_CONTRACT_VERSION = 2 as const;

export interface WorkspaceRepositoryTarget {
  id: string;
  fullName: string;
  private: boolean;
}

export type WorkspaceResourceState =
  | "create_pending"
  | "create_submitted"
  | "usable"
  | "start_pending"
  | "stop_pending"
  | "stopped"
  | "delete_pending"
  | "cleanup_pending"
  | "deleted"
  | "rejected"
  | "ambiguous";

export type WorkspaceProviderHealthState =
  "disabled" | "misconfigured" | "unavailable" | "available";

export interface WorkspaceMachine {
  name: string;
  displayName: string;
  operatingSystem: string;
  cpuCores: number;
  memoryBytes: number;
  storageBytes: number;
}

export interface WorkspaceProviderResource {
  name: string;
  displayName: string;
  ownerId: string;
  billableOwnerId: string;
  repositoryId: string;
  repositoryFullName: string;
  ref: string;
  state: "provisioning" | "available" | "shutdown" | "deleting" | "failed";
  machine: WorkspaceMachine | null;
  createdAt: number;
}

export type WorkspaceCreateProviderResult =
  | { outcome: "accepted"; resource: WorkspaceProviderResource | null }
  | { outcome: "rejected"; reason: string };

export interface WorkspaceProviderAdapter {
  readonly id: string;
  readonly contractVersion: typeof WORKSPACE_PROVIDER_CONTRACT_VERSION;
  readonly capabilities: Readonly<{
    disposable: boolean;
    persistent: boolean;
    exactLifecycle: boolean;
    personalBillingOnly: boolean;
    connector: string;
  }>;
  health(): Promise<{ state: WorkspaceProviderHealthState; reason: string | null }>;
  getIdentity(credential: string): Promise<{ id: string; login: string }>;
  listMachines(
    credential: string,
    repository: WorkspaceRepositoryTarget,
  ): Promise<WorkspaceMachine[]>;
  create(
    credential: string,
    input: {
      repository: WorkspaceRepositoryTarget;
      ref: string;
      machine: WorkspaceMachine;
      operationMarker: string;
      idleTimeoutMinutes: number;
      retentionMinutes: number;
    },
  ): Promise<WorkspaceCreateProviderResult>;
  listOwned(credential: string): Promise<WorkspaceProviderResource[]>;
  getExact(credential: string, resourceName: string): Promise<WorkspaceProviderResource | null>;
  startExact(credential: string, resourceName: string): Promise<"accepted" | "absent">;
  stopExact(credential: string, resourceName: string): Promise<"accepted" | "absent">;
  deleteExact(credential: string, resourceName: string): Promise<"accepted" | "absent">;
  probeConnector(credential: string, resourceName: string): Promise<void>;
}

export interface WorkspaceResourcePolicy {
  enabled: boolean;
  maxCpuCores: number;
  maxMemoryBytes: number;
  maxStorageBytes: number;
  maxActivePerUser: number;
  maxActiveGlobal: number;
  maxOperationsPerDay: number;
  createThrottleMs: number;
  remoteTtlMs: number;
  persistentRetentionMs?: number;
  createDeadlineMs: number;
  cleanupDeadlineMs: number;
  claimLeaseMs: number;
  reconcileIntervalMs: number;
  maxConcurrentOperationsPerUser?: number;
  maxConcurrentOperationsGlobal?: number;
  maxOperationInputBytes?: number;
  maxOperationStdoutBytes?: number;
  maxOperationStderrBytes?: number;
  maxOperationMs?: number;
}

export interface WorkspaceResourceRecord {
  id: string;
  userId: string;
  connectionId: string;
  authorizationGeneration: number;
  provider: string;
  repositoryId: string;
  repositoryFullName: string;
  requestedRef: string;
  operationMarker: string;
  providerResourceName: string | null;
  externalOwnerId: string | null;
  billableOwnerId: string | null;
  machine: WorkspaceMachine;
  state: WorkspaceResourceState;
  retentionPolicy: "legacy_disposable" | "persistent";
  desiredState: "running" | "stopped" | "deleted";
  observedState:
    "unknown" | "provisioning" | "running" | "stopped" | "deleting" | "absent" | "failed";
  generation: number;
  createDeadlineAt: number;
  remoteExpiresAt: number;
  cleanupDeadlineAt: number | null;
  claimId: string | null;
  claimExpiresAt: number | null;
  lastOutcome: string | null;
  createdAt: number;
  updatedAt: number;
}

export type WorkspaceResourceErrorCode =
  | "WORKSPACE_PROVIDER_DISABLED"
  | "WORKSPACE_PROVIDER_UNAVAILABLE"
  | "WORKSPACE_POLICY_LIMIT"
  | "WORKSPACE_CREATE_REJECTED"
  | "WORKSPACE_CREATE_PENDING"
  | "WORKSPACE_NOT_RUNNING"
  | "WORKSPACE_GENERATION_CONFLICT"
  | "WORKSPACE_RESOURCE_INVALID"
  | "WORKSPACE_NOT_FOUND";

export type WorkspaceOperationState =
  | "reserved"
  | "running"
  | "cancel_pending"
  | "reconcile_pending"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "timed_out";

export interface WorkspaceOperationRecord {
  id: string;
  userId: string;
  resourceId: string;
  resourceGeneration: number;
  authorizationGeneration: number;
  provider: string;
  providerResourceName: string;
  remoteMarker: string;
  kind: "exec";
  state: WorkspaceOperationState;
  inputBytes: number;
  stdoutLimitBytes: number;
  stderrLimitBytes: number;
  outputBytes: number;
  exitCode: number | null;
  remoteCleanupPending: 0 | 1;
  resultExpiresAt: number | null;
  deadlineAt: number;
  claimId: string | null;
  claimExpiresAt: number | null;
  lastOutcome: string | null;
  createdAt: number;
  updatedAt: number;
}

export type WorkspaceByteSource =
  | { kind: "inline"; bytes: Uint8Array }
  | { kind: "reference"; referenceId: string; declaredBytes: number };

export interface WorkspaceExecRequest {
  argv: readonly string[];
  cwd: string;
  stdin: WorkspaceByteSource;
  timeoutMs: number;
  maxStdoutBytes?: number;
  maxStderrBytes?: number;
}

export interface WorkspaceOperationResult {
  state: "succeeded" | "failed" | "cancelled" | "timed_out";
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

export interface WorkspaceOperationResponse {
  operation: WorkspaceOperationRecord;
  result: WorkspaceOperationResult | null;
}

export interface WorkspaceOperationTransport {
  execute(
    credential: string,
    workspace: WorkspaceResourceRecord,
    operation: WorkspaceOperationRecord,
    request: WorkspaceExecRequest,
  ): Promise<WorkspaceOperationResult | { state: "running" }>;
  inspect(
    credential: string,
    workspace: WorkspaceResourceRecord,
    operation: WorkspaceOperationRecord,
  ): Promise<WorkspaceOperationResult | { state: "running" } | { state: "absent" }>;
  cancel(
    credential: string,
    workspace: WorkspaceResourceRecord,
    operation: WorkspaceOperationRecord,
  ): Promise<WorkspaceOperationResult | { state: "running" } | { state: "absent" }>;
  finalize(
    credential: string,
    workspace: WorkspaceResourceRecord,
    operation: WorkspaceOperationRecord,
  ): Promise<void>;
}

export class WorkspaceResourceError extends Error {
  constructor(
    public readonly code: WorkspaceResourceErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "WorkspaceResourceError";
  }
}
