export const CODESPACE_PROVIDER_CONTRACT_VERSION = 5 as const;

export interface CodespaceRepositoryTarget {
  id: string;
  fullName: string;
  private: boolean;
}

export type CodespaceResourceState =
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

export type CodespaceProviderHealthState =
  "disabled" | "misconfigured" | "unavailable" | "available";

export interface CodespaceMachine {
  name: string;
  displayName: string;
  operatingSystem: string;
  cpuCores: number;
  memoryBytes: number;
  storageBytes: number;
}

export type CodespaceProviderState =
  "provisioning" | "starting" | "available" | "stopping" | "shutdown" | "deleting" | "failed";

export interface CodespaceProviderResource {
  name: string;
  displayName: string;
  ownerId: string;
  billableOwnerId: string;
  repositoryId: string;
  repositoryFullName: string;
  /**
   * The Git ref currently checked out in the codespace. It is observed working state, never part of
   * the codespace's identity: an agent may switch branches at any time. `null` when the provider
   * reports none, such as a detached HEAD.
   */
  ref: string | null;
  /**
   * Where the provider says the codespace is. `provisioning`, `starting` and `stopping` are
   * transitional: the provider is already moving the codespace, so lifecycle work waits for it
   * instead of issuing another mutation.
   */
  state: CodespaceProviderState;
  /**
   * When the provider last started the codespace (GitHub's `last_used_at`, documented as "last
   * known time this codespace was started"). It is not a sign of use and is shown for information
   * only. `null` when the provider does not report it.
   */
  lastUsedAt: number | null;
  machine: CodespaceMachine | null;
  createdAt: number;
}

export type CodespaceCreateProviderResult =
  | { outcome: "accepted"; resource: CodespaceProviderResource | null }
  /**
   * `reason` is the stable machine-readable code that routing reads. `detail` is what the provider
   * itself said about the refusal, already redacted and bounded by the adapter; it is absent when the
   * provider said nothing usable, and nothing may infer a cause from its absence.
   */
  | { outcome: "rejected"; reason: string; detail?: string };

/**
 * What the provider can tell a user who must act outside Moira: the links that take them to the right
 * page, and one sentence per situation the product can find itself in. It is data rather than prose
 * composed by an agent, and it is the provider's own — the next provider brings its own console, its
 * own consent screen and its own idea of what a project is.
 */
export interface CodespaceProviderGuidance {
  /** Labelled destinations, identified by what they are for rather than by provider vocabulary. */
  links: ReadonlyArray<{ id: CodespaceGuidanceLinkId; url: string; label: string }>;
  /** One sentence per situation, in the provider's own terms. */
  instructions: Readonly<Partial<Record<CodespaceGuidanceSituation, string>>>;
}

/** Destinations a user may have to visit; a provider supplies the ones it has. */
export type CodespaceGuidanceLinkId =
  "settings" | "install" | "create_repository" | "provider_console";

/** What the product has found to be missing, decided by Moira rather than by the provider. */
export type CodespaceGuidanceSituation =
  | "not_configured"
  | "instance_disabled"
  | "connection_required"
  | "installation_required"
  | "authorization_repair_required"
  | "repository_not_approved"
  | "ceiling_reached"
  | "ready";

export interface CodespaceProviderAdapter {
  readonly id: string;
  readonly contractVersion: typeof CODESPACE_PROVIDER_CONTRACT_VERSION;
  readonly capabilities: Readonly<{
    disposable: boolean;
    persistent: boolean;
    exactLifecycle: boolean;
    personalBillingOnly: boolean;
    connector: string;
  }>;
  health(): Promise<{ state: CodespaceProviderHealthState; reason: string | null }>;
  getIdentity(credential: string): Promise<{ id: string; login: string }>;
  /**
   * Machine types the provider offers for this repository at this ref. The ref is part of the question:
   * a provider may offer different machines on different branches, and asking without one silently
   * answers for the default branch.
   */
  listMachines(
    credential: string,
    repository: CodespaceRepositoryTarget,
    ref: string,
  ): Promise<CodespaceMachine[]>;
  create(
    credential: string,
    input: {
      repository: CodespaceRepositoryTarget;
      ref: string;
      machine: CodespaceMachine;
      operationMarker: string;
      idleTimeoutMinutes: number;
      retentionMinutes: number;
    },
  ): Promise<CodespaceCreateProviderResult>;
  listOwned(credential: string): Promise<CodespaceProviderResource[]>;
  getExact(credential: string, resourceName: string): Promise<CodespaceProviderResource | null>;
  startExact(credential: string, resourceName: string): Promise<"accepted" | "absent">;
  stopExact(credential: string, resourceName: string): Promise<"accepted" | "absent">;
  deleteExact(credential: string, resourceName: string): Promise<"accepted" | "absent">;
  probeConnector(credential: string, resourceName: string): Promise<void>;
  /** The provider's own links and sentences for a user who must act outside Moira. */
  guidance(): CodespaceProviderGuidance;
}

export interface CodespaceResourcePolicy {
  enabled: boolean;
  maxCpuCores: number;
  maxMemoryBytes: number;
  maxStorageBytes: number;
  maxActivePerUser: number;
  maxActiveGlobal: number;
  createThrottleMs: number;
  /** How long an operation may wait for a stopped codespace it started to become usable. */
  startWaitMs: number;
  persistentRetentionMs?: number;
  createDeadlineMs: number;
  cleanupDeadlineMs: number;
  claimLeaseMs: number;
  reconcileIntervalMs: number;
  maxConcurrentOperationsPerUser?: number;
  maxConcurrentOperationsGlobal?: number;
  maxOperationInputBytes?: number;
  /** Response payload bounds. They bound what a call returns, never how long a command runs. */
  maxOperationStdoutBytes?: number;
  maxOperationStderrBytes?: number;
  /** Disk a single command's retained output may occupy in the codespace before it is stopped. */
  maxRetainedOutputBytes?: number;
  maxOperationMs?: number;
  /** How long a command started in the background may run in the codespace. */
  maxBackgroundOperationMs?: number;
  maxTransferFileBytes?: number;
  maxTransferBytesPerUser?: number;
  maxTransferBytesGlobal?: number;
  maxTransferObjectsPerUser?: number;
  maxTransferObjectsGlobal?: number;
  maxTransferInflightBytesPerUser?: number;
  maxTransferInflightBytesGlobal?: number;
  transferTtlMs?: number;
}

export interface CodespaceResourceRecord {
  id: string;
  userId: string;
  connectionId: string;
  authorizationGeneration: number;
  provider: string;
  repositoryId: string;
  repositoryFullName: string;
  requestedRef: string;
  /** The ref the provider last reported checked out; `null` until observed or when detached. */
  observedRef: string | null;
  operationMarker: string;
  providerResourceName: string | null;
  externalOwnerId: string | null;
  billableOwnerId: string | null;
  machine: CodespaceMachine;
  state: CodespaceResourceState;
  retentionPolicy: "legacy_disposable" | "persistent";
  desiredState: "running" | "stopped" | "deleted";
  observedState:
    "unknown" | "provisioning" | "running" | "stopped" | "deleting" | "absent" | "failed";
  generation: number;
  createDeadlineAt: number;
  /**
   * When a legacy disposable codespace expires, stamped when it was created. A persistent codespace
   * never expires; the column holds its creation time and is not read for it.
   */
  remoteExpiresAt: number;
  cleanupDeadlineAt: number | null;
  claimId: string | null;
  /**
   * While `claimId` is null, the earliest time the reconciler may take the record again: a record
   * whose reconciliation did not converge is deferred rather than retried on every tick.
   */
  claimExpiresAt: number | null;
  /** Consecutive reconciler passes that left the record unconverged; drives the retry backoff. */
  reconcileFailures: number;
  /** Last work Moira did in the codespace; `null` until any. */
  lastActivityAt: number | null;
  /** The provider's last start time as last observed, for display only; `null` until observed. */
  providerLastUsedAt: number | null;
  lastOutcome: string | null;
  createdAt: number;
  updatedAt: number;
}

export type CodespaceResourceErrorCode =
  | "CODESPACE_PROVIDER_DISABLED"
  | "CODESPACE_PROVIDER_UNAVAILABLE"
  | "CODESPACE_POLICY_LIMIT"
  | "CODESPACE_SESSION_UNAVAILABLE"
  | "CODESPACE_OPERATION_BUSY"
  | "CODESPACE_AUTHORIZATION_REQUIRED"
  | "CODESPACE_RESULT_EXPIRED"
  | "CODESPACE_CREATE_REJECTED"
  | "CODESPACE_CREATE_PENDING"
  | "CODESPACE_NOT_RUNNING"
  | "CODESPACE_START_TIMEOUT"
  | "CODESPACE_GENERATION_CONFLICT"
  | "CODESPACE_RESOURCE_INVALID"
  | "CODESPACE_NOT_FOUND";

export type CodespaceOperationState =
  | "reserved"
  | "running"
  | "cancel_pending"
  | "reconcile_pending"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "timed_out";

export interface CodespaceOperationRecord {
  id: string;
  userId: string;
  resourceId: string;
  resourceGeneration: number;
  authorizationGeneration: number;
  provider: string;
  providerResourceName: string;
  remoteMarker: string;
  kind: CodespaceOperationKind;
  state: CodespaceOperationState;
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

export type CodespaceOperationKind =
  "exec" | "stat" | "search" | "read" | "write" | "apply_patch" | "upload" | "download";

export type CodespaceByteSource =
  | { kind: "inline"; bytes: Uint8Array }
  | {
      kind: "reference";
      referenceId: string;
      declaredBytes: number;
      declaredMimeType: string;
    };

export interface CodespaceExecRequest {
  /** Absent only for a script command or a call that just ends a session. */
  argv?: readonly string[];
  /** Text run by the codespace's own shell inside a session; its end state is captured. */
  script?: string;
  /** Ends the named session after this call, removing its stored context. */
  sessionEnd?: boolean;
  /** Absent means the session's working directory, or the repository root without a session. */
  cwd?: string;
  /** Names a session whose working directory and variables this command continues. */
  session?: string;
  /** Opens the named session instead of continuing it. */
  sessionStart?: boolean;
  /** Variables to apply to this command and, in a session, to the ones that follow it. */
  env?: Readonly<Record<string, string>>;
  stdin: CodespaceByteSource;
  /** Absent means the mode's own default: an ordinary bounded duration, or the background ceiling. */
  timeoutMs?: number;
  /** Response payload bounds; the command is not stopped for reaching them. */
  maxStdoutBytes?: number;
  maxStderrBytes?: number;
  /** Retained-output ceiling, resolved from policy before dispatch. */
  maxRetainedBytes?: number;
  /**
   * Starts the command so that it keeps running past any single request. It is the same operation,
   * collected later by its own identity; only its ceiling and its deadline differ.
   */
  background?: boolean;
}

export interface CodespaceOperationResult {
  state: "succeeded" | "failed" | "cancelled" | "timed_out";
  /** Response payload: the beginning of the stream, bounded by the operation's payload limit. */
  stdout: string;
  stderr: string;
  exitCode: number | null;
  /** Complete size of each retained stream, whatever the payload above carries. */
  stdoutTotalBytes: number;
  stderrTotalBytes: number;
  /** True when the codespace's retained-output ceiling stopped the command. */
  outputLimitExceeded: boolean;
  /** True when a script's end state would not fit the session's stored-context ceiling. */
  sessionCaptureDropped: boolean;
}

export interface CodespaceOperationOutputRequest {
  stream: "stdout" | "stderr";
  offset: number;
  length: number;
}

export interface CodespaceOperationOutputResult {
  stream: "stdout" | "stderr";
  offset: number;
  totalBytes: number;
  bytes: Buffer;
}

export interface CodespaceOperationResponse {
  operation: CodespaceOperationRecord;
  result: CodespaceOperationResult | null;
}

export interface CodespaceTransportAvailability {
  health(): Promise<{ ok: boolean; reason: string | null }>;
}

export interface CodespaceOperationTransport extends CodespaceTransportAvailability {
  execute(
    credential: string,
    codespace: CodespaceResourceRecord,
    operation: CodespaceOperationRecord,
    request: CodespaceExecRequest,
  ): Promise<
    | CodespaceOperationResult
    | { state: "running" }
    | { state: "session_unavailable" }
    | { state: "session_limit"; limit: "context" | "sessions" }
  >;
  inspect(
    credential: string,
    codespace: CodespaceResourceRecord,
    operation: CodespaceOperationRecord,
  ): Promise<
    | CodespaceOperationResult
    | { state: "running" }
    | { state: "absent" }
    /** The operation belongs to an earlier life of the codespace: it was lost to a restart. */
    | { state: "interrupted" }
  >;
  cancel(
    credential: string,
    codespace: CodespaceResourceRecord,
    operation: CodespaceOperationRecord,
  ): Promise<
    CodespaceOperationResult | { state: "running" } | { state: "absent" } | { state: "interrupted" }
  >;
  finalize(
    credential: string,
    codespace: CodespaceResourceRecord,
    operation: CodespaceOperationRecord,
  ): Promise<void>;
  /**
   * Reads a range of a command's retained output. The retained streams live beside the operation's
   * remote result and are removed by the same finalize, so a range is readable exactly as long as
   * the result is.
   */
  readOutput(
    credential: string,
    codespace: CodespaceResourceRecord,
    operation: CodespaceOperationRecord,
    request: CodespaceOperationOutputRequest,
  ): Promise<CodespaceOperationOutputResult | { state: "absent" }>;
}

export interface CodespaceFileVersion {
  size: number;
  sha256: string;
  modifiedAt: number;
}

export interface CodespaceFileStat {
  path: string;
  type: "file" | "directory";
  size: number;
  mode: number;
  modifiedAt: number;
  version: CodespaceFileVersion | null;
}

export interface CodespaceSearchMatch {
  path: string;
  line: number;
  column: number;
  preview: string;
}

export interface CodespacePatchSummaryEntry {
  path: string;
  edits: number;
  insertedBytes: number;
  deletedBytes: number;
}

export interface CodespacePatchSummary {
  filesChanged: number;
  editsApplied: number;
  insertedBytes: number;
  deletedBytes: number;
  entries: CodespacePatchSummaryEntry[];
  truncated: boolean;
}

export type CodespaceFileRequest =
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

export type CodespaceFileResult =
  | {
      action: Exclude<CodespaceOperationKind, "exec">;
      state: "failed";
      code: "CODESPACE_FILE_REJECTED";
    }
  | { action: "stat"; stat: CodespaceFileStat }
  | { action: "search"; matches: CodespaceSearchMatch[]; truncated: boolean }
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
      previous: CodespaceFileVersion | null;
      current: CodespaceFileVersion;
    }
  | {
      action: "apply_patch";
      files: {
        path: string;
        previous: CodespaceFileVersion | null;
        current: CodespaceFileVersion;
      }[];
      summary: CodespacePatchSummary;
    };

export interface CodespaceFileOperationResponse {
  operation: CodespaceOperationRecord;
  result: CodespaceFileResult | null;
}

export interface CodespaceFileTransport extends CodespaceTransportAvailability {
  executeFile(
    credential: string,
    codespace: CodespaceResourceRecord,
    operation: CodespaceOperationRecord,
    request: CodespaceFileRequest,
  ): Promise<CodespaceFileResult | { state: "running" }>;
  inspectFile(
    credential: string,
    codespace: CodespaceResourceRecord,
    operation: CodespaceOperationRecord,
  ): Promise<CodespaceFileResult | { state: "running" } | { state: "absent" }>;
}

export interface CodespaceNativeFileReference {
  fileId: string;
  downloadUrl: string;
  fileName?: string;
  mimeType?: string;
  declaredSize?: number;
}

export interface CodespaceTransferRecord {
  id: string;
  userId: string;
  purpose: "codespace_input" | "codespace_download";
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

export class CodespaceResourceError extends Error {
  /**
   * `message` stays the operator-facing sentence that reaches logs and audit. `detail` is the
   * optional agent-safe addition: the refusing code decides what a caller may be told about its
   * own refusal, so no transport has to classify an error it did not raise. A detail carries no
   * codespace, user, repository or other caller identity.
   */
  constructor(
    public readonly code: CodespaceResourceErrorCode,
    message: string,
    public readonly detail?: string,
  ) {
    super(message);
    this.name = "CodespaceResourceError";
  }
}
