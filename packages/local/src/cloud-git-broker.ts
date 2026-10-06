import { request as httpsRequest } from "node:https";
import type { BrokerOptions } from "./broker.js";
import { NetworkBudget } from "./network-budget.js";
import { relayOrigin } from "./relay.js";

export interface CloudGitAuthority {
  origin: string;
  credential: string;
  resourceId: string;
  resourceGeneration: number;
}
/** Stream only fixed smart Git operations to the locally pinned server; OAuth stays there. */
export function cloudGitBroker(
  authority: (
    spaceId: string,
    generation: number,
    repositoryId: string,
  ) => Promise<CloudGitAuthority>,
  budget: NetworkBudget,
  onFault: (error: unknown) => void,
  fallback: BrokerOptions["git"],
  requestHttps: typeof httpsRequest = httpsRequest,
): BrokerOptions["git"] {
  return async (request, response, grant) => {
    if (!grant.spaceId || !grant.generation) {
      await fallback(request, response, grant);
      return;
    }
    const prefix = `/git/${grant.repository.fullName}.git/`;
    const relative = request.url?.startsWith(prefix) ? request.url.slice(prefix.length) : "";
    const actions: Record<string, string> = {
      "info/refs?service=git-upload-pack": "refs-fetch",
      "info/refs?service=git-receive-pack": "refs-push",
      "git-upload-pack": "fetch",
      "git-receive-pack": "push",
    };
    const action = actions[relative];
    if (
      !action ||
      request.method !== (action.startsWith("refs-") ? "GET" : "POST") ||
      ((action === "push" || action === "refs-push") && !grant.repository.allowPush)
    ) {
      response.writeHead(403, { connection: "close" }).end();
      return;
    }
    const binding = await authority(grant.spaceId, grant.generation, grant.repository.id);
    const target = new URL(
      `${relayOrigin(binding.origin)}/api/local-devices/github/${binding.resourceId}/${binding.resourceGeneration}/git/${action}`,
    );
    const reservation = await budget.reserve(grant.policy);
    let used = 0;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      void reservation.release(used).catch(onFault);
    };
    response.once("close", release);
    const upstream = requestHttps(
      target,
      {
        method: request.method,
        agent: false,
        timeout: 15000,
        maxHeaderSize: 8192,
        headers: {
          authorization: `Bearer ${binding.credential}`,
          ...(request.method === "POST"
            ? {
                "content-type": `application/x-git-${action === "push" ? "receive" : "upload"}-pack-request`,
              }
            : {}),
          ...(request.headers["git-protocol"] === "version=2"
            ? { "git-protocol": "version=2" }
            : {}),
        },
      },
      (reply) => {
        const status = reply.statusCode ?? 502;
        if (status >= 300 && status < 400) {
          reply.destroy();
          response.writeHead(502, { connection: "close" }).end();
          return;
        }
        response.writeHead(status, {
          "content-type":
            typeof reply.headers["content-type"] === "string"
              ? reply.headers["content-type"]
              : "application/octet-stream",
          "cache-control": "no-store",
          connection: "close",
        });
        reply.on("data", count);
        reply.once("error", () => response.destroy());
        reply.pipe(response);
      },
    );
    const count = (chunk: Buffer) => {
      used += chunk.length;
      if (used > reservation.maximumBytes) {
        upstream.destroy();
        response.destroy();
      }
    };
    const lifetime = setTimeout(
      () => upstream.destroy(),
      Math.max(1, Math.min(120000, grant.policy.leaseUntil - Date.now())),
    );
    let checking = false;
    const recheck = setInterval(() => {
      if (checking) return;
      checking = true;
      void authority(grant.spaceId!, grant.generation!, grant.repository.id)
        .catch(() => {
          upstream.destroy();
          response.destroy();
        })
        .finally(() => {
          checking = false;
        });
    }, 1000);
    upstream.once("close", () => {
      clearTimeout(lifetime);
      clearInterval(recheck);
      release();
    });
    upstream.once("timeout", () => upstream.destroy());
    upstream.once("error", () => {
      if (!response.headersSent) response.writeHead(502, { connection: "close" });
      response.end();
    });
    request.on("data", count);
    request.once("aborted", () => upstream.destroy());
    response.once("close", () => upstream.destroy());
    request.pipe(upstream);
  };
}
