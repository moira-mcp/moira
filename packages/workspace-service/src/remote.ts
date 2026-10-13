import { request as httpsRequest } from "node:https";
import { request as httpRequest } from "node:http";
import { connect as connectTls } from "node:tls";
import { connect, isIP } from "node:net";
import type { Duplex } from "node:stream";
import {
  WORKSPACE_HEARTBEAT_INTERVAL_MS,
  WORKSPACE_UPGRADE,
} from "@mcp-moira/shared/workspace-transport";

const protocol = WORKSPACE_UPGRADE;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export interface WorkspaceRemoteOptions {
  socketPath: string;
  origin: string;
  credential: string;
  environmentIdentity: string;
  proxy?: string;
  signal?: AbortSignal;
}

/** Outbound byte transport only. Reconnection never resubmits an operation. */
export function startWorkspaceRemote(options: WorkspaceRemoteOptions) {
  const origin = new URL(options.origin);
  if (!/^[a-f0-9]{64}$/.test(options.environmentIdentity))
    throw new Error("Workspace measured life required");
  if (
    origin.protocol !== "https:" ||
    origin.username ||
    origin.password ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash
  )
    throw new Error("Workspace origin must be a fixed HTTPS origin");
  const sockets = new Set<Duplex>();
  const shutdown = new AbortController();
  let closed = false;
  let retry: NodeJS.Timeout | undefined;
  let heartbeat: NodeJS.Timeout | undefined;
  const track = (socket: Duplex) => {
    sockets.add(socket);
    socket.on("error", () => socket.destroy());
    socket.once("close", () => sockets.delete(socket));
    if (closed) socket.destroy();
    return socket;
  };
  const tlsSocket = (ready: (error: Error | null, socket?: Duplex) => void) => {
    let delivered = false;
    const finish = (error: Error | null, socket?: Duplex) => {
      if (delivered) {
        socket?.destroy();
        return;
      }
      delivered = true;
      ready(error, socket);
    };
    const target = {
      host: origin.hostname,
      port: Number(origin.port || 443),
      ...(isIP(origin.hostname) ? {} : { servername: origin.hostname }),
      ALPNProtocols: ["http/1.1"],
    };
    const secure = (socket?: Duplex) => {
      const tls = track(connectTls({ ...target, ...(socket ? { socket } : {}) }));
      let returned = false;
      tls.once("error", () => {
        if (!returned) {
          returned = true;
          finish(new Error("Workspace TLS connection failed"));
        }
      });
      tls.once("secureConnect", () => {
        if (!returned) {
          returned = true;
          finish(null, tls);
        }
      });
    };
    if (!options.proxy) return secure();
    const proxy = new URL(options.proxy);
    if (
      proxy.protocol !== "http:" ||
      proxy.hostname !== "127.0.0.1" ||
      proxy.port !== "3437" ||
      !proxy.username ||
      !proxy.password ||
      proxy.pathname !== "/" ||
      proxy.search ||
      proxy.hash
    )
      return finish(new Error("Invalid workspace CONNECT proxy"));
    const request = httpRequest({
      host: proxy.hostname,
      port: Number(proxy.port || 80),
      method: "CONNECT",
      path: `${origin.hostname}:${origin.port || 443}`,
      agent: false,
      signal: shutdown.signal,
      headers: {
        ...(proxy.username || proxy.password
          ? {
              "proxy-authorization": `Basic ${Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString("base64")}`,
            }
          : {}),
      },
    });
    request.once("error", () => finish(new Error("Workspace CONNECT admission failed")));
    request.once("connect", (response, socket, head) => {
      if (response.statusCode !== 200 || head.length) {
        socket.destroy();
        finish(new Error("Workspace CONNECT was refused"));
        return;
      }
      secure(track(socket));
    });
    request.end();
  };
  const upgrade = (path: string, controlId?: string): Promise<Duplex> =>
    new Promise((resolve, reject) => {
      const request = httpsRequest({
        hostname: origin.hostname,
        port: Number(origin.port || 443),
        path,
        method: "GET",
        signal: shutdown.signal,
        headers: {
          authorization: `Bearer ${options.credential}`,
          "x-moira-environment-identity": options.environmentIdentity,
          connection: "Upgrade",
          upgrade: protocol,
          ...(controlId ? { "x-moira-control-id": controlId } : {}),
        },
        createConnection: (_options, ready) => {
          tlsSocket((error, socket) => {
            if (socket) ready(error, socket);
            else
              queueMicrotask(() =>
                request.destroy(error ?? new Error("Workspace TLS connection failed")),
              );
          });
          return undefined;
        },
      });
      request.once("error", () => reject(new Error("Workspace connection failed")));
      request.once("response", (response) => {
        response.resume();
        reject(new Error(`Workspace connection refused (${response.statusCode ?? 0})`));
      });
      request.once("upgrade", (response, socket, head) => {
        if (response.statusCode !== 101 || response.headers.upgrade !== protocol || closed) {
          socket.destroy();
          reject(new Error("Invalid workspace upgrade"));
          return;
        }
        socket.pause();
        if (head.length) socket.unshift(head);
        resolve(track(socket));
      });
      request.end();
    });
  const data = async (callId: string, controlId: string) => {
    const remote = await upgrade(`/api/workspaces/calls/${callId}`, controlId);
    if (closed) return remote.destroy();
    const local = track(connect({ path: options.socketPath }));
    remote.once("close", () => local.destroy());
    local.once("close", () => remote.destroy());
    local.once("connect", () => {
      remote.pipe(local);
      local.pipe(remote);
      remote.resume();
    });
  };
  const reconnect = () => {
    if (closed || retry) return;
    // This reconnects observation transport only; no request payload is retained here.
    retry = setTimeout(() => {
      retry = undefined;
      void control();
    }, 1000);
    retry.unref();
  };
  const measuredLife = () =>
    new Promise<string>((resolve, reject) => {
      const request = httpRequest(
        {
          socketPath: options.socketPath,
          path: "/v1/health",
          agent: false,
          signal: shutdown.signal,
        },
        (response) => {
          let json = "";
          response.on("data", (bytes) => {
            json += String(bytes);
            if (Buffer.byteLength(json) > 4096)
              request.destroy(new Error("Invalid workspace health"));
          });
          response.once("error", reject);
          response.once("end", () => {
            try {
              const health = JSON.parse(json) as { environmentIdentity?: unknown };
              if (
                response.statusCode !== 200 ||
                typeof health.environmentIdentity !== "string" ||
                !/^[a-f0-9]{64}$/.test(health.environmentIdentity)
              )
                throw new Error();
              resolve(health.environmentIdentity);
            } catch {
              reject(new Error("Workspace life observation refused"));
            }
          });
        },
      );
      request.once("error", reject);
      request.end();
    });
  const control = async () => {
    try {
      if ((await measuredLife()) !== options.environmentIdentity)
        throw new Error("Workspace life changed; bootstrap required");
      const socket = await upgrade("/api/workspaces/connect");
      let id: string | undefined;
      let buffered = "";
      socket.on("data", (chunk: Buffer) => {
        buffered += chunk.toString("utf8");
        let end;
        while ((end = buffered.indexOf("\n")) >= 0) {
          const line = buffered.slice(0, end);
          buffered = buffered.slice(end + 1);
          if (Buffer.byteLength(line) > 4096) return socket.destroy();
          try {
            const value: unknown = JSON.parse(line);
            if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
            const message = value as Record<string, unknown>;
            if (Object.keys(message).length !== 1) throw new Error();
            if (
              typeof message.connectionId === "string" &&
              uuid.test(message.connectionId) &&
              !id
            ) {
              id = message.connectionId;
              heartbeat = setInterval(
                () => socket.write('{"ping":true}\n'),
                WORKSPACE_HEARTBEAT_INTERVAL_MS,
              );
              heartbeat.unref();
            } else if (typeof message.callId === "string" && uuid.test(message.callId) && id) {
              // Failed rendezvous closes its control epoch: the cloud rejects pending calls,
              // and reconnect never repeats their payloads. Existing core jobs remain alive.
              void data(message.callId, id).catch(() => socket.destroy());
            } else if (message.pong !== true) throw new Error();
          } catch {
            socket.destroy();
          }
        }
        if (Buffer.byteLength(buffered) > 4096) socket.destroy();
      });
      socket.once("close", () => {
        if (heartbeat) clearInterval(heartbeat);
        heartbeat = undefined;
        reconnect();
      });
      socket.resume();
    } catch {
      reconnect();
    }
  };
  const close = async () => {
    closed = true;
    shutdown.abort();
    if (retry) clearTimeout(retry);
    if (heartbeat) clearInterval(heartbeat);
    options.signal?.removeEventListener("abort", close);
    await Promise.all(
      [...sockets].map(
        (socket) =>
          new Promise<void>((resolve) => {
            socket.once("close", resolve);
            socket.destroy();
          }),
      ),
    );
  };
  options.signal?.addEventListener("abort", close, { once: true });
  if (options.signal?.aborted) void close();
  else void control();
  return { close };
}
