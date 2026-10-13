import { request as httpRequest, type RequestOptions } from "node:http";
import {
  CONNECTOR_MAX_RESPONSE_BYTES,
  decodeConnectorResponse,
  encodeConnectorRequest,
  validGitHubUserCredential,
} from "./github-codespaces-connector-protocol.mjs";

const SOCKET_PATH = "/run/moira-codespace-connector/connector.sock";
const RESOURCE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
type RequestFunction = (
  options: RequestOptions,
  callback: (response: import("node:http").IncomingMessage) => void,
) => import("node:http").ClientRequest;

export class GitHubCodespacesConnector {
  constructor(
    private readonly requestImpl: RequestFunction = httpRequest,
    private readonly socketPath = SOCKET_PATH,
    private readonly requestTimeoutMs = 30_000,
  ) {}

  private call(path: "/health" | "/bootstrap", body?: unknown, timeoutMs = this.requestTimeoutMs) {
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
          response.once("error", reject);
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
    const result = (await this.call("/bootstrap", {
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

  async probeWorkspace(
    accessToken: string,
    resourceName: string,
  ): Promise<{ environmentIdentity: string; architecture: string; rootBase64: string }> {
    this.validateCredentialAndResource(accessToken, resourceName);
    const response = (await this.call("/bootstrap", {
      action: "probe",
      token: accessToken,
      resourceName,
    })) as { value?: string };
    if (typeof response.value !== "string" || response.value.includes(accessToken))
      throw new Error("Invalid workspace bootstrap observation");
    const value = JSON.parse(String(response.value)) as {
      environmentIdentity: string;
      architecture: string;
      rootBase64: string;
    };
    if (
      !/^[a-f0-9]{64}$/.test(value.environmentIdentity) ||
      !["x86_64", "aarch64"].includes(value.architecture) ||
      !/^[A-Za-z0-9+/]+=*$/.test(value.rootBase64)
    )
      throw new Error("Invalid workspace bootstrap observation");
    return {
      environmentIdentity: value.environmentIdentity,
      architecture: value.architecture,
      rootBase64: value.rootBase64,
    };
  }

  async bootstrapWorkspace(
    accessToken: string,
    resourceName: string,
    configuration: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    this.validateCredentialAndResource(accessToken, resourceName);
    const response = (await this.call(
      "/bootstrap",
      { action: "install", token: accessToken, resourceName, configuration },
      300_000,
    )) as { value?: string };
    if (typeof response.value !== "string" || response.value.includes(accessToken))
      throw new Error("Invalid workspace bootstrap readiness");
    const value = JSON.parse(response.value) as Record<string, unknown>;
    if (
      value.version !== 1 ||
      value.repositoryFullName !== configuration.repositoryFullName ||
      value.environmentIdentity !==
        (configuration.remote as { environmentIdentity?: unknown })?.environmentIdentity ||
      typeof value.releaseIdentity !== "string" ||
      !/^[a-f0-9]{64}$/.test(value.releaseIdentity)
    )
      throw new Error("Invalid workspace bootstrap readiness");
    return {
      version: 1,
      repositoryFullName: value.repositoryFullName,
      environmentIdentity: value.environmentIdentity,
      releaseIdentity: value.releaseIdentity,
    };
  }

  private validateCredentialAndResource(accessToken: string, resourceName: string): void {
    if (!validGitHubUserCredential(accessToken)) {
      throw new Error("Invalid GitHub App user credential");
    }
    if (!RESOURCE.test(resourceName)) throw new Error("Invalid Codespace name");
  }
}
