export const CODESPACE_PROVIDER_CONTRACT_VERSION = 6 as const;
/** Idle timeout bounds and default, in minutes: GitHub's own idle-timeout range. */
export const CODESPACE_IDLE_TIMEOUT_MINUTES = { minimum: 5, maximum: 240, default: 30 } as const;

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
  | "created"
  | "provisioning"
  | "starting"
  | "available"
  | "stopping"
  | "shutdown"
  | "deleting"
  | "failed"
  | "unknown";

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
  /** Bounded physical-state or guest-readiness diagnosis; a confirmed shutdown may still have incomplete guest preparation. */
  stateError?: CodespaceResourceErrorCode;
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
  /**
   * Read the provider's billing owner for a create request before any resource is created. A
   * provider that cannot identify the payer must fail this read, not guess from repository owner.
   */
  preflightCreate(
    credential: string,
    repository: CodespaceRepositoryTarget,
    ref: string,
  ): Promise<{ billableOwnerId: string }>;
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
  /** Exact reserved creation identity; absence means creation has settled without a resource. */
  inspectCreation?(
    credential: string,
    input: { resourceId: string; operationMarker: string; repositoryId: string },
  ): Promise<{ outcome: "found"; resource: CodespaceProviderResource } | { outcome: "absent" }>;
  getExact(credential: string, resourceName: string): Promise<CodespaceProviderResource | null>;
  startExact(credential: string, resourceName: string): Promise<"accepted" | "absent">;
  stopExact(credential: string, resourceName: string): Promise<"accepted" | "absent">;
  deleteExact(credential: string, resourceName: string): Promise<"accepted" | "absent">;
  preflightDelete?(
    credential: string,
    input: { resourceId: string; ownerConfirmed: boolean },
  ): Promise<void>;
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
  /** Expiry of separately published native attachment links, not workspace results. */
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
    | "unknown"
    | "created"
    | "provisioning"
    | "running"
    | "stopped"
    | "deleting"
    | "absent"
    | "failed";
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
  /** Last verified provider observation, independent of bookkeeping and retry timestamps. */
  observedAt: number | null;
  lastOutcome: string | null;
  createdAt: number;
  updatedAt: number;
}

export type CodespaceResourceErrorCode =
  | "CODESPACE_PROVIDER_DISABLED"
  | "CODESPACE_PROVIDER_UNAVAILABLE"
  | "CODESPACE_POLICY_LIMIT"
  | "CODESPACE_AUTHORIZATION_REQUIRED"
  | "CODESPACE_CREATE_REJECTED"
  | "CODESPACE_BILLING_UNSUPPORTED"
  | "CODESPACE_CREATE_PENDING"
  | "CODESPACE_NOT_RUNNING"
  | "CODESPACE_START_TIMEOUT"
  | "CODESPACE_GENERATION_CONFLICT"
  | "CODESPACE_RESOURCE_INVALID"
  | "CODESPACE_LOCAL_CREATION_UNKNOWN"
  | "CODESPACE_LOCAL_SETUP_INCOMPLETE"
  | "CODESPACE_LOCAL_PROTOCOL_ERROR"
  | "CODESPACE_LOCAL_RUNTIME_ERROR"
  | "CODESPACE_LOCAL_DELETE_APPROVAL_REQUIRED"
  | "CODESPACE_NOT_FOUND";

/** Only these known lifecycle outcomes may be projected to callers; never provider text. */
export function codespaceLifecycleErrorCode(
  outcome: string | null,
): CodespaceResourceErrorCode | null {
  const code = outcome?.startsWith("refused:") ? outcome.slice("refused:".length) : outcome;
  switch (code) {
    case "CODESPACE_PROVIDER_DISABLED":
    case "CODESPACE_PROVIDER_UNAVAILABLE":
    case "CODESPACE_POLICY_LIMIT":
    case "CODESPACE_AUTHORIZATION_REQUIRED":
    case "CODESPACE_CREATE_REJECTED":
    case "CODESPACE_BILLING_UNSUPPORTED":
    case "CODESPACE_CREATE_PENDING":
    case "CODESPACE_NOT_RUNNING":
    case "CODESPACE_START_TIMEOUT":
    case "CODESPACE_GENERATION_CONFLICT":
    case "CODESPACE_RESOURCE_INVALID":
    case "CODESPACE_LOCAL_CREATION_UNKNOWN":
    case "CODESPACE_LOCAL_SETUP_INCOMPLETE":
    case "CODESPACE_LOCAL_PROTOCOL_ERROR":
    case "CODESPACE_LOCAL_RUNTIME_ERROR":
    case "CODESPACE_LOCAL_DELETE_APPROVAL_REQUIRED":
    case "CODESPACE_NOT_FOUND":
      return code;
    default:
      return null;
  }
}

export interface CodespaceTransportAvailability {
  health(): Promise<{ ok: boolean; reason: string | null }>;
}

export interface CodespaceNativeFileReference {
  fileId: string;
  downloadUrl: string;
  fileName?: string;
  mimeType?: string;
  declaredSize?: number;
}

/** Each open verifies content before delivery and owns a separate bounded descriptor lifecycle. */
export interface CodespaceVerifiedByteSource {
  readonly size: number;
  readonly sha256: string;
  open(signal?: AbortSignal): Promise<CodespaceVerifiedByteStream>;
}

export interface CodespaceVerifiedByteStream extends AsyncIterable<Uint8Array> {
  readonly settled: Promise<void>;
  close(): Promise<void>;
}

export interface CodespaceTransferRecord {
  id: string;
  requestId?: string | null;
  requestDigest?: string | null;
  direction?: "guest_to_server" | "server_to_guest" | null;
  resourceId?: string | null;
  provider?: string | null;
  resourceGeneration?: number | null;
  authorizationGeneration?: number | null;
  environmentIdentity?: string | null;
  expectedSha256?: string | null;
  uploadedBytes?: number;
  userId: string;
  purpose:
    | "codespace_input"
    | "codespace_download"
    | "local_relay_input"
    | "local_relay_output"
    | "operation_input"
    | "operation_result";
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
    /** Internal provenance: an authenticated provider reply explicitly refused this intent. */
    public readonly confirmedRefusal = false,
  ) {
    super(message);
    this.name = "CodespaceResourceError";
  }
}
