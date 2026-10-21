const { test, expect, afterEach } = require("@jest/globals");
const { randomUUID } = require("node:crypto");
const {
  writeFileSync,
  readFileSync,
  renameSync,
  readdirSync,
  mkdirSync,
  existsSync,
} = require("node:fs");
const { join } = require("node:path");
const {
  createFixture,
  start,
  stop,
  call,
  dispose,
} = require("../../fixtures/workspace-service.cjs");
const fixtures = [];
afterEach(async () => {
  for (const value of fixtures.splice(0)) await dispose(value);
});
async function service() {
  const value = createFixture();
  fixtures.push(value);
  value.ownerSelector = {
    kind: "local",
    deviceId: randomUUID(),
    spaceId: randomUUID(),
    operationMarker: "moira-" + "a".repeat(24),
  };
  await start(value);
  return value;
}
async function tool(value, action, request, requestId) {
  return JSON.parse(
    (
      await call(
        value,
        "POST",
        "/v1/tools",
        { action, request, ...(requestId ? { requestId } : {}) },
        { "content-type": "application/json" },
      )
    ).bytes,
  );
}
const data = (result) => result.structuredContent;

test("observed text/reference share one file version and reject same-byte inode replacement before admission", async () => {
  const value = await service();
  writeFileSync(join(value.root, "code.txt"), "Привет 🙂\nsecond\n");
  const first = data(
    await tool(value, "file_read", { path: "code.txt", window: { max_lines: 1 } }),
  );
  const { decodeReference } =
    await import("../../../packages/shared/src/codespaces/workspace-references.mjs");
  expect(first.text).toBe("Привет 🙂\n");
  const reference = decodeReference(first.file, "file");
  expect(reference.version.size).toBe(Buffer.byteLength("Привет 🙂\nsecond\n"));
  expect(
    data(
      await tool(value, "file_read", { path: "code.txt", window: { cursor: first.next_cursor } }),
    ).text,
  ).toBe("second\n");
  renameSync(join(value.root, "code.txt"), join(value.root, "original.txt"));
  writeFileSync(join(value.root, "code.txt"), "Привет 🙂\nsecond\n");
  const refused = await tool(value, "file_replace", {
    path: "code.txt",
    text: "overwrite",
    expected: { file: first.file },
  });
  expect(data(refused).error.code).toBe("FILE_REFERENCE_CONFLICT");
  expect(readFileSync(join(value.root, "code.txt"), "utf8")).toBe("Привет 🙂\nsecond\n");
});

test("expected full text and observed cursor preserve an intervening edit without refresh", async () => {
  const value = await service();
  writeFileSync(join(value.root, "file"), "old\nnext\n");
  const observed = data(await tool(value, "file_read", { path: "file", max_bytes: 4 }));
  writeFileSync(join(value.root, "file"), "intervening\n");
  expect(
    data(
      await tool(value, "file_replace", {
        path: "file",
        text: "lost",
        expected: { text: "old\nnext\n" },
      }),
    ).error.code,
  ).toBe("FILE_PRECONDITION_CONFLICT");
  expect(
    data(await tool(value, "file_read", { path: "file", window: { cursor: observed.next_cursor } }))
      .error.code,
  ).toBe("FILE_REFERENCE_CONFLICT");
  expect(readFileSync(join(value.root, "file"), "utf8")).toBe("intervening\n");
});

test("text patches use the immutable original and reject ambiguity, overlap and partial multifile publication", async () => {
  const value = await service();
  writeFileSync(join(value.root, "a"), "one two");
  writeFileSync(join(value.root, "b"), "safe");
  const patch = (files) => tool(value, "file_patch", { files });
  const changed = await patch([
    {
      path: "a",
      replacements: [
        { old_text: "one", new_text: "two" },
        { old_text: "two", new_text: "three" },
      ],
    },
  ]);
  expect(data(changed).outcome.ok).toBe(true);
  expect(readFileSync(join(value.root, "a"), "utf8")).toBe("two three");
  expect(
    data(await tool(value, "operation_find", { kind: "file-change", query: "Patch a" })).operations,
  ).toMatchObject([{ description: "Patch a" }]);
  writeFileSync(join(value.root, "a"), "same same");
  expect(
    data(await patch([{ path: "a", replacements: [{ old_text: "same", new_text: "x" }] }])).error
      .code,
  ).toBe("TEXT_MATCH_CONFLICT");
  expect(
    data(
      await patch([
        {
          path: "a",
          replacements: [
            { old_text: "same", new_text: "x", occurrence: "all" },
            { old_text: "same same", new_text: "y" },
          ],
        },
      ]),
    ).error.code,
  ).toBe("TEXT_PATCH_OVERLAP");
  const result = await patch([
    { path: "b", replacements: [{ old_text: "safe", new_text: "lost" }] },
    { path: "a", replacements: [{ old_text: "missing", new_text: "x" }] },
  ]);
  expect(result.isError).toBe(true);
  expect(readFileSync(join(value.root, "b"), "utf8")).toBe("safe");
});

test("file UTF8 continuation reconstructs Cyrillic/emoji and tiny windows remain actionable", async () => {
  const value = await service();
  const text = "Я🙂аб🙂z";
  writeFileSync(join(value.root, "utf8"), text);
  let cursor,
    actual = "";
  do {
    const result = data(
      await tool(value, "file_read", {
        path: "utf8",
        max_bytes: 4,
        ...(cursor ? { window: { cursor } } : {}),
      }),
    );
    expect(result.error).toBeUndefined();
    actual += result.text;
    cursor = result.next_cursor;
  } while (cursor);
  expect(actual).toBe(text);
  const tiny = data(await tool(value, "file_read", { path: "utf8", max_bytes: 1 }));
  expect(tiny.error).toMatchObject({ code: "TEXT_WINDOW_TOO_SMALL", minimum_bytes: 2 });
  writeFileSync(join(value.root, "bad"), Buffer.from([0xff]));
  expect(data(await tool(value, "file_read", { path: "bad" })).error.code).toBe(
    "BINARY_TEXT_REQUIRES_DOWNLOAD",
  );
});

test("original discovery survives a lost response/restart and two deliberate identical commands remain distinct", async () => {
  const value = await service();
  const requestId = "ws1-" + randomUUID();
  const request = {
    command: { argv: [process.execPath, "-e", "require('fs').appendFileSync('effect','once\\n')"] },
  };
  await tool(value, "command_run", request, requestId); // Deliberately discard the first response.
  const accepted = JSON.parse(
    readFileSync(join(value.stateRoot, "requests", requestId, "accepted.json")),
  );
  expect(accepted.intent).toMatchObject({ kind: "command", description: "Run node" });
  expect(accepted.intent.createdAt).toEqual(expect.any(Number));
  expect(JSON.stringify(accepted.intent)).not.toContain("appendFileSync");
  await stop(value);
  await start(value);
  const found = data(await tool(value, "operation_find", { kind: "command", query: "Run node" }));
  expect(found.operations).toHaveLength(1);
  const reference = found.operations[0].operation;
  expect(data(await tool(value, "operation_get", { reference })).state).toBe("completed");
  expect(data(await tool(value, "operation_get", { reference })).state).toBe("completed");
  await tool(value, "command_run", request);
  expect(readFileSync(join(value.root, "effect"), "utf8")).toBe("once\nonce\n");
  expect(data(await tool(value, "operation_find", { kind: "command" })).operations).toHaveLength(2);
  const conflict = await tool(value, "command_run", { command: { argv: ["false"] } }, requestId);
  expect(data(conflict).error.code).toBe("REQUEST_ID_CONFLICT");
});

test("foreign references refuse and absent inspection never creates a request directory", async () => {
  const value = await service();
  const { encodeReference } =
    await import("../../../packages/shared/src/codespaces/workspace-references.mjs");
  const before = readdirSync(join(value.stateRoot, "requests"));
  const reference = encodeReference("operation", {
    owner: value.ownerSelector,
    requestId: "ws1-" + randomUUID(),
    kind: "unknown",
  });
  expect(data(await tool(value, "operation_get", { reference })).state).toBe("absent");
  const foreign = encodeReference("operation", {
    owner: { ...value.ownerSelector, spaceId: randomUUID() },
    requestId: "ws1-" + randomUUID(),
    kind: "command",
  });
  expect(data(await tool(value, "operation_get", { reference: foreign })).error.code).toBe(
    "FOREIGN_OWNER_REFERENCE",
  );
  expect(readdirSync(join(value.stateRoot, "requests"))).toEqual(before);
});

test("old descriptorless unknown admission is discoverable without replay", async () => {
  const value = await service();
  const requestId = "ws1-" + randomUUID();
  const directory = join(value.stateRoot, "requests", requestId);
  mkdirSync(directory, { mode: 0o700 });
  writeFileSync(
    join(directory, "accepted.json"),
    JSON.stringify({ kind: "exec", digest: "a".repeat(64), environmentIdentity: "old-life" }),
    { mode: 0o600 },
  );
  const found = data(await tool(value, "operation_find", {}));
  expect(found.operations[0].description).toBe("Original owner operation");
  expect(
    data(await tool(value, "operation_get", { reference: found.operations[0].operation })).state,
  ).toBe("unconfirmed");
  expect(existsSync(join(value.root, "effect"))).toBe(false);
});

test("shared UTF8 output boundary distinguishes live incomplete data from terminal malformed bytes", async () => {
  const { utf8Window } = await import("../../../packages/workspace-service/src/utf8-window.mjs");
  expect(utf8Window(Buffer.from([0xf0, 0x9f]), 4, { terminal: false })).toMatchObject({
    text: "",
    bytes: 0,
    pending_utf8: true,
  });
  expect(utf8Window(Buffer.from([0xf0, 0x9f]), 4)).toEqual({ binary: true });
  const value = await service();
  const first = data(
    await tool(value, "command_run", {
      command: { argv: [process.execPath, "-e", "process.stdout.write('Я🙂аб🙂z')"] },
      max_stdout_bytes: 4,
    }),
  );
  let actual = first.stdout,
    cursor = first.stdout_cursor;
  while (cursor) {
    const next = data(
      await tool(value, "process_output", {
        process: first.process,
        stream: "stdout",
        cursor,
        max_bytes: 4,
      }),
    );
    actual += next.text;
    cursor = next.next_cursor;
  }
  expect(actual).toBe("Я🙂аб🙂z");
});

test("delivery receipt collection uses the same operation surface and retains original publication bytes", async () => {
  const value = await service();
  await stop(value);
  value.publicationScope = {
    resourceId: randomUUID(),
    resourceGeneration: 1,
    authorizationGeneration: 1,
    publicOrigin: "https://moira.example",
  };
  await start(value);
  const requestId = "ws1-" + randomUUID(),
    bytes = Buffer.from([0, 255, 42]);
  const reply = JSON.parse(
    (
      await call(
        value,
        "POST",
        "/v1/communication",
        {
          action: "publish",
          requestId,
          source: {
            type: "inline",
            data: bytes.toString("base64"),
            fileName: "original.bin",
            mimeType: "application/octet-stream",
          },
        },
        { "content-type": "application/json" },
      )
    ).bytes,
  );
  const found = data(
    await tool(value, "operation_find", { kind: "delivery", query: "original.bin" }),
  );
  expect(found.operations[0].description).toBe("Publish file original.bin");
  const collected = data(
    await tool(value, "operation_get", { reference: found.operations[0].operation }),
  );
  expect(collected.outcome).toEqual(reply.outcome);
  const token = reply.outcome.result.file.referenceId.split("/").at(-1);
  expect((await call(value, "GET", "/v1/publications/" + token)).bytes).toEqual(bytes);
});

test("delivery discovery does not create state and old-life receipt reads never reopen sources or replay delivery", async () => {
  const value = createFixture();
  fixtures.push(value);
  const { createOwnerCommunication, findOwnerCommunication } =
    await import("../../../packages/workspace-service/src/owner-communication.mjs");
  const { createOwnerPublications } =
    await import("../../../packages/workspace-service/src/publications.mjs");
  const scope = {
    kind: "workspace",
    resourceId: randomUUID(),
    resourceGeneration: 1,
    authorizationGeneration: 1,
    environmentIdentity: "original-life",
  };
  expect(await findOwnerCommunication({ stateRoot: value.stateRoot, scope })).toEqual({
    operations: [],
  });
  expect(existsSync(value.stateRoot)).toBe(false);
  const open = async (selected) => {
    const publications = await createOwnerPublications({
      stateRoot: value.stateRoot,
      scope: { ...selected, publicOrigin: "https://moira.example" },
      environmentIdentity: selected.environmentIdentity,
      withCommitLock: (work) => work(),
    });
    const communication = await createOwnerCommunication({
      stateRoot: value.stateRoot,
      scope: selected,
      publications,
      transport: {
        prepare: async () => ({
          channels: [
            {
              channelId: "telegram",
              provider: "telegram",
              authorityDigest: "a".repeat(64),
              capabilities: { text: true, image: true, document: true },
              operations: ["send_message"],
            },
          ],
        }),
        send: async (input, source) => {
          const record = JSON.parse(
            readFileSync(join(value.stateRoot, "communication", input.requestId + ".json")),
          );
          expect(record.descriptor).toMatchObject({
            kind: "delivery",
            description: "Deliver document owner.txt",
            createdAt: expect.any(Number),
          });
          expect(record.stages[0].status).toBe("accepted");
          for await (const _ of source) {
            /* actual source is drained once */
          }
          effects++;
          return { status: "delivered" };
        },
      },
    });
    return {
      communication,
      publications,
      close: async () => {
        await communication.close();
        await publications.close();
      },
    };
  };
  let effects = 0;
  const first = await open(scope),
    requestId = "ws1-" + randomUUID();
  const input = {
    action: "deliver",
    requestId,
    kind: "document",
    text: "safe",
    source: {
      type: "inline",
      data: Buffer.from("owner bytes").toString("base64"),
      fileName: "owner.txt",
      mimeType: "text/plain",
    },
  };
  const original = await first.communication.submit(input);
  await first.close();
  const next = await open({
    ...scope,
    resourceGeneration: 2,
    authorizationGeneration: 2,
    environmentIdentity: "new-life",
  });
  try {
    expect(await next.communication.inspect(requestId)).toEqual(original);
    expect((await next.communication.find()).operations).toMatchObject([
      { requestId, kind: "delivery", state: "completed" },
    ]);
    await expect(next.communication.submit(input)).rejects.toMatchObject({
      publicCode: "COMMUNICATION_SCOPE_REFUSED",
    });
    expect(effects).toBe(1);
  } finally {
    await next.close();
  }
  const foreign = await open({ ...scope, resourceId: randomUUID() });
  try {
    await expect(foreign.communication.inspect(requestId)).rejects.toMatchObject({
      publicCode: "COMMUNICATION_SCOPE_REFUSED",
    });
    expect((await foreign.communication.find()).operations).toEqual([]);
    expect(effects).toBe(1);
  } finally {
    await foreign.close();
  }
});

test("a local-only operation reference remains collectable at the same Unix owner after actual remote configuration", async () => {
  const { startWorkspaceService } =
    await import("../../../packages/workspace-service/src/server.mjs");
  const value = createFixture();
  fixtures.push(value);
  value.ownerSelector = {
    kind: "local",
    deviceId: randomUUID(),
    spaceId: randomUUID(),
    operationMarker: "moira-" + "c".repeat(24),
  };
  const previousIdentity = process.env.MOIRA_ENVIRONMENT_ID;
  process.env.MOIRA_ENVIRONMENT_ID = "semantic-local-enrollment-test";
  let service;
  try {
    service = await startWorkspaceService(value);
    const result = await service.owner.semantic("command_run", {
      command: {
        argv: [process.execPath, "-e", "require('node:fs').appendFileSync('effect','once\\n')"],
      },
    });
    const health = await service.owner.health();
    await service.owner.configureRemote({
      publicationScope: {
        resourceId: randomUUID(),
        resourceGeneration: 1,
        authorizationGeneration: 1,
        publicOrigin: "https://moira.example",
      },
    });
    const collected = await service.owner.semantic("operation_get", {
      reference: result.operation,
    });
    expect(collected).toEqual(
      await service.owner.semantic("operation_get", { reference: result.operation }),
    );
    expect(collected.state).toBe("completed");
    expect((await service.owner.health()).processId).toBe(health.processId);
    expect((await service.owner.health()).environmentIdentity).toBe(health.environmentIdentity);
    expect(readFileSync(join(value.root, "effect"), "utf8")).toBe("once\n");
  } finally {
    await service?.close();
    if (previousIdentity === undefined) delete process.env.MOIRA_ENVIRONMENT_ID;
    else process.env.MOIRA_ENVIRONMENT_ID = previousIdentity;
  }
});
