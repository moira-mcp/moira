import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";
import { mkdtemp, rm, realpath, stat } from "node:fs/promises";
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

describe("local broker authority and address boundary", () => {
  test.each(["reservation", "release"] as const)(
    "broker shutdown waits for the final %s ledger write",
    async (phase) => {
      const fixture = await localFixture(state);
      const budget = new NetworkBudget(state);
      let enterWrite!: () => void;
      let releaseWrite!: () => void;
      const entered = new Promise<void>((resolve) => {
        enterWrite = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        releaseWrite = resolve;
      });
      const write = state.write.bind(state);
      let ledgerWrites = 0;
      const spy = jest.spyOn(state, "write").mockImplementation(async (key, value) => {
        if (key === "network-budget.json") {
          ledgerWrites++;
          if (ledgerWrites === (phase === "reservation" ? 1 : 2)) {
            enterWrite();
            await gate;
          }
        }
        await write(key, value);
      });
      let lookups = 0;
      const faults: unknown[] = [];
      const broker = await startBroker({
        authorize: (header) => fixture.records.authorize(header),
        budget,
        resolve: async () => {
          lookups++;
          return [{ address: "127.0.0.1", family: 4 }];
        },
        git: async (_request, response) => {
          response.end();
        },
        onFault: (error) => faults.push(error),
      });
      closers.push(broker.close);
      const client = connect({ host: "127.0.0.1", port: broker.port });
      client.on("error", () => undefined);
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
        // A complete event-loop turn lets listener/socket closure settle while the
        // deliberately held filesystem operation remains unfinished.
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(closed).toBe(false);
      } finally {
        releaseWrite();
        await closing;
        client.destroy();
        spy.mockRestore();
      }
      expect(ledgerWrites).toBe(2);
      expect(lookups).toBe(phase === "reservation" ? 0 : 1);
      expect(await state.read("network-budget.json", (value) => value)).toEqual({
        leaseUntil: fixture.policy.leaseUntil,
        spent: 0,
      });
      expect(faults).toEqual([]);
      await rm(root, { recursive: true, force: true });
      await expect(stat(root)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  test("broker and fixed tunnel repeat and concurrent close settle the actual listeners", async () => {
    const fixture = await localFixture(state);
    const broker = await startBroker({
      authorize: (header) => fixture.records.authorize(header),
      budget: new NetworkBudget(state),
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
      budget: new NetworkBudget(state),
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
      budget: new NetworkBudget(state),
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
      budget: new NetworkBudget(state),
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
