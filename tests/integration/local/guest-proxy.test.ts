import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as http from "node:http";
import * as net from "node:net";
import { once } from "node:events";
import { PrivateState } from "../../../packages/local/src/private-state.js";
import { startBroker } from "../../../packages/local/src/broker.js";
import { startBrokerTunnel } from "../../../packages/local/src/broker-tunnel.js";
import { NetworkBudget } from "../../../packages/local/src/network-budget.js";
import { localFixture } from "./fixtures.js";

let proxyServer: http.Server;
// Substitute only guest DNS/host addressing. HTTP requests, sockets, broker framing and
// authorization remain real. A phantom direct connection is refused without external DNS.
jest.unstable_mockModule("node:http", () => ({
  ...http,
  createServer: (...args: Parameters<typeof http.createServer>) => {
    proxyServer = http.createServer(...args);
    return proxyServer;
  },
  request: (options: http.RequestOptions, callback?: (response: http.IncomingMessage) => void) =>
    http.request(
      {
        ...options,
        lookup: (_host, _options, ready) =>
          ready(
            Object.assign(new Error("Controlled phantom lookup refused"), { code: "ENOTFOUND" }),
            "",
            4,
          ),
      },
      callback,
    ),
}));
jest.unstable_mockModule("node:net", () => ({
  ...net,
  connect: (options: net.TcpNetConnectOpts) => {
    if (options.host !== "host.docker.internal")
      throw new Error("Unexpected guest tunnel destination");
    return net.connect({ ...options, host: "127.0.0.1" });
  },
}));
const { serveGuestProxy } = await import("../../../packages/local/src/guest-proxy.js");

let root: string;
const closers: Array<() => Promise<void>> = [];
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "moira-local-guest-proxy-")));
});
afterEach(async () => {
  for (const close of closers.reverse()) await close();
  closers.length = 0;
  await rm(root, { recursive: true, force: true });
});

async function fixture() {
  const state = await PrivateState.open(root);
  const local = await localFixture(state);
  const broker = await startBroker({
    authorize: (header) => local.records.authorize(header),
    budget: new NetworkBudget(state),
    git: async (request, response, grant) => {
      const chunks: Buffer[] = [];
      for await (const bytes of request) chunks.push(Buffer.from(bytes));
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          repository: grant.repository.fullName,
          method: request.method,
          path: request.url,
          bodyBase64: Buffer.concat(chunks).toString("base64"),
        }),
      );
    },
    onFault: () => undefined,
  });
  closers.push(broker.close);
  const tunnel = await startBrokerTunnel(broker.port);
  closers.push(tunnel.close);
  const closeProxy = await serveGuestProxy(tunnel.port, 0);
  const server = proxyServer;
  closers.push(async () => {
    const stopped = once(server, "close");
    closeProxy();
    await stopped;
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Proxy did not listen on its ephemeral port");
  return { ...local, state, port: address.port };
}

function exchange(port: number, path: string, authorization?: string, body?: Buffer) {
  return new Promise<{ status: number; body: Buffer }>((resolve, reject) => {
    const request = http.request(
      {
        host: "127.0.0.1",
        port,
        path,
        method: body ? "POST" : "GET",
        agent: false,
        headers: {
          connection: "close",
          ...(authorization ? { authorization } : {}),
          ...(body ? { "content-length": body.length } : {}),
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (bytes) => chunks.push(Buffer.from(bytes)));
        response.once("error", reject);
        response.once("end", () =>
          resolve({ status: response.statusCode!, body: Buffer.concat(chunks) }),
        );
      },
    );
    request.setTimeout(3000, () =>
      request.destroy(new Error("Guest HTTP response did not settle")),
    );
    request.once("error", reject);
    request.end(body);
  });
}

describe("guest HTTP forwarding through the fixed broker tunnel", () => {
  test("approved Git GET query and POST binary body reach the broker without phantom DNS", async () => {
    const local = await fixture();
    const path = "/git/owner/project.git/info/refs?service=git-upload-pack";
    const response = await exchange(local.port, path, local.authorization);
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body.toString())).toEqual({
      repository: "owner/project",
      method: "GET",
      path,
      bodyBase64: "",
    });
    const payload = Buffer.from([0, 255, 13, 10, 65]);
    const upload = await exchange(
      local.port,
      "/git/owner/project.git/git-upload-pack",
      local.authorization,
      payload,
    );
    expect(upload.status).toBe(200);
    expect(JSON.parse(upload.body.toString())).toEqual({
      repository: "owner/project",
      method: "POST",
      path: "/git/owner/project.git/git-upload-pack",
      bodyBase64: payload.toString("base64"),
    });
  });

  test("the same HTTP tunnel preserves missing-auth and locally revoked refusals", async () => {
    const local = await fixture();
    const path = "/git/owner/project.git/info/refs?service=git-upload-pack";
    expect((await exchange(local.port, path)).status).toBe(401);
    local.policy.enabled = false;
    await local.state.write("policy.json", local.policy);
    expect((await exchange(local.port, path, local.authorization)).status).toBe(403);
  });
});
