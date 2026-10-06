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

async function fixture(publicTarget = false) {
  const state = await PrivateState.open(root);
  const local = await localFixture(state);
  const upstreamPeers = new Set<net.Socket>();
  const upstream = net.createServer((socket) => {
    upstreamPeers.add(socket);
    socket.once("close", () => upstreamPeers.delete(socket));
    socket.on("data", (bytes) => socket.write(bytes));
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const upstreamAddress = upstream.address();
  if (!upstreamAddress || typeof upstreamAddress === "string") throw new Error("No upstream");
  closers.push(
    () =>
      new Promise<void>((resolve, reject) => {
        for (const socket of upstreamPeers) socket.destroy();
        upstream.close((error) => (error ? reject(error) : resolve()));
      }),
  );
  const authorizations: string[] = [];
  const resolveTarget = jest.fn(async (_host: string) => [
    { address: publicTarget ? "93.184.216.34" : "127.0.0.1", family: 4 as const },
  ]);
  const broker = await startBroker({
    authorize: (header) => {
      authorizations.push(header);
      return local.records.authorize(header);
    },
    budget: new NetworkBudget(state),
    resolve: resolveTarget,
    dial: (target) => {
      const socket = net.connect({ host: "127.0.0.1", port: upstreamAddress.port });
      Object.defineProperty(socket, "remoteAddress", { get: () => target.address });
      return socket;
    },
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
  const closeProxy = await serveGuestProxy(tunnel.port, local.authorization, 0);
  const server = proxyServer;
  closers.push(async () => {
    const stopped = once(server, "close");
    closeProxy();
    await stopped;
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Proxy did not listen on its ephemeral port");
  return { ...local, state, port: address.port, authorizations, resolveTarget };
}

function connectStatus(port: number, target: string, proxyAuthorization?: string) {
  return new Promise<number>((resolve, reject) => {
    const request = http.request({
      host: "127.0.0.1",
      port,
      path: target,
      method: "CONNECT",
      agent: false,
      headers: proxyAuthorization ? { "proxy-authorization": proxyAuthorization } : {},
    });
    request.once("connect", (response, socket) => {
      socket.destroy();
      resolve(response.statusCode!);
    });
    request.once("error", reject);
    request.setTimeout(3000, () => request.destroy(new Error("CONNECT did not settle")));
    request.end();
  });
}
const foreignAuthorization = `Basic ${Buffer.from("another-space:another-token").toString("base64")}`;

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
  test.each([undefined, foreignAuthorization])(
    "CONNECT uses the installed space authority instead of client authorization %s",
    async (supplied) => {
      const local = await fixture(true);
      expect(await connectStatus(local.port, "packages.example.com:443", supplied)).toBe(200);
      expect(local.authorizations).toContain(local.authorization);
      expect(local.authorizations).not.toContain(foreignAuthorization);
      expect(await connectStatus(local.port, "unapproved.example:443", supplied)).toBe(502);
      local.policy.enabled = false;
      await local.state.write("policy.json", local.policy);
      expect(await connectStatus(local.port, "packages.example.com:443", supplied)).toBe(403);
    },
  );

  test("HTTP dependency requests without client proxy auth reach the installed grant and retain DNS checks", async () => {
    const local = await fixture();
    // The controlled private DNS answer is refused after authenticating, before any remote dial.
    expect((await exchange(local.port, "http://packages.example.com/package")).status).toBe(502);
    expect(local.authorizations).toContain(local.authorization);
    expect(local.resolveTarget).toHaveBeenCalledWith("packages.example.com");
    local.policy.enabled = false;
    await local.state.write("policy.json", local.policy);
    expect((await exchange(local.port, "http://packages.example.com/package")).status).toBe(403);
  });

  test.each(["", "Bearer wrong", "Basic invalid value"])(
    "refuses missing or invalid installed authorization before listening: %s",
    async (authorization) => {
      await expect(serveGuestProxy(3073, authorization, 0)).rejects.toThrow(
        "Invalid installed broker authorization",
      );
    },
  );

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
