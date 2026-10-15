import { afterEach, expect, test } from "@jest/globals";
import { createHash } from "node:crypto";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createConnection } from "node:net";
import { compileBinaryExtensionArtifact, scanExtensionBundles } from "@mcp-moira/extension-runner";
import { deliverOwnerExtension } from "../../packages/workspace-service/src/extension-owner.mjs";
import { binaryTransportSchema } from "@mcp-moira/workflow-engine/extensions/contract";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});
async function invocation() {
  const directory = await mkdtemp(join(tmpdir(), "owner-extension-"));
  directories.push(directory);
  const bundle = scanExtensionBundles(resolve("tests/fixtures/extension-bundles")).bundles.find(
    (bundle) => bundle.manifest.name === "channel-probe",
  )!;
  const artifact = await compileBinaryExtensionArtifact(bundle);
  const bytes = Buffer.from("streamed owner bytes\0🙂");
  let opened = 0,
    closed = 0,
    consumed = 0;
  return {
    directory,
    artifact,
    handlerHost: resolve("packages/extension-runner/src/binary-handler-host.mjs"),
    helperPath: resolve("packages/local/dist/process-group-helper"),
    channelId: "channel-probe.notifications",
    settings: {
      "channel-probe.destination": "configured",
      "channel-probe.enabled": true,
      "foreign.secret": "not-forwarded",
    },
    message: { text: "caption" },
    source: {
      metadata: {
        kind: "document" as const,
        filename: "report.bin",
        mimeType: "application/octet-stream",
        size: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      },
      async open() {
        opened++;
        return {
          stream: (async function* () {
            for (const byte of bytes) {
              consumed++;
              yield Buffer.from([byte]);
            }
          })(),
          async close() {
            closed++;
          },
          settled: Promise.resolve(),
        };
      },
    },
    observations: () => ({ opened, closed, consumed }),
    bytes,
  };
}

test("the installed compiled binary handler reads the real owner pipe, without secret or general fetch authority", async () => {
  const value = await invocation();
  const sends: unknown[] = [];
  await deliverOwnerExtension({
    ...value,
    async send(operation, controls) {
      sends.push({ operation, controls, read: value.observations().consumed });
      return { status: 200 };
    },
  });
  expect(sends).toEqual([
    { operation: "upload", controls: { caption: "caption" }, read: value.bytes.length },
  ]);
  expect(value.observations()).toEqual({ opened: 1, closed: 1, consumed: value.bytes.length });
});

test("an unresolved vendor stream keeps the owner invocation pending and preserves its actual failure", async () => {
  const value = await invocation();
  let entered!: () => void, release!: (value?: unknown) => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const held = new Promise((resolve) => {
    release = resolve;
  });
  let settled = false;
  const failure = Object.assign(new Error("retained vendor uncertainty"), {
    code: "OWNER_DELIVERY_UNCONFIRMED",
  });
  const pending = deliverOwnerExtension({
    ...value,
    async send() {
      entered();
      await held;
      throw failure;
    },
  }).finally(() => {
    settled = true;
  });
  await started;
  expect(settled).toBe(false);
  release();
  await expect(pending).rejects.toBe(failure);
  expect(value.observations().closed).toBe(1);
});

test("an altered artifact cannot execute the installed bundle or dispatch a vendor mutation", async () => {
  const value = await invocation();
  let sent = false;
  await expect(
    deliverOwnerExtension({
      ...value,
      artifact: { ...value.artifact, bytes: Buffer.from("foreign") },
      async send() {
        sent = true;
      },
    }),
  ).rejects.toThrow("artifact");
  expect(sent).toBe(false);
  expect(value.observations().opened).toBe(0);
});

test("the child starts handling a large source before the owner finishes reading it", async () => {
  const value = await invocation();
  const chunk = Buffer.alloc(64 * 1024, 97);
  const count = 512;
  let read = 0;
  let closed = false;
  const hash = createHash("sha256");
  for (let index = 0; index < count; index++) hash.update(chunk);
  let seen = 0;
  await deliverOwnerExtension({
    ...value,
    message: { text: "incremental" },
    source: {
      metadata: {
        ...value.source.metadata,
        size: chunk.length * count,
        sha256: hash.digest("hex"),
      },
      async open() {
        return {
          stream: (async function* () {
            for (let index = 0; index < count; index++) {
              read++;
              yield chunk;
            }
          })(),
          async close() {
            closed = true;
          },
          settled: Promise.resolve(),
        };
      },
    },
    async send() {
      seen = read;
      return { status: 200 };
    },
  });
  expect(seen).toBeGreaterThan(0);
  expect(seen).toBeLessThan(count);
  expect(read).toBe(count);
  expect(closed).toBe(true);
});

test("a handler result and closed byte pipe cannot certify an unsettled source", async () => {
  const value = await invocation();
  const originalOpen = value.source.open;
  let sourceClosed!: () => void;
  let settle!: () => void;
  const closed = new Promise<void>((resolve) => {
    sourceClosed = resolve;
  });
  const settled = new Promise<void>((resolve) => {
    settle = resolve;
  });
  value.source.open = async () => {
    const opened = await originalOpen();
    return {
      ...opened,
      settled,
      async close() {
        await opened.close();
        sourceClosed();
      },
    };
  };
  let returned = false;
  const pending = deliverOwnerExtension({
    ...value,
    async send() {
      return { status: 200 };
    },
  }).then(() => {
    returned = true;
  });
  await closed;
  expect(returned).toBe(false);
  settle();
  await pending;
  expect(returned).toBe(true);
});

test("fixed transport refuses field collisions and caller-selected authority", async () => {
  const manifest = JSON.parse(
    await readFile(
      resolve("tests/fixtures/extension-bundles/channel-extension/moira-extension.json"),
      "utf8",
    ),
  );
  const transport = manifest.communicationChannels[0].binaryTransport;
  expect(
    binaryTransportSchema.safeParse({
      ...transport,
      operations: [
        {
          ...transport.operations[0],
          recipient: { field: "file", setting: "channel-probe.destination" },
        },
      ],
    }).success,
  ).toBe(false);
  expect(
    binaryTransportSchema.safeParse({
      ...transport,
      operations: [{ ...transport.operations[0], headers: { authorization: "caller" } }],
    }).success,
  ).toBe(false);
});

test("an unresolved runtime import is refused as packaging, before any owner invocation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "extension-dynamic-"));
  directories.push(directory);
  const manifest = JSON.parse(
    await readFile(
      resolve("tests/fixtures/extension-bundles/channel-extension/moira-extension.json"),
      "utf8",
    ),
  );
  const entrypoint = join(directory, "index.mjs");
  await writeFile(
    entrypoint,
    "export default {communicationChannels:[]}; export async function unresolved(name){return import(name)}",
  );
  await expect(
    compileBinaryExtensionArtifact({ directory, entrypoint, manifest }),
  ).rejects.toThrow();
});

test("a handler result settles its surviving descendant transport before delivery returns", async () => {
  const value = await invocation();
  let port = 0;
  const connect = () =>
    new Promise<string>((resolve, reject) => {
      const socket = createConnection({ host: "127.0.0.1", port });
      let bytes = "";
      socket.on("data", (chunk) => {
        bytes += chunk.toString();
      });
      socket.once("error", reject);
      socket.once("end", () => resolve(bytes));
    });
  await deliverOwnerExtension({
    ...value,
    message: { text: "descendant" },
    async send(_operation, controls) {
      port = Number(controls.caption);
      expect(await connect()).toBe("owned");
      return { status: 200 };
    },
  });
  await expect(connect()).rejects.toMatchObject({ code: "ECONNREFUSED" });
});
