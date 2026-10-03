import { httpBroker } from "./http-broker.js";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { connect, type Socket } from "node:net";
import type { Duplex } from "node:stream";
import type { LocalPolicy, LocalRepository } from "./policy.js";
import { resolvePublicTarget, type ResolveHost, type ResolvedTarget } from "./network.js";
import { NetworkBudget } from "./network-budget.js";

export interface BrokerGrant {
  repository: LocalRepository;
  policy: LocalPolicy;
  /** Read only by the Git request broker; never used for CONNECT. */
  gitCredential: string | null;
}
export type AuthorizeBroker = (credential: string) => Promise<BrokerGrant | null>;
export interface BrokerOptions {
  authorize: AuthorizeBroker;
  budget: NetworkBudget;
  resolve?: ResolveHost;
  dial?: (target: ResolvedTarget, port: number) => Socket;
  git: (request: IncomingMessage, response: ServerResponse, grant: BrokerGrant) => Promise<void>;
  onFault: (error: unknown) => void;
}

function deny(socket: Duplex, status = "403 Forbidden"): void {
  if (!socket.destroyed)
    socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

/** A loopback-only, authenticated broker, not a general-purpose host proxy. */
export async function startBroker(options: BrokerOptions, port = 0) {
  const sockets = new Set<Socket>();
  const active = new Map<Duplex, string>();
  const authorize = (request: IncomingMessage, proxy: boolean) => {
    const header = request.headers[proxy ? "proxy-authorization" : "authorization"];
    return typeof header === "string" && header.length < 512
      ? options.authorize(header)
      : Promise.resolve(null);
  };
  const server = createServer(
    { maxHeaderSize: 8192, requestTimeout: 120_000, headersTimeout: 5000 },
    (request, response) => {
      void (async () => {
        const proxy = request.url?.startsWith("http://") ?? false;
        const grant = await authorize(request, proxy);
        if (
          !grant &&
          !request.headers.authorization &&
          !request.headers.origin &&
          request.url?.startsWith("/git/")
        ) {
          response.writeHead(401, {
            "www-authenticate": 'Basic realm="Moira Local Git"',
            connection: "close",
          });
          response.end();
          return;
        }
        if (!grant || request.headers.origin) {
          response.writeHead(403, { connection: "close" });
          response.end();
          return;
        }
        // Fixed Git operations and approved public HTTP downloads have separate handlers.
        if (proxy)
          await httpBroker(options.budget, options.onFault, options.resolve)(
            request,
            response,
            grant,
          );
        else await options.git(request, response, grant);
      })().catch((error) => {
        if (!response.headersSent) response.writeHead(502, { connection: "close" });
        response.end();
        if (!(error instanceof Error)) options.onFault(error);
      });
    },
  );
  server.keepAliveTimeout = 1000;
  server.maxRequestsPerSocket = 16;
  server.maxConnections = 128;
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.on("error", () => socket.destroy());
  });
  server.on("clientError", (_error, socket) => deny(socket, "400 Bad Request"));
  server.on("connect", (request, client, head) => {
    void (async () => {
      const match = /^([a-z0-9.-]+):443$/.exec(request.url ?? "");
      const grant = await authorize(request, true);
      if (!match || !grant || request.headers.origin || head.length > 8192) {
        deny(client);
        return;
      }
      const reservation = await options.budget.reserve(grant.policy);
      let used = 0;
      let upstream: Socket | undefined;
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        active.delete(client);
        upstream?.destroy();
        void reservation.release(used).catch(options.onFault);
      };
      client.once("close", release);
      client.once("error", release);
      const lifetime = setTimeout(
        () => client.destroy(),
        Math.max(1, Math.min(120_000, grant.policy.leaseUntil - Date.now())),
      );
      client.once("close", () => clearTimeout(lifetime));
      const count = (chunk: Buffer) => {
        used += chunk.length;
        if (used > reservation.maximumBytes) client.destroy();
      };
      const credential = String(request.headers["proxy-authorization"]);
      active.set(client, credential);
      try {
        const target = await resolvePublicTarget(
          match[1],
          grant.repository.domains,
          options.resolve,
        );
        if (client.destroyed) {
          release();
          return;
        }
        upstream = (
          options.dial ??
          ((peer, targetPort) =>
            connect({ host: peer.address, port: targetPort, family: peer.family }))
        )(target, 443);
        let established = false;
        upstream.setTimeout(15_000, () => client.destroy());
        upstream.once("connect", () => {
          if (!upstream || client.destroyed) {
            release();
            return;
          }
          if (
            upstream.remoteAddress !== target.address &&
            upstream.remoteAddress !== `::ffff:${target.address}`
          ) {
            deny(client, "502 Bad Gateway");
            release();
            return;
          }
          established = true;
          client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
          count(head);
          if (client.destroyed) return;
          if (head.length) upstream.write(head);
          client.on("data", count);
          upstream.on("data", count);
          client.pipe(upstream);
          upstream.pipe(client);
        });
        upstream.once("error", () => {
          if (established) client.destroy();
          else deny(client, "502 Bad Gateway");
          release();
        });
        upstream.once("close", () => client.destroy());
      } catch {
        deny(client, "502 Bad Gateway");
        release();
      }
    })().catch(() => deny(client));
  });
  const sweep = setInterval(() => {
    for (const [socket, credential] of active) {
      void options.authorize(credential).then(
        (grant) => {
          if (!grant) socket.destroy();
        },
        () => socket.destroy(),
      );
    }
  }, 2000);
  sweep.unref();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Broker did not bind loopback");
  return {
    port: address.port,
    close: () =>
      new Promise<void>((resolve, reject) => {
        clearInterval(sweep);
        for (const socket of sockets) socket.destroy();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
