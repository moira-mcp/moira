import { z } from "zod";
import {
  CODESPACE_PROVIDER_LOCAL,
  CodespaceResourceError,
  localRepositoryTargetId,
  localResourceSnapshotSchema,
  type CodespaceProviderResource,
  type LocalResourceIdentity,
  type LocalResourceRepository,
} from "@mcp-moira/shared";
import { type LocalDeviceService, type LocalControllerSnapshot } from "@mcp-moira/shared";

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

export class LocalCodespaceProvider {
  readonly id = CODESPACE_PROVIDER_LOCAL;
  constructor(
    readonly devices: LocalDeviceService,
    readonly resources: LocalResourceRepository,
    private readonly settingsUrl: string,
    private readonly now: () => number = Date.now,
  ) {}

  async health() {
    return { state: "available" as const, reason: null };
  }
  async getIdentity(credential: string) {
    const id = userFromCredential(credential);
    this.devices.listRegistered(id);
    return { id, login: "local" };
  }
  private async exactRecord(credential: string, name: string) {
    const id = z.string().uuid().parse(name);
    const userId = userFromCredential(credential);
    const reserved = this.resources.getOwned(userId, id);
    if (reserved) return reserved;
    throw new CodespaceResourceError(
      "CODESPACE_NOT_FOUND",
      "Local codespace is not owned by this account",
    );
  }
  async getExact(credential: string, name: string, snapshot?: LocalControllerSnapshot) {
    return this.observe(await this.exactRecord(credential, name), snapshot);
  }
  private async observe(
    record: LocalResourceIdentity,
    observed?: LocalControllerSnapshot,
  ): Promise<CodespaceProviderResource | null> {
    const binding = this.devices.getBinding(record.userId, record.id);
    if (!binding)
      throw new CodespaceResourceError(
        "CODESPACE_AUTHORIZATION_REQUIRED",
        "Local resource binding is missing",
      );
    const snapshot =
      observed ?? (await this.devices.localSnapshot(record.userId, binding.deviceId, record.id));
    if (snapshot.resourceObservation.state !== "available")
      throw new CodespaceResourceError(
        "CODESPACE_PROVIDER_UNAVAILABLE",
        "The device cannot observe its native environments.",
      );
    const match = snapshot.resources.find((resource) => resource.resourceId === record.id);
    if (!match?.space) return null;
    return this.fromSnapshot(localCodespaceCredential(record.userId), record.id, {
      deviceId: binding.deviceId,
      creation: { state: "manifest", spaceId: match.space.id },
      spaces: [match.space],
    });
  }
  /** Project the exact observation captured by a completed lifecycle receipt without another read. */
  async fromSnapshot(
    credential: string,
    name: string,
    value: unknown,
  ): Promise<CodespaceProviderResource | null> {
    const record = await this.exactRecord(credential, name);
    const binding = this.devices.getBinding(record.userId, record.id);
    if (!binding)
      throw new CodespaceResourceError(
        "CODESPACE_AUTHORIZATION_REQUIRED",
        "Local resource binding is missing",
      );
    const parsed = localResourceSnapshotSchema.safeParse(value);
    if (!parsed.success)
      throw new CodespaceResourceError(
        "CODESPACE_LOCAL_PROTOCOL_ERROR",
        "Invalid owner resource snapshot",
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
    if (space.repositoryId !== binding.repositoryId || space.machine.name !== binding.profileId) {
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
        space.failure === null);
    return {
      name: record.id,
      displayName: record.operationMarker,
      ownerId: record.userId,
      billableOwnerId: record.userId,
      repositoryId: localRepositoryTargetId(binding.deviceId, binding.repositoryId),
      repositoryFullName: record.repositoryFullName,
      ref: null,
      ...(space.remote ? { remote: space.remote } : {}),
      ...(space.setupFailure ? { setupFailure: space.setupFailure } : {}),
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
      machine: space.machine,
      createdAt: space.createdAt,
    };
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
        ready: "Run moira-local run on the selected computer with local work enabled.",
      },
    };
  }
}
