import { randomUUID } from "node:crypto";
import {
  createServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
} from "node:http";
import { mkdir, chmod, lstat, unlink } from "node:fs/promises";
import { lstatSync, unlinkSync } from "node:fs";
import { connect as connectUnix } from "node:net";
import { once, EventEmitter } from "node:events";
import { dirname } from "node:path";
import type { Duplex, Readable } from "node:stream";
import { CodespaceResourceError } from "@mcp-moira/shared/codespace-resource-types";
import {
  WORKSPACE_HEARTBEAT_INTERVAL_MS,
  WORKSPACE_UPGRADE,
  type WorkspaceEndpointKind,
} from "@mcp-moira/shared/workspace-transport";

export { WORKSPACE_UPGRADE };
interface WorkspacePrincipal {
  userId: string;
  resourceId: string;
  resourceGeneration: number;
  authorizationGeneration: number;
  expiresAt?: number | null;
}
export type WorkspaceBinding = WorkspacePrincipal &
  (
    | { kind: "workspace"; environmentIdentity: string }
    | { kind: "controller"; connectionId: string }
  );
export interface WorkspaceRequest {
  method: string;
  path: string;
  headers?: IncomingHttpHeaders;
  body?: Uint8Array | AsyncIterable<Uint8Array>;
}
export interface WorkspaceResponse {
  statusCode: number;
  headers: IncomingHttpHeaders;
  body: Readable;
}
export interface WorkspaceClient {
  request(
    userId: string,
    resourceId: string,
    input: WorkspaceRequest,
    signal?: AbortSignal,
  ): Promise<WorkspaceResponse>;
  json(
    userId: string,
    resourceId: string,
    input: Omit<WorkspaceRequest, "body"> & { body?: unknown },
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>>;
}
interface Connection {
  id: string;
  binding: WorkspaceBinding;
  socket: Duplex;
  data: Set<Duplex>;
  closed: boolean;
  authorityTimer?: NodeJS.Timeout;
  expiryTimer?: NodeJS.Timeout;
  checking?: Promise<boolean>;
}
interface Pending {
  connection: Connection;
  resolve(socket: Duplex): void;
  reject(error: Error): void;
}
const key = (binding: WorkspaceBinding) =>
  `${binding.kind}:${binding.userId}:${binding.resourceId}`;
const endpointIdentity = (binding: WorkspaceBinding) =>
  binding.kind === "workspace" ? binding.environmentIdentity : binding.connectionId;
const identity = (binding: WorkspaceBinding) =>
  JSON.stringify([
    binding.userId,
    binding.kind,
    binding.resourceId,
    binding.resourceGeneration,
    binding.authorizationGeneration,
    endpointIdentity(binding),
  ]);
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

/** Live rendezvous only. No command, payload or result is persisted here. */
export class WorkspaceRouter extends EventEmitter {
  private readonly connections = new Map<string, Connection>();
  private readonly pending = new Map<string, Pending>();
  private privateServer?: Server;
  private privatePath?: string;
  private privateIdentity?: { dev: number; ino: number };
  private publicServer?: Server;
  constructor(
    private readonly authority: {
      credential(value: string): Promise<WorkspaceBinding>;
      request(
        userId: string,
        resourceId: string,
        signal?: AbortSignal,
        kind?: WorkspaceEndpointKind,
      ): Promise<WorkspaceBinding>;
    },
  ) {
    super();
  }

  private disconnect(connection: Connection): void {
    connection.closed = true;
    clearTimeout(connection.authorityTimer);
    clearTimeout(connection.expiryTimer);
    if (this.connections.get(key(connection.binding)) === connection)
      this.connections.delete(key(connection.binding));
    for (const [id, pending] of this.pending)
      if (pending.connection === connection) {
        this.pending.delete(id);
        pending.reject(
          new CodespaceResourceError(
            "CODESPACE_PROVIDER_UNAVAILABLE",
            "Workspace connection ended before dispatch",
          ),
        );
      }
    for (const socket of connection.data) socket.destroy();
    connection.socket.destroy();
  }

  private updateExpiry(connection: Connection, expiresAt: number | null | undefined): boolean {
    clearTimeout(connection.expiryTimer);
    connection.expiryTimer = undefined;
    if (expiresAt === null || expiresAt === undefined) return true;
    if (!Number.isSafeInteger(expiresAt) || expiresAt <= Date.now()) {
      this.disconnect(connection);
      return false;
    }
    const expire = () => {
      if (connection.closed) return;
      const remaining = expiresAt - Date.now();
      if (remaining <= 0) this.disconnect(connection);
      else {
        connection.expiryTimer = setTimeout(expire, Math.min(remaining, 2147483647));
        connection.expiryTimer.unref();
      }
    };
    expire();
    return true;
  }

  private revalidate(connection: Connection, token: string): Promise<boolean> {
    if (connection.closed) return Promise.resolve(false);
    if (connection.checking) return connection.checking;
    const checking = (async () => {
      try {
        const current = await this.authority.credential(token);
        if (connection.closed) return false;
        if (identity(current) !== identity(connection.binding)) {
          this.disconnect(connection);
          return false;
        }
        return this.updateExpiry(connection, current.expiresAt);
      } catch {
        this.disconnect(connection);
        return false;
      }
    })().finally(() => {
      if (connection.checking === checking) connection.checking = undefined;
    });
    connection.checking = checking;
    return checking;
  }

  private observeAuthority(connection: Connection, token: string): void {
    if (connection.closed) return;
    connection.authorityTimer = setTimeout(() => {
      connection.authorityTimer = undefined;
      void this.revalidate(connection, token).then(() => this.observeAuthority(connection, token));
    }, WORKSPACE_HEARTBEAT_INTERVAL_MS);
    connection.authorityTimer.unref();
  }

  private readonly upgrade = (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    socket.pause();
    socket.once("error", () => socket.destroy());
    void this.accept(request, socket, head).catch(() => {
      if (!socket.destroyed)
        socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
    });
  };

  private async accept(request: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    if (
      request.method !== "GET" ||
      request.headers.upgrade !== WORKSPACE_UPGRADE ||
      request.headers.origin ||
      !String(request.headers.connection)
        .toLowerCase()
        .split(/\s*,\s*/)
        .includes("upgrade")
    )
      throw new Error("Invalid workspace handshake");
    const path = request.url ?? "";
    const call = /^\/api\/workspaces\/calls\/([a-f0-9-]{36})$/.exec(path);
    if (path !== "/api/workspaces/connect" && !call) throw new Error("Unknown workspace endpoint");
    const token = /^Bearer ([A-Za-z0-9_.-]{1,4096})$/.exec(
      String(request.headers.authorization ?? ""),
    )?.[1];
    if (!token) throw new Error("Workspace credential required");
    const binding = await this.authority.credential(token);
    if (
      request.headers["x-moira-endpoint-kind"] !== binding.kind ||
      request.headers["x-moira-endpoint-identity"] !== endpointIdentity(binding)
    )
      throw new Error("Owner endpoint identity changed");
    if (socket.destroyed) return;
    if (call) {
      const pending = this.pending.get(call[1]);
      if (
        !pending ||
        !uuid.test(String(request.headers["x-moira-control-id"])) ||
        pending.connection.id !== request.headers["x-moira-control-id"] ||
        identity(pending.connection.binding) !== identity(binding) ||
        this.connections.get(key(binding)) !== pending.connection
      )
        throw new Error("Workspace rendezvous changed");
      this.pending.delete(call[1]);
      pending.connection.data.add(socket);
      socket.once("close", () => pending.connection.data.delete(socket));
      socket.write(
        `HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: ${WORKSPACE_UPGRADE}\r\n\r\n`,
      );
      if (head.length) socket.unshift(head);
      pending.resolve(socket);
      return;
    }
    if (head.length) throw new Error("Control handshake cannot contain data");
    const previous = this.connections.get(key(binding));
    if (previous) this.disconnect(previous);
    const connection: Connection = {
      id: randomUUID(),
      binding,
      socket,
      data: new Set(),
      closed: false,
    };
    this.connections.set(key(binding), connection);
    if (!this.updateExpiry(connection, binding.expiresAt)) return;
    this.observeAuthority(connection, token);
    this.emit("connected", binding);
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: ${WORKSPACE_UPGRADE}\r\n\r\n`,
    );
    socket.write(`${JSON.stringify({ connectionId: connection.id })}\n`);
    let buffered = "";
    socket.on("data", (chunk: Buffer) => {
      buffered += chunk.toString("utf8");
      let end;
      while ((end = buffered.indexOf("\n")) >= 0) {
        const line = buffered.slice(0, end);
        buffered = buffered.slice(end + 1);
        if (Buffer.byteLength(line) > 4096) return this.disconnect(connection);
        if (line !== '{"ping":true}') return this.disconnect(connection);
        void this.revalidate(connection, token).then((valid) => {
          if (valid && !connection.closed) socket.write('{"pong":true}\n');
        });
      }
      if (Buffer.byteLength(buffered) > 4096) this.disconnect(connection);
    });
    socket.once("error", () => this.disconnect(connection));
    socket.once("close", () => this.disconnect(connection));
    socket.resume();
  }

  attach(server: Server): void {
    if (this.publicServer) throw new Error("Workspace router is already attached");
    this.publicServer = server;
    server.on("upgrade", this.upgrade);
  }
  isConnected(binding: WorkspaceBinding): boolean {
    const current = this.connections.get(key(binding));
    return (
      !!current && !current.socket.destroyed && identity(current.binding) === identity(binding)
    );
  }
  waitForConnection(binding: WorkspaceBinding, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    if (this.isConnected(binding)) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const clean = () => {
        this.off("connected", connected);
        this.off("closed", aborted);
        signal?.removeEventListener("abort", aborted);
      };
      const connected = (current: WorkspaceBinding) => {
        if (identity(current) === identity(binding)) {
          clean();
          resolve();
        }
      };
      const aborted = () => {
        clean();
        reject(new Error("Workspace observation cancelled before dispatch"));
      };
      this.on("connected", connected);
      this.once("closed", aborted);
      signal?.addEventListener("abort", aborted, { once: true });
    });
  }

  async request(
    userId: string,
    resourceId: string,
    input: WorkspaceRequest,
    signal?: AbortSignal,
    kind: WorkspaceEndpointKind = "workspace",
  ): Promise<WorkspaceResponse> {
    signal?.throwIfAborted();
    if (
      !/^[A-Z]+$/.test(input.method) ||
      !input.path.startsWith("/v1/") ||
      input.path.includes("\r") ||
      input.path.includes("\n")
    )
      throw new CodespaceResourceError("CODESPACE_RESOURCE_INVALID", "Invalid workspace request");
    const binding = await this.requestAuthority(userId, resourceId, signal, kind);
    const connection = this.connections.get(key(binding));
    if (!connection || identity(connection.binding) !== identity(binding))
      throw new CodespaceResourceError(
        "CODESPACE_PROVIDER_UNAVAILABLE",
        "Workspace service is offline; no request was dispatched",
      );
    const callId = randomUUID();
    const socket = await new Promise<Duplex>((resolve, reject) => {
      const abort = () => {
        this.pending.delete(callId);
        reject(
          signal?.reason instanceof Error
            ? signal.reason
            : new Error("Workspace call cancelled before dispatch"),
        );
      };
      const pending: Pending = {
        connection,
        resolve: (value) => {
          signal?.removeEventListener("abort", abort);
          resolve(value);
        },
        reject: (error) => {
          signal?.removeEventListener("abort", abort);
          reject(error);
        },
      };
      this.pending.set(callId, pending);
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) return abort();
      connection.socket.write(`${JSON.stringify({ callId })}\n`, (error) => {
        if (error) {
          this.pending.delete(callId);
          pending.reject(
            new CodespaceResourceError(
              "CODESPACE_PROVIDER_UNAVAILABLE",
              "Workspace control contact failed before dispatch",
            ),
          );
        }
      });
    });
    // Authentication can change while the agent is opening its data connection.
    try {
      const current = await this.requestAuthority(userId, resourceId, signal, kind);
      if (
        identity(current) !== identity(binding) ||
        this.connections.get(key(binding)) !== connection
      )
        throw new CodespaceResourceError(
          "CODESPACE_GENERATION_CONFLICT",
          "Workspace authority changed before dispatch",
        );
    } catch (error) {
      socket.destroy();
      throw error;
    }
    const headers = { ...input.headers };
    for (const name of [
      "x-moira-user-id",
      "x-moira-device-id",
      "x-moira-device-generation",
      "x-moira-connection-id",
      "x-moira-endpoint-kind",
      "x-moira-endpoint-identity",
    ])
      delete headers[name];
    if (binding.kind === "controller") {
      headers["x-moira-user-id"] = binding.userId;
      headers["x-moira-device-id"] = binding.resourceId;
      headers["x-moira-device-generation"] = String(binding.resourceGeneration);
      headers["x-moira-connection-id"] = binding.connectionId;
    }
    return sendHttp({ ...input, headers }, signal, (ready) => ready(null, socket));
  }

  private async requestAuthority(
    userId: string,
    resourceId: string,
    signal?: AbortSignal,
    kind: WorkspaceEndpointKind = "workspace",
  ) {
    try {
      const binding = await this.authority.request(userId, resourceId, signal, kind);
      if (binding.kind !== kind)
        throw new CodespaceResourceError(
          "CODESPACE_AUTHORIZATION_REQUIRED",
          "Owner endpoint kind does not match its authority",
        );
      return binding;
    } catch (error) {
      if (error instanceof CodespaceResourceError || signal?.aborted) throw error;
      throw new CodespaceResourceError(
        "CODESPACE_PROVIDER_UNAVAILABLE",
        "Workspace readiness failed before dispatch",
      );
    }
  }

  async listenPrivate(socketPath: string): Promise<void> {
    await mkdir(dirname(socketPath), { recursive: true, mode: 0o700 });
    const parent = await lstat(dirname(socketPath));
    if (
      !parent.isDirectory() ||
      parent.isSymbolicLink() ||
      parent.uid !== process.getuid?.() ||
      parent.mode & 0o077
    )
      throw new Error("Unsafe workspace router directory");
    let existing;
    try {
      existing = await lstat(socketPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (existing) {
      if (!existing.isSocket() || existing.uid !== process.getuid?.() || existing.mode & 0o077)
        throw new Error("Unsafe workspace router endpoint");
      await new Promise<void>((resolve, reject) => {
        const probe = connectUnix(socketPath);
        probe.once("connect", () => {
          probe.destroy();
          reject(new Error("Workspace router already owns this endpoint"));
        });
        probe.once("error", (error) => {
          if ((error as NodeJS.ErrnoException).code !== "ECONNREFUSED") return reject(error);
          try {
            const current = lstatSync(socketPath);
            if (current.dev !== existing.dev || current.ino !== existing.ino)
              throw new Error("Workspace endpoint changed");
            unlinkSync(socketPath);
            resolve();
          } catch (error) {
            reject(error);
          }
        });
      });
    }
    this.privateServer = createServer((request, response) => {
      const controller = new AbortController();
      const abort = () => controller.abort();
      request.once("aborted", abort);
      response.once("close", abort);
      void (async () => {
        const userId = request.headers["x-moira-user-id"],
          resourceId = request.headers["x-moira-resource-id"];
        if (typeof userId !== "string" || typeof resourceId !== "string")
          throw new CodespaceResourceError(
            "CODESPACE_AUTHORIZATION_REQUIRED",
            "Workspace principal required",
          );
        const headers = { ...request.headers };
        const kind = headers["x-moira-endpoint-kind"] ?? "workspace";
        if (kind !== "workspace" && kind !== "controller")
          throw new CodespaceResourceError(
            "CODESPACE_RESOURCE_INVALID",
            "Invalid owner endpoint kind",
          );
        delete headers["x-moira-user-id"];
        delete headers["x-moira-resource-id"];
        const result = await this.request(
          userId,
          resourceId,
          { method: request.method ?? "GET", path: request.url ?? "", headers, body: request },
          controller.signal,
          kind,
        );
        response.writeHead(result.statusCode, result.headers);
        result.body.once("error", () => response.destroy());
        response.once("close", () => result.body.destroy());
        result.body.pipe(response);
      })()
        .catch((error: unknown) => {
          if (!response.headersSent)
            response.writeHead(503, { "content-type": "application/json" });
          response.end(
            JSON.stringify({
              error: {
                code:
                  error instanceof CodespaceResourceError
                    ? error.code
                    : "WORKSPACE_OUTCOME_UNKNOWN",
              },
            }),
          );
        })
        .finally(() => request.off("aborted", abort));
    });
    // Authenticated raw streams belong to their caller/credential and socket closure,
    // rather than Node's default whole-request body deadline.
    this.privateServer.requestTimeout = 0;
    this.privateServer.timeout = 0;
    await new Promise<void>((resolve, reject) => {
      this.privateServer!.once("error", reject);
      this.privateServer!.listen(socketPath, resolve);
    });
    this.privatePath = socketPath;
    await chmod(socketPath, 0o600);
    const owned = await lstat(socketPath);
    this.privateIdentity = { dev: owned.dev, ino: owned.ino };
  }

  async close(): Promise<void> {
    this.emit("closed");
    this.publicServer?.off("upgrade", this.upgrade);
    for (const connection of this.connections.values()) this.disconnect(connection);
    this.privateServer?.closeAllConnections();
    if (this.privateServer)
      await new Promise<void>((resolve, reject) =>
        this.privateServer!.close((error) => (error ? reject(error) : resolve())),
      );
    if (this.privatePath && this.privateIdentity) {
      try {
        const current = await lstat(this.privatePath);
        if (current.dev === this.privateIdentity.dev && current.ino === this.privateIdentity.ino)
          await unlink(this.privatePath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  }
}

export function sendHttp(
  input: WorkspaceRequest,
  signal: AbortSignal | undefined,
  connect: (ready: (error: Error | null, socket: Duplex) => void) => void,
): Promise<WorkspaceResponse> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        method: input.method,
        path: input.path,
        host: "workspace",
        signal,
        headers: { ...input.headers, connection: "close" },
        createConnection: (_options, ready) => {
          connect(ready);
          return undefined;
        },
      },
      (response) =>
        resolve({
          statusCode: response.statusCode ?? 502,
          headers: response.headers,
          body: response,
        }),
    );
    // Upgrade sockets arrive explicitly paused. ClientRequest has installed its HTTP
    // parser before this event, so resume now without losing the handshake's head bytes.
    request.once("socket", (socket) => socket.resume());
    request.once("error", reject);
    void (async () => {
      try {
        if (input.body && Symbol.asyncIterator in Object(input.body)) {
          for await (const bytes of input.body as AsyncIterable<Uint8Array>) {
            if (!request.write(bytes)) await once(request, "drain");
          }
        } else if (input.body) request.write(input.body);
        request.end();
      } catch {
        request.destroy(new Error("Workspace request stream ended before completion"));
      }
    })();
  });
}

export async function jsonResponse(response: WorkspaceResponse): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of response.body) {
    chunks.push(Buffer.from(chunk));
  }
  const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid workspace metadata reply");
  if (response.statusCode >= 400) {
    const error = new Error(`Workspace request refused (${response.statusCode})`);
    Object.assign(error, { statusCode: response.statusCode, details: value });
    throw error;
  }
  return value as Record<string, unknown>;
}
