/** Idle timeout bounds and default, in minutes: GitHub's own idle-timeout range. */
import type { GitHubProviderFailure, providerReplySchema } from "./local-controller-protocol.js";
import type { z } from "zod";
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
  | {
      outcome: "accepted";
      resource: CodespaceProviderResource | null;
      providerReply?: z.infer<typeof providerReplySchema>;
    }
  /**
   * `reason` is the stable machine-readable code that routing reads. `detail` is what the provider
   * itself said about the refusal, already redacted and bounded by the adapter; it is absent when the
   * provider said nothing usable, and nothing may infer a cause from its absence.
   */
  | {
      outcome: "rejected";
      reason: string;
      detail?: string;
      providerFailure?: GitHubProviderFailure;
    };

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
  | "ready";

export interface GitHubProviderCreateInput {
  repository: CodespaceRepositoryTarget;
  ref: string;
  machine: CodespaceMachine;
  operationMarker: string;
  idleTimeoutMinutes: number;
  retentionMinutes: number;
  devcontainerPath?: string;
}

export interface CodespaceResourcePolicy {
  enabled: boolean;
  persistentRetentionMs: number;
}

export type CodespaceRetentionPolicy = "legacy_disposable" | "persistent";
export type CodespaceDesiredState = "running" | "stopped" | "deleted";
export type CodespaceObservedState =
  "unknown" | "created" | "provisioning" | "running" | "stopped" | "deleting" | "absent" | "failed";
export type CodespaceResourceErrorCode =
  | "WORKSPACE_OUTCOME_UNCONFIRMED"
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
    case "WORKSPACE_OUTCOME_UNCONFIRMED":
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

export class CodespaceResourceError extends Error {
  requestId?: string;
  /** Authoritative owner observation, when available; never inferred from cloud identity. */
  pendingRequestIds?: string[];
  deviceId?: string;
  resourceId?: string;
  providerFailure?: GitHubProviderFailure;
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
