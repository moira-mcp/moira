import { z } from "zod";
import {
  CODESPACE_PROVIDER_CONTRACT_VERSION,
  CODESPACE_PROVIDER_LOCAL,
  CodespaceResourceError,
  LocalDeviceError,
  canonicalJson,
  localRepositoryTargetId,
  localResourceSnapshotSchema,
  LOCAL_WORKER_REQUEST_TIMEOUT_MS,
  parseLocalRepositoryTargetId,
  type CodespaceProviderAdapter,
  type CodespaceProviderResource,
  type CodespaceResourceRecord,
  type CodespaceResourceRepository,
  type CodespaceMachine,
  type CodespaceRepositoryTarget,
} from "@mcp-moira/shared";
import { CodespaceJobTransport } from "./codespace-job-transport.js";
import { LocalCodespaceRelay } from "./local-codespace-relay.js";

const RECOVERY_JOB_ACTIONS = new Set(["inspect", "cancel", "finalize", "output", "file-inspect"]);
const LOCAL_JOB_DELIVERY_TIMEOUT_MS = LOCAL_WORKER_REQUEST_TIMEOUT_MS + 120_000;

/** Internal credentials identify the already authenticated caller; they never leave this server. */
export function localCodespaceCredential(userId: string): string {
  return `local-user:${userId}`;
}
function userFromCredential(credential: string): string {
  if (!credential.startsWith("local-user:") || credential.length <= 11 || credential.length > 140) {
    throw new CodespaceResourceError(
      "CODESPACE_AUTHORIZATION_REQUIRED",
      "Local account authority is missing",
    );
  }
  return credential.slice(11);
}

export class LocalCodespaceProvider implements CodespaceProviderAdapter {
  readonly id = CODESPACE_PROVIDER_LOCAL;
  readonly contractVersion = CODESPACE_PROVIDER_CONTRACT_VERSION;
  readonly capabilities = Object.freeze({
    disposable: false,
    persistent: true,
    exactLifecycle: true,
    personalBillingOnly: true,
    connector: "local-outbound-relay",
  });
  constructor(
    readonly relay: LocalCodespaceRelay,
    readonly resources: CodespaceResourceRepository,
    private readonly settingsUrl: string,
    private readonly now: () => number = Date.now,
  ) {}

  async health() {
    return { state: "available" as const, reason: null };
  }
  async getIdentity(credential: string) {
    const id = userFromCredential(credential);
    this.relay.devices.listOwned(id);
    return { id, login: "local" };
  }
  private target(credential: string, repository: CodespaceRepositoryTarget) {
    const userId = userFromCredential(credential);
    const target = parseLocalRepositoryTargetId(repository.id);
    const device = this.relay.devices.getActiveDevice(userId, target.deviceId);
    const grant = device.policy.repositories.find((repo) => repo.id === target.repositoryId);
    if (!grant || grant.fullName !== repository.fullName || grant.private !== repository.private) {
      throw new CodespaceResourceError(
        "CODESPACE_AUTHORIZATION_REQUIRED",
        "Local repository is not approved on this device",
      );
    }
    if (!device.policy.enabled || device.policy.leaseUntil <= this.now()) {
      throw new CodespaceResourceError("CODESPACE_POLICY_LIMIT", "Renew the work lease locally");
    }
    if (device.lastSeenAt === null || this.now() - device.lastSeenAt > 60_000) {
      throw new CodespaceResourceError(
        "CODESPACE_PROVIDER_UNAVAILABLE",
        "The selected local device is offline",
      );
    }
    return { userId, device, repositoryId: target.repositoryId };
  }
  async listMachines(credential: string, repository: CodespaceRepositoryTarget, _ref: string) {
    return [this.target(credential, repository).device.policy.machine];
  }
  async preflightCreate(credential: string, repository: CodespaceRepositoryTarget, _ref: string) {
    return { billableOwnerId: this.target(credential, repository).userId };
  }
  async create(
    credential: string,
    input: {
      repository: CodespaceRepositoryTarget;
      ref: string;
      machine: CodespaceMachine;
      operationMarker: string;
      idleTimeoutMinutes: number;
      retentionMinutes: number;
    },
  ) {
    const target = this.target(credential, input.repository);
    if (canonicalJson(input.machine) !== canonicalJson(target.device.policy.machine)) {
      throw new CodespaceResourceError(
        "CODESPACE_RESOURCE_INVALID",
        "Local machine profile changed",
      );
    }
    const record = this.resources
      .listOwned(target.userId, this.id)
      .find((row) => row.operationMarker === input.operationMarker);
    if (!record || record.repositoryId !== input.repository.id) {
      throw new CodespaceResourceError(
        "CODESPACE_NOT_FOUND",
        "Local creation reservation is missing",
      );
    }
    this.relay.devices.bindResource({
      userId: target.userId,
      deviceId: target.device.deviceId,
      deviceGeneration: target.device.deviceGeneration,
      connectionId: target.device.connectionId,
      resourceId: record.id,
      repositoryId: target.repositoryId,
      profileId: input.machine.name,
    });
    await this.relay.send(
      record,
      {
        action: "create",
        repositoryId: target.repositoryId,
        ref: input.ref,
        operationMarker: input.operationMarker,
      },
      { mutation: true },
    );
    // A reconciler may have adopted the admitted VM while its original create receipt was in flight.
    // The receipt settles that old claim; a new snapshot still needs current resource authority.
    const current = this.resources.getOwned(target.userId, record.id);
    if (
      !current ||
      current.operationMarker !== record.operationMarker ||
      current.repositoryId !== record.repositoryId ||
      current.connectionId !== record.connectionId
    )
      throw new CodespaceResourceError(
        "CODESPACE_AUTHORIZATION_REQUIRED",
        "Local creation authority changed",
      );
    const resource = await this.observe(current);
    return { outcome: "accepted" as const, resource };
  }
  async listOwned(credential: string): Promise<CodespaceProviderResource[]> {
    const userId = userFromCredential(credential);
    const found: CodespaceProviderResource[] = [];
    for (const record of this.resources.listOwned(userId, this.id)) {
      if (
        record.state === "deleted" ||
        record.state === "rejected" ||
        !this.relay.devices.getBinding(userId, record.id)
      )
        continue;
      const resource = await this.observe(record);
      if (resource) found.push(resource);
    }
    return found;
  }
  async inspectCreation(
    credential: string,
    input: { resourceId: string; operationMarker: string; repositoryId: string },
  ) {
    const record = this.resources.getOwned(userFromCredential(credential), input.resourceId);
    if (
      !record ||
      record.provider !== this.id ||
      record.operationMarker !== input.operationMarker ||
      record.repositoryId !== input.repositoryId
    )
      throw new CodespaceResourceError(
        "CODESPACE_GENERATION_CONFLICT",
        "Local creation reservation changed",
      );
    const resource = await this.observe(record);
    return resource ? { outcome: "found" as const, resource } : { outcome: "absent" as const };
  }
  private async exactRecord(credential: string, name: string) {
    const id = z.string().uuid().parse(name);
    const userId = userFromCredential(credential);
    const reserved = this.resources.getOwned(userId, id);
    if (reserved?.provider === this.id) return reserved;
    const records = this.resources.listOwned(userId, this.id);
    const record = records.find((row) => row.providerResourceName === id);
    if (record) return record;
    throw new CodespaceResourceError(
      "CODESPACE_NOT_FOUND",
      "Local codespace is not owned by this account",
    );
  }
  async getExact(credential: string, name: string) {
    return this.observe(await this.exactRecord(credential, name));
  }
  private async observe(
    record: CodespaceResourceRecord,
  ): Promise<CodespaceProviderResource | null> {
    const binding = this.relay.devices.getBinding(record.userId, record.id);
    if (!binding)
      throw new CodespaceResourceError(
        "CODESPACE_AUTHORIZATION_REQUIRED",
        "Local resource binding is missing",
      );
    const parsed = localResourceSnapshotSchema.safeParse(
      await this.relay.send(record, { action: "snapshot" }),
    );
    if (!parsed.success)
      throw new CodespaceResourceError(
        "CODESPACE_LOCAL_PROTOCOL_ERROR",
        "The local computer returned an incompatible resource snapshot; update the companion and server together",
      );
    const result = parsed.data;
    if (result.deviceId !== binding.deviceId)
      throw new CodespaceResourceError(
        "CODESPACE_GENERATION_CONFLICT",
        "Local device identity changed",
      );
    const matches = result.spaces.filter(
      (space) => space.operationMarker === record.operationMarker,
    );
    if (matches.length > 1)
      throw new CodespaceResourceError(
        "CODESPACE_GENERATION_CONFLICT",
        "Local creation identity is ambiguous",
      );
    const space = matches[0];
    if (result.creation.state === "absent") {
      if (result.spaces.length !== 0)
        throw new CodespaceResourceError(
          "CODESPACE_LOCAL_PROTOCOL_ERROR",
          "Local absence disagrees with its resource snapshot",
        );
      return null;
    }
    if (!space || result.creation.spaceId !== space.id)
      throw new CodespaceResourceError(
        "CODESPACE_LOCAL_PROTOCOL_ERROR",
        "The local creation manifest is missing from its scoped snapshot",
      );
    if (
      space.repositoryId !== binding.repositoryId ||
      (record.providerResourceName !== null &&
        record.providerResourceName !== record.id &&
        space.id !== record.providerResourceName)
    ) {
      throw new CodespaceResourceError(
        "CODESPACE_GENERATION_CONFLICT",
        "Local sandbox identity changed",
      );
    }
    if (space.state === "absent") return null;
    const setupIncomplete =
      space.failure === "LOCAL_SETUP_INCOMPLETE" ||
      ((space.phase === "stopped" || space.phase === "usable") &&
        space.lastStartedAt === null &&
        space.failure === null) ||
      (space.phase === "failed" &&
        space.lastStartedAt === null &&
        space.failure === "LOCAL_GUEST_SETTLEMENT_UNKNOWN" &&
        space.state !== "unknown");
    return {
      name: record.providerResourceName ?? record.id,
      displayName: record.operationMarker,
      ownerId: record.userId,
      billableOwnerId: record.userId,
      repositoryId: localRepositoryTargetId(binding.deviceId, binding.repositoryId),
      repositoryFullName: record.repositoryFullName,
      ref: null,
      ...(setupIncomplete
        ? { stateError: "CODESPACE_LOCAL_SETUP_INCOMPLETE" as const }
        : space.state === "unknown" || space.failure !== null
          ? {
              stateError:
                space.failure &&
                space.failure !== "LOCAL_CREATE_UNKNOWN" &&
                space.failure !== "LOCAL_SETUP_INCOMPLETE"
                  ? ("CODESPACE_LOCAL_RUNTIME_ERROR" as const)
                  : ("CODESPACE_LOCAL_CREATION_UNKNOWN" as const),
            }
          : {}),
      state:
        space.state === "unknown"
          ? "unknown"
          : space.state === "running"
            ? space.phase === "usable" && space.failure === null && !setupIncomplete
              ? "available"
              : !setupIncomplete &&
                  space.failure === null &&
                  (space.phase === "creating" || space.phase === "stopped")
                ? "starting"
                : "failed"
            : space.state === "stopped"
              ? "shutdown"
              : space.state === "starting"
                ? "starting"
                : space.state === "stopping"
                  ? "stopping"
                  : space.state === "created"
                    ? space.nativeStopConfirmed
                      ? "shutdown"
                      : "created"
                    : "failed",
      lastUsedAt: space.lastStartedAt,
      machine: record.machine,
      createdAt: space.createdAt,
    };
  }
  private async lifecycle(credential: string, name: string, action: "start" | "stop" | "delete") {
    const record = await this.exactRecord(credential, name);
    await this.relay.send(
      record,
      { action, spaceId: name, ...(action === "delete" ? { generation: record.generation } : {}) },
      { mutation: true },
    );
    return "accepted" as const;
  }
  startExact(credential: string, name: string) {
    return this.lifecycle(credential, name, "start");
  }
  stopExact(credential: string, name: string) {
    return this.lifecycle(credential, name, "stop");
  }
  deleteExact(credential: string, name: string) {
    return this.lifecycle(credential, name, "delete");
  }
  async preflightDelete(
    credential: string,
    input: { resourceId: string; ownerConfirmed: boolean },
  ) {
    const record = await this.exactRecord(credential, input.resourceId);
    const binding = this.relay.devices.getBinding(record.userId, record.id);
    if (!binding)
      throw new CodespaceResourceError(
        "CODESPACE_AUTHORIZATION_REQUIRED",
        "Local resource is not bound",
      );
    let device;
    try {
      device = this.relay.devices.getActiveDevice(record.userId, binding.deviceId);
    } catch (error) {
      if (error instanceof LocalDeviceError)
        throw new CodespaceResourceError(
          "CODESPACE_AUTHORIZATION_REQUIRED",
          "Local device access is no longer active",
        );
      throw error;
    }
    if (
      device.deviceGeneration !== binding.deviceGeneration ||
      device.connectionId !== record.connectionId
    )
      throw new CodespaceResourceError(
        "CODESPACE_AUTHORIZATION_REQUIRED",
        "Local device authority changed",
      );
    if (input.ownerConfirmed) {
      if (!device.control?.optedIn)
        throw new CodespaceResourceError(
          "CODESPACE_AUTHORIZATION_REQUIRED",
          "Approve web control on this computer first",
        );
    } else if (
      !device.policy.repositories.find((repo) => repo.id === binding.repositoryId)?.allowDelete
    ) {
      throw new CodespaceResourceError(
        "CODESPACE_LOCAL_DELETE_APPROVAL_REQUIRED",
        "The owner must confirm deletion in Settings",
        undefined,
        true,
      );
    }
    if (!input.ownerConfirmed && (!device.policy.enabled || device.policy.leaseUntil <= this.now()))
      throw new CodespaceResourceError(
        "CODESPACE_POLICY_LIMIT",
        "Renew the device work lease before agent work",
      );
  }
  async probeConnector(credential: string, name: string) {
    const resource = await this.getExact(credential, name);
    if (resource?.state !== "available")
      throw new CodespaceResourceError(
        resource?.stateError ?? "CODESPACE_NOT_RUNNING",
        "Local sandbox guest is not ready",
      );
  }
  guidance() {
    return {
      links: [{ id: "settings" as const, url: this.settingsUrl, label: "Local devices" }],
      instructions: {
        instance_disabled:
          "Ask the Moira administrator to enable codespace operations. Connect Moira Local in Settings and approve the pairing on this computer; pairing does not override the instance policy.",
        connection_required:
          "Connect Moira Local in Settings and approve the pairing on this computer.",
        repository_not_approved:
          "Approve this repository with moira-local approve on the selected computer.",
        ready: "Run moira-local run on the selected computer with a current local work lease.",
      },
    };
  }
}

export class LocalCodespaceJobTransport extends CodespaceJobTransport {
  constructor(private readonly relay: LocalCodespaceRelay) {
    super();
  }
  async health() {
    return { ok: true, reason: null };
  }
  async retainExecuteInput(
    credential: string,
    codespace: CodespaceResourceRecord,
    operation: import("@mcp-moira/shared").CodespaceOperationRecord,
    request: import("@mcp-moira/shared").CodespaceExecRequest,
  ): Promise<void> {
    this.requireOperation(credential, codespace, operation);
    await this.relay.retain(
      codespace,
      {
        action: "operation",
        spaceId: codespace.providerResourceName,
        job: this.executeJob(codespace, operation, request),
      },
      { mutation: true, waitMs: LOCAL_JOB_DELIVERY_TIMEOUT_MS },
    );
  }
  async retainFileInput(
    credential: string,
    codespace: CodespaceResourceRecord,
    operation: import("@mcp-moira/shared").CodespaceOperationRecord,
    request: import("@mcp-moira/shared").CodespaceFileRequest,
  ): Promise<void> {
    this.requireOperation(credential, codespace, operation);
    await this.relay.retain(
      codespace,
      {
        action: "operation",
        spaceId: codespace.providerResourceName,
        job: this.fileExecuteJob(codespace, operation, request),
      },
      { mutation: true, waitMs: LOCAL_JOB_DELIVERY_TIMEOUT_MS },
    );
  }
  private requireOperation(
    credential: string,
    codespace: CodespaceResourceRecord,
    operation: import("@mcp-moira/shared").CodespaceOperationRecord,
    action?: unknown,
  ): void {
    const recovering = typeof action === "string" && RECOVERY_JOB_ACTIONS.has(action);
    if (
      userFromCredential(credential) !== codespace.userId ||
      operation.userId !== codespace.userId ||
      codespace.provider !== CODESPACE_PROVIDER_LOCAL ||
      operation.provider !== codespace.provider ||
      operation.resourceId !== codespace.id ||
      operation.providerResourceName !== codespace.providerResourceName ||
      operation.authorizationGeneration !== codespace.authorizationGeneration ||
      operation.resourceGeneration > codespace.generation ||
      (!recovering && operation.resourceGeneration !== codespace.generation) ||
      !codespace.providerResourceName
    ) {
      throw new CodespaceResourceError(
        "CODESPACE_GENERATION_CONFLICT",
        "Local operation authority changed",
      );
    }
  }
  protected async sendJob(
    credential: string,
    codespace: CodespaceResourceRecord,
    operation: import("@mcp-moira/shared").CodespaceOperationRecord,
    job: Record<string, unknown>,
    timeoutMs: number,
  ) {
    this.requireOperation(credential, codespace, operation, job.action);
    const result = await this.relay.send(
      codespace,
      {
        action: "operation",
        spaceId: codespace.providerResourceName,
        job,
      },
      {
        mutation:
          job.action === "execute" || job.action === "file-execute" || job.action === "finalize",
        // The guest supervisor detaches commands; this call waits for its bounded worker,
        // not the command's separate retained execution deadline.
        waitMs: Math.min(timeoutMs, LOCAL_JOB_DELIVERY_TIMEOUT_MS),
      },
    );
    if (!result || typeof result !== "object" || Array.isArray(result))
      throw new Error("Local guest returned an invalid job result");
    return result as Record<string, unknown>;
  }
}
