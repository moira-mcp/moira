import { createHash, randomUUID } from "node:crypto";
import { CodespaceProviderRegistry } from "./provider-registry.js";
import {
  CODESPACE_IDLE_TIMEOUT_MINUTES,
  CodespaceResourceRepository,
} from "./resource-repository.js";
import {
  CodespaceResourceError,
  type CodespaceMachine,
  type CodespaceProviderAdapter,
  type CodespaceProviderResource,
  type CodespaceProviderState,
  type CodespaceResourcePolicy,
  type CodespaceResourceRecord,
  type CodespaceGuidanceSituation,
  type CodespaceProviderGuidance,
  type CodespaceRepositoryTarget,
} from "./resource-types.js";
import { CodespaceConnectionError } from "./types.js";

export interface CodespaceCredentialResolver {
  getCredential(userId: string, providerId: string): Promise<string>;
}

export interface CodespaceRepositoryResolver {
  getApprovedConnection(
    userId: string,
    providerId: string,
    repositoryId: string,
  ): {
    connectionId: string;
    externalAccountId: string;
    authorizationGeneration: number;
    repository: CodespaceRepositoryTarget;
  } | null;
  listApprovedRepositories(userId: string, providerId: string): CodespaceRepositoryTarget[];
}

export interface CodespaceResourceAuditEvent {
  action: "create" | "create_pending" | "create_rejected" | "cleanup" | "start" | "stop" | "delete";
  userId: string;
  provider: string;
  resourceId: string;
  outcome: string;
  state: CodespaceResourceRecord["state"];
  machine: Pick<CodespaceMachine, "name" | "cpuCores" | "memoryBytes" | "storageBytes">;
  /** Bounded, credential-free detail for a provider or connector refusal. */
  reason?: string;
  /** Stable sink-level idempotency key for a retryable lifecycle refusal. */
  dedupeKey?: string;
}

export interface CodespaceCreateResult {
  resource: CodespaceResourceRecord;
  lifecycleCapability: string;
}

export interface CodespaceControlAuditEvent {
  action: "control_update";
  userId: string;
  provider: string;
  scope: "global" | `provider:${string}`;
  disabled: boolean;
  reason: string | null;
  stoppedPersistentCodespaces: number;
}

const PROVIDER_CLOCK_SKEW_MS = 5 * 60_000;

/** Longest a record that keeps failing to converge waits between reconciler attempts. */
const RECONCILE_BACKOFF_MAX_MS = 30 * 60_000;

/**
 * Due records one scheduled tick may reconcile after its first pass. Records that do not converge
 * are deferred, so a tick normally ends when nothing is due; the bound only caps provider traffic.
 */
const RECONCILE_BATCH_LIMIT = 20;

/**
 * How often one user's codespaces are listed from the provider, in reconcile intervals. The listing
 * is what notices GitHub's own idle shutdowns and use outside Moira; ten intervals (five minutes at
 * the default interval) keeps it to one list call per user in that time.
 */
const PROVIDER_OBSERVATION_INTERVALS = 10;

/** Users whose codespaces one tick may list from the provider. */
const PROVIDER_OBSERVATION_USERS_PER_TICK = 5;

/** Idle codespaces one tick may request stops for. */
const IDLE_STOP_LIMIT = 50;

/** Provider states in which the provider is already moving the codespace. */
const TRANSITIONAL_PROVIDER_STATES: ReadonlySet<CodespaceProviderState> = new Set([
  "provisioning",
  "starting",
  "stopping",
]);

function isTransitional(state: CodespaceProviderState): boolean {
  return TRANSITIONAL_PROVIDER_STATES.has(state);
}

/**
 * The record's coarse observed state for a provider state. A codespace that is shutting down is
 * still running until the provider says it stopped; the pending outcome names the transition.
 */
function observedStateFor(state: CodespaceProviderState): CodespaceResourceRecord["observedState"] {
  switch (state) {
    case "available":
    case "stopping":
      return "running";
    case "shutdown":
      return "stopped";
    case "deleting":
      return "deleting";
    case "failed":
      return "failed";
    case "provisioning":
    case "starting":
      return "provisioning";
  }
}

/** A branch ref and its short name are the same ref: `refs/heads/x` equals `x`. */
function normalizeRef(ref: string): string {
  return ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref;
}

/**
 * The fields that make an exact provider resource the one a record owns. The checked-out ref is
 * deliberately absent: an agent switches branches inside its codespace, and that must never turn
 * the codespace into a stranger. Owner, billable owner, repository id and marker still differ for a
 * resource that belongs to another account or another record.
 */
function exactIdentityMatches(
  actual: CodespaceProviderResource,
  record: Pick<
    CodespaceResourceRecord,
    | "providerResourceName"
    | "operationMarker"
    | "externalOwnerId"
    | "billableOwnerId"
    | "repositoryId"
  >,
): boolean {
  return (
    actual.name === record.providerResourceName &&
    actual.displayName === record.operationMarker &&
    actual.ownerId === record.externalOwnerId &&
    actual.billableOwnerId === record.billableOwnerId &&
    actual.repositoryId === record.repositoryId
  );
}

/** States a codespace never leaves: it holds no provider resource and accepts no operation. */
const FINISHED_RESOURCE_STATES: ReadonlySet<CodespaceResourceRecord["state"]> = new Set([
  "deleted",
  "rejected",
]);

function containsControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0)!;
    return codePoint <= 31 || (codePoint >= 127 && codePoint <= 159);
  });
}
/**
 * A provider transport failure before any durable reservation becomes a typed, bounded
 * error instead of an internal one: an HTTP 401/403 means the stored grant no longer
 * reaches the repository, 404 means the target is gone, and anything else (rate limit,
 * 5xx, network) is a retryable provider outage. The status is an integer and safe to name.
 */
/** Bounded, single-line detail of a connector or provider failure; never provider output. */
function boundedReason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/g, " ").trim().slice(0, 200) || "unknown";
}

/**
 * What the provider said about its own refusal, when it is carried on the error.
 *
 * Read structurally rather than by instance: the adapter that produces it lives in another package,
 * and the reason has already been redacted and bounded where it was produced.
 */
function providerDetail(error: unknown): string | undefined {
  const message =
    error && typeof error === "object"
      ? (error as { providerMessage?: unknown }).providerMessage
      : undefined;
  return typeof message === "string" && message.length > 0 ? message : undefined;
}

/**
 * Statuses a provider uses to say "no, and it will still be no next time": the request itself is
 * refused (400), it conflicts with the current state (409), or it cannot be processed as sent (422).
 * Classifying these as an outage would mark them retryable and tell an agent to repeat a request
 * that can never succeed, so they take the non-retryable code instead.
 */
const PERMANENT_REFUSAL_STATUSES = new Set([400, 409, 422]);

/**
 * The HTTP status of a provider refusal, or `null` when the error is not one: an error Moira already
 * classified is not the provider's answer, and neither is one that carries no status at all.
 */
function providerRefusalStatus(error: unknown): number | null {
  if (error instanceof CodespaceResourceError || error instanceof CodespaceConnectionError) {
    return null;
  }
  return error &&
    typeof error === "object" &&
    typeof (error as { status?: unknown }).status === "number"
    ? (error as { status: number }).status
    : null;
}

function providerFailure(error: unknown): never {
  if (error instanceof CodespaceResourceError || error instanceof CodespaceConnectionError) {
    throw error;
  }
  const status = providerRefusalStatus(error);
  const detail = providerDetail(error);
  if (status === 401 || status === 403) {
    throw new CodespaceResourceError(
      "CODESPACE_AUTHORIZATION_REQUIRED",
      `Codespace provider refused the stored grant (HTTP ${status})`,
      detail,
    );
  }
  if (status === 404) {
    throw new CodespaceResourceError(
      "CODESPACE_RESOURCE_INVALID",
      "Codespace provider no longer exposes the approved repository",
      detail,
    );
  }
  if (status !== null && PERMANENT_REFUSAL_STATUSES.has(status)) {
    throw new CodespaceResourceError(
      "CODESPACE_RESOURCE_INVALID",
      `Codespace provider refused the request (HTTP ${status})`,
      detail,
    );
  }
  if (status !== null) {
    throw new CodespaceResourceError(
      "CODESPACE_PROVIDER_UNAVAILABLE",
      `Codespace provider request failed (HTTP ${status})`,
      detail,
    );
  }
  throw error;
}

/**
 * Which lifecycle operation a pending record is in the middle of, for the audit entry a refusal
 * writes. The state the request persisted before provider contact is the authority; the desired
 * state answers for a record whose pending state has already been superseded.
 */
function lifecycleAuditAction(record: CodespaceResourceRecord): "start" | "stop" | "delete" {
  if (record.state === "delete_pending" || record.desiredState === "deleted") return "delete";
  if (record.state === "stop_pending" || record.desiredState === "stopped") return "stop";
  return "start";
}

function smallestPermittedMachine(
  machines: CodespaceMachine[],
  policy: CodespaceResourcePolicy,
): CodespaceMachine | null {
  return (
    machines
      .filter(
        (machine) =>
          machine.operatingSystem.toLowerCase() === "linux" &&
          machine.cpuCores > 0 &&
          machine.cpuCores <= policy.maxCpuCores &&
          machine.memoryBytes > 0 &&
          machine.memoryBytes <= policy.maxMemoryBytes &&
          machine.storageBytes > 0 &&
          machine.storageBytes <= policy.maxStorageBytes,
      )
      .sort(
        (left, right) =>
          left.cpuCores - right.cpuCores ||
          left.memoryBytes - right.memoryBytes ||
          left.storageBytes - right.storageBytes ||
          left.name.localeCompare(right.name),
      )[0] ?? null
  );
}

/**
 * The provider's repository id is the identity; the stored full name is a display fact. A repository
 * renamed on the provider keeps the same id, so comparing the name here would strand a codespace whose
 * repository was renamed — while a genuinely different repository still differs by id and is refused.
 */
function resourceMatches(
  actual: CodespaceProviderResource,
  expected: CodespaceResourceRecord,
  accountId: string,
  policy: CodespaceResourcePolicy,
  requirePersonalBilling: boolean,
): boolean {
  const machine = actual.machine;
  return (
    actual.displayName === expected.operationMarker &&
    actual.ownerId === accountId &&
    (!requirePersonalBilling || actual.billableOwnerId === accountId) &&
    actual.repositoryId === expected.repositoryId &&
    // Adoption is the one moment the requested ref is checked, and only as a branch name: GitHub may
    // report `refs/heads/x` for a request of `x`. A codespace that reports no ref yet (its git status
    // is filled in after provisioning, or it is on a detached HEAD) is accepted on the remaining
    // identity, which already pins it to this record's marker, owner, repository and machine.
    (actual.ref === null || normalizeRef(actual.ref) === normalizeRef(expected.requestedRef)) &&
    actual.createdAt >= expected.createdAt - 60_000 &&
    actual.createdAt <= expected.createDeadlineAt &&
    machine !== null &&
    machine.name === expected.machine.name &&
    machine.operatingSystem.toLowerCase() === expected.machine.operatingSystem.toLowerCase() &&
    machine.cpuCores === expected.machine.cpuCores &&
    machine.memoryBytes === expected.machine.memoryBytes &&
    machine.storageBytes === expected.machine.storageBytes &&
    machine.cpuCores <= policy.maxCpuCores &&
    machine.memoryBytes <= policy.maxMemoryBytes &&
    machine.storageBytes <= policy.maxStorageBytes
  );
}

export class CodespaceResourceService {
  private timer: NodeJS.Timeout | null = null;
  private scheduledReconcileRunning = false;

  constructor(
    private readonly dependencies: {
      repository: CodespaceResourceRepository;
      registry: CodespaceProviderRegistry;
      credentials: CodespaceCredentialResolver;
      repositories: CodespaceRepositoryResolver;
      providerId: string;
      requiredCapabilities: Partial<
        Pick<
          CodespaceProviderAdapter["capabilities"],
          "disposable" | "persistent" | "exactLifecycle" | "personalBillingOnly"
        >
      >;
      policy: () => CodespaceResourcePolicy;
      now?: () => number;
      /** Injected so waiting for a start costs no real time in tests. */
      delay?: (milliseconds: number) => Promise<void>;
      audit?: (event: CodespaceResourceAuditEvent) => Promise<void> | void;
      controlAudit?: (event: CodespaceControlAuditEvent) => Promise<void> | void;
    },
  ) {}

  /** Durable global and provider emergency controls as seen by administrators. */
  listControls(): ReturnType<CodespaceResourceRepository["listControls"]> {
    return this.dependencies.repository.listControls(this.dependencies.providerId);
  }

  /**
   * Set one emergency control. Disabling refuses new create/start/operation reservations,
   * rejects unsubmitted creates and requests stop for persistent codespaces; it never
   * deletes user data. Re-enabling only clears the control.
   */
  async setControl(input: {
    scope: "global" | `provider:${string}`;
    disabled: boolean;
    reason: string | null;
    updatedBy: string;
  }): Promise<ReturnType<CodespaceResourceRepository["listControls"]>> {
    const providerScope: `provider:${string}` = `provider:${this.dependencies.providerId}`;
    if (input.scope !== "global" && input.scope !== providerScope) {
      throw new CodespaceResourceError(
        "CODESPACE_RESOURCE_INVALID",
        "Codespace control scope is not managed by this provider",
      );
    }
    const now = this.now();
    const stopped = this.dependencies.repository.setControl({
      scope: input.scope,
      disabled: input.disabled,
      reason: input.reason,
      updatedBy: input.updatedBy,
      now,
      cleanupDeadlineAt: now + this.dependencies.policy().cleanupDeadlineMs,
    });
    await this.dependencies.controlAudit?.({
      action: "control_update",
      userId: input.updatedBy,
      provider: this.dependencies.providerId,
      scope: input.scope,
      disabled: input.disabled,
      reason: input.reason,
      stoppedPersistentCodespaces: stopped,
    });
    return this.listControls();
  }

  private now(): number {
    return (this.dependencies.now ?? Date.now)();
  }

  private provider(): CodespaceProviderAdapter {
    const provider = this.dependencies.registry.require(this.dependencies.providerId);
    const incompatible = Object.entries(this.dependencies.requiredCapabilities).some(
      ([name, required]) =>
        required === true &&
        provider.capabilities[name as keyof typeof provider.capabilities] !== true,
    );
    if (incompatible) {
      throw new CodespaceResourceError(
        "CODESPACE_PROVIDER_UNAVAILABLE",
        "Codespace provider does not satisfy the required lifecycle contract",
      );
    }
    return provider;
  }

  private requiresPersonalBilling(): boolean {
    return this.dependencies.requiredCapabilities.personalBillingOnly === true;
  }

  async getCapabilities(): Promise<{
    provider: string;
    health: Awaited<ReturnType<CodespaceProviderAdapter["health"]>>;
    capabilities: CodespaceProviderAdapter["capabilities"];
  }> {
    const provider = this.provider();
    const policy = this.dependencies.policy();
    if (!policy.enabled) {
      return {
        provider: provider.id,
        health: { state: "disabled", reason: "Codespace resources are disabled" },
        capabilities: provider.capabilities,
      };
    }
    const control = this.dependencies.repository.getControl(provider.id);
    if (control.disabled) {
      return {
        provider: provider.id,
        health: { state: "disabled", reason: control.reason ?? "Codespace provider is disabled" },
        capabilities: provider.capabilities,
      };
    }
    return {
      provider: provider.id,
      health: await provider.health(),
      capabilities: provider.capabilities,
    };
  }

  /**
   * What the user must do next and where, for whichever provider is configured. Moira decides the
   * situation — it knows what it just refused — and the provider supplies the words and the links, so
   * an agent never has to compose an instruction it cannot check.
   */
  setupGuidance(situation: CodespaceGuidanceSituation): {
    provider: string;
    situation: CodespaceGuidanceSituation;
    instruction: string | null;
    links: CodespaceProviderGuidance["links"];
  } {
    const provider = this.provider();
    const guidance = provider.guidance();
    return {
      provider: provider.id,
      situation,
      instruction: guidance.instructions[situation] ?? null,
      links: guidance.links,
    };
  }

  /** Diagnose the next setup step using current policy, grants and capacity. */
  setupSituation(userId: string, repositoryId?: string): CodespaceGuidanceSituation {
    const provider = this.provider();
    const policy = this.dependencies.policy();
    if (!policy.enabled || this.dependencies.repository.getControl(provider.id).disabled) {
      return "instance_disabled";
    }
    const repositories = this.listRepositories(userId);
    if (
      repositories.length === 0 ||
      (repositoryId !== undefined &&
        !repositories.some((repository) => repository.id === repositoryId))
    ) {
      return "repository_not_approved";
    }
    if (this.dependencies.repository.checkCreateCapacity(userId, provider.id, policy, this.now())) {
      return "ceiling_reached";
    }
    return "ready";
  }

  listRepositories(userId: string): CodespaceRepositoryTarget[] {
    return this.dependencies.repositories.listApprovedRepositories(
      userId,
      this.dependencies.providerId,
    );
  }

  /**
   * Codespaces a caller can still act on. A deleted or rejected codespace is finished and cannot
   * be started, used or recovered, so listing it only invites an agent to address an identifier
   * that will refuse every operation. Fetching one by its identifier still works.
   */
  listResources(userId: string): CodespaceResourceRecord[] {
    return this.listAllResources(userId).filter(
      (resource) => !FINISHED_RESOURCE_STATES.has(resource.state),
    );
  }

  /** Every owned record, including finished ones, for lifecycle work that must see them. */
  private listAllResources(userId: string): CodespaceResourceRecord[] {
    return this.dependencies.repository.listOwned(userId, this.dependencies.providerId);
  }

  async rebindAfterAuthorization(userId: string): Promise<number> {
    const provider = this.provider();
    const candidates = this.dependencies.repository.listAuthorizationRebindCandidates(
      userId,
      provider.id,
    );
    if (candidates.length === 0) return 0;
    const unrebound = new Set(candidates.map((candidate) => candidate.resource.id));
    let rebound = 0;
    try {
      const credential = await this.dependencies.credentials.getCredential(userId, provider.id);
      const identity = await provider.getIdentity(credential);
      for (const candidate of candidates) {
        const record = candidate.resource;
        if (!record.providerResourceName || record.externalOwnerId !== identity.id) continue;
        const exact = await provider.getExact(credential, record.providerResourceName);
        // An exact resource that is gone is rebound too: the account and grant are verified, and
        // there is nothing another account could own under that name. Lifecycle then settles the
        // absence — a stop or delete completes as absent — instead of the record staying fenced,
        // undeletable and counted against the user's limit.
        if (exact && (exact.ownerId !== identity.id || !exactIdentityMatches(exact, record))) {
          continue;
        }
        if (exact) {
          this.dependencies.repository.recordProviderObservation(
            record.id,
            {
              repositoryFullName: exact.repositoryFullName,
              observedRef: exact.ref,
              lastUsedAt: exact.lastUsedAt,
            },
            this.now(),
          );
        }
        if (
          this.dependencies.repository.rebindAuthorization({
            userId,
            resourceId: record.id,
            resourceGeneration: record.generation,
            expectedAuthorizationGeneration: record.authorizationGeneration,
            authorizationGeneration: candidate.authorizationGeneration,
            now: this.now(),
          })
        ) {
          unrebound.delete(record.id);
          rebound++;
        }
      }
    } finally {
      // Whatever was not re-verified — a different identity, a provider failure mid-pass — goes to
      // the back of the rebind order so it cannot hold every other user's rebind behind it.
      this.dependencies.repository.touchAuthorizationRebindAttempt([...unrebound], this.now());
    }
    return rebound;
  }

  async create(
    userId: string,
    repositoryId: string,
    requestedRef: string,
  ): Promise<CodespaceCreateResult> {
    const provider = this.provider();
    const policy = this.dependencies.policy();
    if (!policy.enabled || this.dependencies.repository.getControl(provider.id).disabled) {
      throw new CodespaceResourceError(
        "CODESPACE_PROVIDER_DISABLED",
        "Codespace provider is disabled",
      );
    }
    if (
      repositoryId.length < 1 ||
      repositoryId.length > 255 ||
      containsControlCharacter(repositoryId) ||
      requestedRef.length < 1 ||
      requestedRef.length > 255
    ) {
      throw new CodespaceConnectionError("REPOSITORY_NOT_ALLOWED", "Repository is not approved");
    }
    let approved = this.dependencies.repositories.getApprovedConnection(
      userId,
      provider.id,
      repositoryId,
    );
    if (!approved) {
      throw new CodespaceConnectionError("REPOSITORY_NOT_ALLOWED", "Repository is not approved");
    }
    const capacity = this.dependencies.repository.checkCreateCapacity(
      userId,
      provider.id,
      policy,
      this.now(),
    );
    if (capacity) {
      throw new CodespaceResourceError("CODESPACE_POLICY_LIMIT", capacity.reason, capacity.detail);
    }
    const health = await provider.health();
    if (health.state !== "available") {
      throw new CodespaceResourceError(
        "CODESPACE_PROVIDER_UNAVAILABLE",
        health.reason ?? "Codespace provider is unavailable",
      );
    }
    const credential = await this.dependencies.credentials.getCredential(userId, provider.id);
    const identity = await provider.getIdentity(credential).catch(providerFailure);
    if (identity.id !== approved.externalAccountId) {
      throw new CodespaceResourceError("CODESPACE_RESOURCE_INVALID", "Connected identity changed");
    }
    const currentApproval = this.dependencies.repositories.getApprovedConnection(
      userId,
      provider.id,
      repositoryId,
    );
    if (!currentApproval || currentApproval.externalAccountId !== identity.id) {
      throw new CodespaceConnectionError("REPOSITORY_NOT_ALLOWED", "Repository is not approved");
    }
    approved = currentApproval;
    const machine = smallestPermittedMachine(
      await provider
        .listMachines(credential, approved.repository, requestedRef)
        .catch(providerFailure),
      policy,
    );
    if (!machine) {
      throw new CodespaceResourceError(
        "CODESPACE_POLICY_LIMIT",
        "No permitted Linux machine is available",
      );
    }
    const reservation = this.dependencies.repository.reserveCreate({
      userId,
      provider: provider.id,
      repository: approved.repository,
      connectionId: approved.connectionId,
      authorizationGeneration: approved.authorizationGeneration,
      requestedRef,
      machine,
      externalAccountId: identity.id,
      policy,
      now: this.now(),
    });
    if (reservation.outcome !== "reserved") {
      if (reservation.outcome === "not_approved") {
        throw new CodespaceConnectionError("REPOSITORY_NOT_ALLOWED", reservation.reason);
      }
      throw new CodespaceResourceError(
        reservation.outcome === "disabled"
          ? "CODESPACE_PROVIDER_DISABLED"
          : "CODESPACE_POLICY_LIMIT",
        reservation.reason,
        reservation.outcome === "limit" ? reservation.detail : undefined,
      );
    }
    const initial = reservation.resource;
    const submissionClaimId = randomUUID();
    if (
      !this.dependencies.repository.markSubmitted({
        resourceId: initial.id,
        expectedGeneration: initial.generation,
        claimId: submissionClaimId,
        claimExpiresAt: this.now() + Math.max(policy.claimLeaseMs, 60_000),
        now: this.now(),
      })
    ) {
      const superseded = this.dependencies.repository.getOwned(userId, initial.id);
      if (
        superseded &&
        ["stop_before_submission", "delete_requested"].includes(superseded.lastOutcome ?? "")
      ) {
        return { resource: superseded, lifecycleCapability: reservation.capability };
      }
      this.dependencies.repository.markRejected(
        initial.id,
        initial.generation,
        "provider_disabled_before_submission",
        this.now(),
      );
      throw new CodespaceResourceError(
        "CODESPACE_PROVIDER_DISABLED",
        "Codespace provider was disabled before submission",
      );
    }
    const submitted = this.dependencies.repository.getOwned(userId, initial.id)!;
    let result: Awaited<ReturnType<CodespaceProviderAdapter["create"]>>;
    try {
      result = await provider.create(credential, {
        repository: approved.repository,
        ref: requestedRef,
        machine,
        operationMarker: initial.operationMarker,
        // Always the provider's maximum. GitHub's own idle timer ignores silent background commands,
        // so a shorter provider timeout would stop a codespace under a long agent command; the
        // owner's timeout is enforced by Moira's idle stop, which sees agent activity.
        idleTimeoutMinutes: CODESPACE_IDLE_TIMEOUT_MINUTES.maximum,
        retentionMinutes: Math.min(
          43_200,
          Math.max(1, Math.ceil((policy.persistentRetentionMs ?? 30 * 24 * 60 * 60_000) / 60_000)),
        ),
      });
    } catch {
      this.dependencies.repository.releaseClaim(
        submitted.id,
        submitted.generation,
        submissionClaimId,
        "provider_outcome_unknown",
        this.now(),
      );
      await this.emit("create_pending", submitted, "provider_outcome_unknown");
      return {
        resource: this.dependencies.repository.getOwned(userId, submitted.id)!,
        lifecycleCapability: reservation.capability,
      };
    }
    if (result.outcome === "rejected") {
      this.dependencies.repository.markClaimedCreateRejected(
        submitted.id,
        submitted.generation,
        submissionClaimId,
        result.reason,
        this.now(),
      );
      await this.emit(
        "create_rejected",
        this.dependencies.repository.getOwned(userId, submitted.id)!,
        result.reason,
        result.detail,
      );
      throw new CodespaceResourceError(
        "CODESPACE_CREATE_REJECTED",
        "Codespace creation was rejected",
        result.detail,
      );
    }
    if (!result.resource) {
      this.dependencies.repository.releaseClaim(
        submitted.id,
        submitted.generation,
        submissionClaimId,
        "accepted_background",
        this.now(),
      );
      await this.emit("create_pending", submitted, "accepted_background");
      return {
        resource: this.dependencies.repository.getOwned(userId, submitted.id)!,
        lifecycleCapability: reservation.capability,
      };
    }
    return this.acceptCreatedResource(
      submitted,
      reservation.capability,
      result.resource,
      identity.id,
      policy,
      submissionClaimId,
      credential,
    );
  }

  private async acceptCreatedResource(
    record: CodespaceResourceRecord,
    capability: string,
    actual: CodespaceProviderResource,
    accountId: string,
    policy: CodespaceResourcePolicy,
    claimId: string,
    credential: string,
  ): Promise<CodespaceCreateResult> {
    const valid = resourceMatches(
      actual,
      record,
      accountId,
      policy,
      this.requiresPersonalBilling(),
    );
    let usable = valid && actual.state === "available";
    if (valid && isTransitional(actual.state)) {
      this.dependencies.repository.bindSubmittedResource({
        resourceId: record.id,
        expectedGeneration: record.generation,
        resourceName: actual.name,
        ownerId: actual.ownerId,
        billableOwnerId: actual.billableOwnerId,
        observedRef: actual.ref,
        outcome: "provisioning",
        claimId,
        now: this.now(),
      });
      const pending = this.dependencies.repository.getOwned(record.userId, record.id)!;
      await this.emit("create_pending", pending, "provisioning");
      return { resource: pending, lifecycleCapability: capability };
    }
    let probeReason: string | undefined;
    if (usable) {
      try {
        await this.dependencies.registry
          .require(record.provider)
          .probeConnector(credential, actual.name);
      } catch (error) {
        usable = false;
        probeReason = boundedReason(error);
      }
    }
    const adopted = this.dependencies.repository.adopt({
      resourceId: record.id,
      expectedGeneration: record.generation,
      resourceName: actual.name,
      ownerId: actual.ownerId,
      billableOwnerId: actual.billableOwnerId,
      observedRef: actual.ref,
      state: usable ? "usable" : "cleanup_pending",
      outcome: usable ? "verified_usable" : valid ? "connector_unavailable" : "verification_failed",
      cleanupDeadlineAt: usable ? undefined : this.now() + policy.cleanupDeadlineMs,
      claimId,
      now: this.now(),
    });
    if (!adopted && valid) {
      this.dependencies.repository.bindReturnedCleanupResource({
        resourceId: record.id,
        resourceName: actual.name,
        ownerId: actual.ownerId,
        billableOwnerId: actual.billableOwnerId,
        now: this.now(),
      });
    }
    const current = this.dependencies.repository.getOwned(record.userId, record.id)!;
    if (!adopted) {
      await this.emit("create_pending", current, "lifecycle_state_changed");
      return { resource: current, lifecycleCapability: capability };
    }
    await this.emit(
      usable ? "create" : "create_rejected",
      current,
      current.lastOutcome ?? "unknown",
      probeReason,
    );
    if (!usable) {
      throw new CodespaceResourceError(
        "CODESPACE_RESOURCE_INVALID",
        "Created codespace failed verification",
      );
    }
    return { resource: current, lifecycleCapability: capability };
  }

  async release(userId: string, resourceId: string, capability: string): Promise<void> {
    const existing = this.dependencies.repository.getByCapability(userId, capability);
    if (!existing || existing.id !== resourceId) {
      throw new CodespaceResourceError("CODESPACE_NOT_FOUND", "Codespace was not found");
    }
    if (existing.retentionPolicy === "persistent") {
      await this.stopCodespace(userId, resourceId);
      return;
    }
    const policy = this.dependencies.policy();
    if (
      !this.dependencies.repository.requestCleanup(
        userId,
        resourceId,
        capability,
        this.now() + policy.cleanupDeadlineMs,
        this.now(),
      )
    ) {
      throw new CodespaceResourceError("CODESPACE_NOT_FOUND", "Codespace was not found");
    }
    await this.reconcileOnce(userId);
  }

  getCodespace(userId: string, resourceId: string): CodespaceResourceRecord {
    const codespace = this.dependencies.repository.getOwned(userId, resourceId);
    if (!codespace) {
      throw new CodespaceResourceError("CODESPACE_NOT_FOUND", "Codespace was not found");
    }
    return codespace;
  }

  /**
   * Make a codespace usable for work that is about to reach it. A codespace that is already usable is
   * returned untouched; one that is merely asleep is started and waited for, because an agent's
   * command should not fail for a codespace that went idle between two calls. The wait is bounded by
   * policy and a codespace that cannot start is refused by what it actually is.
   */
  async ensureRunning(userId: string, resourceId: string): Promise<CodespaceResourceRecord> {
    const current = this.getCodespace(userId, resourceId);
    if (current.state === "usable" && current.desiredState === "running") return current;
    if (
      current.retentionPolicy !== "persistent" ||
      ["deleted", "rejected", "delete_pending", "cleanup_pending"].includes(current.state) ||
      current.desiredState === "deleted"
    ) {
      throw new CodespaceResourceError(
        "CODESPACE_NOT_RUNNING",
        "Codespace cannot be started",
        `This codespace is ${current.state} and cannot be started; create a new one.`,
      );
    }
    const started = await this.startCodespace(userId, resourceId);
    if (started.state === "usable") return started;
    const policy = this.dependencies.policy();
    const deadline = this.now() + policy.startWaitMs;
    const interval = Math.max(1000, Math.min(policy.reconcileIntervalMs, policy.startWaitMs));
    while (this.now() < deadline) {
      await this.delay(interval);
      const pending = this.getCodespace(userId, resourceId);
      if (pending.state === "usable" && pending.desiredState === "running") return pending;
      if (pending.desiredState !== "running") break;
      await this.applyPersistentLifecycle(pending);
      const observed = this.getCodespace(userId, resourceId);
      if (observed.state === "usable" && observed.desiredState === "running") return observed;
    }
    const final = this.getCodespace(userId, resourceId);
    if (final.state === "usable" && final.desiredState === "running") return final;
    throw new CodespaceResourceError(
      "CODESPACE_START_TIMEOUT",
      "Codespace did not become usable in time",
      `The codespace was started but was not usable within ${Math.floor(
        policy.startWaitMs / 1000,
      )} seconds; retry the command once it has finished starting.`,
    );
  }

  private async delay(milliseconds: number): Promise<void> {
    if (this.dependencies.delay) return this.dependencies.delay(milliseconds);
    await new Promise((resolveValue) => setTimeout(resolveValue, milliseconds));
  }

  async startCodespace(userId: string, resourceId: string): Promise<CodespaceResourceRecord> {
    const policy = this.dependencies.policy();
    if (!policy.enabled) {
      throw new CodespaceResourceError(
        "CODESPACE_PROVIDER_DISABLED",
        "Codespace provider is disabled",
      );
    }
    this.requireCurrentLifecycleAuthority(userId, resourceId);
    const requested = this.dependencies.repository.requestStart(userId, resourceId, this.now());
    if (requested === "disabled") {
      throw new CodespaceResourceError(
        "CODESPACE_PROVIDER_DISABLED",
        "Codespace provider is disabled",
      );
    }
    if (requested === "unbound") {
      // The record exists; what is missing is the exact provider resource a start would address.
      // Saying "not found" here sent agents looking for a codespace that is listed right beside it.
      const current = this.getCodespace(userId, resourceId);
      if (current.state === "ambiguous") {
        throw new CodespaceResourceError(
          "CODESPACE_NOT_RUNNING",
          "Codespace provider resource is ambiguous",
          "Moira could not identify this codespace's provider resource uniquely (state ambiguous), so it cannot be started.",
        );
      }
      throw new CodespaceResourceError(
        "CODESPACE_CREATE_PENDING",
        "Codespace provider resource is not identified yet",
        `Moira is still identifying this codespace's provider resource (state ${current.state}); retry the start once it has settled.`,
      );
    }
    if (!requested) {
      throw new CodespaceResourceError("CODESPACE_NOT_FOUND", "Codespace was not found");
    }
    if (["usable", "create_pending", "create_submitted"].includes(requested.state))
      return requested;
    await this.applyPersistentLifecycle(requested);
    const current = this.getCodespace(userId, resourceId);
    if (current.state === "usable")
      await this.emit("start", current, current.lastOutcome ?? "running");
    return current;
  }

  async stopCodespace(userId: string, resourceId: string): Promise<CodespaceResourceRecord> {
    this.requireCurrentLifecycleAuthority(userId, resourceId);
    const requested = this.dependencies.repository.requestStop(userId, resourceId, this.now());
    if (!requested) {
      throw new CodespaceResourceError("CODESPACE_NOT_FOUND", "Codespace was not found");
    }
    if (["stopped", "deleted"].includes(requested.state)) {
      await this.emit("stop", requested, requested.lastOutcome ?? requested.state);
      return requested;
    }
    await this.applyPersistentLifecycle(requested);
    const current = this.getCodespace(userId, resourceId);
    if (current.state === "stopped")
      await this.emit("stop", current, current.lastOutcome ?? "stopped");
    return current;
  }

  async deleteCodespace(
    userId: string,
    resourceId: string,
    expectedGeneration: number,
  ): Promise<CodespaceResourceRecord> {
    this.requireCurrentLifecycleAuthority(userId, resourceId);
    const requested = this.dependencies.repository.requestDelete(
      userId,
      resourceId,
      expectedGeneration,
      this.now(),
    );
    if (requested === "conflict") {
      throw new CodespaceResourceError(
        "CODESPACE_GENERATION_CONFLICT",
        "Codespace generation changed; refresh it before deleting",
      );
    }
    if (!requested) {
      throw new CodespaceResourceError("CODESPACE_NOT_FOUND", "Codespace was not found");
    }
    await this.applyPersistentLifecycle(requested);
    const current = this.getCodespace(userId, resourceId);
    if (current.state === "deleted")
      await this.emit("delete", current, current.lastOutcome ?? "deleted");
    return current;
  }

  private requireCurrentLifecycleAuthority(userId: string, resourceId: string): void {
    const owned = this.dependencies.repository.getOwned(userId, resourceId);
    if (!owned) {
      throw new CodespaceResourceError("CODESPACE_NOT_FOUND", "Codespace was not found");
    }
    if (!this.dependencies.repository.hasCurrentAuthorization(userId, resourceId)) {
      throw new CodespaceResourceError(
        "CODESPACE_RESOURCE_INVALID",
        "Reconnect the same provider account and repository in Moira settings",
      );
    }
  }

  async cleanupBeforeDisconnect(userId: string): Promise<void> {
    const policy = this.dependencies.policy();
    this.dependencies.repository.requestAllCleanupForUser(
      userId,
      this.dependencies.providerId,
      this.now() + policy.cleanupDeadlineMs,
      this.now(),
    );
    this.dependencies.repository.requestPersistentStopsForUser(
      userId,
      this.dependencies.providerId,
      this.now(),
    );
    const maximumPasses = this.listAllResources(userId).length + 1;
    for (let pass = 0; pass < maximumPasses; pass++) {
      if (!(await this.reconcileOnce(userId))) break;
    }
    const unfinished = this.listResources(userId).filter((resource) =>
      resource.retentionPolicy === "persistent"
        ? !["stopped", "deleted", "rejected"].includes(resource.state)
        : !["deleted", "rejected"].includes(resource.state),
    );
    if (unfinished.length > 0) {
      throw new CodespaceResourceError(
        "CODESPACE_CREATE_PENDING",
        "Codespace operations must stop before disconnecting GitHub",
      );
    }
  }

  /**
   * One reconciliation step: re-verify one user's codespaces after a re-authorization if any are
   * waiting, otherwise reconcile the next due record. Returns whether it did any work.
   */
  async reconcileOnce(userId?: string): Promise<boolean> {
    const rebindUser = this.dependencies.repository.nextAuthorizationRebindUser(
      this.dependencies.providerId,
      userId,
    );
    if (rebindUser) {
      try {
        if ((await this.rebindAfterAuthorization(rebindUser)) > 0) return true;
      } catch {
        // Keep the stale authorization generation fenced and retry later; the pass already moved
        // these records to the back of the rebind order.
      }
    }
    return this.reconcileNextDue(userId);
  }

  private deferReconcile(
    record: CodespaceResourceRecord,
    claimId: string,
    outcome: string | null,
  ): void {
    const now = this.now();
    this.dependencies.repository.deferReconcile({
      resourceId: record.id,
      generation: record.generation,
      claimId,
      outcome,
      baseDelayMs: this.dependencies.policy().reconcileIntervalMs,
      maxDelayMs: RECONCILE_BACKOFF_MAX_MS,
      // A create, or a record not yet bound to its provider resource, is decided at the create
      // deadline, so the backoff never carries it past that moment; the deadline is still strictly
      // in the future, so this tick never takes it again.
      latestAt:
        (record.state === "create_submitted" || record.providerResourceName === null) &&
        record.createDeadlineAt > now
          ? record.createDeadlineAt
          : null,
      now,
    });
  }

  /**
   * Defers a record the pass left where it found it — same generation, same state — unless the
   * pass already deferred it. Several passes end by giving the claim back (a create not visible
   * yet, one still provisioning, a cleanup target not listed yet); without this, the next claim in
   * the same tick would take the same record again and ask the provider the same question.
   */
  private deferIfUnconverged(record: CodespaceResourceRecord, claimId: string): void {
    const after = this.dependencies.repository.getOwned(record.userId, record.id);
    if (!after || after.generation !== record.generation || after.state !== record.state) return;
    const alreadyDeferred =
      after.claimId === null && after.claimExpiresAt !== null && after.claimExpiresAt > this.now();
    if (after.claimId !== null && after.claimId !== claimId) return;
    if (!alreadyDeferred) this.deferReconcile(record, claimId, null);
  }

  private async reconcileNextDue(userId?: string): Promise<boolean> {
    const policy = this.dependencies.policy();
    const claimId = randomUUID();
    const record = this.dependencies.repository.claimDue(
      claimId,
      this.now(),
      this.now() + policy.claimLeaseMs,
      userId,
    );
    if (!record) return false;
    if (record.state === "create_pending") {
      this.dependencies.repository.expireUnsubmitted(
        record.id,
        record.generation,
        claimId,
        this.now(),
      );
      return true;
    }
    if (record.state === "usable") {
      this.dependencies.repository.releaseClaim(
        record.id,
        record.generation,
        claimId,
        "remote_ttl_expired",
        this.now(),
      );
      this.dependencies.repository.requestCleanupSystem(
        record.id,
        record.generation,
        this.now() + policy.cleanupDeadlineMs,
        this.now(),
      );
      return true;
    }
    if (["start_pending", "stop_pending", "delete_pending"].includes(record.state)) {
      let failure: string | null = null;
      try {
        await this.applyPersistentLifecycle(record);
      } catch {
        failure = "lifecycle_reconcile_required";
      }
      // A pass that left the record in the same pending generation did not converge it, whether
      // the provider refused or is still moving the codespace. Either way it waits its backoff
      // instead of being the first due record again on the next tick.
      const after = this.dependencies.repository.getOwned(record.userId, record.id);
      if (after && after.generation === record.generation && after.state === record.state) {
        this.deferReconcile(record, claimId, failure);
      }
      return true;
    }
    try {
      const credential = await this.dependencies.credentials.getCredential(
        record.userId,
        record.provider,
      );
      const provider = this.dependencies.registry.require(record.provider);
      if (record.state === "create_submitted") {
        await this.reconcileCreation(record, claimId, credential, provider, policy);
      } else if (record.state === "cleanup_pending") {
        await this.reconcileCleanup(record, claimId, credential, provider);
      } else {
        this.deferReconcile(record, claimId, "manual_ambiguous_cleanup_required");
      }
    } catch {
      this.deferReconcile(record, claimId, "reconcile_retry_required");
    }
    this.deferIfUnconverged(record, claimId);
    return true;
  }

  private async applyPersistentLifecycle(record: CodespaceResourceRecord): Promise<void> {
    // Start, stop and delete reach the provider through this one funnel. Without this catch a
    // provider refusal leaves as an unclassified error and the caller is told only that something
    // went wrong internally — the state that made a refused start as undiagnosable as a refused
    // creation. `providerFailure` rethrows an already-classified error untouched, so a genuine
    // internal fault stays an internal fault.
    try {
      await this.applyPersistentLifecycleThroughProvider(record);
    } catch (error) {
      // The refusal is audited before it is thrown. The caller's error lives as long as the request
      // and the connector's log lives as long as the container, so the audit entry is the only
      // record of a refused start, stop or delete that survives the next deploy. Only an actual
      // provider refusal is audited: an already-classified or status-less error is an internal
      // fault, and recording it as the provider's answer would be a false entry.
      const status = providerRefusalStatus(error);
      if (status !== null) {
        const action = lifecycleAuditAction(record);
        const outcome = `provider_refused_${status}`;
        const detail = providerDetail(error);
        const dedupeKey = `codespace-refusal:${createHash("sha256")
          .update(JSON.stringify([record.id, record.generation, action, outcome, detail ?? null]))
          .digest("hex")}`;
        await this.emit(action, record, outcome, detail, dedupeKey);
      }
      providerFailure(error);
    }
  }

  /**
   * Moves one pending persistent codespace toward its desired state, looking before it acts.
   *
   * The provider's current state decides what happens: a codespace already where it should be is
   * completed without a provider call; one the provider is still moving is left pending; only a
   * codespace that is settled somewhere else receives a mutation. A delete is issued directly,
   * whatever the codespace is doing. When a mutation fails, the codespace is observed again, because
   * a refused stop of a codespace that meanwhile shut down has nonetheless reached its goal.
   */
  private async applyPersistentLifecycleThroughProvider(
    record: CodespaceResourceRecord,
  ): Promise<void> {
    const provider = this.dependencies.registry.require(record.provider);
    const credential = await this.dependencies.credentials.getCredential(
      record.userId,
      record.provider,
    );
    let resourceName = record.providerResourceName;
    if (!resourceName) {
      const identity = await provider.getIdentity(credential);
      const matches = (await provider.listOwned(credential)).filter(
        (candidate) =>
          candidate.displayName === record.operationMarker &&
          candidate.ownerId === identity.id &&
          (!this.requiresPersonalBilling() || candidate.billableOwnerId === identity.id) &&
          candidate.repositoryId === record.repositoryId &&
          candidate.createdAt >= record.createdAt - 60_000 &&
          candidate.createdAt <= record.createDeadlineAt + PROVIDER_CLOCK_SKEW_MS,
      );
      if (matches.length !== 1) {
        if (
          matches.length === 0 &&
          record.desiredState === "stopped" &&
          this.now() >= record.createDeadlineAt
        ) {
          this.dependencies.repository.completeAbsentPersistentLifecycle(
            record.id,
            record.generation,
            "stopped",
            "verified_never_created",
            this.now(),
          );
          return;
        }
        if (
          matches.length === 0 &&
          record.desiredState === "deleted" &&
          this.now() >= record.createDeadlineAt
        ) {
          this.dependencies.repository.completeLifecycle({
            resourceId: record.id,
            generation: record.generation,
            desiredState: "deleted",
            observedState: "absent",
            state: "deleted",
            outcome: "verified_never_created",
            now: this.now(),
          });
          return;
        }
        this.dependencies.repository.markLifecyclePending(
          record.id,
          record.generation,
          matches.length === 0 ? "resource_not_visible" : "multiple_exact_matches",
          "unknown",
          this.now(),
        );
        return;
      }
      const discovered = matches[0];
      resourceName = discovered.name;
      this.dependencies.repository.bindLifecycleIdentity({
        resourceId: record.id,
        generation: record.generation,
        resourceName,
        ownerId: discovered.ownerId,
        billableOwnerId: discovered.billableOwnerId,
        now: this.now(),
      });
      record = {
        ...record,
        providerResourceName: resourceName,
        externalOwnerId: discovered.ownerId,
        billableOwnerId: discovered.billableOwnerId,
      };
    }
    const observe = () => this.observeExact(record, provider, credential);
    const exact = await observe();
    if ((await this.settleLifecycleVerified(record, exact, provider, credential)) || !exact) return;
    if (
      exact.state === "deleting" ||
      (record.desiredState !== "deleted" && isTransitional(exact.state))
    ) {
      this.markTransitionPending(record, exact);
      return;
    }
    try {
      if (record.desiredState === "running") await provider.startExact(credential, resourceName);
      else if (record.desiredState === "stopped")
        await provider.stopExact(credential, resourceName);
      else await provider.deleteExact(credential, resourceName);
    } catch (error) {
      const reobserved = await observe().catch(() => undefined);
      if (reobserved === undefined) throw error;
      if (await this.settleLifecycleVerified(record, reobserved, provider, credential)) return;
      if (reobserved && (reobserved.state === "deleting" || isTransitional(reobserved.state))) {
        // The provider refused because it is already moving the codespace; that is progress to
        // wait for, not a refusal to report.
        this.markTransitionPending(record, reobserved);
        return;
      }
      throw error;
    }
    const observed = await observe();
    if (await this.settleLifecycleVerified(record, observed, provider, credential)) return;
    this.dependencies.repository.markLifecyclePending(
      record.id,
      record.generation,
      record.desiredState === "running"
        ? "start_pending"
        : record.desiredState === "stopped"
          ? "stop_pending"
          : "delete_pending",
      observed ? observedStateFor(observed.state) : "absent",
      this.now(),
    );
  }

  /**
   * The exact resource as the provider reports it now, verified to still be this record's. A
   * different identity under the same name is refused rather than acted on; the facts that are not
   * identity — the repository's name, the checked-out ref — are written back.
   */
  private async observeExact(
    record: CodespaceResourceRecord,
    provider: CodespaceProviderAdapter,
    credential: string,
  ): Promise<CodespaceProviderResource | null> {
    const exact = await provider.getExact(credential, record.providerResourceName!);
    if (!exact) return null;
    if (!exactIdentityMatches(exact, record)) {
      throw new CodespaceResourceError(
        "CODESPACE_RESOURCE_INVALID",
        "Codespace exact identity changed",
      );
    }
    this.dependencies.repository.recordProviderObservation(
      record.id,
      {
        repositoryFullName: exact.repositoryFullName,
        observedRef: exact.ref,
        lastUsedAt: exact.lastUsedAt,
      },
      this.now(),
    );
    return exact;
  }

  /**
   * Completes the record when the observed codespace already is what the record wants, except for a
   * running target, which needs the connector probe of {@link settleLifecycleVerified}. Returns
   * whether the record is settled.
   */
  private settleLifecycle(
    record: CodespaceResourceRecord,
    observed: CodespaceProviderResource | null,
  ): boolean {
    if (!observed) {
      if (record.desiredState === "deleted") {
        this.dependencies.repository.completeLifecycle({
          resourceId: record.id,
          generation: record.generation,
          desiredState: "deleted",
          observedState: "absent",
          state: "deleted",
          outcome: "verified_absent",
          now: this.now(),
        });
      } else {
        this.dependencies.repository.completeAbsentPersistentLifecycle(
          record.id,
          record.generation,
          record.desiredState,
          "verified_externally_absent",
          this.now(),
        );
      }
      return true;
    }
    // A failed codespace runs nothing, so the intent to stop it is met; the provider refuses to
    // stop it, and asking again would keep the record pending forever. The record stops with the
    // provider's observation kept as `failed`, so the view does not claim a clean shutdown.
    if (
      record.desiredState === "stopped" &&
      (observed.state === "shutdown" || observed.state === "failed")
    ) {
      const failed = observed.state === "failed";
      this.dependencies.repository.completeLifecycle({
        resourceId: record.id,
        generation: record.generation,
        desiredState: "stopped",
        observedState: failed ? "failed" : "stopped",
        state: "stopped",
        outcome: failed ? "verified_failed_not_running" : "verified_stopped",
        now: this.now(),
      });
      return true;
    }
    return false;
  }

  private async settleLifecycleVerified(
    record: CodespaceResourceRecord,
    observed: CodespaceProviderResource | null,
    provider: CodespaceProviderAdapter,
    credential: string,
  ): Promise<boolean> {
    if (this.settleLifecycle(record, observed)) return true;
    if (record.desiredState !== "running" || observed?.state !== "available") return false;
    await provider.probeConnector(credential, observed.name);
    this.dependencies.repository.completeLifecycle({
      resourceId: record.id,
      generation: record.generation,
      desiredState: "running",
      observedState: "running",
      state: "usable",
      outcome: "verified_running",
      now: this.now(),
    });
    return true;
  }

  private markTransitionPending(
    record: CodespaceResourceRecord,
    observed: CodespaceProviderResource,
  ): void {
    this.dependencies.repository.markLifecyclePending(
      record.id,
      record.generation,
      `provider_${observed.state}`,
      observedStateFor(observed.state),
      this.now(),
    );
  }

  private async reconcileCreation(
    record: CodespaceResourceRecord,
    claimId: string,
    credential: string,
    provider: CodespaceProviderAdapter,
    policy: CodespaceResourcePolicy,
  ): Promise<void> {
    const identity = await provider.getIdentity(credential);
    const candidates = record.providerResourceName
      ? [await provider.getExact(credential, record.providerResourceName)].filter(
          (value): value is CodespaceProviderResource => value !== null,
        )
      : (await provider.listOwned(credential)).filter(
          (resource) =>
            resource.displayName === record.operationMarker &&
            resource.repositoryId === record.repositoryId &&
            resource.ownerId === identity.id &&
            (!this.requiresPersonalBilling() || resource.billableOwnerId === identity.id) &&
            resource.createdAt >= record.createdAt - 60_000 &&
            resource.createdAt <= record.createDeadlineAt + PROVIDER_CLOCK_SKEW_MS,
        );
    if (candidates.length > 1) {
      this.dependencies.repository.markAmbiguous(record.id, record.generation, claimId, this.now());
      return;
    }
    if (candidates.length === 0) {
      if (this.now() >= record.createDeadlineAt) {
        this.dependencies.repository.markClaimedCreateRejected(
          record.id,
          record.generation,
          claimId,
          "verified_no_created_resource",
          this.now(),
        );
      } else {
        this.dependencies.repository.releaseClaim(
          record.id,
          record.generation,
          claimId,
          "creation_not_visible",
          this.now(),
        );
      }
      return;
    }
    await this.acceptCreatedResource(
      record,
      "",
      candidates[0],
      identity.id,
      policy,
      claimId,
      credential,
    );
  }

  private async reconcileCleanup(
    record: CodespaceResourceRecord,
    claimId: string,
    credential: string,
    provider: CodespaceProviderAdapter,
  ): Promise<void> {
    let resourceName = record.providerResourceName;
    if (!resourceName) {
      const identity = await provider.getIdentity(credential);
      const matches = (await provider.listOwned(credential)).filter(
        (resource) =>
          resource.displayName === record.operationMarker &&
          resource.repositoryId === record.repositoryId &&
          resource.ownerId === identity.id &&
          (!this.requiresPersonalBilling() || resource.billableOwnerId === identity.id) &&
          resource.createdAt >= record.createdAt - 60_000 &&
          resource.createdAt <= record.createDeadlineAt + PROVIDER_CLOCK_SKEW_MS,
      );
      if (matches.length > 1) {
        this.deferReconcile(record, claimId, "multiple_cleanup_matches");
        return;
      }
      if (matches.length === 0) {
        if (this.now() >= record.createDeadlineAt) {
          this.dependencies.repository.completeWithoutRemoteResource(
            record.id,
            record.generation,
            claimId,
            this.now(),
          );
        } else {
          this.dependencies.repository.releaseClaim(
            record.id,
            record.generation,
            claimId,
            "cleanup_resource_not_visible",
            this.now(),
          );
        }
        return;
      }
      const discovered = matches[0];
      if (
        !this.dependencies.repository.bindCleanupResource({
          resourceId: record.id,
          generation: record.generation,
          claimId,
          resourceName: discovered.name,
          ownerId: discovered.ownerId,
          billableOwnerId: discovered.billableOwnerId,
          now: this.now(),
        })
      ) {
        return;
      }
      resourceName = discovered.name;
      record = {
        ...record,
        providerResourceName: resourceName,
        externalOwnerId: discovered.ownerId,
        billableOwnerId: discovered.billableOwnerId,
      };
    }
    const exact = await provider.getExact(credential, resourceName);
    if (exact) {
      if (!exactIdentityMatches(exact, record)) {
        this.deferReconcile(record, claimId, "exact_identity_mismatch");
        return;
      }
      this.dependencies.repository.recordProviderObservation(
        record.id,
        {
          repositoryFullName: exact.repositoryFullName,
          observedRef: exact.ref,
          lastUsedAt: exact.lastUsedAt,
        },
        this.now(),
      );
      if (exact.state === "deleting") {
        this.deferReconcile(record, claimId, "delete_pending");
        return;
      }
      // Deleting needs no stop first: the provider deletes a running or transitional codespace
      // directly, and a stop in front of it is one more call that can fail and hold cleanup back.
      if (
        !this.dependencies.repository.recordRequiredCleanupMutation({
          resourceId: record.id,
          generation: record.generation,
          claimId,
          kind: "delete",
          now: this.now(),
        })
      ) {
        return;
      }
      try {
        await provider.deleteExact(credential, resourceName);
      } catch (error) {
        // A refused delete of a codespace that is gone anyway has still reached its goal.
        if ((await provider.getExact(credential, resourceName).catch(() => undefined)) !== null) {
          throw error;
        }
      }
    }
    if ((await provider.getExact(credential, resourceName)) === null) {
      const completed = this.dependencies.repository.completeDeleted(
        record.id,
        record.generation,
        claimId,
        this.now(),
      );
      if (completed) {
        await this.emit(
          "cleanup",
          this.dependencies.repository.getOwned(record.userId, record.id)!,
          "verified_absent",
        );
      }
    } else {
      this.deferReconcile(record, claimId, "delete_pending");
    }
  }

  start(): void {
    if (this.timer) return;
    void this.reconcileTick();
    this.timer = setInterval(
      () => void this.reconcileTick(),
      this.dependencies.policy().reconcileIntervalMs,
    );
    this.timer.unref();
  }

  /**
   * One scheduled reconciliation tick, as `start()` runs it each interval: one rebind attempt, then
   * the due records up to a bound. Overlapping ticks do not run concurrently.
   */
  async reconcileTick(): Promise<void> {
    if (this.scheduledReconcileRunning) return;
    this.scheduledReconcileRunning = true;
    try {
      // A record observed in this tick is left for the next tick's idle scan: an idle stop leads to
      // a lifecycle pass that reads the codespace again, and no record is looked at twice in a tick.
      const observed = await this.observeProviderState();
      await this.stopIdleCodespaces(observed);
      // One rebind attempt per tick, then every due record up to a bound. A record that does not
      // converge is deferred, so it is not claimed twice in one tick and cannot crowd others out.
      if (await this.reconcileOnce()) {
        for (let pass = 1; pass < RECONCILE_BATCH_LIMIT; pass++) {
          if (!(await this.reconcileNextDue())) break;
        }
      }
    } finally {
      this.scheduledReconcileRunning = false;
    }
  }

  /**
   * Lists the codespaces of the users whose observation is due — at most one listing per user per
   * observation interval — and records what the provider says about each running one: its checked-
   * out ref and last start time, and, when the provider already stopped it, that it is stopped. Nothing
   * is mutated at the provider. Returns the records observed.
   */
  private async observeProviderState(): Promise<Set<string>> {
    const observed = new Set<string>();
    const policy = this.dependencies.policy();
    if (!policy.enabled) return observed;
    const provider = this.dependencies.registry.require(this.dependencies.providerId);
    const users = this.dependencies.repository.claimProviderObservations(
      provider.id,
      this.now(),
      policy.reconcileIntervalMs * PROVIDER_OBSERVATION_INTERVALS,
      PROVIDER_OBSERVATION_USERS_PER_TICK,
    );
    for (const userId of users) {
      try {
        const records = this.dependencies.repository.listObservableRunning(userId, provider.id);
        if (records.length === 0) continue;
        const credential = await this.dependencies.credentials.getCredential(userId, provider.id);
        const listed = new Map(
          (await provider.listOwned(credential)).map((resource) => [resource.name, resource]),
        );
        for (const record of records) {
          observed.add(record.id);
          const actual = listed.get(record.providerResourceName!);
          // Absent from the listing, or no longer this record's: lifecycle decides that from an
          // exact read when the codespace is next used, not a listing.
          if (!actual || !exactIdentityMatches(actual, record)) continue;
          this.dependencies.repository.recordProviderObservation(
            record.id,
            {
              repositoryFullName: actual.repositoryFullName,
              observedRef: actual.ref,
              lastUsedAt: actual.lastUsedAt,
            },
            this.now(),
          );
          if (
            actual.state === "shutdown" &&
            this.dependencies.repository.markObservedStopped(
              record.id,
              record.generation,
              this.now(),
            )
          ) {
            await this.emit(
              "stop",
              this.dependencies.repository.getOwned(userId, record.id)!,
              "provider_observed_stopped",
            );
          }
        }
      } catch {
        // One user's credential or provider failure never holds back another's observation or the
        // rest of the tick; the next interval observes again.
      }
    }
    return observed;
  }

  /**
   * Requests a stop for every codespace idle past its owner's timeout. The stop converges through
   * ordinary lifecycle, and the next use starts the codespace again. `skip` are records observed in
   * this tick, stopped (if still idle) in the next.
   */
  private async stopIdleCodespaces(skip: ReadonlySet<string>): Promise<void> {
    if (!this.dependencies.policy().enabled) return;
    const candidates = this.dependencies.repository.listIdleStopCandidates(
      this.dependencies.providerId,
      this.now(),
      IDLE_STOP_LIMIT,
      [...skip],
    );
    for (const candidate of candidates) {
      const stopped = this.dependencies.repository.requestIdleStop(
        candidate.id,
        candidate.generation,
        this.now(),
      );
      if (stopped) await this.emit("stop", stopped, "idle_stop_requested");
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async emit(
    action: CodespaceResourceAuditEvent["action"],
    record: CodespaceResourceRecord,
    outcome: string,
    reason?: string,
    dedupeKey?: string,
  ): Promise<void> {
    await this.dependencies.audit?.({
      action,
      userId: record.userId,
      provider: record.provider,
      resourceId: record.id,
      outcome,
      ...(reason !== undefined ? { reason } : {}),
      ...(dedupeKey !== undefined ? { dedupeKey } : {}),
      state: record.state,
      machine: {
        name: record.machine.name,
        cpuCores: record.machine.cpuCores,
        memoryBytes: record.machine.memoryBytes,
        storageBytes: record.machine.storageBytes,
      },
    });
  }
}
