import { afterEach, expect, jest, test } from "@jest/globals";
import { createWorkspaceRequestId } from "@mcp-moira/shared/workspace-request-id";
import { CodespaceResourceError } from "@mcp-moira/shared/codespace-resource-types";
import { createServer } from "node:https";
import { createServer as createHttpServer } from "node:http";
import { request as httpsRequest } from "node:https";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  rm,
  stat,
  realpath,
  readdir,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { watch } from "node:fs";
import {
  WorkspaceRouter,
  WORKSPACE_UPGRADE,
  type WorkspaceBinding,
} from "../../packages/web-backend/src/services/workspace-router.js";
import {
  createControllerClient,
  createWorkspaceClient,
} from "../../packages/web-backend/src/services/workspace-client.js";

const disposals: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of disposals.splice(0).reverse()) await close();
});

// The actual service and remote adapter run in a separate process with its own CA and HOME.
// Only provider/account authority is injected at this transport boundary.
const childProgram = `
  const c=JSON.parse(process.env.WORKSPACE_TEST_CONFIG);
  const {startWorkspaceService}=await import(c.serviceModule);
  const {startWorkspaceRemote}=await import(c.remoteModule);
  const service=await startWorkspaceService(c.service);
  service.server.on('request',request=>{
    if(request.url?.includes('waitMs=60000'))process.stdout.write('observing\\n');
  });
  let remote;
  const {createInterface}=await import('node:readline');
  const lines=createInterface({input:process.stdin});
  lines.on('line',async line=>{
    if(line.startsWith('connect:')){
      const life=line.slice('connect:'.length);
      if(remote||!/^[a-f0-9]{64}$/.test(life))throw new Error('Invalid fixture bootstrap');
      c.remote.environmentIdentity=life;
      remote=startWorkspaceRemote(c.remote);
    }
    else if(line==='disconnect'){await remote.close();process.stdout.write('disconnected\\n');}
    else if(line==='reconnect'){remote=startWorkspaceRemote(c.remote);}
    else if(line==='when-ready'){
      process.stdout.write('awaiting-connection\\n');
      try{await remote.whenConnected();process.stdout.write('connection-ready\\n');}
      catch(error){process.stdout.write('connection-cancelled\\nconnection-error:'+error.message+'\\n');}
    }
    else if(line.startsWith('owner:')){
      await remote.close();
      remote=startWorkspaceRemote(JSON.parse(line.slice('owner:'.length)));
    }
  });
  process.on('SIGTERM',async()=>{await remote?.close();await service.close();process.exit(0)});
  process.stdout.write('ready\\n');
`;

async function fixture(expiresAt: number | null = null) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "workspace-router-")));
  disposals.push(() => rm(root, { recursive: true, force: true }));
  const project = join(root, "project");
  await mkdir(project);
  const origin = "https://github.com/owner/project.git";
  for (const argv of [
    ["init", project],
    ["-C", project, "remote", "add", "origin", origin],
  ]) {
    if (spawnSync("git", argv, { stdio: "ignore" }).status !== 0)
      throw new Error("Fixture repository failed");
  }
  const key = join(root, "key.pem"),
    ca = join(root, "ca.pem");
  const cert = spawnSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "1",
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=IP:127.0.0.1",
      "-keyout",
      key,
      "-out",
      ca,
    ],
    { stdio: "ignore" },
  );
  if (cert.status !== 0) throw new Error("Fixture certificate failed");
  const principal = {
    userId: randomUUID(),
    resourceId: randomUUID(),
    resourceGeneration: 1,
    authorizationGeneration: 1,
  };
  let binding: WorkspaceBinding | undefined = undefined;
  let allowed = true;
  let authorityUnavailable = false;
  let observeOutage: (() => void) | undefined;
  const credential = "fixture-credential";
  const router = new WorkspaceRouter({
    async credential(value) {
      if (authorityUnavailable) {
        observeOutage?.();
        throw new Error("Fixture authority store unavailable");
      }
      if (
        !binding ||
        value !== credential ||
        !allowed ||
        (expiresAt !== null && expiresAt <= Date.now())
      )
        throw new CodespaceResourceError("CODESPACE_AUTHORIZATION_REQUIRED", "Fixture denied");
      return { ...binding, expiresAt };
    },
    async request(user, id) {
      if (!binding || user !== binding.userId || id !== binding.resourceId || !allowed)
        throw new CodespaceResourceError("CODESPACE_AUTHORIZATION_REQUIRED", "Fixture denied");
      return { ...binding };
    },
  });
  const server = createServer(
    { key: await readFile(key), cert: await readFile(ca) },
    (_req, res) => {
      res.writeHead(404);
      res.end();
    },
  );
  await router.listenPrivate(join(root, "router", "router.sock"));
  router.attach(server);
  await new Promise<void>((done, reject) => {
    server.once("error", reject);
    server.listen(3100, "127.0.0.1", done);
  });
  disposals.push(async () => {
    await router.close();
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
  });
  const info = await stat(project);
  const config = {
    serviceModule: pathToFileURL(resolve("packages/workspace-service/src/server.mjs")).href,
    remoteModule: pathToFileURL(resolve("packages/workspace-service/src/remote.ts")).href,
    service: {
      socketPath: join(root, "service.sock"),
      stateRoot: join(root, "state"),
      binding: {
        repositoryFullName: "owner/project",
        root: project,
        origin,
        dev: info.dev,
        ino: info.ino,
      },
    },
    remote: {
      socketPath: join(root, "service.sock"),
      origin: "https://127.0.0.1:3100",
      credential,
    },
  };
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "-e", childProgram],
    {
      env: {
        ...process.env,
        HOME: root,
        NODE_EXTRA_CA_CERTS: ca,
        MOIRA_ENVIRONMENT_ID: "router-test",
        WORKSPACE_TEST_CONFIG: JSON.stringify(config),
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  const ready = once(child.stdout!, "data");
  let childDiagnostic = "";
  child.stderr!.on("data", (bytes) => {
    childDiagnostic = (childDiagnostic + String(bytes)).slice(-4096);
  });
  const failed = new Promise<never>((_done, reject) => {
    child.once("exit", (code) =>
      reject(
        new Error(
          `Workspace fixture exited (${code}): ${childDiagnostic.replaceAll(credential, "[fixture credential]")}`,
        ),
      ),
    );
    child.once("error", reject);
  });
  disposals.push(async () => {
    // Detached test work outlives the observer; release its physical barrier before shutdown.
    await writeFile(join(project, "release"), "release");
    if (child.exitCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGTERM");
      await exited;
    }
  });
  let setupStage = "owner process ready";
  let measuredBinding: WorkspaceBinding;
  try {
    expect(String((await Promise.race([ready, failed]))[0]).trim()).toBe("ready");
    setupStage = "direct Unix health before enrollment";
    const health = await Promise.race([
      createWorkspaceClient(config.service.socketPath).json(
        principal.userId,
        principal.resourceId,
        {
          method: "GET",
          path: "/v1/health",
        },
      ),
      failed,
    ]);
    const life = health.environmentIdentity;
    if (typeof life !== "string" || !/^[a-f0-9]{64}$/.test(life))
      throw new Error("Fixture service did not report its measured life");
    measuredBinding = { kind: "workspace" as const, ...principal, environmentIdentity: life };
    binding = measuredBinding;
    setupStage = "TLS control enrollment";
    const connected = once(router, "connected");
    child.stdin!.write(`connect:${life}\n`);
    await Promise.race([connected, failed]);
  } catch (error) {
    throw new Error(
      `Workspace setup failed during ${setupStage}; child evidence: ${childDiagnostic.replaceAll(credential, "[fixture credential]")}`,
      { cause: error },
    );
  }
  return {
    root,
    project,
    router,
    server,
    child,
    ca,
    binding: measuredBinding,
    credential,
    diagnostics: () => childDiagnostic.replaceAll(credential, "[fixture credential]"),
    client: createWorkspaceClient(join(root, "router", "router.sock")),
    replaceBinding: (next: WorkspaceBinding) => {
      binding = next;
    },
    revoke: () => {
      allowed = false;
    },
    authorize: () => {
      allowed = true;
      expiresAt = null;
    },
    interruptAuthorityStore: () => {
      authorityUnavailable = true;
      return new Promise<void>((resolve) => {
        observeOutage = resolve;
      });
    },
    restoreAuthorityStore: () => {
      authorityUnavailable = false;
      observeOutage = undefined;
    },
  };
}

async function bytes(body: AsyncIterable<Uint8Array>) {
  const chunks: Buffer[] = [];
  for await (const chunk of body) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}
async function disconnect(child: ChildProcess) {
  const ended = once(child.stdout!, "data");
  child.stdin!.write("disconnect\n");
  expect(String((await ended)[0]).trim()).toBe("disconnected");
}

test("remote availability requires authenticated control while the Unix owner stays independently ready", async () => {
  const f = await fixture();
  const observe = (marker: string) =>
    new Promise<string>((resolve) => {
      let output = "";
      const collect = (bytes: Buffer) => {
        output += bytes.toString();
        if (output.includes(marker)) {
          f.child.stdout!.off("data", collect);
          resolve(output);
        }
      };
      f.child.stdout!.on("data", collect);
    });
  const ready = observe("connection-ready\n");
  f.child.stdin!.write("when-ready\n");
  expect(await ready).toContain("awaiting-connection\n");
  await disconnect(f.child);
  // A temporary transport outage must remain pending until explicit close;
  // a definitive credential refusal is tested separately below.
  const unavailable = (_request: unknown, socket: { destroy(): void }) => socket.destroy();
  f.server.prependListener("upgrade", unavailable);
  const attempted = once(f.server, "upgrade");
  const waiting = observe("awaiting-connection\n");
  let prematurelyReady = false;
  const premature = (bytes: Buffer) => {
    if (bytes.toString().includes("connection-ready")) prematurelyReady = true;
  };
  f.child.stdout!.on("data", premature);
  try {
    f.child.stdin!.write("reconnect\nwhen-ready\n");
    await waiting;
    await attempted;
    // The guest is locally healthy, but refused cloud enrollment cannot satisfy readiness.
    expect(
      await createWorkspaceClient(join(f.root, "service.sock")).json(
        f.binding.userId,
        f.binding.resourceId,
        { method: "GET", path: "/v1/health" },
      ),
    ).toMatchObject({ version: 1 });
    expect(prematurelyReady).toBe(false);
    const cancelled = observe("connection-cancelled\n");
    f.child.stdin!.write("disconnect\n");
    await cancelled;
    expect(prematurelyReady).toBe(false);
  } finally {
    f.server.off("upgrade", unavailable);
    f.child.stdout!.off("data", premature);
  }
});

test("a temporary authority-store outage reconnects the same remote owner while its Unix API remains ready", async () => {
  const f = await fixture();
  const local = createWorkspaceClient(join(f.root, "service.sock"));
  const before = await local.json(f.binding.userId, f.binding.resourceId, {
    method: "GET",
    path: "/v1/health",
  });
  await disconnect(f.child);
  const outageObserved = f.interruptAuthorityStore();
  const reconnected = once(f.router, "connected");
  f.child.stdin!.write("reconnect\n");
  await outageObserved;
  expect(f.router.isConnected(f.binding)).toBe(false);
  expect(
    await local.json(f.binding.userId, f.binding.resourceId, {
      method: "GET",
      path: "/v1/health",
    }),
  ).toEqual(before);
  f.restoreAuthorityStore();
  // No reconnect instruction or new credential is supplied after the outage.
  await reconnected;
  expect(
    await f.client.json(f.binding.userId, f.binding.resourceId, {
      method: "GET",
      path: "/v1/health",
    }),
  ).toEqual(before);
});

test.each([401, 403])(
  "a definitive HTTPS %s owner enrollment refusal rejects startup readiness without retrying its credential",
  async (status) => {
    const f = await fixture();
    await disconnect(f.child);
    f.server.removeAllListeners("upgrade");
    let refusals = 0;
    let observed!: () => void;
    const refused = new Promise<void>((resolve) => {
      observed = resolve;
    });
    f.server.on("upgrade", (request, socket) => {
      expect(request.url).toBe("/api/workspaces/connect");
      refusals++;
      socket.end(`HTTP/1.1 ${status} Refused\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      observed();
    });
    const outcome = () =>
      new Promise<string>((resolve) => {
        let output = "";
        const collect = (bytes: Buffer) => {
          output += bytes.toString();
          if (output.includes("connection-error:")) {
            f.child.stdout!.off("data", collect);
            resolve(output);
          }
        };
        f.child.stdout!.on("data", collect);
      });
    const failed = outcome();
    f.child.stdin!.write("reconnect\nwhen-ready\n");
    await refused;
    expect(await failed).toContain(`Workspace connection refused (${status})`);
    expect(f.router.isConnected(f.binding)).toBe(false);
    // A later waiter observes the same terminal refusal, rather than making a
    // new connection or requiring shutdown to release its readiness promise.
    const repeated = outcome();
    f.child.stdin!.write("when-ready\n");
    expect(await repeated).toContain(`Workspace connection refused (${status})`);
    expect(refusals).toBe(1);
  },
);

test("TLS outbound tunnels preserve large raw bytes and detached identity across observation reconnect", async () => {
  const f = await fixture();
  let stage = "initial health";
  try {
    const { userId, resourceId } = f.binding;
    expect(
      await f.client.json(userId, resourceId, { method: "GET", path: "/v1/health" }),
    ).toMatchObject({ version: 1, repositoryFullName: "owner/project" });
    const payload = Buffer.alloc(8 * 1024 * 1024 + 31, 0xfe),
      requestId = createWorkspaceRequestId();
    stage = "large stdin request headers";
    const input = await f.client.request(userId, resourceId, {
      method: "PUT",
      path: `/v1/operations/${requestId}/input`,
      body: payload,
    });
    expect(input.statusCode).toBe(200);
    stage = "large stdin receipt body";
    expect(JSON.parse((await bytes(input.body)).toString())).toEqual({
      size: payload.length,
      sha256: createHash("sha256").update(payload).digest("hex"),
    });
    const command = {
      requestId,
      inputReady: true,
      argv: [
        process.execPath,
        "-e",
        "const f=require('node:fs');f.appendFileSync('effects','once\\n');process.stdin.pipe(process.stdout);const t=setInterval(()=>{if(f.existsSync('release'))clearInterval(t)},10)",
      ],
    };
    let effectObserved!: () => void;
    const effect = new Promise<void>((done) => {
      effectObserved = done;
    });
    const inspectEffect = async () => {
      if ((await readFile(join(f.project, "effects"), "utf8").catch(() => null)) === "once\n")
        effectObserved();
    };
    const watcher = watch(f.project, () => {
      void inspectEffect();
    });
    try {
      stage = "command admission";
      const admitted = await f.client.json(userId, resourceId, {
        method: "POST",
        path: "/v1/exec",
        body: command,
      });
      expect(["starting", "running"]).toContain(admitted.state);
      stage = "physical command effect";
      await inspectEffect();
      await effect;
    } finally {
      watcher.close();
    }
    const observing = once(f.child.stdout!, "data");
    stage = "observer disconnect";
    const lostObserver = f.client.json(userId, resourceId, {
      method: "GET",
      path: `/v1/operations/${requestId}?waitMs=60000`,
    });
    // Attach rejection handling before deliberately closing the observed data tunnel.
    const lostOutcome = expect(lostObserver).rejects.toMatchObject({
      details: { error: { code: "WORKSPACE_OUTCOME_UNKNOWN" } },
    });
    expect(String((await observing)[0]).trim()).toBe("observing");
    await disconnect(f.child);
    await lostOutcome;
    stage = "offline observation refusal";
    await expect(
      f.client.json(userId, resourceId, { method: "GET", path: `/v1/operations/${requestId}` }),
    ).rejects.toThrow();
    await writeFile(join(f.project, "release"), "release");
    const connected = once(f.router, "connected");
    f.child.stdin!.write("reconnect\n");
    await connected;
    stage = "reconnected completion observation";
    let result = await f.client.json(userId, resourceId, {
      method: "GET",
      path: `/v1/operations/${requestId}?waitMs=1000`,
    });
    while (result.state === "running" || result.state === "starting")
      result = await f.client.json(userId, resourceId, {
        method: "GET",
        path: `/v1/operations/${requestId}?waitMs=1000`,
      });
    expect(result.state).toBe("succeeded");
    stage = "large output request headers";
    const response = await f.client.request(userId, resourceId, {
      method: "GET",
      path: `/v1/operations/${requestId}/output`,
    });
    // Leave the large response unread while an independent call uses a different tunnel.
    stage = "independent health with large output paused";
    expect(
      await f.client.json(userId, resourceId, { method: "GET", path: "/v1/health" }),
    ).toMatchObject({ version: 1 });
    stage = "large output body after independent health";
    expect((await bytes(response.body)).equals(payload)).toBe(true);
    stage = "terminal receipt after large output";
    expect(
      await f.client.json(userId, resourceId, {
        method: "GET",
        path: `/v1/operations/${requestId}`,
      }),
    ).toMatchObject({ requestId, state: "succeeded" });
    stage = "accepted command replay";
    await f.client.json(userId, resourceId, { method: "POST", path: "/v1/exec", body: command });
    expect(await readFile(join(f.project, "effects"), "utf8")).toBe("once\n");
  } catch (error) {
    throw new Error(
      `Workspace transport fixture failed during ${stage}; child evidence: ${f.diagnostics()}`,
      { cause: error },
    );
  }
});

test("a cancelled data rendezvous reconnects the same valid owner instead of retiring its credential", async () => {
  const f = await fixture();
  const abort = new AbortController();
  const reconnected = once(f.router, "connected");
  const attempted = once(f.server, "upgrade");
  f.server.prependOnceListener("upgrade", (request) => {
    expect(request.url).toMatch(/^\/api\/workspaces\/calls\//);
    // The real router removes this original pending call synchronously. Its
    // incoming data handshake then receives 403 for the missing rendezvous,
    // although the same credential still authorizes control registration.
    abort.abort();
  });
  const pending = f.router.request(
    f.binding.userId,
    f.binding.resourceId,
    { method: "GET", path: "/v1/health" },
    abort.signal,
  );
  const cancelled = expect(pending).rejects.toThrow("Workspace call cancelled before dispatch");
  await attempted;
  await cancelled;
  await reconnected;
  expect(f.router.isConnected(f.binding)).toBe(true);
  expect(
    await f.client.json(f.binding.userId, f.binding.resourceId, {
      method: "GET",
      path: "/v1/health",
    }),
  ).toMatchObject({ version: 1, repositoryFullName: "owner/project" });
  expect(await readdir(join(f.root, "state", "requests"))).toEqual([]);
});

test("control loss before HTTP dispatch refuses admission without creating a guest operation", async () => {
  const f = await fixture();
  const requestId = createWorkspaceRequestId();
  const reconnected = once(f.router, "connected");
  f.server.once("upgrade", (request, socket) => {
    expect(request.url).toMatch(/^\/api\/workspaces\/calls\//);
    // The authenticated DATA rendezvous has not sent any HTTP bytes to the service yet.
    socket.destroy();
  });
  await expect(
    f.client.json(f.binding.userId, f.binding.resourceId, {
      method: "POST",
      path: "/v1/exec",
      body: {
        requestId,
        argv: [process.execPath, "-e", "require('node:fs').appendFileSync('effects','unexpected')"],
      },
    }),
  ).rejects.toMatchObject({ details: { error: { code: "CODESPACE_PROVIDER_UNAVAILABLE" } } });
  await reconnected;
  expect(
    await f.client.json(f.binding.userId, f.binding.resourceId, {
      method: "GET",
      path: `/v1/operations/${requestId}`,
    }),
  ).toMatchObject({ requestId, state: "absent" });
  await expect(readFile(join(f.project, "effects"))).rejects.toThrow();
});

test.each(["revoked", "expired"] as const)(
  "server authority closes silent CONTROL and its stalled DATA when credentials are %s without cancelling work",
  async (change) => {
    // Only the cloud clock is controlled; the separate real service/adapter process
    // has not reached its heartbeat when the server's independent check runs.
    jest.useFakeTimers({ doNotFake: ["nextTick", "setImmediate", "queueMicrotask"] });
    const expiry = Date.now() + 100_000;
    try {
      const f = await fixture(change === "expired" ? expiry : null);
      const { userId, resourceId } = f.binding;
      const requestId = createWorkspaceRequestId();
      const observing = once(f.child.stdout!, "data");
      await f.client.json(userId, resourceId, {
        method: "POST",
        path: "/v1/exec",
        body: {
          requestId,
          argv: [
            process.execPath,
            "-e",
            "const f=require('node:fs');f.appendFileSync('effects','once\\n');const t=setInterval(()=>{if(f.existsSync('release'))clearInterval(t)},10)",
          ],
        },
      });
      const observer = f.client.json(userId, resourceId, {
        method: "GET",
        path: `/v1/operations/${requestId}?waitMs=60000`,
      });
      const ended = observer.then(
        () => null,
        (error: unknown) => error,
      );
      expect(String((await observing)[0]).trim()).toBe("observing");
      if (change === "revoked") f.revoke();
      await jest.advanceTimersByTimeAsync(change === "expired" ? 100_000 : 20_000);
      expect(f.router.isConnected(f.binding)).toBe(false);
      expect(await ended).toMatchObject({
        details: { error: { code: "WORKSPACE_OUTCOME_UNKNOWN" } },
      });
      // Restoration opens observation only. The actual owner still holds the same job.
      jest.useRealTimers();
      await disconnect(f.child);
      f.authorize();
      const connected = once(f.router, "connected");
      f.child.stdin!.write("reconnect\n");
      await connected;
      await writeFile(join(f.project, "release"), "release");
      const result = await f.client.json(userId, resourceId, {
        method: "GET",
        path: `/v1/operations/${requestId}?waitMs=1000`,
      });
      expect(result).toMatchObject({ requestId, state: "succeeded" });
      expect(await readFile(join(f.project, "effects"), "utf8")).toBe("once\n");
    } finally {
      jest.useRealTimers();
    }
  },
);

test("unknown data IDs, wrong principals and revoked authority never reach the Unix service", async () => {
  const f = await fixture();
  const ca = await readFile(f.ca);
  const status = await new Promise<number>((done, reject) => {
    const request = httpsRequest(
      {
        hostname: "127.0.0.1",
        port: 3100,
        path: `/api/workspaces/calls/${randomUUID()}`,
        method: "GET",
        ca,
        headers: {
          authorization: `Bearer ${f.credential}`,
          connection: "Upgrade",
          upgrade: WORKSPACE_UPGRADE,
          "x-moira-control-id": randomUUID(),
          "x-moira-endpoint-kind": "workspace",
          "x-moira-endpoint-identity": f.binding.environmentIdentity,
        },
      },
      (reply) => {
        reply.resume();
        done(reply.statusCode!);
      },
    );
    request.once("upgrade", (_reply, socket) => {
      socket.destroy();
      reject(new Error("Unowned rendezvous was accepted"));
    });
    request.once("error", reject);
    request.end();
  });
  expect(status).toBe(403);
  await expect(
    f.client.json(randomUUID(), f.binding.resourceId, {
      method: "POST",
      path: "/v1/exec",
      body: { requestId: createWorkspaceRequestId(), argv: ["/bin/true"] },
    }),
  ).rejects.toThrow();
  f.revoke();
  await expect(
    f.client.json(f.binding.userId, f.binding.resourceId, { method: "GET", path: "/v1/service" }),
  ).rejects.toThrow();
  await expect(readFile(join(f.project, "effects"))).rejects.toThrow();
});

test("controller routes use device authority without guest readiness and replace forged identity headers", async () => {
  const f = await fixture();
  await disconnect(f.child);
  const binding: WorkspaceBinding = {
    kind: "controller",
    userId: f.binding.userId,
    resourceId: f.binding.resourceId,
    resourceGeneration: 7,
    authorizationGeneration: 7,
    connectionId: randomUUID(),
  };
  f.replaceBinding(binding);
  const socketPath = join(f.root, "controller.sock");
  const owner = createHttpServer((request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify(
        request.url === "/v1/controller/health"
          ? { connectionId: binding.connectionId }
          : {
              userId: request.headers["x-moira-user-id"],
              deviceId: request.headers["x-moira-device-id"],
              generation: request.headers["x-moira-device-generation"],
              connectionId: request.headers["x-moira-connection-id"],
            },
      ),
    );
  });
  await new Promise<void>((done, reject) => {
    owner.once("error", reject);
    owner.listen(socketPath, done);
  });
  await chmod(socketPath, 0o600);
  disposals.push(async () => {
    owner.closeAllConnections();
    await new Promise<void>((done) => owner.close(() => done()));
  });
  const connected = once(f.router, "connected");
  f.child.stdin!.write(
    `owner:${JSON.stringify({
      kind: "controller",
      socketPath,
      origin: "https://127.0.0.1:3100",
      credential: f.credential,
      connectionId: binding.connectionId,
    })}\n`,
  );
  await connected;
  const client = createControllerClient(join(f.root, "router", "router.sock"));
  expect(
    await client.json(binding.userId, binding.resourceId, {
      method: "GET",
      path: "/v1/controller/identity",
      headers: {
        "x-moira-device-id": randomUUID(),
        "x-moira-device-generation": "999",
        "x-moira-connection-id": randomUUID(),
      },
    }),
  ).toEqual({
    userId: binding.userId,
    deviceId: binding.resourceId,
    generation: "7",
    connectionId: binding.connectionId,
  });
  await expect(
    f.client.json(binding.userId, binding.resourceId, {
      method: "GET",
      path: "/v1/controller/identity",
    }),
  ).rejects.toMatchObject({
    details: { error: { code: "CODESPACE_AUTHORIZATION_REQUIRED" } },
  });
  f.revoke();
  await expect(
    client.json(binding.userId, binding.resourceId, {
      method: "GET",
      path: "/v1/controller/identity",
    }),
  ).rejects.toThrow();
});
