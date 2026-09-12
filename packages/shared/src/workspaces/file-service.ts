import { randomUUID } from "node:crypto";
import { requireWorkspaceTransportAvailable } from "./transport-availability.js";
import type {
  WorkspaceFileOperationResponse,
  WorkspaceFileRequest,
  WorkspaceFileResult,
  WorkspaceFileTransport,
  WorkspaceOperationKind,
  WorkspaceOperationRecord,
  WorkspaceResourcePolicy,
  WorkspaceNativeFileReference,
  WorkspaceTransferRecord,
} from "./resource-types.js";
import { WorkspaceResourceError } from "./resource-types.js";
import { WorkspaceOperationRepository } from "./operation-repository.js";
import type { WorkspaceCredentialResolver } from "./resource-service.js";
import type { WorkspaceOperationAuditEvent } from "./operation-service.js";
import type {
  WorkspaceNativeReferenceFetcher,
  WorkspaceTransferHandle,
  WorkspaceTransferReservation,
  WorkspaceTransferService,
} from "./transfer-service.js";

const MAX_PATH_BYTES = 4096;
const MAX_SEARCH_QUERY_BYTES = 4096;
const MAX_PATCH_FILES = 64;
const MAX_PATCH_EDITS = 4096;
const MIN_SEARCH_RESULT_BYTES = Buffer.byteLength(
  JSON.stringify({ action: "search", matches: [], truncated: false }),
  "utf8",
);

function kind(request: WorkspaceFileRequest): WorkspaceOperationKind {
  return request.action;
}

function paths(request: WorkspaceFileRequest): string[] {
  return request.action === "apply_patch" ? request.files.map((file) => file.path) : [request.path];
}

function validPath(path: string, allowRoot = false): boolean {
  return allowRoot && path === "."
    ? true
    : path.length > 0 &&
        Buffer.byteLength(path, "utf8") <= MAX_PATH_BYTES &&
        !path.includes("\0") &&
        !path.startsWith("/") &&
        !path.startsWith("\\") &&
        !/^[A-Za-z]:/.test(path) &&
        path.split(/[\\/]/).every((part) => part !== "" && part !== "." && part !== "..");
}

function requestBytes(request: WorkspaceFileRequest): number {
  if (request.action === "write" || request.action === "upload") return request.bytes.byteLength;
  if (request.action === "apply_patch") {
    return request.files.reduce(
      (total, file) => total + file.edits.reduce((sum, edit) => sum + edit.bytes.byteLength, 0),
      0,
    );
  }
  return 0;
}

export function workspaceFileResultBytes(result: WorkspaceFileResult): number {
  if ("state" in result) return 0;
  if (result.action === "read" || result.action === "download") {
    return result.bytes.byteLength;
  }
  return Buffer.byteLength(JSON.stringify(result), "utf8");
}

function validateExpected(expected: { exists: boolean; size?: number; sha256?: string }): void {
  if (
    typeof expected.exists !== "boolean" ||
    (expected.size !== undefined && (!Number.isSafeInteger(expected.size) || expected.size < 0)) ||
    (expected.sha256 !== undefined && !/^[a-f0-9]{64}$/.test(expected.sha256))
  ) {
    throw new WorkspaceResourceError("WORKSPACE_RESOURCE_INVALID", "Invalid file precondition");
  }
}

function validateRequest(
  request: WorkspaceFileRequest,
  policy: WorkspaceResourcePolicy,
  inputBytesOverride?: number,
): number {
  if (
    paths(request).some(
      (path) => !validPath(path, request.action === "stat" || request.action === "search"),
    )
  ) {
    throw new WorkspaceResourceError("WORKSPACE_RESOURCE_INVALID", "Invalid workspace path");
  }
  const maximum = policy.maxTransferFileBytes ?? 4 * 1024 * 1024;
  const inputBytes = inputBytesOverride ?? requestBytes(request);
  if (!Number.isSafeInteger(inputBytes) || inputBytes > maximum) {
    throw new WorkspaceResourceError("WORKSPACE_POLICY_LIMIT", "File input exceeds its limit");
  }
  if (request.action === "read") {
    if (
      !Number.isSafeInteger(request.offset) ||
      request.offset < 0 ||
      !Number.isSafeInteger(request.length) ||
      request.length < 1 ||
      request.length > maximum
    ) {
      throw new WorkspaceResourceError("WORKSPACE_POLICY_LIMIT", "Read range exceeds its limit");
    }
  } else if (request.action === "download") {
    if (
      !Number.isSafeInteger(request.maxBytes) ||
      request.maxBytes < 1 ||
      request.maxBytes > maximum
    ) {
      throw new WorkspaceResourceError("WORKSPACE_POLICY_LIMIT", "Download exceeds its limit");
    }
  } else if (request.action === "search") {
    if (
      Buffer.byteLength(request.query, "utf8") < 1 ||
      Buffer.byteLength(request.query, "utf8") > MAX_SEARCH_QUERY_BYTES ||
      !["literal", "regex"].includes(request.mode) ||
      !Number.isSafeInteger(request.maxMatches) ||
      request.maxMatches < 1 ||
      request.maxMatches > 1000 ||
      !Number.isSafeInteger(request.maxBytes) ||
      request.maxBytes < MIN_SEARCH_RESULT_BYTES ||
      request.maxBytes > Math.min(maximum, 1024 * 1024)
    ) {
      throw new WorkspaceResourceError("WORKSPACE_POLICY_LIMIT", "Search bounds are invalid");
    }
    if (request.mode === "regex") {
      try {
        new RegExp(request.query, "u");
      } catch {
        throw new WorkspaceResourceError(
          "WORKSPACE_RESOURCE_INVALID",
          "Search expression is invalid",
        );
      }
    }
  } else if (request.action === "write" || request.action === "upload") {
    validateExpected(request.expected);
  } else if (request.action === "apply_patch") {
    if (request.files.length < 1 || request.files.length > MAX_PATCH_FILES) {
      throw new WorkspaceResourceError(
        "WORKSPACE_POLICY_LIMIT",
        "Patch file count exceeds its limit",
      );
    }
    const unique = new Set(request.files.map((file) => file.path));
    if (unique.size !== request.files.length) {
      throw new WorkspaceResourceError("WORKSPACE_RESOURCE_INVALID", "Patch paths must be unique");
    }
    let editCount = 0;
    for (const file of request.files) {
      validateExpected(file.expected);
      let previousEnd = 0;
      for (const edit of file.edits) {
        editCount++;
        if (
          !Number.isSafeInteger(edit.start) ||
          !Number.isSafeInteger(edit.end) ||
          edit.start < previousEnd ||
          edit.end < edit.start
        ) {
          throw new WorkspaceResourceError(
            "WORKSPACE_RESOURCE_INVALID",
            "Patch edits overlap or are invalid",
          );
        }
        previousEnd = edit.end;
      }
    }
    if (editCount > MAX_PATCH_EDITS) {
      throw new WorkspaceResourceError(
        "WORKSPACE_POLICY_LIMIT",
        "Patch edit count exceeds its limit",
      );
    }
  }
  return inputBytes;
}

export class WorkspaceFileService {
  constructor(
    private readonly dependencies: {
      repository: WorkspaceOperationRepository;
      credentials: WorkspaceCredentialResolver;
      transport: WorkspaceFileTransport;
      policy: () => WorkspaceResourcePolicy;
      now?: () => number;
      transfers?: Pick<
        WorkspaceTransferService,
        | "ingest"
        | "claimInput"
        | "release"
        | "consume"
        | "reserveDownload"
        | "publishDownload"
        | "discard"
      >;
      nativeFetcher?: WorkspaceNativeReferenceFetcher;
      audit?: (event: WorkspaceOperationAuditEvent) => Promise<void> | void;
    },
  ) {}

  async uploadReference(
    userId: string,
    workspaceId: string,
    input: {
      path: string;
      reference: WorkspaceNativeFileReference;
      expected: { exists: boolean; size?: number; sha256?: string };
    },
  ): Promise<WorkspaceFileOperationResponse> {
    if (!this.dependencies.transfers || !this.dependencies.nativeFetcher) {
      throw new WorkspaceResourceError(
        "WORKSPACE_PROVIDER_UNAVAILABLE",
        "Native transfer is unavailable",
      );
    }
    const request: WorkspaceFileRequest = {
      action: "upload",
      path: input.path,
      bytes: new Uint8Array(),
      expected: input.expected,
    };
    const prepared = await this.reserve(
      userId,
      workspaceId,
      request,
      input.reference.declaredSize ??
        Math.min(
          this.dependencies.policy().maxTransferFileBytes ?? 4 * 1024 * 1024,
          4 * 1024 * 1024,
        ),
    );
    let claimed: Awaited<ReturnType<WorkspaceTransferService["claimInput"]>> | null = null;
    try {
      this.dependencies.repository.requireResultContext(
        userId,
        prepared.operation.id,
        this.dependencies.policy(),
        this.now(),
      );
      const handle = await this.dependencies.transfers.ingest(
        userId,
        input.reference,
        this.dependencies.nativeFetcher,
        prepared.operation.inputBytes,
      );
      claimed = await this.dependencies.transfers.claimInput(userId, handle.referenceId);
      const materialized = this.dependencies.repository.recordInputBytes(
        userId,
        prepared.operation.id,
        claimed.bytes.byteLength,
        this.now(),
      );
      if (!materialized) {
        throw new WorkspaceResourceError(
          "WORKSPACE_NOT_RUNNING",
          "Native input operation authority changed",
        );
      }
      prepared.operation = materialized;
      const response = await this.executePrepared(
        userId,
        {
          action: "upload",
          path: input.path,
          bytes: claimed.bytes,
          expected: input.expected,
        },
        prepared,
        claimed.record,
      );
      if (response.operation.state === "cancelled") {
        await this.dependencies.transfers.discard(claimed.record);
      }
      return response;
    } catch (error) {
      if (claimed) await this.dependencies.transfers.discard(claimed.record);
      if (
        this.dependencies.repository.cancelBeforeDispatch(
          userId,
          prepared.operation.id,
          this.now(),
          "native_input_unavailable_before_dispatch",
        )
      ) {
        await this.emit(
          "terminal",
          this.dependencies.repository.getOwned(userId, prepared.operation.id)!,
        );
      }
      throw error;
    }
  }

  async downloadReference(
    userId: string,
    workspaceId: string,
    input: { path: string; maxBytes: number; fileName: string; mimeType: string },
  ): Promise<{ operation: WorkspaceOperationRecord; transfer: WorkspaceTransferHandle | null }> {
    if (!this.dependencies.transfers) {
      throw new WorkspaceResourceError(
        "WORKSPACE_PROVIDER_UNAVAILABLE",
        "Native transfer is unavailable",
      );
    }
    const request: WorkspaceFileRequest = {
      action: "download",
      path: input.path,
      maxBytes: input.maxBytes,
    };
    const prepared = await this.reserve(userId, workspaceId, request);
    let reservation: WorkspaceTransferReservation;
    try {
      reservation = this.dependencies.transfers.reserveDownload(userId, {
        fileName: input.fileName,
        mimeType: input.mimeType,
        maxBytes: input.maxBytes,
      });
    } catch (error) {
      this.dependencies.repository.cancelBeforeDispatch(
        userId,
        prepared.operation.id,
        this.now(),
        "transfer_quota_unavailable_before_dispatch",
      );
      await this.emit(
        "terminal",
        this.dependencies.repository.getOwned(userId, prepared.operation.id)!,
      );
      throw error;
    }
    const response = await this.executePrepared(userId, request, prepared);
    if (!response.result || "state" in response.result || response.result.action !== "download") {
      await this.dependencies.transfers.discard(reservation.record);
      return { operation: response.operation, transfer: null };
    }
    try {
      const transfer = await this.dependencies.transfers.publishDownload(
        reservation,
        response.result.bytes,
      );
      return { operation: response.operation, transfer };
    } catch (error) {
      await this.dependencies.transfers.discard(reservation.record);
      throw error;
    }
  }

  async execute(
    userId: string,
    workspaceId: string,
    request: WorkspaceFileRequest,
  ): Promise<WorkspaceFileOperationResponse> {
    const prepared = await this.reserve(userId, workspaceId, request);
    return this.executePrepared(userId, request, prepared);
  }

  async reconcileDownloadReference(
    userId: string,
    operationId: string,
    input: { fileName: string; mimeType: string },
  ): Promise<{ operation: WorkspaceOperationRecord; transfer: WorkspaceTransferHandle | null }> {
    const context = this.dependencies.repository.requireResultContext(
      userId,
      operationId,
      this.dependencies.policy(),
      this.now(),
    );
    if (context.operation.kind !== "download") {
      throw new WorkspaceResourceError("WORKSPACE_NOT_FOUND", "Workspace download was not found");
    }
    if (!this.dependencies.transfers) {
      throw new WorkspaceResourceError(
        "WORKSPACE_PROVIDER_UNAVAILABLE",
        "Native transfer is unavailable",
      );
    }
    const reservation = this.dependencies.transfers.reserveDownload(userId, {
      ...input,
      maxBytes: context.operation.stdoutLimitBytes,
    });
    try {
      const response = await this.reconcile(userId, operationId);
      if (!response.result || "state" in response.result || response.result.action !== "download") {
        await this.dependencies.transfers.discard(reservation.record);
        return { operation: response.operation, transfer: null };
      }
      const transfer = await this.dependencies.transfers.publishDownload(
        reservation,
        response.result.bytes,
      );
      return { operation: response.operation, transfer };
    } catch (error) {
      await this.dependencies.transfers.discard(reservation.record);
      throw error;
    }
  }

  private async reserve(
    userId: string,
    workspaceId: string,
    request: WorkspaceFileRequest,
    inputBytesOverride?: number,
  ) {
    const policy = this.dependencies.policy();
    const inputBytes = validateRequest(request, policy, inputBytesOverride);
    const outputLimit = this.outputLimit(request, policy);
    const now = this.now();
    const reservation = this.dependencies.repository.reserve({
      userId,
      resourceId: workspaceId,
      kind: kind(request),
      inputBytes,
      stdoutLimitBytes: outputLimit,
      stderrLimitBytes: 1,
      deadlineAt: now + Math.min(policy.maxOperationMs ?? 15 * 60_000, 15 * 60_000),
      policy,
      now,
    });
    if (reservation.outcome !== "reserved" || !reservation.operation || !reservation.workspace) {
      const code =
        reservation.outcome === "not_found"
          ? "WORKSPACE_NOT_FOUND"
          : reservation.outcome === "limit"
            ? "WORKSPACE_POLICY_LIMIT"
            : reservation.outcome === "busy"
              ? "WORKSPACE_OPERATION_BUSY"
              : reservation.outcome === "disabled"
                ? "WORKSPACE_PROVIDER_DISABLED"
                : "WORKSPACE_NOT_RUNNING";
      throw new WorkspaceResourceError(code, "Workspace file operation cannot be started");
    }
    const { operation, workspace } = reservation;
    await this.emit("reserve", operation);
    try {
      await requireWorkspaceTransportAvailable(this.dependencies.transport);
    } catch (error) {
      this.dependencies.repository.cancelBeforeDispatch(
        userId,
        operation.id,
        this.now(),
        "connector_unavailable_before_dispatch",
      );
      await this.emit("terminal", this.dependencies.repository.getOwned(userId, operation.id)!);
      throw error;
    }
    return { policy, operation, workspace };
  }

  private async executePrepared(
    userId: string,
    request: WorkspaceFileRequest,
    prepared: Awaited<ReturnType<WorkspaceFileService["reserve"]>>,
    claimedInput: WorkspaceTransferRecord | null = null,
  ): Promise<WorkspaceFileOperationResponse> {
    const { policy, operation, workspace } = prepared;
    let remoteContacted = false;
    try {
      if (!this.dependencies.repository.canDispatch(userId, operation.id, this.now())) {
        if (claimedInput) this.dependencies.transfers?.release(claimedInput);
        this.dependencies.repository.cancelBeforeDispatch(userId, operation.id, this.now());
        const current = this.dependencies.repository.getOwned(userId, operation.id)!;
        await this.emit("terminal", current);
        return { operation: current, result: null };
      }
      const credential = await this.dependencies.credentials.getCredential(
        userId,
        workspace.provider,
      );
      const dispatchNow = this.now();
      if (
        !this.dependencies.repository.beginDispatch(
          userId,
          operation.id,
          operation.resourceGeneration,
          randomUUID(),
          dispatchNow + Math.max(policy.claimLeaseMs, 60_000),
          dispatchNow,
        )
      ) {
        if (claimedInput) this.dependencies.transfers?.release(claimedInput);
        this.dependencies.repository.cancelBeforeDispatch(userId, operation.id, this.now());
        const current = this.dependencies.repository.getOwned(userId, operation.id)!;
        await this.emit("terminal", current);
        return { operation: current, result: null };
      }
      if (claimedInput) {
        await this.dependencies.transfers!.consume(claimedInput);
        claimedInput = null;
      }
      remoteContacted = true;
      const result = await this.dependencies.transport.executeFile(
        credential,
        workspace,
        operation,
        request,
      );
      this.dependencies.repository.recordConnectorRunning(
        userId,
        workspace.id,
        operation.resourceGeneration,
        this.now(),
      );
      if ("state" in result && result.state === "running") {
        this.dependencies.repository.markRunning(
          userId,
          operation.id,
          operation.resourceGeneration,
          this.now(),
        );
        return {
          operation: this.dependencies.repository.getOwned(userId, operation.id)!,
          result: null,
        };
      }
      if (result.action !== request.action) {
        throw new Error("Workspace file transport returned a mismatched result");
      }
      return this.complete(userId, operation, result);
    } catch {
      if (claimedInput) this.dependencies.transfers?.release(claimedInput);
      if (remoteContacted) {
        this.dependencies.repository.markReconcilePending(
          userId,
          operation.id,
          "remote_outcome_unknown",
          this.now(),
        );
        await this.emit("reconcile", this.dependencies.repository.getOwned(userId, operation.id)!);
      } else {
        this.dependencies.repository.cancelBeforeDispatch(
          userId,
          operation.id,
          this.now(),
          "credential_unavailable_before_dispatch",
        );
        await this.emit("terminal", this.dependencies.repository.getOwned(userId, operation.id)!);
      }
      return {
        operation: this.dependencies.repository.getOwned(userId, operation.id)!,
        result: null,
      };
    }
  }

  async reconcile(userId: string, operationId: string): Promise<WorkspaceFileOperationResponse> {
    const context = this.dependencies.repository.requireResultContext(
      userId,
      operationId,
      this.dependencies.policy(),
      this.now(),
    );
    if (context.operation.kind === "exec") {
      throw new WorkspaceResourceError(
        "WORKSPACE_NOT_FOUND",
        "Workspace file operation was not found",
      );
    }
    await requireWorkspaceTransportAvailable(this.dependencies.transport);
    this.dependencies.repository.requireResultContext(
      userId,
      operationId,
      this.dependencies.policy(),
      this.now(),
    );
    if (context.operation.state === "reserved")
      return { operation: context.operation, result: null };
    const credential = await this.dependencies.credentials.getCredential(
      userId,
      context.operation.provider,
    );
    this.dependencies.repository.requireResultContext(
      userId,
      operationId,
      this.dependencies.policy(),
      this.now(),
    );
    let result: Awaited<ReturnType<WorkspaceFileTransport["inspectFile"]>>;
    try {
      result = await this.dependencies.transport.inspectFile(
        credential,
        context.workspace,
        context.operation,
      );
    } catch (error) {
      // A connector failure during inspection is not a result: the operation stays
      // reconcile-pending with capacity reserved, exactly like an exec inspection.
      if (error instanceof WorkspaceResourceError) throw error;
      this.dependencies.repository.markReconcilePending(
        userId,
        operationId,
        "remote_inspection_required",
        this.now(),
      );
      return {
        operation: this.dependencies.repository.getOwned(userId, operationId)!,
        result: null,
      };
    }
    this.dependencies.repository.requireResultContext(
      userId,
      operationId,
      this.dependencies.policy(),
      this.now(),
    );
    if ("state" in result && result.state === "running") {
      return {
        operation: this.dependencies.repository.getOwned(userId, operationId)!,
        result: null,
      };
    }
    if ("state" in result && result.state === "absent") {
      // Exact-marker inspection proved the remote never ran or no longer holds this
      // operation: it is terminal and its capacity is released, exactly like an exec.
      return this.completeAbsent(userId, context.operation);
    }
    if (result.action !== context.operation.kind) {
      throw new Error("Workspace file transport returned a mismatched result");
    }
    if (["succeeded", "failed", "cancelled", "timed_out"].includes(context.operation.state)) {
      const resultState = "state" in result ? result.state : "succeeded";
      if (
        resultState !== context.operation.state ||
        workspaceFileResultBytes(result) !== context.operation.outputBytes
      ) {
        return { operation: context.operation, result: null };
      }
      return { operation: context.operation, result };
    }
    return this.complete(userId, context.operation, result);
  }

  private async completeAbsent(
    userId: string,
    operation: WorkspaceOperationRecord,
  ): Promise<WorkspaceFileOperationResponse> {
    if (["succeeded", "failed", "cancelled", "timed_out"].includes(operation.state)) {
      return { operation, result: null };
    }
    const completed = this.dependencies.repository.completeMetadata(
      userId,
      operation.id,
      operation.resourceGeneration,
      0,
      this.now() + this.dependencies.policy().cleanupDeadlineMs,
      this.now(),
      "failed",
    );
    const current = this.dependencies.repository.getOwned(userId, operation.id)!;
    if (completed) await this.emit("terminal", current);
    return { operation: current, result: null };
  }

  private async complete(
    userId: string,
    operation: WorkspaceOperationRecord,
    result: WorkspaceFileResult,
  ): Promise<WorkspaceFileOperationResponse> {
    const bytes = workspaceFileResultBytes(result);
    if (bytes > operation.stdoutLimitBytes) {
      this.dependencies.repository.markReconcilePending(
        userId,
        operation.id,
        "remote_result_exceeded_bound",
        this.now(),
      );
      return {
        operation: this.dependencies.repository.getOwned(userId, operation.id)!,
        result: null,
      };
    }
    const completed = this.dependencies.repository.completeMetadata(
      userId,
      operation.id,
      operation.resourceGeneration,
      bytes,
      this.now() + this.dependencies.policy().cleanupDeadlineMs,
      this.now(),
      "state" in result && result.state === "failed" ? "failed" : "succeeded",
    );
    const current = this.dependencies.repository.getOwned(userId, operation.id)!;
    if (!completed) return { operation: current, result: null };
    await this.emit("terminal", current);
    return { operation: current, result };
  }

  private outputLimit(request: WorkspaceFileRequest, policy: WorkspaceResourcePolicy): number {
    const maximum = policy.maxTransferFileBytes ?? 4 * 1024 * 1024;
    if (request.action === "read") return request.length;
    if (request.action === "download") return request.maxBytes;
    if (request.action === "search") return request.maxBytes;
    return Math.min(maximum, 1024 * 1024);
  }

  private now(): number {
    return (this.dependencies.now ?? Date.now)();
  }

  private async emit(
    action: WorkspaceOperationAuditEvent["action"],
    operation: WorkspaceOperationRecord,
  ): Promise<void> {
    await this.dependencies.audit?.({
      action,
      userId: operation.userId,
      workspaceId: operation.resourceId,
      operationId: operation.id,
      provider: operation.provider,
      state: operation.state,
      kind: operation.kind,
      inputBytes: operation.inputBytes,
      outputBytes: operation.outputBytes,
      exitCode: operation.exitCode,
      createdAt: operation.createdAt,
      updatedAt: operation.updatedAt,
    });
  }
}
