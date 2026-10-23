const { afterEach, beforeAll, expect, test } = require("@jest/globals");
const { spawn, spawnSync } = require("node:child_process");
const { randomUUID, randomBytes, createHash } = require("node:crypto");
const {
  readFileSync,
  writeFileSync,
  existsSync,
  symlinkSync,
  linkSync,
  mkdirSync,
  readdirSync,
  renameSync,
  unlinkSync,
  openSync,
  closeSync,
  statSync,
  watch,
} = require("node:fs");
const { join, resolve } = require("node:path");
const { pathToFileURL } = require("node:url");
const {
  createFixture,
  start,
  stop,
  call,
  dispose,
} = require("../../fixtures/workspace-service.cjs");
const cliUrl = pathToFileURL(resolve("packages/workspace-service/src/cli.mjs")).href;
let createWorkspaceRequestId;
let workspaceRequestUuid;
let encodeReference, decodeReference;
beforeAll(async () => {
  ({ createWorkspaceRequestId, workspaceRequestUuid } =
    await import("../../../packages/shared/src/codespaces/workspace-request-id.ts"));
  ({ encodeReference, decodeReference } =
    await import("../../../packages/shared/src/codespaces/workspace-references.mjs"));
});
const fixtures = [];
function fixture() {
  const value = createFixture();
  value.ownerSelector = { kind: "github", resourceId: randomUUID() };
  fixtures.push(value);
  return value;
}
afterEach(async () => {
  for (const value of fixtures.splice(0)) await dispose(value);
});

async function control(value, method, path, body) {
  const response = await call(value, method, path, body, { "content-type": "application/json" });
  if (response.status !== 200)
    throw new Error(`${method} ${path}: ${response.status} ${response.bytes.toString()}`);
  return JSON.parse(response.bytes.toString());
}

async function settle(value, requestId) {
  const deadline = Date.now() + 5000;
  let status;
  do {
    status = await control(value, "GET", `/v1/operations/${requestId}`);
    if (!["starting", "running"].includes(status.state)) return status;
    await new Promise((done) => setTimeout(done, 10));
  } while (Date.now() < deadline);
  throw new Error(`Operation did not settle: ${JSON.stringify(status)}`);
}

test("raw input and retained output exceed former envelopes without changing exact binary bytes", async () => {
  const value = fixture();
  await start(value);
  const bytes = Buffer.alloc(8 * 1024 * 1024 + 31);
  for (let index = 0; index < bytes.length; index++) bytes[index] = index % 251;
  const requestId = createWorkspaceRequestId();
  const input = await control(value, "PUT", `/v1/operations/${requestId}/input`, bytes);
  expect(input).toEqual({
    size: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  });
  await control(value, "POST", "/v1/exec", {
    requestId,
    inputReady: true,
    argv: [process.execPath, "-e", "process.stdin.pipe(process.stdout)"],
  });
  const result = await settle(value, requestId);
  expect(result.state).toBe("succeeded");
  expect(result.stdoutBytes).toBe(bytes.length);
  const output = await call(value, "GET", `/v1/operations/${requestId}/output`);
  expect(output.bytes.equals(bytes)).toBe(true);
  expect(existsSync(join(value.stateRoot, "requests", requestId, "input"))).toBe(false);
  expect(
    JSON.parse(readFileSync(join(value.stateRoot, "requests", requestId, "input.json"), "utf8")),
  ).toEqual(input);
});

test("the direct owner and tool view share original effects and retained results without an HTTP server", async () => {
  const value = fixture();
  const { createWorkspaceOwner } =
    await import("../../../packages/workspace-service/src/owner.mjs");
  const { executeOwnerTool } =
    await import("../../../packages/workspace-service/src/presentation.mjs");
  const options = {
    stateRoot: value.stateRoot,
    binding: value.binding,
    searchExecutable: value.searchExecutable,
    ownerSelector: value.ownerSelector,
  };
  let owner = await createWorkspaceOwner(options);
  const requestId = createWorkspaceRequestId();
  const request = {
    stdin_text: "retained input",
    command: {
      argv: [
        process.execPath,
        "-e",
        "const f=require('node:fs');f.appendFileSync('direct-effects','once\\n');process.stdin.pipe(process.stdout)",
      ],
    },
  };
  try {
    const admitted = await executeOwnerTool(owner, { action: "command_run", request, requestId });
    expect(admitted.isError).toBeUndefined();
    expect(await owner.observe(requestId, 5000)).toMatchObject({
      state: "succeeded",
      stdoutBytes: 14,
    });
    await owner.close();
    owner = await createWorkspaceOwner(options);
    const collected = await executeOwnerTool(owner, {
      action: "operation_get",
      request: { reference: admitted.structuredContent.operation },
    });
    expect(collected.structuredContent).toMatchObject({
      state: "completed",
      operation: admitted.structuredContent.operation,
      outcome: { ok: true, result: { stdoutBytes: 14 } },
    });
    const same = await executeOwnerTool(owner, { action: "command_run", request, requestId });
    expect(same.structuredContent).toMatchObject({
      state: "completed",
      operation: admitted.structuredContent.operation,
    });
    expect(readFileSync(join(value.root, "direct-effects"), "utf8")).toBe("once\n");
    expect(existsSync(value.socketPath)).toBe(false);
    const written = await executeOwnerTool(owner, {
      action: "file_create",
      request: {
        path: "direct-file",
        text: "owner\nbytes",
      },
    });
    expect(written.structuredContent).toMatchObject({
      state: "completed",
      outcome: { ok: true, result: { path: "direct-file" } },
    });
    const observed = await executeOwnerTool(owner, {
      action: "file_read",
      request: { path: "direct-file", window: { start_line: 2 } },
    });
    expect(observed.structuredContent).toMatchObject({ text: "bytes" });
    const writes = await Promise.all(
      ["first replacement", "second replacement"].map((text) =>
        executeOwnerTool(owner, {
          action: "file_replace",
          request: {
            path: "direct-file",
            expected: { file: observed.structuredContent.file },
            text,
          },
        }),
      ),
    );
    expect(writes.filter((result) => result.structuredContent.outcome?.ok === true)).toHaveLength(
      1,
    );
    expect(writes.filter((result) => result.isError)).toHaveLength(1);
    expect(["first replacement", "second replacement"]).toContain(
      readFileSync(join(value.root, "direct-file"), "utf8"),
    );
    renameSync(value.root, `${value.root}-retained`);
    mkdirSync(value.root);
    const refusedId = createWorkspaceRequestId();
    const refused = await executeOwnerTool(owner, {
      action: "command_run",
      requestId: refusedId,
      request: {
        command: {
          argv: [
            process.execPath,
            "-e",
            "require('node:fs').writeFileSync('foreign-effect','unexpected')",
          ],
        },
      },
    });
    expect(refused.structuredContent).toMatchObject({
      error: { code: "WORKSPACE_OPERATION_ERROR" },
    });
    expect(readdirSync(value.root)).toEqual([]);
    expect(existsSync(join(value.stateRoot, "requests", refusedId, "accepted.json"))).toBe(false);
  } finally {
    await owner.close();
  }
});

test("service restart and direct CLI collect a detached command without launching it again", async () => {
  const value = fixture();
  await start(value);
  const requestId = createWorkspaceRequestId();
  const body = {
    requestId,
    argv: [
      process.execPath,
      "-e",
      "const f=require('node:fs');f.appendFileSync('effects','once\\n');const t=setInterval(()=>{if(f.existsSync('release')){clearInterval(t);process.stdout.write('retained')}},10)",
    ],
  };
  const initial = await control(value, "POST", "/v1/exec", body);
  expect(["starting", "running"]).toContain(initial.state);
  const deadline = Date.now() + 5000;
  while (!existsSync(join(value.root, "effects"))) {
    if (Date.now() > deadline) throw new Error("Detached command did not reach its real effect");
    await new Promise((done) => setTimeout(done, 10));
  }
  // A lost launch observer can retain uncertainty while the already admitted
  // detached command remains real. Later collection must use its terminal proof.
  writeFileSync(
    join(value.stateRoot, "requests", requestId, "result.json"),
    JSON.stringify({ state: "unknown", reason: "COMMAND_OUTCOME_UNKNOWN" }),
    { mode: 0o600 },
  );
  await stop(value);
  writeFileSync(join(value.root, "release"), "release");
  await start(value);
  const result = await settle(value, requestId);
  expect(result.state).toBe("succeeded");
  await control(value, "POST", "/v1/exec", body);
  expect(readFileSync(join(value.root, "effects"), "utf8")).toBe("once\n");
  const cli = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import {runWorkspaceCli} from ${JSON.stringify(cliUrl)};await runWorkspaceCli(['get',${JSON.stringify(encodeReference("operation", { owner: value.ownerSelector, requestId, kind: "command" }))}],{socketPath:${JSON.stringify(value.socketPath)}});`,
    ],
    { encoding: "utf8" },
  );
  expect(cli.status).toBe(0);
  expect(JSON.parse(cli.stdout).structuredContent).toMatchObject({
    state: "completed",
    outcome: { ok: true, result: { stdoutBytes: 8 } },
  });
});

test("large guarded binary publication is idempotent and rejects traversal and a stale precondition", async () => {
  const value = fixture();
  await start(value);
  const bytes = Buffer.alloc(5 * 1024 * 1024 + 7, 0xfe);
  const requestId = createWorkspaceRequestId();
  const path = `/v1/files/write?path=binary.dat&requestId=${requestId}`;
  const headers = { "x-moira-expected": JSON.stringify({ exists: false }) };
  const written = await call(value, "PUT", path, bytes, headers);
  expect(written.status).toBe(200);
  const receipt = JSON.parse(written.bytes.toString());
  expect(receipt).toMatchObject({
    requestId,
    state: "succeeded",
    current: { size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") },
  });
  expect(readFileSync(join(value.root, "binary.dat")).equals(bytes)).toBe(true);
  const source = join(value.directory, "binary-source");
  writeFileSync(source, bytes);
  const replay = spawnSync(
    process.execPath,
    [
      resolve("packages/workspace-service/src/cli.mjs"),
      "get",
      encodeReference("operation", { owner: value.ownerSelector, requestId, kind: "file-change" }),
    ],
    { env: { ...process.env, MOIRA_WORKSPACE_SOCKET: value.socketPath }, encoding: "utf8" },
  );
  expect(replay.status).toBe(0);
  expect(JSON.parse(replay.stdout).structuredContent).toMatchObject({
    state: "completed",
    outcome: { ok: true, result: { path: "binary.dat", current: receipt.current } },
  });
  expect(JSON.parse((await call(value, "PUT", path, bytes, headers)).bytes.toString())).toEqual(
    receipt,
  );
  const refused = await call(
    value,
    "PUT",
    `/v1/files/write?path=binary.dat&requestId=${createWorkspaceRequestId()}`,
    Buffer.from("foreign"),
    headers,
  );
  expect(refused.status).toBe(409);
  expect(readFileSync(join(value.root, "binary.dat")).equals(bytes)).toBe(true);
  const range = await call(value, "GET", "/v1/files/read?path=binary.dat&offset=4194304&length=17");
  expect(range.bytes).toEqual(bytes.subarray(4194304, 4194321));
  writeFileSync(join(value.directory, "outside"), "private");
  symlinkSync(join(value.directory, "outside"), join(value.root, "link"));
  expect((await call(value, "GET", "/v1/files/read?path=../outside")).status).toBe(409);
  expect((await call(value, "GET", "/v1/files/read?path=link")).status).toBe(409);
});

test("persistent sessions exceed the former slot and variable ceilings while retaining context", async () => {
  const value = fixture();
  await start(value);
  for (let index = 0; index < 17; index++) {
    const requestId = createWorkspaceRequestId();
    await control(value, "POST", "/v1/exec", {
      requestId,
      session: `session-${index}`,
      sessionStart: true,
      script: "true",
    });
    expect((await settle(value, requestId)).state).toBe("succeeded");
  }
  const exported = createWorkspaceRequestId();
  const names = Array.from({ length: 70 }, (_, index) => `SERVICE_VALUE_${index}`);
  await control(value, "POST", "/v1/exec", {
    requestId: exported,
    session: "session-16",
    script: names.map((name) => `export ${name}=retained`).join("; "),
  });
  expect((await settle(value, exported)).state).toBe("succeeded");
  const inspected = createWorkspaceRequestId();
  await control(value, "POST", "/v1/exec", {
    requestId: inspected,
    session: "session-16",
    argv: [process.execPath, "-e", "process.stdout.write(process.env.SERVICE_VALUE_69)"],
  });
  expect((await settle(value, inspected)).state).toBe("succeeded");
  expect((await call(value, "GET", `/v1/operations/${inspected}/output`)).bytes.toString()).toBe(
    "retained",
  );
});

test("streamed patch keeps untouched large-file bytes and searches beyond the former scan budget", async () => {
  const value = fixture();
  const bytes = Buffer.alloc(5 * 1024 * 1024 + 31, 0x61);
  bytes[bytes.length - 9] = 10;
  Buffer.from("needle\n").copy(bytes, bytes.length - 8);
  writeFileSync(join(value.root, "large.txt"), bytes);
  await start(value);
  const original = await control(value, "POST", "/v1/files/stat", { path: "large.txt" });
  expect(original.stat.version.size).toBe(bytes.length);
  const search = await control(value, "POST", "/v1/files/search", {
    path: ".",
    query: "needle",
    mode: "literal",
    maxMatches: 10,
    maxBytes: 4096,
  });
  expect(search.matches).toContainEqual(
    expect.objectContaining({ path: "large.txt", line: 2, column: 1 }),
  );
  const requestId = createWorkspaceRequestId();
  const patch = await control(value, "POST", "/v1/files/patch", {
    requestId,
    files: [
      {
        path: "large.txt",
        expected: { exists: true, ...original.stat.version },
        edits: [{ start: 0, end: 1, text: "changed" }],
      },
    ],
  });
  expect(patch.state).toBe("succeeded");
  const actual = readFileSync(join(value.root, "large.txt"));
  expect(actual.subarray(0, 7).toString()).toBe("changed");
  expect(actual.subarray(7).equals(bytes.subarray(1))).toBe(true);
  expect(readdirSync(value.root).filter((name) => name.startsWith(".moira-"))).toEqual([]);
});

test.each([false, true])(
  "restart settles only owned interrupted file publication (foreign replacement: %s)",
  async (foreign) => {
    const value = fixture();
    writeFileSync(join(value.root, "target"), "original");
    await start(value);
    const previous = await control(value, "POST", "/v1/files/stat", { path: "target" });
    await stop(value);
    const requestId = createWorkspaceRequestId();
    // This fixture represents a pre-index retained operation, not a new admission
    // bypassing the current owner's durable active membership.
    unlinkSync(join(value.stateRoot, "active-requests.json"));
    const directory = join(value.stateRoot, "requests", requestId);
    mkdirSync(directory, { mode: 0o700 });
    const marker = `moira-op-${workspaceRequestUuid(requestId).replaceAll("-", "")}`;
    const committed = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
    import {createWorkspaceEngine} from ${JSON.stringify(pathToFileURL(resolve("packages/workspace-service/src/engine.mjs")).href)};
    const engine=createWorkspaceEngine(${JSON.stringify({ stateRoot: join(value.stateRoot, "engine"), binding: value.binding })});
    const directory=${JSON.stringify(directory)};const marker=${JSON.stringify(marker)};
    const staged=await engine.stageStream('target',[Buffer.from('new bytes')],${JSON.stringify({ exists: true, ...previous.stat.version })},marker);
    await engine.writeDurableJson(directory,'accepted.json',{kind:'write',path:'target',sha256:staged.sha256,size:staged.size});
    await engine.withFileCommitLock(()=>engine.commitStaged([staged],marker,directory));
  `,
      ],
      { encoding: "utf8" },
    );
    expect({ status: committed.status, stderr: committed.stderr }).toEqual({
      status: 0,
      stderr: "",
    });
    expect(readFileSync(join(value.root, "target"), "utf8")).toBe("new bytes");
    // This is the real durable commit before its result publication, not a fabricated journal.
    if (foreign) writeFileSync(join(value.root, "target"), "independent edit");
    await start(value);
    const result = await control(value, "GET", `/v1/operations/${requestId}`);
    expect(result.state).toBe(foreign ? "unknown" : "interrupted");
    expect(readFileSync(join(value.root, "target"), "utf8")).toBe(
      foreign ? "independent edit" : "original",
    );
    expect(readdirSync(value.root).some((name) => name.startsWith(".moira-"))).toBe(foreign);
    expect(existsSync(join(value.stateRoot, "active-requests", `${requestId}.json`))).toBe(foreign);
  },
);

test.each(["target", "parent", "absent-parent"])(
  "staged publication refuses a substituted %s without touching foreign files",
  async (substitution) => {
    const value = fixture();
    const parent = join(value.root, "nested");
    const outside = join(value.directory, "outside");
    mkdirSync(parent);
    mkdirSync(outside);
    writeFileSync(join(outside, "target"), "outside");
    const absent = substitution === "absent-parent";
    if (!absent) writeFileSync(join(parent, "target"), "original");
    await start(value);
    await stop(value);
    const requestId = createWorkspaceRequestId();
    const directory = join(value.stateRoot, "requests", requestId);
    mkdirSync(directory, { mode: 0o700 });
    const marker = `moira-op-${workspaceRequestUuid(requestId).replaceAll("-", "")}`;
    const published = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
        import {createWorkspaceEngine} from ${JSON.stringify(pathToFileURL(resolve("packages/workspace-service/src/engine.mjs")).href)};
        import * as fs from 'node:fs';
        const engine=createWorkspaceEngine(${JSON.stringify({ stateRoot: join(value.stateRoot, "engine"), binding: value.binding })});
        const item=await engine.stageStream('nested/target',[Buffer.from('desired')],{exists:${!absent}},${JSON.stringify(marker)});
        const parent=${JSON.stringify(parent)}, outside=${JSON.stringify(outside)};
        if(${JSON.stringify(substitution)}==='target') {
          fs.renameSync(parent+'/target',parent+'/retained-original');
          fs.writeFileSync(parent+'/target','original');
        } else {
          fs.renameSync(parent,parent+'-retained');
          if(${absent}) fs.mkdirSync(parent);
          else fs.symlinkSync(outside,parent);
        }
        const foreign=${absent} ? parent : parent+'/target';
        const before=fs.statSync(foreign);
        try {
          await engine.withFileCommitLock(()=>engine.commitStaged([item],${JSON.stringify(marker)},${JSON.stringify(directory)}));
          process.stdout.write(JSON.stringify({accepted:true}));
        } catch(error) {
          process.stdout.write(JSON.stringify({accepted:false,reason:error.fileReason,before:{dev:before.dev,ino:before.ino},after:{dev:fs.statSync(foreign).dev,ino:fs.statSync(foreign).ino}}));
        }
      `,
      ],
      { encoding: "utf8" },
    );
    expect({ status: published.status, stderr: published.stderr }).toEqual({
      status: 0,
      stderr: "",
    });
    const result = JSON.parse(published.stdout);
    expect(result.accepted).toBe(false);
    expect(result.after).toEqual(result.before);
    expect(readFileSync(join(outside, "target"), "utf8")).toBe("outside");
    if (absent) {
      expect(existsSync(join(parent, "target"))).toBe(false);
      expect(existsSync(join(`${parent}-retained`, "target"))).toBe(false);
    } else if (substitution === "parent") {
      expect(readFileSync(join(`${parent}-retained`, "target"), "utf8")).toBe("original");
    } else {
      expect(readFileSync(join(parent, "target"), "utf8")).toBe("original");
      expect(statSync(join(parent, "target")).ino).not.toBe(
        statSync(join(parent, "retained-original")).ino,
      );
    }
  },
);

test.each(["owned", "target", "backup"])(
  "partial multi-file publication recovers only after checking every retained inode (%s)",
  async (substitution) => {
    const value = fixture();
    writeFileSync(join(value.root, "one"), "one");
    writeFileSync(join(value.root, "two"), "two");
    await start(value);
    await stop(value);
    const requestId = createWorkspaceRequestId();
    const directory = join(value.stateRoot, "requests", requestId);
    mkdirSync(directory, { mode: 0o700 });
    const marker = `moira-op-${workspaceRequestUuid(requestId).replaceAll("-", "")}`;
    const interrupted = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
        import * as fs from 'node:fs';
        import promises from 'node:fs/promises';
        import {syncBuiltinESMExports} from 'node:module';
        const rename=promises.rename;
        let backups=0;
        promises.rename=async(from,to)=>{
          await rename(from,to);
          if(String(to).endsWith('.bak')&&++backups===2) process.exit(91);
        };
        syncBuiltinESMExports();
        const {createWorkspaceEngine}=await import(${JSON.stringify(pathToFileURL(resolve("packages/workspace-service/src/engine.mjs")).href)});
        const engine=createWorkspaceEngine(${JSON.stringify({ stateRoot: join(value.stateRoot, "engine"), binding: value.binding })});
        const directory=${JSON.stringify(directory)},marker=${JSON.stringify(marker)};
        const {retainActiveRequest}=await import(${JSON.stringify(pathToFileURL(resolve("packages/workspace-service/src/request-retirement.mjs")).href)});
        await retainActiveRequest(directory);
        const staged=[];
        for(const name of ['one','two']) staged.push(await engine.stageStream(name,[Buffer.from(name.toUpperCase())],{exists:true},marker));
        await engine.writeDurableJson(directory,'accepted.json',{kind:'patch'});
        await engine.withFileCommitLock(()=>engine.commitStaged(staged,marker,directory));
      `,
      ],
      { encoding: "utf8" },
    );
    expect({ status: interrupted.status, stderr: interrupted.stderr }).toEqual({
      status: 91,
      stderr: "",
    });
    const entries = JSON.parse(readFileSync(join(directory, "file-transaction.json"), "utf8"));
    expect(entries.map((entry) => entry.commitAttempted)).toEqual([true, true]);
    expect(readFileSync(join(value.root, "one"), "utf8")).toBe("ONE");
    expect(existsSync(join(value.root, "two"))).toBe(false);
    expect(readFileSync(join(value.root, entries[1].temporaryName), "utf8")).toBe("TWO");
    for (const entry of entries)
      expect(readFileSync(join(value.root, entry.backup), "utf8")).toBe(entry.target);
    let retained;
    try {
      if (substitution !== "owned") {
        const foreign = join(value.root, substitution === "target" ? "one" : entries[0].backup);
        const original = statSync(foreign);
        const bytes = readFileSync(foreign);
        // Keep the removed inode open so identical content cannot accidentally
        // reuse its inode and make a digest-only ownership test look sufficient.
        retained = openSync(foreign, "r");
        unlinkSync(foreign);
        writeFileSync(foreign, bytes);
        expect(statSync(foreign).ino).not.toBe(original.ino);
      }
      const paths = entries.flatMap((entry) => [entry.target, entry.backup, entry.temporaryName]);
      const observe = () =>
        paths.map((name) => {
          const path = join(value.root, name);
          if (!existsSync(path)) return { name, absent: true };
          const identity = statSync(path);
          return { name, dev: identity.dev, ino: identity.ino, bytes: readFileSync(path) };
        });
      const before = observe();
      await start(value);
      const result = await control(value, "GET", `/v1/operations/${requestId}`);
      if (substitution === "owned") {
        expect(result.state).toBe("interrupted");
        for (const name of ["one", "two"])
          expect(readFileSync(join(value.root, name), "utf8")).toBe(name);
        for (const entry of entries) {
          const original = before.find((item) => item.name === entry.backup);
          const restored = statSync(join(value.root, entry.target));
          expect({ dev: restored.dev, ino: restored.ino }).toEqual({
            dev: original.dev,
            ino: original.ino,
          });
          expect(existsSync(join(value.root, entry.backup))).toBe(false);
          expect(existsSync(join(value.root, entry.temporaryName))).toBe(false);
        }
        expect(existsSync(join(directory, "file-transaction.json"))).toBe(false);
      } else {
        expect(result.state).toBe("unknown");
        // Recovery walks in reverse order. The foreign first entry must be
        // discovered before restoring the second entry or removing its stage.
        expect(observe()).toEqual(before);
      }
      await stop(value);
      await start(value);
      expect((await control(value, "GET", `/v1/operations/${requestId}`)).state).toBe(
        substitution === "owned" ? "interrupted" : "unknown",
      );
      if (substitution !== "owned") expect(observe()).toEqual(before);
      expect(existsSync(join(value.stateRoot, "active-requests", `${requestId}.json`))).toBe(
        substitution !== "owned",
      );
    } finally {
      if (retained !== undefined) closeSync(retained);
    }
  },
);

test("declared binary size mismatch preserves input and target without publishing a new effect", async () => {
  const value = fixture();
  await start(value);
  const requestId = createWorkspaceRequestId();
  const bytes = Buffer.from([0, 255, 1, 128]);
  const refused = await call(value, "PUT", `/v1/operations/${requestId}/input`, bytes, {
    "x-moira-content-size": "5",
  });
  expect(JSON.parse(refused.bytes.toString())).toEqual({
    error: { code: "CONTENT_SIZE_MISMATCH" },
  });
  expect(existsSync(join(value.stateRoot, "requests", requestId, "input.json"))).toBe(false);
  const accepted = await call(value, "PUT", `/v1/operations/${requestId}/input`, bytes, {
    "x-moira-content-size": "4",
  });
  expect(accepted.status).toBe(200);
  const conflict = await call(
    value,
    "PUT",
    `/v1/operations/${requestId}/input`,
    Buffer.from("changed"),
  );
  expect(JSON.parse(conflict.bytes.toString()).error.code).toBe("REQUEST_ID_CONFLICT");
  expect(readFileSync(join(value.stateRoot, "requests", requestId, "input")).equals(bytes)).toBe(
    true,
  );
  writeFileSync(join(value.root, "target"), "original");
  const stat = await control(value, "POST", "/v1/files/stat", { path: "target" });
  const write = await call(
    value,
    "PUT",
    `/v1/files/write?path=target&requestId=${createWorkspaceRequestId()}`,
    bytes,
    {
      "x-moira-content-size": "3",
      "x-moira-expected": JSON.stringify({ exists: true, ...stat.stat.version }),
    },
  );
  expect(JSON.parse(write.bytes.toString()).error.code).toBe("CONTENT_SIZE_MISMATCH");
  expect(readFileSync(join(value.root, "target"), "utf8")).toBe("original");
});

test("rejected preflight remains a collectible no-start result and direct CLI invokes the service", async () => {
  const value = fixture();
  await start(value);
  const requestId = createWorkspaceRequestId();
  const result = await control(value, "POST", "/v1/exec", { requestId, argv: [] });
  expect(result).toMatchObject({ requestId, state: "not_started", reason: "COMMAND_REJECTED" });
  expect(await control(value, "GET", `/v1/operations/${requestId}`)).toEqual(result);
  expect(
    existsSync(
      join(
        value.stateRoot,
        "engine",
        `moira-op-${workspaceRequestUuid(requestId).replaceAll("-", "")}`,
      ),
    ),
  ).toBe(false);
  const cli = spawnSync(
    process.execPath,
    [
      resolve("packages/workspace-service/src/cli.mjs"),
      "get",
      encodeReference("operation", { owner: value.ownerSelector, requestId, kind: "command" }),
    ],
    { env: { ...process.env, MOIRA_WORKSPACE_SOCKET: value.socketPath }, encoding: "utf8" },
  );
  expect(cli.status).toBe(1);
  expect(JSON.parse(cli.stdout)).toMatchObject({
    isError: true,
    structuredContent: { state: "completed", outcome: { ok: false } },
  });
  const conflicting = await call(value, "POST", "/v1/exec", { requestId, argv: ["true"] });
  expect(JSON.parse(conflicting.bytes.toString()).error.code).toBe("REQUEST_ID_CONFLICT");
  const missing = createWorkspaceRequestId();
  await control(value, "POST", "/v1/exec", {
    requestId: missing,
    session: "never-opened",
    argv: ["true"],
  });
  const unavailable = await settle(value, missing);
  expect(unavailable).toMatchObject({
    requestId: missing,
    state: "not_started",
    reason: "SESSION_UNAVAILABLE",
  });
  expect(await control(value, "GET", `/v1/operations/${missing}`)).toEqual(unavailable);
});

test("collection rechecks terminal proof when preflight finishes across its original read", async () => {
  const value = fixture();
  const requestId = createWorkspaceRequestId();
  const resultPath = join(
    value.stateRoot,
    "engine",
    `moira-op-${workspaceRequestUuid(requestId).replaceAll("-", "")}`,
    "result.json",
  );
  const membership = join(value.stateRoot, "active-requests", `${requestId}.json`);
  const publication = join(value.directory, "publication-held");
  const release = join(value.directory, "release-publication");
  const armed = join(value.directory, "read-armed");
  const readHeld = join(value.directory, "read-held");
  const collected = join(value.directory, "launch-collected");
  const hook = join(value.directory, "preflight-read-race.cjs");
  writeFileSync(
    hook,
    `const fs=require('node:fs');
const promises=require('node:fs/promises');
const paths=${JSON.stringify({ resultPath, membership, publication, release, armed, readHeld, collected, index: join(value.stateRoot, "active-requests"), directory: value.directory })};
function reached(path){return new Promise(done=>{const check=()=>{if(fs.existsSync(path)){watcher.close();done()}};const watcher=fs.watch(paths.directory,check);check()})}
const rename=promises.rename;
promises.rename=async(from,to)=>{if(to===paths.resultPath){fs.writeFileSync(paths.publication,'ready');await reached(paths.release)}return rename(from,to)};
const readFile=promises.readFile;
let misses=0,resumeRead;
promises.readFile=async(...args)=>{try{return await readFile(...args)}catch(error){if(args[0]===paths.resultPath&&error.code==='ENOENT'&&fs.existsSync(paths.armed)&&++misses===2){fs.writeFileSync(paths.readHeld,'two absent result observations');await new Promise(done=>{resumeRead=done})}throw error}};
const open=promises.open;
promises.open=async(...args)=>{const handle=await open(...args);if(args[0]===paths.index){const close=handle.close.bind(handle);handle.close=async()=>{await close();if(resumeRead&&fs.existsSync(paths.resultPath)&&!fs.existsSync(paths.membership)){const done=resumeRead;resumeRead=null;setImmediate(()=>{fs.writeFileSync(paths.collected,'terminal proof retired by original collector');done()})}}}return handle};
require('node:module').syncBuiltinESMExports();`,
  );
  value.environment = { NODE_OPTIONS: `--require=${hook}` };
  const reached = (path) =>
    new Promise((done) => {
      const check = () => {
        if (existsSync(path)) {
          watcher.close();
          done();
        }
      };
      const watcher = watch(value.directory, check);
      check();
    });
  await start(value);
  try {
    expect(
      await control(value, "POST", "/v1/exec", {
        requestId,
        session: "never-opened",
        argv: ["true"],
      }),
    ).toMatchObject({ requestId, state: "starting" });
    await reached(publication);
    writeFileSync(armed, "armed");
    const observation = control(value, "GET", `/v1/operations/${requestId}`);
    await reached(readHeld);
    writeFileSync(release, "release");
    const result = await observation;
    expect(readFileSync(collected, "utf8")).toBe("terminal proof retired by original collector");
    expect(JSON.parse(readFileSync(resultPath, "utf8"))).toMatchObject({
      state: "not_started",
      reason: "SESSION_UNAVAILABLE",
      inputSettled: true,
    });
    expect(existsSync(membership)).toBe(false);
    expect(existsSync(join(resultPath, "..", "pid"))).toBe(false);
    expect(existsSync(join(resultPath, "..", "runner-pid"))).toBe(false);
    expect(result).toMatchObject({
      requestId,
      state: "not_started",
      reason: "SESSION_UNAVAILABLE",
    });
    expect(await control(value, "GET", `/v1/operations/${requestId}`)).toEqual(result);
    const retained = readFileSync(resultPath);
    await stop(value);
    await start(value);
    expect(await control(value, "GET", `/v1/operations/${requestId}`)).toEqual(result);
    expect(readFileSync(resultPath)).toEqual(retained);
  } finally {
    writeFileSync(release, "release");
  }
});

test("observer waiting collects completion while cancellation confirms the real process group is gone", async () => {
  const value = fixture();
  await start(value);
  const requestId = createWorkspaceRequestId();
  await control(value, "POST", "/v1/exec", {
    requestId,
    argv: [process.execPath, "-e", "process.stdout.write('finished')"],
  });
  const result = await control(value, "GET", `/v1/operations/${requestId}?waitMs=10000`);
  expect(result.state).toBe("succeeded");
  const held = createWorkspaceRequestId();
  await control(value, "POST", "/v1/exec", {
    requestId: held,
    timeoutMs: 5000,
    argv: [process.execPath, "-e", "setInterval(()=>{},1000)"],
  });
  const launched = join(
    value.stateRoot,
    "engine",
    `moira-op-${workspaceRequestUuid(held).replaceAll("-", "")}`,
    "pid",
  );
  const launchDeadline = Date.now() + 5000;
  while (!existsSync(launched)) {
    if (Date.now() > launchDeadline)
      throw new Error("Cancellation fixture did not physically launch");
    await new Promise((done) => setTimeout(done, 10));
  }
  const pid = JSON.parse(
    readFileSync(
      join(
        value.stateRoot,
        "engine",
        `moira-op-${workspaceRequestUuid(held).replaceAll("-", "")}`,
        "pid",
      ),
      "utf8",
    ),
  ).pid;
  const cancelled = await control(value, "POST", `/v1/operations/${held}/cancel`);
  expect(cancelled.state).toBe("cancelled");
  expect(() => process.kill(pid, 0)).toThrow();
});

test("an explicit command deadline reports timeout only after actual owned termination", async () => {
  const value = fixture();
  await start(value);
  const requestId = createWorkspaceRequestId();
  await control(value, "POST", "/v1/exec", {
    requestId,
    timeoutMs: 1000,
    argv: [process.execPath, "-e", "process.stdout.write('deadline');setInterval(()=>{},1000)"],
  });
  expect(await settle(value, requestId)).toMatchObject({ requestId, state: "timed_out" });
  const directory = join(
    value.stateRoot,
    "engine",
    `moira-op-${workspaceRequestUuid(requestId).replaceAll("-", "")}`,
  );
  const owner = JSON.parse(readFileSync(join(directory, "pid"), "utf8")).pid;
  expect(() => process.kill(owner, 0)).toThrow();
  expect((await call(value, "GET", `/v1/operations/${requestId}/output`)).bytes.toString()).toBe(
    "deadline",
  );
});

test("large control scripts and giant regex matches have no old envelope or line-buffer ceiling", async () => {
  const value = fixture();
  await start(value);
  const requestId = createWorkspaceRequestId();
  const script = `#${"x".repeat(1024 * 1024 + 13)}\nprintf 'executed'`;
  await control(value, "POST", "/v1/exec", { requestId, script });
  expect((await settle(value, requestId)).state).toBe("succeeded");
  expect((await call(value, "GET", `/v1/operations/${requestId}/output`)).bytes.toString()).toBe(
    "executed",
  );
  writeFileSync(join(value.root, "giant.txt"), "a".repeat(5 * 1024 * 1024));
  const searched = await control(value, "POST", "/v1/files/search", {
    path: ".",
    mode: "regex",
    query: "a+",
    maxMatches: 10,
    maxBytes: 4096,
  });
  expect(searched.matches).toContainEqual({
    path: "giant.txt",
    line: 1,
    column: 1,
    preview: "a".repeat(512),
  });
});

test("legacy caller and operation UUIDs cannot address new work despite an independent retained remote marker", async () => {
  const value = fixture();
  const callerId = randomUUID();
  const operationId = randomUUID();
  const remoteMarker = `moira-op-${randomBytes(16).toString("hex")}`;
  const legacyRoot = join(value.directory, ".local/state/moira/operations");
  const legacy = join(legacyRoot, remoteMarker);
  mkdirSync(legacy, { recursive: true, mode: 0o700 });
  const receipt = JSON.stringify({ requestHash: "a".repeat(64), launchAttempted: true });
  writeFileSync(join(legacy, "execution.json"), receipt, { mode: 0o600 });
  await start(value);
  const requests = readdirSync(join(value.stateRoot, "requests"));
  const refused = await call(value, "POST", "/v1/exec", {
    requestId: callerId,
    argv: [process.execPath, "-e", "require('node:fs').writeFileSync('effect','replayed')"],
  });
  expect(refused.status).toBe(400);
  expect(JSON.parse(refused.bytes.toString()).error.code).toBe("INVALID_REQUEST_ID");
  expect(existsSync(join(value.root, "effect"))).toBe(false);
  for (const oldId of [callerId, operationId]) {
    for (const [method, path, body, headers] of [
      ["POST", "/v1/exec", { requestId: oldId, argv: ["true"] }],
      ["GET", `/v1/operations/${oldId}`],
      ["GET", `/v1/operations/${oldId}/output`],
      ["POST", `/v1/operations/${oldId}/cancel`],
      ["PUT", `/v1/operations/${oldId}/input`, Buffer.from("old input")],
      [
        "PUT",
        `/v1/files/write?requestId=${oldId}&path=old-file`,
        Buffer.from("old file"),
        { "x-moira-expected": '{"exists":false}' },
      ],
      ["POST", "/v1/files/patch", { requestId: oldId, files: [] }],
    ]) {
      const result = await call(value, method, path, body, headers);
      expect(result.status).toBe(400);
      expect(JSON.parse(result.bytes.toString()).error.code).toBe("INVALID_REQUEST_ID");
    }
  }
  expect(readdirSync(join(value.stateRoot, "requests"))).toEqual(requests);
  expect(existsSync(join(value.root, "old-file"))).toBe(false);
  expect(readFileSync(join(legacy, "execution.json"), "utf8")).toBe(receipt);
  expect(readdirSync(legacyRoot)).toEqual([remoteMarker]);
  const requestId = createWorkspaceRequestId();
  expect(
    await control(value, "POST", "/v1/exec", {
      requestId,
      argv: [process.execPath, "-e", "process.stdout.write('fresh namespace')"],
    }),
  ).toMatchObject({ requestId });
  expect((await settle(value, requestId)).state).toBe("succeeded");
  expect((await call(value, "GET", `/v1/operations/${requestId}/output`)).bytes.toString()).toBe(
    "fresh namespace",
  );
  expect(readFileSync(join(legacy, "execution.json"), "utf8")).toBe(receipt);
});

test("ordinary CLI refuses caller IDs and collects distinct fresh commands through returned references", async () => {
  const value = fixture();
  await start(value);
  const oldId = randomUUID();
  const source = join(value.directory, "cli-source");
  const patch = join(value.directory, "cli-patch.json");
  writeFileSync(source, "new bytes");
  writeFileSync(patch, JSON.stringify({ requestId: oldId, files: [] }));
  const requests = readdirSync(join(value.stateRoot, "requests"));
  const run = (args) =>
    spawnSync(process.execPath, [resolve("packages/workspace-service/src/cli.mjs"), ...args], {
      env: { ...process.env, MOIRA_WORKSPACE_SOCKET: value.socketPath },
      encoding: "utf8",
    });
  for (const args of [
    ["exec", "--request-id", oldId, "--", "true"],
    ["exec", "--request-id"],
    ["status", oldId],
    ["cancel", oldId],
    ["output", oldId],
    ["write", "--request-id", oldId, "old-target", source],
    ["upload", "--request-id", oldId, "old-target", source],
    ["patch", patch],
  ]) {
    const refused = run(args);
    expect(refused.status).toBe(1);
  }
  expect(readdirSync(join(value.stateRoot, "requests"))).toEqual(requests);
  expect(existsSync(join(value.root, "old-target"))).toBe(false);
  const operations = [];
  for (let index = 0; index < 2; index++) {
    const generated = run([
      "exec",
      "--",
      process.execPath,
      "-e",
      "require('node:fs').appendFileSync('cli-effects','once\\n')",
    ]);
    expect(generated.status).toBe(0);
    const result = JSON.parse(generated.stdout).structuredContent;
    expect(result).toMatchObject({ state: "completed", outcome: { ok: true } });
    const identity = decodeReference(result.operation, "operation").requestId;
    expect(identity).toMatch(/^ws1-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/);
    expect((await settle(value, identity)).state).toBe("succeeded");
    expect(run(["get", result.operation]).status).toBe(0);
    operations.push(result.operation);
  }
  expect(operations[0]).not.toBe(operations[1]);
  expect(readFileSync(join(value.root, "cli-effects"), "utf8")).toBe("once\nonce\n");
});

test("argv, inline stdin and genuine exit codes survive the HTTP service without shell interpretation", async () => {
  const value = fixture();
  await start(value);
  const requestId = createWorkspaceRequestId();
  await control(value, "POST", "/v1/exec", {
    requestId,
    stdinText: "native stdin",
    argv: [
      process.execPath,
      "-e",
      "let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>{process.stdout.write(process.argv[1]+'|'+s);process.stderr.write('err');process.exit(23)});",
      "argument with spaces;$(false)",
    ],
  });
  expect(await settle(value, requestId)).toMatchObject({
    state: "failed",
    exitCode: 23,
    stderrBytes: 3,
  });
  expect((await call(value, "GET", `/v1/operations/${requestId}/output`)).bytes.toString()).toBe(
    "argument with spaces;$(false)|native stdin",
  );
  const refused = createWorkspaceRequestId();
  await control(value, "POST", "/v1/exec", {
    requestId: refused,
    argv: [join(value.root, "missing-executable")],
  });
  const negative = await settle(value, refused);
  try {
    expect(negative).toMatchObject({ state: "not_started", exitCode: null });
  } catch (error) {
    const directory = join(
      value.stateRoot,
      "engine",
      `moira-op-${workspaceRequestUuid(refused).replaceAll("-", "")}`,
    );
    error.message += `\nOriginal runner evidence: ${JSON.stringify(
      readdirSync(directory)
        .filter((name) => name.endsWith(".json"))
        .map((name) => {
          try {
            const record = JSON.parse(readFileSync(join(directory, name), "utf8"));
            return [
              name,
              Object.fromEntries(
                [
                  "state",
                  "reason",
                  "inputSettled",
                  "requestDigest",
                  "pid",
                  "startTime",
                  "launchAttempted",
                  "startedAt",
                ]
                  .filter((key) => ["string", "number", "boolean"].includes(typeof record?.[key]))
                  .map((key) => [key, record[key]]),
              ),
            ];
          } catch (failure) {
            return [name, { code: failure.code ?? "INVALID_DIAGNOSTIC_RECORD" }];
          }
        }),
    )}`;
    throw error;
  }
});

test("large Unicode environment values cross the real runner pipe without changing accepted bytes", async () => {
  const value = fixture();
  await start(value);
  // Each variable remains below Linux's per-string exec bound; the complete
  // launch metadata crosses actual pipe reads and contains multibyte UTF-8.
  const text = "€🙂Ж".repeat(6000);
  const bytes = Buffer.from(text, "utf8");
  const expected = createHash("sha256").update(bytes).digest("hex");
  const stdin = Buffer.from(text.repeat(2), "utf8");
  const requestId = createWorkspaceRequestId();
  await control(value, "POST", "/v1/exec", {
    requestId,
    env: { FIRST_UNICODE: text, SECOND_UNICODE: text, THIRD_UNICODE: text },
    stdinText: text.repeat(2),
    argv: [
      process.execPath,
      "-e",
      "const {createHash}=require('node:crypto');const chunks=[];process.stdin.on('data',chunk=>chunks.push(chunk));process.stdin.on('end',()=>{const bytes=Buffer.concat(chunks);process.stdout.write(JSON.stringify({environments:['FIRST_UNICODE','SECOND_UNICODE','THIRD_UNICODE'].map(key=>({size:Buffer.byteLength(process.env[key]),sha256:createHash('sha256').update(process.env[key]).digest('hex')})),stdin:{size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')}}))})",
    ],
  });
  expect((await settle(value, requestId)).state).toBe("succeeded");
  const output = await call(value, "GET", `/v1/operations/${requestId}/output`);
  expect(JSON.parse(output.bytes.toString())).toEqual({
    environments: Array(3).fill({ size: bytes.length, sha256: expected }),
    stdin: { size: stdin.length, sha256: createHash("sha256").update(stdin).digest("hex") },
  });
});

test("hard links and special files refuse reads while a stale multi-file patch has no partial effect", async () => {
  const value = fixture();
  writeFileSync(join(value.root, "one"), "one");
  writeFileSync(join(value.root, "two"), "two");
  writeFileSync(join(value.root, "linked-original"), "owned");
  linkSync(join(value.root, "linked-original"), join(value.root, "hard"));
  expect(spawnSync("mkfifo", [join(value.root, "special")]).status).toBe(0);
  await start(value);
  for (const path of ["hard", "special"])
    expect((await call(value, "GET", `/v1/files/read?path=${path}`)).status).toBe(409);
  const requestId = createWorkspaceRequestId();
  const body = {
    requestId,
    files: [
      { path: "two", expected: { exists: true }, edits: [{ start: 0, end: 3, text: "TWO" }] },
      {
        path: "one",
        expected: { exists: true, sha256: "0".repeat(64) },
        edits: [{ start: 0, end: 3, text: "ONE" }],
      },
    ],
  };
  const patch = await control(value, "POST", "/v1/files/patch", body);
  expect(patch).toEqual({ requestId, state: "not_started", reason: "precondition" });
  expect(await control(value, "GET", `/v1/operations/${requestId}`)).toEqual(patch);
  expect(await control(value, "POST", "/v1/files/patch", body)).toEqual(patch);
  expect(readFileSync(join(value.root, "one"), "utf8")).toBe("one");
  expect(readFileSync(join(value.root, "two"), "utf8")).toBe("two");
  expect(readdirSync(value.root).filter((name) => name.startsWith(".moira-"))).toEqual([]);
});

test("session directory and context remain local and a replaced bound root cannot admit a command", async () => {
  const value = fixture();
  mkdirSync(join(value.root, "nested"));
  await start(value);
  const opening = createWorkspaceRequestId();
  await control(value, "POST", "/v1/exec", {
    requestId: opening,
    session: "working",
    sessionStart: true,
    script: "cd nested; export WORKSPACE_CONTEXT=retained",
  });
  expect((await settle(value, opening)).state).toBe("succeeded");
  const next = createWorkspaceRequestId();
  await control(value, "POST", "/v1/exec", {
    requestId: next,
    session: "working",
    argv: [
      process.execPath,
      "-e",
      "process.stdout.write(process.cwd()+'|'+process.env.WORKSPACE_CONTEXT)",
    ],
  });
  expect((await settle(value, next)).state).toBe("succeeded");
  expect((await call(value, "GET", `/v1/operations/${next}/output`)).bytes.toString()).toBe(
    `${join(value.root, "nested")}|retained`,
  );
  renameSync(value.root, `${value.root}-retained`);
  mkdirSync(value.root);
  const refused = await call(value, "POST", "/v1/exec", {
    requestId: createWorkspaceRequestId(),
    argv: ["true"],
  });
  expect(refused.status).toBe(409);
  expect(readdirSync(value.root)).toEqual([]);
});

test("an occupied session admits a collectible cancellable request while independent work proceeds", async () => {
  const value = fixture();
  await start(value);
  const first = createWorkspaceRequestId(),
    queued = createWorkspaceRequestId(),
    other = createWorkspaceRequestId();
  await control(value, "POST", "/v1/exec", {
    requestId: first,
    session: "ordered",
    sessionStart: true,
    timeoutMs: 5000,
    argv: [
      process.execPath,
      "-e",
      "const f=require('node:fs');f.writeFileSync('session-held','ready');const t=setInterval(()=>{if(f.existsSync('release'))clearInterval(t)},10)",
    ],
  });
  const deadline = Date.now() + 5000;
  while (!existsSync(join(value.root, "session-held"))) {
    if (Date.now() > deadline) throw new Error("Held session did not launch");
    await new Promise((done) => setTimeout(done, 10));
  }
  let admitted = false;
  const intake = control(value, "POST", "/v1/exec", {
    requestId: queued,
    session: "ordered",
    argv: [
      process.execPath,
      "-e",
      "require('node:fs').writeFileSync('queued-effect','unexpected')",
    ],
  }).then((result) => {
    admitted = true;
    return result;
  });
  try {
    const execution = join(
      value.stateRoot,
      "engine",
      `moira-op-${workspaceRequestUuid(queued).replaceAll("-", "")}`,
      "execution.json",
    );
    while (!existsSync(execution)) {
      if (Date.now() > deadline)
        throw new Error("Queued session owner did not reach its durable boundary");
      await new Promise((done) => setTimeout(done, 10));
    }
    await control(value, "POST", "/v1/exec", { requestId: other, argv: ["true"] });
    expect((await settle(value, other)).state).toBe("succeeded");
    // The independent completion gives the real HTTP owner observable progress;
    // the occupied session must not keep its admission response behind the lock.
    expect(admitted).toBe(true);
    expect((await intake).state).toBe("starting");
    expect(await control(value, "POST", `/v1/operations/${queued}/cancel`)).toMatchObject({
      state: "not_started",
    });
  } finally {
    writeFileSync(join(value.root, "release"), "release");
    await settle(value, first);
    await intake;
  }
  expect((await settle(value, queued)).state).toBe("not_started");
  expect(existsSync(join(value.root, "queued-effect"))).toBe(false);
});

test("cancellation after a lost collector preserves uncertainty and real output even when its group owner exits", async () => {
  const value = fixture();
  await start(value);
  const requestId = createWorkspaceRequestId();
  await control(value, "POST", "/v1/exec", {
    requestId,
    timeoutMs: 5000,
    argv: [process.execPath, "-e", "process.stdout.write('retained');setInterval(()=>{},1000)"],
  });
  const directory = join(
    value.stateRoot,
    "engine",
    `moira-op-${workspaceRequestUuid(requestId).replaceAll("-", "")}`,
  );
  const deadline = Date.now() + 5000;
  while (
    !existsSync(join(directory, "pid")) ||
    !existsSync(join(directory, "stdout.log")) ||
    readFileSync(join(directory, "stdout.log")).length !== 8
  ) {
    if (Date.now() > deadline) throw new Error("Runner did not publish real process and output");
    await new Promise((done) => setTimeout(done, 10));
  }
  const runner = JSON.parse(readFileSync(join(directory, "runner-pid"), "utf8")).pid;
  const command = JSON.parse(readFileSync(join(directory, "pid"), "utf8")).pid;
  process.kill(-runner, "SIGKILL");
  while (true) {
    try {
      process.kill(runner, 0);
    } catch {
      break;
    }
    if (Date.now() > deadline) throw new Error("Owned runner did not exit");
    await new Promise((done) => setTimeout(done, 10));
  }
  expect(await control(value, "POST", `/v1/operations/${requestId}/cancel`)).toMatchObject({
    state: "unknown",
  });
  expect(() => process.kill(command, 0)).toThrow();
  expect((await call(value, "GET", `/v1/operations/${requestId}/output`)).bytes.toString()).toBe(
    "retained",
  );
});

test("lost cancellation owners cannot fabricate completion while a resistant child still produces effects", async () => {
  const value = fixture();
  await start(value);
  const requestId = createWorkspaceRequestId();
  let actualChild;
  let watcher;
  try {
    await control(value, "POST", "/v1/exec", {
      requestId,
      argv: [
        process.execPath,
        "-e",
        "const f=require('node:fs');process.on('SIGTERM',()=>{});let wrote=false;f.watch('.',()=>{if(!wrote&&f.existsSync('show-life')){wrote=true;f.writeFileSync('after-cancel-effect','still running')}});f.writeFileSync('actual-child',String(process.pid));setInterval(()=>{},1000)",
      ],
    });
    const directory = join(
      value.stateRoot,
      "engine",
      `moira-op-${workspaceRequestUuid(requestId).replaceAll("-", "")}`,
    );
    const deadline = Date.now() + 5000;
    while (
      !existsSync(join(value.root, "actual-child")) ||
      !existsSync(join(directory, "pid")) ||
      !existsSync(join(directory, "runner-pid"))
    ) {
      if (Date.now() > deadline)
        throw new Error("Owned command and collectors did not become ready");
      await new Promise((done) => setTimeout(done, 10));
    }
    actualChild = Number(readFileSync(join(value.root, "actual-child"), "utf8"));
    const owner = JSON.parse(readFileSync(join(directory, "pid"), "utf8")).pid;
    const collector = JSON.parse(readFileSync(join(directory, "runner-pid"), "utf8")).pid;
    let observed = false;
    watcher = watch(directory, () => {
      if (observed || !existsSync(join(directory, "cancel-requested"))) return;
      observed = true;
      // Kill only the fixture's two owners. Its separately spawned command is
      // resistant to SIGTERM and remains available to demonstrate a real effect.
      for (const pid of [owner, collector]) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // Another owned exit can race with this explicit fixture loss.
        }
      }
    });
    const reply = await control(value, "POST", `/v1/operations/${requestId}/cancel`);
    expect(observed).toBe(true);
    const effect = await new Promise((done, reject) => {
      const observer = watch(value.root, () => {
        if (!existsSync(join(value.root, "after-cancel-effect"))) return;
        clearTimeout(timer);
        observer.close();
        done(readFileSync(join(value.root, "after-cancel-effect"), "utf8"));
      });
      const timer = setTimeout(() => {
        observer.close();
        reject(new Error("Resistant command did not demonstrate its surviving effect"));
      }, 5000);
      writeFileSync(join(value.root, "show-life"), "observe");
    });
    expect(effect).toBe("still running");
    expect(reply).toMatchObject({ requestId, state: "unknown" });
    expect(await control(value, "GET", `/v1/operations/${requestId}`)).toMatchObject({
      requestId,
      state: "unknown",
    });
    expect(existsSync(join(directory, "result.json"))).toBe(false);
    expect(existsSync(join(value.stateRoot, "requests", requestId, "result.json"))).toBe(false);
  } finally {
    watcher?.close();
    if (actualChild) {
      try {
        process.kill(actualChild, "SIGKILL");
      } catch {
        // The owned fixture command may already have exited after a failed assertion.
      }
    }
  }
});

test.each(["acknowledged", "missing-start-ack"])(
  "a lost group owner with %s launch retains uncertainty while its actual child survives",
  async (phase) => {
    const value = fixture();
    if (phase === "missing-start-ack") {
      const hook = join(value.directory, "drop-start-ack.cjs");
      writeFileSync(
        hook,
        `if(process.send){const original=process.send.bind(process);process.send=(message,...args)=>{if(Number.isSafeInteger(message?.startedAt)){require('node:fs').writeFileSync(${JSON.stringify(join(value.directory, "unacknowledged-owner"))},String(process.pid));return true}return original(message,...args)}}`,
      );
      value.environment = { NODE_OPTIONS: `--require=${hook}` };
    }
    await start(value);
    const requestId = createWorkspaceRequestId();
    let actualChild;
    try {
      await control(
        value,
        "PUT",
        `/v1/operations/${requestId}/input`,
        Buffer.from("unknown retained input"),
      );
      await control(value, "POST", "/v1/exec", {
        requestId,
        inputReady: true,
        argv: [
          process.execPath,
          "-e",
          "const f=require('node:fs');f.watch('.',()=>{if(f.existsSync('show-survival')&&!f.existsSync('owner-loss-effect'))f.writeFileSync('owner-loss-effect','command survived owner loss')});f.writeFileSync('owner-loss-child',String(process.pid));setInterval(()=>{},1000)",
        ],
      });
      const directory = join(
        value.stateRoot,
        "engine",
        `moira-op-${workspaceRequestUuid(requestId).replaceAll("-", "")}`,
      );
      const ownerPath =
        phase === "acknowledged"
          ? join(directory, "pid")
          : join(value.directory, "unacknowledged-owner");
      const deadline = Date.now() + 5000;
      while (
        !existsSync(join(value.root, "owner-loss-child")) ||
        !existsSync(ownerPath) ||
        !existsSync(join(directory, "runner-pid"))
      ) {
        if (Date.now() > deadline)
          throw new Error(
            "Real owner and actual command did not reach the selected acknowledgement boundary",
          );
        await new Promise((done) => setTimeout(done, 10));
      }
      actualChild = Number(readFileSync(join(value.root, "owner-loss-child"), "utf8"));
      const owner =
        phase === "acknowledged"
          ? JSON.parse(readFileSync(ownerPath, "utf8")).pid
          : Number(readFileSync(ownerPath, "utf8"));
      const collector = JSON.parse(readFileSync(join(directory, "runner-pid"), "utf8")).pid;
      expect(() => process.kill(collector, 0)).not.toThrow();
      process.kill(owner, "SIGKILL");
      const result = await settle(value, requestId);
      const effect = await new Promise((done, reject) => {
        const observer = watch(value.root, () => {
          if (!existsSync(join(value.root, "owner-loss-effect"))) return;
          clearTimeout(timer);
          observer.close();
          done(readFileSync(join(value.root, "owner-loss-effect"), "utf8"));
        });
        const timer = setTimeout(() => {
          observer.close();
          reject(
            new Error("Actual command did not demonstrate survival after losing only its owner"),
          );
        }, 5000);
        writeFileSync(join(value.root, "show-survival"), "observe");
      });
      expect(effect).toBe("command survived owner loss");
      expect(result).toMatchObject({ requestId, state: "unknown" });
      expect(await control(value, "GET", `/v1/operations/${requestId}`)).toMatchObject({
        requestId,
        state: "unknown",
      });
      const retained = JSON.parse(readFileSync(join(directory, "result.json"), "utf8"));
      expect(retained).toMatchObject({ state: "outcome_unknown", exitCode: null });
      expect(retained.reason).not.toBe("COMMAND_START_REJECTED");
      expect(readFileSync(join(value.stateRoot, "requests", requestId, "input"), "utf8")).toBe(
        "unknown retained input",
      );
      expect(existsSync(join(value.stateRoot, "active-requests", `${requestId}.json`))).toBe(true);
      const execution = JSON.parse(readFileSync(join(directory, "execution.json"), "utf8"));
      expect(execution.launchAttempted).toBe(true);
      if (phase === "missing-start-ack") expect(execution.startedAt).toBeUndefined();
      else expect(execution.startedAt).toEqual(expect.any(Number));
    } finally {
      if (actualChild) {
        try {
          process.kill(actualChild, "SIGKILL");
        } catch {
          // The fixture command may already have exited after a failed assertion.
        }
      }
    }
  },
);

test("cancellation never signals a foreign group substituted for the retained command PID", async () => {
  const value = fixture();
  await start(value);
  const foreign = spawn(
    process.execPath,
    [
      "-e",
      "const f=require('node:fs');process.on('SIGTERM',()=>f.writeFileSync('foreign-signal','yes'));f.writeFileSync('foreign-ready','yes');setInterval(()=>{},1000)",
    ],
    { cwd: value.root, detached: true, stdio: "ignore" },
  );
  const requestId = createWorkspaceRequestId();
  let original;
  const directory = join(
    value.stateRoot,
    "engine",
    `moira-op-${workspaceRequestUuid(requestId).replaceAll("-", "")}`,
  );
  try {
    await control(value, "POST", "/v1/exec", {
      requestId,
      argv: [
        process.execPath,
        "-e",
        "require('node:fs').writeFileSync('owned-ready','yes');setInterval(()=>{},1000)",
      ],
    });
    const deadline = Date.now() + 5000;
    while (
      !existsSync(join(value.root, "foreign-ready")) ||
      !existsSync(join(value.root, "owned-ready")) ||
      !existsSync(join(directory, "pid"))
    ) {
      if (Date.now() > deadline) throw new Error("Real groups did not become ready");
      await new Promise((done) => setTimeout(done, 10));
    }
    original = JSON.parse(readFileSync(join(directory, "pid"), "utf8"));
    const startTime =
      process.platform === "linux"
        ? readFileSync(`/proc/${foreign.pid}/stat`, "utf8").split(") ")[1].split(" ")[19]
        : null;
    writeFileSync(join(directory, "pid"), JSON.stringify({ pid: foreign.pid, startTime }), {
      mode: 0o600,
    });
    await control(value, "POST", `/v1/operations/${requestId}/cancel`);
    expect(existsSync(join(value.root, "foreign-signal"))).toBe(false);
    expect(() => process.kill(foreign.pid, 0)).not.toThrow();
    expect((await settle(value, requestId)).state).toBe("cancelled");
  } finally {
    try {
      process.kill(-foreign.pid, "SIGKILL");
    } catch {
      // The fixture's foreign group may already have exited in a failing regression.
    }
    if (original)
      try {
        process.kill(-original.pid, "SIGKILL");
      } catch {
        // The owned command normally exited through cancellation.
      }
  }
});

test("a proved command exit cannot confirm group cancellation when a resistant descendant survives owner loss", async () => {
  const value = fixture();
  const closedOwner = join(value.directory, "command-close-owner");
  const hook = join(value.directory, "observe-command-close.cjs");
  writeFileSync(
    hook,
    `if(process.send){const original=process.send.bind(process);process.send=(message,callback)=>{if(Object.hasOwn(message,'exitCode'))return original(message,error=>{require('node:fs').writeFileSync(${JSON.stringify(closedOwner)},String(process.pid));callback?.(error)});return original(message,callback)}}`,
  );
  value.environment = { NODE_OPTIONS: `--require=${hook}` };
  await start(value);
  const requestId = createWorkspaceRequestId();
  let descendant;
  let watcher;
  try {
    await control(value, "POST", "/v1/exec", {
      requestId,
      argv: [
        process.execPath,
        "-e",
        "const {spawn}=require('node:child_process');const f=require('node:fs');spawn(process.execPath,['-e',\"const f=require('node:fs');process.on('SIGTERM',()=>{});f.watch('.',()=>{if(f.existsSync('show-descendant')&&!f.existsSync('descendant-effect'))f.writeFileSync('descendant-effect','descendant survived cancellation')});f.writeFileSync('resistant-descendant',String(process.pid));setInterval(()=>{},1000)\"],{stdio:'ignore'});f.writeFileSync('cancellable-leader','ready');setInterval(()=>{},1000)",
      ],
    });
    const deadline = Date.now() + 5000;
    while (
      !existsSync(join(value.root, "resistant-descendant")) ||
      !existsSync(join(value.root, "cancellable-leader"))
    ) {
      if (Date.now() > deadline)
        throw new Error("Real command and resistant descendant did not become ready");
      await new Promise((done) => setTimeout(done, 10));
    }
    descendant = Number(readFileSync(join(value.root, "resistant-descendant"), "utf8"));
    let observed = false;
    watcher = watch(value.directory, () => {
      if (observed || !existsSync(closedOwner)) return;
      observed = true;
      const owner = Number(readFileSync(closedOwner, "utf8"));
      try {
        process.kill(owner, "SIGKILL");
      } catch {
        // An already exited fixture owner cannot perform escalation.
      }
    });
    const reply = await control(value, "POST", `/v1/operations/${requestId}/cancel`);
    expect(observed).toBe(true);
    const effect = await new Promise((done, reject) => {
      const observer = watch(value.root, () => {
        if (!existsSync(join(value.root, "descendant-effect"))) return;
        clearTimeout(timer);
        observer.close();
        done(readFileSync(join(value.root, "descendant-effect"), "utf8"));
      });
      const timer = setTimeout(() => {
        observer.close();
        reject(new Error("Resistant descendant did not demonstrate its surviving effect"));
      }, 5000);
      writeFileSync(join(value.root, "show-descendant"), "observe");
    });
    expect(effect).toBe("descendant survived cancellation");
    expect(reply).toMatchObject({ requestId, state: "unknown" });
    expect(await control(value, "GET", `/v1/operations/${requestId}`)).toMatchObject({
      requestId,
      state: "unknown",
    });
  } finally {
    watcher?.close();
    if (descendant) {
      try {
        process.kill(descendant, "SIGKILL");
      } catch {
        // The fixture descendant may already have exited after a failed assertion.
      }
    }
  }
});

test("cancellation reaches owned descendants after the original command leader exits", async () => {
  const value = fixture();
  await start(value);
  const requestId = createWorkspaceRequestId();
  await control(value, "POST", "/v1/exec", {
    requestId,
    argv: [
      process.execPath,
      "-e",
      "const {spawn}=require('node:child_process');spawn(process.execPath,['-e',\"require('node:fs').writeFileSync('descendant-pid',String(process.pid));setInterval(()=>{},1000)\"],{stdio:['ignore',process.stdout,process.stderr]});process.exit(0)",
    ],
  });
  const deadline = Date.now() + 5000;
  while (!existsSync(join(value.root, "descendant-pid"))) {
    if (Date.now() > deadline) throw new Error("Owned descendant did not start");
    await new Promise((done) => setTimeout(done, 10));
  }
  const pid = Number(readFileSync(join(value.root, "descendant-pid"), "utf8"));
  try {
    expect((await control(value, "GET", `/v1/operations/${requestId}`)).state).toBe("running");
    await control(value, "POST", `/v1/operations/${requestId}/cancel`);
    expect((await settle(value, requestId)).state).toBe("cancelled");
    expect(() => process.kill(pid, 0)).toThrow();
  } finally {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Successful cancellation already reaped the fixture descendant.
    }
  }
});

test("directory publication failure refuses admission before any command effect and permits later recovery", async () => {
  const value = fixture();
  const fault = join(value.directory, "sync-fault.cjs");
  const armed = join(value.directory, "armed");
  const observed = join(value.directory, "sync-observed");
  writeFileSync(
    fault,
    `const fs=require('node:fs');const promises=require('node:fs/promises');const original=promises.open;promises.open=async(...args)=>{const handle=await original(...args);const sync=handle.sync.bind(handle);handle.sync=async()=>{if(args[0]===${JSON.stringify(join(value.stateRoot, "requests"))}&&fs.existsSync(${JSON.stringify(armed)})){fs.writeFileSync(${JSON.stringify(observed)},'requests-parent');throw Object.assign(new Error('injected storage failure'),{code:'EIO'})}return sync()};return handle};require('node:module').syncBuiltinESMExports();`,
  );
  value.environment = { NODE_OPTIONS: `--require=${fault}` };
  await start(value);
  writeFileSync(armed, "armed");
  const requestId = createWorkspaceRequestId();
  const body = {
    requestId,
    argv: [process.execPath, "-e", "require('node:fs').writeFileSync('durable-effect','once')"],
  };
  const refused = await call(value, "POST", "/v1/exec", body);
  expect(refused.status).not.toBe(200);
  expect(readFileSync(observed, "utf8")).toBe("requests-parent");
  expect(existsSync(join(value.stateRoot, "requests", requestId, "accepted.json"))).toBe(false);
  expect(existsSync(join(value.root, "durable-effect"))).toBe(false);
  unlinkSync(armed);
  await control(value, "POST", "/v1/exec", body);
  expect((await settle(value, requestId)).state).toBe("succeeded");
  expect(readFileSync(join(value.root, "durable-effect"), "utf8")).toBe("once");
});

test.each(["patch", "command-refusal"])(
  "failed result publication after accepted %s remains uncertain and replay cannot repeat effects",
  async (kind) => {
    const value = fixture();
    const requestId = createWorkspaceRequestId();
    const directory = join(value.stateRoot, "requests", requestId);
    const armed = join(value.directory, "result-fault-armed");
    const observed = join(value.directory, "result-fault-observed");
    const fault = join(value.directory, "result-fault.cjs");
    writeFileSync(
      fault,
      `const fs=require('node:fs');const path=require('node:path');const promises=require('node:fs/promises');const original=promises.rename;promises.rename=async(from,to)=>{if(path.basename(String(to))==='result.json'&&fs.existsSync(${JSON.stringify(armed)})&&fs.realpathSync(path.dirname(String(to)))===${JSON.stringify(directory)}){fs.writeFileSync(${JSON.stringify(observed)},'result-publication');throw Object.assign(new Error('injected result storage failure'),{code:'EIO'})}return original(from,to)};require('node:module').syncBuiltinESMExports();`,
    );
    value.environment = { NODE_OPTIONS: `--require=${fault}` };
    writeFileSync(join(value.root, "target"), "original");
    await start(value);
    const body =
      kind === "patch"
        ? {
            requestId,
            files: [
              {
                path: "target",
                expected: { exists: true },
                edits: [{ start: 0, end: 8, text: "changed" }],
              },
            ],
          }
        : { requestId, argv: [] };
    const route = kind === "patch" ? "/v1/files/patch" : "/v1/exec";
    writeFileSync(armed, "armed");
    const response = await call(value, "POST", route, body);
    expect(response.status).toBe(503);
    expect(JSON.parse(response.bytes.toString())).toEqual({
      error: { code: "WORKSPACE_OUTCOME_UNCONFIRMED" },
    });
    expect(readFileSync(observed, "utf8")).toBe("result-publication");
    expect(existsSync(join(directory, "accepted.json"))).toBe(true);
    expect(existsSync(join(directory, "result.json"))).toBe(false);
    const target = join(value.root, "target");
    expect(readFileSync(target, "utf8")).toBe(kind === "patch" ? "changed" : "original");
    const published = statSync(target);
    unlinkSync(armed);
    expect(await control(value, "POST", route, body)).toMatchObject({
      requestId,
      state: "unknown",
    });
    expect(await control(value, "GET", `/v1/operations/${requestId}`)).toMatchObject({
      requestId,
      state: "unknown",
    });
    expect(statSync(target).ino).toBe(published.ino);
    expect(readFileSync(target, "utf8")).toBe(kind === "patch" ? "changed" : "original");
    const conflict = await call(value, "POST", route, {
      ...body,
      ...(kind === "patch" ? { files: [] } : { argv: ["true"] }),
    });
    expect(conflict.status).toBe(409);
    expect(JSON.parse(conflict.bytes.toString()).error.code).toBe("REQUEST_ID_CONFLICT");
  },
);

test("retained output fsync failure is observable before a durable terminal success", async () => {
  const value = fixture();
  const requestId = createWorkspaceRequestId();
  const output = join(
    value.stateRoot,
    "engine",
    `moira-op-${workspaceRequestUuid(requestId).replaceAll("-", "")}`,
    "stdout.log",
  );
  const observed = join(value.directory, "output-sync-observed");
  const fault = join(value.directory, "output-fault.cjs");
  writeFileSync(
    fault,
    `const fs=require('node:fs');const original=fs.fsync;fs.fsync=(fd,callback)=>{const actual=fs.fstatSync(fd);let expected;try{expected=fs.statSync(${JSON.stringify(output)})}catch{}if(expected&&actual.dev===expected.dev&&actual.ino===expected.ino){fs.writeFileSync(${JSON.stringify(observed)},'owned-output');callback(Object.assign(new Error('injected storage failure'),{code:'EIO'}));return}original(fd,callback)};`,
  );
  value.environment = { NODE_OPTIONS: `--require=${fault}` };
  await start(value);
  await control(value, "POST", "/v1/exec", {
    requestId,
    argv: [process.execPath, "-e", "process.stdout.write('retained')"],
  });
  expect(await settle(value, requestId)).toMatchObject({
    state: "failed",
    reason: "OUTPUT_STORAGE_FAILED",
  });
  expect(readFileSync(observed, "utf8")).toBe("owned-output");
  expect(readFileSync(output, "utf8")).toBe("retained");
});
