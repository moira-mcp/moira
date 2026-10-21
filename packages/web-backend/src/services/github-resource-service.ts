import { createHash, createHmac } from "node:crypto";
import {
  CodespaceConnectionRepository,
  CodespaceResourceError,
  GitHubResourceRepository,
  controllerRequestIdSchema,
  controllerGitHubLifecycleSchema,
  controllerOperationSchema,
  githubAssignmentSchema,
  githubCreationSettingsSchema,
  githubCreatePreflightSchema,
  githubMachineOffersSchema,
  githubProviderActionSchema,
  githubResourceAuthoritySchema,
  getAccountAccessDenial,
  gitFetchRefSchema,
  CodespaceRepositorySettings,
  type CodespaceConnectionService,
  type CodespaceSummaryView,
  type CodespaceResourceListView,
  codespaceObservationErrorCode,
  type CodespaceProviderResource,
  type GitHubResourceIdentity,
  type LocalDeviceService,
  type LocalControllerClient,
  type ControllerGitHubLifecycle,
  type ControllerOperation,
  githubProvisionProofSchema,
  githubRenewEnrollmentSchema,
  WorkspaceAuthRepository,
  getCodespaceGitHubConfig,
  getBaseUrl,
  canonicalJson,
  type GitHubProvisionProof,
  type CodespaceGuidanceSituation,
  type CodespaceResourcePolicy,
  CODESPACE_IDLE_TIMEOUT_MINUTES,
  ScopedCredentialError,
  scopedCredentialFailureOutcome,
  type ScopedCredentialErrorCode,
  codespaceLifecycleErrorCode,
  type GitHubProviderFailure,
  providerFailureSchema,
} from "@mcp-moira/shared";
import type Database from "better-sqlite3";
import { HttpGitHubCodespaceClient } from "./github-codespace-client.js";
import type { WorkspaceBinding } from "./workspace-router.js";

/** Live owner lifecycle, fixed provider API and minimal cloud authority; no reconciliation worker. */
export class GitHubResourceService {
  constructor(
    readonly identities: GitHubResourceRepository,
    private readonly connection: Pick<CodespaceConnectionService, "getAccessToken" | "getStatus">,
    private readonly client: HttpGitHubCodespaceClient,
    private readonly devices: LocalDeviceService,
    private readonly controller: LocalControllerClient,
    private readonly retire: (
      userId: string,
      resourceId: string,
      throughGeneration: number,
    ) => Promise<void>,
    private readonly policy: () => CodespaceResourcePolicy,
    private readonly configuration = getCodespaceGitHubConfig,
    private readonly baseUrl = getBaseUrl,
    private readonly guestConnected: (
      binding: WorkspaceBinding,
    ) => boolean | Promise<boolean> = () => false,
  ) {}
  get db(): Database.Database {
    return this.identities.db;
  }
  private account(userId: string) {
    const account = this.db
      .prepare("SELECT blocked,approvedAt,emailVerified FROM user WHERE id=?")
      .get(userId) as
      { blocked: number; approvedAt: string | null; emailVerified: number } | undefined;
    if (
      !account ||
      getAccountAccessDenial(
        {
          ...account,
          blocked: Boolean(account.blocked),
          emailVerified: Boolean(account.emailVerified),
        },
        { requireEmailVerified: true },
      )
    )
      throw new CodespaceResourceError(
        "CODESPACE_AUTHORIZATION_REQUIRED",
        "Account authority refused",
      );
  }
  private enabled() {
    if (!this.policy().enabled)
      throw new CodespaceResourceError(
        "CODESPACE_PROVIDER_DISABLED",
        "GitHub codespaces are disabled",
      );
  }
  authority(userId: string, id: string, allowRetired = false): GitHubResourceIdentity {
    this.account(userId);
    const resource = this.identities.getOwned(userId, id);
    if (!resource) throw new CodespaceResourceError("CODESPACE_NOT_FOUND", "Resource is not owned");
    if (
      !this.identities.hasCurrentAuthorization(userId, id) ||
      (!allowRetired && resource.retirement === "retired")
    )
      throw new CodespaceResourceError(
        "CODESPACE_AUTHORIZATION_REQUIRED",
        "Resource authority refused",
      );
    if (resource.deviceId) {
      const device = this.devices.getDeviceIdentity(userId, resource.deviceId);
      if (
        device.status !== "active" ||
        device.deviceGeneration !== resource.deviceGeneration ||
        device.connectionId !== resource.deviceConnectionId
      )
        throw new CodespaceResourceError(
          "CODESPACE_AUTHORIZATION_REQUIRED",
          "Assigned controller authority changed",
        );
    }
    return resource;
  }
  private current(resource: GitHubResourceIdentity) {
    const current = this.authority(resource.userId, resource.id, resource.retirement === "retired");
    if (canonicalJson(current) !== canonicalJson(resource))
      throw new CodespaceResourceError(
        "CODESPACE_GENERATION_CONFLICT",
        "Resource authority changed before dispatch",
      );
    return current;
  }
  private async selectDevice(userId: string, deviceId?: string) {
    this.account(userId);
    const candidates = this.devices
      .listRegistered(userId)
      .devices.filter(
        (device) => device.status === "active" && (!deviceId || device.deviceId === deviceId),
      );
    if (candidates.length !== 1)
      throw new CodespaceResourceError(
        "CODESPACE_PROVIDER_UNAVAILABLE",
        candidates.length
          ? "Select an explicit registered controller"
          : "No active controller is registered for this owner",
      );
    return this.devices.getDeviceIdentity(userId, candidates[0]!.deviceId);
  }
  listRepositories(userId: string) {
    this.account(userId);
    return new CodespaceRepositorySettings(this.db).listApprovedRepositories(
      userId,
      "github-codespaces",
    );
  }
  private creationSettings(userId: string) {
    const idle = new CodespaceRepositorySettings(this.db).idlePolicy(userId);
    return githubCreationSettingsSchema.parse({
      autoStopEnabled: idle.autoStopEnabled,
      idleTimeoutMinutes: idle.idleTimeoutMinutes,
      retentionMinutes: this.policy().persistentRetentionMs / 60_000,
    });
  }
  private exact(resource: GitHubResourceIdentity, observed: CodespaceProviderResource | null) {
    if (
      observed &&
      (observed.name !== resource.providerResourceName ||
        observed.repositoryId !== resource.repositoryId ||
        observed.ownerId !== resource.externalOwnerId ||
        observed.billableOwnerId !== resource.billableOwnerId ||
        observed.repositoryFullName.toLowerCase() !== resource.repositoryFullName.toLowerCase())
    )
      throw new CodespaceResourceError(
        "CODESPACE_GENERATION_CONFLICT",
        "Provider resource identity changed",
      );
    return observed;
  }
  private async observation(userId: string, resource: GitHubResourceIdentity) {
    if (!resource.providerResourceName) return null;
    return this.exact(
      resource,
      await this.client.getExact(
        await this.connection.getAccessToken(userId),
        resource.providerResourceName,
      ),
    );
  }
  private async owner(resource: GitHubResourceIdentity) {
    if (!resource.deviceId) return null;
    try {
      const snapshot = await this.devices.snapshot(resource.userId, resource.deviceId);
      return snapshot.github.resources.find((entry) => entry.resourceId === resource.id) ?? null;
    } catch {
      return null;
    }
  }
  async getCodespace(userId: string, id: string): Promise<CodespaceSummaryView> {
    this.account(userId);
    const identity = this.identities.getOwned(userId, id);
    if (!identity) throw new CodespaceResourceError("CODESPACE_NOT_FOUND", "Resource is not owned");
    const current = this.identities.hasCurrentAuthorization(userId, id),
      owner = current ? await this.owner(identity) : null,
      observed =
        current && identity.retirement !== "retired"
          ? await this.observation(userId, identity)
          : null;
    const credential = new WorkspaceAuthRepository(this.db).getOwned(userId, id);
    let guestLive = false;
    if (
      current &&
      identity.retirement !== "retired" &&
      credential &&
      credential.resourceGeneration === identity.generation &&
      credential.authorizationGeneration === identity.authorizationGeneration &&
      owner?.environmentIdentity === credential.environmentIdentity &&
      (credential.expiresAt === null || credential.expiresAt > Date.now())
    ) {
      try {
        this.current(identity);
        guestLive = await this.guestConnected({
          kind: "workspace",
          userId,
          resourceId: id,
          resourceGeneration: credential.resourceGeneration,
          authorizationGeneration: credential.authorizationGeneration,
          environmentIdentity: credential.environmentIdentity,
          expiresAt: credential.expiresAt,
        });
      } catch {
        guestLive = false;
      }
    }
    const ownerCurrent =
      owner?.resourceGeneration === identity.generation &&
      owner.authorizationGeneration === identity.authorizationGeneration &&
      owner.repositoryId === identity.repositoryId &&
      owner.providerResourceName === identity.providerResourceName;
    const ownerRunning =
      ownerCurrent &&
      owner.state === "running" &&
      owner.environmentIdentity !== null &&
      observed?.state === "available";
    const remote =
      current && identity.retirement !== "retired" && ownerRunning && owner.remote
        ? {
            state: guestLive
              ? ("connected" as const)
              : owner.remote.state === "connected"
                ? ("unavailable" as const)
                : owner.remote.state,
          }
        : undefined;
    const setupIncomplete =
      remote?.state === "unconfigured" || remote?.state === "enrollment_unavailable";
    const state =
      identity.retirement === "retired"
        ? "deleted"
        : ownerRunning && guestLive
          ? "usable"
          : ownerRunning
            ? "start_pending"
            : owner?.state === "stopped" && observed?.state === "shutdown"
              ? "stopped"
              : owner?.state === "creating"
                ? "create_submitted"
                : owner?.state === "provisioning"
                  ? "start_pending"
                  : "ambiguous";
    return {
      codespace_id: id,
      provider: "github-codespaces",
      repository_id: identity.repositoryId,
      repository: identity.repositoryFullName,
      requested_ref: identity.requestedRef,
      current_ref: observed?.ref ?? null,
      machine: observed?.machine
        ? {
            name: observed.machine.name,
            display_name: observed.machine.displayName,
            operating_system: observed.machine.operatingSystem,
            cpu_cores: observed.machine.cpuCores,
            memory_bytes: observed.machine.memoryBytes,
            storage_bytes: observed.machine.storageBytes,
          }
        : null,
      state,
      retention_policy: "persistent",
      desired_state:
        owner?.desiredState ?? (identity.retirement === "retired" ? "deleted" : "running"),
      observed_state:
        observed?.state === "available" || observed?.state === "stopping"
          ? "running"
          : observed?.state === "shutdown"
            ? "stopped"
            : observed?.state === "starting"
              ? "provisioning"
              : (observed?.state ?? "unknown"),
      observed_at: observed ? Date.now() : null,
      lifecycle_error:
        identity.retirement === "retired"
          ? null
          : !current
            ? "CODESPACE_AUTHORIZATION_REQUIRED"
            : setupIncomplete
              ? "CODESPACE_LOCAL_SETUP_INCOMPLETE"
              : ownerRunning && !guestLive && !remote
                ? "CODESPACE_PROVIDER_UNAVAILABLE"
                : owner
                  ? null
                  : "CODESPACE_PROVIDER_UNAVAILABLE",
      generation: owner?.resourceGeneration ?? identity.generation,
      created_at: identity.createdAt,
      updated_at: owner?.observedAt ?? identity.createdAt,
      pending_request_ids: owner?.pendingRequestIds ?? [],
      ...(remote ? { remote } : {}),
      ...(identity.deviceId ? { device_id: identity.deviceId } : {}),
      ...(identity.providerResourceName
        ? {
            provider_url: `https://github.com/codespaces/${encodeURIComponent(identity.providerResourceName)}`,
          }
        : {}),
    };
  }
  async listResources(userId: string): Promise<CodespaceResourceListView> {
    const identities = this.identities
      .listOwned(userId)
      .filter((resource) => resource.retirement !== "retired");
    const observations = await Promise.allSettled(
      identities.map((resource) => this.getCodespace(userId, resource.id)),
    );
    const result: CodespaceResourceListView = { codespaces: [], unavailable: [] };
    observations.forEach((observation, index) => {
      if (observation.status === "fulfilled") {
        result.codespaces.push(observation.value);
        return;
      }
      const identity = identities[index]!;
      result.unavailable.push({
        codespace_id: identity.id,
        provider: "github-codespaces",
        repository_id: identity.repositoryId,
        repository: identity.repositoryFullName,
        requested_ref: identity.requestedRef,
        created_at: identity.createdAt,
        ...(identity.deviceId ? { device_id: identity.deviceId } : {}),
        error: { code: codespaceObservationErrorCode(observation.reason) },
      });
    });
    return result;
  }
  async refreshProviderState(userId: string) {
    const resources = await this.listResources(userId);
    return { stale: resources.unavailable.length > 0 };
  }
  private uncertainty(
    resource: GitHubResourceIdentity,
    requestId: string,
    providerFailure?: GitHubProviderFailure,
  ) {
    const error = new CodespaceResourceError(
      "WORKSPACE_OUTCOME_UNCONFIRMED",
      "Collect the original owner request; no lifecycle effect may be repeated automatically",
    );
    error.requestId = requestId;
    error.resourceId = resource.id;
    if (resource.deviceId) error.deviceId = resource.deviceId;
    if (providerFailure) error.providerFailure = providerFailure;
    return error;
  }
  private async dispatch(
    userId: string,
    resource: GitHubResourceIdentity,
    input: ControllerGitHubLifecycle,
    rebindPurpose?: "adopt" | "retire",
  ) {
    this.enabled();
    if (rebindPurpose && resource.deviceId)
      await this.rebindPreview(
        this.devices.getDeviceIdentity(userId, resource.deviceId),
        resource.id,
        rebindPurpose,
      );
    else this.authority(userId, resource.id);
    if (!resource.deviceId)
      throw new CodespaceResourceError(
        "CODESPACE_PROVIDER_UNAVAILABLE",
        "Historical controller assignment is unproved",
        "Keep the historical workspace identity and disk. Verify that its previous cloud SSH and processes have finished before assigning a controller.",
      );
    let receipt: ControllerOperation;
    try {
      receipt = controllerOperationSchema.parse(
        await this.controller.json(userId, resource.deviceId, {
          method: "POST",
          path: `/v1/controller/github/resources/${resource.id}`,
          body: input,
        }),
      );
    } catch (error) {
      if (
        error instanceof CodespaceResourceError &&
        ["CODESPACE_PROVIDER_UNAVAILABLE", "CODESPACE_AUTHORIZATION_REQUIRED"].includes(error.code)
      )
        throw error;
      throw this.uncertainty(resource, input.requestId);
    }
    if (receipt.requestId !== input.requestId)
      throw new CodespaceResourceError(
        "CODESPACE_GENERATION_CONFLICT",
        "Owner returned another request identity",
      );
    if (receipt.state === "completed" && receipt.outcome?.ok === false) {
      const failure = receipt.outcome.error,
        scopeOutcome = scopedCredentialFailureOutcome(failure.code);
      if (scopeOutcome) {
        const error = new ScopedCredentialError(
          failure.code as ScopedCredentialErrorCode,
          scopeOutcome === "unconfirmed" ? 503 : 409,
        );
        error.requestId = input.requestId;
        error.deviceId = resource.deviceId;
        error.resourceId = resource.id;
        if (failure.securityRequestId) error.securityRequestId = failure.securityRequestId;
        throw error;
      }
      if (failure.code === "WORKSPACE_OUTCOME_UNCONFIRMED")
        throw this.uncertainty(resource, input.requestId, failure.providerFailure);
      const error = new CodespaceResourceError(
        failure.code === "LOCAL_GENERATION_CONFLICT"
          ? "CODESPACE_GENERATION_CONFLICT"
          : (codespaceLifecycleErrorCode(failure.code) ?? "CODESPACE_RESOURCE_INVALID"),
        failure.message,
        failure.providerFailure && "reason" in failure.providerFailure
          ? failure.providerFailure.reason
          : undefined,
      );
      error.providerFailure = failure.providerFailure;
      error.requestId = input.requestId;
      error.deviceId = resource.deviceId;
      error.resourceId = resource.id;
      throw error;
    }
    if (receipt.state !== "completed" || !receipt.outcome?.ok)
      throw this.uncertainty(resource, input.requestId);
    return this.getCodespace(userId, resource.id);
  }
  async create(
    userId: string,
    repositoryId: string,
    ref: string,
    requestId?: string,
    options: { deviceId?: string; devcontainerPath?: string } = {},
  ) {
    const original = controllerRequestIdSchema.parse(requestId);
    gitFetchRefSchema.parse(ref);
    const repository = this.listRepositories(userId).find((entry) => entry.id === repositoryId);
    if (!repository)
      throw new CodespaceResourceError(
        "CODESPACE_AUTHORIZATION_REQUIRED",
        "Repository is not approved",
      );
    const device = await this.selectDevice(userId, options.deviceId),
      connection = new CodespaceConnectionRepository(this.db).getConnection(
        userId,
        "github-codespaces",
      );
    if (connection?.status !== "connected")
      throw new CodespaceResourceError(
        "CODESPACE_AUTHORIZATION_REQUIRED",
        "Current GitHub connection required",
      );
    const resource = this.identities.reserve({
      id: original.slice(4),
      userId,
      connectionId: connection.id,
      authorizationGeneration: new CodespaceConnectionRepository(this.db).getAuthorityGeneration(
        userId,
        connection.id,
      ),
      repositoryId: repository.id,
      repositoryFullName: repository.fullName,
      requestedRef: ref,
      devcontainerPath: options.devcontainerPath ?? null,
      operationMarker: "moira-" + createHash("sha256").update(original).digest("hex").slice(0, 24),
      providerResourceName: null,
      externalOwnerId: connection.externalAccountId,
      billableOwnerId: connection.externalAccountId,
      deviceId: device.deviceId,
      deviceGeneration: device.deviceGeneration,
      deviceConnectionId: device.connectionId,
      generation: 1,
      retirement: "uncreated",
      revokedAt: null,
      createdAt: Date.now(),
    });
    return this.dispatch(
      userId,
      resource,
      controllerGitHubLifecycleSchema.parse({
        requestId: original,
        expectedGeneration: 1,
        action: "create",
        repositoryId: resource.repositoryId,
        repositoryFullName: resource.repositoryFullName,
        ref,
        operationMarker: resource.operationMarker,
        authorizationGeneration: resource.authorizationGeneration,
        ...(options.devcontainerPath ? { devcontainerPath: options.devcontainerPath } : {}),
      }),
    );
  }
  async registerExisting(
    userId: string,
    providerName: string,
    options: { deviceId?: string; requestId: string },
  ) {
    const requestId = controllerRequestIdSchema.parse(options.requestId),
      device = await this.selectDevice(userId, options.deviceId);
    const connection = new CodespaceConnectionRepository(this.db).getConnection(
      userId,
      "github-codespaces",
    );
    if (connection?.status !== "connected")
      throw new CodespaceResourceError(
        "CODESPACE_AUTHORIZATION_REQUIRED",
        "Current GitHub connection required",
      );
    const observed = await this.client.getExact(
      await this.connection.getAccessToken(userId),
      providerName,
    );
    if (
      !observed ||
      observed.ownerId !== connection.externalAccountId ||
      observed.billableOwnerId !== connection.externalAccountId ||
      !connection.repositories.some(
        (grant) =>
          grant.externalRepositoryId === observed.repositoryId &&
          grant.fullName.toLowerCase() === observed.repositoryFullName.toLowerCase(),
      )
    )
      throw new CodespaceResourceError(
        "CODESPACE_AUTHORIZATION_REQUIRED",
        "Provider identity is not owned and approved",
      );
    const existing = this.identities
      .listOwned(userId)
      .find((resource) => resource.providerResourceName === providerName);
    if (existing) {
      if (existing.id !== requestId.slice(4)) {
        const error = new CodespaceResourceError(
          "CODESPACE_GENERATION_CONFLICT",
          "Provider resource already has a public identity; use that identity and its observed generation",
        );
        error.resourceId = existing.id;
        throw error;
      }
      this.assigned(existing, device);
      return this.getCodespace(userId, existing.id);
    }
    const registered = this.identities.reserve({
      id: requestId.slice(4),
      userId,
      connectionId: connection.id,
      authorizationGeneration: new CodespaceConnectionRepository(this.db).getAuthorityGeneration(
        userId,
        connection.id,
      ),
      repositoryId: observed.repositoryId,
      repositoryFullName: observed.repositoryFullName,
      requestedRef: observed.ref ?? "HEAD",
      devcontainerPath: null,
      operationMarker: "moira-" + createHash("sha256").update(requestId).digest("hex").slice(0, 24),
      providerResourceName: observed.name,
      externalOwnerId: observed.ownerId,
      billableOwnerId: observed.billableOwnerId,
      deviceId: device.deviceId,
      deviceGeneration: device.deviceGeneration,
      deviceConnectionId: device.connectionId,
      generation: 1,
      retirement: "owned",
      revokedAt: null,
      createdAt: observed.createdAt,
    });
    return this.getCodespace(userId, registered.id);
  }
  async adopt(
    userId: string,
    id: string,
    requestId: string,
    expectedGeneration: number,
    options: { deviceId?: string } = {},
  ) {
    this.account(userId);
    const resource = this.identities.getOwned(userId, id);
    if (!resource || resource.retirement === "retired")
      throw new CodespaceResourceError(
        "CODESPACE_GENERATION_CONFLICT",
        "Observed resource identity changed",
      );
    if (!resource.deviceId)
      throw new CodespaceResourceError(
        "CODESPACE_AUTHORIZATION_REQUIRED",
        "Historical physical custody is not proved",
        "This historical workspace has no verified controller assignment. Keep its original identity and disk; recovery requires proof that its previous cloud SSH and processes have finished before assigning a controller.",
      );
    if (resource.deviceId && options.deviceId && resource.deviceId !== options.deviceId)
      throw new CodespaceResourceError(
        "CODESPACE_GENERATION_CONFLICT",
        "Use the assigned controller and settle its original operation before changing assignment",
        "Use the assigned controller and collect or settle its original operation before changing the controller assignment.",
      );
    const device = await this.selectDevice(
      userId,
      options.deviceId ?? resource.deviceId ?? undefined,
    );
    this.assigned(resource, device);
    return this.dispatch(
      userId,
      resource,
      controllerGitHubLifecycleSchema.parse({ action: "adopt", requestId, expectedGeneration }),
      "adopt",
    );
  }
  private async rebindPreview(
    auth: { userId: string; deviceId: string; deviceGeneration: number; connectionId: string },
    id: string,
    purpose: "adopt" | "retire",
  ) {
    this.account(auth.userId);
    const resource = this.identities.getOwned(auth.userId, id);
    if (
      !resource ||
      (resource.retirement === "retired" && purpose !== "retire") ||
      (!resource.providerResourceName && (purpose !== "adopt" || resource.retirement !== "unknown"))
    )
      throw new CodespaceResourceError(
        "CODESPACE_RESOURCE_INVALID",
        "Only an exact known provider resource can be explicitly rebound; collect the original creation identity",
      );
    this.assigned(resource, auth);
    const admittedDevice = this.devices.getDeviceIdentity(auth.userId, auth.deviceId);
    this.assigned(resource, admittedDevice);
    if (admittedDevice.status !== "active")
      throw new CodespaceResourceError(
        "CODESPACE_AUTHORIZATION_REQUIRED",
        "Assigned controller authority changed",
      );
    const repository = new CodespaceConnectionRepository(this.db),
      connection = repository.getConnection(auth.userId, "github-codespaces"),
      grant = connection?.repositories.find(
        (entry) => entry.externalRepositoryId === resource.repositoryId,
      );
    if (
      connection?.status !== "connected" ||
      connection.externalAccountId !== resource.externalOwnerId ||
      connection.externalAccountId !== resource.billableOwnerId ||
      !grant
    )
      throw new CodespaceResourceError(
        "CODESPACE_AUTHORIZATION_REQUIRED",
        "Current account and numeric repository grant do not reach this assignment",
      );
    const authorizationGeneration = repository.getAuthorityGeneration(auth.userId, connection.id),
      token = await this.connection.getAccessToken(auth.userId);
    let observed: CodespaceProviderResource | null;
    if (resource.providerResourceName)
      observed = await this.client.getExact(token, resource.providerResourceName);
    else {
      const matching = (await this.client.listOwned(token)).filter(
        (candidate) => candidate.displayName === resource.operationMarker,
      );
      if (matching.length > 1)
        throw new CodespaceResourceError(
          "CODESPACE_GENERATION_CONFLICT",
          "Original provider creation identity is ambiguous",
        );
      observed = matching[0] ?? null;
    }
    if (
      observed &&
      ((resource.providerResourceName !== null &&
        observed.name !== resource.providerResourceName) ||
        observed.repositoryId !== resource.repositoryId ||
        observed.ownerId !== resource.externalOwnerId ||
        observed.billableOwnerId !== resource.billableOwnerId ||
        observed.repositoryFullName.toLowerCase() !== grant.fullName.toLowerCase())
    )
      throw new CodespaceResourceError(
        "CODESPACE_GENERATION_CONFLICT",
        "Provider identity does not match the verified assignment",
      );
    if ((purpose === "adopt" && !observed) || (purpose === "retire" && observed))
      throw new CodespaceResourceError(
        "CODESPACE_RESOURCE_INVALID",
        purpose === "adopt"
          ? "Absent workspace cannot be adopted"
          : "Only confirmed known-name absence permits retirement reauthorization",
      );
    const currentConnection = repository.getConnection(auth.userId, "github-codespaces"),
      currentDevice = this.devices.getDeviceIdentity(auth.userId, auth.deviceId);
    this.account(auth.userId);
    this.assigned(resource, currentDevice);
    if (
      currentDevice.status !== "active" ||
      canonicalJson(resource) !== canonicalJson(this.identities.getOwned(auth.userId, id)) ||
      currentConnection?.status !== "connected" ||
      currentConnection.id !== connection.id ||
      currentConnection.externalAccountId !== connection.externalAccountId ||
      repository.getAuthorityGeneration(auth.userId, connection.id) !== authorizationGeneration ||
      !currentConnection.repositories.some(
        (entry) =>
          entry.externalRepositoryId === resource.repositoryId && entry.fullName === grant.fullName,
      )
    )
      throw new CodespaceResourceError(
        "CODESPACE_GENERATION_CONFLICT",
        "Assignment authority changed during explicit proof",
      );
    return {
      resource,
      connectionId: connection.id,
      authorizationGeneration,
      repositoryFullName: grant.fullName,
      observed,
    };
  }
  async assignment(
    auth: { userId: string; deviceId: string; deviceGeneration: number; connectionId: string },
    id: string,
    purpose?: "adopt" | "retire",
  ) {
    const preview = purpose ? await this.rebindPreview(auth, id, purpose) : null;
    const resource = preview
      ? {
          ...preview.resource,
          authorizationGeneration: preview.authorizationGeneration,
          repositoryFullName: preview.repositoryFullName,
          providerResourceName: preview.observed?.name ?? preview.resource.providerResourceName,
          retirement: preview.observed ? ("owned" as const) : preview.resource.retirement,
        }
      : this.authority(auth.userId, id, true);
    this.assigned(resource, auth);
    return githubAssignmentSchema.parse({
      resourceId: id,
      resourceGeneration: resource.generation,
      authorizationGeneration: resource.authorizationGeneration,
      repositoryId: resource.repositoryId,
      repositoryFullName: resource.repositoryFullName,
      requestedRef: resource.requestedRef,
      ...(resource.devcontainerPath ? { devcontainerPath: resource.devcontainerPath } : {}),
      operationMarker: resource.operationMarker,
      providerResourceName: resource.providerResourceName,
      retirement: resource.retirement,
      state: resource.retirement === "retired" ? "deleted" : "unknown",
      desiredState: resource.retirement === "retired" ? "deleted" : "running",
      environmentIdentity: null,
      pendingRequestIds: [],
      observedAt: preview?.observed ? Date.now() : null,
      providerResource: preview?.observed ?? null,
      billableOwnerId: resource.billableOwnerId,
      creationSettings: this.creationSettings(auth.userId),
    });
  }
  private remoteCredential(
    resource: GitHubResourceIdentity,
    environmentIdentity: string,
    credential: string,
    renewalCredential: string,
  ) {
    new WorkspaceAuthRepository(this.db).issue(
      {
        userId: resource.userId,
        resourceId: resource.id,
        resourceGeneration: resource.generation,
        authorizationGeneration: resource.authorizationGeneration,
        environmentIdentity,
      },
      null,
      credential,
    );
    return {
      version: 1 as const,
      origin: new URL(this.baseUrl()).origin,
      publicOrigin: this.baseUrl(),
      resourceId: resource.id,
      resourceGeneration: resource.generation,
      authorizationGeneration: resource.authorizationGeneration,
      environmentIdentity,
      credential,
      renewal: { credential: renewalCredential },
    };
  }
  private digest(value: string) {
    return createHash("sha256").update(value).digest("hex");
  }
  private renewalCredential(resource: GitHubResourceIdentity, proof: GitHubProvisionProof) {
    const config = this.configuration();
    if (config.state !== "available")
      throw new CodespaceResourceError(
        "CODESPACE_PROVIDER_UNAVAILABLE",
        "Workspace issuer unavailable",
      );
    return createHmac("sha256", Buffer.from(config.vaultKeyHex, "hex"))
      .update(
        canonicalJson({
          purpose: "github-workspace-renewal",
          userId: resource.userId,
          resourceId: resource.id,
          repositoryId: resource.repositoryId,
          providerResourceName: resource.providerResourceName,
          ownerId: resource.externalOwnerId,
          deviceId: resource.deviceId,
          deviceGeneration: resource.deviceGeneration,
          connectionId: resource.deviceConnectionId,
          proof,
        }),
      )
      .digest("base64url");
  }
  async enroll(
    auth: { userId: string; deviceId: string; deviceGeneration: number; connectionId: string },
    id: string,
    value: unknown,
  ) {
    this.enabled();
    const proof = githubProvisionProofSchema.parse(value),
      resource = this.authority(auth.userId, id);
    this.assigned(resource, auth);
    const observed = await this.observation(auth.userId, resource);
    if (
      !observed ||
      observed.state !== "available" ||
      proof.providerResourceName !== resource.providerResourceName ||
      proof.repositoryId !== resource.repositoryId ||
      proof.repositoryFullName.toLowerCase() !== resource.repositoryFullName.toLowerCase() ||
      proof.resourceGeneration !== resource.generation ||
      proof.authorizationGeneration !== resource.authorizationGeneration
    )
      throw new CodespaceResourceError(
        "CODESPACE_GENERATION_CONFLICT",
        "Proved workspace identity does not match current assignment",
      );
    const renewalCredential = this.renewalCredential(resource, proof),
      enrollmentDigest = this.digest(canonicalJson(proof));
    return this.db
      .transaction(() => {
        this.assigned(this.current(resource), auth);
        const existing = this.db
          .prepare(
            "SELECT resourceGeneration,enrollmentDigest,currentEnvironmentIdentity,currentRequestId FROM githubWorkspaceRenewal WHERE resourceId=?",
          )
          .get(id) as
          | {
              resourceGeneration: number;
              enrollmentDigest: string;
              currentEnvironmentIdentity: string;
              currentRequestId: string;
            }
          | undefined;
        if (
          existing?.resourceGeneration === resource.generation &&
          (existing.enrollmentDigest !== enrollmentDigest ||
            existing.currentEnvironmentIdentity !== proof.environmentIdentity ||
            existing.currentRequestId !== proof.requestId)
        )
          throw new CodespaceResourceError(
            "CODESPACE_GENERATION_CONFLICT",
            "Original enrollment proof changed",
          );
        this.db
          .prepare(
            `INSERT INTO githubWorkspaceRenewal(resourceId,userId,credentialDigest,resourceGeneration,authorizationGeneration,
        root,rootDevice,rootInode,release,enrollmentRequestId,enrollmentDigest,currentRequestId,currentEnvironmentIdentity)
        VALUES(@resourceId,@userId,@credentialDigest,@resourceGeneration,@authorizationGeneration,@root,@rootDevice,@rootInode,@release,@requestId,@enrollmentDigest,@requestId,@environmentIdentity)
        ON CONFLICT(resourceId) DO UPDATE SET credentialDigest=excluded.credentialDigest,resourceGeneration=excluded.resourceGeneration,
          authorizationGeneration=excluded.authorizationGeneration,root=excluded.root,rootDevice=excluded.rootDevice,rootInode=excluded.rootInode,
          release=excluded.release,enrollmentRequestId=excluded.enrollmentRequestId,enrollmentDigest=excluded.enrollmentDigest,
          currentRequestId=excluded.currentRequestId,currentEnvironmentIdentity=excluded.currentEnvironmentIdentity`,
          )
          .run({
            ...proof,
            resourceId: id,
            userId: auth.userId,
            credentialDigest: this.digest(renewalCredential),
            enrollmentDigest,
          });
        const credential = createHmac("sha256", renewalCredential)
          .update(canonicalJson({ purpose: "workspace-life", ...proof }))
          .digest("base64url");
        return this.remoteCredential(
          resource,
          proof.environmentIdentity,
          credential,
          renewalCredential,
        );
      })
      .immediate();
  }
  async renew(id: string, bearer: string, value: unknown) {
    this.enabled();
    const input = githubRenewEnrollmentSchema.parse(value);
    const row = this.db
      .prepare("SELECT * FROM githubWorkspaceRenewal WHERE resourceId=? AND credentialDigest=?")
      .get(id, this.digest(bearer)) as
      | {
          userId: string;
          resourceGeneration: number;
          authorizationGeneration: number;
          root: string;
          rootDevice: string;
          rootInode: string;
          release: string;
          currentRequestId: string;
          currentEnvironmentIdentity: string;
        }
      | undefined;
    if (!row)
      throw new CodespaceResourceError(
        "CODESPACE_AUTHORIZATION_REQUIRED",
        "Workspace renewal authority refused",
      );
    const resource = this.authority(row.userId, id),
      observed = await this.observation(row.userId, resource);
    if (
      !observed ||
      observed.state !== "available" ||
      resource.generation !== row.resourceGeneration ||
      resource.authorizationGeneration !== row.authorizationGeneration ||
      input.root !== row.root ||
      input.rootDevice !== row.rootDevice ||
      input.rootInode !== row.rootInode ||
      input.release !== row.release
    )
      throw new CodespaceResourceError(
        "CODESPACE_GENERATION_CONFLICT",
        "Workspace renewal binding changed; controller proof required",
      );
    return this.db
      .transaction(() => {
        this.current(resource);
        const current = this.db
          .prepare("SELECT * FROM githubWorkspaceRenewal WHERE resourceId=? AND credentialDigest=?")
          .get(id, this.digest(bearer)) as typeof row;
        if (
          !current ||
          current.resourceGeneration !== resource.generation ||
          (current.currentEnvironmentIdentity === input.environmentIdentity &&
            current.currentRequestId !== input.requestId)
        )
          throw new CodespaceResourceError(
            "CODESPACE_GENERATION_CONFLICT",
            "Original boot enrollment request changed",
          );
        this.db
          .prepare(
            "UPDATE githubWorkspaceRenewal SET currentRequestId=?,currentEnvironmentIdentity=? WHERE resourceId=?",
          )
          .run(input.requestId, input.environmentIdentity, id);
        const credential = createHmac("sha256", bearer)
          .update(
            canonicalJson({
              purpose: "workspace-life",
              resourceId: id,
              resourceGeneration: resource.generation,
              authorizationGeneration: resource.authorizationGeneration,
              ...input,
            }),
          )
          .digest("base64url");
        return this.remoteCredential(resource, input.environmentIdentity, credential, bearer);
      })
      .immediate();
  }
  async startCodespace(
    userId: string,
    id: string,
    requestId?: string,
    expectedGeneration?: number,
  ) {
    return this.lifecycle(userId, id, "start", requestId, expectedGeneration);
  }
  async stopCodespace(userId: string, id: string, requestId?: string, expectedGeneration?: number) {
    return this.lifecycle(userId, id, "stop", requestId, expectedGeneration);
  }
  async resumeSetup(userId: string, id: string, requestId?: string, expectedGeneration?: number) {
    return this.lifecycle(userId, id, "resume_setup", requestId, expectedGeneration);
  }
  async deleteCodespace(
    userId: string,
    id: string,
    expectedGeneration?: number,
    options: { requestId?: string; ownerConfirmed?: boolean } = {},
  ) {
    if (!this.identities.hasCurrentAuthorization(userId, id)) {
      const resource = this.identities.getOwned(userId, id);
      if (!resource)
        throw new CodespaceResourceError("CODESPACE_NOT_FOUND", "Resource is not owned");
      return this.dispatch(
        userId,
        resource,
        controllerGitHubLifecycleSchema.parse({
          action: "delete",
          requestId: options.requestId,
          expectedGeneration,
          rebindPurpose: "retire",
        }),
        "retire",
      );
    }
    return this.lifecycle(userId, id, "delete", options.requestId, expectedGeneration);
  }
  private async lifecycle(
    userId: string,
    id: string,
    action: "start" | "stop" | "delete" | "adopt" | "resume_setup",
    requestId?: string,
    expectedGeneration?: number,
  ) {
    return this.dispatch(
      userId,
      this.authority(userId, id),
      controllerGitHubLifecycleSchema.parse({ action, requestId, expectedGeneration }),
    );
  }
  async advanceAuthority(
    auth: { userId: string; deviceId: string; deviceGeneration: number; connectionId: string },
    id: string,
    value: unknown,
  ) {
    const input = githubResourceAuthoritySchema.parse(value);
    if (input.rebindPurpose) {
      const preview = await this.rebindPreview(auth, id, input.rebindPurpose),
        resource = preview.resource;
      if (
        input.authorizationGeneration !== preview.authorizationGeneration ||
        input.providerResourceName !== (preview.observed?.name ?? resource.providerResourceName) ||
        input.resourceGeneration < resource.generation ||
        (input.retirement !== "owned" &&
          !(input.rebindPurpose === "retire" && input.retirement === "retired")) ||
        (input.resourceGeneration === resource.generation &&
          (resource.authorizationGeneration !== preview.authorizationGeneration ||
            resource.connectionId !== preview.connectionId ||
            resource.repositoryFullName !== preview.repositoryFullName))
      )
        throw new CodespaceResourceError(
          "CODESPACE_GENERATION_CONFLICT",
          "Explicit owner rebind requires its newly admitted generation and verified authority",
        );
      if (input.resourceGeneration > resource.generation || input.retirement === "retired") {
        new WorkspaceAuthRepository(this.db).revoke(id);
        this.db
          .prepare("DELETE FROM githubWorkspaceRenewal WHERE resourceId=? AND userId=?")
          .run(id, auth.userId);
      }
      await this.retire(auth.userId, id, input.resourceGeneration - 1);
      const current = await this.rebindPreview(auth, id, input.rebindPurpose);
      if (
        canonicalJson(current.resource) !== canonicalJson(resource) ||
        current.connectionId !== preview.connectionId ||
        current.authorizationGeneration !== preview.authorizationGeneration ||
        current.repositoryFullName !== preview.repositoryFullName ||
        current.observed?.name !== preview.observed?.name
      )
        throw new CodespaceResourceError(
          "CODESPACE_GENERATION_CONFLICT",
          "Explicit rebind authority changed during retirement",
        );
      return this.identities.rebind(auth.userId, id, {
        connectionId: preview.connectionId,
        authorizationGeneration: preview.authorizationGeneration,
        deviceId: auth.deviceId,
        deviceGeneration: auth.deviceGeneration,
        deviceConnectionId: auth.connectionId,
        expectedGeneration: resource.generation,
        resourceGeneration: input.resourceGeneration,
        repositoryFullName: preview.repositoryFullName,
        providerResourceName: preview.observed?.name ?? resource.providerResourceName!,
        retirement: input.retirement,
      });
    }
    const resource = this.authority(auth.userId, id, true);
    this.assigned(resource, auth);
    if (
      input.authorizationGeneration !== resource.authorizationGeneration ||
      input.resourceGeneration < resource.generation
    )
      throw new CodespaceResourceError(
        "CODESPACE_GENERATION_CONFLICT",
        "Owner security fence cannot decrease or change authorization identity",
      );
    if (
      input.providerResourceName &&
      input.providerResourceName !== resource.providerResourceName
    ) {
      const observed = await this.client.getExact(
        await this.connection.getAccessToken(auth.userId),
        input.providerResourceName,
      );
      if (
        !observed ||
        observed.displayName !== resource.operationMarker ||
        observed.repositoryId !== resource.repositoryId ||
        observed.ownerId !== resource.externalOwnerId ||
        observed.billableOwnerId !== resource.billableOwnerId
      )
        throw new CodespaceResourceError(
          "CODESPACE_GENERATION_CONFLICT",
          "Provider registration identity changed",
        );
    }
    if (input.retirement === "retired" && resource.retirement !== "retired") {
      if (
        resource.retirement !== "uncreated" &&
        (!resource.providerResourceName || (await this.observation(auth.userId, resource)))
      )
        throw new CodespaceResourceError(
          "CODESPACE_RESOURCE_INVALID",
          "Provider retirement is not confirmed",
        );
    }
    this.assigned(this.current(resource), auth);
    if (input.resourceGeneration > resource.generation || input.retirement === "retired") {
      new WorkspaceAuthRepository(this.db).revoke(id);
      this.db
        .prepare("DELETE FROM githubWorkspaceRenewal WHERE resourceId=? AND userId=?")
        .run(id, auth.userId);
    }
    if (input.resourceGeneration > 1)
      await this.retire(auth.userId, id, input.resourceGeneration - 1);
    this.assigned(this.current(resource), auth);
    return this.identities.advanceAuthority(auth.userId, id, input);
  }
  private assigned(
    resource: GitHubResourceIdentity,
    auth: { deviceId: string; deviceGeneration: number; connectionId: string },
  ) {
    if (
      resource.deviceId !== auth.deviceId ||
      resource.deviceGeneration !== auth.deviceGeneration ||
      resource.deviceConnectionId !== auth.connectionId
    )
      throw new CodespaceResourceError(
        "CODESPACE_AUTHORIZATION_REQUIRED",
        "Controller is not assigned this resource",
      );
  }
  async providerAction(
    auth: { userId: string; deviceId: string; deviceGeneration: number; connectionId: string },
    id: string,
    value: unknown,
  ) {
    const input = githubProviderActionSchema.parse(value),
      resource = this.authority(auth.userId, id, input.action === "get");
    this.assigned(resource, auth);
    if (resource.generation !== input.resourceGeneration)
      throw new CodespaceResourceError(
        "CODESPACE_GENERATION_CONFLICT",
        "Resource authority generation changed",
      );
    if (["create", "start", "stop", "delete"].includes(input.action) && resource.generation > 1)
      await this.retire(auth.userId, id, resource.generation - 1);
    if (["create", "start", "preflight", "machines"].includes(input.action)) this.enabled();
    const token = await this.connection.getAccessToken(auth.userId);
    this.assigned(this.current(resource), auth);
    if (input.action === "get") {
      if (resource.retirement === "retired") return null;
      if (resource.providerResourceName)
        return this.exact(
          resource,
          await this.client.getExact(token, resource.providerResourceName),
        );
      const candidates = (await this.client.listOwned(token)).filter(
        (observed) => observed.displayName === resource.operationMarker,
      );
      if (candidates.length > 1)
        throw new CodespaceResourceError(
          "CODESPACE_GENERATION_CONFLICT",
          "Provider creation identity is ambiguous",
        );
      const observed = candidates[0] ?? null;
      if (
        observed &&
        (observed.repositoryId !== resource.repositoryId ||
          observed.ownerId !== resource.externalOwnerId ||
          observed.billableOwnerId !== resource.billableOwnerId ||
          observed.repositoryFullName.toLowerCase() !== resource.repositoryFullName.toLowerCase())
      )
        throw new CodespaceResourceError(
          "CODESPACE_GENERATION_CONFLICT",
          "Provider creation identity changed",
        );
      return observed;
    }
    const repository = {
      id: resource.repositoryId,
      fullName: resource.repositoryFullName,
      private: true,
    };
    if (input.action === "preflight") {
      const result = githubCreatePreflightSchema.parse(
        await this.client.preflightCreate(token, repository, resource.requestedRef),
      );
      this.assigned(this.current(resource), auth);
      return result;
    }
    if (input.action === "machines") {
      const result = githubMachineOffersSchema.parse(
        await this.client.listMachines(token, repository, resource.requestedRef),
      );
      this.assigned(this.current(resource), auth);
      return result;
    }
    if (input.action === "create") {
      if (resource.providerResourceName)
        throw new CodespaceResourceError(
          "CODESPACE_GENERATION_CONFLICT",
          "Resource already exists",
        );
      if (resource.retirement !== "uncreated")
        throw new CodespaceResourceError(
          "WORKSPACE_OUTCOME_UNCONFIRMED",
          "Original creation may already have been dispatched; collect its owner receipt",
        );
      // The owner chooses progression; the secret-bearing broker still fences actual billing.
      const preflight = await this.client.preflightCreate(token, repository, resource.requestedRef);
      if (preflight.billableOwnerId !== resource.billableOwnerId)
        throw new CodespaceResourceError(
          "CODESPACE_BILLING_UNSUPPORTED",
          "Provider payer does not match current account",
        );
      const settings = this.creationSettings(auth.userId),
        prepared = input.prepared;
      if (
        prepared.retentionMinutes !== settings.retentionMinutes ||
        (settings.autoStopEnabled
          ? prepared.idleTimeoutMinutes !== settings.idleTimeoutMinutes
          : prepared.idleTimeoutMinutes !== CODESPACE_IDLE_TIMEOUT_MINUTES.maximum)
      )
        throw new CodespaceResourceError(
          "CODESPACE_GENERATION_CONFLICT",
          "Account creation settings changed; inspect the original owner operation",
        );
      this.assigned(this.current(resource), auth);
      this.identities.markCreationSubmitted(auth.userId, id, resource.generation);
      const result = await this.client.create(token, {
        repository,
        ref: resource.requestedRef,
        machine: prepared.machine,
        operationMarker: resource.operationMarker,
        idleTimeoutMinutes: prepared.idleTimeoutMinutes,
        retentionMinutes: prepared.retentionMinutes,
        ...(resource.devcontainerPath ? { devcontainerPath: resource.devcontainerPath } : {}),
      });
      try {
        this.assigned(this.current({ ...resource, retirement: "unknown" }), auth);
        if (result.outcome === "rejected")
          this.identities.observeCreation(auth.userId, id, resource.generation, "refused");
        else if (result.resource)
          this.identities.observeCreation(auth.userId, id, resource.generation, result.resource);
      } catch (error) {
        if (error instanceof CodespaceResourceError) {
          const reply =
            result.outcome === "accepted"
              ? result.providerReply
              : result.providerFailure && "status" in result.providerFailure
                ? result.providerFailure
                : undefined;
          if (result.outcome === "rejected") return result;
          const uncertain = new CodespaceResourceError(
            "WORKSPACE_OUTCOME_UNCONFIRMED",
            "The provider accepted the original creation but its authority publication is unconfirmed; collect the original owner request",
          );
          if (reply)
            uncertain.providerFailure = providerFailureSchema.parse({
              kind: "authority_changed",
              phase: "publication",
              status: reply.status,
              ...(reply.githubRequestId ? { githubRequestId: reply.githubRequestId } : {}),
              ...(result.outcome === "accepted" && result.resource
                ? { resource: result.resource }
                : {}),
            });
          throw uncertain;
        }
        throw error;
      }
      return result;
    }
    if (!resource.providerResourceName)
      throw new CodespaceResourceError(
        "CODESPACE_RESOURCE_INVALID",
        "Provider creation identity remains unknown; collect original owner request",
      );
    const observed = await this.observation(auth.userId, resource);
    this.assigned(this.current(resource), auth);
    if (input.action === "delete" && observed === null) return "absent" as const;
    switch (input.action) {
      case "start":
        return this.client.startExact(token, resource.providerResourceName);
      case "stop":
        return this.client.stopExact(token, resource.providerResourceName);
      case "delete":
        return this.client.deleteExact(token, resource.providerResourceName);
    }
  }
  async setupSituation(userId: string, repositoryId?: string): Promise<CodespaceGuidanceSituation> {
    if (!this.policy().enabled) return "instance_disabled";
    const status = this.connection.getStatus(userId);
    if (status.state !== "connected") return "connection_required";
    const repositories = this.listRepositories(userId);
    if (
      !repositories.length ||
      (repositoryId && !repositories.some((repository) => repository.id === repositoryId))
    )
      return "repository_not_approved";
    const devices = await this.devices.listOwned(userId);
    return devices.devices.some(
      (device) => device.status === "active" && device.owner.state === "available",
    )
      ? "ready"
      : "connection_required";
  }
  setupGuidance(situation: CodespaceGuidanceSituation) {
    const guidance = this.client.guidance();
    return {
      provider: "github-codespaces",
      situation,
      links: guidance.links,
      instruction: guidance.instructions[situation] ?? null,
    };
  }
}
