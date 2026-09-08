import { randomUUID } from "node:crypto";
import { WorkspaceProviderRegistry } from "./provider-registry.js";
import { WorkspaceResourceRepository } from "./resource-repository.js";
import {
  WorkspaceResourceError,
  type WorkspaceMachine,
  type WorkspaceProviderAdapter,
  type WorkspaceProviderResource,
  type WorkspaceResourcePolicy,
  type WorkspaceResourceRecord,
  type WorkspaceRepositoryTarget,
} from "./resource-types.js";
import { WorkspaceConnectionError } from "./types.js";

export interface WorkspaceCredentialResolver {
  getCredential(userId: string, providerId: string): Promise<string>;
}

export interface WorkspaceRepositoryResolver {
  getApprovedConnection(
    userId: string,
    providerId: string,
    repositoryId: string,
  ): {
    connectionId: string;
    externalAccountId: string;
    authorizationGeneration: number;
    repository: WorkspaceRepositoryTarget;
  } | null;
  listApprovedRepositories(userId: string, providerId: string): WorkspaceRepositoryTarget[];
}

export interface WorkspaceResourceAuditEvent {
  action: "create" | "create_pending" | "create_rejected" | "cleanup" | "start" | "stop" | "delete";
  userId: string;
  provider: string;
  resourceId: string;
  outcome: string;
  state: WorkspaceResourceRecord["state"];
  machine: Pick<WorkspaceMachine, "name" | "cpuCores" | "memoryBytes" | "storageBytes">;
}

export interface WorkspaceCreateResult {
  resource: WorkspaceResourceRecord;
  lifecycleCapability: string;
}

const PROVIDER_CLOCK_SKEW_MS = 5 * 60_000;

function containsControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0)!;
    return codePoint <= 31 || (codePoint >= 127 && codePoint <= 159);
  });
}

function smallestPermittedMachine(
  machines: WorkspaceMachine[],
  policy: WorkspaceResourcePolicy,
): WorkspaceMachine | null {
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

function resourceMatches(
  actual: WorkspaceProviderResource,
  expected: WorkspaceResourceRecord,
  accountId: string,
  policy: WorkspaceResourcePolicy,
  requirePersonalBilling: boolean,
): boolean {
  const machine = actual.machine;
  return (
    actual.displayName === expected.operationMarker &&
    actual.ownerId === accountId &&
    (!requirePersonalBilling || actual.billableOwnerId === accountId) &&
    actual.repositoryId === expected.repositoryId &&
    actual.repositoryFullName.toLowerCase() === expected.repositoryFullName.toLowerCase() &&
    actual.ref === expected.requestedRef &&
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

export class WorkspaceResourceService {
  private timer: NodeJS.Timeout | null = null;
  private scheduledReconcileRunning = false;

  constructor(
    private readonly dependencies: {
      repository: WorkspaceResourceRepository;
      registry: WorkspaceProviderRegistry;
      credentials: WorkspaceCredentialResolver;
      repositories: WorkspaceRepositoryResolver;
      providerId: string;
      requiredCapabilities: Partial<
        Pick<
          WorkspaceProviderAdapter["capabilities"],
          "disposable" | "persistent" | "exactLifecycle" | "personalBillingOnly"
        >
      >;
      policy: () => WorkspaceResourcePolicy;
      now?: () => number;
      audit?: (event: WorkspaceResourceAuditEvent) => Promise<void> | void;
    },
  ) {}

  private now(): number {
    return (this.dependencies.now ?? Date.now)();
  }

  private provider(): WorkspaceProviderAdapter {
    const provider = this.dependencies.registry.require(this.dependencies.providerId);
    const incompatible = Object.entries(this.dependencies.requiredCapabilities).some(
      ([name, required]) =>
        required === true &&
        provider.capabilities[name as keyof typeof provider.capabilities] !== true,
    );
    if (incompatible) {
      throw new WorkspaceResourceError(
        "WORKSPACE_PROVIDER_UNAVAILABLE",
        "Workspace provider does not satisfy the required lifecycle contract",
      );
    }
    return provider;
  }

  private requiresPersonalBilling(): boolean {
    return this.dependencies.requiredCapabilities.personalBillingOnly === true;
  }

  async getCapabilities(): Promise<{
    provider: string;
    health: Awaited<ReturnType<WorkspaceProviderAdapter["health"]>>;
    capabilities: WorkspaceProviderAdapter["capabilities"];
  }> {
    const provider = this.provider();
    const policy = this.dependencies.policy();
    if (!policy.enabled) {
      return {
        provider: provider.id,
        health: { state: "disabled", reason: "Workspace resources are disabled" },
        capabilities: provider.capabilities,
      };
    }
    const control = this.dependencies.repository.getControl(provider.id);
    if (control.disabled) {
      return {
        provider: provider.id,
        health: { state: "disabled", reason: control.reason ?? "Workspace provider is disabled" },
        capabilities: provider.capabilities,
      };
    }
    return {
      provider: provider.id,
      health: await provider.health(),
      capabilities: provider.capabilities,
    };
  }

  listRepositories(userId: string): WorkspaceRepositoryTarget[] {
    return this.dependencies.repositories.listApprovedRepositories(
      userId,
      this.dependencies.providerId,
    );
  }

  listResources(userId: string): WorkspaceResourceRecord[] {
    return this.dependencies.repository.listOwned(userId, this.dependencies.providerId);
  }

  async rebindAfterAuthorization(userId: string): Promise<number> {
    const provider = this.provider();
    const candidates = this.dependencies.repository.listAuthorizationRebindCandidates(
      userId,
      provider.id,
    );
    if (candidates.length === 0) return 0;
    const credential = await this.dependencies.credentials.getCredential(userId, provider.id);
    const identity = await provider.getIdentity(credential);
    let rebound = 0;
    for (const candidate of candidates) {
      const record = candidate.resource;
      if (!record.providerResourceName || record.externalOwnerId !== identity.id) continue;
      const exact = await provider.getExact(credential, record.providerResourceName);
      if (
        !exact ||
        exact.name !== record.providerResourceName ||
        exact.displayName !== record.operationMarker ||
        exact.ownerId !== identity.id ||
        exact.billableOwnerId !== record.billableOwnerId ||
        exact.repositoryId !== record.repositoryId ||
        exact.repositoryFullName.toLowerCase() !== record.repositoryFullName.toLowerCase() ||
        exact.ref !== record.requestedRef
      ) {
        continue;
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
        rebound++;
      }
    }
    return rebound;
  }

  async create(
    userId: string,
    repositoryId: string,
    requestedRef: string,
  ): Promise<WorkspaceCreateResult> {
    const provider = this.provider();
    const policy = this.dependencies.policy();
    if (!policy.enabled || this.dependencies.repository.getControl(provider.id).disabled) {
      throw new WorkspaceResourceError(
        "WORKSPACE_PROVIDER_DISABLED",
        "Workspace provider is disabled",
      );
    }
    if (
      repositoryId.length < 1 ||
      repositoryId.length > 255 ||
      containsControlCharacter(repositoryId) ||
      requestedRef.length < 1 ||
      requestedRef.length > 255
    ) {
      throw new WorkspaceConnectionError("REPOSITORY_NOT_ALLOWED", "Repository is not approved");
    }
    let approved = this.dependencies.repositories.getApprovedConnection(
      userId,
      provider.id,
      repositoryId,
    );
    if (!approved) {
      throw new WorkspaceConnectionError("REPOSITORY_NOT_ALLOWED", "Repository is not approved");
    }
    const health = await provider.health();
    if (health.state !== "available") {
      throw new WorkspaceResourceError(
        "WORKSPACE_PROVIDER_UNAVAILABLE",
        health.reason ?? "Workspace provider is unavailable",
      );
    }
    const credential = await this.dependencies.credentials.getCredential(userId, provider.id);
    const identity = await provider.getIdentity(credential);
    if (identity.id !== approved.externalAccountId) {
      throw new WorkspaceResourceError("WORKSPACE_RESOURCE_INVALID", "Connected identity changed");
    }
    const currentApproval = this.dependencies.repositories.getApprovedConnection(
      userId,
      provider.id,
      repositoryId,
    );
    if (!currentApproval || currentApproval.externalAccountId !== identity.id) {
      throw new WorkspaceConnectionError("REPOSITORY_NOT_ALLOWED", "Repository is not approved");
    }
    approved = currentApproval;
    const machine = smallestPermittedMachine(
      await provider.listMachines(credential, approved.repository),
      policy,
    );
    if (!machine) {
      throw new WorkspaceResourceError(
        "WORKSPACE_POLICY_LIMIT",
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
        throw new WorkspaceConnectionError("REPOSITORY_NOT_ALLOWED", reservation.reason);
      }
      throw new WorkspaceResourceError(
        reservation.outcome === "disabled"
          ? "WORKSPACE_PROVIDER_DISABLED"
          : "WORKSPACE_POLICY_LIMIT",
        reservation.reason,
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
      throw new WorkspaceResourceError(
        "WORKSPACE_PROVIDER_DISABLED",
        "Workspace provider was disabled before submission",
      );
    }
    const submitted = this.dependencies.repository.getOwned(userId, initial.id)!;
    let result: Awaited<ReturnType<WorkspaceProviderAdapter["create"]>>;
    try {
      result = await provider.create(credential, {
        repository: approved.repository,
        ref: requestedRef,
        machine,
        operationMarker: initial.operationMarker,
        idleTimeoutMinutes: Math.min(240, Math.max(5, Math.ceil(policy.remoteTtlMs / 60_000))),
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
      );
      throw new WorkspaceResourceError(
        "WORKSPACE_CREATE_REJECTED",
        "Workspace creation was rejected",
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
    record: WorkspaceResourceRecord,
    capability: string,
    actual: WorkspaceProviderResource,
    accountId: string,
    policy: WorkspaceResourcePolicy,
    claimId: string,
    credential: string,
  ): Promise<WorkspaceCreateResult> {
    const valid = resourceMatches(
      actual,
      record,
      accountId,
      policy,
      this.requiresPersonalBilling(),
    );
    let usable = valid && actual.state === "available";
    if (valid && actual.state === "provisioning") {
      this.dependencies.repository.bindSubmittedResource({
        resourceId: record.id,
        expectedGeneration: record.generation,
        resourceName: actual.name,
        ownerId: actual.ownerId,
        billableOwnerId: actual.billableOwnerId,
        outcome: "provisioning",
        claimId,
        now: this.now(),
      });
      const pending = this.dependencies.repository.getOwned(record.userId, record.id)!;
      await this.emit("create_pending", pending, "provisioning");
      return { resource: pending, lifecycleCapability: capability };
    }
    if (usable) {
      try {
        await this.dependencies.registry
          .require(record.provider)
          .probeConnector(credential, actual.name);
      } catch {
        usable = false;
      }
    }
    const adopted = this.dependencies.repository.adopt({
      resourceId: record.id,
      expectedGeneration: record.generation,
      resourceName: actual.name,
      ownerId: actual.ownerId,
      billableOwnerId: actual.billableOwnerId,
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
    );
    if (!usable) {
      throw new WorkspaceResourceError(
        "WORKSPACE_RESOURCE_INVALID",
        "Created workspace failed verification",
      );
    }
    return { resource: current, lifecycleCapability: capability };
  }

  async release(userId: string, resourceId: string, capability: string): Promise<void> {
    const existing = this.dependencies.repository.getByCapability(userId, capability);
    if (!existing || existing.id !== resourceId) {
      throw new WorkspaceResourceError("WORKSPACE_NOT_FOUND", "Workspace was not found");
    }
    if (existing.retentionPolicy === "persistent") {
      await this.stopWorkspace(userId, resourceId);
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
      throw new WorkspaceResourceError("WORKSPACE_NOT_FOUND", "Workspace was not found");
    }
    await this.reconcileOnce(userId);
  }

  getWorkspace(userId: string, resourceId: string): WorkspaceResourceRecord {
    const workspace = this.dependencies.repository.getOwned(userId, resourceId);
    if (!workspace) {
      throw new WorkspaceResourceError("WORKSPACE_NOT_FOUND", "Workspace was not found");
    }
    return workspace;
  }

  async startWorkspace(userId: string, resourceId: string): Promise<WorkspaceResourceRecord> {
    const policy = this.dependencies.policy();
    if (!policy.enabled) {
      throw new WorkspaceResourceError(
        "WORKSPACE_PROVIDER_DISABLED",
        "Workspace provider is disabled",
      );
    }
    this.requireCurrentLifecycleAuthority(userId, resourceId);
    const requested = this.dependencies.repository.requestStart(
      userId,
      resourceId,
      policy,
      this.now(),
    );
    if (requested === "limit") {
      throw new WorkspaceResourceError(
        "WORKSPACE_POLICY_LIMIT",
        "Daily workspace operation budget reached",
      );
    }
    if (requested === "disabled") {
      throw new WorkspaceResourceError(
        "WORKSPACE_PROVIDER_DISABLED",
        "Workspace provider is disabled",
      );
    }
    if (!requested) {
      throw new WorkspaceResourceError("WORKSPACE_NOT_FOUND", "Workspace was not found");
    }
    if (["usable", "create_pending", "create_submitted"].includes(requested.state))
      return requested;
    await this.applyPersistentLifecycle(requested);
    const current = this.getWorkspace(userId, resourceId);
    if (current.state === "usable")
      await this.emit("start", current, current.lastOutcome ?? "running");
    return current;
  }

  async stopWorkspace(userId: string, resourceId: string): Promise<WorkspaceResourceRecord> {
    this.requireCurrentLifecycleAuthority(userId, resourceId);
    const requested = this.dependencies.repository.requestStop(userId, resourceId, this.now());
    if (!requested) {
      throw new WorkspaceResourceError("WORKSPACE_NOT_FOUND", "Workspace was not found");
    }
    if (["stopped", "deleted"].includes(requested.state)) {
      await this.emit("stop", requested, requested.lastOutcome ?? requested.state);
      return requested;
    }
    await this.applyPersistentLifecycle(requested);
    const current = this.getWorkspace(userId, resourceId);
    if (current.state === "stopped")
      await this.emit("stop", current, current.lastOutcome ?? "stopped");
    return current;
  }

  async deleteWorkspace(
    userId: string,
    resourceId: string,
    expectedGeneration: number,
  ): Promise<WorkspaceResourceRecord> {
    this.requireCurrentLifecycleAuthority(userId, resourceId);
    const requested = this.dependencies.repository.requestDelete(
      userId,
      resourceId,
      expectedGeneration,
      this.now(),
    );
    if (requested === "conflict") {
      throw new WorkspaceResourceError(
        "WORKSPACE_GENERATION_CONFLICT",
        "Workspace generation changed; refresh it before deleting",
      );
    }
    if (!requested) {
      throw new WorkspaceResourceError("WORKSPACE_NOT_FOUND", "Workspace was not found");
    }
    await this.applyPersistentLifecycle(requested);
    const current = this.getWorkspace(userId, resourceId);
    if (current.state === "deleted")
      await this.emit("delete", current, current.lastOutcome ?? "deleted");
    return current;
  }

  private requireCurrentLifecycleAuthority(userId: string, resourceId: string): void {
    const owned = this.dependencies.repository.getOwned(userId, resourceId);
    if (!owned) {
      throw new WorkspaceResourceError("WORKSPACE_NOT_FOUND", "Workspace was not found");
    }
    if (!this.dependencies.repository.hasCurrentAuthorization(userId, resourceId)) {
      throw new WorkspaceResourceError(
        "WORKSPACE_RESOURCE_INVALID",
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
    const maximumPasses = this.listResources(userId).length + 1;
    for (let pass = 0; pass < maximumPasses; pass++) {
      if (!(await this.reconcileOnce(userId))) break;
    }
    const unfinished = this.listResources(userId).filter((resource) =>
      resource.retentionPolicy === "persistent"
        ? !["stopped", "deleted", "rejected"].includes(resource.state)
        : !["deleted", "rejected"].includes(resource.state),
    );
    if (unfinished.length > 0) {
      throw new WorkspaceResourceError(
        "WORKSPACE_CREATE_PENDING",
        "Workspace operations must stop before disconnecting GitHub",
      );
    }
  }

  async reconcileOnce(userId?: string): Promise<boolean> {
    const policy = this.dependencies.policy();
    const rebindUser = this.dependencies.repository.nextAuthorizationRebindUser(
      this.dependencies.providerId,
      userId,
    );
    if (rebindUser) {
      try {
        if ((await this.rebindAfterAuthorization(rebindUser)) > 0) return true;
      } catch {
        // Keep the stale authorization generation fenced and retry later.
      }
    }
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
      try {
        await this.applyPersistentLifecycle(record);
      } catch {
        this.dependencies.repository.releaseClaim(
          record.id,
          record.generation,
          claimId,
          "lifecycle_reconcile_required",
          this.now(),
        );
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
        this.dependencies.repository.releaseClaim(
          record.id,
          record.generation,
          claimId,
          "manual_ambiguous_cleanup_required",
          this.now(),
        );
      }
    } catch {
      this.dependencies.repository.releaseClaim(
        record.id,
        record.generation,
        claimId,
        "reconcile_retry_required",
        this.now(),
      );
    }
    return true;
  }

  private async applyPersistentLifecycle(record: WorkspaceResourceRecord): Promise<void> {
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
          candidate.repositoryFullName.toLowerCase() === record.repositoryFullName.toLowerCase() &&
          candidate.ref === record.requestedRef &&
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
    const exact = await provider.getExact(credential, resourceName);
    if (!exact) {
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
      } else if (
        !this.dependencies.repository.completeAbsentPersistentLifecycle(
          record.id,
          record.generation,
          record.desiredState,
          "verified_externally_absent",
          this.now(),
        )
      ) {
        return;
      }
      return;
    }
    if (
      exact.name !== resourceName ||
      exact.ownerId !== record.externalOwnerId ||
      exact.billableOwnerId !== record.billableOwnerId ||
      exact.repositoryId !== record.repositoryId ||
      exact.repositoryFullName.toLowerCase() !== record.repositoryFullName.toLowerCase() ||
      exact.ref !== record.requestedRef ||
      exact.displayName !== record.operationMarker
    ) {
      throw new WorkspaceResourceError(
        "WORKSPACE_RESOURCE_INVALID",
        "Workspace exact identity changed",
      );
    }
    if (record.desiredState === "running") {
      if (exact.state !== "available") await provider.startExact(credential, resourceName);
      const observed = await provider.getExact(credential, resourceName);
      if (observed?.state === "available") {
        await provider.probeConnector(credential, resourceName);
        this.dependencies.repository.completeLifecycle({
          resourceId: record.id,
          generation: record.generation,
          desiredState: "running",
          observedState: "running",
          state: "usable",
          outcome: "verified_running",
          now: this.now(),
        });
      } else {
        this.dependencies.repository.markLifecyclePending(
          record.id,
          record.generation,
          "start_pending",
          "provisioning",
          this.now(),
        );
      }
      return;
    }
    await provider.stopExact(credential, resourceName);
    if (record.desiredState === "deleted") {
      await provider.deleteExact(credential, resourceName);
      const observed = await provider.getExact(credential, resourceName);
      if (!observed) {
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
        this.dependencies.repository.markLifecyclePending(
          record.id,
          record.generation,
          "delete_pending",
          "deleting",
          this.now(),
        );
      }
      return;
    }
    const observed = await provider.getExact(credential, resourceName);
    if (observed?.state === "shutdown") {
      this.dependencies.repository.completeLifecycle({
        resourceId: record.id,
        generation: record.generation,
        desiredState: "stopped",
        observedState: "stopped",
        state: "stopped",
        outcome: "verified_stopped",
        now: this.now(),
      });
    } else {
      this.dependencies.repository.markLifecyclePending(
        record.id,
        record.generation,
        "stop_pending",
        observed ? "running" : "absent",
        this.now(),
      );
    }
  }

  private async reconcileCreation(
    record: WorkspaceResourceRecord,
    claimId: string,
    credential: string,
    provider: WorkspaceProviderAdapter,
    policy: WorkspaceResourcePolicy,
  ): Promise<void> {
    const identity = await provider.getIdentity(credential);
    const candidates = record.providerResourceName
      ? [await provider.getExact(credential, record.providerResourceName)].filter(
          (value): value is WorkspaceProviderResource => value !== null,
        )
      : (await provider.listOwned(credential)).filter(
          (resource) =>
            resource.displayName === record.operationMarker &&
            resource.repositoryId === record.repositoryId &&
            resource.ref === record.requestedRef &&
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
    record: WorkspaceResourceRecord,
    claimId: string,
    credential: string,
    provider: WorkspaceProviderAdapter,
  ): Promise<void> {
    let resourceName = record.providerResourceName;
    if (!resourceName) {
      const identity = await provider.getIdentity(credential);
      const matches = (await provider.listOwned(credential)).filter(
        (resource) =>
          resource.displayName === record.operationMarker &&
          resource.repositoryId === record.repositoryId &&
          resource.ref === record.requestedRef &&
          resource.ownerId === identity.id &&
          (!this.requiresPersonalBilling() || resource.billableOwnerId === identity.id) &&
          resource.createdAt >= record.createdAt - 60_000 &&
          resource.createdAt <= record.createDeadlineAt + PROVIDER_CLOCK_SKEW_MS,
      );
      if (matches.length > 1) {
        this.dependencies.repository.releaseClaim(
          record.id,
          record.generation,
          claimId,
          "multiple_cleanup_matches",
          this.now(),
        );
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
      if (
        exact.name !== resourceName ||
        exact.displayName !== record.operationMarker ||
        exact.ownerId !== record.externalOwnerId ||
        exact.billableOwnerId !== record.billableOwnerId ||
        exact.repositoryId !== record.repositoryId ||
        exact.repositoryFullName.toLowerCase() !== record.repositoryFullName.toLowerCase() ||
        exact.ref !== record.requestedRef
      ) {
        this.dependencies.repository.releaseClaim(
          record.id,
          record.generation,
          claimId,
          "exact_identity_mismatch",
          this.now(),
        );
        return;
      }
      if (
        !this.dependencies.repository.recordRequiredCleanupMutation({
          resourceId: record.id,
          generation: record.generation,
          claimId,
          kind: "stop",
          now: this.now(),
        })
      ) {
        return;
      }
      const stopped = await provider.stopExact(credential, resourceName);
      if (stopped !== "absent") {
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
        await provider.deleteExact(credential, resourceName);
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
      this.dependencies.repository.releaseClaim(
        record.id,
        record.generation,
        claimId,
        "delete_pending",
        this.now(),
      );
    }
  }

  start(): void {
    if (this.timer) return;
    void this.runScheduledReconcile();
    this.timer = setInterval(
      () => void this.runScheduledReconcile(),
      this.dependencies.policy().reconcileIntervalMs,
    );
    this.timer.unref();
  }

  private async runScheduledReconcile(): Promise<void> {
    if (this.scheduledReconcileRunning) return;
    this.scheduledReconcileRunning = true;
    try {
      await this.reconcileOnce();
    } finally {
      this.scheduledReconcileRunning = false;
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async emit(
    action: WorkspaceResourceAuditEvent["action"],
    record: WorkspaceResourceRecord,
    outcome: string,
  ): Promise<void> {
    await this.dependencies.audit?.({
      action,
      userId: record.userId,
      provider: record.provider,
      resourceId: record.id,
      outcome,
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
