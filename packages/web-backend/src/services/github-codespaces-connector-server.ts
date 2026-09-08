import { execFile, spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, unlink } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { connect, createServer as createNetServer } from "node:net";
import { dirname } from "node:path";
import {
  CONNECTOR_MAX_REQUEST_BYTES,
  CONNECTOR_MAX_RESPONSE_BYTES,
  decodeConnectorRequest,
  encodeConnectorRequest,
  encodeConnectorResponse,
  validGitHubUserCredential,
} from "./github-codespaces-connector-protocol.mjs";

const SOCKET_PATH = "/run/moira-workspace-connector/connector.sock";
const WORKER_PATH = "/app/packages/web-backend/src/services/github-codespaces-connector-worker.ts";
const SUPERVISOR_PATH =
  "/app/packages/web-backend/src/services/github-codespaces-remote-supervisor.mjs";
const WORKER_UID = 1000;
const WORKER_GID = 1000;
const RESOURCE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const EGRESS_SOCKET_PATH = "/run/moira-workspace-egress/proxy.sock";
const LOCAL_PROXY_PORT = 18080;
let ready = false;

interface ConnectorRequest {
  action: "ssh-config" | "operation";
  resourceName: string;
  token: string;
  job?: Record<string, unknown>;
}

function respond(response: ServerResponse, status: number, value: unknown): void {
  const body = encodeConnectorResponse(value);
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": body.length,
    "cache-control": "no-store",
  });
  response.end(body);
}

async function readJson(request: IncomingMessage): Promise<ConnectorRequest> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const value = Buffer.from(chunk);
    bytes += value.length;
    if (bytes > CONNECTOR_MAX_REQUEST_BYTES) throw new Error("request too large");
    chunks.push(value);
  }
  const value = decodeConnectorRequest(Buffer.concat(chunks)) as Partial<ConnectorRequest>;
  if (
    !["ssh-config", "operation"].includes(value.action ?? "") ||
    !RESOURCE.test(value.resourceName ?? "") ||
    !validGitHubUserCredential(value.token)
  ) {
    throw new Error("invalid connector request");
  }
  return value as ConnectorRequest;
}

function command(executable: string, argv: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      executable,
      argv,
      {
        timeout: 30_000,
        maxBuffer: 64 * 1024,
        encoding: "utf8",
        env: { HOME: "/tmp", PATH: "/usr/local/bin:/usr/bin:/bin", LANG: "C.UTF-8" },
      },
      (error, stdout, stderr) => resolve(error ? null : `${stdout}\n${stderr}`),
    );
  });
}

function workerHealth(): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      "/usr/bin/prlimit",
      [
        "--nproc=64:64",
        "--fsize=16777216:16777216",
        "--nofile=128:128",
        "--",
        "/usr/local/bin/node",
        "--experimental-strip-types",
        WORKER_PATH,
        "health",
      ],
      {
        timeout: 30_000,
        maxBuffer: 64 * 1024,
        encoding: "utf8",
        env: { HOME: "/tmp", PATH: "/usr/local/bin:/usr/bin:/bin", LANG: "C.UTF-8" },
      },
      (error, stdout) => resolve(error ? null : stdout),
    );
  });
}

async function connectorHealth(): Promise<boolean> {
  const [worker, gh, ssh, prlimit] = await Promise.all([
    workerHealth(),
    command("/usr/bin/gh", ["--version"]),
    command("/usr/bin/ssh", ["-V"]),
    command("/usr/bin/prlimit", ["--version"]),
  ]);
  return Boolean(
    worker?.includes(`uid=${WORKER_UID} gid=${WORKER_GID}`) &&
    gh?.includes("gh version 2.97.") &&
    ssh?.includes("OpenSSH_10.3") &&
    prlimit?.includes("util-linux"),
  );
}

async function runWorker(input: ConnectorRequest): Promise<string> {
  const home = await mkdtemp("/tmp/moira-codespaces-connector-");
  try {
    return await new Promise((resolve, reject) => {
      const child = spawn(
        "/usr/bin/prlimit",
        [
          "--nproc=64:64",
          "--fsize=16777216:16777216",
          "--nofile=128:128",
          "--",
          "/usr/local/bin/node",
          "--experimental-strip-types",
          WORKER_PATH,
          input.action,
          input.resourceName,
        ],
        {
          env: {
            ...process.env,
            HOME: home,
            PATH: "/usr/local/bin:/usr/bin:/bin",
            LANG: "C.UTF-8",
            LC_ALL: "C.UTF-8",
          },
          detached: true,
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
      const stdout: Buffer[] = [];
      let bytes = 0;
      let settled = false;
      const finish = (error?: Error, value?: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (error) reject(error);
        else resolve(value ?? "");
      };
      const killGroup = () => {
        try {
          process.kill(-child.pid!, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      };
      const timeout = setTimeout(
        () => {
          killGroup();
          finish(new Error("worker timeout"));
        },
        Math.min(17 * 60_000, Number(input.job?.timeoutMs ?? 30_000) + 120_000),
      );
      timeout.unref();
      child.stdout.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > CONNECTOR_MAX_RESPONSE_BYTES) {
          killGroup();
          finish(new Error("worker output too large"));
        } else stdout.push(Buffer.from(chunk));
      });
      child.stderr.resume();
      child.once("error", (error) => finish(error));
      child.once("close", (code) =>
        code === 0
          ? finish(undefined, Buffer.concat(stdout).toString("utf8"))
          : finish(new Error("worker failed")),
      );
      child.stdin.end(
        encodeConnectorRequest({
          token: input.token,
          home,
          supervisorPath: SUPERVISOR_PATH,
          job: input.job,
        }),
      );
    });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

async function route(request: IncomingMessage, response: ServerResponse): Promise<void> {
  if (request.method === "GET" && request.url === "/health") {
    const available = ready && (await egressAvailable());
    respond(response, available ? 200 : 503, {
      state: available ? "available" : "unavailable",
      reason: available ? null : "connector or egress unavailable",
    });
    return;
  }
  if (!ready || request.method !== "POST" || request.url !== "/job") {
    respond(response, ready ? 404 : 503, {
      error: ready ? "not found" : "connector starting",
    });
    return;
  }
  try {
    respond(response, 200, { value: await runWorker(await readJson(request)) });
  } catch {
    respond(response, 503, { error: "connector unavailable" });
  }
}

function egressAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect(EGRESS_SOCKET_PATH);
    const timeout = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, 1_000);
    timeout.unref();
    socket.once("connect", () => {
      clearTimeout(timeout);
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => {
      clearTimeout(timeout);
      resolve(false);
    });
  });
}

async function main(): Promise<void> {
  await mkdir(dirname(SOCKET_PATH), { recursive: true });
  await unlink(SOCKET_PATH).catch(() => undefined);
  const server = createServer((request, response) => void route(request, response));
  const egressBridge = createNetServer((client) => {
    const upstream = connect(EGRESS_SOCKET_PATH);
    client.pipe(upstream);
    upstream.pipe(client);
    client.once("error", () => upstream.destroy());
    upstream.once("error", () => client.destroy());
  });
  egressBridge.listen(LOCAL_PROXY_PORT, "127.0.0.1");
  server.listen(SOCKET_PATH, async () => {
    await chmod(SOCKET_PATH, 0o660);
    if (typeof process.setgid !== "function" || typeof process.setuid !== "function") {
      throw new Error("connector privilege drop unavailable");
    }
    process.setgid(WORKER_GID);
    process.setuid(WORKER_UID);
    ready = await connectorHealth();
    if (!ready) throw new Error("connector health failed");
    process.stdout.write("workspace-connector-ready\n");
  });
}

void main();
