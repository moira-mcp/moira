import { afterAll, beforeAll, describe, expect, test } from "@jest/globals";
import * as fs from "fs";
import * as http from "http";
import * as os from "os";
import * as path from "path";
import { startExtensionRunner, type RunningRunner } from "@mcp-moira/extension-runner";
import { HttpExtensionRunnerClient, type ExtensionManifest } from "@mcp-moira/workflow-engine";

const SOURCE = path.resolve(process.cwd(), "examples/extensions/webhook-notify");
let temporaryRoot: string;
let receiver: http.Server;
let runner: RunningRunner;
let client: HttpExtensionRunnerClient;
let received: { url: string; authorization?: string; body: unknown } | undefined;

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("missing address"));
      resolve(address.port);
    });
  });
}

function close(server: http.Server | undefined): Promise<void> {
  if (!server) return Promise.resolve();
  return new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

beforeAll(async () => {
  receiver = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      received = {
        url: request.url ?? "",
        authorization: request.headers.authorization,
        body,
      };
      if ((body as { channel?: string }).channel === "rate-limited") {
        response.writeHead(429, { "retry-after": "17" });
        response.end();
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ message_id: 4242 }));
    });
  });
  const port = await listen(receiver);

  temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "moira-webhook-notify-example-"));
  fs.symlinkSync(
    path.resolve(process.cwd(), "node_modules"),
    path.join(temporaryRoot, "node_modules"),
  );
  const installed = path.join(temporaryRoot, "webhook-notify");
  fs.cpSync(SOURCE, installed, { recursive: true });
  const manifestPath = path.join(installed, "moira-extension.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as ExtensionManifest;
  manifest.permissions = { ...manifest.permissions, network: [`127.0.0.1:${port}`] };
  manifest.communicationChannels![0].permissions = {
    ...manifest.communicationChannels![0].permissions,
    network: [`127.0.0.1:${port}`],
  };
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  runner = await startExtensionRunner({
    extensionsDir: temporaryRoot,
    port: 0,
    host: "127.0.0.1",
    execArgv: ["--import", "tsx"],
  });
  client = new HttpExtensionRunnerClient({ baseUrl: `http://127.0.0.1:${runner.port}` });
}, 60_000);

afterAll(async () => {
  await runner?.close();
  await close(receiver);
  if (temporaryRoot) fs.rmSync(temporaryRoot, { recursive: true, force: true });
});

function invoke(channel: string) {
  const receiverAddress = receiver.address();
  if (!receiverAddress || typeof receiverAddress === "string") throw new Error("receiver stopped");
  return client.invoke({
    nodeType: "webhook-notify.post-message",
    nodeId: "notify",
    executionId: "example-execution",
    workflowId: "example-workflow",
    config: { text: "deploy finished", channel, threadId: "release-7" },
    secrets: {
      "webhook-notify.token": "local-test-token",
      "webhook-notify.base_url": `http://127.0.0.1:${receiverAddress.port}`,
      "webhook-notify.message_path": "/messages",
      "webhook-notify.auth_scheme": "Token",
    },
    timeoutMs: 5_000,
  });
}

describe("the installable webhook example", () => {
  test("the real runner loads it and returns the local receiver's message id", async () => {
    expect(runner.scan.rejected).toEqual([]);
    await expect(invoke("releases")).resolves.toEqual({ output: { messageId: "4242" } });
    expect(received).toEqual({
      url: "/messages",
      authorization: "Token local-test-token",
      body: {
        text: "deploy finished",
        channel: "releases",
        thread_id: "release-7",
      },
    });
  });

  test("the real runner preserves the example's named rate-limit failure", async () => {
    await expect(invoke("rate-limited")).rejects.toMatchObject({
      kind: "handler-error",
      message: "rate limited by the endpoint; retry after 17 s",
    });
  });

  test("the generic channel uses its configured recipient without caller selection", async () => {
    const receiverAddress = receiver.address();
    if (!receiverAddress || typeof receiverAddress === "string")
      throw new Error("receiver stopped");
    await expect(
      client.deliverCommunicationChannel!({
        channelId: "webhook-notify.notifications",
        timeoutMs: 5_000,
        message: { text: "generic notification" },
        settings: {
          "webhook-notify.enabled": true,
          "webhook-notify.base_url": `http://127.0.0.1:${receiverAddress.port}`,
          "webhook-notify.message_path": "/messages",
          "webhook-notify.auth_scheme": "Token",
          "webhook-notify.default_recipient": "configured-notifications",
        },
        secrets: { "webhook-notify.token": "local-test-token" },
      }),
    ).resolves.toBeUndefined();
    expect(received).toEqual({
      url: "/messages",
      authorization: "Token local-test-token",
      body: { text: "generic notification", channel: "configured-notifications" },
    });
  });
});
