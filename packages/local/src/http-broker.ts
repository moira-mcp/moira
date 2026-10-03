import { request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import type { BrokerGrant } from "./broker.js";
import { resolvePublicTarget, type ResolveHost } from "./network.js";
import { NetworkBudget } from "./network-budget.js";

/** Plain HTTP dependency downloads use pinned public-address admission, never a host tunnel. */
export function httpBroker(
  budget: NetworkBudget,
  onFault: (error: unknown) => void,
  resolve?: ResolveHost,
) {
  return async (
    request: IncomingMessage,
    response: ServerResponse,
    grant: BrokerGrant,
  ): Promise<void> => {
    let target: URL;
    try {
      target = new URL(request.url ?? "");
    } catch {
      response.writeHead(403, { connection: "close" }).end();
      return;
    }
    if (
      target.protocol !== "http:" ||
      target.username ||
      target.password ||
      (target.port && target.port !== "80") ||
      !["GET", "HEAD"].includes(request.method ?? "") ||
      request.headers["transfer-encoding"] ||
      (request.headers["content-length"] && request.headers["content-length"] !== "0")
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
      const address = await resolvePublicTarget(target.hostname, grant.repository.domains, resolve);
      if (response.destroyed) {
        release();
        return;
      }
      const headers: Record<string, string> = {
        host: target.host,
        "user-agent": "Moira-Local/1",
        connection: "close",
      };
      for (const name of ["accept", "range", "if-modified-since", "if-none-match"]) {
        const value = request.headers[name];
        if (typeof value === "string" && value.length <= 1024) headers[name] = value;
      }
      const upstream = httpRequest(
        {
          hostname: address.address,
          family: address.family,
          port: 80,
          method: request.method,
          path: target.pathname + target.search,
          headers,
          agent: false,
          timeout: 15_000,
          maxHeaderSize: 8192,
        },
        (reply) => {
          const outgoing: Record<string, string> = { connection: "close" };
          for (const name of [
            "content-type",
            "content-length",
            "content-encoding",
            "content-range",
            "etag",
            "last-modified",
            "location",
          ]) {
            const value = reply.headers[name];
            if (typeof value === "string") outgoing[name] = value;
          }
          response.writeHead(reply.statusCode ?? 502, outgoing);
          reply.on("data", (chunk: Buffer) => {
            bytes += chunk.length;
            if (bytes > reservation.maximumBytes) {
              reply.destroy();
              response.destroy();
            }
          });
          reply.once("error", () => response.destroy());
          reply.pipe(response);
        },
      );
      const timer = setTimeout(
        () => upstream.destroy(),
        Math.max(1, Math.min(120_000, grant.policy.leaseUntil - Date.now())),
      );
      upstream.once("close", () => clearTimeout(timer));
      upstream.once("timeout", () => upstream.destroy());
      upstream.once("error", () => {
        if (!response.headersSent) response.writeHead(502, { connection: "close" });
        response.end();
      });
      response.once("close", () => upstream.destroy());
      upstream.end();
    } catch {
      response.writeHead(502, { connection: "close" }).end();
      release();
    }
  };
}
