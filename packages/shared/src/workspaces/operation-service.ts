import { WorkspaceOperationRepository } from "./operation-repository.js";
import type {
  WorkspaceExecRequest,
  WorkspaceOperationRecord,
  WorkspaceOperationResponse,
  WorkspaceOperationResult,
  WorkspaceOperationTransport,
  WorkspaceFileTransport,
  WorkspaceNativeFileReference,
  WorkspaceResourcePolicy,
} from "./resource-types.js";
import { WorkspaceResourceError } from "./resource-types.js";
import type { WorkspaceCredentialResolver } from "./resource-service.js";
import { randomUUID } from "node:crypto";
import { workspaceFileResultBytes } from "./file-service.js";
import type { WorkspaceTransferRecord } from "./resource-types.js";
import type {
  WorkspaceNativeReferenceFetcher,
  WorkspaceTransferHandle,
  WorkspaceTransferService,
} from "./transfer-service.js";

const CONNECTOR_MAX_INPUT_BYTES = 4 * 1024 * 1024;
const CONNECTOR_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const CONNECTOR_MAX_TIMEOUT_MS = 15 * 60_000;
const MAX_WORKSPACE_CWD_BYTES = 4096;

function isTerminalOperationState(
  state: WorkspaceOperationRecord["state"],
): state is WorkspaceOperationResult["state"] {
  return ["succeeded", "failed", "cancelled", "timed_out"].includes(state);
}

export interface WorkspaceOperationAuditEvent {
  action: "reserve" | "reconcile" | "terminal";
  userId: string;
  workspaceId: string;
  operationId: string;
  provider: string;
  state: WorkspaceOperationRecord["state"];
  kind: WorkspaceOperationRecord["kind"];
  inputBytes: number;
  outputBytes: number;
  exitCode: number | null;
}

function validateRequest(
  request: WorkspaceExecRequest,
  policy: WorkspaceResourcePolicy,
): { inputBytes: number; stdoutLimitBytes: number; stderrLimitBytes: number } {
  if (
    request.argv.length === 0 ||
    request.argv.length > 128 ||
    request.argv.some(
      (value) =>
        typeof value !== "string" ||
        value.length === 0 ||
        Buffer.byteLength(value) > 16_384 ||
        value.includes("\0"),
    )
  ) {
    throw new WorkspaceResourceError("WORKSPACE_RESOURCE_INVALID", "Invalid command arguments");
  }
  if (
    Buffer.byteLength(request.cwd, "utf8") > MAX_WORKSPACE_CWD_BYTES ||
    request.cwd.startsWith("/") ||
    (request.cwd !== "." &&
      request.cwd.split("/").some((part) => part === ".." || part === "." || part === "")) ||
    request.cwd.includes("\0")
  ) {
    throw new WorkspaceResourceError(
      "WORKSPACE_RESOURCE_INVALID",
      "Working directory must be workspace-relative",
    );
  }
  const inputBytes =
    request.stdin.kind === "inline" ? request.stdin.bytes.byteLength : request.stdin.declaredBytes;
  if (
    !Number.isSafeInteger(inputBytes) ||
    inputBytes < 0 ||
    inputBytes >
      Math.min(policy.maxOperationInputBytes ?? 1024 * 1024, CONNECTOR_MAX_INPUT_BYTES) ||
    (request.stdin.kind === "reference" &&
      (request.stdin.referenceId.length < 1 ||
        request.stdin.referenceId.length > 2048 ||
        request.stdin.referenceId.includes("\0")))
  ) {
    throw new WorkspaceResourceError("WORKSPACE_POLICY_LIMIT", "Operation input exceeds its limit");
  }
  if (
    request.timeoutMs < 1 ||
    request.timeoutMs >
      Math.min(policy.maxOperationMs ?? CONNECTOR_MAX_TIMEOUT_MS, CONNECTOR_MAX_TIMEOUT_MS)
  ) {
    throw new WorkspaceResourceError(
      "WORKSPACE_POLICY_LIMIT",
      "Operation timeout exceeds its limit",
    );
  }
  const stdoutLimitBytes = request.maxStdoutBytes ?? policy.maxOperationStdoutBytes ?? 1024 * 1024;
  const stderrLimitBytes = request.maxStderrBytes ?? policy.maxOperationStderrBytes ?? 256 * 1024;
  if (
    !Number.isSafeInteger(stdoutLimitBytes) ||
    stdoutLimitBytes < 1 ||
    stdoutLimitBytes >
      Math.min(policy.maxOperationStdoutBytes ?? 1024 * 1024, CONNECTOR_MAX_OUTPUT_BYTES) ||
    !Number.isSafeInteger(stderrLimitBytes) ||
    stderrLimitBytes < 1 ||
    stderrLimitBytes >
      Math.min(policy.maxOperationStderrBytes ?? 256 * 1024, CONNECTOR_MAX_OUTPUT_BYTES)
  ) {
    throw new WorkspaceResourceError(
      "WORKSPACE_POLICY_LIMIT",
      "Operation output exceeds its limit",
    );
  }
  return { inputBytes, stdoutLimitBytes, stderrLimitBytes };
}

export class WorkspaceOperationService {
  private timer: NodeJS.Timeout | null = null;
  private scheduledReconcileRunning = false;
  constructor(
    private readonly dependencies: {
      repository: WorkspaceOperationRepository;
      credentials: WorkspaceCredentialResolver;
      transport: WorkspaceOperationTransport & Partial<WorkspaceFileTransport>;
      policy: () => WorkspaceResourcePolicy;
      now?: () => number;
      audit?: (event: WorkspaceOperationAuditEvent) => Promise<void> | void;
      transfers?: Pick<WorkspaceTransferService, "ingest" | "claimInput" | "release" | "consume">;
      nativeFetcher?: WorkspaceNativeReferenceFetcher;
    },
  ) {}

  async executeNativeReference(
    userId: string,
    workspaceId: string,
    request: Omit<WorkspaceExecRequest, "stdin">,
    reference: WorkspaceNativeFileReference,
  ): Promise<WorkspaceOperationResponse> {
    if (!this.dependencies.transfers || !this.dependencies.nativeFetcher) {
      throw new WorkspaceResourceError(
        "WORKSPACE_PROVIDER_UNAVAILABLE",
        "Native operation input is unavailable",
      );
    }
    const nativeRequest: WorkspaceExecRequest = {
      ...request,
      stdin: {
        kind: "reference",
        referenceId: reference.fileId,
        declaredBytes: reference.declaredSize,
        declaredMimeType: reference.mimeType,
      },
    };
    const prepared = await this.reserve(userId, workspaceId, nativeRequest);
    let handle: WorkspaceTransferHandle | null = null;
    try {
      handle = await this.dependencies.transfers.ingest(
        userId,
        reference,
        this.dependencies.nativeFetcher,
      );
      const response = await this.executePrepared(
        userId,
        {
          ...request,
          stdin: {
            kind: "reference",
            referenceId: handle.referenceId,
            declaredBytes: handle.size,
            declaredMimeType: handle.mimeType,
          },
        },
        prepared,
      );
      if (response.operation.state === "cancelled") {
        await this.discardNativeInput(userId, handle.referenceId);
      }
      return response;
    } catch (error) {
      if (handle) await this.discardNativeInput(userId, handle.referenceId);
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

  private now(): number {
    return (this.dependencies.now ?? Date.now)();
  }

  list(userId: string, workspaceId: string): WorkspaceOperationRecord[] {
    return this.dependencies.repository.listOwned(userId, workspaceId);
  }

  get(userId: string, operationId: string): WorkspaceOperationRecord | null {
    return this.dependencies.repository.getOwned(userId, operationId);
  }

  async execute(
    userId: string,
    workspaceId: string,
    request: WorkspaceExecRequest,
  ): Promise<WorkspaceOperationResponse> {
    const prepared = await this.reserve(userId, workspaceId, request);
    return this.executePrepared(userId, request, prepared);
  }

  private async reserve(userId: string, workspaceId: string, request: WorkspaceExecRequest) {
    const policy = this.dependencies.policy();
    const { inputBytes, stdoutLimitBytes, stderrLimitBytes } = validateRequest(request, policy);
    const reservation = this.dependencies.repository.reserve({
      userId,
      resourceId: workspaceId,
      inputBytes,
      stdoutLimitBytes,
      stderrLimitBytes,
      deadlineAt: this.now() + request.timeoutMs,
      policy,
      now: this.now(),
    });
    if (reservation.outcome !== "reserved" || !reservation.operation || !reservation.workspace) {
      const code =
        reservation.outcome === "not_found"
          ? "WORKSPACE_NOT_FOUND"
          : reservation.outcome === "limit"
            ? "WORKSPACE_POLICY_LIMIT"
            : reservation.outcome === "disabled"
              ? "WORKSPACE_PROVIDER_DISABLED"
              : "WORKSPACE_NOT_RUNNING";
      throw new WorkspaceResourceError(code, "Workspace operation cannot be started");
    }
    const { operation, workspace } = reservation;
    await this.emit("reserve", operation);
    return { policy, stdoutLimitBytes, stderrLimitBytes, operation, workspace };
  }

  private async executePrepared(
    userId: string,
    request: WorkspaceExecRequest,
    prepared: Awaited<ReturnType<WorkspaceOperationService["reserve"]>>,
  ): Promise<WorkspaceOperationResponse> {
    const { policy, stdoutLimitBytes, stderrLimitBytes, operation, workspace } = prepared;
    let terminalResult: WorkspaceOperationResult | null = null;
    let remoteContacted = false;
    let claimedInput: WorkspaceTransferRecord | null = null;
    let preDispatchOutcome = "credential_unavailable_before_dispatch";
    try {
      if (!this.dependencies.repository.canDispatch(userId, operation.id, this.now())) {
        this.dependencies.repository.cancelBeforeDispatch(userId, operation.id, this.now());
        return {
          operation: this.dependencies.repository.getOwned(userId, operation.id)!,
          result: null,
        };
      }
      let materializedRequest = request;
      if (request.stdin.kind === "reference") {
        preDispatchOutcome = "native_input_unavailable_before_dispatch";
        if (!this.dependencies.transfers) {
          throw new WorkspaceResourceError(
            "WORKSPACE_RESOURCE_INVALID",
            "Native operation input is unavailable",
          );
        }
        const claimed = await this.dependencies.transfers.claimInput(
          userId,
          request.stdin.referenceId,
        );
        if (
          claimed.bytes.byteLength !== request.stdin.declaredBytes ||
          claimed.record.mimeType !== request.stdin.declaredMimeType
        ) {
          this.dependencies.transfers.release(claimed.record);
          throw new WorkspaceResourceError(
            "WORKSPACE_RESOURCE_INVALID",
            "Native operation input size changed",
          );
        }
        claimedInput = claimed.record;
        materializedRequest = { ...request, stdin: { kind: "inline", bytes: claimed.bytes } };
      }
      preDispatchOutcome = "credential_unavailable_before_dispatch";
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
        return {
          operation: this.dependencies.repository.getOwned(userId, operation.id)!,
          result: null,
        };
      }
      remoteContacted = true;
      if (claimedInput) await this.dependencies.transfers!.consume(claimedInput);
      const result = await this.dependencies.transport.execute(credential, workspace, operation, {
        ...materializedRequest,
        maxStdoutBytes: stdoutLimitBytes,
        maxStderrBytes: stderrLimitBytes,
      });
      this.dependencies.repository.recordConnectorRunning(
        userId,
        workspace.id,
        operation.resourceGeneration,
        this.now(),
      );
      if (result.state === "running") {
        this.dependencies.repository.markRunning(
          userId,
          operation.id,
          operation.resourceGeneration,
          this.now(),
        );
      } else {
        terminalResult = this.complete(userId, operation, result);
      }
    } catch {
      if (remoteContacted) {
        this.dependencies.repository.markReconcilePending(
          userId,
          operation.id,
          "remote_outcome_unknown",
          this.now(),
        );
        await this.emit("reconcile", this.dependencies.repository.getOwned(userId, operation.id)!);
      } else {
        if (claimedInput) this.dependencies.transfers?.release(claimedInput);
        this.dependencies.repository.cancelBeforeDispatch(
          userId,
          operation.id,
          this.now(),
          preDispatchOutcome,
        );
        await this.emit("terminal", this.dependencies.repository.getOwned(userId, operation.id)!);
      }
    }
    const current = this.dependencies.repository.getOwned(userId, operation.id)!;
    if (terminalResult) await this.emit("terminal", current);
    return {
      operation: current,
      result: terminalResult,
    };
  }

  async cancel(userId: string, operationId: string): Promise<WorkspaceOperationResponse> {
    const operation = this.dependencies.repository.requestCancel(userId, operationId, this.now());
    if (!operation) {
      throw new WorkspaceResourceError("WORKSPACE_NOT_FOUND", "Workspace operation was not found");
    }
    if (!["cancel_pending", "reconcile_pending", "running", "reserved"].includes(operation.state)) {
      return { operation, result: null };
    }
    const result = await this.reconcile(userId, operation.id, true);
    return {
      operation: this.dependencies.repository.getOwned(userId, operation.id)!,
      result,
    };
  }

  async reconcile(
    userId: string,
    operationId: string,
    cancel = false,
  ): Promise<WorkspaceOperationResult | null> {
    const context = this.dependencies.repository.getContext(userId, operationId);
    if (!context) return null;
    const { operation, workspace } = context;
    try {
      if (
        isTerminalOperationState(operation.state) &&
        (workspace.state !== "usable" || workspace.desiredState !== "running")
      ) {
        return null;
      }
      const credential = await this.dependencies.credentials.getCredential(
        userId,
        operation.provider,
      );
      if (isTerminalOperationState(operation.state)) {
        if (operation.remoteCleanupPending !== 1) return null;
        const retained = await this.dependencies.transport.inspect(
          credential,
          workspace,
          operation,
        );
        if (retained.state === "running") return null;
        if (retained.state === "absent") {
          this.dependencies.repository.markRemoteFinalized(userId, operation.id, this.now());
          return null;
        }
        return this.projectRetainedResult(operation, retained);
      }
      const result = cancel
        ? await this.dependencies.transport.cancel(credential, workspace, operation)
        : await this.dependencies.transport.inspect(credential, workspace, operation);
      if (result.state === "running") return null;
      if (result.state === "absent") {
        const terminal = this.complete(userId, operation, {
          state: cancel ? "cancelled" : "failed",
          stdout: "",
          stderr: "",
          exitCode: null,
        });
        if (terminal) {
          await this.emit("terminal", this.dependencies.repository.getOwned(userId, operation.id)!);
        }
        return terminal;
      }
      const terminal = this.complete(userId, operation, result);
      if (terminal) {
        await this.emit("terminal", this.dependencies.repository.getOwned(userId, operation.id)!);
      }
      return terminal;
    } catch {
      this.dependencies.repository.markReconcilePending(
        userId,
        operation.id,
        "remote_inspection_required",
        this.now(),
      );
      return null;
    }
  }

  async reconcileOnce(userId?: string): Promise<boolean> {
    const policy = this.dependencies.policy();
    const claimId = randomUUID();
    const operation = this.dependencies.repository.claimDue(
      claimId,
      this.now(),
      this.now() + policy.claimLeaseMs,
      userId,
    );
    if (!operation) return false;
    const context = this.dependencies.repository.getContext(operation.userId, operation.id);
    if (!context) return true;
    if (operation.state === "reserved") {
      this.dependencies.repository.cancelBeforeDispatch(
        operation.userId,
        operation.id,
        this.now(),
        "reservation_expired_before_dispatch",
      );
      await this.emit(
        "terminal",
        this.dependencies.repository.getOwned(operation.userId, operation.id)!,
      );
      return true;
    }
    const cleanupOnly = ["succeeded", "failed", "cancelled", "timed_out"].includes(operation.state);
    try {
      const credential = await this.dependencies.credentials.getCredential(
        operation.userId,
        operation.provider,
      );
      if (cleanupOnly) {
        await this.dependencies.transport.finalize(credential, context.workspace, operation);
        this.dependencies.repository.markRemoteFinalized(
          operation.userId,
          operation.id,
          this.now(),
        );
        return true;
      }
      if (operation.kind !== "exec") {
        if (!this.dependencies.transport.inspectFile) {
          throw new Error("Workspace file reconciliation transport is unavailable");
        }
        const fileResult = await this.dependencies.transport.inspectFile(
          credential,
          context.workspace,
          operation,
        );
        if ("state" in fileResult && fileResult.state === "running") {
          this.dependencies.repository.releaseClaim(
            operation.id,
            claimId,
            "remote_running",
            this.now(),
          );
        } else if ("state" in fileResult && fileResult.state === "absent") {
          this.dependencies.repository.releaseClaim(
            operation.id,
            claimId,
            "remote_inspection_required",
            this.now(),
          );
        } else {
          const completed = this.dependencies.repository.completeMetadata(
            operation.userId,
            operation.id,
            operation.resourceGeneration,
            workspaceFileResultBytes(fileResult),
            this.now() + policy.cleanupDeadlineMs,
            this.now(),
            "state" in fileResult && fileResult.state === "failed" ? "failed" : "succeeded",
          );
          if (completed) {
            await this.emit(
              "terminal",
              this.dependencies.repository.getOwned(operation.userId, operation.id)!,
            );
          }
        }
        return true;
      }
      const shouldCancel =
        operation.state === "cancel_pending" || this.now() >= operation.deadlineAt;
      const result = shouldCancel
        ? await this.dependencies.transport.cancel(credential, context.workspace, operation)
        : await this.dependencies.transport.inspect(credential, context.workspace, operation);
      if (result.state === "running") {
        this.dependencies.repository.releaseClaim(
          operation.id,
          claimId,
          shouldCancel ? "remote_cancel_pending" : "remote_running",
          this.now(),
        );
      } else if (result.state === "absent") {
        const terminal = this.complete(operation.userId, operation, {
          state: shouldCancel ? "cancelled" : "failed",
          stdout: "",
          stderr: "",
          exitCode: null,
        });
        if (terminal) {
          await this.emit(
            "terminal",
            this.dependencies.repository.getOwned(operation.userId, operation.id)!,
          );
        }
      } else {
        const terminal = this.complete(operation.userId, operation, result);
        if (terminal) {
          await this.emit(
            "terminal",
            this.dependencies.repository.getOwned(operation.userId, operation.id)!,
          );
        }
      }
    } catch {
      this.dependencies.repository.releaseClaim(
        operation.id,
        claimId,
        cleanupOnly ? "remote_cleanup_required" : "remote_inspection_required",
        this.now(),
      );
    }
    return true;
  }

  start(): void {
    if (this.timer) return;
    void this.runScheduledReconcile();
    this.timer = setInterval(
      () => void this.runScheduledReconcile(),
      this.dependencies.policy().reconcileIntervalMs,
    );
    this.timer.unref();
  }

  private async runScheduledReconcile(): Promise<void> {
    if (this.scheduledReconcileRunning) return;
    this.scheduledReconcileRunning = true;
    try {
      await this.reconcileOnce();
    } finally {
      this.scheduledReconcileRunning = false;
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private complete(
    userId: string,
    operation: WorkspaceOperationRecord,
    result: WorkspaceOperationResult,
  ): WorkspaceOperationResult | null {
    const now = this.now();
    return this.dependencies.repository.complete(
      userId,
      operation.id,
      operation.resourceGeneration,
      result,
      operation.stdoutLimitBytes,
      operation.stderrLimitBytes,
      now + this.dependencies.policy().cleanupDeadlineMs,
      now,
    );
  }

  private projectRetainedResult(
    operation: WorkspaceOperationRecord,
    result: WorkspaceOperationResult,
  ): WorkspaceOperationResult | null {
    if (!isTerminalOperationState(operation.state)) return null;
    const stateMatches =
      result.state === operation.state ||
      (operation.state === "cancelled" && result.state === "succeeded");
    const stdoutBytes = Buffer.byteLength(result.stdout);
    const stderrBytes = Buffer.byteLength(result.stderr);
    if (
      !stateMatches ||
      result.exitCode !== operation.exitCode ||
      stdoutBytes > operation.stdoutLimitBytes ||
      stderrBytes > operation.stderrLimitBytes ||
      stdoutBytes + stderrBytes !== operation.outputBytes
    ) {
      return null;
    }
    return { ...result, state: operation.state };
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
    });
  }

  private async discardNativeInput(userId: string, referenceId: string): Promise<void> {
    try {
      const claimed = await this.dependencies.transfers!.claimInput(userId, referenceId);
      await this.dependencies.transfers!.consume(claimed.record);
    } catch {
      // Claim validation removes invalid objects; consumed or unavailable references need no work.
    }
  }
}
