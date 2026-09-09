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
  maxTransferFileBytes?: number;
  maxTransferBytesPerUser?: number;
  maxTransferBytesGlobal?: number;
  maxTransferObjectsPerUser?: number;
  maxTransferObjectsGlobal?: number;
  maxTransferInflightBytesPerUser?: number;
  maxTransferInflightBytesGlobal?: number;
  transferTtlMs?: number;
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
  kind: WorkspaceOperationKind;
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

export type WorkspaceOperationKind =
  "exec" | "stat" | "search" | "read" | "write" | "apply_patch" | "upload" | "download";

export type WorkspaceByteSource =
  | { kind: "inline"; bytes: Uint8Array }
  | {
      kind: "reference";
      referenceId: string;
      declaredBytes: number;
      declaredMimeType: string;
    };

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

export interface WorkspaceFileVersion {
  size: number;
  sha256: string;
  modifiedAt: number;
}

export interface WorkspaceFileStat {
  path: string;
  type: "file" | "directory";
  size: number;
  mode: number;
  modifiedAt: number;
  version: WorkspaceFileVersion | null;
}

export interface WorkspaceSearchMatch {
  path: string;
  line: number;
  column: number;
  preview: string;
}

export interface WorkspacePatchSummaryEntry {
  path: string;
  edits: number;
  insertedBytes: number;
  deletedBytes: number;
}

export interface WorkspacePatchSummary {
  filesChanged: number;
  editsApplied: number;
  insertedBytes: number;
  deletedBytes: number;
  entries: WorkspacePatchSummaryEntry[];
  truncated: boolean;
}

export type WorkspaceFileRequest =
  | { action: "stat"; path: string }
  | {
      action: "search";
      path: string;
      query: string;
      mode: "literal" | "regex";
      maxMatches: number;
      maxBytes: number;
    }
  | { action: "read"; path: string; offset: number; length: number }
  | {
      action: "write" | "upload";
      path: string;
      bytes: Uint8Array;
      expected: { exists: boolean; size?: number; sha256?: string };
    }
  | {
      action: "apply_patch";
      files: readonly {
        path: string;
        expected: { exists: boolean; size?: number; sha256?: string };
        edits: readonly { start: number; end: number; bytes: Uint8Array }[];
      }[];
    }
  | { action: "download"; path: string; maxBytes: number };

export type WorkspaceFileResult =
  | {
      action: Exclude<WorkspaceOperationKind, "exec">;
      state: "failed";
      code: "WORKSPACE_FILE_REJECTED";
    }
  | { action: "stat"; stat: WorkspaceFileStat }
  | { action: "search"; matches: WorkspaceSearchMatch[]; truncated: boolean }
  | {
      action: "read" | "download";
      path: string;
      offset: number;
      totalSize: number;
      bytes: Uint8Array;
      sha256: string;
    }
  | {
      action: "write" | "upload";
      path: string;
      previous: WorkspaceFileVersion | null;
      current: WorkspaceFileVersion;
    }
  | {
      action: "apply_patch";
      files: {
        path: string;
        previous: WorkspaceFileVersion | null;
        current: WorkspaceFileVersion;
      }[];
      summary: WorkspacePatchSummary;
    };

export interface WorkspaceFileOperationResponse {
  operation: WorkspaceOperationRecord;
  result: WorkspaceFileResult | null;
}

export interface WorkspaceFileTransport {
  executeFile(
    credential: string,
    workspace: WorkspaceResourceRecord,
    operation: WorkspaceOperationRecord,
    request: WorkspaceFileRequest,
  ): Promise<WorkspaceFileResult | { state: "running" }>;
  inspectFile(
    credential: string,
    workspace: WorkspaceResourceRecord,
    operation: WorkspaceOperationRecord,
  ): Promise<WorkspaceFileResult | { state: "running" } | { state: "absent" }>;
}

export interface WorkspaceNativeFileReference {
  fileId: string;
  downloadUrl: string;
  fileName: string;
  mimeType: string;
  declaredSize: number;
}

export interface WorkspaceTransferRecord {
  id: string;
  userId: string;
  purpose: "workspace_input" | "workspace_download";
  state: "reserved" | "ready" | "claimed" | "consumed";
  fileName: string;
  mimeType: string;
  declaredSize: number;
  observedSize: number | null;
  sha256: string | null;
  objectKey: string;
  ownerPid: number;
  ownerStartTime: string | null;
  claimId: string | null;
  claimExpiresAt: number | null;
  expiresAt: number;
  createdAt: number;
  updatedAt: number;
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
