const { afterEach, beforeAll, expect, test } = require("@jest/globals");
const { createHash, randomUUID } = require("node:crypto");
const {
  existsSync,
  readFileSync,
  writeFileSync,
  statSync,
  readdirSync,
  renameSync,
} = require("node:fs");
const { createServer, request } = require("node:http");
const { join, resolve } = require("node:path");
const { pathToFileURL } = require("node:url");
const {
  createFixture,
  start,
  stop,
  call,
  dispose,
} = require("../../fixtures/workspace-service.cjs");

const sourceModule = pathToFileURL(resolve("tests/fixtures/workspace-native-source.mjs")).href;
const fixtures = [];
let createWorkspaceRequestId;
beforeAll(async () => {
  ({ createWorkspaceRequestId } =
    await import("../../../packages/shared/src/codespaces/workspace-request-id.ts"));
});
afterEach(async () => {
  for (const value of fixtures.splice(0)) {
    // A failed shutdown assertion must still release this fixture's held source,
    // so Jest can report the regression instead of hanging its cleanup hook.
    if (value.sourceMode === "held-headers") value.sourceServer?.closeAllConnections();
    await stop(value);
    if (value.sourceServer) {
      value.sourceServer.closeAllConnections();
      await new Promise((done, reject) =>
        value.sourceServer.close((error) => (error ? reject(error) : done())),
      );
    }
    await dispose(value);
  }
});

async function fixture(bytes = Buffer.from([0, 255, 13, 10, 128, 1])) {
  const value = createFixture();
  fixtures.push(value);
  value.sourceRequests = [];
  value.sourceBytes = bytes;
  value.sourceMode = "ready";
  value.sourceFixture = {
    moduleUrl: sourceModule,
    socketPath: join(value.directory, "source.sock"),
  };
  value.publicationScope = {
    resourceId: randomUUID(),
    resourceGeneration: 1,
    authorizationGeneration: 1,
    publicOrigin: "https://moira.example",
  };
  value.sourceServer = createServer((incoming, response) => {
    value.sourceRequests.push({
      method: incoming.method,
      pid: Number(incoming.headers["x-fixture-owner-pid"]),
      url: incoming.headers["x-fixture-source-url"],
      path: incoming.url,
    });
    if (value.sourceMode === "held-headers") {
      value.onSourceRequest?.(value.sourceRequests.at(-1));
      return;
    }
    if (value.sourceMode === "refused") {
      response.writeHead(403).end();
      return;
    }
    response.writeHead(200, {
      "content-type": "application/octet-stream",
      "content-length": value.sourceBytes.length,
    });
    if (value.sourceMode === "broken-body") {
      response.write(value.sourceBytes.subarray(0, 1), () => response.destroy());
      return;
    }
    response.end(value.sourceBytes);
  });
  await new Promise((done, reject) => {
    value.sourceServer.once("error", reject);
    value.sourceServer.listen(value.sourceFixture.socketPath, done);
  });
  value.file = {
    fileId: "file-owner-control",
    downloadUrl: "https://files.oaiusercontent.com/control?fixtureSignedAuthority=private-sentinel",
    fileName: "control.bin",
    mimeType: "application/octet-stream",
    declaredSize: bytes.length,
  };
  await start(value);
  return value;
}

async function jsonCall(value, method, path, body) {
  const response = await call(value, method, path, body, { "content-type": "application/json" });
  return { ...response, body: JSON.parse(response.bytes.toString()) };
}

async function collect(value, requestId) {
  const deadline = Date.now() + 5000;
  while (true) {
    const response = await jsonCall(value, "GET", `/v1/operations/${requestId}`);
    expect(response.status).toBe(200);
    if (!["starting", "running"].includes(response.body.state)) return response.body;
    if (Date.now() >= deadline) throw new Error("Owner operation did not settle");
    await new Promise((done) => setTimeout(done, 10));
  }
}

function assertNoSourceAuthority(value) {
  const sentinel = Buffer.from("fixtureSignedAuthority=private-sentinel");
  const inspect = (directory) => {
    for (const item of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, item.name);
      if (item.isDirectory()) inspect(path);
      else if (item.isFile()) expect(readFileSync(path).includes(sentinel)).toBe(false);
    }
  };
  inspect(value.stateRoot);
  expect(Buffer.concat(value.diagnostics).includes(sentinel)).toBe(false);
}

test("the separate owner acquires exact native bytes and restart collects without using rotated source authority", async () => {
  const value = await fixture(Buffer.alloc(1024 * 1024 + 17, 0xc7));
  const requestId = createWorkspaceRequestId();
  const body = { requestId, path: "native.bin", expected: { exists: false }, file: value.file };
  const uploaded = await jsonCall(value, "POST", "/v1/files/native-upload", body);
  expect(uploaded.status).toBe(200);
  expect(uploaded.body).toMatchObject({ requestId, state: "succeeded" });
  expect(readFileSync(join(value.root, body.path)).equals(value.sourceBytes)).toBe(true);
  expect(value.sourceRequests).toEqual([
    {
      method: "GET",
      pid: value.child.pid,
      url: value.file.downloadUrl,
      path: "/source/file-owner-control",
    },
  ]);
  expect(value.sourceRequests[0].pid).not.toBe(process.pid);
  const original = statSync(join(value.root, body.path));
  await stop(value);
  value.sourceMode = "refused";
  await start(value);
  const replay = await jsonCall(value, "POST", "/v1/files/native-upload", {
    ...body,
    file: { ...body.file, downloadUrl: "https://files.oaiusercontent.com/expired-rotated" },
  });
  expect(replay.status).toBe(200);
  expect(replay.body).toEqual(uploaded.body);
  expect(await collect(value, requestId)).toMatchObject({ requestId, state: "succeeded" });
  expect(value.sourceRequests).toHaveLength(1);
  const retained = statSync(join(value.root, body.path));
  expect([retained.dev, retained.ino, retained.mtimeMs]).toEqual([
    original.dev,
    original.ino,
    original.mtimeMs,
  ]);
  assertNoSourceAuthority(value);
});

test("changed native identity or destination conflicts before another acquisition, and stale target refuses before the first", async () => {
  const value = await fixture();
  const body = {
    requestId: createWorkspaceRequestId(),
    path: "native.bin",
    expected: { exists: false },
    file: value.file,
  };
  expect((await jsonCall(value, "POST", "/v1/files/native-upload", body)).status).toBe(200);
  for (const changed of [
    { ...body, file: { ...body.file, fileId: "another-file" } },
    { ...body, file: { ...body.file, declaredSize: body.file.declaredSize + 1 } },
    { ...body, file: { ...body.file, mimeType: "image/png" } },
    { ...body, file: { ...body.file, fileName: "changed.bin" } },
    { ...body, path: "another.bin" },
    { ...body, expected: { exists: true } },
  ]) {
    expect((await jsonCall(value, "POST", "/v1/files/native-upload", changed)).status).toBe(409);
  }
  expect(value.sourceRequests).toHaveLength(1);
  const staleId = createWorkspaceRequestId();
  const stale = await jsonCall(value, "POST", "/v1/files/native-upload", {
    ...body,
    requestId: staleId,
  });
  expect(stale.status).toBe(409);
  expect((await collect(value, staleId)).state).toBe("absent");
  expect(value.sourceRequests).toHaveLength(1);
  expect(existsSync(join(value.root, "another.bin"))).toBe(false);
});

test.each(["refused", "broken-body"])(
  "native source %s is confirmed before upload or command admission",
  async (mode) => {
    const value = await fixture();
    value.sourceMode = mode;
    writeFileSync(join(value.root, "existing.bin"), "original");
    const uploadId = createWorkspaceRequestId();
    const upload = await jsonCall(value, "POST", "/v1/files/native-upload", {
      requestId: uploadId,
      path: "existing.bin",
      expected: { exists: true, sha256: createHash("sha256").update("original").digest("hex") },
      file: value.file,
    });
    expect(upload.status).toBe(422);
    expect(upload.body).toMatchObject({ error: { code: "SOURCE_REFUSED" } });
    expect((await collect(value, uploadId)).state).toBe("absent");
    expect(readFileSync(join(value.root, "existing.bin"), "utf8")).toBe("original");
    const execId = createWorkspaceRequestId();
    const executed = await jsonCall(value, "POST", "/v1/exec", {
      requestId: execId,
      nativeInput: value.file,
      argv: [
        process.execPath,
        "-e",
        "require('node:fs').writeFileSync('command-effect','changed')",
      ],
    });
    expect(executed.status).toBe(422);
    expect(executed.body).toMatchObject({ error: { code: "SOURCE_REFUSED" } });
    expect((await collect(value, execId)).state).toBe("absent");
    expect(existsSync(join(value.root, "command-effect"))).toBe(false);
    assertNoSourceAuthority(value);
  },
);

test("graceful owner shutdown aborts a held native source before admission and leaves its original request absent after restart", async () => {
  const value = await fixture();
  value.sourceMode = "held-headers";
  const observed = new Promise((done) => {
    value.onSourceRequest = done;
  });
  const requestId = createWorkspaceRequestId();
  writeFileSync(join(value.root, "shutdown.bin"), "unchanged");
  const pending = jsonCall(value, "POST", "/v1/files/native-upload", {
    requestId,
    path: "shutdown.bin",
    expected: { exists: true },
    file: value.file,
  });
  expect(await observed).toMatchObject({ method: "GET", pid: value.child.pid });
  // No fixture release or guessed delay: the owner's close must abort the source
  // acquisition and drain the fully received request before its process exits.
  const [response] = await Promise.all([pending, stop(value)]);
  expect(response.status).toBe(422);
  expect(response.body).toMatchObject({ error: { code: "SOURCE_REFUSED" } });
  expect(readFileSync(join(value.root, "shutdown.bin"), "utf8")).toBe("unchanged");
  value.sourceMode = "ready";
  await start(value);
  expect((await collect(value, requestId)).state).toBe("absent");
  expect(value.sourceRequests).toHaveLength(1);
  expect(readFileSync(join(value.root, "shutdown.bin"), "utf8")).toBe("unchanged");
  assertNoSourceAuthority(value);
});

test("the final session gate refuses a prepared native stdin command without an effect", async () => {
  const value = await fixture();
  const requestId = createWorkspaceRequestId();
  const result = await jsonCall(value, "POST", "/v1/exec", {
    requestId,
    nativeInput: value.file,
    session: "never-opened",
    argv: [
      process.execPath,
      "-e",
      "require('node:fs').writeFileSync('invalid-session-effect','unexpected')",
    ],
  });
  expect(result.status).toBe(200);
  expect(result.body).toMatchObject({ requestId });
  expect(await collect(value, requestId)).toMatchObject({
    requestId,
    state: "not_started",
    reason: "SESSION_UNAVAILABLE",
  });
  expect(value.sourceRequests).toHaveLength(1);
  expect(existsSync(join(value.root, "invalid-session-effect"))).toBe(false);
  assertNoSourceAuthority(value);
});

test("one native stdin request retains exact command output and cannot change its command or fetch on replay", async () => {
  const value = await fixture();
  const requestId = createWorkspaceRequestId();
  const body = {
    requestId,
    nativeInput: value.file,
    argv: [
      process.execPath,
      "-e",
      "require('node:fs').appendFileSync('effects','once');process.stdin.pipe(process.stdout)",
    ],
  };
  expect((await jsonCall(value, "POST", "/v1/exec", body)).status).toBe(200);
  expect(await collect(value, requestId)).toMatchObject({
    requestId,
    state: "succeeded",
    stdoutBytes: value.sourceBytes.length,
  });
  expect(
    (await call(value, "GET", `/v1/operations/${requestId}/output`)).bytes.equals(
      value.sourceBytes,
    ),
  ).toBe(true);
  value.sourceMode = "refused";
  expect(
    (
      await jsonCall(value, "POST", "/v1/exec", {
        ...body,
        nativeInput: { ...value.file, downloadUrl: "https://files.oaiusercontent.com/expired" },
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await jsonCall(value, "POST", "/v1/exec", {
        ...body,
        argv: [process.execPath, "-e", "process.exit(7)"],
      })
    ).status,
  ).toBe(409);
  expect(readFileSync(join(value.root, "effects"), "utf8")).toBe("once");
  expect(value.sourceRequests).toHaveLength(1);
  assertNoSourceAuthority(value);
});

test("losing the upload reply collects the same completed effect without replacing its file or acquiring the source twice", async () => {
  const value = await fixture();
  const requestId = createWorkspaceRequestId();
  const body = { requestId, path: "lost.bin", expected: { exists: false }, file: value.file };
  await new Promise((done, reject) => {
    const outgoing = request(
      {
        socketPath: value.socketPath,
        method: "POST",
        path: "/v1/files/native-upload",
        headers: { "content-type": "application/json" },
      },
      (response) => {
        response.destroy();
        done();
      },
    );
    outgoing.once("error", reject);
    outgoing.end(JSON.stringify(body));
  });
  expect(await collect(value, requestId)).toMatchObject({ requestId, state: "succeeded" });
  const original = statSync(join(value.root, body.path));
  value.sourceMode = "refused";
  expect((await jsonCall(value, "POST", "/v1/files/native-upload", body)).status).toBe(200);
  expect(statSync(join(value.root, body.path)).ino).toBe(original.ino);
  expect(value.sourceRequests).toHaveLength(1);
});

async function publish(value, extra = {}) {
  const response = await jsonCall(value, "POST", "/v1/files/publish", {
    path: "export.bin",
    fileName: "export.bin",
    mimeType: "application/octet-stream",
    ...extra,
  });
  expect(response.status).toBe(200);
  const publication = response.body;
  const token = publication.referenceId.split("/").at(-1);
  expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(publication.referenceId).toBe(
    `owner-file://workspace/${value.publicationScope.resourceId}/${token}`,
  );
  expect(publication.uri).toBe(
    `https://moira.example/api/codespaces/files/${value.publicationScope.resourceId}/${token}`,
  );
  return { publication, token };
}

test("repeated public reads retain the immutable published version after the source changes and the service restarts", async () => {
  const value = await fixture(Buffer.alloc(1024 * 1024 + 31, 0xda));
  writeFileSync(join(value.root, "export.bin"), value.sourceBytes);
  const { publication, token } = await publish(value);
  expect(publication).toMatchObject({
    size: value.sourceBytes.length,
    sha256: createHash("sha256").update(value.sourceBytes).digest("hex"),
  });
  writeFileSync(join(value.root, "export.bin"), "new workspace bytes");
  for (let read = 0; read < 2; read++) {
    const response = await call(value, "GET", `/v1/publications/${token}`);
    expect(response.status).toBe(200);
    expect(response.bytes.equals(value.sourceBytes)).toBe(true);
  }
  await stop(value);
  await start(value);
  const response = await call(value, "GET", `/v1/publications/${token}`);
  expect(response.status).toBe(200);
  expect(response.bytes.equals(value.sourceBytes)).toBe(true);
  expect(value.sourceRequests).toHaveLength(0);
});

test("an interrupted public GET can be read again and does not consume the publication", async () => {
  const value = await fixture(Buffer.alloc(8 * 1024 * 1024 + 1, 0xdd));
  writeFileSync(join(value.root, "export.bin"), value.sourceBytes);
  const { token } = await publish(value);
  await new Promise((done, reject) => {
    const outgoing = request(
      { socketPath: value.socketPath, path: `/v1/publications/${token}` },
      (response) => {
        response.once("data", () => {
          response.destroy();
          done();
        });
      },
    );
    outgoing.once("error", reject);
    outgoing.end();
  });
  const resumed = await call(value, "GET", `/v1/publications/${token}`);
  expect(resumed.status).toBe(200);
  expect(resumed.bytes.equals(value.sourceBytes)).toBe(true);
});

test("a published capability refuses foreign generation while the original scope remains readable", async () => {
  const value = await fixture();
  writeFileSync(join(value.root, "export.bin"), "exported");
  const { token } = await publish(value);
  expect((await call(value, "GET", `/v1/publications/${token}`)).status).toBe(200);
  await stop(value);
  value.publicationScope.authorizationGeneration++;
  await start(value);
  expect((await call(value, "GET", `/v1/publications/${token}`)).status).not.toBe(200);
  await stop(value);
  value.publicationScope.authorizationGeneration--;
  await start(value);
  expect((await call(value, "GET", `/v1/publications/${token}`)).status).toBe(200);
});

test("a readable publication expires at its owner deadline without requiring a consume receipt", async () => {
  const value = await fixture();
  writeFileSync(join(value.root, "export.bin"), "exported");
  const { token, publication } = await publish(value, { expiresInSeconds: 1 });
  expect((await call(value, "GET", `/v1/publications/${token}`)).status).toBe(200);
  const remaining = publication.expiresAt - Date.now();
  if (remaining > 0) await new Promise((done) => setTimeout(done, remaining + 1));
  expect((await call(value, "GET", `/v1/publications/${token}`)).status).not.toBe(200);
});

test("same-content substitution of an immutable publication object refuses while preserving the foreign replacement", async () => {
  const value = await fixture();
  const bytes = Buffer.from("unique immutable object sentinel");
  writeFileSync(join(value.root, "export.bin"), bytes);
  const { token } = await publish(value);
  const matching = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && readFileSync(path).equals(bytes)) matching.push(path);
    }
  };
  visit(value.stateRoot);
  expect(matching).toHaveLength(1);
  const objectPath = matching[0];
  const retained = join(value.directory, "retained-object");
  renameSync(objectPath, retained);
  writeFileSync(objectPath, bytes, { mode: 0o600 });
  expect((await call(value, "GET", `/v1/publications/${token}`)).status).not.toBe(200);
  expect(readFileSync(objectPath).equals(bytes)).toBe(true);
  expect(readFileSync(retained).equals(bytes)).toBe(true);
});
