import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import {
  CodespaceResourceError,
  LocalDeviceError,
  canonicalJson,
  localManagementOutcomeSchema,
  localRelayMutationId as mutationId,
  LOCAL_REQUEST_MAX_WINDOW_MS,
  type CodespaceResourceRecord,
  type CodespaceTransferService,
  type LocalDeviceService,
  type LocalRelayRequest,
} from "@mcp-moira/shared";

const replySchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), result: z.unknown() }).strict(),
  z
    .object({
      ok: z.literal(false),
      error: z
        .object({
          code: z.string().regex(/^LOCAL_[A-Z0-9_]{1,80}$/),
          message: z.string().max(500),
          management: localManagementOutcomeSchema.optional(),
        })
        .strict(),
    })
    .strict(),
]);

function refuseLocalReply(code: string): never {
  throw new CodespaceResourceError(
    code === "LOCAL_DELETE_APPROVAL_REQUIRED"
      ? "CODESPACE_LOCAL_DELETE_APPROVAL_REQUIRED"
      : code === "LOCAL_SETUP_INCOMPLETE"
        ? "CODESPACE_LOCAL_SETUP_INCOMPLETE"
        : code === "LOCAL_CREATE_UNKNOWN"
          ? "CODESPACE_LOCAL_CREATION_UNKNOWN"
          : code === "LOCAL_REQUEST_INVALID" || code === "LOCAL_PAYLOAD_CHANGED"
            ? "CODESPACE_LOCAL_PROTOCOL_ERROR"
            : code === "LOCAL_UNAUTHORIZED" || code === "LOCAL_REPOSITORY_DENIED"
              ? "CODESPACE_AUTHORIZATION_REQUIRED"
              : code === "LOCAL_SANDBOX_ABSENT"
                ? "CODESPACE_NOT_FOUND"
                : /(?:LEASE|CAPACITY|LIMIT|TOO_LARGE)/.test(code)
                  ? "CODESPACE_POLICY_LIMIT"
                  : /(?:IDENTITY|GENERATION|REPLAY|SETTLEMENT)/.test(code)
                    ? "CODESPACE_GENERATION_CONFLICT"
                    : /(?:NOT_RUNNING)/.test(code)
                      ? "CODESPACE_NOT_RUNNING"
                      : "CODESPACE_LOCAL_RUNTIME_ERROR",
    `Local companion refused the request (${code})`,
    undefined,
    !/(?:UNKNOWN|SETTLEMENT)/.test(code),
  );
}

/** Durable metadata and private transfer objects own dispatch before any delivery can happen. */
export class LocalCodespaceRelay {
  constructor(
    readonly devices: LocalDeviceService,
    readonly transfers: CodespaceTransferService,
    private readonly now: () => number = Date.now,
  ) {}

  private readonly pending = new Map<string, Promise<LocalRelayRequest>>();
  private authority(
    resource: CodespaceResourceRecord,
    request: Record<string, unknown>,
  ): "owner-delete" | undefined {
    if (!this.devices.isOwnerDeleteIntent(resource.userId, resource.id, resource.generation))
      return undefined;
    if (request.action !== "snapshot" && request.action !== "delete")
      throw new CodespaceResourceError(
        "CODESPACE_AUTHORIZATION_REQUIRED",
        "Owner cleanup cannot authorize work",
      );
    return "owner-delete";
  }

  /** Read an already authenticated durable receipt; never dispatch merely to resolve identity. */
  async completedResult(
    resource: CodespaceResourceRecord,
    request: Record<string, unknown>,
  ): Promise<unknown | null> {
    request = JSON.parse(JSON.stringify(request)) as Record<string, unknown>;
    const authority = this.authority(resource, request);
    const queued = this.devices.getRequest(
      resource.userId,
      mutationId(resource, request, authority),
    );
    if (!queued) return null;
    const binding = this.devices.getBinding(resource.userId, resource.id);
    if (
      !binding ||
      queued.resourceId !== resource.id ||
      queued.resourceGeneration !== resource.generation ||
      queued.deviceId !== binding.deviceId ||
      queued.deviceGeneration !== binding.deviceGeneration ||
      queued.connectionId !== binding.connectionId
    ) {
      throw new CodespaceResourceError(
        "CODESPACE_GENERATION_CONFLICT",
        "Local creation receipt authority changed",
      );
    }
    const digest = createHash("sha256")
      .update(
        canonicalJson({
          version: 1,
          id: queued.requestId,
          expiresAt: queued.deadlineAt,
          request,
          ...(authority ? { authority } : {}),
        }),
      )
      .digest("hex");
    const result = this.devices.getResult(resource.userId, queued.requestId);
    if (digest !== queued.digest || result?.digest !== digest) {
      throw new CodespaceResourceError(
        "CODESPACE_GENERATION_CONFLICT",
        "Local creation receipt digest changed",
      );
    }
    if (!["completed", "refused"].includes(result.status) || !result.outcomeReference) return null;
    const active = this.devices.getActiveDevice(queued.userId, queued.deviceId);
    if (active.deviceGeneration !== queued.deviceGeneration) {
      throw new CodespaceResourceError(
        "CODESPACE_AUTHORIZATION_REQUIRED",
        "Local device authority changed",
      );
    }
    const bytes = await this.transfers.readRelayPayload(
      resource.userId,
      "local_relay_output",
      result.outcomeReference,
    );
    const reply = replySchema.parse(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
    );
    if (!reply.ok) refuseLocalReply(reply.error.code);
    if (result.status !== "completed") {
      throw new CodespaceResourceError(
        "CODESPACE_LOCAL_PROTOCOL_ERROR",
        "Local outcome status disagrees",
      );
    }
    if (
      this.devices.getActiveDevice(queued.userId, queued.deviceId).deviceGeneration !==
      queued.deviceGeneration
    ) {
      throw new CodespaceResourceError(
        "CODESPACE_AUTHORIZATION_REQUIRED",
        "Local device authority changed",
      );
    }
    return reply.result;
  }

  async retain(
    resource: CodespaceResourceRecord,
    request: Record<string, unknown>,
    options: { mutation?: boolean; waitMs?: number } = {},
  ): Promise<LocalRelayRequest> {
    request = JSON.parse(JSON.stringify(request)) as Record<string, unknown>;
    if (!options.mutation) return this.prepare(resource, request, options);
    const key = mutationId(resource, request, this.authority(resource, request));
    const previous = this.pending.get(key);
    if (previous) return previous;
    const pending = this.prepare(resource, request, options).finally(() =>
      this.pending.delete(key),
    );
    this.pending.set(key, pending);
    return pending;
  }

  private async prepare(
    resource: CodespaceResourceRecord,
    request: Record<string, unknown>,
    options: { mutation?: boolean; waitMs?: number } = {},
  ): Promise<LocalRelayRequest> {
    try {
      request = JSON.parse(JSON.stringify(request)) as Record<string, unknown>;
      const binding = this.devices.getBinding(resource.userId, resource.id);
      if (!binding)
        throw new LocalDeviceError("LOCAL_UNAUTHORIZED", "Local resource is not bound.");
      const device = this.devices.getActiveDevice(resource.userId, binding.deviceId);
      if (device.deviceGeneration !== binding.deviceGeneration) {
        throw new LocalDeviceError("LOCAL_UNAUTHORIZED", "Local device generation changed.");
      }
      const authority = this.authority(resource, request);
      const requestId = options.mutation ? mutationId(resource, request, authority) : randomUUID();
      const previous = this.devices.getRequest(resource.userId, requestId);
      const deadlineAt =
        previous?.deadlineAt ??
        Math.min(
          this.now() +
            (request.action === "create"
              ? LOCAL_REQUEST_MAX_WINDOW_MS
              : Math.min(options.waitMs ?? 120_000, LOCAL_REQUEST_MAX_WINDOW_MS)),
          request.action === "create" ? resource.createDeadlineAt : Number.MAX_SAFE_INTEGER,
          authority ? Number.MAX_SAFE_INTEGER : device.policy.leaseUntil,
        );
      const bytes = Buffer.from(
        canonicalJson({
          version: 1,
          id: requestId,
          expiresAt: deadlineAt,
          request,
          ...(authority ? { authority } : {}),
        }),
      );
      if (bytes.length > 8 * 1024 * 1024) {
        throw new CodespaceResourceError(
          "CODESPACE_POLICY_LIMIT",
          "Local request exceeds its advertised envelope limit",
        );
      }
      const digest = createHash("sha256").update(bytes).digest("hex");
      if (previous && previous.digest !== digest) {
        throw new LocalDeviceError("LOCAL_CONFLICT", "Local request digest changed.");
      }
      const reference =
        previous?.payloadReference ??
        (await this.transfers.retainRelayPayload(resource.userId, "local_relay_input", bytes));
      try {
        const envelope: LocalRelayRequest = {
          userId: binding.userId,
          deviceId: binding.deviceId,
          deviceGeneration: binding.deviceGeneration,
          connectionId: binding.connectionId,
          resourceId: resource.id,
          requestId,
          resourceGeneration: resource.generation,
          digest,
          payloadReference: reference,
          deadlineAt,
          ...(authority ? { authority } : {}),
        };
        this.devices.enqueue(envelope);
        return envelope;
      } catch (error) {
        if (!previous)
          await this.transfers.discardRelayPayload(resource.userId, "local_relay_input", reference);
        throw error;
      }
    } catch (error) {
      return this.failure(error);
    }
  }

  async send(
    resource: CodespaceResourceRecord,
    request: Record<string, unknown>,
    options: { mutation?: boolean; waitMs?: number } = {},
  ): Promise<unknown> {
    try {
      // A completed mutation no longer needs delivery authority. Its current authenticated
      // identity and private receipt remain valid for the existing transfer TTL, even after the
      // original delivery deadline; never enqueue it again merely to read that receipt.
      if (
        options.mutation &&
        ["create", "start", "stop", "delete"].includes(String(request.action))
      ) {
        const receipt = await this.completedResult(resource, request);
        if (receipt !== null) return receipt;
      }
      const queued = await this.retain(resource, request, options);
      const { requestId, digest, deadlineAt } = queued;
      const waitUntil = Math.min(deadlineAt, this.now() + (options.waitMs ?? 120_000));
      for (;;) {
        const active = this.devices.getActiveDevice(queued.userId, queued.deviceId);
        if (active.deviceGeneration !== queued.deviceGeneration)
          throw new LocalDeviceError("LOCAL_UNAUTHORIZED", "Device authority changed.");
        const result = this.devices.getResult(resource.userId, requestId);
        if (!result || result.digest !== digest) {
          throw new LocalDeviceError("LOCAL_CONFLICT", "Local relay identity changed.");
        }
        if (result.status === "completed" || result.status === "refused") {
          if (!result.outcomeReference)
            throw new LocalDeviceError("LOCAL_INVALID", "Local outcome is missing.");
          let payload: Buffer;
          try {
            payload = await this.transfers.readRelayPayload(
              resource.userId,
              "local_relay_output",
              result.outcomeReference,
            );
          } catch {
            throw new CodespaceResourceError(
              "CODESPACE_RESULT_EXPIRED",
              "The short-lived relay reply is unavailable; inspect the existing operation",
            );
          }
          // Core has already persisted dispatch intent. If it crashes after receiving this reply,
          // its normal reconciliation inspects the durable guest marker instead of executing again.
          // Lifecycle retries address the same durable mutation identity. Retain its receipt until
          // the existing transfer expiry, including when its first observation did not converge.
          if (!["create", "start", "stop", "delete"].includes(String(request.action))) {
            await this.transfers.discardRelayPayload(
              resource.userId,
              "local_relay_input",
              queued.payloadReference,
            );
            await this.transfers.discardRelayPayload(
              resource.userId,
              "local_relay_output",
              result.outcomeReference,
            );
          }
          const reply = replySchema.parse(
            JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(payload)),
          );
          if (!reply.ok) {
            refuseLocalReply(reply.error.code);
          }
          if (result.status !== "completed")
            throw new LocalDeviceError("LOCAL_INVALID", "Local outcome status disagrees.");
          if (
            this.devices.getActiveDevice(queued.userId, queued.deviceId).deviceGeneration !==
            queued.deviceGeneration
          )
            throw new LocalDeviceError("LOCAL_UNAUTHORIZED", "Device authority changed.");
          return reply.result;
        }
        if (result.status === "expired" || result.status === "revoked") {
          throw new LocalDeviceError("LOCAL_EXPIRED", "Local delivery authority expired.");
        }
        if (this.now() >= waitUntil) {
          throw new CodespaceResourceError(
            "CODESPACE_PROVIDER_UNAVAILABLE",
            "Local device has not returned a durable outcome; reconcile the same operation",
          );
        }
        // Each read rechecks SQL authority; polling does not imply acknowledgement or redispatch.
        await delay(Math.min(100, Math.max(1, waitUntil - this.now())));
      }
    } catch (error) {
      return this.failure(error);
    }
  }

  private failure(error: unknown): never {
    if (error instanceof z.ZodError || error instanceof SyntaxError)
      throw new CodespaceResourceError(
        "CODESPACE_LOCAL_PROTOCOL_ERROR",
        "The local computer returned an invalid protocol response; update the companion and server together",
      );
    if (error instanceof LocalDeviceError) {
      throw new CodespaceResourceError(
        error.code === "LOCAL_UNAUTHORIZED"
          ? "CODESPACE_AUTHORIZATION_REQUIRED"
          : error.code === "LOCAL_CAPACITY"
            ? "CODESPACE_POLICY_LIMIT"
            : error.code === "LOCAL_CONFLICT"
              ? "CODESPACE_GENERATION_CONFLICT"
              : "CODESPACE_PROVIDER_UNAVAILABLE",
        error.message,
      );
    }
    throw error;
  }
}
