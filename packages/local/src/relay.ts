import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import {
  localPublicPolicySchema,
  localRelayPayloadReferenceSchema,
  type LocalRelayClaim,
  type LocalRelayPayloadReference,
} from "../../shared/src/codespaces/local-device-types.js";
import { LocalRecords } from "./space-record.js";
import { LocalRefusal, MAX_MESSAGE_BYTES, publicPolicy, requireLocalGrant } from "./policy.js";
import { LocalRpc, localEnvelopeSchema, type LocalReply } from "./rpc.js";
import {
  localDeviceControlViewSchema,
  type LocalDeviceControlView,
} from "../../shared/src/codespaces/local-management-types.js";
import { LocalWebControl } from "./web-control.js";
import { RequestJournal } from "./journal.js";
import { canonicalJson } from "../../shared/src/utils/canonical-json.js";
import {
  localManagementOutcomeSchema,
  localResourceSnapshotSchema,
} from "../../shared/src/codespaces/local-protocol.js";

const uuid = z.string().uuid();
const deviceSecret = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const connectionSchema = z
  .object({
    origin: z.string().url(),
    credential: deviceSecret,
    deviceId: uuid,
    userId: z.string().min(1).max(255).optional(),
    deviceGeneration: z.number().int().positive().optional(),
    connectionId: uuid.optional(),
    pairingId: uuid,
    pairingToken: deviceSecret.optional(),
  })
  .strict();
type Connection = z.infer<typeof connectionSchema>;
const deviceSchema = z
  .object({
    deviceId: uuid,
    userId: z.string().min(1).max(255),
    deviceGeneration: z.number().int().positive(),
    connectionId: uuid,
    status: z.enum(["pending", "active", "revoked"]),
    policy: localPublicPolicySchema,
    control: localDeviceControlViewSchema.optional(),
  })
  .passthrough();
const claimSchema = z
  .object({
    requestId: uuid,
    deviceId: uuid,
    userId: z.string().min(1),
    deviceGeneration: z.number().int().positive(),
    connectionId: uuid,
    resourceId: uuid,
    resourceGeneration: z.number().int().positive(),
    authority: z.literal("owner-delete").optional(),
    digest: z.string().regex(/^[a-f0-9]{64}$/),
    payloadReference: localRelayPayloadReferenceSchema,
    deadlineAt: z.number().int().positive(),
    claimId: uuid,
    claimExpiresAt: z.number().int().positive(),
  })
  .strict();
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const resourceSnapshot = (value: unknown, spaceId: string | null) => {
  const snapshot = z
    .object({ spaces: z.array(z.object({ id: uuid }).passthrough()) })
    .passthrough()
    .parse(value);
  return localResourceSnapshotSchema.parse({
    ...snapshot,
    spaces: snapshot.spaces.filter((space) => space.id === spaceId),
    creation: { state: "manifest", spaceId },
  });
};
// Reconnect instances share the same admitted records. A binding observation cannot
// overtake a creation between its durable intent and the manager's native admission.
const resourceGates = new WeakMap<LocalRecords, Map<string, Promise<unknown>>>();
const bindingSchema = z
  .object({
    resourceId: uuid,
    deviceId: uuid,
    userId: z.string().min(1),
    connectionId: uuid,
    deviceGeneration: z.number().int().positive(),
    serverGeneration: z.number().int().positive(),
    localSpaceId: uuid.nullable(),
    localGeneration: z.number().int().positive().nullable(),
    createMarker: z.string().regex(/^moira-[a-f0-9]{24}$/),
    repositoryId: uuid,
    createRequestId: uuid,
    createDigest: z.string().regex(/^[a-f0-9]{64}$/),
    creationClosed: z.boolean().optional(),
  })
  .strict();
const intentSchema = z
  .object({
    digest: z.string().regex(/^[a-f0-9]{64}$/),
    resourceId: uuid,
    deviceGeneration: z.number().int().positive(),
    connectionId: uuid,
    serverGeneration: z.number().int().positive(),
    message: localEnvelopeSchema,
    authority: z.literal("owner-delete").optional(),
    sourceMessage: localEnvelopeSchema.optional(),
  })
  .strict();

/** The origin is chosen on this machine. Server responses cannot select another host or redirect. */
export function relayOrigin(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash)
    throw new LocalRefusal(
      "LOCAL_ORIGIN_UNSAFE",
      "Choose an HTTPS Moira application URL without credentials.",
    );
  return url.href.replace(/\/$/, "");
}

/** Only a device confirmation can revoke the device owner's admitted work. */
export class LocalDeviceAuthorityFailure extends LocalRefusal {
  constructor(code: string) {
    super(code, "Moira refused the confirmed device authority.");
  }
}

/** A known HTTP refusal of one addressed delivery, not device ownership or native work. */
class LocalClaimRefusal extends LocalRefusal {}

export class LocalRelay {
  private established?: Connection;
  private readonly deliveries = new Map<string, Promise<void>>();
  private readonly activeClaims = new Map<
    string,
    { resourceId: string; action?: string; controller: AbortController }
  >();
  private readonly deliveryFailures: unknown[] = [];
  private polling?: AbortController;
  private readonly transportFailures = new WeakSet<object>();
  isUnavailable(error: unknown): boolean {
    return (
      (error instanceof LocalRefusal && error.code === "LOCAL_RELAY_UNAVAILABLE") ||
      (typeof error === "object" && error !== null && this.transportFailures.has(error))
    );
  }
  control?: LocalDeviceControlView;
  constructor(
    readonly records: LocalRecords,
    private readonly fetch: typeof globalThis.fetch = globalThis.fetch,
  ) {}

  /** Manager holds the short marker admission boundary before any SDK effect. */
  async assertCreationOpen(repositoryId: string, operationMarker: string): Promise<void> {
    for (const key of await this.records.state.keys("relay-space-")) {
      const binding = await this.records.state.read(key, bindingSchema.parse);
      if (binding?.createMarker !== operationMarker) continue;
      if (binding.repositoryId !== repositoryId)
        throw new LocalRefusal(
          "LOCAL_IDENTITY_CHANGED",
          "Creation marker belongs to another repository.",
        );
      if (binding.creationClosed)
        throw new LocalRefusal(
          "LOCAL_CREATE_UNKNOWN",
          "This never-created intent is closed; create a new codespace instead of replaying it.",
        );
    }
  }

  async gitAuthority(spaceId: string, repositoryId: string, signal?: AbortSignal) {
    const connection = await this.confirmed(signal);
    const space = await this.records.get(spaceId);
    if (
      !space ||
      space.repositoryId !== repositoryId ||
      !space.runtimeId ||
      space.desiredState !== "running"
    )
      throw new LocalRefusal(
        "LOCAL_CREATE_UNKNOWN",
        "Git requires the exact locally admitted space.",
      );
    const candidates = [];
    for (const key of await this.records.state.keys("relay-space-")) {
      const binding = await this.records.state.read(key, bindingSchema.parse);
      if (
        !binding ||
        binding.repositoryId !== repositoryId ||
        binding.createMarker !== space.operationMarker
      )
        continue;
      if (
        binding.deviceId !== connection.deviceId ||
        binding.userId !== connection.userId ||
        binding.deviceGeneration !== connection.deviceGeneration ||
        binding.connectionId !== connection.connectionId
      )
        throw new LocalRefusal("LOCAL_IDENTITY_CHANGED", "Git resource authority changed.");
      if (space.phase === "creating") {
        const intent = await this.records.state.read(
          `relay-request-${binding.createRequestId}.json`,
          intentSchema.parse,
        );
        const request = intent?.message.request;
        if (
          binding.creationClosed ||
          (binding.localSpaceId !== null && binding.localSpaceId !== spaceId) ||
          !intent ||
          intent.message.id !== binding.createRequestId ||
          intent.digest !== binding.createDigest ||
          hash(Buffer.from(canonicalJson(intent.sourceMessage ?? intent.message))) !==
            intent.digest ||
          intent.resourceId !== binding.resourceId ||
          intent.deviceGeneration !== binding.deviceGeneration ||
          intent.connectionId !== binding.connectionId ||
          intent.message.expiresAt <= Date.now() ||
          request?.action !== "create" ||
          request.repositoryId !== repositoryId ||
          request.operationMarker !== space.operationMarker ||
          request.ref !== space.ref ||
          !(await new RequestJournal(this.records.state).isAccepted(
            intent.message.id,
            intent.message.expiresAt,
            intent.message.request,
          ))
        )
          throw new LocalRefusal(
            "LOCAL_CREATE_UNKNOWN",
            "Initial Git requires the exact retained accepted creation intent.",
          );
        // Scoped observation can adopt the manifest while the same create is still bootstrapping.
        // It changes routing, not the accepted native work's authority or local generation.
        candidates.push(binding);
        continue;
      }
      if (binding.localSpaceId !== spaceId) {
        throw new LocalRefusal(
          "LOCAL_CREATE_UNKNOWN",
          "Git has no confirmed usable local creation identity.",
        );
      }
      if (!["usable", "stopped"].includes(space.phase) || space.failure !== null)
        throw new LocalRefusal("LOCAL_NOT_RUNNING", "Git requires an initialized codespace.");
      candidates.push(binding);
    }
    if (candidates.length !== 1)
      throw new LocalRefusal("LOCAL_CREATE_UNKNOWN", "Git has no unique server resource binding.");
    signal?.throwIfAborted();
    return {
      origin: connection.origin,
      credential: connection.credential,
      resourceId: candidates[0].resourceId,
      resourceGeneration: candidates[0].serverGeneration,
    };
  }

  async gitIdentity(spaceId: string, repositoryId: string, signal?: AbortSignal) {
    const authority = await this.gitAuthority(spaceId, repositoryId, signal);
    const connection = await this.records.state.read("connection.json", connectionSchema.parse);
    if (!connection) throw new LocalRefusal("LOCAL_NOT_ENROLLED", "Pair this device first.");
    const bytes = await this.request(
      connection,
      `/github/${authority.resourceId}/${authority.resourceGeneration}/identity`,
      { limit: 8192, signal },
    );
    return z
      .object({
        success: z.literal(true),
        data: z
          .object({ name: z.string().min(1).max(200), email: z.string().email().max(254) })
          .strict(),
      })
      .passthrough()
      .parse(JSON.parse(bytes.toString("utf8"))).data;
  }

  private async request(
    connection: Connection,
    path: string,
    options: {
      body?: unknown;
      binary?: Uint8Array;
      claim?: string;
      signal?: AbortSignal;
      limit?: number;
    } = {},
  ): Promise<Buffer> {
    const transportFailure = (error: unknown): never => {
      if (!options.signal?.aborted && typeof error === "object" && error !== null)
        this.transportFailures.add(error);
      throw error;
    };
    const response = await this.fetch(
      `${relayOrigin(connection.origin)}/api/local-devices${path}`,
      {
        method: options.body === undefined && options.binary === undefined ? "GET" : "POST",
        redirect: "error",
        signal: options.signal
          ? AbortSignal.any([options.signal, AbortSignal.timeout(30_000)])
          : AbortSignal.timeout(30_000),
        headers: {
          authorization: `Bearer ${connection.credential}`,
          ...(options.claim ? { "X-Moira-Claim-Id": options.claim } : {}),
          ...(options.body === undefined ? {} : { "content-type": "application/json" }),
          ...(options.binary === undefined ? {} : { "content-type": "application/octet-stream" }),
        },
        body:
          options.binary === undefined
            ? options.body === undefined
              ? undefined
              : JSON.stringify(options.body)
            : Buffer.from(options.binary),
      },
    ).catch(transportFailure);
    if (!response.ok) {
      if (
        [401, 403].includes(response.status) &&
        /^\/github\/[a-f0-9-]{36}\/\d+\/identity$/.test(path)
      ) {
        const reader = response.body?.getReader();
        const chunks: Uint8Array[] = [];
        let size = 0;
        let complete = false;
        if (reader)
          try {
            for (;;) {
              const item = await reader.read();
              if (item.done) {
                complete = true;
                break;
              }
              size += item.value.length;
              if (size > 8192) break;
              chunks.push(item.value);
            }
          } catch {
            // Error details are optional; a broken body cannot override the known HTTP refusal.
          } finally {
            await reader.cancel().catch(() => undefined);
            reader.releaseLock();
          }
        if (complete && size <= 8192)
          try {
            const refusal = z
              .object({
                success: z.literal(false),
                error: z
                  .object({
                    code: z.literal("LOCAL_UNAUTHORIZED"),
                    message: z.enum([
                      "Refresh GitHub repository access in Settings.",
                      "Add this repository to the Moira GitHub App installation in Settings.",
                      "Reconnect GitHub to restore the verified commit identity.",
                    ]),
                  })
                  .strict(),
              })
              .strict()
              .parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
            throw new LocalRefusal(refusal.error.code, refusal.error.message);
          } catch (error) {
            if (error instanceof LocalRefusal) throw error;
          }
      }
      await response.body?.cancel().catch(() => undefined);
      const Refusal =
        response.status < 500 &&
        /^\/relay\/(?:[a-f0-9-]{36}\/(?:renew|result-part|payload\/\d+)(?:\?|$)|ack$)/.test(path)
          ? LocalClaimRefusal
          : LocalRefusal;
      throw new Refusal(
        response.status === 401
          ? "LOCAL_UNAUTHORIZED"
          : response.status >= 500
            ? "LOCAL_RELAY_UNAVAILABLE"
            : "LOCAL_RELAY_REFUSED",
        "Moira refused the current local connection or relay claim.",
      );
    }
    const chunks: Buffer[] = [];
    let size = 0;
    const reader = response.body?.getReader();
    if (reader)
      try {
        for (;;) {
          const { done, value } = await reader.read().catch(transportFailure);
          if (done) break;
          size += value.length;
          if (size > (options.limit ?? MAX_MESSAGE_BYTES)) {
            await reader.cancel();
            throw new LocalRefusal("LOCAL_OUTPUT_LIMIT", "The relay response exceeded its bound.");
          }
          chunks.push(Buffer.from(value));
        }
      } finally {
        reader.releaseLock();
      }
    return Buffer.concat(chunks);
  }

  private async json(
    connection: Connection,
    path: string,
    body: unknown,
    signal?: AbortSignal,
    claim?: string,
  ): Promise<unknown> {
    const management = path === "/enroll" || path === "/pairings/status" || path === "/heartbeat";
    const bytes = await this.request(connection, path, {
      body,
      signal,
      claim,
      limit: management ? 2 * 1024 * 1024 : 128 * 1024,
    });
    return z
      .object({ success: z.literal(true), data: z.unknown() })
      .passthrough()
      .parse(JSON.parse(bytes.toString("utf8"))).data;
  }

  async enroll(
    origin: string,
    pairingId: string,
    pairingToken: string,
  ): Promise<{ deviceId: string; status: string }> {
    const release = await this.records.state.lock();
    try {
      const policy = await this.records.policy();
      const saved = await this.records.state.read("connection.json", connectionSchema.parse);
      if (
        saved &&
        (saved.origin !== relayOrigin(origin) ||
          saved.pairingId !== pairingId ||
          saved.deviceId !== policy.deviceId ||
          saved.pairingToken !== pairingToken ||
          saved.connectionId)
      )
        throw new LocalRefusal(
          "LOCAL_ALREADY_ENROLLED",
          "This device already has another pairing; inspect it before replacing its authority.",
        );
      const connection =
        saved ??
        connectionSchema.parse({
          origin: relayOrigin(origin),
          pairingId,
          pairingToken,
          deviceId: policy.deviceId,
          credential: randomBytes(32).toString("base64url"),
        });
      // Persist before transport: a lost enrollment response must not rotate the credential.
      await this.records.state.write("connection.json", connection);
      const device = deviceSchema.parse(
        await this.json(connection, "/enroll", {
          pairingId,
          pairingToken,
          credential: connection.credential,
          policy: publicPolicy(policy),
        }),
      );
      if (device.deviceId !== policy.deviceId || device.status === "revoked")
        throw new LocalRefusal(
          "LOCAL_IDENTITY_CHANGED",
          "The pairing did not bind this locally selected device.",
        );
      return { deviceId: device.deviceId, status: device.status };
    } finally {
      await release();
    }
  }

  async confirmed(signal?: AbortSignal): Promise<Connection> {
    try {
      return await this.confirmDevice(signal);
    } catch (error) {
      if (
        error instanceof LocalRefusal &&
        ["LOCAL_UNAUTHORIZED", "LOCAL_IDENTITY_CHANGED"].includes(error.code)
      )
        throw new LocalDeviceAuthorityFailure(error.code);
      throw error;
    }
  }

  private async confirmDevice(signal?: AbortSignal): Promise<Connection> {
    const connection = await this.records.state.read("connection.json", connectionSchema.parse);
    if (!connection)
      throw new LocalRefusal("LOCAL_NOT_ENROLLED", "Pair this device from Moira first.");
    const policy = await this.records.policy();
    if (connection.deviceId !== policy.deviceId)
      throw new LocalRefusal(
        "LOCAL_IDENTITY_CHANGED",
        "The paired device differs from local policy.",
      );
    if (!connection.connectionId) {
      if (!connection.pairingToken)
        throw new LocalRefusal("LOCAL_PAIRING_INCOMPLETE", "The pending pairing has no token.");
      const status = z
        .object({ device: deviceSchema.nullable() })
        .passthrough()
        .parse(
          await this.json(
            connection,
            "/pairings/status",
            { pairingId: connection.pairingId, pairingToken: connection.pairingToken },
            signal,
          ),
        );
      if (!status.device || status.device.status !== "active")
        throw new LocalRefusal(
          "LOCAL_PAIRING_INCOMPLETE",
          "Confirm this device's local policy in the Moira browser.",
        );
      if (status.device.deviceId !== policy.deviceId)
        throw new LocalRefusal(
          "LOCAL_IDENTITY_CHANGED",
          "The confirmed pairing differs from local policy.",
        );
      connection.userId = status.device.userId;
      connection.deviceGeneration = status.device.deviceGeneration;
      connection.connectionId = status.device.connectionId;
      delete connection.pairingToken;
      await this.records.state.write("connection.json", connection);
    }
    const control = await new LocalWebControl(this.records).report(connection);
    const device = deviceSchema.parse(
      await this.json(
        connection,
        "/heartbeat",
        { policy: publicPolicy(policy), ...(control ? { control } : {}) },
        signal,
      ),
    );
    if (
      device.status !== "active" ||
      device.deviceId !== connection.deviceId ||
      device.userId !== connection.userId ||
      device.connectionId !== connection.connectionId ||
      device.deviceGeneration !== connection.deviceGeneration
    )
      throw new LocalRefusal(
        "LOCAL_IDENTITY_CHANGED",
        "The confirmed connection authority changed.",
      );
    if (
      this.established &&
      (
        [
          "origin",
          "credential",
          "deviceId",
          "userId",
          "deviceGeneration",
          "connectionId",
          "pairingId",
          "pairingToken",
        ] as const
      ).some((key) => connection[key] !== this.established![key])
    )
      throw new LocalRefusal(
        "LOCAL_IDENTITY_CHANGED",
        "The locally pinned relay connection changed during this run.",
      );
    this.established = { ...connection };
    this.control = device.control;
    return connection;
  }

  private async payload(
    connection: Connection,
    claim: LocalRelayClaim,
    signal?: AbortSignal,
  ): Promise<Buffer> {
    if (claim.payloadReference.size > MAX_MESSAGE_BYTES)
      throw new LocalRefusal(
        "LOCAL_REQUEST_TOO_LARGE",
        "The requested local operation exceeds its message bound.",
      );
    const parts: Buffer[] = [];
    for (const [index, part] of claim.payloadReference.parts.entries()) {
      const chunks: Buffer[] = [];
      for (let offset = 0; offset < part.size; offset += 256 * 1024) {
        const length = Math.min(256 * 1024, part.size - offset);
        const bytes = await this.request(
          connection,
          `/relay/${claim.requestId}/payload/${index}?offset=${offset}&length=${length}`,
          { claim: claim.claimId, signal, limit: length },
        );
        if (bytes.length !== length)
          throw new LocalRefusal("LOCAL_PAYLOAD_CHANGED", "A relay payload part is incomplete.");
        chunks.push(bytes);
      }
      const bytes = Buffer.concat(chunks);
      if (hash(bytes) !== part.sha256)
        throw new LocalRefusal(
          "LOCAL_PAYLOAD_CHANGED",
          "A relay payload part differs from its digest.",
        );
      parts.push(bytes);
    }
    const bytes = Buffer.concat(parts);
    if (
      bytes.length !== claim.payloadReference.size ||
      hash(bytes) !== claim.payloadReference.sha256 ||
      hash(bytes) !== claim.digest
    )
      throw new LocalRefusal(
        "LOCAL_PAYLOAD_CHANGED",
        "The complete relay payload differs from its digest.",
      );
    return bytes;
  }

  private async retainedOutcome(rpc: LocalRpc, claim: LocalRelayClaim) {
    const binding = await this.records.state.read(
      `relay-space-${claim.resourceId}.json`,
      bindingSchema.parse,
    );
    const intent = await this.records.state.read(
      `relay-request-${claim.requestId}.json`,
      intentSchema.parse,
    );
    if (!binding || !intent) return undefined;
    if (
      binding.userId !== claim.userId ||
      binding.deviceId !== claim.deviceId ||
      binding.connectionId !== claim.connectionId ||
      binding.deviceGeneration !== claim.deviceGeneration
    )
      throw new LocalRefusal(
        "LOCAL_IDENTITY_CHANGED",
        "The retained outcome belongs to another device authority.",
      );
    if (
      intent.digest !== claim.digest ||
      intent.resourceId !== claim.resourceId ||
      intent.deviceGeneration !== claim.deviceGeneration ||
      intent.connectionId !== claim.connectionId ||
      intent.serverGeneration !== claim.resourceGeneration ||
      intent.authority !== claim.authority ||
      intent.message.authority !== claim.authority ||
      intent.message.id !== claim.requestId ||
      intent.message.expiresAt !== claim.deadlineAt ||
      hash(Buffer.from(canonicalJson(intent.sourceMessage ?? intent.message))) !== claim.digest
    )
      throw new LocalRefusal(
        "LOCAL_REPLAY_CONFLICT",
        "The retained outcome cannot change its accepted payload or authority.",
      );
    await this.requireRequestAuthority(claim, binding, intent.message);
    const message =
      intent.message.request.action === "snapshot" && binding.localSpaceId
        ? {
            ...intent.message,
            request: { ...intent.message.request, spaceId: binding.localSpaceId },
          }
        : intent.message;
    if (!(await rpc.isAccepted(message, true))) return undefined;
    const result = await rpc.replay(message);
    await this.restoreManagementBinding(claim, intent, result);
    return result.ok && message.request.action === "snapshot"
      ? { ...result, result: resourceSnapshot(result.result, binding.localSpaceId) }
      : result;
  }

  private async requireRequestAuthority(
    claim: LocalRelayClaim,
    binding: z.infer<typeof bindingSchema>,
    message: z.infer<typeof localEnvelopeSchema>,
  ): Promise<void> {
    if (claim.authority !== message.authority)
      throw new LocalRefusal("LOCAL_UNAUTHORIZED", "The relay request authority changed.");
    if (!claim.authority) {
      const policy = await this.records.policy();
      if (message.request.action === "snapshot") {
        if (!policy.repositories.some((repository) => repository.id === binding.repositoryId))
          throw new LocalRefusal(
            "LOCAL_REPOSITORY_DENIED",
            "The repository is no longer approved.",
          );
      } else requireLocalGrant(policy, binding.repositoryId, Date.now());
      return;
    }
    const connection = await this.records.state.read("connection.json", connectionSchema.parse);
    if (
      !connection ||
      !this.control?.optedIn ||
      connection.deviceId !== claim.deviceId ||
      connection.userId !== claim.userId ||
      connection.deviceGeneration !== claim.deviceGeneration ||
      connection.connectionId !== claim.connectionId ||
      binding.resourceId !== claim.resourceId ||
      binding.deviceId !== claim.deviceId ||
      binding.userId !== claim.userId ||
      binding.connectionId !== claim.connectionId ||
      binding.deviceGeneration !== claim.deviceGeneration ||
      (message.request.action !== "snapshot" && message.request.action !== "delete") ||
      !(await new LocalWebControl(this.records).report(connection))
    )
      throw new LocalRefusal(
        "LOCAL_UNAUTHORIZED",
        "This exact owner cleanup has no local web-control approval.",
      );
  }

  private async restoreManagementBinding(
    claim: LocalRelayClaim,
    intent: z.infer<typeof intentSchema>,
    result: LocalReply,
  ): Promise<void> {
    const parsed = localManagementOutcomeSchema.safeParse(
      result.ok
        ? typeof result.result === "object" &&
          result.result !== null &&
          "management" in result.result
          ? result.result.management
          : undefined
        : result.error.management,
    );
    if (!parsed.success) return;
    const receipt = parsed.data;
    if (receipt.action !== intent.message.request.action) return;
    let gates = resourceGates.get(this.records);
    if (!gates) {
      gates = new Map();
      resourceGates.set(this.records, gates);
    }
    const gate = gates;
    const key = `relay-space-${claim.resourceId}.json`;
    const work = (gate.get(claim.resourceId) ?? Promise.resolve())
      .catch(() => undefined)
      .then(async () => {
        const binding = await this.records.state.read(key, bindingSchema.parse);
        if (
          !binding ||
          binding.serverGeneration >= intent.serverGeneration ||
          binding.deviceId !== claim.deviceId ||
          binding.userId !== claim.userId ||
          binding.connectionId !== claim.connectionId ||
          binding.deviceGeneration !== claim.deviceGeneration ||
          receipt.spaceId !== binding.localSpaceId ||
          receipt.repositoryId !== binding.repositoryId ||
          receipt.operationMarker !== binding.createMarker ||
          receipt.originGeneration !==
            (intent.message.request.action === "stop" || intent.message.request.action === "delete"
              ? (intent.message.request.generation ?? binding.localGeneration)
              : binding.localGeneration)
        )
          return;
        await this.requireRequestAuthority(claim, binding, intent.message);
        const space = await this.records.get(receipt.spaceId);
        if (
          !space ||
          space.id !== receipt.spaceId ||
          space.repositoryId !== receipt.repositoryId ||
          space.operationMarker !== receipt.operationMarker ||
          space.generation !== receipt.generation ||
          (result.ok
            ? space.desiredState !== (receipt.action === "stop" ? "stopped" : "deleted")
            : space.desiredState === "running") ||
          (result.ok &&
            (receipt.action === "stop"
              ? !["stopped", "failed"].includes(space.phase)
              : space.phase !== "deleted")) ||
          (!result.ok && !["failed", "stopped", "deleting"].includes(space.phase))
        )
          return;
        binding.localGeneration = receipt.generation;
        binding.serverGeneration = intent.serverGeneration;
        await this.records.state.write(key, binding);
      });
    gate.set(claim.resourceId, work);
    try {
      await work;
    } finally {
      if (gate.get(claim.resourceId) === work) gate.delete(claim.resourceId);
    }
  }

  private async dispatch(
    rpc: LocalRpc,
    claim: LocalRelayClaim,
    message: z.infer<typeof localEnvelopeSchema>,
    signal?: AbortSignal,
  ) {
    let gates = resourceGates.get(this.records);
    if (!gates) {
      gates = new Map();
      resourceGates.set(this.records, gates);
    }
    const gate = gates;
    let admit!: () => void;
    const admitted = new Promise<void>((done) => {
      admit = done;
    });
    const work = (gate.get(claim.resourceId) ?? Promise.resolve())
      .catch(() => undefined)
      .then(() => {
        signal?.throwIfAborted();
        return this.dispatchResource(rpc, claim, message, admit, signal);
      });
    // The gate covers durable admission, not native execution. Stop can quiesce admitted work.
    const admission = Promise.race([
      admitted,
      work.then(
        () => undefined,
        () => undefined,
      ),
    ]);
    gate.set(claim.resourceId, admission);
    try {
      return await work;
    } finally {
      if (gate.get(claim.resourceId) === admission) gate.delete(claim.resourceId);
    }
  }

  private async dispatchResource(
    rpc: LocalRpc,
    claim: LocalRelayClaim,
    message: z.infer<typeof localEnvelopeSchema>,
    onAdmitted: () => void,
    signal?: AbortSignal,
  ) {
    const sourceMessage = message;
    const key = `relay-space-${claim.resourceId}.json`;
    let binding = await this.records.state.read(key, bindingSchema.parse);
    const intentKey = `relay-request-${claim.requestId}.json`;
    let intent = await this.records.state.read(intentKey, intentSchema.parse);
    let cleanupGeneration: number | undefined;
    let readonlyIncompleteSnapshot = false;
    if (
      binding &&
      (binding.userId !== claim.userId ||
        binding.deviceId !== claim.deviceId ||
        binding.connectionId !== claim.connectionId ||
        binding.deviceGeneration !== claim.deviceGeneration)
    )
      throw new LocalRefusal(
        "LOCAL_IDENTITY_CHANGED",
        "This server resource belongs to another device authority.",
      );
    if (message.request.action === "snapshot" && binding?.localSpaceId) {
      await this.requireRequestAuthority(claim, binding, message);
      const space = await this.records.get(binding.localSpaceId);
      if (
        !space ||
        space.repositoryId !== binding.repositoryId ||
        space.operationMarker !== binding.createMarker
      )
        throw new LocalRefusal("LOCAL_IDENTITY_CHANGED", "The codespace identity changed.");
      onAdmitted();
      const result = await rpc.handle(
        { ...message, request: { action: "snapshot", spaceId: binding.localSpaceId } },
        onAdmitted,
        claim.authority,
      );
      return result.ok
        ? { ...result, result: resourceSnapshot(result.result, binding.localSpaceId) }
        : result;
    }
    if (message.request.action === "operation") {
      if (!binding?.localSpaceId || claim.authority)
        throw new LocalRefusal(
          "LOCAL_CREATE_UNKNOWN",
          "The codespace has no confirmed local identity.",
        );
      await this.requireRequestAuthority(claim, binding, message);
      const space = await this.records.get(binding.localSpaceId);
      if (
        !space ||
        !space.runtimeId ||
        space.repositoryId !== binding.repositoryId ||
        space.operationMarker !== binding.createMarker ||
        (message.request.spaceId !== binding.localSpaceId &&
          message.request.spaceId !== claim.resourceId)
      )
        throw new LocalRefusal("LOCAL_IDENTITY_CHANGED", "The codespace identity changed.");
      if (space.desiredState !== "running" || space.phase !== "usable")
        throw new LocalRefusal(
          "LOCAL_NOT_RUNNING",
          "The codespace is stopped or not ready for development.",
        );
      if (intent) {
        if (
          intent.digest !== claim.digest ||
          intent.resourceId !== claim.resourceId ||
          intent.deviceGeneration !== claim.deviceGeneration ||
          intent.connectionId !== claim.connectionId ||
          intent.authority !== undefined ||
          intent.message.id !== claim.requestId ||
          intent.message.expiresAt !== claim.deadlineAt ||
          hash(Buffer.from(canonicalJson(intent.sourceMessage ?? intent.message))) !== claim.digest
        )
          throw new LocalRefusal(
            "LOCAL_REPLAY_CONFLICT",
            "The accepted operation cannot change its request.",
          );
        message = intent.message;
      } else {
        message = { ...message, request: { ...message.request, spaceId: binding.localSpaceId } };
        intent = intentSchema.parse({
          digest: claim.digest,
          resourceId: claim.resourceId,
          deviceGeneration: claim.deviceGeneration,
          connectionId: claim.connectionId,
          serverGeneration: claim.resourceGeneration,
          message,
          sourceMessage,
        });
        await this.records.state.write(intentKey, intent);
      }
      onAdmitted();
      signal?.throwIfAborted();
      return rpc.handle(message, onAdmitted, undefined, signal);
    }
    if (binding && claim.resourceGeneration < binding.serverGeneration)
      throw new LocalRefusal(
        "LOCAL_GENERATION_CONFLICT",
        "The retained request predates the current resource generation.",
      );
    if (claim.authority) {
      if (!binding)
        throw new LocalRefusal(
          "LOCAL_UNAUTHORIZED",
          "Owner cleanup has no retained resource binding.",
        );
      await this.requireRequestAuthority(claim, binding, message);
    }
    if (binding && !binding.localSpaceId && message.request.action !== "create") {
      const manifest = await rpc.manager.inspectCreation(
        binding.repositoryId,
        binding.createMarker,
        async () => {
          binding!.creationClosed = true;
          binding!.serverGeneration = claim.resourceGeneration;
          await this.records.state.write(key, binding);
        },
      );
      if (manifest) {
        for (const previousKey of await this.records.state.keys("relay-space-")) {
          const previous = await this.records.state.read(previousKey, bindingSchema.parse);
          if (
            previous &&
            previous.resourceId !== binding.resourceId &&
            (previous.localSpaceId === manifest.id ||
              previous.createMarker === binding.createMarker)
          )
            throw new LocalRefusal(
              "LOCAL_IDENTITY_CHANGED",
              "The local manifest belongs to another server resource.",
            );
        }
        binding.localSpaceId = manifest.id;
        binding.localGeneration = manifest.generation;
        await this.records.state.write(key, binding);
      } else if (message.request.action === "snapshot") {
        // The manager's lifecycle gate settled accepted create before checking its pre-SDK manifest.
        binding.serverGeneration = claim.resourceGeneration;
        await this.records.state.write(key, binding);
        return {
          ok: true as const,
          result: localResourceSnapshotSchema.parse({
            ...publicPolicy(await this.records.policy()),
            spaces: [],
            creation: { state: "absent" },
          }),
        };
      }
    }
    if (binding?.localSpaceId && binding.localGeneration !== null) {
      const space = await this.records.get(binding.localSpaceId);
      if (
        !space ||
        space.repositoryId !== binding.repositoryId ||
        space.operationMarker !== binding.createMarker
      )
        throw new LocalRefusal(
          "LOCAL_IDENTITY_CHANGED",
          "The retained local resource identity changed.",
        );
      if (space.generation !== binding.localGeneration && message.request.action !== "start") {
        const freshIncomplete =
          !intent &&
          (claim.resourceGeneration > binding.serverGeneration ||
            (claim.resourceGeneration === binding.serverGeneration &&
              message.request.action === "snapshot")) &&
          space.generation > binding.localGeneration &&
          (space.failure === "LOCAL_SETUP_INCOMPLETE" || space.lastStartedAt === null) &&
          ["stopped", "failed"].includes(space.phase) &&
          space.desiredState === "stopped" &&
          space.runtimeId;
        if (freshIncomplete && ["stop", "delete", "snapshot"].includes(message.request.action)) {
          cleanupGeneration = space.generation;
          readonlyIncompleteSnapshot = message.request.action === "snapshot";
        } else {
          if (
            intent ||
            claim.resourceGeneration < binding.serverGeneration ||
            (claim.resourceGeneration === binding.serverGeneration &&
              message.request.action !== "snapshot") ||
            space.recoveryGeneration !== space.generation ||
            space.failure !== null ||
            space.phase !== "stopped" ||
            space.desiredState !== "stopped" ||
            !space.runtimeId
          )
            throw new LocalRefusal(
              "LOCAL_GENERATION_CONFLICT",
              "A changed local generation requires a fresh server request after confirmed local stop or recovery.",
            );
          binding.localGeneration = space.generation;
          binding.serverGeneration = claim.resourceGeneration;
          await this.records.state.write(key, binding);
        }
      }
      if (claim.resourceGeneration < binding.serverGeneration)
        throw new LocalRefusal(
          "LOCAL_GENERATION_CONFLICT",
          "The retained request predates the current resource generation.",
        );
    }
    if (intent) {
      if (
        intent.digest !== claim.digest ||
        intent.resourceId !== claim.resourceId ||
        intent.deviceGeneration !== claim.deviceGeneration ||
        intent.connectionId !== claim.connectionId ||
        intent.serverGeneration !== claim.resourceGeneration ||
        intent.authority !== claim.authority ||
        intent.message.authority !== claim.authority
      )
        throw new LocalRefusal(
          "LOCAL_REPLAY_CONFLICT",
          "A retained relay request cannot change its authority or payload.",
        );
      message = intent.message;
    } else {
      const request = message.request;
      if (request.action === "create") {
        const keys = await this.records.state.keys("relay-space-");
        if (!binding && keys.length >= 128)
          throw new LocalRefusal(
            "LOCAL_RESOURCE_LIMIT",
            "Retained local resource binding capacity is exhausted.",
          );
        for (const previousKey of keys) {
          const previous = await this.records.state.read(previousKey, bindingSchema.parse);
          if (
            previous &&
            previous.resourceId !== claim.resourceId &&
            previous.createMarker === request.operationMarker
          )
            throw new LocalRefusal(
              "LOCAL_REPLAY_CONFLICT",
              "A local creation marker already belongs to another server resource.",
            );
        }
        if (
          binding &&
          (binding.createRequestId !== claim.requestId || binding.createDigest !== claim.digest)
        )
          throw new LocalRefusal(
            "LOCAL_REPLAY_CONFLICT",
            "This resource already has another local creation intent.",
          );
        binding ??= bindingSchema.parse({
          resourceId: claim.resourceId,
          deviceId: claim.deviceId,
          userId: claim.userId,
          connectionId: claim.connectionId,
          deviceGeneration: claim.deviceGeneration,
          serverGeneration: claim.resourceGeneration,
          localSpaceId: null,
          localGeneration: null,
          createMarker: request.operationMarker,
          repositoryId: request.repositoryId,
          createRequestId: claim.requestId,
          createDigest: claim.digest,
        });
        await this.records.state.write(key, binding);
      } else {
        if (!binding?.localSpaceId || !binding.localGeneration)
          throw new LocalRefusal(
            "LOCAL_CREATE_UNKNOWN",
            "This server resource has no confirmed local creation receipt.",
          );
        if (claim.resourceGeneration < binding.serverGeneration)
          throw new LocalRefusal(
            "LOCAL_GENERATION_CONFLICT",
            "The server resource generation is stale.",
          );
        const space = await this.records.get(binding.localSpaceId);
        if (
          !space ||
          (request.action !== "start" &&
            space.generation !== (cleanupGeneration ?? binding.localGeneration)) ||
          space.repositoryId !== binding.repositoryId ||
          space.operationMarker !== binding.createMarker
        )
          throw new LocalRefusal(
            "LOCAL_GENERATION_CONFLICT",
            "The locally owned resource changed outside its retained relay receipt.",
          );
        if (
          request.action !== "snapshot" &&
          request.spaceId !== binding.localSpaceId &&
          request.spaceId !== claim.resourceId
        )
          throw new LocalRefusal(
            "LOCAL_IDENTITY_CHANGED",
            "The request targets another local sandbox.",
          );
        if (request.action !== "snapshot")
          message = { ...message, request: { ...request, spaceId: binding.localSpaceId } };
        if (request.action === "delete") {
          if (request.generation !== claim.resourceGeneration)
            throw new LocalRefusal(
              "LOCAL_GENERATION_CONFLICT",
              "Deletion does not name the current server generation.",
            );
          message = {
            ...message,
            request: {
              ...request,
              spaceId: binding.localSpaceId,
              generation: cleanupGeneration ?? binding.localGeneration,
            },
          };
        }
        if (request.action === "stop")
          message = {
            ...message,
            request: {
              ...request,
              spaceId: binding.localSpaceId,
              generation: cleanupGeneration ?? binding.localGeneration,
            },
          };
      }
      if ((await this.records.state.keys("relay-request-")).length >= 1024)
        throw new LocalRefusal(
          "LOCAL_REQUEST_CAPACITY",
          "Retained relay authority capacity is exhausted.",
        );
      intent = intentSchema.parse({
        digest: claim.digest,
        resourceId: claim.resourceId,
        deviceGeneration: claim.deviceGeneration,
        connectionId: claim.connectionId,
        serverGeneration: claim.resourceGeneration,
        ...(claim.authority ? { authority: claim.authority } : {}),
        message,
        ...(sourceMessage !== message ? { sourceMessage } : {}),
      });
      await this.records.state.write(intentKey, intent);
    }
    if (!binding)
      throw new LocalRefusal(
        "LOCAL_CREATE_UNKNOWN",
        "The retained relay resource binding disappeared.",
      );
    if (message.request.action !== "create" && message.request.action !== "start") onAdmitted();
    if (claim.authority) await this.requireRequestAuthority(claim, binding, message);
    if (message.request.action === "stop" || message.request.action === "delete")
      for (const [requestId, active] of this.activeClaims)
        if (
          requestId !== claim.requestId &&
          active.resourceId === claim.resourceId &&
          (!active.action || active.action === "operation")
        )
          active.controller.abort(
            new LocalRefusal("LOCAL_CANCELLED", "This operation was cancelled by codespace stop."),
          );
    const result = await rpc.handle(
      message.request.action === "snapshot"
        ? { ...message, request: { ...message.request, spaceId: binding.localSpaceId! } }
        : message,
      onAdmitted,
      claim.authority,
      signal,
    );
    // A later stop/delete may already own a newer binding after this request's admission.
    binding = await this.records.state.read(key, bindingSchema.parse);
    if (!binding)
      throw new LocalRefusal(
        "LOCAL_IDENTITY_CHANGED",
        "The admitted resource binding disappeared.",
      );
    if (!binding.localSpaceId) {
      if (result.ok && message.request.action === "create")
        binding.localSpaceId = z.object({ spaceId: uuid }).strict().parse(result.result).spaceId;
      else {
        // This is our durable pre-SDK manifest, never a same-name SDK adoption.
        const candidates = (await this.records.list()).filter(
          (space) =>
            space.operationMarker === binding!.createMarker &&
            space.repositoryId === binding!.repositoryId,
        );
        if (candidates.length === 1) binding.localSpaceId = candidates[0].id;
      }
    }
    if (
      binding.localSpaceId &&
      intent.serverGeneration >= binding.serverGeneration &&
      !readonlyIncompleteSnapshot
    ) {
      const space = await this.records.get(binding.localSpaceId);
      if (
        !space ||
        space.repositoryId !== binding.repositoryId ||
        space.operationMarker !== binding.createMarker
      )
        throw new LocalRefusal(
          "LOCAL_IDENTITY_CHANGED",
          "The local creation receipt changed identity.",
        );
      if (!result.ok && message.request.action === "start") return result;
      const lifecycleReceipt =
        result.ok && ["create", "start", "stop", "delete"].includes(message.request.action);
      const unknownStopReceipt =
        !result.ok &&
        result.error.code === "LOCAL_GUEST_SETTLEMENT_UNKNOWN" &&
        space.phase === "stopped" &&
        space.failure === "LOCAL_GUEST_SETTLEMENT_UNKNOWN";
      const managementValue = result.ok
        ? typeof result.result === "object" &&
          result.result !== null &&
          "management" in result.result
          ? result.result.management
          : undefined
        : result.error.management;
      const managementReceipt = managementValue
        ? localManagementOutcomeSchema.parse(managementValue)
        : null;
      const failedManagementReceipt =
        !result.ok &&
        managementReceipt !== null &&
        managementReceipt.originGeneration ===
          (message.request.action === "stop" || message.request.action === "delete"
            ? (message.request.generation ?? binding.localGeneration)
            : binding.localGeneration) &&
        managementReceipt.generation === space.generation &&
        managementReceipt.action === message.request.action &&
        managementReceipt.spaceId === space.id &&
        managementReceipt.repositoryId === space.repositoryId &&
        managementReceipt.operationMarker === space.operationMarker &&
        (message.request.action === "stop" || message.request.action === "delete") &&
        message.request.spaceId === space.id &&
        binding.localGeneration !== null &&
        space.generation > binding.localGeneration &&
        space.desiredState !== "running" &&
        (space.phase === "failed" || space.phase === "stopped" || space.phase === "deleting");
      if (
        cleanupGeneration !== undefined &&
        result.ok &&
        (!managementReceipt ||
          managementReceipt.originGeneration !== cleanupGeneration ||
          managementReceipt.generation !== space.generation ||
          managementReceipt.spaceId !== space.id ||
          managementReceipt.repositoryId !== space.repositoryId ||
          managementReceipt.operationMarker !== space.operationMarker ||
          managementReceipt.action !== message.request.action)
      )
        throw new LocalRefusal(
          "LOCAL_GENERATION_CONFLICT",
          "Exact cleanup has no matching native completion receipt.",
        );
      if (
        binding.localGeneration !== null &&
        binding.localGeneration !== space.generation &&
        !lifecycleReceipt &&
        !unknownStopReceipt &&
        !failedManagementReceipt
      )
        throw new LocalRefusal(
          "LOCAL_GENERATION_CONFLICT",
          "The local generation changed without this request's confirmed lifecycle receipt.",
        );
      binding.localGeneration = space.generation;
      binding.serverGeneration = intent.serverGeneration;
      await this.records.state.write(key, binding);
    }
    if (result.ok && message.request.action === "snapshot") {
      result.result = resourceSnapshot(result.result, binding.localSpaceId);
    }
    return result;
  }

  private async holdClaim(
    connection: Connection,
    claim: LocalRelayClaim,
    work: (signal: AbortSignal) => Promise<void>,
    signal?: AbortSignal,
  ): Promise<void> {
    const controller = new AbortController();
    this.activeClaims.set(claim.requestId, { resourceId: claim.resourceId, controller });
    const scope = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let rejectLoss!: (error: unknown) => void;
    const lost = new Promise<never>((_done, reject) => {
      rejectLoss = reject;
    });
    const renew = async () => {
      try {
        await this.confirmed(scope);
        const next = claimSchema.parse(
          await this.json(connection, `/relay/${claim.requestId}/renew`, {}, scope, claim.claimId),
        );
        if (
          next.claimId !== claim.claimId ||
          next.requestId !== claim.requestId ||
          next.digest !== claim.digest ||
          next.deviceGeneration !== claim.deviceGeneration ||
          next.connectionId !== claim.connectionId ||
          next.resourceGeneration !== claim.resourceGeneration ||
          next.resourceId !== claim.resourceId ||
          next.deviceId !== claim.deviceId ||
          next.userId !== claim.userId ||
          next.deadlineAt !== claim.deadlineAt ||
          next.authority !== claim.authority ||
          JSON.stringify(next.payloadReference) !== JSON.stringify(claim.payloadReference) ||
          next.claimExpiresAt <= Date.now()
        )
          throw new LocalRefusal(
            "LOCAL_IDENTITY_CHANGED",
            "A renewed relay claim changed authority.",
          );
        if (!scope.aborted)
          timer = setTimeout(() => {
            void renew();
          }, 10_000);
      } catch (error) {
        rejectLoss(error);
      }
    };
    timer = setTimeout(() => {
      void renew();
    }, 10_000);
    const executing = work(scope);
    try {
      await Promise.race([executing, lost]);
    } catch (error) {
      controller.abort();
      // Delivery owns this request scope, never the VM or its generation clock.
      // The daemon handles device revocation; the journal prevents redispatch.
      if (error instanceof LocalDeviceAuthorityFailure || error instanceof LocalClaimRefusal) {
        // Report device revocation promptly so its owner can settle admitted hardware work.
        void executing.catch(() => undefined);
        throw error;
      }
      await executing.catch(() => undefined);
      throw error;
    } finally {
      if (this.activeClaims.get(claim.requestId)?.controller === controller)
        this.activeClaims.delete(claim.requestId);
      controller.abort();
      if (timer) clearTimeout(timer);
    }
  }

  async drain(): Promise<void> {
    await Promise.allSettled([...this.deliveries.values()]);
  }

  async poll(rpc: LocalRpc, signal?: AbortSignal, background = false): Promise<number> {
    if (this.deliveryFailures.length) throw this.deliveryFailures.shift();
    const connection = await this.confirmed(signal);
    for (const key of await this.records.state.keys("relay-request-")) {
      const entry = await this.records.state.read(key, intentSchema.parse);
      if (entry && entry.message.expiresAt <= Date.now()) await this.records.state.remove(key);
    }
    const wake = new AbortController();
    this.polling = wake;
    const pollingSignal = signal ? AbortSignal.any([signal, wake.signal]) : wake.signal;
    const data = z
      .object({
        requests: z.array(claimSchema).max(8),
        maxPartBytes: z
          .number()
          .int()
          .min(1)
          .max(4 * 1024 * 1024),
      })
      .strict()
      .parse(
        await this.json(connection, "/relay/claim", { limit: 1, waitMs: 25_000 }, pollingSignal)
          .catch((error: unknown) => {
            if (wake.signal.aborted && !signal?.aborted && this.deliveryFailures.length)
              throw this.deliveryFailures.shift();
            throw error;
          })
          .finally(() => {
            if (this.polling === wake) this.polling = undefined;
          }),
      );
    for (const claim of data.requests) {
      if (
        claim.deviceId !== connection.deviceId ||
        claim.userId !== connection.userId ||
        claim.connectionId !== connection.connectionId ||
        claim.deviceGeneration !== connection.deviceGeneration ||
        claim.deadlineAt <= Date.now() ||
        claim.claimExpiresAt <= Date.now()
      )
        throw new LocalRefusal(
          "LOCAL_IDENTITY_CHANGED",
          "A relay claim differs from this device's authority.",
        );
      if (this.deliveries.has(claim.requestId)) continue;
      const delivery = this.holdClaim(
        connection,
        claim,
        async (scope) => {
          let result;
          try {
            result = await this.retainedOutcome(rpc, claim);
            if (result === undefined) {
              const payload = await this.payload(connection, claim, scope);
              const message = localEnvelopeSchema.parse(JSON.parse(payload.toString("utf8")));
              const active = this.activeClaims.get(claim.requestId);
              if (active) active.action = message.request.action;
              if (
                message.id !== claim.requestId ||
                message.expiresAt !== claim.deadlineAt ||
                message.authority !== claim.authority
              )
                throw new LocalRefusal(
                  "LOCAL_PAYLOAD_CHANGED",
                  "The relay request identity or deadline changed.",
                );
              result = await this.dispatch(rpc, claim, message, scope);
            }
          } catch (error) {
            if (
              !(error instanceof LocalRefusal) &&
              !(error instanceof z.ZodError) &&
              !(error instanceof SyntaxError)
            )
              throw error;
            // A refused resource request gets the existing RPC error envelope; it is
            // not a revocation of independent work on sibling resources.
            result = rpc.failure(error);
          }
          const bytes = Buffer.from(JSON.stringify(result));
          if (Math.ceil(bytes.length / data.maxPartBytes) > 32)
            throw new LocalRefusal(
              "LOCAL_OUTPUT_LIMIT",
              "The result exceeds the configured relay's bounded part capacity.",
            );
          const parts: LocalRelayPayloadReference["parts"] = [];
          for (let offset = 0; offset < bytes.length; offset += data.maxPartBytes) {
            const part = bytes.subarray(offset, offset + data.maxPartBytes);
            const response = await this.request(
              connection,
              `/relay/${claim.requestId}/result-part`,
              { binary: part, claim: claim.claimId, signal: scope, limit: 8192 },
            );
            const uploaded = z
              .object({
                success: z.literal(true),
                data: localRelayPayloadReferenceSchema.innerType().shape.parts.element,
              })
              .passthrough()
              .parse(JSON.parse(response.toString("utf8"))).data;
            if (uploaded.size !== part.length || uploaded.sha256 !== hash(part))
              throw new LocalRefusal(
                "LOCAL_PAYLOAD_CHANGED",
                "The uploaded result part differs from its digest.",
              );
            parts.push(uploaded);
          }
          await this.json(
            connection,
            "/relay/ack",
            {
              requestId: claim.requestId,
              claimId: claim.claimId,
              digest: claim.digest,
              status: result.ok ? "completed" : "refused",
              outcomeReference: { parts, size: bytes.length, sha256: hash(bytes) },
            },
            scope,
          );
          // Keep the journal's cached result until expiry: another claim may replay a lost acknowledgement.
        },
        signal,
      );
      if (background) {
        const tracked = delivery
          .catch(async (error: unknown) => {
            if (error instanceof LocalRefusal && error.code === "LOCAL_CANCELLED") return;
            if (error instanceof LocalClaimRefusal && !signal?.aborted) {
              try {
                const current = await this.confirmed(signal);
                if (
                  current.deviceId === claim.deviceId &&
                  current.userId === claim.userId &&
                  current.connectionId === claim.connectionId &&
                  current.deviceGeneration === claim.deviceGeneration
                )
                  return;
              } catch (failure) {
                error = failure;
              }
            }
            if (!signal?.aborted) {
              this.deliveryFailures.push(error);
              this.polling?.abort();
            }
          })
          .finally(() => {
            if (this.deliveries.get(claim.requestId) === tracked)
              this.deliveries.delete(claim.requestId);
          });
        this.deliveries.set(claim.requestId, tracked);
      } else await delivery;
    }
    return data.requests.length;
  }
}
