import { request as httpRequest, type RequestOptions } from "node:http";
import type {
  WorkspaceExecRequest,
  WorkspaceFileRequest,
  WorkspaceFileResult,
  WorkspaceFileTransport,
  WorkspaceOperationOutputRequest,
  WorkspaceOperationOutputResult,
  WorkspaceOperationRecord,
  WorkspaceOperationResult,
  WorkspaceOperationTransport,
  WorkspaceResourceRecord,
} from "@mcp-moira/shared";
import {
  CONNECTOR_MAX_RESPONSE_BYTES,
  decodeConnectorResponse,
  encodeConnectorRequest,
  validGitHubUserCredential,
} from "./github-codespaces-connector-protocol.mjs";

const SOCKET_PATH = "/run/moira-workspace-connector/connector.sock";
const RESOURCE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
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

function decodeFileVersion(value: unknown) {
  if (!value || typeof value !== "object") return null;
  const version = value as Record<string, unknown>;
  if (
    !hasExactKeys(version, ["size", "sha256", "modifiedAt"]) ||
    !nonnegativeInteger(version.size, MAX_FILE_BYTES) ||
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

type RequestFunction = (
  options: RequestOptions,
  callback: (response: import("node:http").IncomingMessage) => void,
) => import("node:http").ClientRequest;

export class GitHubCodespacesConnector
  implements WorkspaceOperationTransport, WorkspaceFileTransport
{
  constructor(
    private readonly requestImpl: RequestFunction = httpRequest,
    private readonly socketPath = SOCKET_PATH,
    private readonly requestTimeoutMs = 30_000,
  ) {}

  private call(path: "/health" | "/job", body?: unknown, timeoutMs = this.requestTimeoutMs) {
    return new Promise<unknown>((resolve, reject) => {
      const payload = body === undefined ? null : encodeConnectorRequest(body);
      const request = this.requestImpl(
        {
          socketPath: this.socketPath,
          path,
          method: payload ? "POST" : "GET",
          headers: payload
            ? { "content-type": "application/json", "content-length": payload.length }
            : undefined,
        },
        (response) => {
          const chunks: Buffer[] = [];
          let bytes = 0;
          response.on("data", (chunk: Buffer) => {
            bytes += chunk.length;
            if (bytes > CONNECTOR_MAX_RESPONSE_BYTES) {
              request.destroy(new Error("Connector response exceeded its bound"));
            } else chunks.push(Buffer.from(chunk));
          });
          response.once("end", () => {
            if (response.statusCode !== 200) {
              reject(new Error("Connector sidecar is unavailable"));
              return;
            }
            try {
              resolve(decodeConnectorResponse(Buffer.concat(chunks)));
            } catch {
              reject(new Error("Connector sidecar returned an invalid response"));
            }
          });
        },
      );
      request.setTimeout(timeoutMs, () =>
        request.destroy(new Error("Connector request timed out")),
      );
      request.once("error", reject);
      request.end(payload ?? undefined);
    });
  }

  async health(): Promise<{ ok: boolean; reason: string | null }> {
    try {
      const result = (await this.call("/health")) as { state?: string; reason?: string | null };
      return result.state === "available"
        ? { ok: true, reason: null }
        : { ok: false, reason: result.reason ?? "Codespaces connector is unavailable" };
    } catch {
      return { ok: false, reason: "Codespaces connector sidecar is unavailable" };
    }
  }

  async probeSshConfiguration(accessToken: string, resourceName: string): Promise<void> {
    this.validateCredentialAndResource(accessToken, resourceName);
    const result = (await this.call("/job", {
      action: "ssh-config",
      token: accessToken,
      resourceName,
    })) as { value?: string };
    if (
      typeof result.value !== "string" ||
      !result.value.includes("ProxyCommand") ||
      result.value.includes(accessToken)
    ) {
      throw new Error("Codespace SSH capability is unavailable");
    }
  }

  async execute(
    credential: string,
    workspace: WorkspaceResourceRecord,
    operation: WorkspaceOperationRecord,
    request: WorkspaceExecRequest,
  ): Promise<
    | WorkspaceOperationResult
    | { state: "running" }
    | { state: "session_unavailable" }
    | { state: "session_limit"; limit: "context" | "sessions" }
  > {
    if (request.stdin.kind !== "inline") {
      throw new Error("Referenced operation input is not materialized by this transport version");
    }
    const result = await this.operationJob(credential, workspace, operation, {
      action: "execute",
      version: 1,
      remoteMarker: operation.remoteMarker,
      repositoryFullName: workspace.repositoryFullName,
      ...(request.argv !== undefined ? { argv: request.argv } : {}),
      ...(request.cwd !== undefined ? { cwd: request.cwd } : {}),
      ...(request.session !== undefined ? { session: request.session } : {}),
      ...(request.sessionStart !== undefined ? { sessionStart: request.sessionStart } : {}),
      ...(request.sessionEnd !== undefined ? { sessionEnd: request.sessionEnd } : {}),
      ...(request.script !== undefined ? { script: request.script } : {}),
      ...(request.env !== undefined ? { env: request.env } : {}),
      stdin: Buffer.from(request.stdin.bytes).toString("base64"),
      timeoutMs: request.timeoutMs,
      maxStdoutBytes: request.maxStdoutBytes,
      maxStderrBytes: request.maxStderrBytes,
      maxRetainedBytes: request.maxRetainedBytes,
    });
    if (result.state === "absent" || result.state === "interrupted") {
      throw new Error("Remote operation was not created");
    }
    return result;
  }

  async inspect(
    credential: string,
    workspace: WorkspaceResourceRecord,
    operation: WorkspaceOperationRecord,
  ): Promise<
    WorkspaceOperationResult | { state: "running" } | { state: "absent" } | { state: "interrupted" }
  > {
    // Only a dispatch can be refused for its session; an inspection of an existing operation
    // cannot, so that answer is not part of this contract.
    const result = await this.operationJob(credential, workspace, operation, {
      action: "inspect",
      version: 1,
      remoteMarker: operation.remoteMarker,
    });
    if (result.state === "session_unavailable" || result.state === "session_limit") {
      throw new Error("Codespace operation transport returned an invalid result");
    }
    return result;
  }

  async cancel(
    credential: string,
    workspace: WorkspaceResourceRecord,
    operation: WorkspaceOperationRecord,
  ): Promise<
    WorkspaceOperationResult | { state: "running" } | { state: "absent" } | { state: "interrupted" }
  > {
    const result = await this.operationJob(credential, workspace, operation, {
      action: "cancel",
      version: 1,
      remoteMarker: operation.remoteMarker,
    });
    if (result.state === "session_unavailable" || result.state === "session_limit") {
      throw new Error("Codespace operation transport returned an invalid result");
    }
    return result;
  }

  async finalize(
    credential: string,
    workspace: WorkspaceResourceRecord,
    operation: WorkspaceOperationRecord,
  ): Promise<void> {
    const result = await this.operationJob(credential, workspace, operation, {
      action: "finalize",
      version: 1,
      remoteMarker: operation.remoteMarker,
    });
    if (result.state !== "absent") throw new Error("Remote operation cleanup is incomplete");
  }

  async readOutput(
    credential: string,
    workspace: WorkspaceResourceRecord,
    operation: WorkspaceOperationRecord,
    request: WorkspaceOperationOutputRequest,
  ): Promise<WorkspaceOperationOutputResult | { state: "absent" }> {
    const value = await this.submitOperationJob(credential, workspace, operation, {
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
    workspace: WorkspaceResourceRecord,
    operation: WorkspaceOperationRecord,
    request: WorkspaceFileRequest,
  ): Promise<WorkspaceFileResult | { state: "running" }> {
    const result = await this.fileJob(credential, workspace, operation, {
      action: "file-execute",
      version: 1,
      remoteMarker: operation.remoteMarker,
      repositoryFullName: workspace.repositoryFullName,
      request: this.encodeFileRequest(request),
    });
    if ("state" in result) {
      if (result.state === "absent") throw new Error("Remote file operation was not created");
      return result;
    }
    return result;
  }

  inspectFile(
    credential: string,
    workspace: WorkspaceResourceRecord,
    operation: WorkspaceOperationRecord,
  ): Promise<WorkspaceFileResult | { state: "running" } | { state: "absent" }> {
    return this.fileJob(credential, workspace, operation, {
      action: "file-inspect",
      version: 1,
      remoteMarker: operation.remoteMarker,
    });
  }

  private async fileJob(
    credential: string,
    workspace: WorkspaceResourceRecord,
    operation: WorkspaceOperationRecord,
    job: Record<string, unknown>,
  ): Promise<WorkspaceFileResult | { state: "running" } | { state: "absent" }> {
    if (!workspace.providerResourceName || workspace.id !== operation.resourceId) {
      throw new Error("Invalid workspace file operation identity");
    }
    this.validateCredentialAndResource(credential, workspace.providerResourceName);
    const response = (await this.call(
      "/job",
      {
        action: "operation",
        token: credential,
        resourceName: workspace.providerResourceName,
        job,
      },
      this.requestTimeoutMs + 120_000,
    )) as { value?: string };
    if (typeof response.value !== "string" || response.value.includes(credential)) {
      throw new Error("Codespace file transport is unavailable");
    }
    const value = JSON.parse(response.value) as Record<string, unknown>;
    if (value.state === "running" || value.state === "absent") {
      if (!hasExactKeys(value, ["state"])) {
        throw new Error("Codespace file transport returned an invalid pending result");
      }
      return { state: value.state };
    }
    if (
      !hasExactKeys(value, ["state", "value"]) ||
      !["succeeded", "failed"].includes(String(value.state)) ||
      !value.value ||
      typeof value.value !== "object"
    ) {
      throw new Error("Codespace file transport returned an invalid result");
    }
    const result = this.decodeFileResult(
      value.value as Record<string, unknown>,
      operation.stdoutLimitBytes,
    );
    if (
      result.action !== operation.kind ||
      (value.state === "failed") !== ("state" in result && result.state === "failed")
    ) {
      throw new Error("Codespace file transport returned an inconsistent result");
    }
    return result;
  }

  private encodeFileRequest(request: WorkspaceFileRequest): Record<string, unknown> {
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
  ): WorkspaceFileResult {
    const encoded = JSON.stringify(value);
    if (Buffer.byteLength(encoded, "utf8") > 1024 * 1024 || encoded.includes("ghu_")) {
      throw new Error("Codespace file transport returned an invalid result");
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
        !hasExactKeys(value, ["action", "path", "offset", "totalSize", "bytesBase64", "sha256"]) ||
        bytes.length > Math.min(MAX_FILE_BYTES, outputLimitBytes) ||
        !validResultPath(value.path) ||
        !nonnegativeInteger(value.offset) ||
        !nonnegativeInteger(value.totalSize, MAX_FILE_BYTES) ||
        value.offset > value.totalSize ||
        bytes.length > value.totalSize - value.offset ||
        (value.action === "download" && (value.offset !== 0 || bytes.length !== value.totalSize)) ||
        typeof value.sha256 !== "string" ||
        !/^[a-f0-9]{64}$/.test(value.sha256)
      ) {
        throw new Error("Codespace file transport returned invalid bytes metadata");
      }
      return {
        action: value.action,
        path: value.path,
        offset: value.offset,
        totalSize: value.totalSize,
        bytes,
        sha256: value.sha256,
      };
    }
    if (!FILE_RESULT_ACTIONS.has(String(value.action))) {
      throw new Error("Codespace file transport returned an invalid action");
    }
    if (value.state === "failed") {
      if (
        !hasExactKeys(value, ["action", "state", "code"]) ||
        value.code !== "WORKSPACE_FILE_REJECTED"
      ) {
        throw new Error("Codespace file transport returned an invalid failure");
      }
      return value as WorkspaceFileResult;
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
        !nonnegativeInteger(stat.size, MAX_FILE_BYTES) ||
        !nonnegativeInteger(stat.mode, 0o777) ||
        !nonnegativeInteger(stat.modifiedAt) ||
        (stat.type === "file" && (!version || version.size !== stat.size)) ||
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
      return value as WorkspaceFileResult;
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
      return value as WorkspaceFileResult;
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
    workspace: WorkspaceResourceRecord,
    operation: WorkspaceOperationRecord,
    job: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    if (!workspace.providerResourceName || workspace.id !== operation.resourceId) {
      throw new Error("Invalid workspace operation identity");
    }
    this.validateCredentialAndResource(credential, workspace.providerResourceName);
    const result = (await this.call(
      "/job",
      {
        action: "operation",
        token: credential,
        resourceName: workspace.providerResourceName,
        job,
      },
      // A dispatch returns as soon as the remote runner is proven alive, so the budget covers the
      // session and the handshake, never the command's own lifetime.
      Math.min(Number(job.timeoutMs ?? this.requestTimeoutMs), MAX_JOB_WAIT_MS) + 120_000,
    )) as { value?: string };
    if (typeof result.value !== "string" || result.value.includes(credential)) {
      throw new Error("Codespace operation transport is unavailable");
    }
    return JSON.parse(result.value) as Record<string, unknown>;
  }

  private async operationJob(
    credential: string,
    workspace: WorkspaceResourceRecord,
    operation: WorkspaceOperationRecord,
    job: Record<string, unknown>,
  ): Promise<
    | WorkspaceOperationResult
    | { state: "running" }
    | { state: "absent" }
    | { state: "interrupted" }
    | { state: "session_unavailable" }
    | { state: "session_limit"; limit: "context" | "sessions" }
  > {
    const value = await this.submitOperationJob(credential, workspace, operation, job);
    if (
      value.state === "running" ||
      value.state === "absent" ||
      value.state === "interrupted" ||
      value.state === "session_unavailable"
    ) {
      return {
        state: value.state as "running" | "absent" | "interrupted" | "session_unavailable",
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
      state: value.state as WorkspaceOperationResult["state"],
      stdout: stdout.toString("utf8"),
      stderr: stderr.toString("utf8"),
      exitCode: value.exitCode as number | null,
      stdoutTotalBytes: value.stdoutBytes as number,
      stderrTotalBytes: value.stderrBytes as number,
      outputLimitExceeded: value.outputLimitExceeded as boolean,
      sessionCaptureDropped: value.sessionCaptureDropped as boolean,
    };
  }

  private validateCredentialAndResource(accessToken: string, resourceName: string): void {
    if (!validGitHubUserCredential(accessToken)) {
      throw new Error("Invalid GitHub App user credential");
    }
    if (!RESOURCE.test(resourceName)) throw new Error("Invalid Codespace name");
  }
}
