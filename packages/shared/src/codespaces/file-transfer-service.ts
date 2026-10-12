import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { canonicalJson } from "../utils/canonical-json.js";
import { localRelayPayloadReferenceSchema } from "./local-device-types.js";
import { effectiveCodespaceLimits } from "./resource-policy.js";
import { CodespaceResourceError } from "./resource-types.js";
import type {
  CodespaceExecRequest,
  CodespaceFileOperationResponse,
  CodespaceFileRequest,
  CodespaceFileResult,
  CodespaceFileRuntimeProbe,
  CodespaceFileTransferDescriptor,
  CodespaceFileTransport,
  CodespaceOperationRecord,
  CodespaceOperationResult,
  CodespaceOperationTransport,
  CodespaceResourcePolicy,
  CodespaceTransferAuthority,
  CodespaceTransferRecord,
  CodespaceTransferStatus,
} from "./resource-types.js";
import {
  CodespaceFileCapabilities,
  type CodespaceFileBootstrapClaims,
  type CodespaceFileCapabilityClaims,
} from "./file-transfer-capability.js";
import { CodespaceFileService, type CodespaceNativeFileTransfers } from "./file-service.js";
import { CodespaceOperationRepository } from "./operation-repository.js";
import type { CodespaceCredentialResolver } from "./resource-service.js";
import {
  CodespaceTransferService,
  type CodespaceNativeReferenceFetcher,
} from "./transfer-service.js";
import { settleAfterDispatch } from "./settle-after-dispatch.js";

interface AssetIdentity {
  abi: number;
  workerSha256: string | null;
  cliSha256: string;
}
interface FixedMaintenanceRequest {
  argv: readonly string[];
  stdin: Uint8Array;
  timeoutMs: number;
  maxStdoutBytes: number;
  maxStderrBytes: number;
  maxRetainedBytes: number;
}
interface FileClientConfiguration {
  version: 1;
  origin: string;
  bootstrapCapability: string;
  environmentIdentity: string;
  resourceId: string;
  repositoryFullName: string;
}
type NativeUploadInput = Parameters<CodespaceNativeFileTransfers["uploadReference"]>[2];
type NativeDownloadInput = Parameters<CodespaceNativeFileTransfers["downloadReference"]>[2];
type StoredIntent =
  | {
      version: 1;
      mode: "setup";
      life: string;
      expiresAt: number;
      assets: AssetIdentity;
      request: Omit<FixedMaintenanceRequest, "stdin"> & { stdinBase64: string };
    }
  | {
      version: 1;
      mode: "upload";
      anchorId: string;
      life: string;
      input: NativeUploadInput;
      transferId?: string;
      descriptor?: CodespaceFileTransferDescriptor;
    }
  | {
      version: 1;
      mode: "download";
      anchorId: string;
      life: string;
      input: NativeDownloadInput;
      descriptor: CodespaceFileTransferDescriptor;
    }
  | {
      version: 1;
      mode: "cli";
      anchorId: string;
      life: string;
      transferId?: string;
      sourceId?: string;
    };

type CliMintInput =
  | {
      requestId: string;
      direction: "guest_to_server";
      size: number;
      sha256: string;
      fileName: string;
      mimeType: string;
    }
  | { requestId: string; direction: "server_to_guest"; referenceId: string };

function requestId(value: string): string {
  if (!z.string().uuid().safeParse(value).success)
    throw new CodespaceResourceError("CODESPACE_RESOURCE_INVALID", "Invalid file request identity");
  return value.toLowerCase();
}
function digest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}
/** The guest supplies one measured executable path, never a shell expression or PATH guess. */
export function isCodespaceFileClientCommand(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.startsWith("/") &&
    value.length > 1 &&
    Buffer.byteLength(value) <= 4096 &&
    ![...value].some(
      (character) => character.charCodeAt(0) <= 31 || character.charCodeAt(0) === 127,
    )
  );
}
function resourceError(message: string, operationId?: string): never {
  throw new CodespaceResourceError(
    "CODESPACE_PROVIDER_UNAVAILABLE",
    message,
    "Keep the original request identity; an unknown outcome does not authorize another effect.",
    false,
    operationId,
  );
}

/** One resource/operation/private-transfer pipeline backs native attachments and the guest file client. */
export class CodespaceFileTransferService implements CodespaceNativeFileTransfers {
  private readonly pending = new Map<string, { digest: string; promise: Promise<unknown> }>();
  private readonly origin: string;
  constructor(
    private readonly dependencies: {
      repository: CodespaceOperationRepository;
      files: CodespaceFileService;
      transfers: CodespaceTransferService;
      credentials: CodespaceCredentialResolver;
      transport: CodespaceFileTransport & Pick<CodespaceOperationTransport, "execute" | "inspect">;
      policy: () => CodespaceResourcePolicy;
      origin: string;
      capabilities: CodespaceFileCapabilities;
      requireAccount: (userId: string) => void;
      assets: (provider: string) => Promise<AssetIdentity>;
      lifeProbe: () => FixedMaintenanceRequest;
      installer: (
        provider: string,
        config: FileClientConfiguration,
        deadlineAt: number,
      ) => Promise<FixedMaintenanceRequest>;
      nativeFetcher: CodespaceNativeReferenceFetcher;
      wake: () => void;
      now?: () => number;
    },
  ) {
    const origin = new URL(dependencies.origin);
    if (
      origin.username ||
      origin.password ||
      origin.search ||
      origin.hash ||
      origin.pathname !== "/"
    )
      throw new Error("File transfer origin must be a fixed origin");
    this.origin = origin.origin;
  }

  async setup(userId: string, codespaceId: string, input: { requestId: string }) {
    this.requireSecureOrigin();
    const id = requestId(input.requestId);
    const semantic = digest({ mode: "setup", codespaceId });
    return this.once(`${userId}:${id}`, semantic, async () => {
      this.dependencies.requireAccount(userId);
      const previous = this.dependencies.repository.getByRequest(userId, id);
      if (previous) {
        if (previous.resourceId !== codespaceId || previous.sessionKey !== "moira-file-client")
          throw new CodespaceResourceError(
            "CODESPACE_RESOURCE_INVALID",
            "Request identity belongs to another operation",
          );
        if (previous.inputReference) return this.setupResult(previous);
      }
      const observed = await this.observeLegacyLife(userId, codespaceId, id);
      const life = observed.environmentIdentity;
      const policy = this.dependencies.policy();
      const limits = effectiveCodespaceLimits(policy);
      const createdAt = this.now();
      const deadlineAt = createdAt + limits.operations.maxDurationMs;
      const operationId = randomUUID();
      const authority = {
        resourceId: codespaceId,
        provider: observed.codespace.provider,
        resourceGeneration: observed.codespace.generation,
        authorizationGeneration: observed.codespace.authorizationGeneration,
        environmentIdentity: life,
      };
      const claims: CodespaceFileBootstrapClaims = {
        kind: "bootstrap",
        userId,
        ...authority,
        operationId,
        expiresAt: createdAt + limits.transfers.ttlMs,
      };
      const assets = await this.dependencies.assets(authority.provider);
      const fixed = await this.dependencies.installer(
        authority.provider,
        {
          version: 1,
          origin: this.origin,
          bootstrapCapability: this.dependencies.capabilities.issue(claims),
          environmentIdentity: life,
          resourceId: codespaceId,
          repositoryFullName: observed.codespace.repositoryFullName,
        },
        deadlineAt,
      );
      if (fixed.stdin.byteLength > limits.operations.maxInputBytes)
        throw new CodespaceResourceError(
          "CODESPACE_POLICY_LIMIT",
          "File client assets exceed the maintenance bound",
        );
      const { stdin, ...request } = fixed;
      const plan: StoredIntent = {
        version: 1,
        mode: "setup",
        life,
        expiresAt: claims.expiresAt,
        assets,
        request: { ...request, stdinBase64: Buffer.from(stdin).toString("base64") },
      };
      const ref = await this.dependencies.transfers.retainRelayPayload(
        userId,
        "operation_input",
        Buffer.from(JSON.stringify(plan)),
        Math.max(deadlineAt + policy.cleanupDeadlineMs, claims.expiresAt),
      );
      let retained = false;
      try {
        this.dependencies.requireAccount(userId);
        const reserved = this.dependencies.repository.reserve({
          userId,
          resourceId: codespaceId,
          kind: "exec",
          requestId: id,
          requestDigest: semantic,
          sessionKey: "moira-file-client",
          inputBytes: effectiveCodespaceLimits(policy).operations.maxInputBytes,
          stdoutLimitBytes: 16384,
          stderrLimitBytes: 4096,
          deadlineAt,
          policy,
          now: createdAt,
          prepared: {
            operationId,
            inputReference: JSON.stringify(ref),
            ...authority,
            providerResourceName: observed.codespace.providerResourceName,
          },
        });
        if (!reserved.operation || !reserved.codespace || reserved.outcome !== "reserved")
          resourceError("Guest file client cannot be provisioned");
        const operation = reserved.operation;
        retained = operation.id === operationId;
        this.dependencies.wake();
        return this.setupResult(this.owned(userId, operation.id).operation);
      } finally {
        if (!retained)
          await this.dependencies.transfers.discardRelayPayload(userId, "operation_input", ref);
      }
    });
  }

  async uploadReference(
    userId: string,
    codespaceId: string,
    input: NativeUploadInput,
  ): Promise<CodespaceFileOperationResponse> {
    this.requireSecureOrigin();
    input = { ...input, requestId: requestId(input.requestId) };
    const semantic = digest({
      mode: "upload",
      codespaceId,
      path: input.path,
      expected: input.expected,
      fileId: input.reference.fileId,
      fileName: input.reference.fileName ?? null,
      mimeType: input.reference.mimeType ?? null,
      declaredSize: input.reference.declaredSize ?? null,
    });
    return this.once(`${userId}:${input.requestId}`, semantic, async () => {
      const previous = this.match(userId, codespaceId, input.requestId, semantic, "upload");
      if (previous && (previous.inputReference || previous.state !== "reserved"))
        return this.resumeOrCollect(previous, true);
      const anchor = this.anchor(userId, codespaceId);
      const probe = await this.freshProbe(anchor);
      const bound =
        input.reference.declaredSize ??
        effectiveCodespaceLimits(this.dependencies.policy()).transfers.maxFileBytes;
      const prepared = await this.dependencies.files.prepareNative(
        userId,
        codespaceId,
        { action: "upload", path: input.path, expected: input.expected, bytes: new Uint8Array() },
        bound,
        { requestId: input.requestId, requestDigest: semantic },
      );
      await this.attach(prepared.operation, {
        version: 1,
        mode: "upload",
        anchorId: anchor.id,
        life: probe.environmentIdentity,
        input,
      });
      this.dependencies.wake();
      return { operation: this.owned(userId, prepared.operation.id).operation, result: null };
    });
  }

  async downloadReference(userId: string, codespaceId: string, input: NativeDownloadInput) {
    this.requireSecureOrigin();
    input = { ...input, requestId: requestId(input.requestId) };
    const semantic = digest({ mode: "download", codespaceId, ...input });
    return this.once(`${userId}:${input.requestId}`, semantic, async () => {
      const previous = this.match(userId, codespaceId, input.requestId, semantic, "download");
      if (previous && (previous.inputReference || previous.state !== "reserved")) {
        await this.resumeOrCollect(previous, true);
        return this.collectDownload(userId, previous.id);
      }
      const anchor = this.anchor(userId, codespaceId);
      const probe = await this.freshProbe(anchor);
      if (!this.dependencies.transport.describeTransfer)
        resourceError("Guest transfer description is unavailable");
      const context = this.owned(userId, anchor.id);
      const credential = await this.dependencies.credentials.getCredential(
        userId,
        context.codespace.provider,
      );
      const description = await this.dependencies.transport.describeTransfer(
        credential,
        context.codespace,
        anchor,
        { path: input.path, maxBytes: input.maxBytes },
      );
      if (description.environmentIdentity !== probe.environmentIdentity)
        throw new CodespaceResourceError(
          "CODESPACE_GENERATION_CONFLICT",
          "Guest life changed during transfer preparation",
        );
      const prepared = await this.dependencies.files.prepareNative(
        userId,
        codespaceId,
        { action: "download", path: input.path, maxBytes: input.maxBytes },
        0,
        { requestId: input.requestId, requestDigest: semantic },
      );
      const authority = this.authority(prepared.operation, probe.environmentIdentity);
      const status = await this.dependencies.transfers.reserveResumable(userId, {
        requestId: input.requestId,
        requestDigest: semantic,
        purpose: "codespace_download",
        fileName: input.fileName,
        mimeType: input.mimeType,
        size: description.size,
        sha256: description.sha256,
        authority,
      });
      const descriptor = this.descriptor(anchor, status, input.mimeType, authority);
      await this.attach(prepared.operation, {
        version: 1,
        mode: "download",
        anchorId: anchor.id,
        life: probe.environmentIdentity,
        input,
        descriptor,
      });
      this.dependencies.wake();
      return {
        operation: this.owned(userId, prepared.operation.id).operation,
        transfer: status.handle ?? null,
      };
    });
  }

  async status(
    userId: string,
    codespaceId: string,
    input: { requestId: string; transferId?: string },
  ) {
    const id = requestId(input.requestId);
    this.dependencies.requireAccount(userId);
    const operation = this.dependencies.repository.getByRequest(userId, id);
    if (!operation || operation.resourceId !== codespaceId)
      return { operation: null, transfer: null };
    this.owned(userId, operation.id);
    const record = input.transferId
      ? this.dependencies.transfers.getOwnedTransfer(userId, input.transferId)
      : this.dependencies.transfers.getByRequest(userId, id);
    if (!record) return { operation, transfer: null };
    if (record.requestId !== id || record.resourceId !== codespaceId)
      throw new CodespaceResourceError("CODESPACE_NOT_FOUND", "Transfer was not found");
    if (!record.expectedSha256) return { operation, transfer: null };
    const transfer = await this.dependencies.transfers.getTransferStatus(
      userId,
      record.id,
      this.recordAuthority(record),
    );
    this.owned(userId, operation.id);
    return { operation, transfer };
  }

  async collectFile(userId: string, operationId: string): Promise<CodespaceFileOperationResponse> {
    const { operation } = this.owned(userId, operationId);
    if (operation.kind === "exec")
      throw new CodespaceResourceError(
        "CODESPACE_NOT_FOUND",
        "Native file operation was not found",
      );
    if (operation.resultReference)
      return { operation, result: (await this.result(operation)) as CodespaceFileResult };
    if (
      operation.state === "reserved" ||
      ["failed", "cancelled", "timed_out"].includes(operation.state)
    )
      return { operation, result: null };
    return this.resumeOrCollect(operation, false);
  }

  async collectDownload(userId: string, operationId: string) {
    const response = await this.collectFile(userId, operationId);
    if (response.operation.kind !== "download")
      throw new CodespaceResourceError("CODESPACE_NOT_FOUND", "Native download was not found");
    const record = this.dependencies.transfers.getByRequest(userId, response.operation.requestId!);
    if (!record || !record.expectedSha256) {
      if (response.operation.state === "succeeded")
        throw new CodespaceResourceError(
          "CODESPACE_RESULT_EXPIRED",
          "The original attachment is no longer retained",
        );
      return { operation: response.operation, transfer: null };
    }
    const status = await this.dependencies.transfers.getTransferStatus(
      userId,
      record.id,
      this.recordAuthority(record),
    );
    return { operation: response.operation, transfer: status.handle ?? null };
  }

  async recover(operation: CodespaceOperationRecord): Promise<boolean> {
    if (["succeeded", "failed", "cancelled", "timed_out"].includes(operation.state)) {
      // Terminal cleanup is independent of input/result collection. Guest-backed work
      // belongs to the common finalizer; a private-only admission owns no guest marker.
      if (operation.sessionKey !== "moira-private-file-transfer") return false;
      this.owned(operation.userId, operation.id);
      if (operation.resultExpiresAt !== null && operation.resultExpiresAt <= this.now())
        this.dependencies.repository.markRemoteFinalized(
          operation.userId,
          operation.id,
          this.now(),
        );
      return true;
    }
    if (operation.sessionKey === "moira-private-file-transfer") {
      await this.once(
        `${operation.userId}:${operation.requestId}`,
        operation.requestDigest!,
        async () => {
          await this.recoverPrivateObject(operation);
        },
      );
      return true;
    }
    const plan = await this.intent(operation);
    if (!plan) return false;
    if (plan.mode === "cli") return this.recoverPrivateObject(operation);
    if (operation.state !== "reserved") {
      if (plan.mode === "setup") await this.setupResult(operation);
      else await this.resumeOrCollect(operation, false);
      return true;
    }
    if (operation.deadlineAt <= this.now()) {
      this.dependencies.repository.cancelBeforeDispatch(
        operation.userId,
        operation.id,
        this.now(),
        "admission_expired_not_started",
        operation.claimId ?? undefined,
      );
      return true;
    }
    if (plan.mode === "setup") {
      const request = {
        ...plan.request,
        stdin: { kind: "inline" as const, bytes: Buffer.from(plan.request.stdinBase64, "base64") },
      };
      await this.dispatch(operation, request);
      return true;
    }
    const anchor = this.owned(operation.userId, plan.anchorId).operation;
    await this.freshProbe(anchor, plan.life);
    if (plan.mode === "upload" && !plan.descriptor) {
      const retained = this.dependencies.transfers.getByRequest(
        operation.userId,
        operation.requestId!,
      );
      if (plan.transferId && retained?.id !== plan.transferId)
        throw new CodespaceResourceError(
          "CODESPACE_RESULT_EXPIRED",
          "The original native input is no longer retained",
        );
      const claimId = operation.claimId;
      if (!claimId) resourceError("Native input admission is not claimed", operation.id);
      let boundOperation = operation;
      let boundPlan = plan;
      const handle = await this.dependencies.transfers.ingest(
        operation.userId,
        plan.input.reference,
        this.dependencies.nativeFetcher,
        operation.inputBytes,
        {
          requestId: operation.requestId!,
          requestDigest: operation.requestDigest!,
          authority: this.authority(operation, plan.life),
          direction: "server_to_guest",
          beforePublish: async (transferId) => {
            boundOperation = await this.bindTransfer(
              boundOperation,
              boundPlan,
              transferId,
              claimId,
            );
            boundPlan = { ...boundPlan, transferId };
          },
        },
      );
      const current = this.dependencies.repository.recordInputBytes(
        operation.userId,
        operation.id,
        handle.size,
        this.now(),
        operation.claimId ?? undefined,
      );
      if (!current) return true;
      const record = this.dependencies.transfers.getByRequest(
        operation.userId,
        operation.requestId!,
      )!;
      const status = await this.dependencies.transfers.getTransferStatus(
        operation.userId,
        record.id,
        this.recordAuthority(record),
      );
      const next: StoredIntent = {
        ...boundPlan,
        descriptor: this.descriptor(anchor, status, record.mimeType, this.recordAuthority(record)),
      };
      if (!(await this.replace(current, next, claimId))) return true;
      operation = this.owned(operation.userId, operation.id).operation;
      await this.dispatch(operation, this.fileRequest(next));
      return true;
    }
    await this.dispatch(operation, this.fileRequest(plan));
    return true;
  }

  readCapability(token: string): CodespaceFileCapabilityClaims {
    return this.dependencies.capabilities.read(token);
  }

  /** Verified limiter metadata; never probes or performs guest work. */
  async requestRateScope(token: string, method: string, path: string) {
    const claims = this.readCapability(token);
    const chunks = /^\/transfers\/([0-9a-f-]{36})\/chunks$/i.exec(path);
    if (claims.kind === "bootstrap") {
      if (method !== "POST" || !["/transfers", "/lookup"].includes(path))
        throw new CodespaceResourceError(
          "CODESPACE_AUTHORIZATION_REQUIRED",
          "File capability scope does not match",
        );
      await this.authorize(claims, false);
    } else {
      const match = /^\/transfers\/([0-9a-f-]{36})(?:\/(chunks|finalize))?$/i.exec(path);
      if (
        !match ||
        match[1] !== claims.transferId ||
        (match[2] === "chunks"
          ? !(
              (method === "GET" && claims.direction === "server_to_guest") ||
              (method === "PUT" && claims.direction === "guest_to_server")
            )
          : method !== (match[2] === "finalize" ? "POST" : "GET"))
      )
        throw new CodespaceResourceError(
          "CODESPACE_AUTHORIZATION_REQUIRED",
          "File capability scope does not match",
        );
      await this.transferClaims(token, claims.transferId, false);
    }
    const limits = effectiveCodespaceLimits(this.dependencies.policy()).transfers;
    const bytes = Math.min(
      limits.maxBytesPerUser,
      limits.maxBytesGlobal,
      limits.maxInflightBytesPerUser,
      limits.maxInflightBytesGlobal,
    );
    return {
      userId: claims.userId,
      phase: chunks ? ("chunks" as const) : ("control" as const),
      requestsPerMinute: chunks
        ? 2 * Math.ceil(bytes / limits.maxChunkBytes)
        : 8 * Math.min(limits.maxObjectsPerUser, limits.maxObjectsGlobal),
    };
  }

  async mint(token: string, input: CliMintInput) {
    this.requireSecureOrigin();
    const claims = this.readCapability(token);
    if (claims.kind !== "bootstrap")
      throw new CodespaceResourceError(
        "CODESPACE_AUTHORIZATION_REQUIRED",
        "A bootstrap file capability is required",
      );
    await this.authorize(claims, true);
    const id = requestId(input.requestId);
    const semantic = digest({ resourceId: claims.resourceId, ...input, requestId: id });
    await this.once(`${claims.userId}:${id}`, semantic, async () => {
      await this.mintAccepted(claims, input, id, semantic);
    });
    await this.authorize(claims, true);
    const record = this.dependencies.transfers.getByRequest(claims.userId, id);
    if (!record)
      throw new CodespaceResourceError(
        "CODESPACE_RESULT_EXPIRED",
        "The original transfer is no longer retained",
      );
    const authority = this.recordAuthority(record);
    const status = await this.dependencies.transfers.getTransferStatus(
      claims.userId,
      record.id,
      authority,
    );
    return {
      descriptor: this.descriptor(
        this.owned(claims.userId, claims.operationId).operation,
        status,
        record.mimeType,
        authority,
      ),
      status: this.publicStatus(status),
    };
  }

  private async mintAccepted(
    claims: CodespaceFileBootstrapClaims,
    input: CliMintInput,
    id: string,
    semantic: string,
  ): Promise<void> {
    const previous = this.dependencies.repository.getByRequest(claims.userId, id);
    const existing = this.dependencies.transfers.getByRequest(claims.userId, id);
    if (
      previous &&
      (previous.resourceId !== claims.resourceId || previous.requestDigest !== semantic)
    )
      throw new CodespaceResourceError(
        "CODESPACE_RESOURCE_INVALID",
        "Transfer identity belongs to different input",
      );
    if (previous && !existing && previous.state !== "reserved")
      throw new CodespaceResourceError(
        "CODESPACE_RESULT_EXPIRED",
        "The original transfer is no longer retained",
      );
    if (previous && existing) {
      if (
        previous.resourceId !== claims.resourceId ||
        previous.requestDigest !== semantic ||
        existing.requestDigest !== semantic ||
        existing.direction !== input.direction
      )
        throw new CodespaceResourceError(
          "CODESPACE_RESOURCE_INVALID",
          "Transfer identity belongs to different input",
        );
      this.owned(claims.userId, previous.id);
      if (!previous.inputReference && previous.state === "reserved") {
        const source =
          input.direction === "server_to_guest"
            ? this.privateSource(claims.userId, input.referenceId)
            : null;
        await this.attach(previous, {
          version: 1,
          mode: "cli",
          anchorId: claims.operationId,
          life: claims.environmentIdentity,
          transferId: existing.id,
          ...(source ? { sourceId: source.id } : {}),
        });
      }
      await this.recoverPrivateObject(this.owned(claims.userId, previous.id).operation);
      const authority = this.recordAuthority(existing);
      const status = await this.dependencies.transfers.getTransferStatus(
        claims.userId,
        existing.id,
        authority,
      );
      if (status.handle)
        await this.completePrivateObject(
          this.owned(claims.userId, previous.id).operation,
          existing.fileName,
          status,
        );
      return;
    }
    const source =
      input.direction === "server_to_guest"
        ? this.privateSource(claims.userId, input.referenceId)
        : null;
    const metadata =
      input.direction === "guest_to_server"
        ? input
        : {
            size: source!.declaredSize,
            sha256: source!.sha256!,
            fileName: source!.fileName,
            mimeType: source!.mimeType,
          };
    const reservation = this.dependencies.repository.reserve({
      userId: claims.userId,
      resourceId: claims.resourceId,
      kind: "download",
      sessionKey: "moira-private-file-transfer",
      requestId: id,
      requestDigest: semantic,
      inputBytes: input.direction === "server_to_guest" ? metadata.size : 0,
      stdoutLimitBytes: metadata.size,
      stderrLimitBytes: 1,
      deadlineAt: claims.expiresAt,
      policy: this.dependencies.policy(),
      now: this.now(),
    });
    if (!reservation.operation) resourceError("File transfer cannot be admitted");
    const authority = this.authority(reservation.operation, claims.environmentIdentity);
    let status: CodespaceTransferStatus;
    if (input.direction === "guest_to_server") {
      status = await this.dependencies.transfers.reserveResumable(claims.userId, {
        requestId: id,
        requestDigest: semantic,
        purpose: "codespace_download",
        ...metadata,
        authority,
      });
      await this.attach(reservation.operation, {
        version: 1,
        mode: "cli",
        anchorId: claims.operationId,
        life: claims.environmentIdentity,
        transferId: status.transferId,
      });
    } else {
      // Retain the source identity before reserving/writing the copy so scheduled
      // recovery can continue the accepted request even if the first reply is lost.
      const copyPlan: Extract<StoredIntent, { mode: "cli" }> = {
        version: 1,
        mode: "cli",
        anchorId: claims.operationId,
        life: claims.environmentIdentity,
        sourceId: source!.id,
      };
      await this.attach(reservation.operation, copyPlan);
      const claimId = randomUUID();
      if (
        !this.dependencies.repository.beginDispatch(
          claims.userId,
          reservation.operation.id,
          claimId,
          this.now() + this.dependencies.policy().claimLeaseMs,
          this.now(),
        )
      )
        resourceError("Private source copy admission changed", reservation.operation.id);
      // Materialize a new request-bound private object through the common stream writer;
      // the original source remains owned, immutable and independently reopenable.
      const admitted = {
        ...this.owned(claims.userId, reservation.operation.id).operation,
        claimId,
      };
      status = await this.copySource(claims.userId, id, semantic, source!, authority, async () => {
        await this.authorize(claims, true);
        const record = this.dependencies.transfers.getByRequest(claims.userId, id);
        if (!record) resourceError("Private copy reservation disappeared", admitted.id);
        await this.bindTransfer(admitted, copyPlan, record.id, claimId);
      });
    }
    if (this.owned(claims.userId, reservation.operation.id).operation.state === "reserved")
      this.dependencies.repository.beginDispatch(
        claims.userId,
        reservation.operation.id,
        randomUUID(),
        this.now() + this.dependencies.policy().claimLeaseMs,
        this.now(),
      );
    if (status.handle)
      await this.completePrivateObject(
        this.owned(claims.userId, reservation.operation.id).operation,
        metadata.fileName,
        status,
      );
  }

  async lookup(token: string, id: string) {
    const claims = this.readCapability(token);
    if (claims.kind !== "bootstrap")
      throw new CodespaceResourceError(
        "CODESPACE_AUTHORIZATION_REQUIRED",
        "A bootstrap file capability is required",
      );
    await this.authorize(claims, false);
    const observed = await this.status(claims.userId, claims.resourceId, { requestId: id });
    if (!observed.transfer)
      throw new CodespaceResourceError("CODESPACE_NOT_FOUND", "Transfer was not found");
    return this.publicStatus(observed.transfer);
  }

  async transferStatus(token: string, transferId: string) {
    const claims = await this.transferClaims(token, transferId, false);
    const status = await this.dependencies.transfers.getTransferStatus(
      claims.userId,
      transferId,
      claims,
    );
    await this.authorize(claims, false);
    return this.publicStatus(status);
  }
  async writeChunk(
    token: string,
    transferId: string,
    input: { offset: number; bytes: Uint8Array; sha256: string },
  ) {
    const claims = await this.transferClaims(token, transferId, true);
    if (claims.direction !== "guest_to_server")
      throw new CodespaceResourceError(
        "CODESPACE_AUTHORIZATION_REQUIRED",
        "File capability cannot upload bytes",
      );
    return this.publicStatus(
      await this.dependencies.transfers.writeTransferChunk(
        claims.userId,
        transferId,
        claims,
        input,
      ),
    );
  }
  async readChunk(token: string, transferId: string, input: { offset: number; length: number }) {
    const claims = await this.transferClaims(token, transferId, true);
    if (claims.direction !== "server_to_guest")
      throw new CodespaceResourceError(
        "CODESPACE_AUTHORIZATION_REQUIRED",
        "File capability cannot download bytes",
      );
    const result = await this.dependencies.transfers.readTransferRange(
      claims.userId,
      transferId,
      claims,
      input,
    );
    await this.authorize(claims, true);
    return result;
  }
  async finalize(token: string, transferId: string) {
    const claims = await this.transferClaims(token, transferId, false);
    if (claims.direction === "server_to_guest") await this.authorize(claims, true);
    const handle = await this.dependencies.transfers.finalizeTransfer(
      claims.userId,
      transferId,
      claims,
      () => this.authorize(claims, true).then(() => undefined),
    );
    const record = this.dependencies.transfers.getOwnedTransfer(claims.userId, transferId)!;
    const operation = this.dependencies.repository.getByRequest(claims.userId, record.requestId!)!;
    const plan = await this.intent(operation);
    if (plan?.mode === "download")
      await this.completeFile(operation, {
        action: "download",
        transferId,
        path: plan.input.path,
        size: handle.size,
        sha256: handle.sha256,
        referenceId: handle.referenceId,
      });
    else if (plan?.mode === "cli")
      await this.completeFile(
        operation,
        {
          action: "download",
          transferId,
          path: record.fileName,
          size: handle.size,
          sha256: handle.sha256,
          referenceId: handle.referenceId,
        },
        claims.direction === "server_to_guest" ? "private_source_ready" : "private_object_ready",
      );
    return { transferId, scope: "private_object" as const, state: "ready" as const, ...handle };
  }

  private async observeLegacyLife(userId: string, resourceId: string, setupRequestId: string) {
    const fixed = this.dependencies.lifeProbe();
    const policy = this.dependencies.policy();
    const identity = digest({ purpose: "file-client-life", setupRequestId });
    const probeRequestId = `${identity.slice(0, 8)}-${identity.slice(8, 12)}-4${identity.slice(13, 16)}-8${identity.slice(17, 20)}-${identity.slice(20, 32)}`;
    const reserved = this.dependencies.repository.reserve({
      userId,
      resourceId,
      kind: "exec",
      inputBytes: 0,
      stdoutLimitBytes: fixed.maxStdoutBytes,
      stderrLimitBytes: fixed.maxStderrBytes,
      deadlineAt: this.now() + fixed.timeoutMs,
      policy,
      now: this.now(),
      requestId: probeRequestId,
    });
    if (!reserved.operation || !reserved.codespace) resourceError("Guest life cannot be observed");
    const operation = reserved.operation;
    this.dependencies.requireAccount(userId);
    const credential = await this.dependencies.credentials.getCredential(
      userId,
      operation.provider,
    );
    const shadow = { ...operation, requestDigest: null };
    let observed;
    if (operation.resultReference)
      observed = (await this.result(operation)) as CodespaceOperationResult;
    else if (
      operation.state === "reserved" &&
      this.dependencies.repository.beginDispatch(
        userId,
        operation.id,
        randomUUID(),
        this.now() + fixed.timeoutMs,
        this.now(),
      )
    )
      observed = await this.dependencies.transport.execute(credential, reserved.codespace, shadow, {
        ...fixed,
        stdin: { kind: "inline", bytes: fixed.stdin },
      });
    else
      observed = await this.dependencies.transport.inspect(credential, reserved.codespace, shadow);
    const result =
      "stdout" in observed
        ? observed
        : await settleAfterDispatch(undefined, async () => {
            const collected = await this.dependencies.transport.inspect(
              credential,
              reserved.codespace!,
              shadow,
            );
            return "stdout" in collected ? collected : null;
          });
    if (!result || result.state !== "succeeded" || result.exitCode !== 0)
      resourceError("Guest life probe is unconfirmed", operation.id);
    const value = JSON.parse(result.stdout) as { environmentIdentity?: unknown };
    if (
      Object.keys(value).length !== 1 ||
      typeof value.environmentIdentity !== "string" ||
      !/^[a-f0-9]{64}$/.test(value.environmentIdentity)
    )
      resourceError("Guest life probe is invalid", operation.id);
    if (!operation.resultReference) {
      const expiresAt = this.now() + effectiveCodespaceLimits(policy).transfers.ttlMs;
      const ref = await this.dependencies.transfers.retainRelayPayload(
        userId,
        "operation_result",
        Buffer.from(JSON.stringify(result)),
        expiresAt,
      );
      if (
        !this.dependencies.repository.complete(
          userId,
          operation.id,
          result,
          fixed.maxStdoutBytes,
          fixed.maxStderrBytes,
          expiresAt,
          this.now(),
          "file_client_life_observed",
          JSON.stringify(ref),
        )
      )
        await this.dependencies.transfers.discardRelayPayload(userId, "operation_result", ref);
    }
    return {
      environmentIdentity: value.environmentIdentity,
      codespace: this.owned(userId, operation.id).codespace,
    };
  }

  private async setupResult(operation: CodespaceOperationRecord) {
    if (
      operation.state === "succeeded" &&
      (operation.resultExpiresAt === null || operation.resultExpiresAt <= this.now())
    )
      throw new CodespaceResourceError(
        "CODESPACE_RESULT_EXPIRED",
        "Guest file client provisioning must be renewed with a new request identity",
      );
    const output = {
      requestId: operation.requestId!,
      operationId: operation.id,
      provisioned: false,
      command: null,
    };
    if (["reconcile_pending", "running"].includes(operation.state)) {
      const context = this.owned(operation.userId, operation.id);
      const credential = await this.dependencies.credentials.getCredential(
        operation.userId,
        operation.provider,
      );
      const result = await this.dependencies.transport.inspect(credential, context.codespace, {
        ...operation,
        requestDigest: null,
      });
      if ("stdout" in result) {
        await this.completeSetup(operation, result);
        operation = this.owned(operation.userId, operation.id).operation;
      }
    }
    if (["failed", "cancelled", "timed_out"].includes(operation.state))
      resourceError("Guest file client provisioning did not complete", operation.id);
    if (operation.state !== "succeeded") return output;
    const probe = await this.freshProbe(operation);
    return { ...output, provisioned: true, ...probe };
  }

  private async freshProbe(
    anchor: CodespaceOperationRecord,
    life?: string,
  ): Promise<CodespaceFileRuntimeProbe> {
    const context = this.owned(anchor.userId, anchor.id);
    const accepted = await this.intent(anchor);
    if (accepted?.mode !== "setup")
      throw new CodespaceResourceError(
        "CODESPACE_LOCAL_SETUP_INCOMPLETE",
        "Accepted guest file provisioning intent is unavailable",
      );
    if (life && life !== accepted.life)
      throw new CodespaceResourceError(
        "CODESPACE_GENERATION_CONFLICT",
        "Transfer belongs to different provisioning life",
      );
    life = accepted.life;
    if (!this.dependencies.transport.probeFile)
      resourceError("Guest file runtime cannot be observed", anchor.id);
    const credential = await this.dependencies.credentials.getCredential(
      anchor.userId,
      context.codespace.provider,
    );
    const probe = await this.dependencies.transport.probeFile(
      credential,
      context.codespace,
      anchor,
    );
    this.owned(anchor.userId, anchor.id);
    const expected = await this.dependencies.assets(context.codespace.provider);
    if (
      probe.abi !== expected.abi ||
      probe.cliSha256 !== expected.cliSha256 ||
      probe.workerSha256 !== expected.workerSha256 ||
      !isCodespaceFileClientCommand(probe.command) ||
      probe.executableSha256 !== probe.cliSha256
    )
      throw new CodespaceResourceError(
        "CODESPACE_LOCAL_SETUP_INCOMPLETE",
        "Guest file assets require supported provisioning",
      );
    if (life && life !== probe.environmentIdentity)
      throw new CodespaceResourceError(
        "CODESPACE_GENERATION_CONFLICT",
        "Provider-observed guest life changed",
      );
    this.owned(anchor.userId, anchor.id);
    return probe;
  }

  private async authorize(claims: CodespaceFileCapabilityClaims, newWork: boolean) {
    const requireLiveCapability = () => {
      if (claims.expiresAt <= this.now())
        throw new CodespaceResourceError(
          "CODESPACE_AUTHORIZATION_REQUIRED",
          "File capability expired",
        );
    };
    requireLiveCapability();
    const context = this.owned(claims.userId, claims.operationId);
    if (
      context.operation.state !== "succeeded" ||
      context.operation.lastOutcome !== "file_client_provisioned"
    )
      throw new CodespaceResourceError(
        "CODESPACE_AUTHORIZATION_REQUIRED",
        "File client provisioning is not confirmed",
      );
    if (
      context.codespace.id !== claims.resourceId ||
      context.codespace.provider !== claims.provider ||
      context.codespace.authorizationGeneration !== claims.authorizationGeneration
    )
      throw new CodespaceResourceError(
        "CODESPACE_AUTHORIZATION_REQUIRED",
        "File capability authority changed",
      );
    if (newWork) {
      if (
        context.codespace.generation !== claims.resourceGeneration ||
        context.codespace.state !== "usable" ||
        context.codespace.desiredState !== "running"
      )
        throw new CodespaceResourceError(
          "CODESPACE_GENERATION_CONFLICT",
          "File work authority changed",
        );
      await this.freshProbe(context.operation, claims.environmentIdentity);
      requireLiveCapability();
      const current = this.owned(claims.userId, claims.operationId).codespace;
      if (
        current.generation !== claims.resourceGeneration ||
        current.state !== "usable" ||
        current.desiredState !== "running"
      )
        throw new CodespaceResourceError(
          "CODESPACE_GENERATION_CONFLICT",
          "File work authority changed",
        );
    }
    return context;
  }

  private async transferClaims(token: string, id: string, newWork: boolean) {
    const claims = this.readCapability(token);
    if (claims.kind !== "transfer" || claims.transferId !== id)
      throw new CodespaceResourceError(
        "CODESPACE_AUTHORIZATION_REQUIRED",
        "File capability scope does not match",
      );
    await this.authorize(claims, newWork);
    const record = this.dependencies.transfers.getOwnedTransfer(claims.userId, id);
    if (
      !record ||
      record.direction !== claims.direction ||
      record.declaredSize !== claims.size ||
      record.expectedSha256 !== claims.sha256
    )
      throw new CodespaceResourceError(
        "CODESPACE_AUTHORIZATION_REQUIRED",
        "Transfer metadata changed",
      );
    return claims;
  }

  private anchor(userId: string, resourceId: string) {
    this.dependencies.requireAccount(userId);
    const anchor = this.dependencies.repository.getFileClientAnchor(userId, resourceId, this.now());
    if (!anchor)
      throw new CodespaceResourceError(
        "CODESPACE_LOCAL_SETUP_INCOMPLETE",
        "Provision the guest file client before binary transfer",
      );
    const context = this.owned(userId, anchor.id);
    if (context.codespace.generation !== anchor.resourceGeneration)
      throw new CodespaceResourceError(
        "CODESPACE_GENERATION_CONFLICT",
        "Provisioning authority must be renewed before new file work",
      );
    return anchor;
  }
  private owned(userId: string, operationId: string) {
    this.dependencies.requireAccount(userId);
    return this.dependencies.repository.requireAuthority(
      userId,
      operationId,
      this.dependencies.policy(),
    );
  }
  private authority(
    operation: CodespaceOperationRecord,
    environmentIdentity: string,
  ): CodespaceTransferAuthority {
    return {
      resourceId: operation.resourceId,
      provider: operation.provider,
      resourceGeneration: operation.resourceGeneration,
      authorizationGeneration: operation.authorizationGeneration,
      environmentIdentity,
    };
  }
  private recordAuthority(record: CodespaceTransferRecord): CodespaceTransferAuthority {
    if (
      !record.resourceId ||
      !record.provider ||
      record.resourceGeneration == null ||
      record.authorizationGeneration == null ||
      !record.environmentIdentity
    )
      throw new CodespaceResourceError(
        "CODESPACE_RESOURCE_INVALID",
        "Transfer authority is unavailable",
      );
    return {
      resourceId: record.resourceId,
      provider: record.provider,
      resourceGeneration: record.resourceGeneration,
      authorizationGeneration: record.authorizationGeneration,
      environmentIdentity: record.environmentIdentity,
    };
  }
  private bootstrap(
    operation: CodespaceOperationRecord,
    life: string,
  ): CodespaceFileBootstrapClaims {
    return {
      kind: "bootstrap",
      userId: operation.userId,
      ...this.authority(operation, life),
      operationId: operation.id,
      expiresAt:
        operation.createdAt + effectiveCodespaceLimits(this.dependencies.policy()).transfers.ttlMs,
    };
  }
  private descriptor(
    anchor: CodespaceOperationRecord,
    status: CodespaceTransferStatus,
    mimeType: string,
    authority: CodespaceTransferAuthority,
  ): CodespaceFileTransferDescriptor {
    const expiresAt = Math.min(
      status.expiresAt,
      anchor.resultExpiresAt ?? this.bootstrap(anchor, authority.environmentIdentity).expiresAt,
    );
    return {
      version: 1,
      transferId: status.transferId,
      requestId: status.requestId,
      direction: status.direction,
      size: status.size,
      sha256: status.sha256,
      mimeType,
      chunkBytes: 262144,
      origin: this.origin,
      expiresAt,
      environmentIdentity: authority.environmentIdentity,
      capability: this.dependencies.capabilities.issue({
        kind: "transfer",
        userId: anchor.userId,
        ...authority,
        operationId: anchor.id,
        expiresAt,
        transferId: status.transferId,
        direction: status.direction,
        size: status.size,
        sha256: status.sha256,
      }),
    };
  }
  private publicStatus(status: CodespaceTransferStatus) {
    return {
      transferId: status.transferId,
      scope: "private_object" as const,
      requestId: status.requestId,
      state: status.state,
      offset: status.offset,
      size: status.size,
      sha256: status.sha256,
      expiresAt: status.expiresAt,
      ...(status.handle
        ? { receipt: { transferId: status.transferId, state: "ready", ...status.handle } }
        : {}),
    };
  }

  private match(
    userId: string,
    resourceId: string,
    id: string,
    requestDigest: string,
    kind: "upload" | "download",
  ) {
    const operation = this.dependencies.repository.getByRequest(userId, id);
    if (
      operation &&
      (operation.resourceId !== resourceId ||
        operation.requestDigest !== requestDigest ||
        operation.kind !== kind)
    )
      throw new CodespaceResourceError(
        "CODESPACE_RESOURCE_INVALID",
        "Request identity belongs to different file input",
      );
    if (operation) this.owned(userId, operation.id);
    return operation;
  }
  private async once<T>(key: string, requestDigest: string, work: () => Promise<T>): Promise<T> {
    const prior = this.pending.get(key);
    if (prior) {
      if (prior.digest !== requestDigest)
        throw new CodespaceResourceError(
          "CODESPACE_RESOURCE_INVALID",
          "Request identity belongs to different file input",
        );
      return prior.promise as Promise<T>;
    }
    const task = work();
    const entry = { digest: requestDigest, promise: task };
    this.pending.set(key, entry);
    try {
      return await task;
    } finally {
      if (this.pending.get(key) === entry) this.pending.delete(key);
    }
  }
  private async attach(operation: CodespaceOperationRecord, plan: StoredIntent) {
    const ref = await this.dependencies.transfers.retainRelayPayload(
      operation.userId,
      "operation_input",
      Buffer.from(JSON.stringify(plan)),
      operation.deadlineAt + this.dependencies.policy().cleanupDeadlineMs,
    );
    if (
      !this.dependencies.repository.attachInput(
        operation.userId,
        operation.id,
        JSON.stringify(ref),
        this.now(),
      )
    ) {
      await this.dependencies.transfers.discardRelayPayload(
        operation.userId,
        "operation_input",
        ref,
      );
      if (!this.owned(operation.userId, operation.id).operation.inputReference)
        resourceError("File intent is not yet durably attached", operation.id);
    }
  }
  private async replace(operation: CodespaceOperationRecord, plan: StoredIntent, claimId: string) {
    const ref = await this.dependencies.transfers.retainRelayPayload(
      operation.userId,
      "operation_input",
      Buffer.from(JSON.stringify(plan)),
      operation.deadlineAt + this.dependencies.policy().cleanupDeadlineMs,
    );
    const changed = this.dependencies.repository.replaceAcceptedInput(
      operation.userId,
      operation.id,
      operation.inputReference!,
      JSON.stringify(ref),
      claimId,
      this.now(),
    );
    if (!changed)
      await this.dependencies.transfers.discardRelayPayload(
        operation.userId,
        "operation_input",
        ref,
      );
    else
      await this.dependencies.transfers.discardRelayPayload(
        operation.userId,
        "operation_input",
        localRelayPayloadReferenceSchema.parse(JSON.parse(operation.inputReference!)),
      );
    return changed ? { ...operation, inputReference: JSON.stringify(ref) } : null;
  }
  private async bindTransfer(
    operation: CodespaceOperationRecord,
    plan: Extract<StoredIntent, { mode: "cli" | "upload" }>,
    transferId: string,
    claimId: string,
  ): Promise<CodespaceOperationRecord> {
    const check = (reference: string | null) => {
      const current = this.owned(operation.userId, operation.id).operation;
      if (
        current.claimId !== claimId ||
        current.inputReference !== reference ||
        current.deadlineAt <= this.now()
      )
        resourceError("Private input preparation claim changed", operation.id);
    };
    check(operation.inputReference ?? null);
    if (plan.transferId) {
      if (plan.transferId !== transferId)
        throw new CodespaceResourceError(
          "CODESPACE_RESOURCE_INVALID",
          "Original transfer identity changed",
        );
      return operation;
    }
    const bound = await this.replace(operation, { ...plan, transferId }, claimId);
    if (!bound) resourceError("Private input preparation claim changed", operation.id);
    check(bound.inputReference ?? null);
    return bound;
  }
  private async intent(operation: CodespaceOperationRecord): Promise<StoredIntent | null> {
    if (!operation.inputReference) return null;
    const bytes = await this.dependencies.transfers.readRelayPayload(
      operation.userId,
      "operation_input",
      localRelayPayloadReferenceSchema.parse(JSON.parse(operation.inputReference)),
    );
    const plan = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    ) as StoredIntent;
    if (plan.version !== 1 || !["setup", "upload", "download", "cli"].includes(plan.mode))
      return null;
    return plan;
  }
  private async result(operation: CodespaceOperationRecord) {
    if (operation.resultExpiresAt === null || operation.resultExpiresAt <= this.now())
      throw new CodespaceResourceError(
        "CODESPACE_RESULT_EXPIRED",
        "The original file result is no longer retained",
      );
    const bytes = await this.dependencies.transfers.readRelayPayload(
      operation.userId,
      "operation_result",
      localRelayPayloadReferenceSchema.parse(JSON.parse(operation.resultReference!)),
    );
    this.owned(operation.userId, operation.id);
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as
      CodespaceFileResult | CodespaceOperationResult;
  }
  private fileRequest(
    plan: Extract<StoredIntent, { mode: "upload" | "download" }>,
  ): CodespaceFileRequest {
    if (!plan.descriptor) resourceError("Native input is not yet retained");
    return plan.mode === "upload"
      ? {
          action: "upload",
          path: plan.input.path,
          bytes: new Uint8Array(),
          expected: plan.input.expected,
          transfer: plan.descriptor,
        }
      : {
          action: "download",
          path: plan.input.path,
          maxBytes: plan.input.maxBytes,
          transfer: plan.descriptor,
        };
  }
  private async dispatch(
    operation: CodespaceOperationRecord,
    request: CodespaceFileRequest | CodespaceExecRequest,
  ) {
    const context = this.owned(operation.userId, operation.id);
    const credential = await this.dependencies.credentials.getCredential(
      operation.userId,
      operation.provider,
    );
    if (
      this.owned(operation.userId, operation.id).codespace.generation !==
      operation.resourceGeneration
    )
      throw new CodespaceResourceError(
        "CODESPACE_GENERATION_CONFLICT",
        "Prepared file work authority changed",
      );
    if (
      !this.dependencies.repository.beginDispatch(
        operation.userId,
        operation.id,
        randomUUID(),
        this.now() + this.dependencies.policy().claimLeaseMs,
        this.now(),
        undefined,
        operation.claimId ?? undefined,
      )
    )
      return;
    const observed =
      "action" in request
        ? await this.dependencies.transport.executeFile(
            credential,
            context.codespace,
            operation,
            request,
          )
        : await this.dependencies.transport.execute(
            credential,
            context.codespace,
            { ...operation, requestDigest: null },
            request,
          );
    this.owned(operation.userId, operation.id);
    if ("stdout" in observed) await this.completeSetup(operation, observed);
    else if ("action" in observed) await this.completeFile(operation, observed);
  }
  private async resumeOrCollect(
    operation: CodespaceOperationRecord,
    resume: boolean,
  ): Promise<CodespaceFileOperationResponse> {
    if (operation.resultReference)
      return { operation, result: (await this.result(operation)) as CodespaceFileResult };
    const plan = await this.intent(operation);
    if (!plan || plan.mode === "setup" || plan.mode === "cli" || operation.state === "reserved")
      return { operation, result: null };
    const context = this.owned(operation.userId, operation.id);
    const credential = await this.dependencies.credentials.getCredential(
      operation.userId,
      operation.provider,
    );
    if (resume)
      await this.freshProbe(this.owned(operation.userId, plan.anchorId).operation, plan.life);
    const result =
      resume && this.dependencies.transport.resumeFile
        ? await this.dependencies.transport.resumeFile(
            credential,
            context.codespace,
            operation,
            this.fileRequest(plan),
          )
        : await this.dependencies.transport.inspectFile(credential, context.codespace, operation);
    this.owned(operation.userId, operation.id);
    if (!("action" in result))
      return { operation: this.owned(operation.userId, operation.id).operation, result: null };
    await this.completeFile(operation, result);
    const current = this.owned(operation.userId, operation.id).operation;
    return {
      operation: current,
      result: current.resultReference
        ? ((await this.result(current)) as CodespaceFileResult)
        : null,
    };
  }
  private async completeSetup(
    operation: CodespaceOperationRecord,
    result: CodespaceOperationResult,
  ) {
    const plan = await this.intent(operation);
    if (plan?.mode !== "setup")
      resourceError("File maintenance intent is unavailable", operation.id);
    if (result.state !== "succeeded" || result.exitCode !== 0) {
      const expiresAt =
        this.now() + effectiveCodespaceLimits(this.dependencies.policy()).transfers.ttlMs;
      const ref = await this.dependencies.transfers.retainRelayPayload(
        operation.userId,
        "operation_result",
        Buffer.from(JSON.stringify(result)),
        expiresAt,
      );
      if (
        !this.dependencies.repository.complete(
          operation.userId,
          operation.id,
          result,
          operation.stdoutLimitBytes,
          operation.stderrLimitBytes,
          expiresAt,
          this.now(),
          "file_client_failed",
          JSON.stringify(ref),
        )
      )
        await this.dependencies.transfers.discardRelayPayload(
          operation.userId,
          "operation_result",
          ref,
        );
      resourceError("File maintenance did not complete", operation.id);
    }
    const receipt = JSON.parse(result.stdout) as CodespaceFileRuntimeProbe;
    if (
      !receipt ||
      typeof receipt !== "object" ||
      Array.isArray(receipt) ||
      Object.keys(receipt).length !== 6 ||
      Object.keys(receipt).some(
        (key) =>
          ![
            "abi",
            "environmentIdentity",
            "workerSha256",
            "cliSha256",
            "command",
            "executableSha256",
          ].includes(key),
      ) ||
      receipt.abi !== plan.assets.abi ||
      receipt.environmentIdentity !== plan.life ||
      receipt.workerSha256 !== plan.assets.workerSha256 ||
      receipt.cliSha256 !== plan.assets.cliSha256 ||
      !isCodespaceFileClientCommand(receipt.command) ||
      receipt.executableSha256 !== receipt.cliSha256
    )
      resourceError("Installed file assets do not match the accepted intent", operation.id);
    const expiresAt = plan.expiresAt;
    await this.freshProbe(operation, plan.life);
    const ref = await this.dependencies.transfers.retainRelayPayload(
      operation.userId,
      "operation_result",
      Buffer.from(JSON.stringify(result)),
      expiresAt,
    );
    const completed = this.dependencies.repository.complete(
      operation.userId,
      operation.id,
      result,
      operation.stdoutLimitBytes,
      operation.stderrLimitBytes,
      expiresAt,
      this.now(),
      "file_client_provisioned",
      JSON.stringify(ref),
    );
    if (!completed)
      await this.dependencies.transfers.discardRelayPayload(
        operation.userId,
        "operation_result",
        ref,
      );
  }
  private async completeFile(
    operation: CodespaceOperationRecord,
    result: CodespaceFileResult,
    outcome = "remote_terminal",
  ) {
    operation = this.owned(operation.userId, operation.id).operation;
    if (["succeeded", "failed", "cancelled", "timed_out"].includes(operation.state)) return;
    const plan = outcome.startsWith("private_") ? null : await this.intent(operation);
    if (plan && (plan.mode === "upload" || plan.mode === "download") && !("state" in result)) {
      const descriptor = plan.descriptor;
      if (
        !descriptor ||
        !("transferId" in result) ||
        result.transferId !== descriptor.transferId ||
        result.action !== plan.mode ||
        result.path !== plan.input.path ||
        result.size !== descriptor.size ||
        result.sha256 !== descriptor.sha256
      )
        resourceError("Guest file receipt does not match the original transfer", operation.id);
      if (plan.mode === "upload" && result.action === "upload" && "transferId" in result) {
        const expected = plan.input.expected;
        if (
          expected.exists !== (result.previous !== null) ||
          (expected.exists &&
            expected.size !== undefined &&
            result.previous?.size !== expected.size) ||
          (expected.exists &&
            expected.sha256 !== undefined &&
            result.previous?.sha256 !== expected.sha256)
        )
          resourceError(
            "Guest upload receipt does not satisfy the original target guard",
            operation.id,
          );
      }
      if (
        plan.mode === "download" &&
        result.action === "download" &&
        "transferId" in result &&
        this.dependencies.transfers.getOwnedTransfer(operation.userId, result.referenceId)?.id !==
          descriptor.transferId
      )
        resourceError(
          "Guest download receipt does not identify the original private object",
          operation.id,
        );
    }
    const expiresAt =
      this.now() + effectiveCodespaceLimits(this.dependencies.policy()).transfers.ttlMs;
    const ref = await this.dependencies.transfers.retainRelayPayload(
      operation.userId,
      "operation_result",
      Buffer.from(JSON.stringify(result)),
      expiresAt,
    );
    this.owned(operation.userId, operation.id);
    const changed = this.dependencies.repository.completeMetadata(
      operation.userId,
      operation.id,
      "state" in result ? 0 : Buffer.byteLength(JSON.stringify(result)),
      expiresAt,
      this.now(),
      "state" in result ? "failed" : "succeeded",
      JSON.stringify(ref),
      "state" in result && result.notStarted ? "admission_expired_not_started" : outcome,
    );
    if (!changed)
      await this.dependencies.transfers.discardRelayPayload(
        operation.userId,
        "operation_result",
        ref,
      );
  }
  private async completePrivateObject(
    operation: CodespaceOperationRecord,
    fileName: string,
    status: CodespaceTransferStatus,
  ) {
    if (!status.handle) return;
    await this.completeFile(
      operation,
      {
        action: "download",
        transferId: status.transferId,
        path: fileName,
        size: status.handle.size,
        sha256: status.handle.sha256,
        referenceId: status.handle.referenceId,
      },
      status.direction === "server_to_guest" ? "private_source_ready" : "private_object_ready",
    );
  }
  private async recoverPrivateObject(operation: CodespaceOperationRecord): Promise<boolean> {
    this.owned(operation.userId, operation.id);
    if (["succeeded", "failed", "cancelled", "timed_out"].includes(operation.state)) return true;
    const record = this.dependencies.transfers.getByRequest(operation.userId, operation.requestId!);
    if ((!record || record.expiresAt <= this.now()) && operation.deadlineAt <= this.now()) {
      await this.completeFile(
        operation,
        { action: "download", state: "failed", code: "CODESPACE_FILE_REJECTED" },
        "private_transfer_expired",
      );
      return true;
    }
    const plan = operation.deadlineAt > this.now() ? await this.intent(operation) : null;
    if (plan?.mode === "cli" && plan.transferId && record?.id !== plan.transferId)
      throw new CodespaceResourceError(
        "CODESPACE_RESULT_EXPIRED",
        "The original private copy is no longer retained",
      );
    if (
      plan?.mode === "cli" &&
      plan.sourceId &&
      (!record || record.state === "reserved") &&
      operation.deadlineAt > this.now()
    ) {
      const anchor = this.owned(operation.userId, plan.anchorId).operation;
      await this.freshProbe(anchor, plan.life);
      if (operation.state === "reserved") {
        const claimId = randomUUID();
        if (
          !this.dependencies.repository.beginDispatch(
            operation.userId,
            operation.id,
            claimId,
            this.now() + this.dependencies.policy().claimLeaseMs,
            this.now(),
            undefined,
            operation.claimId ?? undefined,
          )
        )
          resourceError("Private source copy admission changed", operation.id);
        operation = { ...operation, state: "reconcile_pending", claimId };
      }
      const claimId = operation.claimId;
      if (!claimId) resourceError("Private copy admission is not claimed", operation.id);
      const status = await this.copySource(
        operation.userId,
        operation.requestId!,
        operation.requestDigest!,
        this.privateSource(operation.userId, plan.sourceId),
        this.authority(operation, plan.life),
        async () => {
          await this.authorize(
            { ...this.bootstrap(anchor, plan.life), expiresAt: operation.deadlineAt },
            true,
          );
          const copy = this.dependencies.transfers.getByRequest(
            operation.userId,
            operation.requestId!,
          );
          if (!copy) resourceError("Private copy reservation disappeared", operation.id);
          await this.bindTransfer(operation, plan, copy.id, claimId);
        },
      );
      if (status.handle)
        await this.completePrivateObject(
          this.owned(operation.userId, operation.id).operation,
          this.dependencies.transfers.getOwnedTransfer(operation.userId, status.transferId)!
            .fileName,
          status,
        );
      return true;
    }
    if (record && record.expectedSha256 && record.expiresAt > this.now()) {
      if (
        operation.state === "reserved" &&
        !this.dependencies.repository.beginDispatch(
          operation.userId,
          operation.id,
          randomUUID(),
          this.now() + this.dependencies.policy().claimLeaseMs,
          this.now(),
          undefined,
          operation.claimId ?? undefined,
        )
      )
        return true;
      const status = await this.dependencies.transfers.getTransferStatus(
        operation.userId,
        record.id,
        this.recordAuthority(record),
      );
      if (status.handle) await this.completePrivateObject(operation, record.fileName, status);
    }
    return true;
  }
  private privateSource(userId: string, id: string): CodespaceTransferRecord {
    const source = this.dependencies.transfers.getOwnedTransfer(userId, id);
    if (
      !source ||
      !["codespace_input", "codespace_download"].includes(source.purpose) ||
      !source.sha256 ||
      !["ready", "claimed"].includes(source.state)
    )
      throw new CodespaceResourceError("CODESPACE_NOT_FOUND", "Private source was not found");
    return source;
  }
  private async copySource(
    userId: string,
    id: string,
    requestDigest: string,
    source: CodespaceTransferRecord,
    authority: CodespaceTransferAuthority,
    authorize: () => Promise<void>,
  ) {
    const status = await this.dependencies.transfers.reserveResumable(userId, {
      requestId: id,
      requestDigest,
      purpose: "codespace_input",
      fileName: source.fileName,
      mimeType: source.mimeType,
      size: source.declaredSize,
      sha256: source.sha256!,
      authority,
    });
    if (status.state !== "reserved") return status;
    const opened = await (
      await this.dependencies.transfers.openOwnedSource(userId, source.id)
    ).open();
    let offset = 0;
    try {
      for await (const bytes of opened) {
        if (offset + bytes.byteLength > status.offset)
          await this.dependencies.transfers.writeTransferChunk(
            userId,
            status.transferId,
            authority,
            { offset, bytes, sha256: createHash("sha256").update(bytes).digest("hex") },
          );
        offset += bytes.byteLength;
      }
      await opened.settled;
    } finally {
      await opened.close();
    }
    await this.dependencies.transfers.finalizeTransfer(
      userId,
      status.transferId,
      authority,
      authorize,
    );
    return this.dependencies.transfers.getTransferStatus(userId, status.transferId, authority);
  }
  private now(): number {
    return (this.dependencies.now ?? Date.now)();
  }
  private requireSecureOrigin(): void {
    if (!this.origin.startsWith("https://"))
      throw new CodespaceResourceError(
        "CODESPACE_LOCAL_SETUP_INCOMPLETE",
        "Binary file transfer requires a fixed HTTPS application origin",
      );
  }
}
