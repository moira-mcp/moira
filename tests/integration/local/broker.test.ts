import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";
import { once } from "node:events";
import supertest from "supertest";
import { mkdtemp, rm, realpath, writeFile, readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { connect, createServer, Socket } from "node:net";
import { PrivateState, hostBootIdentity } from "../../../packages/local/src/private-state.js";
import { startBroker } from "../../../packages/local/src/broker.js";
import { startBrokerTunnel, BROKER_PREFACE } from "../../../packages/local/src/broker-tunnel.js";
import { NetworkBudget } from "../../../packages/local/src/network-budget.js";
import { localFixture } from "./fixtures.js";
import { LocalManager } from "../../../packages/local/src/manager.js";
import { SbxRuntime } from "../../../packages/local/src/sbx-runtime.js";
import { adaptSbxRuntime } from "../../../packages/local/src/local-vm-runtime-factory.js";
import { LocalRefusal, localRuntimeProfileHash } from "../../../packages/local/src/policy.js";
import { gitBroker } from "../../../packages/local/src/git-broker.js";
import {
  serveOwnerGit,
  type OwnerPullRequest,
} from "../../../packages/workspace-service/src/github-owner.mjs";

let root: string;
let state: PrivateState;
const closers: Array<() => Promise<void>> = [];
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "moira-local-broker-")));
  state = await PrivateState.open(root);
});
afterEach(async () => {
  for (const close of closers.reverse()) await close();
  closers.length = 0;
  jest.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

function exchange(port: number, bytes: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const client = connect({ host: "127.0.0.1", port });
    let result = "";
    const timer = setTimeout(() => {
      client.destroy();
      reject(new Error("Broker response timed out"));
    }, 3000);
    client.once("connect", () => client.end(bytes));
    client.on("data", (chunk) => {
      result += chunk.toString();
    });
    client.once("error", reject);
    client.once("close", () => {
      clearTimeout(timer);
      resolve(result);
    });
  });
}

async function exitedPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  await new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => (code === 0 ? resolve() : reject(new Error("Child failed"))));
  });
  return child.pid!;
}

describe("local broker authority and address boundary", () => {
  test("old manual token bytes are preserved but never read into the guest broker grant", async () => {
    const fixture = await localFixture(state);
    const legacy = { token: "legacy-not-scoped", malformed: true };
    const key = `git-${fixture.policy.repositories[0].id}.json`;
    await state.write(key, legacy);
    const grant = await fixture.records.authorize(fixture.authorization);
    expect(grant?.repository.fullName).toBe("owner/project");
    expect(grant).not.toHaveProperty("gitCredential");
    expect(await state.read(key, (value) => value)).toEqual(legacy);
  });

  test.each(["repository rights", "native generation"])(
    "an active response closes when its admitted %s changes even though Basic access remains valid",
    async (change) => {
      const fixture = await localFixture(state);
      fixture.policy.repositories[0].allowPush = true;
      await state.write("policy.json", fixture.policy);
      let observe!: () => void;
      const observing = new Promise<void>((done) => {
        observe = done;
      });
      const broker = await startBroker({
        authorize: (header) => fixture.records.authorize(header),
        budget: new NetworkBudget(),
        git: async (_request, response) => {
          observe();
          await once(response, "close");
        },
        onFault: () => {},
      });
      closers.push(broker.close);
      const client = connect({ host: "127.0.0.1", port: broker.port });
      client.on("error", () => {});
      const closed = once(client, "close");
      await once(client, "connect");
      client.write(
        `POST /git/owner/project.git/git-receive-pack HTTP/1.1\r\nHost: moira-local\r\nAuthorization: ${fixture.authorization}\r\nContent-Length: 0\r\n\r\n`,
      );
      await observing;
      if (change === "repository rights") {
        fixture.policy.repositories[0].allowPush = false;
        await state.write("policy.json", fixture.policy);
      } else {
        fixture.space.generation++;
        await fixture.records.put(fixture.space);
      }
      expect(await fixture.records.authorize(fixture.authorization)).not.toBeNull();
      await closed;
      expect(client.destroyed).toBe(true);
    },
  );
  test("the fixed host PR route requires current Basic and repository rights and never returns its scoped credential", async () => {
    const fixture = await localFixture(state);
    fixture.policy.repositories[0].private = true;
    await state.write("policy.json", fixture.policy);
    const effect = join(root, "pull-request-effect");
    const github = gitBroker(
      new NetworkBudget(),
      () => {},
      async (grant) => ({
        mode: "scoped",
        token: "host-only-child",
        credentialId: randomUUID(),
        repositoryFullName: grant.repository.fullName,
        expiresAt: Date.now() + 60000,
        useUntil: Date.now() + 60000,
        validate: async () => {},
        dispose: async () => {},
      }),
      {
        git: serveOwnerGit,
        pullRequest: async (_action, _input, authority) => {
          const lease = await authority.acquire("pull_request_create", authority.signal);
          try {
            await writeFile(effect, "created");
            return {
              number: 7,
              url: "https://github.com/owner/project/pull/7",
              head: "feature",
              base: "main",
              title: "Approved",
              draft: false,
              state: "open",
            } as OwnerPullRequest;
          } finally {
            await lease.dispose();
          }
        },
      },
    );
    const broker = await startBroker({
      authorize: (header) => fixture.records.authorize(header),
      budget: new NetworkBudget(),
      ...github,
      onFault: () => {},
    });
    closers.push(broker.close);
    const body = { head: "feature", base: "main", title: "Approved" };
    const request = (authorization: string) =>
      supertest(`http://127.0.0.1:${broker.port}`)
        .post("/github/pull_request_create")
        .set("Authorization", authorization)
        .send(body);
    expect((await request("Basic invalid")).status).toBe(403);
    const refusal = await request(fixture.authorization);
    expect(refusal.status).toBe(403);
    expect(refusal.body.error.code).toBe("LOCAL_REPOSITORY_DENIED");
    await expect(readFile(effect)).rejects.toThrow();
    fixture.policy.repositories[0].allowPullRequests = true;
    await state.write("policy.json", fixture.policy);
    const response = await request(fixture.authorization);
    expect(response.status).toBe(200);
    expect(response.body.pull_request.url).toBe("https://github.com/owner/project/pull/7");
    expect(JSON.stringify(response.body)).not.toContain("host-only-child");
    expect(await readFile(effect, "utf8")).toBe("created");
  });
  test("fixed tunnel carries simultaneous streams beyond the former socket ceiling", async () => {
    const peers = new Set<Socket>();
    const clients: Socket[] = [];
    const remote = createServer((socket) => {
      peers.add(socket);
      socket.once("close", () => peers.delete(socket));
      socket.on("data", (bytes) => socket.write(bytes));
    });
    remote.listen(0, "127.0.0.1");
    await once(remote, "listening");
    closers.push(async () => {
      for (const socket of [...clients, ...peers]) socket.destroy();
      await new Promise<void>((resolve, reject) =>
        remote.close((error) => (error ? reject(error) : resolve())),
      );
    });
    const address = remote.address();
    if (!address || typeof address === "string") throw new Error("Remote did not bind");
    const tunnel = await startBrokerTunnel(address.port);
    closers.push(tunnel.close);
    const responses = await Promise.all(
      Array.from(
        { length: 129 },
        () =>
          new Promise<string>((resolve, reject) => {
            const client = connect({ host: "127.0.0.1", port: tunnel.port });
            clients.push(client);
            client.once("error", reject);
            client.once("close", () => reject(new Error("Tunnel closed before its reply")));
            client.once("connect", () => client.write(`${BROKER_PREFACE}echo`));
            client.once("data", (bytes) => resolve(bytes.toString()));
          }),
      ),
    );
    expect(responses).toEqual(Array(129).fill("echo"));
    expect(peers.size).toBe(129);
    expect(clients.every((socket) => !socket.destroyed)).toBe(true);
  });
  test.each(["creating", "usable", "stopped"] as const)(
    "%s with admitted running intent carries CONNECT before readiness and clears only establishment timers",
    async (phase) => {
      const fixture = await localFixture(state);
      fixture.space.phase = phase;
      await fixture.records.put(fixture.space);
      const framed = new Set<Socket>();
      const setTimeout = Socket.prototype.setTimeout;
      jest.spyOn(Socket.prototype, "setTimeout").mockImplementation(function (
        this: Socket,
        milliseconds,
        callback,
      ) {
        if (milliseconds === 5000) framed.add(this);
        return setTimeout.call(this, milliseconds, callback);
      });
      const peers = new Set<Socket>();
      const remote = createServer((socket) => {
        peers.add(socket);
        socket.once("close", () => peers.delete(socket));
        socket.on("data", (bytes) => socket.write(bytes));
      });
      remote.listen(0, "127.0.0.1");
      await once(remote, "listening");
      const remotePort = (remote.address() as { port: number }).port;
      closers.push(
        () =>
          new Promise<void>((done) => {
            for (const peer of peers) peer.destroy();
            remote.close(() => done());
          }),
      );
      let upstream!: Socket;
      let pendingTimeout: number | undefined;
      const broker = await startBroker({
        authorize: (header) => fixture.records.authorize(header),
        budget: new NetworkBudget(),
        resolve: async () => [{ address: "8.8.8.8", family: 4 }],
        dial: (target) => {
          upstream = connect({ host: "127.0.0.1", port: remotePort });
          Object.defineProperty(upstream, "remoteAddress", { get: () => target.address });
          upstream.prependOnceListener("connect", () => {
            pendingTimeout = upstream.timeout;
          });
          return upstream;
        },
        git: async (_request, response) => {
          response.end();
        },
        onFault: () => {},
      });
      closers.push(broker.close);
      const tunnel = await startBrokerTunnel(broker.port);
      closers.push(tunnel.close);
      const client = connect({ host: "127.0.0.1", port: tunnel.port });
      client.on("error", () => {});
      try {
        await once(client, "connect");
        const established = once(client, "data");
        client.write(
          `${BROKER_PREFACE}CONNECT packages.example.com:443 HTTP/1.1\r\nHost: packages.example.com\r\nProxy-Authorization: ${fixture.authorization}\r\n\r\n`,
        );
        expect((await established)[0].toString()).toContain("200 Connection Established");
        expect(pendingTimeout).toBe(15_000);
        expect({
          upstream: upstream.timeout,
          framed: [...framed].map((socket) => socket.timeout),
        }).toEqual({ upstream: 0, framed: [0] });
        const reply = once(client, "data");
        const bytes = Buffer.from([0, 255, 65, 13, 10]);
        client.write(bytes);
        expect((await reply)[0]).toEqual(bytes);
      } finally {
        client.destroy();
      }
    },
  );

  test.each([
    "stopped intent",
    "deleted intent",
    "failed",
    "deleting",
    "deleted",
    "unknown guest",
    "incomplete setup",
    "missing runtime",
    "bad token",
    "revoked repository",
    "renamed repository",
    "disabled policy",
  ])("resume CONNECT refuses %s before opening an upstream", async (reason) => {
    const fixture = await localFixture(state);
    fixture.space.phase = "stopped";
    let authorization = fixture.authorization;
    if (reason === "stopped intent") fixture.space.desiredState = "stopped";
    else if (reason === "deleted intent") fixture.space.desiredState = "deleted";
    else if (reason === "failed" || reason === "deleting" || reason === "deleted")
      fixture.space.phase = reason;
    else if (reason === "unknown guest") fixture.space.failure = "LOCAL_GUEST_SETTLEMENT_UNKNOWN";
    else if (reason === "incomplete setup") fixture.space.lastStartedAt = null;
    else if (reason === "missing runtime") fixture.space.runtimeId = null;
    else if (reason === "bad token")
      authorization = `Basic ${Buffer.from(`${fixture.space.id}:${"c".repeat(64)}`).toString("base64")}`;
    else if (reason === "revoked repository") fixture.policy.repositories = [];
    else if (reason === "renamed repository")
      fixture.space.admittedRepositoryFullName = "owner/previous";
    else if (reason === "disabled policy") fixture.policy.enabled = false;
    await fixture.records.put(fixture.space);
    await state.write("policy.json", fixture.policy);
    const dial = jest.fn(() => {
      throw new Error("Refused resume reached the upstream dialer");
    });
    const broker = await startBroker({
      authorize: (header) => fixture.records.authorize(header),
      budget: new NetworkBudget(),
      resolve: async () => [{ address: "8.8.8.8", family: 4 }],
      dial,
      git: async (_request, response) => {
        response.end();
      },
      onFault: () => {},
    });
    closers.push(broker.close);
    expect(
      await exchange(
        broker.port,
        `CONNECT packages.example.com:443 HTTP/1.1\r\nHost: packages.example.com\r\nProxy-Authorization: ${authorization}\r\n\r\n`,
      ),
    ).toContain("403 Forbidden");
    expect(dial).not.toHaveBeenCalled();
    expect(await fixture.records.get(fixture.space.id)).toEqual(fixture.space);
    expect(await fixture.records.policy()).toEqual(fixture.policy);
  });

  test("a stalled CONNECT retains its finite timeout and releases admission for the next connection", async () => {
    const fixture = await localFixture(state);
    let upstream!: Socket;
    let dialed!: () => void;
    const admitted = new Promise<void>((done) => {
      dialed = done;
    });
    const budget = new NetworkBudget();
    const broker = await startBroker({
      authorize: (header) => fixture.records.authorize(header),
      budget,
      resolve: async () => [{ address: "8.8.8.8", family: 4 }],
      dial: () => {
        upstream = new Socket();
        dialed();
        return upstream;
      },
      git: async (_request, response) => {
        response.end("next-admitted");
      },
      onFault: () => {},
    });
    closers.push(broker.close);
    const client = connect({ host: "127.0.0.1", port: broker.port });
    client.on("error", () => {});
    try {
      await once(client, "connect");
      client.write(
        `CONNECT packages.example.com:443 HTTP/1.1\r\nHost: packages.example.com\r\nProxy-Authorization: ${fixture.authorization}\r\n\r\n`,
      );
      await admitted;
      expect(upstream.timeout).toBe(15_000);
      const closed = once(client, "close");
      // Control the timer event, not the admission or actual socket cleanup.
      upstream.emit("timeout");
      await closed;
      expect(upstream.destroyed).toBe(true);
      const reservation = await budget.reserve(fixture.policy);
      await reservation.release();
    } finally {
      client.destroy();
      upstream?.destroy();
    }
  });
  test("automatic startup reclaims a dead runner and dead guard without replaying retained work", async () => {
    const fixture = await localFixture(state);
    const deadPid = await exitedPid();
    await writeFile(join(root, "runner.lock"), String(deadPid), { mode: 0o600 });
    await state.write("runtime-owner.json", {
      owner: randomUUID(),
      ownerPID: deadPid,
      profile: localRuntimeProfileHash(fixture.policy),
      settled: false,
    });
    const retained = { state: "running", remoteMarker: "retained-unknown-operation" };
    await state.write("job-retained.json", retained);
    let ownerStarts = 0;
    const manager = new LocalManager(fixture.records, {
      storage: async () => {},
      guard: async () => {
        ownerStarts++;
        return {
          active: true,
          stop: async () => {},
          observe: async () => [],
          retire: async () => {},
          remove: async () => {},
          space: async () => {
            throw Error("Startup must not replay guest work");
          },
        };
      },
    });
    closers.push(() => manager.close());
    await Promise.all([manager.holdRunnerLock(), manager.holdRunnerLock()]);
    await manager.open();
    expect(ownerStarts).toBe(1);
    expect(JSON.parse(await readFile(join(root, "runner.lock"), "utf8"))).toEqual({
      pid: process.pid,
      boot: await hostBootIdentity(),
    });
    expect(await state.read("job-retained.json", (value) => value)).toEqual(retained);
    expect(await fixture.records.get(fixture.space.id)).toEqual({
      ...fixture.space,
      admittedMachine: {
        cpuCores: fixture.policy.runtime.cpuCores,
        memoryBytes: fixture.policy.runtime.memoryBytes,
        dockerBytes: fixture.policy.runtime.dockerBytes,
      },
      admittedRepositoryFullName: fixture.policy.repositories[0].fullName,
    });
    expect(await fixture.records.policy()).toEqual(fixture.policy);
    await expect(state.lock()).rejects.toMatchObject({ code: "LOCAL_ALREADY_RUNNING" });
    await manager.close();
    const release = await state.lock();
    await release();
  });

  test.each(
    ["replace", "release"].flatMap((operation) =>
      ["dead", "live", "stopping", "unknown", "missing", "profile"].map((reason) => ({
        operation,
        reason,
      })),
    ),
  )(
    "cached inactive guard $operation preserves surviving work and fences $reason ownership",
    async ({ operation, reason }) => {
      const fixture = await localFixture(state);
      const peer = spawn(process.execPath, ["-e", "process.stdin.pipe(process.stdout)"], {
        stdio: ["pipe", "pipe", "ignore"],
      });
      const guards: ReturnType<typeof spawn>[] = [];
      closers.push(async () => {
        for (const child of [...guards, peer]) {
          if (child.exitCode === null && child.signalCode === null) {
            const ended = once(child, "close");
            child.kill("SIGTERM");
            await ended;
          }
        }
      });
      const echo = async (value: string) => {
        const reply = once(peer.stdout!, "data");
        peer.stdin!.write(value);
        expect(String((await reply)[0])).toBe(value);
      };
      const profile = localRuntimeProfileHash(fixture.policy);
      let retiring = false,
        cleaning = false;
      const manager = new LocalManager(fixture.records, {
        storage: async () => {},
        guard: async () => {
          // New admission must retain the actual physical runner gate.
          await expect(state.lock()).rejects.toMatchObject({ code: "LOCAL_ALREADY_RUNNING" });
          const child = spawn(
            process.execPath,
            ["-e", "process.stdout.write('ready');setInterval(()=>{},1000)"],
            {
              stdio: ["ignore", "pipe", "ignore"],
            },
          );
          guards.push(child);
          await once(child.stdout!, "data");
          await state.write("runtime-owner.json", {
            owner: randomUUID(),
            ownerPID: child.pid!,
            profile,
            settled: false,
          });
          return {
            get active() {
              return !retiring && child.exitCode === null && child.signalCode === null;
            },
            stop: async () => {
              if (child.exitCode !== null || child.signalCode !== null)
                throw new LocalRefusal(
                  "LOCAL_STOP_PENDING",
                  "The old guard did not settle physical work.",
                );
              throw new Error("Observation replacement must not stop surviving work");
            },
            release: async () => {
              if (!cleaning && (child.exitCode !== null || child.signalCode !== null))
                throw new LocalRefusal(
                  "LOCAL_STOP_PENDING",
                  "The old guard exited without a release acknowledgement.",
                );
            },
            observe: async () => [
              { id: fixture.space.runtimeId!, name: fixture.space.name, status: "running" },
            ],
            retire: async () => {},
            remove: async () => {},
            space: async () => {
              throw Error("Observation must not replay guest work");
            },
          };
        },
      });
      closers.push(async () => {
        cleaning = true;
        retiring = false;
        await state.write("runtime-owner.json", {
          owner: randomUUID(),
          ownerPID: guards.at(-1)!.pid!,
          profile,
          settled: false,
        });
        await manager.release();
      });
      await manager.open();
      const admitted = await fixture.records.get(fixture.space.id);
      expect(admitted).toEqual({
        ...fixture.space,
        admittedMachine: {
          cpuCores: fixture.policy.runtime.cpuCores,
          memoryBytes: fixture.policy.runtime.memoryBytes,
          dockerBytes: fixture.policy.runtime.dockerBytes,
        },
        admittedRepositoryFullName: fixture.policy.repositories[0].fullName,
      });
      const retained = Buffer.from('{"state":"running","command":"original-only"}');
      await writeFile(join(root, "job-retained.json"), retained, { mode: 0o600 });
      await echo("before-owner-loss");
      const first = guards[0];
      if (reason === "stopping") retiring = true;
      else {
        const ended = once(first, "close");
        first.kill("SIGTERM");
        await ended;
      }
      const receipt = await state.read(
        "runtime-owner.json",
        (value) => value as Record<string, unknown>,
      );
      if (reason === "live") receipt!.ownerPID = process.pid;
      if (reason === "unknown") delete receipt!.ownerPID;
      if (reason === "profile") receipt!.profile = "f".repeat(64);
      if (reason === "missing") await state.remove("runtime-owner.json");
      else await state.write("runtime-owner.json", receipt);
      const before = await state.read("runtime-owner.json", (value) => value);
      const observe = () => (operation === "replace" ? manager.snapshot() : manager.release());
      if (reason === "dead") {
        if (operation === "replace") {
          const snapshot = await manager.snapshot();
          expect(snapshot.spaces[0]).toMatchObject({ state: "running", failure: null });
          expect(guards).toHaveLength(2);
          expect(await state.read("runtime-owner.json", (value) => value)).toMatchObject({
            ownerPID: guards[1].pid,
          });
        } else {
          const broker = await state.read("broker.json", (value) => value as { port: number });
          await manager.release();
          expect(guards).toHaveLength(1);
          const release = await state.lock();
          await release();
          const listener = createServer();
          await new Promise<void>((resolve, reject) => {
            listener.once("error", reject);
            listener.listen(broker!.port, "127.0.0.1", resolve);
          });
          await new Promise<void>((resolve) => listener.close(() => resolve()));
          expect(await state.read("runtime-owner.json", (value) => value)).toEqual(before);
        }
      } else {
        await expect(observe()).rejects.toMatchObject({
          code:
            reason === "profile" || reason === "missing"
              ? "LOCAL_RUNTIME_CHANGED"
              : "LOCAL_OWNER_ACTIVE",
        });
        expect(guards).toHaveLength(1);
        expect(await state.read("runtime-owner.json", (value) => value)).toEqual(before);
        await expect(state.lock()).rejects.toMatchObject({ code: "LOCAL_ALREADY_RUNNING" });
      }
      await echo("after-owner-loss");
      expect(await readFile(join(root, "job-retained.json"))).toEqual(retained);
      expect(await fixture.records.get(fixture.space.id)).toEqual(admitted);
      expect(await fixture.records.policy()).toEqual(fixture.policy);
    },
  );

  test.each(["live-runner", "live-guard", "unknown-guard", "invalid-receipt", "invalid-marker"])(
    "automatic startup refuses %s without admitting an owner or changing saved work",
    async (reason) => {
      const fixture = await localFixture(state);
      const deadPid = await exitedPid();
      const marker =
        reason === "live-runner"
          ? String(process.pid)
          : reason === "invalid-marker"
            ? "unknown"
            : String(deadPid);
      await writeFile(join(root, "runner.lock"), marker, { mode: 0o600 });
      const receipt =
        reason === "invalid-receipt"
          ? { malformed: true }
          : {
              owner: randomUUID(),
              ...(reason === "unknown-guard"
                ? {}
                : { ownerPID: reason === "live-guard" ? process.pid : deadPid }),
              profile: "a".repeat(64),
              settled: false,
            };
      await state.write("runtime-owner.json", receipt);
      let ownerStarts = 0;
      const manager = new LocalManager(fixture.records, {
        storage: async () => {},
        guard: async () => {
          ownerStarts++;
          throw Error("Unsafe startup reached owner admission");
        },
      });
      closers.push(() => manager.close());
      await expect(manager.open()).rejects.toMatchObject({
        code:
          reason === "live-runner"
            ? "LOCAL_ALREADY_RUNNING"
            : reason.startsWith("invalid-")
              ? "LOCAL_STATE_UNSAFE"
              : "LOCAL_OWNER_ACTIVE",
      });
      expect(ownerStarts).toBe(0);
      expect(await state.read("runtime-owner.json", (value) => value)).toEqual(receipt);
      expect(await fixture.records.get(fixture.space.id)).toEqual(fixture.space);
      expect(await fixture.records.policy()).toEqual(fixture.policy);
      const remainingMarker = await readFile(join(root, "runner.lock"), "utf8").catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return null;
          throw error;
        },
      );
      expect(remainingMarker).toBe(
        reason === "live-runner" || reason === "invalid-marker" ? marker : null,
      );
    },
  );

  test("broker shutdown waits for outstanding authority checks without traffic accounting", async () => {
    const fixture = await localFixture(state);
    let enterCheck!: () => void;
    let finishCheck!: () => void;
    const entered = new Promise<void>((resolve) => {
      enterCheck = resolve;
    });
    const held = new Promise<void>((resolve) => {
      finishCheck = resolve;
    });
    const budget = new NetworkBudget();
    const broker = await startBroker({
      authorize: async (header) => {
        enterCheck();
        await held;
        return fixture.records.authorize(header);
      },
      budget,
      git: async (_request, response) => {
        response.end();
      },
      onFault: () => {},
    });
    closers.push(broker.close);
    const client = connect({ host: "127.0.0.1", port: broker.port });
    client.on("error", () => {});
    await new Promise<void>((resolve) => client.once("connect", resolve));
    client.write(
      `CONNECT packages.example.com:443 HTTP/1.1\r\nHost: packages.example.com\r\nProxy-Authorization: ${fixture.authorization}\r\n\r\n`,
    );
    await entered;
    let closed = false;
    const closing = broker.close().then(() => {
      closed = true;
    });
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(closed).toBe(false);
    } finally {
      finishCheck();
      await closing;
      client.destroy();
    }
    expect(await state.read("network-budget.json", (value) => value)).toBeNull();
  });

  test("broker and fixed tunnel repeat and concurrent close settle the actual listeners", async () => {
    const fixture = await localFixture(state);
    const broker = await startBroker({
      authorize: (header) => fixture.records.authorize(header),
      budget: new NetworkBudget(),
      git: async (_request, response) => {
        response.end();
      },
      onFault: () => {},
    });
    const tunnel = await startBrokerTunnel(broker.port);
    closers.push(broker.close, tunnel.close);
    await Promise.all([tunnel.close(), tunnel.close(), broker.close(), broker.close()]);
    await tunnel.close();
    await broker.close();
    for (const port of [broker.port, tunnel.port]) {
      const probe = createServer();
      await new Promise<void>((resolve, reject) => {
        probe.once("error", reject);
        probe.listen(port, "127.0.0.1", resolve);
      });
      await new Promise<void>((resolve, reject) =>
        probe.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  test("manager close then refused reopen preserves the initial reason and releases its runner lock", async () => {
    const fixture = await localFixture(state);
    let refuse = false;
    const original = new LocalRefusal(
      "LOCAL_NETWORK_UNSAFE",
      "Controlled invalid network baseline",
    );
    class ExternalRuntime extends SbxRuntime {
      override async verifySettings() {
        if (refuse) throw original;
      }
    }
    const manager = new LocalManager(fixture.records, {
      storage: async () => {},
      runtime: (policy) => adaptSbxRuntime(new ExternalRuntime(policy)),
      guard: async () => ({
        active: true,
        stop: async () => {},
        release: async () => {},
        observe: async () => [],
        retire: async () => {},
        remove: async () => {},
        space: async () => {
          throw Error("No VM work expected");
        },
      }),
    });
    closers.push(() => manager.close());
    await manager.open();
    await manager.close();
    refuse = true;
    await expect(manager.open()).rejects.toBe(original);
    const release = await state.lock();
    await release();
    refuse = false;
    await manager.open();
    await manager.close();
    await manager.close();
    const unlocked = await state.lock();
    await unlocked();
  });

  test("fixed-service framing and a valid local grant are both required", async () => {
    const fixture = await localFixture(state);
    let authorized = 0;
    const broker = await startBroker({
      authorize: (header) => fixture.records.authorize(header),
      budget: new NetworkBudget(),
      git: async (_request, response, grant) => {
        authorized++;
        response.end(grant.repository.fullName);
      },
      onFault: () => undefined,
    });
    closers.push(broker.close);
    const tunnel = await startBrokerTunnel(broker.port);
    closers.push(tunnel.close);
    const get = `GET /git/owner/project.git/info/refs?service=git-upload-pack HTTP/1.1\r\nHost: moira-local\r\nConnection: close\r\n`;
    expect(await exchange(tunnel.port, `${get}\r\n`)).toBe("");
    expect(await exchange(tunnel.port, `${BROKER_PREFACE}${get}\r\n`)).toContain(
      "401 Unauthorized",
    );
    expect(
      await exchange(
        tunnel.port,
        `${BROKER_PREFACE}${get}Authorization: ${fixture.authorization}\r\n\r\n`,
      ),
    ).toContain("owner/project");
    expect(authorized).toBe(1);
    fixture.policy.enabled = false;
    await state.write("policy.json", fixture.policy);
    expect(
      await exchange(
        tunnel.port,
        `${BROKER_PREFACE}${get}Authorization: ${fixture.authorization}\r\n\r\n`,
      ),
    ).toContain("403 Forbidden");
    expect(authorized).toBe(1);
  });

  test("a name resolving to host, private or mixed addresses cannot open an upstream socket", async () => {
    const fixture = await localFixture(state);
    let dials = 0;
    let addresses = [{ address: "127.0.0.1", family: 4 as const }];
    const broker = await startBroker({
      authorize: (header) => fixture.records.authorize(header),
      budget: new NetworkBudget(),
      resolve: async () => addresses,
      dial: () => {
        dials++;
        throw new Error("A denied destination reached the dialer");
      },
      git: async (_request, response) => {
        response.end();
      },
      onFault: () => undefined,
    });
    closers.push(broker.close);
    const request = `CONNECT packages.example.com:443 HTTP/1.1\r\nHost: packages.example.com\r\nProxy-Authorization: ${fixture.authorization}\r\n\r\n`;
    expect(await exchange(broker.port, request)).toContain("502 Bad Gateway");
    addresses = [
      { address: "8.8.8.8", family: 4 },
      { address: "169.254.169.254", family: 4 },
    ];
    expect(await exchange(broker.port, request)).toContain("502 Bad Gateway");
    expect(dials).toBe(0);
    expect(
      await exchange(broker.port, request.replace("packages.example.com:443", "localhost:443")),
    ).toContain("502 Bad Gateway");
    expect(dials).toBe(0);
  });

  test.each(["revoked"] as const)(
    "the validated address is used once and active access is cut when locally %s",
    async (reason) => {
      const fixture = await localFixture(state);
      const peers = new Set<Socket>();
      const remote = createServer((socket) => {
        peers.add(socket);
        socket.once("close", () => peers.delete(socket));
        socket.on("data", (bytes) => socket.write(bytes));
      });
      await new Promise<void>((resolve) => remote.listen(0, "127.0.0.1", resolve));
      const remotePort = (remote.address() as { port: number }).port;
      closers.push(
        () =>
          new Promise<void>((resolve) => {
            for (const peer of peers) peer.destroy();
            remote.close(() => resolve());
          }),
      );
      let lookups = 0;
      const destinations: string[] = [];
      const broker = await startBroker({
        authorize: (header) => fixture.records.authorize(header),
        budget: new NetworkBudget(),
        resolve: async () => {
          lookups++;
          return [{ address: "8.8.8.8", family: 4 }];
        },
        // Substitute only the external network endpoint; production still dials the pinned public IP.
        dial: (target, port) => {
          destinations.push(`${target.address}:${port}`);
          const socket = connect({ host: "127.0.0.1", port: remotePort });
          Object.defineProperty(socket, "remoteAddress", { get: () => target.address });
          return socket;
        },
        git: async (_request, response) => {
          response.end();
        },
        onFault: () => undefined,
      });
      closers.push(broker.close);
      const client = connect({ host: "127.0.0.1", port: broker.port });
      const received: Buffer[] = [];
      client.on("data", (chunk) => received.push(chunk));
      client.on("error", () => undefined);
      await new Promise<void>((resolve) => client.once("connect", resolve));
      client.write(
        `CONNECT packages.example.com:443 HTTP/1.1\r\nHost: packages.example.com\r\nProxy-Authorization: ${fixture.authorization}\r\n\r\n`,
      );
      await new Promise<void>((resolve) => client.once("data", () => resolve()));
      client.write("guest-payload");
      await new Promise<void>((resolve) => client.once("data", () => resolve()));
      expect(Buffer.concat(received).toString()).toContain("guest-payload");
      expect(destinations).toEqual(["8.8.8.8:443"]);
      expect(lookups).toBe(1);
      // Controlled authority time crosses the former maximum. This observes
      // exact bytes on the established socket, without changing the Mac clock.
      jest.spyOn(Date, "now").mockReturnValue(Date.now() + 8 * 24 * 60 * 60_000);
      const later = once(client, "data");
      const binary = Buffer.from([0, 255, 128, 1]);
      client.write(binary);
      expect((await later)[0]).toEqual(binary);
      expect(await fixture.records.authorize(fixture.authorization)).not.toBeNull();
      fixture.policy.enabled = false;
      await state.write("policy.json", fixture.policy);
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          client.destroy();
          reject(new Error("Revocation did not close access"));
        }, 4000);
        client.once("close", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    },
  );
});
