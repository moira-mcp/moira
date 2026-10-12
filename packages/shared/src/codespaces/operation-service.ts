import { CodespaceOperationRepository, truncateCodespaceUtf8 } from "./operation-repository.js";
import { effectiveCodespaceLimits } from "./resource-policy.js";
import { settleAfterDispatch } from "./settle-after-dispatch.js";
import { requireCodespaceTransportAvailable } from "./transport-availability.js";
import type {
  CodespaceExecRequest,
  CodespaceOperationOutputRequest,
  CodespaceOperationOutputResult,
  CodespaceOperationRecord,
  CodespaceOperationResponse,
  CodespaceOperationResult,
  CodespaceOperationTransport,
  CodespaceFileTransport,
  CodespaceNativeFileReference,
  CodespaceResourcePolicy,
} from "./resource-types.js";
import { CodespaceResourceError } from "./resource-types.js";
import type { CodespaceCredentialResolver } from "./resource-service.js";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { canonicalJson } from "../utils/canonical-json.js";
import { localRelayPayloadReferenceSchema } from "./local-device-types.js";
import { codespaceFileResultBytes } from "./file-service.js";
import type { CodespaceTransferRecord } from "./resource-types.js";
import type {
  CodespaceNativeReferenceFetcher,
  CodespaceTransferHandle,
  CodespaceTransferService,
} from "./transfer-service.js";
import { startOnUse, type CodespaceLifecycleStarter } from "./start-on-use.js";

const DEFAULT_BOUNDED_TIMEOUT_MS = 300_000;
// A reservation that is never dispatched is reaped on this deadline, whatever the command's own
// lifetime would have been.
const RESERVATION_DEADLINE_MS = 15 * 60_000;
const MAX_OUTPUT_RANGE_BYTES = 4 * 1024 * 1024;
const MAX_CODESPACE_CWD_BYTES = 4096;
const MAX_SESSION_VARIABLES = 64;
const MAX_SCRIPT_BYTES = 64 * 1024;
const MAX_ENVIRONMENT_VALUE_LENGTH = 4096;
const requestIdentitySchema = z.string().uuid();

function canonicalRequestIdentity(value: unknown): string {
  const parsed = requestIdentitySchema.safeParse(value);
  if (!parsed.success)
    throw new CodespaceResourceError(
      "CODESPACE_RESOURCE_INVALID",
      "A stable request_id UUID is required",
    );
  return parsed.data.toLowerCase();
}

/**
 * The disk one command's retained output may occupy in the codespace. It is the only output bound
 * that stops a command; the payload bounds only decide how much of it a single answer carries.
 */
function retainedOutputBytes(policy: CodespaceResourcePolicy): number {
  return effectiveCodespaceLimits(policy).operations.maxRetainedOutputBytes;
}

/** A terminal outcome for an operation that ended without running a command. */
function terminalWithoutCommand(
  state: CodespaceOperationResult["state"],
): CodespaceOperationResult {
  return {
    state,
    stdout: "",
    stderr: "",
    exitCode: null,
    stdoutTotalBytes: 0,
    stderrTotalBytes: 0,
    outputLimitExceeded: false,
    sessionCaptureDropped: false,
  };
}

function isTerminalOperationState(
  state: CodespaceOperationRecord["state"],
): state is CodespaceOperationResult["state"] {
  return ["succeeded", "failed", "cancelled", "timed_out"].includes(state);
}

export interface CodespaceOperationAuditEvent {
  action: "reserve" | "reconcile" | "terminal";
  userId: string;
  codespaceId: string;
  operationId: string;
  provider: string;
  state: CodespaceOperationRecord["state"];
  kind: CodespaceOperationRecord["kind"];
  inputBytes: number;
  outputBytes: number;
  exitCode: number | null;
  createdAt: number;
  updatedAt: number;
}

function validateRequest(
  request: CodespaceExecRequest,
  policy: CodespaceResourcePolicy,
): {
  inputBytes: number;
  stdoutLimitBytes: number;
  stderrLimitBytes: number;
  timeoutMs: number;
} {
  const limits = effectiveCodespaceLimits(policy).operations;
  // A call carries exactly one kind of work: argv, a script, or ending a session and nothing else.
  const forms = [request.argv !== undefined, request.script !== undefined].filter(Boolean).length;
  if (forms > 1 || (forms === 0 && !request.sessionEnd)) {
    throw new CodespaceResourceError(
      "CODESPACE_RESOURCE_INVALID",
      "Command form is invalid",
      "Give argv, or a script inside a session, or end a session with neither.",
    );
  }
  if ((request.script !== undefined || request.sessionEnd) && request.session === undefined) {
    throw new CodespaceResourceError(
      "CODESPACE_RESOURCE_INVALID",
      "A script requires a session",
      "A script runs in a session so that what it leaves behind can be carried; name one.",
    );
  }
  if (
    request.script !== undefined &&
    (request.script.length === 0 || Buffer.byteLength(request.script) > MAX_SCRIPT_BYTES)
  ) {
    throw new CodespaceResourceError(
      "CODESPACE_RESOURCE_INVALID",
      "Script is invalid",
      `A script is between 1 and ${MAX_SCRIPT_BYTES} bytes.`,
    );
  }
  if (
    request.argv !== undefined &&
    (request.argv.length === 0 ||
      request.argv.length > 128 ||
      request.argv.some(
        (value) =>
          typeof value !== "string" ||
          value.length === 0 ||
          Buffer.byteLength(value) > 16_384 ||
          value.includes("\0"),
      ))
  ) {
    throw new CodespaceResourceError("CODESPACE_RESOURCE_INVALID", "Invalid command arguments");
  }
  const requestedCwd = request.cwd;
  if (
    requestedCwd !== undefined &&
    (Buffer.byteLength(requestedCwd, "utf8") > MAX_CODESPACE_CWD_BYTES ||
      requestedCwd.startsWith("/") ||
      (requestedCwd !== "." &&
        requestedCwd.split("/").some((part) => part === ".." || part === "." || part === "")) ||
      requestedCwd.includes("\0"))
  ) {
    throw new CodespaceResourceError(
      "CODESPACE_RESOURCE_INVALID",
      "Working directory must be codespace-relative",
    );
  }
  const inputBytes =
    request.stdin.kind === "inline" ? request.stdin.bytes.byteLength : request.stdin.declaredBytes;
  if (
    !Number.isSafeInteger(inputBytes) ||
    inputBytes < 0 ||
    inputBytes > limits.maxInputBytes ||
    (request.stdin.kind === "reference" &&
      (request.stdin.referenceId.length < 1 ||
        request.stdin.referenceId.length > 2048 ||
        request.stdin.referenceId.includes("\0")))
  ) {
    throw new CodespaceResourceError("CODESPACE_POLICY_LIMIT", "Operation input exceeds its limit");
  }
  // A bounded command is killed at its timeout inside one request's horizon; a background command
  // is bounded by a codespace-side lifetime instead. The two ceilings are different numbers for
  // different jobs, and the refusal says which one the caller met.
  const ceilingMs = request.background ? limits.maxBackgroundMs : limits.maxDurationMs;
  // A caller that names no duration gets the one its mode implies: a bounded command's ordinary
  // default, a background command its whole ceiling. Otherwise background would mean "returns
  // immediately and is killed in five minutes".
  const timeoutMs =
    request.timeoutMs ??
    (request.background ? ceilingMs : Math.min(DEFAULT_BOUNDED_TIMEOUT_MS, ceilingMs));
  if (timeoutMs < 1 || timeoutMs > ceilingMs) {
    throw new CodespaceResourceError(
      "CODESPACE_POLICY_LIMIT",
      "Operation timeout exceeds its limit",
      request.background
        ? `A background command may run for at most ${Math.floor(ceilingMs / 3_600_000)} hours.`
        : `A command may run for at most ${Math.floor(ceilingMs / 1000)} seconds; start it in the background to run longer.`,
    );
  }
  if (request.session !== undefined && !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(request.session)) {
    throw new CodespaceResourceError(
      "CODESPACE_RESOURCE_INVALID",
      "Session name is invalid",
      "A session name is 1 to 64 characters of letters, digits, hyphen or underscore.",
    );
  }
  if (request.env !== undefined) {
    const variables = Object.entries(request.env);
    if (
      variables.length > MAX_SESSION_VARIABLES ||
      variables.some(
        ([name, value]) =>
          !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(name) ||
          typeof value !== "string" ||
          value.length > MAX_ENVIRONMENT_VALUE_LENGTH,
      )
    ) {
      throw new CodespaceResourceError(
        "CODESPACE_RESOURCE_INVALID",
        "Session variables are invalid",
        `At most ${MAX_SESSION_VARIABLES} variables, each a valid name with a value of at most ${MAX_ENVIRONMENT_VALUE_LENGTH} characters.`,
      );
    }
  }
  const stdoutLimitBytes = request.maxStdoutBytes ?? limits.maxStdoutBytes;
  const stderrLimitBytes = request.maxStderrBytes ?? limits.maxStderrBytes;
  if (
    !Number.isSafeInteger(stdoutLimitBytes) ||
    stdoutLimitBytes < 1 ||
    stdoutLimitBytes > limits.maxStdoutBytes ||
    !Number.isSafeInteger(stderrLimitBytes) ||
    stderrLimitBytes < 1 ||
    stderrLimitBytes > limits.maxStderrBytes
  ) {
    throw new CodespaceResourceError(
      "CODESPACE_POLICY_LIMIT",
      "Operation output exceeds its limit",
    );
  }
  return { inputBytes, stdoutLimitBytes, stderrLimitBytes, timeoutMs };
}

export class CodespaceOperationService {
  private timer: NodeJS.Timeout | null = null;
  private readonly recovery = new Set<Promise<void>>();
  private readonly recoveringOperationIds = new Set<string>();
  private recoveryWakePending = false;
  private readonly admissions = new Map<string, Promise<CodespaceOperationResponse>>();
  constructor(
    private readonly dependencies: {
      repository: CodespaceOperationRepository;
      /** Bound provider for scheduled reconciliation; omitted by legacy single-provider callers. */
      providerId?: string;
      credentials: CodespaceCredentialResolver;
      transport: CodespaceOperationTransport & Partial<CodespaceFileTransport>;
      policy: () => CodespaceResourcePolicy;
      now?: () => number;
      /** Injected so a settle window costs no real time in tests. */
      delay?: (milliseconds: number) => Promise<void>;
      audit?: (event: CodespaceOperationAuditEvent) => Promise<void> | void;
      transfers?: Pick<CodespaceTransferService, "ingest" | "claimInput" | "release" | "consume"> &
        Partial<
          Pick<
            CodespaceTransferService,
            "retainRelayPayload" | "readRelayPayload" | "discardRelayPayload"
          >
        >;
      nativeFetcher?: CodespaceNativeReferenceFetcher;
      /** Durable file intents use this same claimed recovery pool, with their own receipt decoder. */
      reconcileFile?: (operation: CodespaceOperationRecord) => Promise<boolean>;
      /**
       * Starts a codespace that is asleep so the work about to reach it does not fail. Absent where
       * no lifecycle authority is wired, in which case a stopped codespace is refused as before.
       */
      lifecycle?: CodespaceLifecycleStarter;
    },
  ) {}

  async executeNativeReference(
    userId: string,
    codespaceId: string,
    request: Omit<CodespaceExecRequest, "stdin">,
    reference: CodespaceNativeFileReference,
  ): Promise<CodespaceOperationResponse> {
    if (!this.dependencies.transfers || !this.dependencies.nativeFetcher) {
      throw new CodespaceResourceError(
        "CODESPACE_PROVIDER_UNAVAILABLE",
        "Native operation input is unavailable",
      );
    }
    const nativeRequest: CodespaceExecRequest = {
      ...request,
      stdin: {
        kind: "reference",
        referenceId: reference.fileId,
        declaredBytes:
          reference.declaredSize ??
          effectiveCodespaceLimits(this.dependencies.policy()).operations.maxInputBytes,
        declaredMimeType: reference.mimeType ?? "application/octet-stream",
      },
    };
    if (request.requestId) return this.submit(userId, codespaceId, nativeRequest, reference);
    const prepared = await this.reserve(userId, codespaceId, nativeRequest);
    let handle: CodespaceTransferHandle | null = null;
    try {
      this.dependencies.repository.requireResultContext(
        userId,
        prepared.operation.id,
        this.dependencies.policy(),
        this.now(),
      );
      handle = await this.dependencies.transfers.ingest(
        userId,
        reference,
        this.dependencies.nativeFetcher,
        prepared.operation.inputBytes,
      );
      const materialized = this.dependencies.repository.recordInputBytes(
        userId,
        prepared.operation.id,
        handle.size,
        this.now(),
      );
      if (!materialized) {
        throw new CodespaceResourceError(
          "CODESPACE_NOT_RUNNING",
          "Native input operation authority changed",
        );
      }
      prepared.operation = materialized;
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

  /**
   * Reads a range of a command's retained output. The read carries no operation of its own: it is a
   * bounded control request checked against current ownership and authorization like any
   * other call against the operation, and the bytes disappear when the operation's remote outcome is
   * cleaned up.
   */
  async readOutput(
    userId: string,
    operationId: string,
    request: CodespaceOperationOutputRequest,
  ): Promise<CodespaceOperationOutputResult> {
    if (
      !["stdout", "stderr"].includes(request.stream) ||
      !Number.isSafeInteger(request.offset) ||
      request.offset < 0 ||
      !Number.isSafeInteger(request.length) ||
      request.length < 1 ||
      request.length > MAX_OUTPUT_RANGE_BYTES
    ) {
      throw new CodespaceResourceError("CODESPACE_POLICY_LIMIT", "Output range is invalid");
    }
    const { operation, codespace } = this.dependencies.repository.requireResultContext(
      userId,
      operationId,
      this.dependencies.policy(),
      this.now(),
    );
    if (operation.kind !== "exec") {
      throw new CodespaceResourceError(
        "CODESPACE_RESOURCE_INVALID",
        "Only a command operation retains output",
      );
    }
    await requireCodespaceTransportAvailable(this.dependencies.transport);
    const credential = await this.dependencies.credentials.getCredential(
      userId,
      operation.provider,
    );
    const result = await this.dependencies.transport.readOutput(
      credential,
      codespace,
      operation,
      request,
    );
    // Authority is proven again after the awaits, the way every other result-bearing call does.
    this.dependencies.repository.requireResultContext(
      userId,
      operationId,
      this.dependencies.policy(),
      this.now(),
    );
    if ("state" in result) {
      throw new CodespaceResourceError(
        "CODESPACE_RESULT_EXPIRED",
        "Retained operation output is no longer available",
      );
    }
    return result;
  }

  list(userId: string, codespaceId: string): CodespaceOperationRecord[] {
    return this.dependencies.repository.listOwned(userId, codespaceId);
  }

  get(userId: string, operationId: string): CodespaceOperationRecord | null {
    return this.dependencies.repository.getOwned(userId, operationId);
  }

  async execute(
    userId: string,
    codespaceId: string,
    request: CodespaceExecRequest,
  ): Promise<CodespaceOperationResponse> {
    if (request.requestId) return this.submit(userId, codespaceId, request);
    const prepared = await this.reserve(userId, codespaceId, request);
    return this.executePrepared(userId, request, prepared);
  }

  /** Durable acceptance ends before provider delivery; the scheduled worker owns continuation. */
  private async submit(
    userId: string,
    codespaceId: string,
    request: CodespaceExecRequest,
    nativeReference?: CodespaceNativeFileReference,
  ): Promise<CodespaceOperationResponse> {
    const requestId = canonicalRequestIdentity(request.requestId);
    request = { ...request, requestId };
    const source = JSON.parse(
      JSON.stringify({
        ...request,
        requestId: undefined,
        sessionStart: request.sessionStart ?? false,
        sessionEnd: request.sessionEnd ?? false,
        background: request.background ?? false,
        stdin:
          request.stdin.kind === "inline"
            ? { kind: "inline", bytesBase64: Buffer.from(request.stdin.bytes).toString("base64") }
            : request.stdin,
      }),
    );
    const identity = nativeReference
      ? {
          ...source,
          stdin: {
            kind: "native",
            fileId: nativeReference.fileId,
            declaredSize: nativeReference.declaredSize ?? null,
            mimeType: nativeReference.mimeType ?? null,
          },
        }
      : source;
    const digest = createHash("sha256")
      .update(canonicalJson({ codespaceId, request: identity }))
      .digest("hex");
    const key = `${userId}:${requestId}`;
    const pending = this.admissions.get(key);
    if (pending) {
      await pending;
      return this.lookupRequest(userId, codespaceId, requestId, digest);
    }
    const admission = (async () => {
      const previous = this.dependencies.repository.getByRequest(userId, request.requestId!);
      if (previous?.inputReference || (previous && previous.state !== "reserved"))
        return this.lookupRequest(userId, codespaceId, request.requestId!, digest);
      const policy = this.dependencies.policy();
      const bounds = validateRequest(request, policy);
      if (
        !this.dependencies.transfers?.retainRelayPayload ||
        !this.dependencies.transfers.readRelayPayload
      )
        throw new CodespaceResourceError(
          "CODESPACE_PROVIDER_UNAVAILABLE",
          "Durable operation storage is unavailable",
        );
      const reserved = this.dependencies.repository.reserve({
        userId,
        resourceId: codespaceId,
        ...bounds,
        requestId: request.requestId,
        requestDigest: digest,
        runtimeMs: bounds.timeoutMs,
        sessionKey: request.session
          ? createHash("sha256").update(request.session).digest("hex")
          : undefined,
        deadlineAt: previous?.admissionDeadlineAt ?? this.now() + RESERVATION_DEADLINE_MS,
        policy,
        now: this.now(),
      });
      if (!reserved.operation || !reserved.codespace)
        throw new CodespaceResourceError(
          reserved.outcome === "busy"
            ? "CODESPACE_OPERATION_BUSY"
            : reserved.outcome === "not_found"
              ? "CODESPACE_NOT_FOUND"
              : reserved.outcome === "disabled"
                ? "CODESPACE_PROVIDER_DISABLED"
                : "CODESPACE_NOT_RUNNING",
          "Codespace operation cannot be accepted",
        );
      const operation = reserved.operation;
      const input = Buffer.from(
        JSON.stringify({
          request: source,
          nativeReference,
          bounds,
          maxRetainedBytes: retainedOutputBytes(policy),
        }),
      );
      if (input.length > 8 * 1024 * 1024 - 64 * 1024)
        throw new CodespaceResourceError(
          "CODESPACE_POLICY_LIMIT",
          "Accepted command exceeds its control envelope bound",
          undefined,
          true,
          operation.id,
        );
      const reference = await this.dependencies.transfers.retainRelayPayload(
        userId,
        "operation_input",
        input,
        operation.admissionDeadlineAt! + policy.cleanupDeadlineMs,
      );
      if (
        !this.dependencies.repository.attachInput(
          userId,
          operation.id,
          JSON.stringify(reference),
          this.now(),
        )
      ) {
        await this.dependencies.transfers.discardRelayPayload?.(
          userId,
          "operation_input",
          reference,
        );
        const current = this.dependencies.repository.getOwned(userId, operation.id)!;
        if (!current.inputReference)
          throw new CodespaceResourceError(
            "CODESPACE_PROVIDER_UNAVAILABLE",
            "Operation admission expired before its input was durable",
            undefined,
            true,
            operation.id,
          );
      }
      await this.emit("reserve", this.dependencies.repository.getOwned(userId, operation.id)!);
      return {
        operation: this.dependencies.repository.getOwned(userId, operation.id)!,
        result: null,
      };
    })();
    this.admissions.set(key, admission);
    try {
      const accepted = await admission;
      // A wake-up is an optimization. The persisted input and repository claim survive this process.
      void this.runScheduledReconcile();
      return accepted;
    } finally {
      if (this.admissions.get(key) === admission) this.admissions.delete(key);
    }
  }

  async lookupRequest(
    userId: string,
    codespaceId: string,
    requestId: string,
    expectedDigest?: string,
  ): Promise<CodespaceOperationResponse> {
    const operation = this.dependencies.repository.getByRequest(
      userId,
      canonicalRequestIdentity(requestId),
    );
    if (!operation || operation.resourceId !== codespaceId)
      throw new CodespaceResourceError("CODESPACE_NOT_FOUND", "Accepted request was not found");
    if (expectedDigest && operation.requestDigest !== expectedDigest)
      throw new CodespaceResourceError(
        "CODESPACE_RESOURCE_INVALID",
        "Submission identity belongs to a different request",
      );
    this.dependencies.repository.requireAuthority(userId, operation.id, this.dependencies.policy());
    const result = operation.resultReference
      ? await this.readStoredResult(userId, operation)
      : null;
    return { operation: this.dependencies.repository.getOwned(userId, operation.id)!, result };
  }

  private async readStoredResult(
    userId: string,
    operation: CodespaceOperationRecord,
  ): Promise<CodespaceOperationResult | null> {
    if (!operation.resultReference || !this.dependencies.transfers?.readRelayPayload) return null;
    this.dependencies.repository.requireResultContext(
      userId,
      operation.id,
      this.dependencies.policy(),
      this.now(),
    );
    let projected: CodespaceOperationResult | null;
    try {
      const bytes = await this.dependencies.transfers.readRelayPayload(
        userId,
        "operation_result",
        localRelayPayloadReferenceSchema.parse(JSON.parse(operation.resultReference)),
      );
      const result: CodespaceOperationResult = JSON.parse(bytes.toString("utf8"));
      projected = this.projectRetainedResult(operation, result);
      if (!projected) throw new Error("Terminal metadata mismatch");
    } catch (error) {
      if (error instanceof CodespaceResourceError) throw error;
      throw new CodespaceResourceError(
        "CODESPACE_RESOURCE_INVALID",
        "Retained terminal result could not be verified",
        "Keep the original operation identity; an unavailable receipt does not authorize repeating the command.",
        false,
        operation.id,
      );
    }
    this.dependencies.repository.requireResultContext(
      userId,
      operation.id,
      this.dependencies.policy(),
      this.now(),
    );
    return projected;
  }

  private async dispatchAccepted(operation: CodespaceOperationRecord): Promise<void> {
    const transfers = this.dependencies.transfers;
    if (!operation.inputReference || !transfers?.readRelayPayload)
      throw new Error("Accepted operation input is unavailable");
    const bytes = await transfers.readRelayPayload(
      operation.userId,
      "operation_input",
      localRelayPayloadReferenceSchema.parse(JSON.parse(operation.inputReference)),
    );
    const stored = JSON.parse(bytes.toString("utf8")) as {
      request: Omit<CodespaceExecRequest, "stdin"> & {
        stdin: CodespaceExecRequest["stdin"] | { kind: "inline"; bytesBase64: string };
      };
      nativeReference?: CodespaceNativeFileReference;
      bounds: {
        inputBytes: number;
        stdoutLimitBytes: number;
        stderrLimitBytes: number;
        timeoutMs: number;
      };
      maxRetainedBytes: number;
    };
    let request: CodespaceExecRequest = {
      ...stored.request,
      requestId: operation.requestId!,
      stdin:
        stored.request.stdin.kind === "inline" && "bytesBase64" in stored.request.stdin
          ? { kind: "inline", bytes: Buffer.from(stored.request.stdin.bytesBase64, "base64") }
          : (stored.request.stdin as CodespaceExecRequest["stdin"]),
      maxRetainedBytes: stored.maxRetainedBytes,
    };
    const policy = this.dependencies.policy();
    this.dependencies.repository.requireAuthority(operation.userId, operation.id, policy);
    if (operation.admissionDeadlineAt! <= this.now()) {
      this.dependencies.repository.cancelBeforeDispatch(
        operation.userId,
        operation.id,
        this.now(),
        "admission_expired_not_started",
        operation.claimId ?? undefined,
      );
      return;
    }
    await this.dependencies.lifecycle?.ensureRunning(operation.userId, operation.resourceId);
    let nativeHandle: CodespaceTransferHandle | null = null;
    try {
      if (stored.nativeReference) {
        if (!transfers.ingest || !this.dependencies.nativeFetcher)
          throw new Error("Native input fetcher is unavailable");
        nativeHandle = await transfers.ingest(
          operation.userId,
          stored.nativeReference,
          this.dependencies.nativeFetcher,
          operation.inputBytes,
        );
        if (
          !this.dependencies.repository.recordInputBytes(
            operation.userId,
            operation.id,
            nativeHandle.size,
            this.now(),
            operation.claimId ?? undefined,
          )
        )
          throw new Error("Accepted input ownership changed during materialization");
        request = {
          ...request,
          stdin: {
            kind: "reference",
            referenceId: nativeHandle.referenceId,
            declaredBytes: nativeHandle.size,
            declaredMimeType: nativeHandle.mimeType,
          },
        };
      }
      const { codespace } = this.dependencies.repository.requireAuthority(
        operation.userId,
        operation.id,
        policy,
      );
      await this.executePrepared(operation.userId, request, {
        policy,
        ...stored.bounds,
        operation: {
          ...this.dependencies.repository.getOwned(operation.userId, operation.id)!,
          claimId: operation.claimId,
        },
        codespace,
      });
    } finally {
      if (nativeHandle) await this.discardNativeInput(operation.userId, nativeHandle.referenceId);
    }
  }

  private async reserve(userId: string, codespaceId: string, request: CodespaceExecRequest) {
    const policy = this.dependencies.policy();
    const { inputBytes, stdoutLimitBytes, stderrLimitBytes, timeoutMs } = validateRequest(
      request,
      policy,
    );
    const reserveOnce = () =>
      this.dependencies.repository.reserve({
        userId,
        resourceId: codespaceId,
        inputBytes,
        stdoutLimitBytes,
        stderrLimitBytes,
        deadlineAt: this.now() + Math.min(timeoutMs, RESERVATION_DEADLINE_MS),
        policy,
        now: this.now(),
      });
    const reservation = await startOnUse(reserveOnce, this.dependencies.lifecycle, {
      userId,
      codespaceId,
    });
    if (reservation.outcome !== "reserved" || !reservation.operation || !reservation.codespace) {
      const code =
        reservation.outcome === "not_found"
          ? "CODESPACE_NOT_FOUND"
          : reservation.outcome === "busy"
            ? "CODESPACE_OPERATION_BUSY"
            : reservation.outcome === "disabled"
              ? "CODESPACE_PROVIDER_DISABLED"
              : "CODESPACE_NOT_RUNNING";
      throw new CodespaceResourceError(code, "Codespace operation cannot be started");
    }
    const { operation, codespace } = reservation;
    await this.emit("reserve", operation);
    try {
      await requireCodespaceTransportAvailable(this.dependencies.transport);
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
    return { policy, stdoutLimitBytes, stderrLimitBytes, timeoutMs, operation, codespace };
  }

  private async executePrepared(
    userId: string,
    request: CodespaceExecRequest,
    prepared: Awaited<ReturnType<CodespaceOperationService["reserve"]>>,
  ): Promise<CodespaceOperationResponse> {
    const {
      policy,
      stdoutLimitBytes,
      stderrLimitBytes,
      timeoutMs: resolvedTimeoutMs,
      operation,
      codespace,
    } = prepared;
    let terminalResult: CodespaceOperationResult | null = null;
    let terminalEmitted = false;
    let sessionUnavailable = false;
    let sessionLimit: "context" | "sessions" | null = null;
    let remoteContacted = false;
    let claimedInput: CodespaceTransferRecord | null = null;
    let preDispatchOutcome = "credential_unavailable_before_dispatch";
    try {
      if (!this.dependencies.repository.canDispatch(userId, operation.id, this.now())) {
        this.dependencies.repository.cancelBeforeDispatch(
          userId,
          operation.id,
          this.now(),
          undefined,
          operation.requestId ? (operation.claimId ?? undefined) : undefined,
        );
        this.refuseBeforeDispatch(userId, operation, policy);
      }
      let materializedRequest = request;
      if (request.stdin.kind === "reference") {
        preDispatchOutcome = "native_input_unavailable_before_dispatch";
        if (!this.dependencies.transfers) {
          throw new CodespaceResourceError(
            "CODESPACE_RESOURCE_INVALID",
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
          throw new CodespaceResourceError(
            "CODESPACE_RESOURCE_INVALID",
            "Native operation input size changed",
          );
        }
        claimedInput = claimed.record;
        materializedRequest = { ...request, stdin: { kind: "inline", bytes: claimed.bytes } };
        if (operation.requestId) {
          const transfers = this.dependencies.transfers;
          if (!transfers.retainRelayPayload || !operation.inputReference || !operation.claimId)
            throw new Error("Accepted input retention is unavailable");
          const source = {
            ...materializedRequest,
            stdin: { kind: "inline", bytesBase64: claimed.bytes.toString("base64") },
          };
          const retained = await transfers.retainRelayPayload(
            userId,
            "operation_input",
            Buffer.from(
              JSON.stringify({
                request: source,
                bounds: {
                  inputBytes: claimed.bytes.length,
                  stdoutLimitBytes,
                  stderrLimitBytes,
                  timeoutMs: resolvedTimeoutMs,
                },
                maxRetainedBytes: request.maxRetainedBytes ?? retainedOutputBytes(policy),
              }),
            ),
            operation.admissionDeadlineAt! + policy.cleanupDeadlineMs,
          );
          if (
            !this.dependencies.repository.replaceAcceptedInput(
              userId,
              operation.id,
              operation.inputReference,
              JSON.stringify(retained),
              operation.claimId,
              this.now(),
            )
          ) {
            await transfers.discardRelayPayload?.(userId, "operation_input", retained);
            throw new Error("Accepted input ownership changed during materialization");
          }
          await transfers.discardRelayPayload?.(
            userId,
            "operation_input",
            localRelayPayloadReferenceSchema.parse(JSON.parse(operation.inputReference)),
          );
        }
      }
      preDispatchOutcome = "credential_unavailable_before_dispatch";
      const credential = await this.dependencies.credentials.getCredential(
        userId,
        codespace.provider,
      );
      const dispatchNow = this.now();
      if (
        !this.dependencies.repository.beginDispatch(
          userId,
          operation.id,
          randomUUID(),
          dispatchNow + Math.max(policy.claimLeaseMs, 60_000),
          dispatchNow,
          // The command's own lifetime starts when it actually starts, so an undispatched
          // reservation is reaped on the short deadline it was reserved with.
          dispatchNow + resolvedTimeoutMs,
          operation.requestId ? (operation.claimId ?? undefined) : undefined,
        )
      ) {
        if (claimedInput) this.dependencies.transfers?.release(claimedInput);
        this.dependencies.repository.cancelBeforeDispatch(
          userId,
          operation.id,
          this.now(),
          undefined,
          operation.requestId ? (operation.claimId ?? undefined) : undefined,
        );
        this.refuseBeforeDispatch(userId, operation, policy);
      }
      remoteContacted = true;
      const dispatchRequest: CodespaceExecRequest = {
        ...materializedRequest,
        timeoutMs: resolvedTimeoutMs,
        maxStdoutBytes: stdoutLimitBytes,
        maxStderrBytes: stderrLimitBytes,
        maxRetainedBytes: request.maxRetainedBytes ?? retainedOutputBytes(policy),
        ...(operation.requestDigest
          ? {
              requestDigest: operation.requestDigest,
              admissionDeadlineAt: operation.admissionDeadlineAt!,
            }
          : {}),
      };
      if (claimedInput) {
        await this.dependencies.transport.retainExecuteInput?.(
          credential,
          codespace,
          operation,
          dispatchRequest,
        );
        await this.dependencies.transfers!.consume(claimedInput);
        claimedInput = null;
      }
      const result = await this.dependencies.transport.execute(
        credential,
        codespace,
        operation,
        dispatchRequest,
      );
      this.dependencies.repository.requireAuthority(userId, operation.id, policy);
      this.dependencies.repository.recordConnectorRunning(userId, codespace.id, this.now());
      if (result.state === "session_limit") {
        // The stored record says why this operation ended, so a later audit read does not mistake
        // it for a cancellation the caller asked for.
        terminalResult = await this.completeDurably(
          userId,
          operation,
          terminalWithoutCommand("cancelled"),
          operation.requestId ? "session_limit_not_started" : "session_limit",
        );
        terminalEmitted = true;
        sessionLimit = result.limit;
        await this.emit("terminal", this.dependencies.repository.getOwned(userId, operation.id)!);
      } else if (result.state === "session_unavailable") {
        // The command never ran, so the operation ends without one; the refusal is raised after
        // this block so it reaches the caller instead of the recovery path below.
        terminalResult = await this.completeDurably(
          userId,
          operation,
          terminalWithoutCommand("cancelled"),
          operation.requestId ? "session_unavailable_not_started" : "session_unavailable",
        );
        terminalEmitted = true;
        sessionUnavailable = true;
        await this.emit("terminal", this.dependencies.repository.getOwned(userId, operation.id)!);
      } else if (result.state === "outcome_unknown") {
        if (result.startedAt !== undefined) this.recordStart(operation, result);
        this.dependencies.repository.markReconcilePending(
          userId,
          operation.id,
          "launch_outcome_unknown",
          this.now(),
        );
      } else if (result.state === "not_started") {
        terminalResult = await this.completeDurably(
          userId,
          operation,
          terminalWithoutCommand("cancelled"),
          "admission_expired_not_started",
        );
      } else if (result.state === "running") {
        this.recordStart(operation, result);
        this.dependencies.repository.markRunning(userId, operation.id, this.now());
        // A background command is expected to outlive this call, so waiting for it to settle would
        // only delay the running answer the caller asked for.
        terminalResult =
          request.background || operation.requestId
            ? null
            : await settleAfterDispatch(this.dependencies.delay, () =>
                this.reconcile(userId, operation.id),
              );
        // Whichever path stored the outcome has already emitted its terminal event.
        terminalEmitted = terminalResult !== null;
      } else {
        terminalResult = await this.completeDurably(userId, operation, result);
      }
    } catch (error) {
      if (claimedInput) this.dependencies.transfers?.release(claimedInput);
      if (remoteContacted && error instanceof CodespaceResourceError && error.confirmedRefusal) {
        this.dependencies.repository.rejectDispatch(userId, operation.id, error.code, this.now());
        await this.emit("terminal", this.dependencies.repository.getOwned(userId, operation.id)!);
      } else if (remoteContacted) {
        this.dependencies.repository.markReconcilePending(
          userId,
          operation.id,
          "remote_outcome_unknown",
          this.now(),
        );
        await this.emit("reconcile", this.dependencies.repository.getOwned(userId, operation.id)!);
      } else {
        const cancelled = this.dependencies.repository.cancelBeforeDispatch(
          userId,
          operation.id,
          this.now(),
          preDispatchOutcome,
          operation.requestId ? (operation.claimId ?? undefined) : undefined,
        );
        if (cancelled)
          await this.emit("terminal", this.dependencies.repository.getOwned(userId, operation.id)!);
      }
      if (error instanceof CodespaceResourceError)
        throw new CodespaceResourceError(
          error.code,
          error.message,
          error.detail,
          error.confirmedRefusal,
          operation.id,
        );
    }
    if (sessionLimit) {
      throw new CodespaceResourceError(
        "CODESPACE_POLICY_LIMIT",
        "Codespace session limit reached",
        sessionLimit === "sessions"
          ? "This codespace already holds the maximum number of open sessions. End one before opening another."
          : "The session's stored context would exceed its ceiling. Pass fewer or smaller variables, or open a new session.",
      );
    }
    if (sessionUnavailable) {
      throw new CodespaceResourceError(
        "CODESPACE_SESSION_UNAVAILABLE",
        "Codespace session is unavailable",
        "That session belongs to an earlier life of this codespace or was never opened. Open a new session for this codespace.",
      );
    }
    const current = this.dependencies.repository.getOwned(userId, operation.id)!;
    if (terminalResult && !terminalEmitted) await this.emit("terminal", current);
    if (terminalResult) this.dependencies.repository.requireAuthority(userId, operation.id, policy);
    return {
      operation: current,
      result: terminalResult,
    };
  }

  private refuseBeforeDispatch(
    userId: string,
    operation: CodespaceOperationRecord,
    policy: CodespaceResourcePolicy,
  ): never {
    this.dependencies.repository.requireAuthority(userId, operation.id, policy);
    if (this.now() >= operation.deadlineAt)
      throw new CodespaceResourceError(
        "CODESPACE_PROVIDER_UNAVAILABLE",
        "The command request expired before execution",
        "No command was started. Submit a new request.",
      );
    throw new CodespaceResourceError(
      "CODESPACE_NOT_RUNNING",
      "Codespace stopped before the command started",
      "No command was started. Start the codespace and submit the command again.",
    );
  }

  async cancel(userId: string, operationId: string): Promise<CodespaceOperationResponse> {
    const context = this.dependencies.repository.requireAuthority(
      userId,
      operationId,
      this.dependencies.policy(),
    );
    if (context.operation.kind !== "exec")
      throw new CodespaceResourceError(
        "CODESPACE_NOT_FOUND",
        "Codespace command operation was not found",
      );
    const operation = this.dependencies.repository.requestCancel(userId, operationId, this.now());
    if (!operation) {
      throw new CodespaceResourceError("CODESPACE_NOT_FOUND", "Codespace operation was not found");
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

  /** Wait for one already accepted command; never reserve or dispatch it again. */
  async waitForResult(
    userId: string,
    operationId: string,
    waitMs = 5_000,
  ): Promise<CodespaceOperationResponse> {
    const context = this.dependencies.repository.requireResultContext(
      userId,
      operationId,
      this.dependencies.policy(),
      this.now(),
    );
    if (context.operation.kind !== "exec")
      throw new CodespaceResourceError("CODESPACE_NOT_FOUND", "Codespace command was not found");
    if (!Number.isSafeInteger(waitMs) || waitMs < 0 || waitMs > 5_000)
      throw new CodespaceResourceError(
        "CODESPACE_RESOURCE_INVALID",
        "Collection wait must be between0 and5000 milliseconds",
      );
    let closed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const snapshot = (): CodespaceOperationResponse => ({
      operation: this.dependencies.repository.requireAuthority(
        userId,
        operationId,
        this.dependencies.policy(),
      ).operation,
      result: null,
    });
    const observer = (async (): Promise<CodespaceOperationResponse> => {
      do {
        void this.runScheduledReconcile();
        const latest = this.dependencies.repository.getOwned(userId, operationId)!;
        const result = latest.requestId
          ? (await this.lookupRequest(userId, latest.resourceId, latest.requestId)).result
          : await this.reconcile(userId, operationId, false);
        const current = snapshot();
        if (result) return { ...current, result };
        if (closed || waitMs === 0) return current;
        await (this.dependencies.delay?.(150) ??
          new Promise<void>((done) => setTimeout(done, 150)));
        await new Promise<void>((done) => setImmediate(done));
      } while (!closed);
      return snapshot();
    })();
    try {
      const observed = await Promise.race([
        observer,
        new Promise<CodespaceOperationResponse>((done, reject) => {
          timer = setTimeout(() => {
            try {
              done(snapshot());
            } catch (error) {
              reject(error);
            }
          }, waitMs);
        }),
      ]);
      // The observation deadline bounds waiting for guest progress, not collection of a receipt
      // already committed with terminal metadata. Do not publish terminal state without its prefix.
      if (!observed.result && observed.operation.resultReference) {
        if (observed.operation.requestId)
          return this.lookupRequest(
            userId,
            observed.operation.resourceId,
            observed.operation.requestId,
          );
        const result = await this.readStoredResult(userId, observed.operation);
        return { operation: snapshot().operation, result };
      }
      if (
        !observed.result &&
        !observed.operation.requestId &&
        isTerminalOperationState(observed.operation.state) &&
        observed.operation.remoteCleanupPending === 1
      )
        return await observer;
      return observed;
    } finally {
      closed = true;
      if (timer) clearTimeout(timer);
      void observer.catch(() => undefined);
    }
  }

  async reconcile(
    userId: string,
    operationId: string,
    cancel = false,
  ): Promise<CodespaceOperationResult | null> {
    const context = this.dependencies.repository.requireResultContext(
      userId,
      operationId,
      this.dependencies.policy(),
      this.now(),
    );
    const { operation, codespace } = context;
    if (operation.kind !== "exec") {
      throw new CodespaceResourceError("CODESPACE_NOT_FOUND", "Codespace operation was not found");
    }
    if (operation.resultReference) return this.readStoredResult(userId, operation);
    await requireCodespaceTransportAvailable(this.dependencies.transport);
    this.dependencies.repository.requireResultContext(
      userId,
      operationId,
      this.dependencies.policy(),
      this.now(),
    );
    if (operation.state === "reserved") return null;
    try {
      const credential = await this.dependencies.credentials.getCredential(
        userId,
        operation.provider,
      );
      this.dependencies.repository.requireResultContext(
        userId,
        operationId,
        this.dependencies.policy(),
        this.now(),
      );
      if (isTerminalOperationState(operation.state)) {
        if (operation.remoteCleanupPending !== 1) return null;
        const retained = await this.dependencies.transport.inspect(
          credential,
          codespace,
          operation,
        );
        this.dependencies.repository.requireResultContext(
          userId,
          operationId,
          this.dependencies.policy(),
          this.now(),
        );
        if (
          retained.state === "running" ||
          retained.state === "not_started" ||
          retained.state === "outcome_unknown"
        )
          return null;
        if (retained.state === "absent" || retained.state === "interrupted") {
          // Nothing of this operation survives in the codespace, either because it was cleaned up
          // or because the codespace restarted; its stored result is already the whole truth.
          this.dependencies.repository.markRemoteFinalized(userId, operation.id, this.now());
          return null;
        }
        return this.projectRetainedResult(operation, retained);
      }
      const result = cancel
        ? await this.dependencies.transport.cancel(credential, codespace, operation)
        : await this.dependencies.transport.inspect(credential, codespace, operation);
      this.dependencies.repository.requireResultContext(
        userId,
        operationId,
        this.dependencies.policy(),
        this.now(),
      );
      if (result.state === "running") {
        this.recordStart(operation, result);
        this.dependencies.repository.markRunning(userId, operation.id, this.now());
        return null;
      }
      if (result.state === "outcome_unknown") {
        if (result.startedAt !== undefined) this.recordStart(operation, result);
        this.dependencies.repository.markReconcilePending(
          userId,
          operation.id,
          "launch_outcome_unknown",
          this.now(),
        );
        return null;
      }
      if (result.state === "not_started")
        return this.completeObserved(
          userId,
          operation,
          terminalWithoutCommand("cancelled"),
          cancel || operation.state === "cancel_pending"
            ? "cancelled_before_start_not_started"
            : "admission_expired_not_started",
        );
      if (result.state === "interrupted") {
        if (result.startedAt !== undefined) this.recordStart(operation, result);
        // The codespace restarted under the command: its files survived, its process did not.
        return await this.completeObserved(
          userId,
          operation,
          terminalWithoutCommand("failed"),
          "codespace_restarted",
        );
      }
      if (result.state === "absent") {
        this.dependencies.repository.markReconcilePending(
          userId,
          operation.id,
          "launch_outcome_unknown",
          this.now(),
        );
        return null;
      }
      return await this.completeObserved(userId, operation, result);
    } catch (error) {
      if (error instanceof CodespaceResourceError) throw error;
      this.dependencies.repository.markReconcilePending(
        userId,
        operation.id,
        "remote_inspection_required",
        this.now(),
      );
      return null;
    }
  }

  async reconcileOnce(userId?: string, queuedOnly = false): Promise<boolean> {
    const policy = this.dependencies.policy();
    const claimId = randomUUID();
    const operation = this.dependencies.repository.claimDue(
      claimId,
      this.now(),
      this.now() + policy.claimLeaseMs,
      userId,
      this.dependencies.providerId,
      queuedOnly,
      [...this.recoveringOperationIds],
    );
    if (!operation) return false;
    // A slow contact can outlive its durable crash-recovery lease. This live owner
    // must not spend additional recovery slots on the same pending operation.
    this.recoveringOperationIds.add(operation.id);
    try {
      return await this.reconcileClaimedOperation(operation, claimId, policy);
    } finally {
      this.recoveringOperationIds.delete(operation.id);
    }
  }

  private async reconcileClaimedOperation(
    operation: CodespaceOperationRecord,
    claimId: string,
    policy: CodespaceResourcePolicy,
  ): Promise<boolean> {
    // Reserved state proves dispatch admission never occurred. Its expiry must
    // settle independently of the retained input or private preparation lifetime.
    if (operation.state === "reserved" && operation.deadlineAt <= this.now()) {
      if (
        this.dependencies.repository.cancelBeforeDispatch(
          operation.userId,
          operation.id,
          this.now(),
          "reservation_expired_before_dispatch",
          claimId,
        )
      )
        await this.emit(
          "terminal",
          this.dependencies.repository.getOwned(operation.userId, operation.id)!,
        );
      return true;
    }
    if (
      operation.inputReference &&
      (operation.kind !== "exec" || operation.sessionKey === "moira-file-client") &&
      this.dependencies.reconcileFile
    ) {
      try {
        if (await this.dependencies.reconcileFile(operation)) return true;
      } catch {
        this.dependencies.repository.retainClaim(
          operation.id,
          claimId,
          "file_inspection_required",
          this.now(),
        );
        return true;
      }
    }
    const context = this.dependencies.repository.getContext(operation.userId, operation.id);
    if (!context) return true;
    if (operation.state === "reserved") {
      if (operation.inputReference && operation.deadlineAt > this.now()) {
        try {
          await this.dispatchAccepted(operation);
        } catch {
          this.dependencies.repository.cancelBeforeDispatch(
            operation.userId,
            operation.id,
            this.now(),
            "accepted_input_unavailable_not_started",
            claimId,
          );
        }
        return true;
      }
      if (
        this.dependencies.repository.cancelBeforeDispatch(
          operation.userId,
          operation.id,
          this.now(),
          "reservation_expired_before_dispatch",
          claimId,
        )
      )
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
        await this.dependencies.transport.finalize(credential, context.codespace, operation);
        this.dependencies.repository.markRemoteFinalized(
          operation.userId,
          operation.id,
          this.now(),
        );
        return true;
      }
      if (operation.kind !== "exec") {
        if (!this.dependencies.transport.inspectFile) {
          throw new Error("Codespace file reconciliation transport is unavailable");
        }
        const fileResult = await this.dependencies.transport.inspectFile(
          credential,
          context.codespace,
          operation,
        );
        if (
          "state" in fileResult &&
          (fileResult.state === "running" || fileResult.state === "outcome_unknown")
        ) {
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
            "file_outcome_unknown",
            this.now(),
          );
        } else {
          const completed = this.dependencies.repository.completeMetadata(
            operation.userId,
            operation.id,
            codespaceFileResultBytes(fileResult),
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
      const shouldCancel = operation.state === "cancel_pending";
      const result = shouldCancel
        ? await this.dependencies.transport.cancel(credential, context.codespace, operation)
        : await this.dependencies.transport.inspect(credential, context.codespace, operation);
      if (result.state === "running") {
        this.recordStart(operation, result);
        this.dependencies.repository.markRunning(operation.userId, operation.id, this.now());
        this.dependencies.repository.releaseClaim(
          operation.id,
          claimId,
          shouldCancel ? "remote_cancel_pending" : "remote_running",
          this.now(),
        );
      } else if (result.state === "outcome_unknown") {
        if (result.startedAt !== undefined) this.recordStart(operation, result);
        this.dependencies.repository.releaseClaim(
          operation.id,
          claimId,
          "launch_outcome_unknown",
          this.now(),
        );
      } else if (result.state === "not_started") {
        await this.completeDurably(
          operation.userId,
          operation,
          terminalWithoutCommand("cancelled"),
          shouldCancel ? "cancelled_before_start_not_started" : "admission_expired_not_started",
        );
      } else if (result.state === "absent") {
        this.dependencies.repository.releaseClaim(
          operation.id,
          claimId,
          "launch_outcome_unknown",
          this.now(),
        );
      } else if (result.state === "interrupted") {
        if (result.startedAt !== undefined) this.recordStart(operation, result);
        const terminal = await this.completeDurably(
          operation.userId,
          operation,
          terminalWithoutCommand("failed"),
          "codespace_restarted",
        );
        if (terminal) {
          await this.emit(
            "terminal",
            this.dependencies.repository.getOwned(operation.userId, operation.id)!,
          );
        }
      } else {
        const terminal = await this.completeDurably(operation.userId, operation, result);
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

  notifyAccepted(): void {
    void this.runScheduledReconcile(true);
  }

  private async runScheduledReconcile(queuedOnly = false): Promise<void> {
    if (this.recovery.size >= 4) {
      this.recoveryWakePending = true;
      return;
    }
    this.recoveryWakePending = false;
    while (this.recovery.size < 4) {
      let handled = false;
      const task = this.reconcileOnce(undefined, queuedOnly)
        .then(
          (value) => {
            handled = value;
          },
          () => undefined,
        )
        .finally(() => {
          this.recovery.delete(task);
          if (this.recoveryWakePending) void this.runScheduledReconcile();
          else if (handled) void this.runScheduledReconcile(true);
        });
      this.recovery.add(task);
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * Store an observed remote outcome. The background reconciler can complete the same row
   * between this caller's read and its write; the row is then already terminal with the
   * identical outcome, so the observed result is projected against it instead of being
   * dropped, which would otherwise report a terminal operation with no output.
   */
  private async completeObserved(
    userId: string,
    operation: CodespaceOperationRecord,
    result: CodespaceOperationResult,
    lastOutcome?: string,
  ): Promise<CodespaceOperationResult | null> {
    const terminal = await this.completeDurably(userId, operation, result, lastOutcome);
    if (terminal) {
      await this.emit("terminal", this.dependencies.repository.getOwned(userId, operation.id)!);
      return terminal;
    }
    const current = this.dependencies.repository.getOwned(userId, operation.id);
    return current ? this.projectRetainedResult(current, result) : null;
  }

  private recordStart(
    operation: CodespaceOperationRecord,
    receipt: { startedAt?: number; runtimeMs?: number; requestDigest?: string },
  ): void {
    if (!operation.requestDigest) return;
    if (
      receipt.requestDigest !== operation.requestDigest ||
      !Number.isSafeInteger(receipt.startedAt) ||
      receipt.startedAt! <= 0 ||
      receipt.startedAt! > operation.admissionDeadlineAt!
    )
      throw new CodespaceResourceError(
        "CODESPACE_RESOURCE_INVALID",
        "Guest start receipt does not match accepted admission",
      );
    const runtimeMs = receipt.runtimeMs ?? operation.runtimeMs!;
    if (
      !Number.isSafeInteger(runtimeMs) ||
      runtimeMs <= 0 ||
      runtimeMs > operation.runtimeMs! ||
      !this.dependencies.repository.recordStarted(
        operation.userId,
        operation.id,
        receipt.startedAt!,
        runtimeMs,
        operation.requestDigest,
        this.now(),
      )
    )
      throw new CodespaceResourceError(
        "CODESPACE_RESOURCE_INVALID",
        "Guest runtime receipt changed accepted execution",
      );
  }

  private async completeDurably(
    userId: string,
    operation: CodespaceOperationRecord,
    result: CodespaceOperationResult,
    lastOutcome?: string,
  ): Promise<CodespaceOperationResult | null> {
    if (operation.requestId && !lastOutcome) this.recordStart(operation, result);
    result = {
      ...result,
      stdout: truncateCodespaceUtf8(result.stdout, operation.stdoutLimitBytes),
      stderr: truncateCodespaceUtf8(result.stderr, operation.stderrLimitBytes),
    };
    // JSON escaping and replacement characters can expand decoded text beyond the guest frame.
    // Keep the actual retained byte counts; a shorter prefix remains readable by the same marker.
    const maximum = 8 * 1024 * 1024 - 64 * 1024;
    while (Buffer.byteLength(JSON.stringify(result)) > maximum) {
      const scale = Math.min(0.9, maximum / Buffer.byteLength(JSON.stringify(result)));
      result = {
        ...result,
        stdout: truncateCodespaceUtf8(
          result.stdout,
          Math.floor(Buffer.byteLength(result.stdout) * scale),
        ),
        stderr: truncateCodespaceUtf8(
          result.stderr,
          Math.floor(Buffer.byteLength(result.stderr) * scale),
        ),
      };
    }
    const transfers = this.dependencies.transfers;
    if (transfers?.retainRelayPayload) {
      const reference = await transfers.retainRelayPayload(
        userId,
        "operation_result",
        Buffer.from(JSON.stringify(result)),
        this.now() + this.resultRetentionMs(operation),
      );
      const completed = this.complete(
        userId,
        operation,
        result,
        lastOutcome,
        JSON.stringify(reference),
      );
      if (!completed) {
        await transfers.discardRelayPayload?.(userId, "operation_result", reference);
        const current = this.dependencies.repository.getOwned(userId, operation.id)!;
        const previous =
          current.resultReference &&
          localRelayPayloadReferenceSchema.parse(JSON.parse(current.resultReference));
        if (!previous || previous.sha256 !== reference.sha256)
          throw new CodespaceResourceError(
            "CODESPACE_RESOURCE_INVALID",
            "Accepted terminal result is immutable",
          );
      }
      return completed;
    } else if (operation.requestId) throw new Error("Durable terminal storage is unavailable");
    return this.complete(userId, operation, result, lastOutcome);
  }

  private complete(
    userId: string,
    operation: CodespaceOperationRecord,
    result: CodespaceOperationResult,
    lastOutcome?: string,
    resultReference?: string,
  ): CodespaceOperationResult | null {
    const now = this.now();
    return this.dependencies.repository.complete(
      userId,
      operation.id,
      result,
      operation.stdoutLimitBytes,
      operation.stderrLimitBytes,
      now + this.resultRetentionMs(operation),
      now,
      lastOutcome,
      resultReference,
    );
  }

  /**
   * A result stays collectible at least as long as the command was allowed to take. A command that
   * may run for hours cannot be one whose outcome disappears minutes after it ends, and an ordinary
   * bounded command keeps the cleanup window it always had.
   */
  private resultRetentionMs(operation: CodespaceOperationRecord): number {
    const cleanupDeadlineMs = this.dependencies.policy().cleanupDeadlineMs;
    return Math.max(
      cleanupDeadlineMs,
      operation.runtimeMs ?? operation.deadlineAt - operation.createdAt,
    );
  }

  private projectRetainedResult(
    operation: CodespaceOperationRecord,
    result: CodespaceOperationResult,
  ): CodespaceOperationResult | null {
    if (!isTerminalOperationState(operation.state)) return null;
    const stateMatches =
      result.state === operation.state ||
      (operation.state === "cancelled" && result.state === "succeeded");
    // The stored byte count is the complete retained size, so a re-observed result must agree with
    // it while its payload stays within the response bounds.
    if (
      !stateMatches ||
      result.exitCode !== operation.exitCode ||
      Buffer.byteLength(result.stdout) > operation.stdoutLimitBytes ||
      Buffer.byteLength(result.stderr) > operation.stderrLimitBytes ||
      result.stdoutTotalBytes + result.stderrTotalBytes !== operation.outputBytes
    ) {
      return null;
    }
    return { ...result, state: operation.state };
  }

  private async emit(
    action: CodespaceOperationAuditEvent["action"],
    operation: CodespaceOperationRecord,
  ): Promise<void> {
    await this.dependencies.audit?.({
      action,
      userId: operation.userId,
      codespaceId: operation.resourceId,
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

  private async discardNativeInput(userId: string, referenceId: string): Promise<void> {
    try {
      const claimed = await this.dependencies.transfers!.claimInput(userId, referenceId);
      await this.dependencies.transfers!.consume(claimed.record);
    } catch {
      // Claim validation removes invalid objects; consumed or unavailable references need no work.
    }
  }
}
