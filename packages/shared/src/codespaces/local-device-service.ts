import { randomBytes } from "node:crypto";
import { z } from "zod";
import { canonicalJson } from "../utils/canonical-json.js";
import { LocalDeviceRepository, digestLocalSecret } from "./local-device-repository.js";
import {
  localControlRequestSchema,
  localDeviceControlViewSchema,
  assertAgentRepositoryAdmission,
  type LocalRepositoryAdmissionReceipt,
} from "./local-management-types.js";
import {
  LocalDeviceError,
  localPublicPolicySchema,
  localDeviceLabelSchema,
  type LocalDeviceAuth,
  type LocalDeviceView,
  type LocalResourceBinding,
  type LocalPublicPolicy,
} from "./local-device-types.js";
import {
  controllerOperationSchema,
  controllerRequestIdSchema,
  githubControllerResourceSchema,
  type ControllerOperation,
} from "./local-controller-protocol.js";
import { type ControllerLifecycle } from "./local-controller-protocol.js";
import { CodespaceResourceError } from "./resource-types.js";
import { scopedCredentialFailureOutcome } from "./scoped-credential-types.js";

const secret = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const id = z.string().uuid();
const generation = z.number().int().positive().safe();
export const localEnrollmentSchema = z
  .object({
    pairingId: id,
    pairingToken: secret,
    credential: secret,
    deviceId: id,
    label: localDeviceLabelSchema,
  })
  .strict();
export interface LocalControllerClient {
  json(
    userId: string,
    deviceId: string,
    input: { method: string; path: string; body?: unknown },
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>>;
}
const localSnapshotSchema = z
  .object({
    state: z.literal("configured"),
    policy: localPublicPolicySchema,
    control: localDeviceControlViewSchema,
    observedAt: z.number().int().nonnegative().safe(),
    resources: z.array(
      z
        .object({
          resourceId: id,
          resourceGeneration: generation,
          routeGeneration: generation,
          repositoryId: id,
          profileId: z.string(),
          space: z.record(z.string(), z.unknown()).nullable(),
          creationClosed: z.boolean(),
          pendingRequestIds: z.array(controllerRequestIdSchema),
        })
        .strict(),
    ),
    resourceObservation: z
      .object({ state: z.enum(["available", "unavailable"]), code: z.string().optional() })
      .strict(),
    pendingResourceOperations: z.array(
      z.object({ resourceId: id, requestIds: z.array(controllerRequestIdSchema) }).strict(),
    ),
  })
  .strict();
const snapshotSchema = z
  .object({
    version: z.literal(1),
    deviceId: id,
    userId: z.string().min(1),
    deviceGeneration: generation,
    ownerConnectionId: id,
    connectionId: id,
    observedAt: z.number().int().nonnegative().safe(),
    local: z.discriminatedUnion("state", [
      localSnapshotSchema,
      z.object({ state: z.literal("unconfigured") }).strict(),
    ]),
    github: z.object({ resources: z.array(githubControllerResourceSchema) }).strict(),
  })
  .strict();
export type ControllerSnapshot = z.infer<typeof snapshotSchema>;
export type LocalControllerSnapshot = Extract<
  ControllerSnapshot["local"],
  { state?: "configured" }
> &
  Omit<ControllerSnapshot, "local" | "github">;
type ActiveDevice = LocalDeviceView & {
  owner: Extract<LocalDeviceView["owner"], { state: "available" }> & {
    local: Extract<
      Extract<LocalDeviceView["owner"], { state: "available" }>["local"],
      { state: "configured" }
    >;
  };
};
export type LocalCredentialRetirement =
  | { kind: "device" }
  | { kind: "settings"; throughRevision: number }
  | { kind: "resource"; resourceId: string; throughGeneration: number };

/** One current owner observation used throughout a single Git authorization decision. */
export interface LocalGitAuthorization {
  auth: LocalDeviceAuth;
  resourceId: string;
  resourceGeneration: number;
  ownerResourceGeneration: number;
  appliedRevision: number;
  useUntil: number;
  repository: LocalPublicPolicy["repositories"][number];
}

/** Registration remains cloud-owned; all operational reads and mutations go to the live owner. */
export class LocalDeviceService {
  constructor(
    readonly repository: LocalDeviceRepository,
    private readonly now: () => number = Date.now,
    readonly controller?: LocalControllerClient,
    private readonly retireDeviceCredentials?: (
      userId: string,
      deviceId: string,
      retirement: LocalCredentialRetirement,
    ) => Promise<void>,
  ) {}
  getDeviceIdentity(userId: string, deviceId: string) {
    return this.repository.getDeviceIdentity(userId, id.parse(deviceId));
  }
  listRegistered(userId: string) {
    return this.repository.listOwned(userId, this.now());
  }
  async listOwned(userId: string) {
    const registered = this.listRegistered(userId);
    return {
      ...registered,
      devices: await Promise.all(registered.devices.map((device) => this.project(device))),
    };
  }
  beginEnrollment(userId: string) {
    const pairingToken = randomBytes(32).toString("base64url");
    return {
      ...this.repository.beginEnrollment(userId, digestLocalSecret(pairingToken), this.now()),
      pairingToken,
    };
  }
  approveLocalEnrollment(value: unknown) {
    const input = localEnrollmentSchema.parse(value);
    return this.repository.approveLocalEnrollment(
      {
        pairingId: input.pairingId,
        tokenDigest: digestLocalSecret(input.pairingToken),
        credentialDigest: digestLocalSecret(input.credential),
        deviceId: input.deviceId,
        label: input.label,
      },
      this.now(),
    );
  }
  pairingStatus(value: unknown) {
    const input = z.object({ pairingId: id, pairingToken: secret }).strict().parse(value);
    return this.repository.pairingStatus(
      input.pairingId,
      digestLocalSecret(input.pairingToken),
      this.now(),
    );
  }
  async confirmEnrollment(userId: string, pairingId: string, expectedRevision: number) {
    return this.project(
      this.repository.confirmEnrollment(
        userId,
        id.parse(pairingId),
        generation.parse(expectedRevision),
        this.now(),
      ),
    );
  }
  authenticateDevice(credential: string): LocalDeviceAuth {
    if (!secret.safeParse(credential).success)
      throw new LocalDeviceError("LOCAL_UNAUTHORIZED", "Device access denied.");
    return this.repository.authenticateDevice(digestLocalSecret(credential), this.now());
  }
  async revokeOwned(userId: string, deviceId: string, expectedGeneration: number) {
    const revoked = this.repository.revokeOwned(
      userId,
      id.parse(deviceId),
      generation.parse(expectedGeneration),
      this.now(),
    );
    // Owner access is fenced even when remote child disposal remains pending.
    await this.retireDeviceCredentials?.(userId, deviceId, { kind: "device" });
    return revoked;
  }
  async snapshot(userId: string, deviceId: string): Promise<ControllerSnapshot> {
    const identity = this.getDeviceIdentity(userId, deviceId);
    if (identity.status !== "active")
      throw new LocalDeviceError("LOCAL_UNAUTHORIZED", "Device access denied.");
    if (!this.controller)
      throw new LocalDeviceError("LOCAL_UNAVAILABLE", "The device owner is unavailable.");
    let value: Record<string, unknown>;
    try {
      value = await this.controller.json(userId, deviceId, {
        method: "GET",
        path: "/v1/controller",
      });
    } catch {
      throw new LocalDeviceError("LOCAL_UNAVAILABLE", "The device owner is unavailable.");
    }
    return this.validateSnapshot(userId, deviceId, value);
  }
  private validateSnapshot(userId: string, deviceId: string, value: unknown): ControllerSnapshot {
    const snapshot = snapshotSchema.parse(value);
    const current = this.getDeviceIdentity(userId, deviceId);
    if (
      current.status !== "active" ||
      snapshot.userId !== userId ||
      snapshot.deviceId !== deviceId ||
      snapshot.deviceGeneration !== current.deviceGeneration ||
      snapshot.ownerConnectionId !== current.connectionId ||
      snapshot.connectionId !== current.connectionId ||
      (snapshot.local.state === "configured" && snapshot.local.policy.deviceId !== deviceId)
    )
      throw new LocalDeviceError(
        "LOCAL_UNAUTHORIZED",
        "Device authority changed during observation.",
      );
    return snapshot;
  }
  async localSnapshot(userId: string, deviceId: string): Promise<LocalControllerSnapshot> {
    const snapshot = await this.snapshot(userId, deviceId);
    if (snapshot.local.state !== "configured")
      throw new LocalDeviceError(
        "LOCAL_UNAVAILABLE",
        "Local capability is not configured on this controller.",
      );
    return {
      ...snapshot.local,
      version: snapshot.version,
      userId: snapshot.userId,
      deviceId: snapshot.deviceId,
      deviceGeneration: snapshot.deviceGeneration,
      ownerConnectionId: snapshot.ownerConnectionId,
      connectionId: snapshot.connectionId,
      observedAt: snapshot.observedAt,
    };
  }
  private async project(device: LocalDeviceView): Promise<LocalDeviceView> {
    if (device.status !== "active") return device;
    try {
      const snapshot = await this.snapshot(device.userId, device.deviceId);
      return this.projectSnapshot(device, snapshot);
    } catch (error) {
      if (!(error instanceof LocalDeviceError) || error.code !== "LOCAL_UNAVAILABLE") throw error;
      return { ...device, owner: { state: "unavailable" } };
    }
  }
  private projectSnapshot(device: LocalDeviceView, snapshot: ControllerSnapshot): LocalDeviceView {
    return {
      ...device,
      label: snapshot.local.state === "configured" ? snapshot.local.policy.label : device.label,
      owner: {
        state: "available",
        observedAt: snapshot.observedAt,
        local:
          snapshot.local.state === "configured"
            ? {
                state: "configured",
                policy: snapshot.local.policy,
                control: snapshot.local.control,
              }
            : { state: "unconfigured" },
        github: { resources: snapshot.github.resources! },
      },
    };
  }
  private projectResult(userId: string, deviceId: string, value: unknown): ActiveDevice {
    const snapshot = this.validateSnapshot(userId, deviceId, value);
    const device = this.projectSnapshot(
      this.repository.getActiveDevice(userId, deviceId),
      snapshot,
    );
    if (device.owner.state !== "available" || device.owner.local.state !== "configured")
      throw new LocalDeviceError("LOCAL_UNAVAILABLE", "The device owner is unavailable.");
    return { ...device, owner: { ...device.owner, local: device.owner.local } };
  }
  async getActiveDevice(userId: string, deviceId: string): Promise<ActiveDevice> {
    const device = await this.project(this.repository.getActiveDevice(userId, id.parse(deviceId)));
    if (device.owner.state !== "available" || device.owner.local.state !== "configured")
      throw new LocalDeviceError("LOCAL_UNAVAILABLE", "The device owner is unavailable.");
    return { ...device, owner: { ...device.owner, local: device.owner.local } };
  }
  private async operation(
    userId: string,
    deviceId: string,
    input: { method: string; path: string; body?: unknown },
    requestId: string,
  ): Promise<ControllerOperation> {
    this.repository.getActiveDevice(userId, id.parse(deviceId));
    if (!this.controller)
      throw new LocalDeviceError("LOCAL_UNAVAILABLE", "The device owner is unavailable.");
    let value: Record<string, unknown>;
    try {
      value = await this.controller.json(userId, deviceId, input);
    } catch (error) {
      const details =
        error && typeof error === "object" && "details" in error
          ? z
              .object({ error: z.object({ code: z.string() }).passthrough() })
              .safeParse(error.details)
          : undefined;
      const code =
        error instanceof CodespaceResourceError
          ? error.code
          : details?.success
            ? details.data.error.code
            : error && typeof error === "object" && "code" in error
              ? error.code
              : undefined;
      if (["CODESPACE_PROVIDER_UNAVAILABLE", "ECONNREFUSED", "ENOENT"].includes(String(code)))
        throw new LocalDeviceError(
          "LOCAL_UNAVAILABLE",
          "The device owner is unavailable; no action was dispatched.",
        );
      if (["CODESPACE_AUTHORIZATION_REQUIRED", "LOCAL_UNAUTHORIZED"].includes(String(code)))
        throw new LocalDeviceError(
          "LOCAL_UNAUTHORIZED",
          "The owner refused this authority before dispatch.",
        );
      if (code === "LOCAL_REQUEST_INVALID")
        throw new LocalDeviceError(
          "LOCAL_INVALID",
          "The owner refused this request before dispatch.",
        );
      throw new LocalDeviceError(
        "LOCAL_OUTCOME_UNCONFIRMED",
        "Collect the original request identity before repeating this operation.",
        requestId,
      );
    }
    const operation = controllerOperationSchema.parse(value);
    if (operation.requestId !== requestId)
      throw new LocalDeviceError(
        "LOCAL_CONFLICT",
        "The owner returned a different request identity.",
      );
    return operation;
  }
  private completed(operation: ControllerOperation, lifecycle = false): unknown {
    if (operation.state !== "completed" || !operation.outcome)
      throw new LocalDeviceError(
        "LOCAL_OUTCOME_UNCONFIRMED",
        "Collect the original request identity before repeating this operation.",
        operation.requestId,
      );
    if (operation.outcome.ok === false) {
      const code = operation.outcome.error.code;
      if (
        lifecycle &&
        ([
          "WORKSPACE_OUTCOME_UNCONFIRMED",
          "WORKSPACE_OUTCOME_UNKNOWN",
          "LOCAL_CUSTODY_UNCONFIRMED",
        ].includes(code) ||
          scopedCredentialFailureOutcome(code) === "unconfirmed")
      )
        throw new LocalDeviceError(
          "LOCAL_OUTCOME_UNCONFIRMED",
          operation.outcome.error.message,
          operation.requestId,
        );
      if (lifecycle && code === "LOCAL_GENERATION_CONFLICT")
        throw new CodespaceResourceError(
          "CODESPACE_GENERATION_CONFLICT",
          operation.outcome.error.message,
        );
      throw new LocalDeviceError(
        code === "LOCAL_UNAUTHORIZED" ||
          code === "LOCAL_EXPIRED" ||
          code === "LOCAL_CONFLICT" ||
          code === "LOCAL_INVALID"
          ? code
          : "LOCAL_CONFLICT",
        operation.outcome.error.message,
      );
    }
    return operation.outcome.result;
  }
  resourceOperationResult(operation: ControllerOperation): unknown {
    return this.completed(operation, true);
  }
  async requestSettings(userId: string, deviceId: string, value: unknown) {
    const input = localControlRequestSchema.parse(value);
    const identity = this.getDeviceIdentity(userId, deviceId);
    if (identity.deviceGeneration !== input.expectedGeneration)
      throw new LocalDeviceError("LOCAL_CONFLICT", "Device generation changed.");
    const result = this.completed(
      await this.operation(
        userId,
        deviceId,
        { method: "PUT", path: "/v1/controller/settings", body: input },
        input.requestId,
      ),
    );
    await this.retireDeviceCredentials?.(userId, deviceId, {
      kind: "settings",
      throughRevision: input.expectedRevision,
    });
    return this.projectResult(userId, deviceId, result);
  }
  async collectSettings(userId: string, deviceId: string, requestId: string) {
    controllerRequestIdSchema.parse(requestId);
    const operation = await this.operation(
      userId,
      deviceId,
      { method: "GET", path: "/v1/controller/operations/" + requestId },
      requestId,
    );
    return operation.state === "completed" && operation.outcome?.ok
      ? { ...operation, result: this.projectResult(userId, deviceId, operation.outcome.result) }
      : operation;
  }
  async getOperation(userId: string, deviceId: string, requestId: string) {
    controllerRequestIdSchema.parse(requestId);
    return this.operation(
      userId,
      deviceId,
      { method: "GET", path: "/v1/controller/operations/" + requestId },
      requestId,
    );
  }
  async requestRepositoryAdmission(
    userId: string,
    deviceId: string,
    input: Omit<
      LocalRepositoryAdmissionReceipt,
      "revision" | "connectionId" | "localRepositoryId"
    > & { expectedRevision: number },
    observation?: ActiveDevice,
  ) {
    const device = observation ?? (await this.getActiveDevice(userId, deviceId)),
      control = device.owner.local.control;
    const current = this.repository.getActiveDevice(userId, id.parse(deviceId));
    if (
      device.userId !== userId ||
      device.deviceId !== deviceId ||
      current.deviceGeneration !== device.deviceGeneration ||
      current.connectionId !== device.connectionId
    )
      throw new LocalDeviceError(
        "LOCAL_UNAUTHORIZED",
        "Device authority changed during admission.",
      );
    const previous = control.repositoryAdmissions?.find(
      (receipt) => receipt.requestId === input.requestId,
    );
    if (previous) {
      if (
        previous.githubRepositoryId !== input.githubRepositoryId ||
        previous.creationRequestId !== input.creationRequestId ||
        canonicalJson(previous.repository) !== canonicalJson(input.repository)
      )
        throw new LocalDeviceError("LOCAL_CONFLICT", "Repository request identity changed.");
      // Admission metadata can precede the physical policy write. Its presence is
      // not a certificate that this original owner operation completed successfully.
      const original = this.projectResult(
        userId,
        deviceId,
        this.completed(await this.getOperation(userId, deviceId, "ws1-" + input.requestId)),
      );
      const applied = device.owner.local.policy.repositories.find(
        (repository) => repository.id === previous.localRepositoryId,
      );
      if (
        control.status !== "applied" ||
        !applied ||
        canonicalJson(applied) !== canonicalJson(previous.repository)
      )
        throw new LocalDeviceError(
          "LOCAL_CONFLICT",
          "The original repository grant is not currently applied on its owner.",
        );
      if (input.creationRequestId) {
        this.repository.validateRepositoryCreation(userId, original, {
          creationRequestId: input.creationRequestId,
          requestId: input.requestId,
          githubRepositoryId: input.githubRepositoryId,
          fullName: input.repository.fullName,
        });
        this.repository.releaseRepositoryCreation(userId, input.creationRequestId, this.now());
      }
      return device;
    }
    if (
      device.deviceGeneration !== input.deviceGeneration ||
      control.revision !== input.expectedRevision
    )
      throw new LocalDeviceError("LOCAL_CONFLICT", "Device settings changed.");
    assertAgentRepositoryAdmission(
      control.appliedAgentRepositoryManagement,
      input.repository,
      input.creationRequestId ? "created" : "existing",
    );
    if (input.creationRequestId)
      this.repository.validateRepositoryCreation(userId, device, {
        creationRequestId: input.creationRequestId,
        requestId: input.requestId,
        githubRepositoryId: input.githubRepositoryId,
        fullName: input.repository.fullName,
      });
    const requestId = "ws1-" + input.requestId;
    const result = this.projectResult(
      userId,
      deviceId,
      this.completed(
        await this.operation(
          userId,
          deviceId,
          { method: "POST", path: "/v1/controller/repositories", body: { ...input, requestId } },
          requestId,
        ),
      ),
    );
    const receipt = result.owner.local.control.repositoryAdmissions?.find(
      (entry) => entry.requestId === input.requestId,
    );
    const grant = result.owner.local.policy.repositories.find(
      (entry) => entry.id === receipt?.localRepositoryId,
    );
    if (
      !receipt ||
      receipt.githubRepositoryId !== input.githubRepositoryId ||
      receipt.creationRequestId !== input.creationRequestId ||
      receipt.deviceGeneration !== result.deviceGeneration ||
      receipt.connectionId !== result.connectionId ||
      receipt.revision !== input.expectedRevision + 1 ||
      result.owner.local.control.status !== "applied" ||
      result.owner.local.control.appliedRevision < receipt.revision ||
      canonicalJson(receipt.repository) !== canonicalJson(input.repository) ||
      !grant ||
      canonicalJson(grant) !== canonicalJson(receipt.repository)
    )
      throw new LocalDeviceError(
        "LOCAL_CONFLICT",
        "The repository grant was not applied on its owner.",
      );
    if (input.creationRequestId) {
      this.repository.validateRepositoryCreation(userId, result, {
        creationRequestId: input.creationRequestId,
        requestId: input.requestId,
        githubRepositoryId: input.githubRepositoryId,
        fullName: input.repository.fullName,
      });
      this.repository.releaseRepositoryCreation(userId, input.creationRequestId, this.now());
    }
    return result;
  }
  bindResource(binding: LocalResourceBinding) {
    return this.repository.bindResource(binding);
  }
  async executeResourceLifecycle(
    userId: string,
    deviceId: string,
    resourceId: string,
    input: ControllerLifecycle,
  ) {
    const binding = this.getBinding(userId, resourceId);
    const current = this.getDeviceIdentity(userId, deviceId);
    if (
      !binding ||
      binding.deviceId !== deviceId ||
      binding.deviceGeneration !== current.deviceGeneration ||
      binding.connectionId !== current.connectionId ||
      current.status !== "active"
    )
      throw new LocalDeviceError("LOCAL_UNAUTHORIZED", "Resource routing authority changed.");
    const result = this.resourceOperationResult(
      await this.operation(
        userId,
        deviceId,
        { method: "POST", path: "/v1/resources/" + resourceId + "/lifecycle", body: input },
        input.requestId,
      ),
    );
    if (this.retireDeviceCredentials && (input.action === "stop" || input.action === "delete"))
      await this.retireDeviceCredentials?.(userId, deviceId, {
        kind: "resource",
        resourceId,
        throughGeneration: z.object({ resourceGeneration: generation }).passthrough().parse(result)
          .resourceGeneration,
      });
    return result;
  }
  getBinding(userId: string, resourceId: string) {
    return this.repository.getBinding(userId, resourceId);
  }
  async authorizeGitHubOperation(
    auth: LocalDeviceAuth,
    resourceId: string,
    resourceGeneration: number,
    action: "fetch" | "push" | "pull_request",
  ): Promise<LocalGitAuthorization> {
    return this.authorizeGitHubAuthority(auth, resourceId, action, resourceGeneration);
  }
  private async authorizeGitHubAuthority(
    auth: LocalDeviceAuth,
    resourceId: string,
    action: "fetch" | "push" | "pull_request",
    resourceGeneration?: number,
  ): Promise<LocalGitAuthorization> {
    const current = this.getDeviceIdentity(auth.userId, auth.deviceId);
    const binding = this.getBinding(auth.userId, resourceId);
    if (
      !binding ||
      current.status !== "active" ||
      current.deviceGeneration !== auth.deviceGeneration ||
      current.connectionId !== auth.connectionId ||
      binding.deviceId !== auth.deviceId
    )
      throw new LocalDeviceError("LOCAL_UNAUTHORIZED", "Local resource authority changed.");
    const snapshot = await this.localSnapshot(auth.userId, auth.deviceId);
    const resource = snapshot.resources.find((entry) => entry.resourceId === resourceId);
    const grant = snapshot.policy.repositories.find((repo) => repo.id === binding.repositoryId);
    if (
      !resource ||
      (resourceGeneration !== undefined && resource.routeGeneration !== resourceGeneration) ||
      snapshot.deviceGeneration !== auth.deviceGeneration ||
      snapshot.connectionId !== auth.connectionId ||
      resource.repositoryId !== binding.repositoryId ||
      !grant ||
      !snapshot.policy.enabled ||
      snapshot.policy.leaseUntil <= this.now() ||
      (action === "push" && !grant.allowPush) ||
      (action === "pull_request" && grant.allowPullRequests !== true)
    )
      throw new LocalDeviceError(
        "LOCAL_UNAUTHORIZED",
        "The local repository operation is not approved.",
      );
    return {
      auth: {
        userId: auth.userId,
        deviceId: auth.deviceId,
        deviceGeneration: snapshot.deviceGeneration,
        connectionId: snapshot.connectionId,
      },
      resourceId,
      resourceGeneration: resource.routeGeneration,
      ownerResourceGeneration: resource.resourceGeneration,
      appliedRevision: snapshot.control.appliedRevision,
      useUntil: snapshot.policy.leaseUntil,
      repository: grant,
    };
  }
  async authorizeOwnedGitHubOperation(
    userId: string,
    resourceId: string,
    action: "fetch" | "push" | "pull_request",
  ): Promise<LocalGitAuthorization> {
    const binding = this.getBinding(userId, resourceId);
    if (!binding) throw new LocalDeviceError("LOCAL_UNAUTHORIZED", "Local resource access denied.");
    return this.authorizeGitHubAuthority(binding, resourceId, action);
  }
}
