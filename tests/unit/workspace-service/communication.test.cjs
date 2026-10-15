const { test, expect, afterEach } = require("@jest/globals");
const { mkdtemp, realpath, rm, readdir, readFile, lstat } = require("node:fs/promises");
const { watch } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { randomUUID } = require("node:crypto");
const { Readable, PassThrough } = require("node:stream");
const { finished } = require("node:stream/promises");
const { createServer, request: httpRequest } = require("node:http");
const guest = require("../../fixtures/workspace-service.cjs");
const tar = require("tar-stream");

const cleanup = [];
afterEach(async () => {
  for (const work of cleanup.splice(0).reverse()) await work();
});
async function fixture(transport, sourceOpener, options = {}) {
  const { createOwnerPublications } =
    await import("../../../packages/workspace-service/src/publications.mjs");
  const { createOwnerCommunication } =
    await import("../../../packages/workspace-service/src/owner-communication.mjs");
  const root = await realpath(await mkdtemp(join(tmpdir(), "communication-owner-")));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const scope = {
    kind: "controller",
    userId: "owner",
    deviceId: randomUUID(),
    deviceGeneration: 1,
    connectionId: randomUUID(),
  };
  const publications = await createOwnerPublications({
    stateRoot: root,
    scope: { ...scope, publicOrigin: "https://moira.example" },
    environmentIdentity: "owned-controller",
    withCommitLock: (work) => work(),
  });
  cleanup.push(() => publications.close());
  const open = () =>
    createOwnerCommunication({
      stateRoot: root,
      scope,
      publications,
      transport,
      sourceOpener,
      ...options,
    });
  const owner = await open();
  cleanup.push(() => owner.close());
  const bytes = Buffer.from("actual owner bytes\0🙂");
  const input = {
    action: "deliver",
    requestId: "ws1-" + randomUUID(),
    source: {
      type: "inline",
      fileName: "scene.jpg",
      mimeType: "image/jpeg",
      data: bytes.toString("base64"),
    },
    kind: "document",
    text: "Scene",
  };
  return { root, owner, open, scope, publications, bytes, input };
}
const prepare = async () => ({
  channels: [{ channelId: "telegram", authorityDigest: "a".repeat(64), provider: "telegram" }],
});

test("controller publication and delivery retain the original source and receipt without another vendor mutation", async () => {
  let sends = 0,
    received;
  const value = await fixture({
    prepare,
    async send(control, source) {
      sends++;
      const chunks = [];
      for await (const chunk of source) chunks.push(chunk);
      received = Buffer.concat(chunks);
      expect(control.file.mimeType).toBe("image/jpeg");
      return { status: "delivered" };
    },
  });
  const result = await value.owner.submit(value.input);
  expect(result).toMatchObject({
    requestId: value.input.requestId,
    state: "completed",
    outcome: {
      ok: true,
      result: { status: "delivered", file: { mimeType: "image/jpeg", size: value.bytes.length } },
    },
  });
  expect(received).toEqual(value.bytes);
  expect(await value.owner.submit(value.input)).toEqual(result);
  expect(sends).toBe(1);
  await expect(
    value.owner.submit({ ...value.input, text: "Different effect" }),
  ).rejects.toMatchObject({ publicCode: "COMMUNICATION_REQUEST_CONFLICT" });
  const records = await readdir(join(value.root, "communication"));
  const durable = await readFile(
    join(
      value.root,
      "communication",
      records.find((name) => name.endsWith(".json")),
    ),
    "utf8",
  );
  expect(durable).not.toContain(value.input.source.data);
  expect(result.outcome.result.file.referenceId).toContain(
    "owner-file://controller/" + value.scope.deviceId + "/",
  );
});

test("lost vendor reply survives owner reopen and pure collection never resends the accepted file", async () => {
  let sends = 0;
  const value = await fixture({
    prepare,
    async send(_control, source) {
      sends++;
      for await (const _chunk of source) {
        // Consume the verified body before simulating loss of its provider reply.
      }
      throw new Error("controlled lost vendor response");
    },
  });
  expect(await value.owner.submit(value.input)).toMatchObject({
    state: "completed",
    outcome: { ok: false, error: { code: "WORKSPACE_OUTCOME_UNCONFIRMED" } },
    stages: [{ status: "unconfirmed" }],
  });
  await value.owner.close();
  const reopened = await value.open();
  cleanup.push(() => reopened.close());
  expect(await reopened.inspect(value.input.requestId)).toMatchObject({
    requestId: value.input.requestId,
    outcome: { ok: false, error: { code: "WORKSPACE_OUTCOME_UNCONFIRMED" } },
  });
  expect(await reopened.submit(value.input)).toMatchObject({
    outcome: { ok: false, error: { code: "WORKSPACE_OUTCOME_UNCONFIRMED" } },
  });
  expect(sends).toBe(1);
});

test("source refusal remains before delivery admission and cannot create a vendor receipt", async () => {
  let sends = 0;
  const value = await fixture(
    {
      prepare,
      async send() {
        sends++;
        return { status: "delivered" };
      },
    },
    async () => {
      throw Object.assign(new Error("source refused"), {
        publicCode: "SOURCE_REFUSED",
        status: 422,
      });
    },
  );
  await expect(
    value.owner.submit({
      ...value.input,
      source: {
        type: "native",
        file: { fileId: "file-original", downloadUrl: "https://trusted.invalid/signed-secret" },
      },
    }),
  ).rejects.toMatchObject({ publicCode: "SOURCE_REFUSED" });
  expect(await value.owner.inspect(value.input.requestId)).toEqual({
    requestId: value.input.requestId,
    state: "absent",
  });
  expect(sends).toBe(0);
});

test("provider success before complete source consumption is uncertain, not delivered", async () => {
  const value = await fixture({
    prepare,
    async send() {
      return { status: "delivered" };
    },
  });
  expect(await value.owner.submit(value.input)).toMatchObject({
    outcome: { ok: false, error: { code: "WORKSPACE_OUTCOME_UNCONFIRMED" } },
    stages: [{ status: "unconfirmed" }],
  });
});

test("complete byte consumption still waits for the vendor outcome before completing the owner receipt", async () => {
  let started, release;
  const entered = new Promise((resolve) => {
    started = resolve;
  });
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const value = await fixture({
    prepare,
    async send(_control, source) {
      for await (const _chunk of source) {
        // The provider reply remains outstanding after complete upload.
      }
      started();
      await held;
      return { status: "delivered" };
    },
  });
  let completed = false;
  const pending = value.owner.submit(value.input).then((result) => {
    completed = true;
    return result;
  });
  await entered;
  expect(completed).toBe(false);
  expect(await value.owner.inspect(value.input.requestId)).toMatchObject({
    state: "accepted",
    stages: [{ status: "accepted" }],
  });
  release();
  expect(await pending).toMatchObject({
    state: "completed",
    outcome: { ok: true, result: { status: "delivered" } },
  });
});

test("long Telegram text has a separate original stage and losing that reply never resends the file", async () => {
  const calls = [];
  const value = await fixture({
    prepare,
    async send(control, source) {
      const chunks = [];
      for await (const chunk of source) chunks.push(chunk);
      calls.push({ control, bytes: Buffer.concat(chunks) });
      if (control.operationId === "send_message") throw new Error("lost text response");
      return { status: "delivered" };
    },
  });
  const input = { ...value.input, text: "x".repeat(1025) };
  const receipt = await value.owner.submit(input);
  expect(receipt).toMatchObject({
    outcome: { ok: false, error: { code: "WORKSPACE_OUTCOME_UNCONFIRMED" } },
    stages: [
      { channelId: "telegram", status: "delivered" },
      { channelId: "telegram", operationId: "send_message", status: "unconfirmed" },
    ],
  });
  expect(calls).toHaveLength(2);
  expect(calls[0].bytes).toEqual(value.bytes);
  expect(calls[0].control.text).toBe("");
  expect(calls[1].bytes).toHaveLength(0);
  expect(calls[1].control).toMatchObject({ text: input.text, file: { size: 0 } });
  expect(await value.owner.submit(input)).toEqual(receipt);
  expect(await value.owner.inspect(input.requestId)).toEqual(receipt);
  expect(calls).toHaveLength(2);
});

test("a new controller connection cannot collect an old connection delivery receipt", async () => {
  const value = await fixture({
    prepare,
    async send(_control, source) {
      for await (const _chunk of source) {
        // Consume the original immutable file under the first connection.
      }
      return { status: "delivered" };
    },
  });
  await value.owner.submit(value.input);
  await value.owner.close();
  value.scope.connectionId = randomUUID();
  const replacement = await value.open();
  cleanup.push(() => replacement.close());
  await expect(replacement.inspect(value.input.requestId)).rejects.toMatchObject({
    publicCode: "COMMUNICATION_SCOPE_REFUSED",
  });
});

async function readMaterializeArchive(publications, file) {
  const source = await publications.openSource(file.referenceId.split("/").at(-1));
  const parser = tar.extract();
  const files = [];
  parser.on("entry", (header, stream, next) => {
    const chunks = [];
    stream.on("data", (chunk) => chunks.push(chunk));
    stream.once("end", () => {
      files.push({ path: header.name, content: Buffer.concat(chunks).toString("utf8") });
      next();
    });
    stream.once("error", (error) => parser.destroy(error));
  });
  const parsed = finished(parser);
  try {
    for await (const chunk of source) {
      await new Promise((resolve, reject) =>
        parser.write(chunk, (error) => (error ? reject(error) : resolve())),
      );
    }
    parser.end();
    await parsed;
    return files;
  } finally {
    parser.destroy();
    await source.close();
    await source.settled;
  }
}

test("materialize publication streams exact Unicode and empty files beyond former archive ceilings and collects without rendering again", async () => {
  const { renderOwnerMaterialize } =
    await import("../../../packages/workspace-service/src/owner-renderer.mjs");
  let rendered = 0;
  const value = await fixture(undefined, undefined, {
    renderMaterialize: (...arguments_) => {
      rendered++;
      return renderOwnerMaterialize(...arguments_);
    },
  });
  const files = [
    { path: "инструкции\\🙂.md", content: "x".repeat(16383) + "🙂" + "Ж".repeat(6 * 1024 * 1024) },
    ...Array.from({ length: 101 }, (_, index) => ({ path: `empty/${index}.txt`, content: "" })),
  ];
  const input = {
    action: "publish",
    requestId: "ws1-" + randomUUID(),
    expectedScope: value.scope,
    source: { type: "materialize-text-set", files },
  };
  const result = await value.owner.submit(input);
  expect(result).toMatchObject({
    state: "completed",
    outcome: {
      ok: true,
      result: { file: { fileName: "materialize.tar", mimeType: "application/x-tar" } },
    },
  });
  const expected = files.map((file) => ({ ...file, path: file.path.replaceAll("\\", "/") }));
  expect(await readMaterializeArchive(value.publications, result.outcome.result.file)).toEqual(
    expected,
  );
  expect(await value.owner.submit(input)).toEqual(result);
  expect(await value.owner.inspect(input.requestId)).toEqual(result);
  expect(rendered).toBe(1);
  await expect(
    value.owner.submit({
      ...input,
      source: { ...input.source, files: [{ path: "changed", content: "new" }] },
    }),
  ).rejects.toMatchObject({ publicCode: "COMMUNICATION_REQUEST_CONFLICT" });
  await expect(value.owner.submit({ ...input, expectedScope: undefined })).rejects.toMatchObject({
    publicCode: "COMMUNICATION_REQUEST_CONFLICT",
  });
});

test.each([
  [[{ path: "../outside", content: "" }]],
  [[{ path: "a\\..\\outside", content: "" }]],
  [[{ path: "C:\\outside", content: "" }]],
  [[{ path: "/outside", content: "" }]],
  [[{ path: "a//b", content: "" }]],
  [[{ path: "a/./b", content: "" }]],
  [[{ path: "nul\0name", content: "" }]],
  [[{ path: "unpaired\ud800", content: "" }]],
  [[{ path: "text", content: "unpaired\ud800" }]],
  [
    [
      { path: "a/b", content: "" },
      { path: "a\\b", content: "" },
    ],
  ],
  [
    [
      { path: "a", content: "" },
      { path: "a/b", content: "" },
    ],
  ],
])(
  "unsafe materialize set %# is refused before archive acquisition or publication",
  async (files) => {
    let rendered = false;
    const value = await fixture(undefined, undefined, {
      renderMaterialize: () => {
        rendered = true;
        throw new Error("Unsafe files reached the renderer");
      },
    });
    const requestId = "ws1-" + randomUUID();
    await expect(
      value.owner.submit({
        action: "publish",
        requestId,
        source: { type: "materialize-text-set", files },
      }),
    ).rejects.toBeDefined();
    expect(rendered).toBe(false);
    expect(await value.owner.inspect(requestId)).toEqual({ requestId, state: "absent" });
    expect(await readdir(join(value.root, "publications", "objects"))).toEqual([]);
  },
);

test.each(["publish", "deliver"])(
  "%s refuses a foreign expected owner before source acquisition and prior receipt lookup",
  async (action) => {
    let acquired = 0;
    const value = await fixture(undefined, undefined, {
      renderMaterialize: () => {
        acquired++;
        throw new Error("Foreign scope reached archive acquisition");
      },
    });
    const requestId = "ws1-" + randomUUID();
    const input = {
      ...(action === "deliver" ? { kind: "document", text: "archive" } : {}),
      action,
      requestId,
      expectedScope: { ...value.scope, connectionId: randomUUID() },
      source: { type: "materialize-text-set", files: [{ path: "file", content: "text" }] },
    };
    await expect(value.owner.submit(input)).rejects.toMatchObject({
      publicCode: "COMMUNICATION_SCOPE_REFUSED",
    });
    expect(acquired).toBe(0);
    const completed = await value.owner.submit({
      action: "publish",
      requestId: value.input.requestId,
      source: value.input.source,
    });
    await expect(
      value.owner.submit({ ...input, requestId: completed.requestId }),
    ).rejects.toMatchObject({ publicCode: "COMMUNICATION_SCOPE_REFUSED" });
    expect(await readdir(join(value.root, "publications", "objects"))).toHaveLength(1);
  },
);

test("materialize publication waits for physical source close and settlement before admitting its receipt", async () => {
  let closeEntered, releaseClose, closeDone, releaseSettled;
  const entered = new Promise((resolve) => {
    closeEntered = resolve;
  });
  const heldClose = new Promise((resolve) => {
    releaseClose = resolve;
  });
  const closed = new Promise((resolve) => {
    closeDone = resolve;
  });
  const settled = new Promise((resolve) => {
    releaseSettled = resolve;
  });
  const value = await fixture(undefined, undefined, {
    renderMaterialize: async () => ({
      async *[Symbol.asyncIterator]() {
        yield Buffer.from("owned archive stream");
      },
      async close() {
        closeEntered();
        await heldClose;
        closeDone();
      },
      settled,
    }),
  });
  cleanup.push(() => {
    releaseClose();
    releaseSettled();
  });
  const input = {
    action: "publish",
    requestId: "ws1-" + randomUUID(),
    source: { type: "materialize-text-set", files: [{ path: "file", content: "text" }] },
  };
  let completed = false;
  const pending = value.owner.submit(input).then((receipt) => {
    completed = true;
    return receipt;
  });
  await entered;
  expect(completed).toBe(false);
  expect(await value.owner.inspect(input.requestId)).toEqual({
    requestId: input.requestId,
    state: "absent",
  });
  releaseClose();
  await closed;
  expect(completed).toBe(false);
  releaseSettled();
  expect(await pending).toMatchObject({ state: "completed", outcome: { ok: true } });
});

test("cancelling a backpressured materialize writer settles its owned stream without consuming or publishing it", async () => {
  const { renderOwnerMaterialize } =
    await import("../../../packages/workspace-service/src/owner-renderer.mjs");
  const abort = new AbortController();
  const source = await renderOwnerMaterialize(
    [{ path: "large", content: "x".repeat(1024 * 1024) }],
    { signal: abort.signal },
  );
  const rejected = expect(source.settled).rejects.toMatchObject({ name: "AbortError" });
  abort.abort();
  await expect(source.close()).rejects.toMatchObject({ name: "AbortError" });
  await rejected;
});

test("framed Unicode control preserves a coalesced opaque file view without header limits", async () => {
  const { encodeOwnerFrame, readOwnerFrame } =
    await import("../../../packages/workspace-service/src/stream-frame.mjs");
  const control = { text: "中".repeat(4096), file: { size: 6 } };
  const bytes = Buffer.from([0, 255, 1, 128, 10, 42]);
  const encoded = encodeOwnerFrame(
    control,
    (async function* () {
      yield bytes;
    })(),
  );
  const pieces = [];
  for await (const piece of encoded.body) pieces.push(piece);
  const wire = Buffer.concat(pieces);
  const frame = await readOwnerFrame(Readable.from([wire.subarray(0, 1), wire.subarray(1)]));
  expect(frame.control).toEqual(control);
  expect(frame.prefixLength).toBe(encoded.prefixLength);
  const observed = [];
  for await (const piece of frame.body) observed.push(piece);
  expect(observed).toHaveLength(1);
  expect(observed[0]).toEqual(bytes);
  expect(observed[0].buffer).toBe(wire.buffer);
  expect(observed[0].byteOffset).toBe(wire.byteOffset + encoded.prefixLength);
});

test("destroying a framed source cancels an actually pending original incoming read", async () => {
  const { encodeOwnerFrame, readOwnerFrame } =
    await import("../../../packages/workspace-service/src/stream-frame.mjs");
  const input = new PassThrough();
  const encoded = encodeOwnerFrame({ file: { size: 10 } }, (async function* () {})());
  for await (const piece of encoded.body) input.write(piece);
  const frame = await readOwnerFrame(input);
  const pending = frame.body[Symbol.asyncIterator]().next();
  const rejected = expect(pending).rejects.toBeDefined();
  const closed = finished(frame.body).catch(() => undefined);
  frame.body.destroy();
  expect(input.destroyed).toBe(true);
  await rejected;
  await closed;
});

test("guest shutdown closes stalled communication ingress before awaiting its unaccepted preparation", async () => {
  const { startWorkspaceService } =
    await import("../../../packages/workspace-service/src/server.mjs");
  const { encodeOwnerFrame, OWNER_STREAM_CONTENT_TYPE } =
    await import("../../../packages/workspace-service/src/stream-frame.mjs");
  const previousLife = process.env.MOIRA_ENVIRONMENT_ID;
  process.env.MOIRA_ENVIRONMENT_ID ??= "service-test";
  cleanup.push(() => {
    if (previousLife === undefined) delete process.env.MOIRA_ENVIRONMENT_ID;
    else process.env.MOIRA_ENVIRONMENT_ID = previousLife;
  });
  const value = guest.createFixture();
  cleanup.push(() => guest.dispose(value));
  // Keep the real Unix socket within the host's pathname limit.
  value.socketPath = join(await realpath("/tmp"), `communication-${randomUUID()}.sock`);
  const service = await startWorkspaceService({
    ...value,
    publicationScope: {
      resourceId: randomUUID(),
      resourceGeneration: 1,
      authorizationGeneration: 1,
      publicOrigin: "https://moira.example",
    },
  });
  cleanup.push(() => service.close());
  const objects = join(value.stateRoot, "publications", "objects");
  const partial = Buffer.from("unfinished file");
  let watcher;
  const captured = new Promise((resolve, reject) => {
    watcher = watch(objects, async (_event, name) => {
      try {
        if (!name) return;
        const info = await lstat(join(objects, name)).catch((error) => {
          if (error.code === "ENOENT") return null;
          throw error;
        });
        if (info?.size === partial.length) resolve();
      } catch (error) {
        reject(error);
      }
    });
    watcher.once("error", reject);
  });
  cleanup.push(() => watcher.close());
  const requestId = "ws1-" + randomUUID();
  const frame = encodeOwnerFrame(
    {
      action: "publish",
      requestId,
      source: {
        type: "stream",
        file: { fileName: "unfinished.bin", mimeType: "application/octet-stream", size: 1024 },
      },
    },
    (async function* () {
      yield partial;
    })(),
  );
  const request = httpRequest(
    {
      socketPath: value.socketPath,
      path: "/v1/communication/stream",
      method: "POST",
      agent: false,
      headers: {
        "content-type": OWNER_STREAM_CONTENT_TYPE,
        "content-length": frame.prefixLength + 1024,
      },
    },
    (response) => response.resume(),
  );
  request.on("error", () => {
    // Explicit service shutdown may disconnect the still-open upload.
  });
  const clientClosed = new Promise((resolve) => request.once("close", resolve));
  cleanup.push(() => request.destroy());
  for await (const piece of frame.body) request.write(piece);
  // Observe actual private staging, so shutdown cannot pass merely by winning
  // the race before the request reached the pending source read.
  await captured;
  expect(request.writableEnded).toBe(false);
  await service.close();
  await clientClosed;
  expect(request.destroyed).toBe(true);
  await expect(lstat(value.socketPath)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readdir(join(value.stateRoot, "communication"))).toEqual([]);
  expect(await readdir(join(value.stateRoot, "requests"))).toEqual([]);
  expect(await readdir(objects)).toEqual([]);
});

test.each(["malformed control", "unconsumed replay"])(
  "%s flushes its complete HTTP result before closing unread file ingress",
  async (mode) => {
    const { readOwnerFrame, settleOwnerFrame, encodeOwnerFrame, OWNER_STREAM_CONTENT_TYPE } =
      await import("../../../packages/workspace-service/src/stream-frame.mjs");
    const root = await realpath(await mkdtemp("/tmp/owner-frame-"));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const socketPath = join(root, "http.sock");
    let ingressClosed;
    const closed = new Promise((resolve) => {
      ingressClosed = resolve;
    });
    const server = createServer((request, response) => {
      request.once("close", () => ingressClosed({ complete: request.complete }));
      void (async () => {
        let frame;
        try {
          frame = await readOwnerFrame(request);
          settleOwnerFrame(request, response, frame);
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify({ state: "completed", original: frame.control.requestId }));
        } catch {
          settleOwnerFrame(request, response, frame);
          response.writeHead(400, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: "COMMUNICATION_REQUEST_INVALID" }));
        }
      })();
    });
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });
    cleanup.push(
      () =>
        new Promise((resolve) => {
          server.closeAllConnections();
          server.close(resolve);
        }),
    );
    const encoded = encodeOwnerFrame({ requestId: "original" }, (async function* () {})());
    const pieces = [];
    for await (const piece of encoded.body) pieces.push(piece);
    const prefix =
      mode === "malformed control" ? Buffer.from([0, 0, 0, 1, 0x7b]) : Buffer.concat(pieces);
    const observed = await new Promise((resolve, reject) => {
      let responding = false;
      const request = httpRequest(
        {
          socketPath,
          path: "/",
          method: "POST",
          agent: false,
          headers: {
            "content-type": OWNER_STREAM_CONTENT_TYPE,
            "content-length": prefix.length + 1024,
          },
        },
        (response) => {
          responding = true;
          const chunks = [];
          response.on("data", (chunk) => chunks.push(chunk));
          response.once("error", reject);
          response.once("end", () =>
            resolve({
              status: response.statusCode,
              body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
            }),
          );
        },
      );
      request.once("error", (error) => {
        if (!responding) reject(error);
      });
      // Deliberately leave the declared 1024 file bytes unsent and the request unfinished.
      request.write(prefix);
    });
    expect(observed).toEqual(
      mode === "malformed control"
        ? { status: 400, body: { error: "COMMUNICATION_REQUEST_INVALID" } }
        : { status: 200, body: { state: "completed", original: "original" } },
    );
    expect(await closed).toEqual({ complete: false });
  },
);
