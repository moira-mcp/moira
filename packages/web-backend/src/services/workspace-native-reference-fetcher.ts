import { lookup } from "node:dns/promises";
import { request as httpsRequest, type RequestOptions } from "node:https";
import { isIP } from "node:net";
import type {
  WorkspaceNativeFileReference,
  WorkspaceNativeReferenceFetcher,
  WorkspaceNativeReferenceResponse,
} from "@mcp-moira/shared";
import { publicIp } from "./github-codespaces-egress-proxy.js";
import { supportedWorkspaceTransferMime } from "@mcp-moira/shared";

const MAX_REDIRECTS = 3;
const RESPONSE_TIMEOUT_MS = 30_000;

export function trustedNativeFileHost(host: string): boolean {
  const normalized = host.toLowerCase().replace(/\.$/, "");
  return (
    (normalized.endsWith(".oaiusercontent.com") &&
      normalized.length > ".oaiusercontent.com".length) ||
    /^oaisdmntpr[a-z0-9-]{1,80}\.blob\.core\.windows\.net$/.test(normalized)
  );
}

type RequestFunction = typeof httpsRequest;

export class OpenAINativeReferenceFetcher implements WorkspaceNativeReferenceFetcher {
  constructor(
    private readonly requestImpl: RequestFunction = httpsRequest,
    private readonly resolveHost: typeof lookup = lookup,
  ) {}

  fetch(reference: WorkspaceNativeFileReference): Promise<WorkspaceNativeReferenceResponse> {
    return this.fetchUrl(new URL(reference.downloadUrl), 0);
  }

  private async fetchUrl(url: URL, redirects: number): Promise<WorkspaceNativeReferenceResponse> {
    if (
      url.protocol !== "https:" ||
      (url.port && url.port !== "443") ||
      url.username ||
      url.password ||
      url.hash ||
      isIP(url.hostname) !== 0 ||
      !trustedNativeFileHost(url.hostname)
    ) {
      throw new Error("Native file URL is not trusted");
    }
    const addresses = await this.resolveHost(url.hostname, { all: true, verbatim: true });
    if (!addresses.length || addresses.some((entry) => !publicIp(entry.address))) {
      throw new Error("Native file URL resolved to an unsafe address");
    }
    const selected = addresses[0];
    return new Promise((resolve, reject) => {
      const options: RequestOptions = {
        protocol: "https:",
        hostname: url.hostname,
        port: 443,
        path: `${url.pathname}${url.search}`,
        method: "GET",
        headers: { accept: "*/*", "user-agent": "Moira-Workspace-Transfer/1" },
        servername: url.hostname,
        lookup: (_host, _options, callback) =>
          callback(null, selected.address, selected.family as 4 | 6),
      };
      const request = this.requestImpl(options, (response) => {
        const remote = response.socket.remoteAddress;
        if (remote !== selected.address && remote !== `::ffff:${selected.address}`) {
          const error = new Error("Native file peer address changed");
          response.resume();
          reject(error);
          return;
        }
        const status = response.statusCode ?? 0;
        if ([301, 302, 303, 307, 308].includes(status)) {
          const location = response.headers.location;
          response.resume();
          if (!location || redirects >= MAX_REDIRECTS) {
            reject(new Error("Native file redirect is invalid"));
            return;
          }
          let target: URL;
          try {
            target = new URL(location, url);
          } catch {
            reject(new Error("Native file redirect is invalid"));
            return;
          }
          void this.fetchUrl(target, redirects + 1).then(resolve, reject);
          return;
        }
        if (status !== 200) {
          response.resume();
          reject(new Error("Native file source is unavailable"));
          return;
        }
        const rawLength = response.headers["content-length"];
        const contentLength = rawLength === undefined ? null : Number(rawLength);
        if (contentLength !== null && (!Number.isSafeInteger(contentLength) || contentLength < 0)) {
          response.resume();
          reject(new Error("Native file content length is invalid"));
          return;
        }
        const contentType = response.headers["content-type"] ?? "application/octet-stream";
        if (
          typeof contentType !== "string" ||
          contentType.length > 256 ||
          !supportedWorkspaceTransferMime(contentType.toLowerCase().split(";", 1)[0].trim())
        ) {
          response.destroy();
          reject(new Error("Native file content type is invalid"));
          return;
        }
        resolve({
          contentLength,
          mimeType: contentType,
          body: response,
          cancel: () => {
            response.destroy();
          },
        });
      });
      request.setTimeout(RESPONSE_TIMEOUT_MS, () =>
        request.destroy(new Error("Native file request timed out")),
      );
      request.once("error", reject);
      request.end();
    });
  }
}
