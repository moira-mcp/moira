import { z } from "zod";
import {
  CODESPACE_PROVIDER_CONTRACT_VERSION,
  CODESPACE_PROVIDER_LOCAL,
  CodespaceResourceError,
  canonicalJson,
  localRepositoryTargetId,
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

const spaceSchema = z
  .object({
    id: z.string().uuid(),
    repositoryId: z.string().uuid(),
    operationMarker: z.string().regex(/^moira-[a-f0-9]{24}$/),
    generation: z.number().int().positive(),
    createdAt: z.number().int().nonnegative(),
    lastStartedAt: z.number().int().nonnegative().nullable(),
    state: z.enum([
      "running",
      "stopped",
      "starting",
      "stopping",
      "created",
      "error",
      "unknown",
      "absent",
    ]),
    phase: z.string().max(80),
    failure: z.string().max(160).nullable(),
  })
  .passthrough();
const snapshotSchema = z
  .object({ deviceId: z.string().uuid(), spaces: z.array(spaceSchema).max(8) })
  .passthrough();

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
    const resource = await this.observe(record);
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
  private async exactRecord(credential: string, name: string) {
    const id = z.string().uuid().parse(name);
    const userId = userFromCredential(credential);
    const records = this.resources.listOwned(userId, this.id);
    const record = records.find((row) => row.providerResourceName === id);
    if (record) return record;
    // Core probes the returned identity before adoption. The saved authenticated create receipt
    // supplies this identity; an SDK name, caller hint or another user's sandbox cannot do so.
    for (const pending of records) {
      if (pending.providerResourceName !== null || pending.state !== "create_submitted") continue;
      const binding = this.relay.devices.getBinding(userId, pending.id);
      if (!binding) continue;
      const receipt = await this.relay.completedResult(pending, {
        action: "create",
        repositoryId: binding.repositoryId,
        ref: pending.requestedRef,
        operationMarker: pending.operationMarker,
      });
      if (
        receipt !== null &&
        z.object({ spaceId: z.string().uuid() }).strict().parse(receipt).spaceId === id
      )
        return pending;
    }
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
    const result = snapshotSchema.parse(await this.relay.send(record, { action: "snapshot" }));
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
    if (!space || space.state === "absent") return null;
    if (
      space.repositoryId !== binding.repositoryId ||
      (record.providerResourceName !== null && space.id !== record.providerResourceName)
    ) {
      throw new CodespaceResourceError(
        "CODESPACE_GENERATION_CONFLICT",
        "Local sandbox identity changed",
      );
    }
    return {
      name: space.id,
      displayName: record.operationMarker,
      ownerId: record.userId,
      billableOwnerId: record.userId,
      repositoryId: localRepositoryTargetId(binding.deviceId, binding.repositoryId),
      repositoryFullName: record.repositoryFullName,
      ref: null,
      state:
        space.state === "running"
          ? "available"
          : space.state === "stopped"
            ? "shutdown"
            : space.state === "starting"
              ? "starting"
              : space.state === "stopping"
                ? "stopping"
                : space.state === "created"
                  ? "provisioning"
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
  async probeConnector(credential: string, name: string) {
    const resource = await this.getExact(credential, name);
    if (resource?.state !== "available")
      throw new CodespaceResourceError("CODESPACE_NOT_RUNNING", "Local sandbox is not running");
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
      { mutation: true },
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
      { mutation: true },
    );
  }
  private requireOperation(
    credential: string,
    codespace: CodespaceResourceRecord,
    operation: import("@mcp-moira/shared").CodespaceOperationRecord,
  ): void {
    if (
      userFromCredential(credential) !== codespace.userId ||
      operation.userId !== codespace.userId ||
      codespace.provider !== CODESPACE_PROVIDER_LOCAL ||
      operation.resourceId !== codespace.id ||
      operation.resourceGeneration !== codespace.generation ||
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
    this.requireOperation(credential, codespace, operation);
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
        waitMs: timeoutMs,
      },
    );
    if (!result || typeof result !== "object" || Array.isArray(result))
      throw new Error("Local guest returned an invalid job result");
    return result as Record<string, unknown>;
  }
}
