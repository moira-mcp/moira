import { afterEach, beforeEach, describe, expect, test } from "@jest/globals";
import { mkdtemp, rm, realpath, writeFile, readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { connect, createServer, type Socket } from "node:net";
import { PrivateState } from "../../../packages/local/src/private-state.js";
import { startBroker } from "../../../packages/local/src/broker.js";
import { startBrokerTunnel, BROKER_PREFACE } from "../../../packages/local/src/broker-tunnel.js";
import { NetworkBudget } from "../../../packages/local/src/network-budget.js";
import { localFixture } from "./fixtures.js";
import { LocalManager } from "../../../packages/local/src/manager.js";
import { SbxRuntime } from "../../../packages/local/src/sbx-runtime.js";
import { adaptSbxRuntime } from "../../../packages/local/src/local-vm-runtime-factory.js";
import { LocalRefusal } from "../../../packages/local/src/policy.js";

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
  test("automatic startup reclaims a dead runner and dead guard without replaying retained work", async () => {
    const fixture = await localFixture(state);
    const deadPid = await exitedPid();
    await writeFile(join(root, "runner.lock"), String(deadPid), { mode: 0o600 });
    await state.write("runtime-owner.json", {
      owner: randomUUID(),
      ownerPID: deadPid,
      profile: "a".repeat(64),
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
    expect(await readFile(join(root, "runner.lock"), "utf8")).toBe(String(process.pid));
    expect(await state.read("job-retained.json", (value) => value)).toEqual(retained);
    expect(await fixture.records.get(fixture.space.id)).toEqual(fixture.space);
    expect(await fixture.records.policy()).toEqual(fixture.policy);
    await expect(state.lock()).rejects.toMatchObject({ code: "LOCAL_ALREADY_RUNNING" });
    await manager.close();
    const release = await state.lock();
    await release();
  });

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

  test("the validated address is used once and active access is cut when locally revoked", async () => {
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
  });
});
