import { request as httpRequest, type RequestOptions } from "node:http";
import type { CodespaceResourceRecord, CodespaceOperationRecord } from "@mcp-moira/shared";
import {
  CONNECTOR_MAX_RESPONSE_BYTES,
  decodeConnectorResponse,
  encodeConnectorRequest,
  validGitHubUserCredential,
} from "./github-codespaces-connector-protocol.mjs";
import { CodespaceJobTransport } from "./codespace-job-transport.js";

const SOCKET_PATH = "/run/moira-codespace-connector/connector.sock";
const RESOURCE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
type RequestFunction = (
  options: RequestOptions,
  callback: (response: import("node:http").IncomingMessage) => void,
) => import("node:http").ClientRequest;

export class GitHubCodespacesConnector extends CodespaceJobTransport {
  constructor(
    private readonly requestImpl: RequestFunction = httpRequest,
    private readonly socketPath = SOCKET_PATH,
    private readonly requestTimeoutMs = 30_000,
  ) {
    super(requestTimeoutMs);
  }

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

  protected async sendJob(
    credential: string,
    codespace: CodespaceResourceRecord,
    operation: CodespaceOperationRecord,
    job: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<Record<string, unknown>> {
    if (!codespace.providerResourceName || codespace.id !== operation.resourceId) {
      throw new Error("Invalid codespace operation identity");
    }
    this.validateCredentialAndResource(credential, codespace.providerResourceName);
    const response = (await this.call(
      "/job",
      {
        action: "operation",
        token: credential,
        resourceName: codespace.providerResourceName,
        job,
      },
      timeoutMs,
    )) as { value?: unknown };
    if (
      typeof response.value !== "string" ||
      response.value.includes(credential) ||
      (String(job.action).startsWith("file-") && response.value.includes("ghu_"))
    ) {
      throw new Error("Codespace operation transport is unavailable");
    }
    const value: unknown = JSON.parse(response.value);
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("Codespace operation transport returned an invalid envelope");
    }
    return value as Record<string, unknown>;
  }

  private validateCredentialAndResource(accessToken: string, resourceName: string): void {
    if (!validGitHubUserCredential(accessToken)) {
      throw new Error("Invalid GitHub App user credential");
    }
    if (!RESOURCE.test(resourceName)) throw new Error("Invalid Codespace name");
  }
}
