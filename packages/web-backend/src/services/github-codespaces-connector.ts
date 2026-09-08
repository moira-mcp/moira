import { request as httpRequest, type RequestOptions } from "node:http";
import type {
  WorkspaceExecRequest,
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

type RequestFunction = (
  options: RequestOptions,
  callback: (response: import("node:http").IncomingMessage) => void,
) => import("node:http").ClientRequest;

export class GitHubCodespacesConnector implements WorkspaceOperationTransport {
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
  ): Promise<WorkspaceOperationResult | { state: "running" }> {
    if (request.stdin.kind !== "inline") {
      throw new Error("Referenced operation input is not materialized by this transport version");
    }
    const result = await this.operationJob(credential, workspace, operation, {
      action: "execute",
      version: 1,
      remoteMarker: operation.remoteMarker,
      repositoryFullName: workspace.repositoryFullName,
      argv: request.argv,
      cwd: request.cwd,
      stdin: Buffer.from(request.stdin.bytes).toString("base64"),
      timeoutMs: request.timeoutMs,
      maxStdoutBytes: request.maxStdoutBytes,
      maxStderrBytes: request.maxStderrBytes,
    });
    if (result.state === "absent") throw new Error("Remote operation was not created");
    return result;
  }

  inspect(
    credential: string,
    workspace: WorkspaceResourceRecord,
    operation: WorkspaceOperationRecord,
  ) {
    return this.operationJob(credential, workspace, operation, {
      action: "inspect",
      version: 1,
      remoteMarker: operation.remoteMarker,
    });
  }

  cancel(
    credential: string,
    workspace: WorkspaceResourceRecord,
    operation: WorkspaceOperationRecord,
  ) {
    return this.operationJob(credential, workspace, operation, {
      action: "cancel",
      version: 1,
      remoteMarker: operation.remoteMarker,
    });
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

  private async operationJob(
    credential: string,
    workspace: WorkspaceResourceRecord,
    operation: WorkspaceOperationRecord,
    job: Record<string, unknown>,
  ): Promise<WorkspaceOperationResult | { state: "running" } | { state: "absent" }> {
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
      Number(job.timeoutMs ?? this.requestTimeoutMs) + 120_000,
    )) as { value?: string };
    if (typeof result.value !== "string" || result.value.includes(credential)) {
      throw new Error("Codespace operation transport is unavailable");
    }
    const value = JSON.parse(result.value) as Record<string, unknown>;
    if (value.state === "running" || value.state === "absent") return { state: value.state };
    if (
      typeof value.state !== "string" ||
      !TERMINAL_OPERATION_STATES.has(value.state) ||
      typeof value.stdoutBase64 !== "string" ||
      typeof value.stderrBase64 !== "string" ||
      !(value.exitCode === null || Number.isInteger(value.exitCode))
    ) {
      throw new Error("Codespace operation transport returned an invalid result");
    }
    const stdout = Buffer.from(value.stdoutBase64, "base64");
    const stderr = Buffer.from(value.stderrBase64, "base64");
    if (
      stdout.toString("base64") !== value.stdoutBase64 ||
      stderr.toString("base64") !== value.stderrBase64 ||
      stdout.length > operation.stdoutLimitBytes ||
      stderr.length > operation.stderrLimitBytes
    ) {
      throw new Error("Codespace operation transport exceeded its result contract");
    }
    return {
      state: value.state as WorkspaceOperationResult["state"],
      stdout: stdout.toString("utf8"),
      stderr: stderr.toString("utf8"),
      exitCode: value.exitCode as number | null,
    };
  }

  private validateCredentialAndResource(accessToken: string, resourceName: string): void {
    if (!validGitHubUserCredential(accessToken)) {
      throw new Error("Invalid GitHub App user credential");
    }
    if (!RESOURCE.test(resourceName)) throw new Error("Invalid Codespace name");
  }
}
