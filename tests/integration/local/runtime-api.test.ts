import { afterEach, beforeEach, expect, test } from "@jest/globals";
import { createServer, type Server } from "node:http";
import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { Readable, Writable, type Duplex } from "node:stream";
import { build } from "esbuild";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { runProcess } from "../../../packages/local/src/process.js";
import { GUEST_WORKER_COMMAND } from "../../../packages/local/src/assets.js";
import {
  createWithoutGateway,
  attachFixedGuest,
  readContainerIdentity,
  startWithoutGateway,
} from "../../../packages/local/src/runtime-api.js";

let home: string;
let server: Server;
const namespace = "moira-0123456789abcd";
const name = `moira-${"a".repeat(32)}`;
const profile = {
  name,
  template: `docker.io/library/debian@sha256:${"a".repeat(64)}`,
  cpuCores: 2,
  memoryBytes: 2 * 1024 ** 3,
  dockerBytes: 4 * 1024 ** 3,
};
let socket: string;
let upgradedPeers: Set<Duplex>;

beforeEach(async () => {
  upgradedPeers = new Set();
  home = await realpath(await mkdtemp("/tmp/ml-api-"));
  const directory = join(home, ".sbx", `run_${namespace}`, "d");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  socket = join(directory, "sandboxd.sock");
});
afterEach(async () => {
  for (const peer of upgradedPeers) peer.destroy();
  server?.closeAllConnections();
  if (server?.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(home, { recursive: true, force: true });
});
async function listen() {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socket, resolve);
  });
}

const container = {
  Id: "c".repeat(64),
  Names: [`/${name}`],
  Labels: { "com.docker.sandbox.name": name, "com.docker.sdk": "true", "docker/sandbox": "true" },
  State: "exited",
};

const execId = "e".repeat(64);
function frame(stream: number, data: Buffer): Buffer {
  const header = Buffer.alloc(8);
  header[0] = stream;
  header.writeUInt32BE(data.length, 4);
  return Buffer.concat([header, data]);
}
function output() {
  const chunks: Buffer[] = [];
  const stream = new Writable({
    highWaterMark: 1,
    write(chunk: Buffer, _encoding, done) {
      chunks.push(Buffer.from(chunk));
      done();
    },
  });
  return { stream, bytes: () => Buffer.concat(chunks) };
}
async function execServer(
  options: { truncated?: boolean; inspect?: object; badHeader?: boolean; held?: boolean } = {},
) {
  let input = Buffer.alloc(0);
  let running = true;
  let entered!: () => void;
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  server = createServer((request, response) => {
    if (request.method !== "GET" || request.url !== `/sandbox/${name}/exec/${execId}`) {
      response.writeHead(404).end();
      return;
    }
    response
      .writeHead(200)
      .end(JSON.stringify(options.inspect ?? { id: execId, running: false, exit_code: 7 }));
  });
  server.on("upgrade", (request, peer, head) => {
    upgradedPeers.add(peer);
    peer.once("close", () => upgradedPeers.delete(peer));
    peer.allowHalfOpen = true;
    const body = JSON.parse(head.toString());
    if (
      request.method !== "POST" ||
      request.url !== `/sandbox/${name}/exec/attach` ||
      JSON.stringify(body) !== JSON.stringify({ cmd: GUEST_WORKER_COMMAND, env: {}, tty: false })
    ) {
      peer.destroy();
      return;
    }
    peer.write(
      `HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: tcp\r\nContent-Type: application/vnd.docker.raw-stream\r\nSandboxes-Exec-Id: ${options.badHeader ? "invalid" : execId}\r\n\r\n`,
    );
    entered();
    peer.on("data", (bytes: Buffer) => {
      input = Buffer.concat([input, bytes]);
    });
    peer.on("end", () => {
      if (options.held) return;
      running = false;
      const bytes = Buffer.concat([frame(1, input), frame(2, Buffer.from("diagnostic"))]);
      peer.write(bytes.subarray(0, 3));
      peer.write(bytes.subarray(3, 11));
      peer.end(options.truncated ? bytes.subarray(11, bytes.length - 1) : bytes.subarray(11));
    });
    peer.on("error", () => undefined);
  });
  await listen();
  return { ready, running: () => running };
}

test("fixed attach preserves binary stdin and split stdout/stderr frames until verified guest exit", async () => {
  await execServer();
  const stdout = output(),
    stderr = output();
  const bytes = Buffer.from([0, 255, 13, 10, 128, 42]);
  await expect(
    attachFixedGuest(
      home,
      namespace,
      name,
      "worker",
      Readable.from([bytes.subarray(0, 2), bytes.subarray(2)]),
      stdout.stream,
      stderr.stream,
    ),
  ).resolves.toBe(7);
  expect(stdout.bytes()).toEqual(bytes);
  expect(stderr.bytes().toString()).toBe("diagnostic");
});

test.each([
  { label: "truncated stdcopy", options: { truncated: true } },
  { label: "invalid exec header", options: { badHeader: true } },
  {
    label: "replacement exec id",
    options: { inspect: { id: "f".repeat(64), running: false, exit_code: 0 } },
  },
  {
    label: "still-running guest",
    options: { inspect: { id: execId, running: true, exit_code: 0 } },
  },
])("fixed attach leaves settlement unknown for $label", async ({ options }) => {
  await execServer(options);
  await expect(
    attachFixedGuest(
      home,
      namespace,
      name,
      "worker",
      Readable.from([Buffer.from("input")]),
      output().stream,
      output().stream,
    ),
  ).rejects.toMatchObject({ code: "LOCAL_GUEST_SETTLEMENT_UNKNOWN" });
});

test("aborting attach does not claim that closing the socket killed the guest", async () => {
  const guest = await execServer({ held: true });
  const controller = new AbortController();
  const result = attachFixedGuest(
    home,
    namespace,
    name,
    "worker",
    Readable.from([Buffer.from("input")]),
    output().stream,
    output().stream,
    controller.signal,
  );
  const unknown = expect(result).rejects.toMatchObject({ code: "LOCAL_GUEST_SETTLEMENT_UNKNOWN" });
  await guest.ready;
  controller.abort();
  await unknown;
  expect(guest.running()).toBe(true);
});

test("bundling the API as a library reads actual identity without running its CLI entry", async () => {
  socket = join(home, ".sbx", `run_${namespace}`, "d", "docker.sock");
  server = createServer((_request, response) =>
    response.writeHead(200).end(JSON.stringify([container])),
  );
  await listen();
  const source = join(home, "library-probe.ts"),
    binary = join(home, "library-probe.mjs");
  await writeFile(
    source,
    `import { readContainerIdentity } from ${JSON.stringify(resolve("packages/local/src/runtime-api.ts"))}; readContainerIdentity(${JSON.stringify(home)},${JSON.stringify(namespace)},${JSON.stringify(name)}).then(value=>process.stdout.write(JSON.stringify(value)));`,
  );
  await build({
    entryPoints: [source],
    outfile: binary,
    bundle: true,
    platform: "node",
    target: "node24",
    format: "esm",
    logLevel: "silent",
  });
  const result = await runProcess({
    binary: process.execPath,
    argv: [binary],
    cwd: home,
    env: {},
    timeoutMs: 15_000,
    maxBytes: 8192,
  });
  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.stdout.toString())).toEqual({
    containerId: container.Id,
    name,
    state: "exited",
  });
});

test("the fixed SDK Docker read emits only one verified container's identity and state", async () => {
  socket = join(home, ".sbx", `run_${namespace}`, "d", "docker.sock");
  server = createServer((request, response) => {
    const target = new URL(request.url!, "http://sdk");
    if (
      request.method !== "GET" ||
      target.pathname !== "/containers/json" ||
      target.searchParams.get("all") !== "true" ||
      target.searchParams.get("filters") !==
        JSON.stringify({ label: [`com.docker.sandbox.name=${name}`] })
    ) {
      response.writeHead(403).end();
      return;
    }
    response.writeHead(200).end(
      JSON.stringify([
        {
          ...container,
          Env: ["FAKE_PRIVATE=value"],
          Command: "private-command",
          HostConfig: { unrelated: true },
        },
      ]),
    );
  });
  await listen();
  await expect(readContainerIdentity(home, namespace, name)).resolves.toEqual({
    containerId: container.Id,
    name,
    state: "exited",
  });
});

test.each([
  { label: "absent container", rows: [] },
  { label: "duplicate matches", rows: [container, container] },
  { label: "invalid CID", rows: [{ ...container, Id: "short" }] },
  { label: "other name", rows: [{ ...container, Names: ["/other"] }] },
  {
    label: "other label",
    rows: [{ ...container, Labels: { ...container.Labels, "com.docker.sandbox.name": "other" } }],
  },
  {
    label: "missing SDK marker",
    rows: [{ ...container, Labels: { "com.docker.sandbox.name": name, "docker/sandbox": "true" } }],
  },
  {
    label: "foreign sandbox marker",
    rows: [{ ...container, Labels: { ...container.Labels, "docker/sandbox": "false" } }],
  },
  { label: "unknown state", rows: [{ ...container, State: "unknown" }] },
  { label: "missing state", rows: [{ ...container, State: undefined }] },
])("the private container read refuses $label instead of adopting it", async ({ rows }) => {
  socket = join(home, ".sbx", `run_${namespace}`, "d", "docker.sock");
  server = createServer((_request, response) => response.writeHead(200).end(JSON.stringify(rows)));
  await listen();
  await expect(readContainerIdentity(home, namespace, name)).rejects.toThrow();
});

test("raw creation supplies only the approved mountless shell profile without reserving MCP", async () => {
  let accepted: unknown;
  server = createServer((request, response) => {
    let body = "";
    request.on("data", (bytes: Buffer) => {
      body += bytes.toString();
    });
    request.on("end", () => {
      if (request.method !== "POST" || request.url !== "/sandbox") {
        response.writeHead(404).end();
        return;
      }
      accepted = JSON.parse(body);
      response
        .writeHead(201)
        .end(JSON.stringify({ name, agent: "shell", workspace: "", status: "created" }));
    });
  });
  await listen();
  await expect(createWithoutGateway(home, namespace, profile)).resolves.toEqual({
    name,
    agent: "shell",
    workspace: "",
  });
  expect(accepted).toEqual({
    agent: "shell",
    name,
    template: profile.template,
    cpus: 2,
    memory: "2048m",
    dind_volume_size: "4096m",
    skills: "off",
    workspace: "",
    additional_workspaces: [],
    credential_values: [],
    environment: {},
    kits: [],
    ssh_agent_socket_path: "",
    clone: false,
    display: false,
    gpu: false,
    nested: false,
    usb_devices: [],
  });
});

test.each([
  { label: "host mount", override: { workspace: "/host" } },
  { label: "unbounded CPU", override: { cpuCores: 33 } },
  { label: "unpinned image", override: { template: "debian:latest" } },
])("creation refuses $label before reaching the SDK", async ({ override }) => {
  let reached = false;
  server = createServer((_request, response) => {
    reached = true;
    response.writeHead(201).end();
  });
  await listen();
  await expect(
    createWithoutGateway(home, namespace, { ...profile, ...override }),
  ).rejects.toThrow();
  expect(reached).toBe(false);
});

test.each([
  { label: "wrong name", response: { name: "another", agent: "shell", workspace: "" } },
  { label: "wrong agent", response: { name, agent: "claude", workspace: "" } },
  { label: "host workspace", response: { name, agent: "shell", workspace: "/host" } },
  { label: "non-JSON response", response: "not-json" },
])("creation refuses $label despite HTTP201", async ({ response: body }) => {
  server = createServer((_request, response) =>
    response.writeHead(201).end(typeof body === "string" ? body : JSON.stringify(body)),
  );
  await listen();
  await expect(createWithoutGateway(home, namespace, profile)).rejects.toThrow();
});

test("HTTP200 cannot masquerade as confirmed new sandbox creation", async () => {
  server = createServer((_request, response) =>
    response.writeHead(200).end(JSON.stringify({ name, agent: "shell", workspace: "" })),
  );
  await listen();
  await expect(createWithoutGateway(home, namespace, profile)).rejects.toMatchObject({
    code: "LOCAL_RUNTIME_API_REFUSED",
  });
});

test("an oversized raw creation response cannot be accepted as an identity", async () => {
  server = createServer((_request, response) =>
    response.writeHead(201).end(Buffer.alloc(64 * 1024 + 1)),
  );
  await listen();
  await expect(createWithoutGateway(home, namespace, profile)).rejects.toMatchObject({
    code: "LOCAL_OUTPUT_LIMIT",
  });
});

test("held raw creation is canceled without returning an invented identity", async () => {
  let entered!: () => void;
  const held = new Promise<void>((resolve) => {
    entered = resolve;
  });
  server = createServer(() => entered());
  await listen();
  const controller = new AbortController();
  const completion = createWithoutGateway(home, namespace, profile, controller.signal);
  const refusal = expect(completion).rejects.toMatchObject({ name: "AbortError" });
  await held;
  controller.abort();
  await refusal;
});

test("an owned stopped sandbox boots only after its gateway is removed with an empty startup body", async () => {
  let gateway = true;
  let running = false;
  server = createServer((request, response) => {
    if (request.method === "DELETE" && request.url === `/sandbox/${name}/mcp/gateway`) {
      gateway = false;
      response.writeHead(204).end();
      return;
    }
    let body = "";
    request.on("data", (chunk: Buffer) => {
      body += chunk.toString();
    });
    request.on("end", () => {
      if (
        request.method !== "POST" ||
        request.url !== `/sandbox/${name}/start` ||
        body !== "{}" ||
        gateway
      ) {
        response.writeHead(400).end();
        return;
      }
      running = true;
      response.writeHead(200).end(JSON.stringify({ running, gateway }));
    });
  });
  await listen();
  await startWithoutGateway(home, namespace, name, true);
  expect({ running, gateway }).toEqual({ running: true, gateway: false });
});

test("a freshly observed absent gateway needs no deletion and still uses the fixed startup", async () => {
  let running = false;
  server = createServer((request, response) => {
    if (request.method !== "POST" || request.url !== `/sandbox/${name}/start`) {
      response.writeHead(404).end();
      return;
    }
    running = true;
    response.writeHead(200).end();
  });
  await listen();
  await startWithoutGateway(home, namespace, name, false);
  expect(running).toBe(true);
});

test.each([404, 500])("gateway refusal HTTP%s cannot boot the sandbox", async (status) => {
  let running = false;
  server = createServer((request, response) => {
    if (request.method === "POST") running = true;
    response.writeHead(status).end();
  });
  await listen();
  await expect(startWithoutGateway(home, namespace, name, true)).rejects.toMatchObject({
    code: "LOCAL_RUNTIME_API_REFUSED",
  });
  expect(running).toBe(false);
});

test("an oversized startup response is refused rather than accepting unbounded host data", async () => {
  server = createServer((_request, response) =>
    response.writeHead(200).end(Buffer.alloc(64 * 1024 + 1)),
  );
  await listen();
  await expect(startWithoutGateway(home, namespace, name, false)).rejects.toMatchObject({
    code: "LOCAL_OUTPUT_LIMIT",
  });
});

test("cancellation of held gateway removal cannot dispatch startup", async () => {
  let entered!: () => void;
  const held = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let running = false;
  server = createServer((request) => {
    if (request.method === "POST") running = true;
    entered();
  });
  await listen();
  const controller = new AbortController();
  const completion = startWithoutGateway(home, namespace, name, true, controller.signal);
  const refusal = expect(completion).rejects.toMatchObject({ name: "AbortError" });
  await held;
  controller.abort();
  await refusal;
  expect(running).toBe(false);
});

test("a socket alias outside the private HOME is refused without reaching the foreign server", async () => {
  const foreign = await realpath(await mkdtemp("/tmp/ml-foreign-"));
  const foreignSocket = join(foreign, "sdk.sock");
  let reached = false;
  server = createServer((_request, response) => {
    reached = true;
    response.end();
  });
  try {
    await new Promise<void>((resolve) => server.listen(foreignSocket, resolve));
    await symlink(foreignSocket, socket);
    await expect(startWithoutGateway(home, namespace, name, false)).rejects.toMatchObject({
      code: "LOCAL_RUNTIME_API_UNSAFE",
    });
    expect(reached).toBe(false);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(foreign, { recursive: true, force: true });
  }
});
