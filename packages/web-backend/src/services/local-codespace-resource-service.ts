import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { z } from "zod";
import {
  CODESPACE_PROVIDER_LOCAL,
  CodespaceResourceError,
  LocalDeviceError,
  LocalResourceRepository,
  controllerRequestIdSchema,
  localRepositoryTargetId,
  parseLocalRepositoryTargetId,
  codespaceObservationErrorCode,
  selectCodespaceDiscoveryView,
  type CodespaceDiscoveryView,
  type LocalDeviceObservation,
  type LocalDeviceService,
  type CodespaceSummaryView,
  type CodespaceResourceListView,
  type LocalResourceIdentity,
  type CodespaceRepositoryTarget,
  type CodespaceGuidanceSituation,
  type ControllerResourceRegistration,
} from "@mcp-moira/shared";
import { LocalCodespaceProvider, localCodespaceCredential } from "./local-codespace-provider.js";

/** A Local resource is an authority/route record; the device owns its lifecycle and current state. */
export class LocalCodespaceResourceService {
  constructor(
    readonly repository: LocalResourceRepository,
    readonly devices: LocalDeviceService,
    private readonly provider: LocalCodespaceProvider,
    private readonly sqlite: Database.Database,
    private readonly now: () => number = Date.now,
    private readonly verifyGitHubGrant?: (
      userId: string,
      repository: {
        fullName: string;
        private: boolean;
        allowPush: boolean;
        allowPullRequests?: boolean;
      },
    ) => Promise<void>,
  ) {}

  private discoveryObservation(userId: string, observation?: LocalDeviceObservation) {
    if (observation && observation.userId !== userId)
      throw new LocalDeviceError("LOCAL_UNAUTHORIZED", "Observation belongs to another caller.");
    return observation ?? this.devices.createObservation(userId);
  }
  async listRepositories(
    userId: string,
    options: { observation?: LocalDeviceObservation } = {},
  ): Promise<CodespaceRepositoryTarget[]> {
    const owned = await this.discoveryObservation(userId, options.observation).listOwned();
    return owned.devices.flatMap((device) =>
      device.owner.state === "available" && device.owner.local.state === "configured"
        ? device.owner.local.policy.repositories.map((repository) => ({
            id: localRepositoryTargetId(device.deviceId, repository.id),
            fullName: repository.fullName,
            private: repository.private,
          }))
        : [],
    );
  }
  async listResources(
    userId: string,
    options: { view?: CodespaceDiscoveryView; observation?: LocalDeviceObservation } = {},
  ): Promise<CodespaceResourceListView> {
    const identities = this.repository
      .listOwned(userId)
      .filter((resource) => (options.view === "history") === (resource.retiredAt !== null));
    const observation = this.discoveryObservation(userId, options.observation);
    const observations = await Promise.allSettled(
      identities.map((resource) => this.observeCodespace(userId, resource.id, observation)),
    );
    const result: CodespaceResourceListView = { codespaces: [], unavailable: [] };
    observations.forEach((observation, index) => {
      if (observation.status === "fulfilled") {
        result.codespaces.push(observation.value);
        return;
      }
      const identity = identities[index]!,
        error: unknown = observation.reason,
        deviceId =
          (error instanceof CodespaceResourceError ? error.deviceId : undefined) ??
          this.devices.getBinding(userId, identity.id)?.deviceId;
      result.unavailable.push({
        codespace_id: identity.id,
        provider: CODESPACE_PROVIDER_LOCAL,
        repository_id: identity.repositoryId,
        repository: identity.repositoryFullName,
        requested_ref: identity.requestedRef,
        created_at: identity.createdAt,
        ...(deviceId ? { device_id: deviceId } : {}),
        ...(error instanceof CodespaceResourceError && error.pendingRequestIds !== undefined
          ? { pending_request_ids: error.pendingRequestIds }
          : {}),
        error: { code: codespaceObservationErrorCode(error) },
      });
    });
    return selectCodespaceDiscoveryView(result, options.view);
  }
  private summary(
    resource: LocalResourceIdentity,
    value: Pick<CodespaceSummaryView, "state" | "desired_state" | "observed_state" | "generation"> &
      Partial<CodespaceSummaryView>,
  ): CodespaceSummaryView {
    return {
      codespace_id: resource.id,
      provider: CODESPACE_PROVIDER_LOCAL,
      repository_id: resource.repositoryId,
      repository: resource.repositoryFullName,
      requested_ref: resource.requestedRef,
      current_ref: null,
      machine: null,
      retention_policy: "persistent",
      observed_at: null,
      lifecycle_error: null,
      created_at: resource.createdAt,
      updated_at: resource.createdAt,
      ...value,
    };
  }
  async getCodespace(userId: string, resourceId: string): Promise<CodespaceSummaryView> {
    return this.observeCodespace(userId, resourceId);
  }
  private async observeCodespace(
    userId: string,
    resourceId: string,
    observation?: LocalDeviceObservation,
  ): Promise<CodespaceSummaryView> {
    const resource = this.repository.getOwned(userId, resourceId);
    if (!resource)
      throw new CodespaceResourceError("CODESPACE_NOT_FOUND", "Local resource was not found.");
    if (resource.retiredAt !== null)
      return this.summary(resource, {
        state: "deleted",
        desired_state: "deleted",
        observed_state: "absent",
        generation: resource.retiredGeneration!,
        updated_at: resource.retiredAt,
      });
    const binding = this.devices.getBinding(userId, resourceId);
    if (!binding)
      throw new CodespaceResourceError(
        "CODESPACE_AUTHORIZATION_REQUIRED",
        "Local resource binding is missing.",
      );
    try {
      const snapshot = observation
        ? await observation.localSnapshot(binding.deviceId)
        : await this.devices.localSnapshot(userId, binding.deviceId);
      const ownedResource = snapshot.resources.find((entry) => entry.resourceId === resourceId);
      const pendingRequestIds =
        snapshot.pendingResourceOperations.find((entry) => entry.resourceId === resourceId)
          ?.requestIds ?? [];
      const actual = await this.provider.getExact(
        localCodespaceCredential(userId),
        resourceId,
        snapshot,
      );
      const unavailable = () => {
        const error = new CodespaceResourceError(
          pendingRequestIds.length
            ? "CODESPACE_LOCAL_CREATION_UNKNOWN"
            : "CODESPACE_PROVIDER_UNAVAILABLE",
          "The owner has no current resource observation; collect the original request when present.",
          pendingRequestIds.length
            ? "Original requests: " + pendingRequestIds.join(", ")
            : undefined,
        );
        error.requestId = pendingRequestIds[0];
        error.pendingRequestIds = pendingRequestIds;
        error.deviceId = binding.deviceId;
        error.resourceId = resourceId;
        return error;
      };
      if (!ownedResource) throw unavailable();
      const desired = ownedResource.space?.desiredState;
      if (desired !== "running" && desired !== "stopped" && desired !== "deleted")
        throw unavailable();
      const common: Pick<
        CodespaceSummaryView,
        "generation" | "pending_request_ids" | "device_id" | "desired_state"
      > = {
        generation: ownedResource.resourceGeneration,
        pending_request_ids: pendingRequestIds,
        device_id: binding.deviceId,
        desired_state: desired,
      };
      if (!actual)
        return this.summary(resource, {
          ...common,
          state: "ambiguous",
          observed_state: "unknown",
          lifecycle_error: "CODESPACE_LOCAL_CREATION_UNKNOWN",
          updated_at: snapshot.observedAt,
        });
      const state =
        actual.state === "available"
          ? "usable"
          : actual.state === "shutdown"
            ? "stopped"
            : actual.state === "starting"
              ? "start_pending"
              : actual.state === "stopping"
                ? "stop_pending"
                : "ambiguous";
      return this.summary(resource, {
        ...common,
        machine: actual.machine
          ? {
              name: actual.machine.name,
              display_name: actual.machine.displayName,
              operating_system: actual.machine.operatingSystem,
              cpu_cores: actual.machine.cpuCores,
              memory_bytes: actual.machine.memoryBytes,
              storage_bytes: actual.machine.storageBytes,
            }
          : null,
        state,
        observed_state:
          actual.state === "available"
            ? "running"
            : actual.state === "shutdown"
              ? "stopped"
              : "unknown",
        current_ref: actual.ref,
        observed_at: snapshot.observedAt,
        updated_at: snapshot.observedAt,
        lifecycle_error: actual.stateError ?? null,
        ...(actual.remote ? { remote: actual.remote } : {}),
        ...(actual.setupFailure ? { setup_failure: actual.setupFailure } : {}),
      });
    } catch (error) {
      this.failure(error);
    }
  }
  async create(userId: string, repositoryId: string, requestedRef: string, requestId?: string) {
    const operationId = this.requestIdentity(requestId);
    const target = parseLocalRepositoryTargetId(repositoryId);
    const device = await this.devices.getActiveDevice(userId, target.deviceId);
    const repository = device.owner.local.policy.repositories.find(
      (entry) => entry.id === target.repositoryId,
    );
    if (!repository || !device.owner.local.policy.enabled)
      throw new CodespaceResourceError(
        "CODESPACE_AUTHORIZATION_REQUIRED",
        "The owner has not admitted this work.",
      );
    if (!requestedRef || requestedRef.length > 255 || requestedRef.includes("\0"))
      throw new CodespaceResourceError(
        "CODESPACE_RESOURCE_INVALID",
        "An explicit repository ref is required.",
      );
    const resourceId = operationId.slice(4),
      operationMarker =
        "moira-" + createHash("sha256").update(operationId).digest("hex").slice(0, 24);
    const reserved = this.repository.getOwned(userId, resourceId);
    if (reserved) {
      if (
        reserved.retiredAt !== null ||
        reserved.repositoryId !== repositoryId ||
        reserved.requestedRef !== requestedRef ||
        reserved.operationMarker !== operationMarker
      )
        throw new CodespaceResourceError(
          "CODESPACE_GENERATION_CONFLICT",
          "Creation identity changed.",
        );
      try {
        const operation = await this.devices.getOperation(userId, device.deviceId, operationId);
        if (operation.state === "completed") {
          this.devices.resourceOperationResult(operation);
          return this.getCodespace(userId, resourceId);
        }
        if (operation.state !== "absent")
          throw new LocalDeviceError(
            "LOCAL_OUTCOME_UNCONFIRMED",
            "Collect the original creation request; its owner outcome is not confirmed.",
            operationId,
          );
        // The caller explicitly repeated this same immutable request after a confirmed
        // absent admission. The owner still receives the original identity and payload.
      } catch (error) {
        this.failure(error, { requestId: operationId, deviceId: device.deviceId, resourceId });
      }
    }
    await this.registerRoute(userId, device.deviceId, {
      resourceId,
      repositoryId: repository.id,
      resourceGeneration: 1,
      operationMarker,
      ref: requestedRef,
    });
    try {
      await this.devices.executeResourceLifecycle(userId, device.deviceId, resourceId, {
        requestId: operationId,
        expectedGeneration: 1,
        action: "create",
        repositoryId: repository.id,
        ref: requestedRef,
        operationMarker,
      });
      return await this.getCodespace(userId, resourceId);
    } catch (error) {
      this.failure(error, { requestId: operationId, deviceId: device.deviceId, resourceId });
    }
  }
  async registerRoute(userId: string, deviceId: string, input: ControllerResourceRegistration) {
    const device = await this.devices.getActiveDevice(userId, deviceId);
    const repository = device.owner.local.policy.repositories.find(
      (entry) => entry.id === input.repositoryId,
    );
    if (!repository || !device.owner.local.policy.enabled)
      throw new CodespaceResourceError(
        "CODESPACE_AUTHORIZATION_REQUIRED",
        "The owner has not admitted this repository.",
      );
    if (repository.private || repository.allowPush || repository.allowPullRequests) {
      if (!this.verifyGitHubGrant)
        throw new CodespaceResourceError(
          "CODESPACE_AUTHORIZATION_REQUIRED",
          "Current GitHub repository authority is unavailable.",
        );
      await this.verifyGitHubGrant(userId, repository);
    }
    const resourceId = input.resourceId,
      repositoryId = localRepositoryTargetId(deviceId, input.repositoryId),
      requestedRef = input.ref,
      operationMarker = input.operationMarker;
    const existing = this.repository.getOwned(userId, resourceId);
    if (existing) {
      const binding = this.devices.getBinding(userId, resourceId);
      if (
        existing.repositoryId !== repositoryId ||
        existing.requestedRef !== requestedRef ||
        existing.operationMarker !== operationMarker ||
        existing.routeGeneration !== input.resourceGeneration ||
        existing.retiredAt !== null ||
        !binding ||
        binding.deviceId !== deviceId
      )
        throw new CodespaceResourceError(
          "CODESPACE_GENERATION_CONFLICT",
          "Resource registration identity changed.",
        );
      return {
        resourceId,
        repositoryId: input.repositoryId,
        resourceGeneration: existing.routeGeneration,
      };
    }
    const connection = this.sqlite
      .prepare(
        "SELECT credentialGeneration FROM codespaceConnection WHERE id=? AND userId=? AND status='connected'",
      )
      .get(device.connectionId, userId) as { credentialGeneration: number } | undefined;
    if (!connection)
      throw new CodespaceResourceError(
        "CODESPACE_AUTHORIZATION_REQUIRED",
        "Device connection changed.",
      );
    const machine = device.owner.local.policy.machine,
      now = this.now();
    this.sqlite
      .transaction(() => {
        const current = this.devices.getDeviceIdentity(userId, device.deviceId);
        if (
          current.status !== "active" ||
          current.deviceGeneration !== device.deviceGeneration ||
          current.connectionId !== device.connectionId
        )
          throw new CodespaceResourceError(
            "CODESPACE_GENERATION_CONFLICT",
            "Device connection changed.",
          );
        this.repository.reserve({
          id: resourceId,
          userId,
          connectionId: device.connectionId,
          authorizationGeneration: connection.credentialGeneration,
          repositoryId,
          repositoryFullName: repository.fullName,
          requestedRef,
          operationMarker,
          routeGeneration: input.resourceGeneration,
          createdAt: now,
          retiredAt: null,
          retiredGeneration: null,
          retiredRequestId: null,
        });
        this.devices.bindResource({
          userId,
          deviceId: device.deviceId,
          deviceGeneration: device.deviceGeneration,
          connectionId: device.connectionId,
          resourceId,
          repositoryId: repository.id,
          profileId: machine.name,
        });
      })
      .immediate();

    return {
      resourceId,
      repositoryId: input.repositoryId,
      resourceGeneration: input.resourceGeneration,
    };
  }
  async ensureRunning(userId: string, resourceId: string) {
    const resource = await this.getCodespace(userId, resourceId);
    if (resource.state !== "usable")
      throw new CodespaceResourceError(
        "CODESPACE_NOT_RUNNING",
        "Start the owned Local environment explicitly.",
      );
    return resource;
  }
  private async lifecycle(
    userId: string,
    resourceId: string,
    action: "start" | "resume_setup" | "stop" | "delete",
    requestId: string | undefined,
    expectedGeneration?: number,
    ownerConfirmed = false,
  ) {
    const operationId = this.requestIdentity(requestId);
    const resource = this.repository.getOwned(userId, resourceId),
      binding = this.devices.getBinding(userId, resourceId);
    if (!resource || !binding || resource.retiredAt !== null)
      throw new CodespaceResourceError("CODESPACE_NOT_FOUND", "Local resource was not found.");
    if (!Number.isSafeInteger(expectedGeneration) || !expectedGeneration || expectedGeneration < 1)
      throw new CodespaceResourceError(
        "CODESPACE_RESOURCE_INVALID",
        "The observed owner resource generation is required.",
      );
    const common = { requestId: operationId, expectedGeneration };
    try {
      const result = await this.devices.executeResourceLifecycle(
        userId,
        binding.deviceId,
        resourceId,
        action === "delete" ? { ...common, action, ownerConfirmed } : { ...common, action },
      );
      let deletedGeneration: number | undefined;
      if (action === "delete") {
        const completed = z
          .object({
            resourceId: z.literal(resourceId),
            resourceGeneration: z.number().int().positive().safe(),
          })
          .passthrough()
          .parse(result);
        deletedGeneration = completed.resourceGeneration;
        this.sqlite
          .transaction(() => {
            this.sqlite
              .prepare(
                "UPDATE codespaceLocalResourceBinding SET revokedAt=? WHERE resourceId=? AND userId=? AND revokedAt IS NULL",
              )
              .run(this.now(), resourceId, userId);
            this.sqlite
              .prepare("DELETE FROM workspaceAgentCredential WHERE resourceId=? AND userId=?")
              .run(resourceId, userId);
            this.repository.retire(userId, resourceId, {
              requestId: operationId,
              resourceGeneration: completed.resourceGeneration,
              retiredAt: this.now(),
            });
          })
          .immediate();
      }
      const observed = await this.getCodespace(userId, resourceId);
      return deletedGeneration ? { ...observed, generation: deletedGeneration } : observed;
    } catch (error) {
      this.failure(error, { requestId: operationId, deviceId: binding.deviceId, resourceId });
    }
  }
  startCodespace(
    userId: string,
    resourceId: string,
    requestId?: string,
    expectedGeneration?: number,
  ) {
    return this.lifecycle(userId, resourceId, "start", requestId, expectedGeneration);
  }
  stopCodespace(
    userId: string,
    resourceId: string,
    requestId?: string,
    expectedGeneration?: number,
  ) {
    return this.lifecycle(userId, resourceId, "stop", requestId, expectedGeneration);
  }
  resumeSetup(userId: string, resourceId: string, requestId?: string, expectedGeneration?: number) {
    return this.lifecycle(userId, resourceId, "resume_setup", requestId, expectedGeneration);
  }
  deleteCodespace(
    userId: string,
    resourceId: string,
    expectedGeneration: number,
    options: { ownerConfirmed?: boolean; requestId?: string } = {},
  ) {
    return this.lifecycle(
      userId,
      resourceId,
      "delete",
      options.requestId,
      expectedGeneration,
      options.ownerConfirmed,
    );
  }
  setupGuidance(situation: CodespaceGuidanceSituation) {
    const guidance = this.provider.guidance();
    return {
      provider: CODESPACE_PROVIDER_LOCAL,
      situation,
      instruction:
        (guidance.instructions as Partial<Record<CodespaceGuidanceSituation, string>>)[situation] ??
        null,
      links: guidance.links,
    };
  }
  async setupSituation(userId: string, repositoryId?: string): Promise<CodespaceGuidanceSituation> {
    const owned = await this.devices.listOwned(userId);
    if (
      !owned.devices.some(
        (device) => device.status === "active" && device.owner.state === "available",
      )
    )
      return "connection_required";
    const admitted = owned.devices.some(
      (device) =>
        device.owner.state === "available" &&
        device.owner.local.state === "configured" &&
        device.owner.local.policy.repositories.some(
          (repository) =>
            !repositoryId ||
            localRepositoryTargetId(device.deviceId, repository.id) === repositoryId,
        ),
    );
    if (!admitted) return "repository_not_approved";
    return "ready";
  }
  private requestIdentity(value: unknown): string {
    const parsed = controllerRequestIdSchema.safeParse(value);
    if (!parsed.success)
      throw new CodespaceResourceError(
        "CODESPACE_RESOURCE_INVALID",
        "A caller-selected ws1 request identity is required.",
      );
    return parsed.data;
  }
  private failure(
    error: unknown,
    identity?: { requestId: string; deviceId: string; resourceId: string },
  ): never {
    if (error instanceof LocalDeviceError)
      error = new CodespaceResourceError(
        error.code === "LOCAL_UNAVAILABLE"
          ? "CODESPACE_PROVIDER_UNAVAILABLE"
          : error.code === "LOCAL_OUTCOME_UNCONFIRMED"
            ? "CODESPACE_LOCAL_CREATION_UNKNOWN"
            : "CODESPACE_AUTHORIZATION_REQUIRED",
        error.message,
        error.requestId ? "Original request: " + error.requestId : undefined,
      );
    if (error instanceof CodespaceResourceError && identity) {
      error.requestId ??= identity.requestId;
      error.deviceId ??= identity.deviceId;
      error.resourceId ??= identity.resourceId;
    }
    throw error;
  }
}
