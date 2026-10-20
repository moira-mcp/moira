import { request as httpsRequest } from "node:https";
import { request as httpRequest } from "node:http";
import { connect } from "node:net";
import { connectHttps } from "./tls-transport.mjs";
import type { Duplex } from "node:stream";
import {
  WORKSPACE_HEARTBEAT_INTERVAL_MS,
  WORKSPACE_UPGRADE,
} from "@mcp-moira/shared/workspace-transport";

const protocol = WORKSPACE_UPGRADE;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
interface WorkspaceRemoteTransport {
  socketPath: string;
  origin: string;
  credential: string;
  proxy?: string;
  signal?: AbortSignal;
}
export type WorkspaceRemoteOptions = WorkspaceRemoteTransport &
  (
    | { kind?: "workspace"; environmentIdentity: string }
    | { kind: "controller"; connectionId: string }
  );

class WorkspaceAuthorityRefusal extends Error {}

/** Outbound byte transport only. Reconnection never resubmits an operation. */
export function startWorkspaceRemote(options: WorkspaceRemoteOptions) {
  const origin = new URL(options.origin);
  const kind = options.kind ?? "workspace";
  const endpointIdentity =
    options.kind === "controller" ? options.connectionId : options.environmentIdentity;
  if (
    !(kind === "controller" ? uuid.test(endpointIdentity) : /^[a-f0-9]{64}$/.test(endpointIdentity))
  )
    throw new Error("Owner endpoint identity required");
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
  let connected: Duplex | undefined;
  let authorityRefusal: WorkspaceAuthorityRefusal | undefined;
  let state: "connecting" | "connected" | "unavailable" | "refused" = "connecting";
  const readiness = new Set<{ resolve(): void; reject(error: Error): void }>();
  const whenConnected = () => {
    if (authorityRefusal) return Promise.reject(authorityRefusal);
    if (closed) return Promise.reject(new Error("Workspace transport closed before readiness"));
    if (connected && !connected.destroyed) return Promise.resolve();
    return new Promise<void>((resolve, reject) => readiness.add({ resolve, reject }));
  };
  const track = (socket: Duplex) => {
    sockets.add(socket);
    socket.on("error", () => socket.destroy());
    socket.once("close", () => sockets.delete(socket));
    if (closed) socket.destroy();
    return socket;
  };
  const upgrade = async (path: string, controlId?: string): Promise<Duplex> => {
    const socket = track(
      await connectHttps({
        hostname: origin.hostname,
        port: Number(origin.port || 443),
        proxy: options.proxy,
        signal: shutdown.signal,
      }),
    );
    return new Promise((resolve, reject) => {
      const request = httpsRequest({
        hostname: origin.hostname,
        port: Number(origin.port || 443),
        path,
        method: "GET",
        signal: shutdown.signal,
        headers: {
          authorization: `Bearer ${options.credential}`,
          "x-moira-endpoint-kind": kind,
          "x-moira-endpoint-identity": endpointIdentity,
          connection: "Upgrade",
          upgrade: protocol,
          ...(controlId ? { "x-moira-control-id": controlId } : {}),
        },
        createConnection: () => socket,
      });
      request.once("error", () => reject(new Error("Workspace connection failed")));
      request.once("response", (response) => {
        response.resume();
        const message = `Workspace connection refused (${response.statusCode ?? 0})`;
        reject(
          path === "/api/workspaces/connect" &&
            (response.statusCode === 401 || response.statusCode === 403)
            ? new WorkspaceAuthorityRefusal(message)
            : new Error(message),
        );
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
  };
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
    state = "unavailable";
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
          path: kind === "controller" ? "/v1/controller/health" : "/v1/health",
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
              const health = JSON.parse(json) as {
                environmentIdentity?: unknown;
                connectionId?: unknown;
              };
              const measured =
                kind === "controller" ? health.connectionId : health.environmentIdentity;
              if (
                response.statusCode !== 200 ||
                typeof measured !== "string" ||
                !(kind === "controller" ? uuid.test(measured) : /^[a-f0-9]{64}$/.test(measured))
              )
                throw new Error();
              resolve(measured);
            } catch {
              reject(new Error("Workspace life observation refused"));
            }
          });
        },
      );
      request.once("error", reject);
      request.end();
    });
  const retireRefusedAuthority = (error: WorkspaceAuthorityRefusal) => {
    authorityRefusal ??= error;
    state = "refused";
    return close();
  };
  const control = async () => {
    try {
      state = "connecting";
      if ((await measuredLife()) !== endpointIdentity)
        throw new Error("Owner endpoint identity changed; enrollment required");
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
              connected = socket;
              state = "connected";
              for (const waiter of readiness) waiter.resolve();
              readiness.clear();
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
        if (connected === socket) connected = undefined;
        if (heartbeat) clearInterval(heartbeat);
        heartbeat = undefined;
        reconnect();
      });
      socket.resume();
    } catch (error) {
      if (error instanceof WorkspaceAuthorityRefusal) await retireRefusedAuthority(error);
      else reconnect();
    }
  };
  const close = async () => {
    closed = true;
    if (!authorityRefusal) state = "unavailable";
    connected = undefined;
    for (const waiter of readiness)
      waiter.reject(authorityRefusal ?? new Error("Workspace transport closed before readiness"));
    readiness.clear();
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
  return { close, whenConnected, status: () => ({ state }) };
}
