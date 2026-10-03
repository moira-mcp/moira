import { afterEach, beforeEach, describe, expect, test } from "@jest/globals";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { connect, createServer, type Socket } from "node:net";
import { PrivateState } from "../../../packages/local/src/private-state.js";
import { startBroker } from "../../../packages/local/src/broker.js";
import { startBrokerTunnel, BROKER_PREFACE } from "../../../packages/local/src/broker-tunnel.js";
import { NetworkBudget } from "../../../packages/local/src/network-budget.js";
import { localFixture } from "./fixtures.js";

let root: string;
let state: PrivateState;
const closers: Array<() => Promise<void>> = [];
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "moira-local-broker-"));
  state = await PrivateState.open(root);
});
afterEach(async () => {
  for (const close of closers.reverse()) await close();
  closers.length = 0;
  await new Promise((resolve) => setTimeout(resolve, 30));
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
