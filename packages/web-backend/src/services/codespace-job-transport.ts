import { createHash } from "node:crypto";
import { CODESPACE_FILE_FAILURE_REASONS, isCodespaceFileClientCommand } from "@mcp-moira/shared";
import type {
  CodespaceExecRequest,
  CodespaceFileRequest,
  CodespaceFileResult,
  CodespaceFileTransport,
  CodespaceFileRuntimeProbe,
  CodespaceFileTransferDescription,
  CodespaceOperationOutputRequest,
  CodespaceOperationOutputResult,
  CodespaceOperationRecord,
  CodespaceOperationResult,
  CodespaceOperationTransport,
  CodespaceResourceRecord,
} from "@mcp-moira/shared";
const TERMINAL_OPERATION_STATES = new Set(["succeeded", "failed", "cancelled", "timed_out"]);
const FILE_RESULT_ACTIONS = new Set([
  "stat",
  "search",
  "read",
  "write",
  "upload",
  "apply_patch",
  "download",
]);
const MAX_JOB_WAIT_MS = 15 * 60_000;
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_FILE_PATH_BYTES = 4096;
const MAX_PATCH_SUMMARY_BYTES = 4 * 1024;

function hasExactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const actual = Object.keys(value).sort();
  return (
    actual.length === keys.length && actual.every((key, index) => key === [...keys].sort()[index])
  );
}

function validResultPath(value: unknown, allowRoot = false): value is string {
  if (allowRoot && value === ".") return true;
  return (
    typeof value === "string" &&
    value.length > 0 &&
    Buffer.byteLength(value, "utf8") <= MAX_FILE_PATH_BYTES &&
    !value.includes("\0") &&
    !value.includes("\\") &&
    !value.startsWith("/") &&
    !value.startsWith("\\") &&
    !/^[A-Za-z]:/.test(value) &&
    value.split("/").every((part) => part !== "" && part !== "." && part !== "..")
  );
}

function nonnegativeInteger(value: unknown, maximum = Number.MAX_SAFE_INTEGER): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= maximum;
}

function decodeFileVersion(value: unknown, maximum = MAX_FILE_BYTES) {
  if (!value || typeof value !== "object") return null;
  const version = value as Record<string, unknown>;
  if (
    !hasExactKeys(version, ["size", "sha256", "modifiedAt"]) ||
    !nonnegativeInteger(version.size, maximum) ||
    typeof version.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(version.sha256) ||
    !nonnegativeInteger(version.modifiedAt)
  ) {
    return null;
  }
  return {
    size: version.size,
    sha256: version.sha256,
    modifiedAt: version.modifiedAt,
  };
}

/** Provider-neutral guest job framing and validation; adapters own authorization and transport. */
export abstract class CodespaceJobTransport
  implements CodespaceOperationTransport, CodespaceFileTransport
{
  constructor(protected readonly jobTimeoutMs = 30_000) {}

  async probeFile(
    credential: string,
    codespace: CodespaceResourceRecord,
    operation: CodespaceOperationRecord,
  ): Promise<CodespaceFileRuntimeProbe> {
    const value = await this.fileControlJob(credential, codespace, operation, { action: "probe" });
    if (
      !hasExactKeys(value, [
        "action",
        "abi",
        "environmentIdentity",
        "workerSha256",
        "cliSha256",
        "command",
        "executableSha256",
      ]) ||
      value.action !== "probe" ||
      !nonnegativeInteger(value.abi) ||
      value.abi !== 1 ||
      typeof value.environmentIdentity !== "string" ||
      !/^[a-f0-9]{64}$/.test(value.environmentIdentity) ||
      !isCodespaceFileClientCommand(value.command) ||
      [value.workerSha256, value.cliSha256, value.executableSha256].some(
        (digest) =>
          digest !== null && (typeof digest !== "string" || !/^[a-f0-9]{64}$/.test(digest)),
      )
    )
      throw new Error("Codespace file runtime probe is invalid");
    return value as unknown as CodespaceFileRuntimeProbe;
  }

  async describeTransfer(
    credential: string,
    codespace: CodespaceResourceRecord,
    operation: CodespaceOperationRecord,
    input: { path: string; maxBytes: number },
  ): Promise<CodespaceFileTransferDescription> {
    const value = await this.fileControlJob(credential, codespace, operation, {
      action: "describe_transfer",
      ...input,
    });
    if (
      !hasExactKeys(value, ["action", "path", "size", "sha256", "environmentIdentity"]) ||
      value.action !== "describe_transfer" ||
      value.path !== input.path ||
      !validResultPath(value.path) ||
      !nonnegativeInteger(value.size, input.maxBytes) ||
      typeof value.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(value.sha256) ||
      typeof value.environmentIdentity !== "string" ||
      !/^[a-f0-9]{64}$/.test(value.environmentIdentity)
    )
      throw new Error("Codespace transfer description is invalid");
    return value as unknown as CodespaceFileTransferDescription;
  }

  private async fileControlJob(
    credential: string,
    codespace: CodespaceResourceRecord,
    operation: CodespaceOperationRecord,
    request: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    if (!codespace.providerResourceName || codespace.id !== operation.resourceId)
      throw new Error("Invalid codespace file control identity");
    const reply = await this.sendJob(
      credential,
      codespace,
      operation,
      {
        action: "file-inspect",
        version: 1,
        remoteMarker: operation.remoteMarker,
        repositoryFullName: codespace.repositoryFullName,
        request,
      },
      this.jobTimeoutMs + 120_000,
    );
    if (
      !hasExactKeys(reply, ["state", "value"]) ||
      reply.state !== "succeeded" ||
      !reply.value ||
      typeof reply.value !== "object" ||
      Array.isArray(reply.value)
    )
      throw new Error("Codespace file control outcome is unconfirmed");
    return reply.value as Record<string, unknown>;
  }

  abstract health(): Promise<{ ok: boolean; reason: string | null }>;

  protected abstract sendJob(
    credential: string,
    codespace: CodespaceResourceRecord,
    operation: CodespaceOperationRecord,
    job: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<Record<string, unknown>>;

  async execute(
    credential: string,
    codespace: CodespaceResourceRecord,
    operation: CodespaceOperationRecord,
    request: CodespaceExecRequest,
  ): Promise<
    | CodespaceOperationResult
    | { state: "running"; startedAt?: number; requestDigest?: string }
    | { state: "not_started"; requestDigest?: string }
    | { state: "outcome_unknown"; requestDigest?: string }
    | { state: "session_unavailable" }
    | { state: "session_limit"; limit: "context" | "sessions" }
  > {
    if (request.stdin.kind !== "inline") {
      throw new Error("Referenced operation input is not materialized by this transport version");
    }
    const result = await this.operationJob(
      credential,
      codespace,
      operation,
      this.executeJob(codespace, operation, request),
    );
    if (result.state === "absent" || result.state === "interrupted") {
      throw new Error("Remote operation was not created");
    }
    return result;
  }

  protected executeJob(
    codespace: CodespaceResourceRecord,
    operation: CodespaceOperationRecord,
    request: CodespaceExecRequest,
  ): Record<string, unknown> {
    if (request.stdin.kind !== "inline") throw new Error("Operation input is not materialized");
    const combinedPrefixBudget = Math.floor(((8 * 1024 * 1024 - 64 * 1024) * 3) / 4);
    const stdout = request.maxStdoutBytes!;
    const stderr = request.maxStderrBytes!;
    const ratio = Math.min(1, combinedPrefixBudget / (stdout + stderr));
    return {
      action: "execute",
      version: 1,
      remoteMarker: operation.remoteMarker,
      repositoryFullName: codespace.repositoryFullName,
      ...(request.requestDigest
        ? { requestDigest: request.requestDigest, admissionDeadlineAt: request.admissionDeadlineAt }
        : {}),
      ...(request.argv !== undefined ? { argv: request.argv } : {}),
      ...(request.cwd !== undefined ? { cwd: request.cwd } : {}),
      ...(request.session !== undefined ? { session: request.session } : {}),
      ...(request.sessionStart !== undefined ? { sessionStart: request.sessionStart } : {}),
      ...(request.sessionEnd !== undefined ? { sessionEnd: request.sessionEnd } : {}),
      ...(request.script !== undefined ? { script: request.script } : {}),
      ...(request.env !== undefined ? { env: request.env } : {}),
      stdin: Buffer.from(request.stdin.bytes).toString("base64"),
      timeoutMs: request.timeoutMs,
      maxStdoutBytes: Math.max(1, Math.floor(stdout * ratio)),
      maxStderrBytes: Math.max(1, Math.floor(stderr * ratio)),
      maxRetainedBytes: request.maxRetainedBytes,
    };
  }

  async inspect(
    credential: string,
    codespace: CodespaceResourceRecord,
    operation: CodespaceOperationRecord,
  ): Promise<
    | CodespaceOperationResult
    | { state: "running"; startedAt?: number; requestDigest?: string }
    | { state: "not_started"; requestDigest?: string }
    | { state: "outcome_unknown"; requestDigest?: string }
    | { state: "absent" }
    | { state: "interrupted" }
  > {
    // Only a dispatch can be refused for its session; an inspection of an existing operation
    // cannot, so that answer is not part of this contract.
    const result = await this.operationJob(credential, codespace, operation, {
      action: "inspect",
      version: 1,
      remoteMarker: operation.remoteMarker,
      ...(operation.requestDigest ? { requestDigest: operation.requestDigest } : {}),
    });
    if (result.state === "session_unavailable" || result.state === "session_limit") {
      throw new Error("Codespace operation transport returned an invalid result");
    }
    return result;
  }

  async cancel(
    credential: string,
    codespace: CodespaceResourceRecord,
    operation: CodespaceOperationRecord,
  ): Promise<
    | CodespaceOperationResult
    | { state: "running"; startedAt?: number; requestDigest?: string }
    | { state: "not_started"; requestDigest?: string }
    | { state: "outcome_unknown"; requestDigest?: string }
    | { state: "absent" }
    | { state: "interrupted" }
  > {
    const result = await this.operationJob(credential, codespace, operation, {
      action: "cancel",
      version: 1,
      remoteMarker: operation.remoteMarker,
      ...(operation.requestDigest
        ? {
            requestDigest: operation.requestDigest,
            admissionDeadlineAt: operation.admissionDeadlineAt,
          }
        : {}),
    });
    if (result.state === "session_unavailable" || result.state === "session_limit") {
      throw new Error("Codespace operation transport returned an invalid result");
    }
    return result;
  }

  async finalize(
    credential: string,
    codespace: CodespaceResourceRecord,
    operation: CodespaceOperationRecord,
  ): Promise<void> {
    const result = await this.operationJob(credential, codespace, operation, {
      action: "finalize",
      version: 1,
      remoteMarker: operation.remoteMarker,
      ...(operation.requestDigest ? { requestDigest: operation.requestDigest } : {}),
    });
    if (result.state !== "absent") throw new Error("Remote operation cleanup is incomplete");
  }

  async readOutput(
    credential: string,
    codespace: CodespaceResourceRecord,
    operation: CodespaceOperationRecord,
    request: CodespaceOperationOutputRequest,
  ): Promise<CodespaceOperationOutputResult | { state: "absent" }> {
    const value = await this.submitOperationJob(credential, codespace, operation, {
      action: "output",
      version: 1,
      remoteMarker: operation.remoteMarker,
      stream: request.stream,
      offset: request.offset,
      length: request.length,
    });
    if (value.state === "absent" && hasExactKeys(value, ["state"])) return { state: "absent" };
    const bytes =
      typeof value.bytesBase64 === "string" ? Buffer.from(value.bytesBase64, "base64") : null;
    if (
      !hasExactKeys(value, ["action", "stream", "offset", "totalBytes", "bytesBase64"]) ||
      value.action !== "output" ||
      value.stream !== request.stream ||
      value.offset !== request.offset ||
      !bytes ||
      bytes.toString("base64") !== value.bytesBase64 ||
      !nonnegativeInteger(value.totalBytes) ||
      bytes.length > Math.min(request.length, Math.max(0, value.totalBytes - request.offset))
    ) {
      throw new Error("Codespace operation transport returned an invalid output range");
    }
    return {
      stream: request.stream,
      offset: request.offset,
      totalBytes: value.totalBytes,
      bytes,
    };
  }

  async executeFile(
    credential: string,
    codespace: CodespaceResourceRecord,
    operation: CodespaceOperationRecord,
    request: CodespaceFileRequest,
  ): Promise<CodespaceFileResult | { state: "running" } | { state: "outcome_unknown" }> {
    const result = await this.fileJob(
      credential,
      codespace,
      operation,
      this.fileExecuteJob(codespace, operation, request),
    );
    if ("state" in result) {
      if (result.state === "absent") throw new Error("Remote file operation was not created");
      return result;
    }
    return result;
  }

  protected fileExecuteJob(
    codespace: CodespaceResourceRecord,
    operation: CodespaceOperationRecord,
    request: CodespaceFileRequest,
  ): Record<string, unknown> {
    return {
      action: "file-execute",
      version: 1,
      remoteMarker: operation.remoteMarker,
      repositoryFullName: codespace.repositoryFullName,
      request: this.encodeFileRequest(request),
      ...(operation.requestDigest
        ? {
            requestDigest: operation.requestDigest,
            admissionDeadlineAt: operation.admissionDeadlineAt,
          }
        : {}),
    };
  }

  inspectFile(
    credential: string,
    codespace: CodespaceResourceRecord,
    operation: CodespaceOperationRecord,
  ): Promise<
    CodespaceFileResult | { state: "running" } | { state: "outcome_unknown" } | { state: "absent" }
  > {
    return this.fileJob(credential, codespace, operation, {
      action: "file-inspect",
      version: 1,
      remoteMarker: operation.remoteMarker,
      ...(operation.requestDigest
        ? {
            requestDigest: operation.requestDigest,
            admissionDeadlineAt: operation.admissionDeadlineAt,
          }
        : {}),
    });
  }

  resumeFile(
    credential: string,
    codespace: CodespaceResourceRecord,
    operation: CodespaceOperationRecord,
    request: CodespaceFileRequest,
  ) {
    return this.fileJob(credential, codespace, operation, {
      ...this.fileExecuteJob(codespace, operation, request),
      action: "file-inspect",
    });
  }

  private async fileJob(
    credential: string,
    codespace: CodespaceResourceRecord,
    operation: CodespaceOperationRecord,
    job: Record<string, unknown>,
  ): Promise<
    CodespaceFileResult | { state: "running" } | { state: "outcome_unknown" } | { state: "absent" }
  > {
    if (!codespace.providerResourceName || codespace.id !== operation.resourceId) {
      throw new Error("Invalid codespace file operation identity");
    }
    const value = await this.sendJob(
      credential,
      codespace,
      operation,
      job,
      this.jobTimeoutMs + 120_000,
    );
    if (
      value.state === "running" ||
      value.state === "outcome_unknown" ||
      value.state === "absent"
    ) {
      if (
        !hasExactKeys(value, [
          "state",
          ...(value.requestDigest !== undefined ? ["requestDigest"] : []),
        ]) ||
        (value.requestDigest !== undefined && value.requestDigest !== operation.requestDigest)
      ) {
        throw new Error("Codespace file transport returned an invalid pending result");
      }
      return value.state === "outcome_unknown"
        ? { state: "outcome_unknown" }
        : value.state === "running"
          ? { state: "running" }
          : { state: "absent" };
    }
    if (
      !hasExactKeys(value, [
        "state",
        "value",
        ...(value.requestDigest !== undefined ? ["requestDigest"] : []),
        ...(value.notStarted !== undefined ? ["notStarted"] : []),
      ]) ||
      (operation.requestDigest != null && value.requestDigest !== operation.requestDigest) ||
      (value.notStarted !== undefined &&
        (value.notStarted !== true || value.state !== "failed" || !operation.requestDigest)) ||
      !["succeeded", "failed"].includes(String(value.state)) ||
      !value.value ||
      typeof value.value !== "object"
    ) {
      throw new Error("Codespace file transport returned an invalid result");
    }
    const result = this.decodeFileResult(
      value.value as Record<string, unknown>,
      operation.stdoutLimitBytes,
      operation.inputBytes,
    );
    if (
      result.action !== operation.kind ||
      (value.state === "failed") !== ("state" in result && result.state === "failed")
    ) {
      throw new Error("Codespace file transport returned an inconsistent result");
    }
    return value.notStarted === true && "state" in result
      ? { ...result, notStarted: true }
      : result;
  }

  private encodeFileRequest(request: CodespaceFileRequest): Record<string, unknown> {
    if ((request.action === "upload" || request.action === "download") && request.transfer) {
      if (request.action === "upload" && request.bytes.byteLength !== 0)
        throw new Error("Transfer control cannot contain file bytes");
      return request.action === "upload"
        ? {
            action: request.action,
            path: request.path,
            expected: request.expected,
            transfer: request.transfer,
          }
        : { ...request };
    }
    if (request.action === "write" || request.action === "upload") {
      return {
        ...request,
        bytesBase64: Buffer.from(request.bytes).toString("base64"),
        bytes: undefined,
      };
    }
    if (request.action === "apply_patch") {
      return {
        ...request,
        summaryMaxBytes: MAX_PATCH_SUMMARY_BYTES,
        files: request.files.map((file) => ({
          ...file,
          edits: file.edits.map((edit) => ({
            start: edit.start,
            end: edit.end,
            bytesBase64: Buffer.from(edit.bytes).toString("base64"),
          })),
        })),
      };
    }
    return { ...request };
  }

  private decodeFileResult(
    value: Record<string, unknown>,
    outputLimitBytes: number,
    inputLimitBytes = MAX_FILE_BYTES,
  ): CodespaceFileResult {
    const encoded = JSON.stringify(value);
    if (Buffer.byteLength(encoded, "utf8") > Math.ceil(MAX_FILE_BYTES / 3) * 4 + 64 * 1024) {
      throw new Error("Codespace file transport returned an invalid result");
    }
    if (
      (value.action === "upload" || value.action === "download") &&
      value.transferId !== undefined
    ) {
      const upload = value.action === "upload";
      const keys = [
        "action",
        "transferId",
        "path",
        "size",
        "sha256",
        ...(upload ? ["previous", "current"] : ["referenceId"]),
      ];
      const current = upload ? decodeFileVersion(value.current, Number.MAX_SAFE_INTEGER) : null;
      const previous = upload ? decodeFileVersion(value.previous, Number.MAX_SAFE_INTEGER) : null;
      if (
        !hasExactKeys(value, keys) ||
        typeof value.transferId !== "string" ||
        !/^[0-9a-f-]{36}$/i.test(value.transferId) ||
        !validResultPath(value.path) ||
        !nonnegativeInteger(value.size, upload ? inputLimitBytes : outputLimitBytes) ||
        typeof value.sha256 !== "string" ||
        !/^[a-f0-9]{64}$/.test(value.sha256) ||
        (upload
          ? !current ||
            current.size !== value.size ||
            current.sha256 !== value.sha256 ||
            (value.previous !== null && !previous)
          : typeof value.referenceId !== "string" ||
            !/^codespace-file:\/\/[A-Za-z0-9_-]{43}$/.test(value.referenceId))
      )
        throw new Error("Codespace transfer receipt is invalid");
      return value as unknown as CodespaceFileResult;
    }
    if (
      (value.action === "read" || value.action === "download") &&
      typeof value.bytesBase64 === "string"
    ) {
      const bytes = Buffer.from(value.bytesBase64, "base64");
      if (bytes.toString("base64") !== value.bytesBase64) {
        throw new Error("Codespace file transport returned invalid bytes");
      }
      if (
        !hasExactKeys(value, [
          "action",
          "path",
          "offset",
          "totalSize",
          "bytesBase64",
          "sha256",
          ...(value.action === "read" && value.rangeSha256 !== undefined ? ["rangeSha256"] : []),
        ]) ||
        bytes.length > Math.min(MAX_FILE_BYTES, outputLimitBytes) ||
        !validResultPath(value.path) ||
        !nonnegativeInteger(value.offset) ||
        !nonnegativeInteger(
          value.totalSize,
          value.action === "download" ? MAX_FILE_BYTES : Number.MAX_SAFE_INTEGER,
        ) ||
        value.offset > value.totalSize ||
        bytes.length > value.totalSize - value.offset ||
        (value.action === "download" && (value.offset !== 0 || bytes.length !== value.totalSize)) ||
        (value.sha256 !== null &&
          (typeof value.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.sha256))) ||
        (value.totalSize <= MAX_FILE_BYTES && value.sha256 === null) ||
        (value.action === "download" && value.sha256 === null) ||
        (value.action === "read" &&
          value.rangeSha256 === undefined &&
          (value.sha256 === null || value.totalSize > MAX_FILE_BYTES))
      ) {
        throw new Error("Codespace file transport returned invalid bytes metadata");
      }
      const metadata = {
        path: value.path,
        offset: value.offset,
        totalSize: value.totalSize,
        bytes,
      };
      if (value.action === "download")
        return { action: "download", ...metadata, sha256: value.sha256 as string };
      const rangeSha256 = createHash("sha256").update(bytes).digest("hex");
      if (
        (value.totalSize > MAX_FILE_BYTES && value.sha256 !== null) ||
        (value.rangeSha256 !== undefined && value.rangeSha256 !== rangeSha256)
      )
        throw new Error("Codespace file transport returned invalid range digest");
      return { action: "read", ...metadata, sha256: value.sha256 as string | null, rangeSha256 };
    }
    if (!FILE_RESULT_ACTIONS.has(String(value.action))) {
      throw new Error("Codespace file transport returned an invalid action");
    }
    if (value.state === "failed") {
      if (
        !hasExactKeys(value, [
          "action",
          "state",
          "code",
          ...(value.reason !== undefined ? ["reason"] : []),
        ]) ||
        (value.reason !== undefined &&
          !CODESPACE_FILE_FAILURE_REASONS.some((reason) => reason === value.reason)) ||
        ![
          "CODESPACE_FILE_REJECTED",
          "WORKSPACE_FILE_REJECTED",
          "CODESPACE_OPERATION_INTERRUPTED",
        ].includes(String(value.code))
      ) {
        throw new Error("Codespace file transport returned an invalid failure");
      }
      // A failed file operation can remain collectible in the remote supervisor after a server
      // upgrade. Accept its version-1 stored code at this private transport boundary, but expose
      // only the renamed code to the service and published MCP contract.
      return {
        ...value,
        code:
          value.code === "CODESPACE_OPERATION_INTERRUPTED" ? value.code : "CODESPACE_FILE_REJECTED",
      } as CodespaceFileResult;
    }
    if (value.action === "stat") {
      const stat = value.stat as Record<string, unknown> | undefined;
      const version = stat ? decodeFileVersion(stat.version) : null;
      if (
        !hasExactKeys(value, ["action", "stat"]) ||
        !stat ||
        !hasExactKeys(stat, ["path", "type", "size", "mode", "modifiedAt", "version"]) ||
        !validResultPath(stat.path, true) ||
        !["file", "directory"].includes(String(stat.type)) ||
        !nonnegativeInteger(stat.size) ||
        !nonnegativeInteger(stat.mode, 0o777) ||
        !nonnegativeInteger(stat.modifiedAt) ||
        (stat.type === "file" &&
          (stat.size <= MAX_FILE_BYTES
            ? !version || version.size !== stat.size
            : stat.version !== null)) ||
        (stat.type === "directory" && (stat.size !== 0 || stat.version !== null))
      ) {
        throw new Error("Codespace file transport returned invalid stat metadata");
      }
      return {
        action: "stat",
        stat: {
          path: stat.path,
          type: stat.type as "file" | "directory",
          size: stat.size,
          mode: stat.mode,
          modifiedAt: stat.modifiedAt,
          version,
        },
      };
    } else if (value.action === "search") {
      if (
        !hasExactKeys(value, ["action", "matches", "truncated"]) ||
        Buffer.byteLength(encoded, "utf8") > outputLimitBytes ||
        !Array.isArray(value.matches) ||
        value.matches.length > 1000 ||
        typeof value.truncated !== "boolean" ||
        value.matches.some((entry) => {
          const match = entry as Record<string, unknown>;
          return (
            !hasExactKeys(match, ["path", "line", "column", "preview"]) ||
            !validResultPath(match.path) ||
            typeof match.preview !== "string" ||
            Buffer.byteLength(match.preview, "utf8") > 2048 ||
            !nonnegativeInteger(match.line) ||
            match.line < 1 ||
            !nonnegativeInteger(match.column) ||
            match.column < 1
          );
        })
      ) {
        throw new Error("Codespace file transport returned invalid search metadata");
      }
      return value as CodespaceFileResult;
    } else if (value.action === "apply_patch") {
      if (
        !hasExactKeys(value, ["action", "files", "summary"]) ||
        Buffer.byteLength(encoded, "utf8") > outputLimitBytes ||
        !Array.isArray(value.files) ||
        value.files.length < 1 ||
        value.files.length > 64 ||
        !this.validPatchFiles(value.files) ||
        !this.validPatchSummary(value.summary, value.files)
      ) {
        throw new Error("Codespace file transport returned invalid patch metadata");
      }
      return value as CodespaceFileResult;
    } else if (value.action === "write" || value.action === "upload") {
      const previous = value.previous === null ? null : decodeFileVersion(value.previous);
      const current = decodeFileVersion(value.current);
      if (
        !hasExactKeys(value, ["action", "path", "previous", "current"]) ||
        Buffer.byteLength(encoded, "utf8") > outputLimitBytes ||
        !validResultPath(value.path) ||
        (value.previous !== null && !previous) ||
        !current
      ) {
        throw new Error("Codespace file transport returned invalid write metadata");
      }
      return { action: value.action, path: value.path, previous, current };
    } else {
      throw new Error("Codespace file transport returned invalid write metadata");
    }
  }

  private validPatchFiles(files: unknown[]): boolean {
    const paths = new Set<string>();
    return files.every((entry) => {
      if (!entry || typeof entry !== "object") return false;
      const file = entry as Record<string, unknown>;
      const previous = file.previous === null ? null : decodeFileVersion(file.previous);
      const current = decodeFileVersion(file.current);
      if (
        !hasExactKeys(file, ["path", "previous", "current"]) ||
        !validResultPath(file.path) ||
        paths.has(file.path) ||
        (file.previous !== null && !previous) ||
        !current
      ) {
        return false;
      }
      paths.add(file.path);
      return true;
    });
  }

  private validPatchSummary(summaryValue: unknown, files: unknown[]): boolean {
    if (!summaryValue || typeof summaryValue !== "object") return false;
    const summary = summaryValue as Record<string, unknown>;
    if (
      !hasExactKeys(summary, [
        "filesChanged",
        "editsApplied",
        "insertedBytes",
        "deletedBytes",
        "entries",
        "truncated",
      ]) ||
      Buffer.byteLength(JSON.stringify(summary), "utf8") > MAX_PATCH_SUMMARY_BYTES ||
      !nonnegativeInteger(summary.filesChanged, 64) ||
      summary.filesChanged !== files.length ||
      !nonnegativeInteger(summary.editsApplied, 4096) ||
      !nonnegativeInteger(summary.insertedBytes, MAX_FILE_BYTES) ||
      !nonnegativeInteger(summary.deletedBytes, 64 * MAX_FILE_BYTES) ||
      !Array.isArray(summary.entries) ||
      summary.entries.length > 64 ||
      typeof summary.truncated !== "boolean"
    ) {
      return false;
    }
    let edits = 0;
    let inserted = 0;
    let deleted = 0;
    for (let index = 0; index < summary.entries.length; index++) {
      const entry = summary.entries[index];
      const file = files[index] as Record<string, unknown>;
      if (!entry || typeof entry !== "object") return false;
      const item = entry as Record<string, unknown>;
      if (
        !hasExactKeys(item, ["path", "edits", "insertedBytes", "deletedBytes"]) ||
        item.path !== file.path ||
        !nonnegativeInteger(item.edits, 4096) ||
        !nonnegativeInteger(item.insertedBytes, MAX_FILE_BYTES) ||
        !nonnegativeInteger(item.deletedBytes, MAX_FILE_BYTES)
      ) {
        return false;
      }
      edits += item.edits;
      inserted += item.insertedBytes;
      deleted += item.deletedBytes;
    }
    if (summary.truncated === false && summary.entries.length !== files.length) return false;
    if (summary.truncated === true && summary.entries.length >= files.length) return false;
    return summary.truncated
      ? edits <= summary.editsApplied &&
          inserted <= summary.insertedBytes &&
          deleted <= summary.deletedBytes
      : edits === summary.editsApplied &&
          inserted === summary.insertedBytes &&
          deleted === summary.deletedBytes;
  }

  /**
   * Submits one operation job and returns its decoded envelope. Every operation job is framed here,
   * so the client budget always matches the sidecar's, which allows the job's own timeout plus the
   * time it needs to open a session into the Codespace.
   */
  private async submitOperationJob(
    credential: string,
    codespace: CodespaceResourceRecord,
    operation: CodespaceOperationRecord,
    job: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    if (!codespace.providerResourceName || codespace.id !== operation.resourceId) {
      throw new Error("Invalid codespace operation identity");
    }
    return this.sendJob(
      credential,
      codespace,
      operation,
      job,
      Math.min(Number(job.timeoutMs ?? this.jobTimeoutMs), MAX_JOB_WAIT_MS) + 120_000,
    );
  }

  private async operationJob(
    credential: string,
    codespace: CodespaceResourceRecord,
    operation: CodespaceOperationRecord,
    job: Record<string, unknown>,
  ): Promise<
    | CodespaceOperationResult
    | { state: "running"; startedAt?: number; requestDigest?: string }
    | { state: "not_started"; requestDigest?: string }
    | { state: "outcome_unknown"; requestDigest?: string }
    | { state: "absent" }
    | { state: "interrupted" }
    | { state: "session_unavailable" }
    | { state: "session_limit"; limit: "context" | "sessions" }
  > {
    const value = await this.submitOperationJob(credential, codespace, operation, job);
    // Cleanup confirms absence after deliberately removing execution proof; it is not a result receipt.
    const receipt =
      operation.requestDigest && job.action !== "finalize"
        ? (() => {
            const startRequired =
              value.state === "running" ||
              value.state === "session_ended" ||
              TERMINAL_OPERATION_STATES.has(String(value.state));
            if (
              value.requestDigest !== operation.requestDigest ||
              (startRequired && value.startedAt === undefined) ||
              (value.startedAt !== undefined &&
                (!nonnegativeInteger(value.startedAt) ||
                  value.startedAt === 0 ||
                  value.startedAt > operation.admissionDeadlineAt!)) ||
              (value.state === "not_started" &&
                (value.startedAt !== undefined || operation.startedAt != null))
            )
              throw new Error("Codespace receipt does not match accepted request");
            if (
              value.runtimeMs !== undefined &&
              (!nonnegativeInteger(value.runtimeMs) ||
                value.runtimeMs === 0 ||
                Number(value.runtimeMs) > operation.runtimeMs!)
            )
              throw new Error("Codespace runtime receipt exceeds accepted duration");
            return {
              requestDigest: value.requestDigest as string,
              ...(value.startedAt !== undefined ? { startedAt: value.startedAt as number } : {}),
              ...(value.runtimeMs !== undefined ? { runtimeMs: value.runtimeMs as number } : {}),
            };
          })()
        : {};
    if (value.state === "not_started") return { state: "not_started", ...receipt };
    if (value.state === "outcome_unknown") return { state: "outcome_unknown", ...receipt };
    if (
      value.state === "running" ||
      value.state === "absent" ||
      value.state === "interrupted" ||
      value.state === "session_unavailable"
    ) {
      return {
        state: value.state as "running" | "absent" | "interrupted" | "session_unavailable",
        ...receipt,
      };
    }
    if (value.state === "session_limit") {
      const limit = value.limit === "sessions" ? "sessions" : "context";
      return { state: "session_limit", limit };
    }
    if (value.state === "session_ended") {
      // Ending a session runs no command, so it is reported as an operation that succeeded with
      // nothing to show.
      return {
        state: "succeeded",
        ...receipt,
        stdout: "",
        stderr: "",
        exitCode: 0,
        stdoutTotalBytes: 0,
        stderrTotalBytes: 0,
        outputLimitExceeded: false,
        sessionCaptureDropped: false,
      };
    }
    if (
      typeof value.state !== "string" ||
      !TERMINAL_OPERATION_STATES.has(value.state) ||
      typeof value.stdoutBase64 !== "string" ||
      typeof value.stderrBase64 !== "string" ||
      !(value.exitCode === null || Number.isInteger(value.exitCode)) ||
      !nonnegativeInteger(value.stdoutBytes) ||
      !nonnegativeInteger(value.stderrBytes) ||
      typeof value.outputLimitExceeded !== "boolean" ||
      typeof value.sessionCaptureDropped !== "boolean"
    ) {
      throw new Error("Codespace operation transport returned an invalid result");
    }
    const stdout = Buffer.from(value.stdoutBase64, "base64");
    const stderr = Buffer.from(value.stderrBase64, "base64");
    if (
      stdout.toString("base64") !== value.stdoutBase64 ||
      stderr.toString("base64") !== value.stderrBase64 ||
      stdout.length > operation.stdoutLimitBytes ||
      stderr.length > operation.stderrLimitBytes ||
      stdout.length > (value.stdoutBytes as number) ||
      stderr.length > (value.stderrBytes as number)
    ) {
      throw new Error("Codespace operation transport exceeded its result contract");
    }
    return {
      state: value.state as CodespaceOperationResult["state"],
      ...receipt,
      stdout: stdout.toString("utf8"),
      stderr: stderr.toString("utf8"),
      exitCode: value.exitCode as number | null,
      stdoutTotalBytes: value.stdoutBytes as number,
      stderrTotalBytes: value.stderrBytes as number,
      outputLimitExceeded: value.outputLimitExceeded as boolean,
      sessionCaptureDropped: value.sessionCaptureDropped as boolean,
    };
  }
}
