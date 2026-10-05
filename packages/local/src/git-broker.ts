/* eslint-disable no-control-regex -- control-byte rejection is part of this broker boundary. */
import { request as httpsRequest } from "node:https";
import { checkServerIdentity } from "node:tls";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { BrokerGrant } from "./broker.js";
import { NetworkBudget } from "./network-budget.js";
import { resolvePublicTarget, type ResolveHost } from "./network.js";

/** GitHub smart HTTP only: no arbitrary URL, API call, redirect, host Git process or credential export. */
export function gitBroker(
  budget: NetworkBudget,
  onFault: (error: unknown) => void,
  resolve?: ResolveHost,
  requestHttps: typeof httpsRequest = httpsRequest,
) {
  return async (
    request: IncomingMessage,
    response: ServerResponse,
    grant: BrokerGrant,
  ): Promise<void> => {
    const prefix = `/git/${grant.repository.fullName}.git/`;
    if (!request.url?.startsWith(prefix) || /[\\%\x00-\x20]/.test(request.url)) {
      response.writeHead(403, { connection: "close" }).end();
      return;
    }
    const relative = request.url.slice(prefix.length);
    const url = new URL(`https://github.com/${grant.repository.fullName}.git/${relative}`);
    const tail = url.pathname.split("/").at(-1);
    const service = tail === "info" ? "" : url.searchParams.get("service");
    const info =
      relative.startsWith("info/refs?") && request.method === "GET" && url.searchParams.size === 1;
    const fetch =
      (info && service === "git-upload-pack") ||
      (relative === "git-upload-pack" && request.method === "POST");
    const push =
      (info && service === "git-receive-pack") ||
      (relative === "git-receive-pack" && request.method === "POST");
    if (
      (!fetch && !push) ||
      (push && !grant.repository.allowPush) ||
      (grant.repository.private && !grant.gitCredential)
    ) {
      response.writeHead(403, { connection: "close" }).end();
      return;
    }
    const reservation = await budget.reserve(grant.policy);
    let bytes = 0;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      void reservation.release(bytes).catch(onFault);
    };
    response.once("close", release);
    try {
      const target = await resolvePublicTarget("github.com", ["github.com"], resolve);
      if (response.destroyed) {
        release();
        return;
      }
      const headers: Record<string, string> = {
        host: "github.com",
        "user-agent": "Moira-Local/1",
        accept: "*/*",
      };
      if (request.method === "POST") {
        headers["content-type"] =
          `application/x-${push ? "git-receive-pack" : "git-upload-pack"}-request`;
      }
      if (request.headers["git-protocol"] === "version=2") headers["git-protocol"] = "version=2";
      if (grant.gitCredential)
        headers.authorization = `Basic ${Buffer.from(`x-access-token:${grant.gitCredential}`).toString("base64")}`;
      const upstream = requestHttps(
        {
          hostname: target.address,
          family: target.family,
          servername: "github.com",
          checkServerIdentity: (_host, certificate) =>
            checkServerIdentity("github.com", certificate),
          method: request.method,
          path: url.pathname + url.search,
          headers,
          agent: false,
          timeout: 15_000,
          maxHeaderSize: 8192,
        },
        (reply) => {
          const status = reply.statusCode ?? 502;
          if (status >= 300 && status < 400) {
            reply.destroy();
            response.writeHead(502, { connection: "close" }).end();
            return;
          }
          const contentType = reply.headers["content-type"];
          response.writeHead(status, {
            "content-type":
              typeof contentType === "string" ? contentType : "application/octet-stream",
            "cache-control": "no-store",
            connection: "close",
          });
          reply.on("data", (chunk: Buffer) => {
            bytes += chunk.length;
            if (bytes > reservation.maximumBytes) {
              reply.destroy();
              response.destroy();
            }
          });
          reply.on("error", () => response.destroy());
          reply.pipe(response);
        },
      );
      const lifetime = setTimeout(
        () => upstream.destroy(),
        Math.max(1, Math.min(120_000, grant.policy.leaseUntil - Date.now())),
      );
      upstream.once("close", () => clearTimeout(lifetime));
      upstream.once("timeout", () => upstream.destroy());
      upstream.once("error", () => {
        if (!response.headersSent) response.writeHead(502, { connection: "close" });
        response.end();
      });
      request.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > reservation.maximumBytes) {
          upstream.destroy();
          response.destroy();
        }
      });
      request.once("aborted", () => upstream.destroy());
      response.once("close", () => upstream.destroy());
      request.pipe(upstream);
    } catch {
      response.writeHead(502, { connection: "close" }).end();
      release();
    }
  };
}
