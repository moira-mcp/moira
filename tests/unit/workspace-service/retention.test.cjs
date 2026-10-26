const { afterEach, beforeAll, expect, test } = require("@jest/globals");
const {
  readFileSync,
  writeFileSync,
  existsSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  mkdirSync,
} = require("node:fs");
const { join } = require("node:path");
const {
  createFixture,
  start,
  stop,
  call,
  dispose,
} = require("../../fixtures/workspace-service.cjs");
let requestId, requestUuid;
beforeAll(async () => {
  ({ createWorkspaceRequestId: requestId, workspaceRequestUuid: requestUuid } =
    await import("../../../packages/shared/src/codespaces/workspace-request-id.ts"));
});
const fixtures = [];
function fixture() {
  const value = createFixture();
  fixtures.push(value);
  return value;
}
afterEach(async () => {
  for (const value of fixtures.splice(0)) await dispose(value);
});

test("durable JSON uses the held directory capability without closing it or writing a substituted named directory", async () => {
  const value = fixture();
  const { openDirectory, writeDurableJson } =
    await import("../../../packages/workspace-service/src/file-primitives.mjs");
  const named = join(value.directory, "publication-directory");
  const original = join(value.directory, "held-publication-directory");
  mkdirSync(named, { mode: 0o700 });
  const held = await openDirectory(named);
  try {
    await writeDurableJson(held, "before.json", { original: true });
    expect((await held.stat()).isDirectory()).toBe(true);
    const retained = readFileSync(join(named, "before.json"));
    renameSync(named, original);
    mkdirSync(named, { mode: 0o700 });
    if (process.platform === "linux") {
      await writeDurableJson(held, "after.json", { original: true });
      expect(JSON.parse(readFileSync(join(original, "after.json"), "utf8"))).toEqual({
        original: true,
      });
    } else {
      await expect(writeDurableJson(held, "after.json", { original: true })).rejects.toMatchObject({
        fileReason: "concurrent_change",
      });
      expect(existsSync(join(original, "after.json"))).toBe(false);
    }
    expect(readdirSync(named)).toEqual([]);
    expect(readFileSync(join(original, "before.json"))).toEqual(retained);
    expect((await held.stat()).isDirectory()).toBe(true);
  } finally {
    await held.close();
  }
});
async function json(value, method, path, body) {
  const response = await call(value, method, path, body, { "content-type": "application/json" });
  expect(response.status).toBe(200);
  return JSON.parse(response.bytes.toString());
}
async function until(check) {
  const deadline = Date.now() + 5000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("Owned retention boundary did not settle");
    await new Promise((done) => setTimeout(done, 10));
  }
}
function paths(value, id) {
  return {
    directory: join(value.stateRoot, "requests", id),
    member: join(value.stateRoot, "active-requests", `${id}.json`),
    engine: join(value.stateRoot, "engine", `moira-op-${requestUuid(id).replaceAll("-", "")}`),
  };
}
async function heldInput(value, id, bytes) {
  await json(value, "PUT", `/v1/operations/${id}/input`, bytes);
  const body = {
    requestId: id,
    inputReady: true,
    argv: [
      process.execPath,
      "-e",
      "const f=require('node:fs');f.appendFileSync('effects','once\\n');const t=setInterval(()=>{if(f.existsSync('release')){clearInterval(t);process.stdin.pipe(process.stdout)}},10)",
    ],
  };
  await json(value, "POST", "/v1/exec", body);
  await until(() => existsSync(join(value.root, "effects")));
  return body;
}

test("the physical collector retires terminal stdin after its observer exits, preserving original receipts and complete output", async () => {
  const value = fixture();
  const pinObserved = join(value.directory, "retirement-pin.json");
  const hook = join(value.directory, "observe-retirement-pin.cjs");
  writeFileSync(
    hook,
    `const fs=require('node:fs'),p=require('node:fs/promises'),path=require('node:path');const remove=p.rm;p.rm=async(name,...rest)=>{if(path.basename(String(name))==='input'){let pin;try{const s=fs.fstatSync(6);pin={open:true,dev:s.dev,ino:s.ino,nlink:s.nlink}}catch{pin={open:false}}fs.writeFileSync(${JSON.stringify(pinObserved)},JSON.stringify(pin))}return remove(name,...rest)};require('node:module').syncBuiltinESMExports();`,
  );
  value.environment = { NODE_OPTIONS: `--require=${hook}` };
  await start(value);
  const id = requestId(),
    bytes = Buffer.alloc(4 * 1024 * 1024 + 13, 0xd5);
  const body = await heldInput(value, id, bytes),
    p = paths(value, id);
  const compact = ["accepted.json", "input.json", "input-identity.json"];
  const before = compact.map((name) => readFileSync(join(p.directory, name)));
  expect(existsSync(p.member)).toBe(true);
  const originalInput = statSync(join(p.directory, "input"));
  expect(readFileSync(join(p.directory, "input"))).toEqual(bytes);
  await stop(value);
  writeFileSync(join(value.root, "release"), "release");
  // No collection/owner process is available to perform this cleanup.
  await until(() => !existsSync(p.member));
  expect(existsSync(join(p.directory, "input"))).toBe(false);
  expect(JSON.parse(readFileSync(pinObserved, "utf8"))).toEqual({
    open: true,
    dev: originalInput.dev,
    ino: originalInput.ino,
    nlink: 1,
  });
  expect(readFileSync(join(p.engine, "stdout.log"))).toEqual(bytes);
  expect(compact.map((name) => readFileSync(join(p.directory, name)))).toEqual(before);
  const resultBytes = readFileSync(join(p.engine, "result.json"));
  await start(value);
  expect(await json(value, "POST", "/v1/exec", body)).toMatchObject({
    state: "succeeded",
    stdoutBytes: bytes.length,
  });
  const changed = await call(value, "POST", "/v1/exec", { ...body, argv: ["false"] });
  expect(changed.status).toBe(409);
  expect(readFileSync(join(value.root, "effects"), "utf8")).toBe("once\n");
  expect(readFileSync(join(p.engine, "result.json"))).toEqual(resultBytes);
  expect((await call(value, "GET", `/v1/operations/${id}/output`)).bytes).toEqual(bytes);
});

test.each(["legacy-identity", "same-content-replacement", "invalid-metadata", "unlink-failure"])(
  "terminal cleanup preserves %s input and unresolved membership through reopen",
  async (mode) => {
    const value = fixture();
    const id = requestId(),
      bytes = Buffer.alloc(256 * 1024 + 7, 0xb1);
    if (mode === "unlink-failure") {
      const hook = join(value.directory, "refuse-input-removal.cjs");
      writeFileSync(
        hook,
        `const p=require('node:fs/promises'),path=require('node:path');const remove=p.rm;p.rm=async(name,...rest)=>{if(path.basename(String(name))==='input')throw Object.assign(new Error('input removal failure'),{code:'EIO'});return remove(name,...rest)};require('node:module').syncBuiltinESMExports();`,
      );
      value.environment = { NODE_OPTIONS: `--require=${hook}` };
    }
    await start(value);
    await heldInput(value, id, bytes);
    const p = paths(value, id),
      input = join(p.directory, "input");
    if (mode === "legacy-identity") {
      const info = statSync(input);
      writeFileSync(
        join(p.directory, "input-identity.json"),
        JSON.stringify({ dev: info.dev, ino: info.ino }),
        { mode: 0o600 },
      );
    } else if (mode === "invalid-metadata") {
      const metadataPath = join(p.directory, "input.json");
      const metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
      writeFileSync(metadataPath, JSON.stringify({ ...metadata, size: -1 }), { mode: 0o600 });
    } else if (mode === "same-content-replacement") {
      renameSync(input, join(value.directory, "retained-input"));
      writeFileSync(input, bytes, { mode: 0o600 });
    }
    const identity = statSync(input),
      original = readFileSync(input);
    writeFileSync(join(value.root, "release"), "release");
    expect(await json(value, "GET", `/v1/operations/${id}?waitMs=5000`)).toMatchObject({
      state: "succeeded",
    });
    expect(readFileSync(input)).toEqual(original);
    expect(existsSync(p.member)).toBe(true);
    await stop(value);
    value.environment = {};
    await start(value);
    expect(await json(value, "GET", `/v1/operations/${id}`)).toMatchObject({ state: "succeeded" });
    expect(existsSync(input) ? readFileSync(input) : null).toEqual(
      mode === "unlink-failure" ? null : original,
    );
    expect(existsSync(input) ? statSync(input).ino : null).toBe(
      mode === "unlink-failure" ? null : identity.ino,
    );
    expect(existsSync(p.member)).toBe(mode !== "unlink-failure");
  },
);

test("routine recovery reads active originals without enumerating or opening terminal history", async () => {
  const value = fixture();
  await start(value);
  const terminal = [];
  for (let index = 0; index < 4; index++) {
    const id = requestId();
    terminal.push(id);
    const response = await call(
      value,
      "PUT",
      `/v1/files/write?path=history-${index}&requestId=${id}`,
      Buffer.from("retained"),
      { "x-moira-expected": '{"exists":false}' },
    );
    expect(response.status).toBe(200);
    expect(existsSync(paths(value, id).member)).toBe(false);
  }
  const legacy = requestId();
  await json(value, "POST", "/v1/exec", { requestId: legacy, argv: ["true"] });
  expect(await json(value, "GET", `/v1/operations/${legacy}?waitMs=5000`)).toMatchObject({
    state: "succeeded",
  });
  const active = requestId();
  await heldInput(value, active, Buffer.from("live input"));
  const retained = terminal.map((id) =>
    readFileSync(join(paths(value, id).directory, "accepted.json")),
  );
  await stop(value);
  const legacyResultPath = join(paths(value, legacy).engine, "result.json");
  const legacyResult = JSON.parse(readFileSync(legacyResultPath, "utf8"));
  delete legacyResult.inputSettled;
  writeFileSync(legacyResultPath, JSON.stringify(legacyResult), { mode: 0o600 });
  const legacyBytes = readFileSync(legacyResultPath);
  unlinkSync(join(value.stateRoot, "active-requests.json"));
  await start(value);
  expect(existsSync(paths(value, legacy).member)).toBe(false);
  expect(readFileSync(legacyResultPath)).toEqual(legacyBytes);
  await stop(value);
  const hook = join(value.directory, "refuse-terminal-inventory.cjs");
  writeFileSync(
    hook,
    `const fs=require('node:fs'),p=require('node:fs/promises');const forbidden=${JSON.stringify(terminal.concat(legacy).map((id) => paths(value, id).directory))};const open=p.open,read=p.readdir;p.readdir=async(path,...rest)=>{if(String(path)===${JSON.stringify(join(value.stateRoot, "requests"))})throw new Error('terminal inventory');return read(path,...rest)};p.open=async(path,...rest)=>{let name;try{name=fs.realpathSync(path)}catch{}if(name&&forbidden.some(root=>name.startsWith(root+'/')))throw new Error('terminal read');return open(path,...rest)};require('node:module').syncBuiltinESMExports();`,
  );
  value.environment = { NODE_OPTIONS: `--require=${hook}` };
  await start(value);
  expect(await json(value, "GET", `/v1/operations/${active}`)).toMatchObject({ state: "running" });
  expect(
    terminal.map((id) => readFileSync(join(paths(value, id).directory, "accepted.json"))),
  ).toEqual(retained);
  writeFileSync(join(value.root, "release"), "release");
  expect(await json(value, "GET", `/v1/operations/${active}?waitMs=5000`)).toMatchObject({
    state: "succeeded",
  });
  expect(readdirSync(join(value.stateRoot, "active-requests"))).toEqual([]);
});

test("failed admission publication preserves its orphan membership and refuses live inspection, replay and startup", async () => {
  const value = fixture();
  const id = requestId(),
    p = paths(value, id);
  const hook = join(value.directory, "refuse-admission-publication.cjs");
  writeFileSync(
    hook,
    `const fs=require('node:fs'),p=require('node:fs/promises'),path=require('node:path');const rename=p.rename;p.rename=async(from,to)=>{if(path.basename(String(to))==='accepted.json'&&fs.realpathSync(path.dirname(String(to)))===${JSON.stringify(p.directory)})throw Object.assign(new Error('admission storage failure'),{code:'EIO'});return rename(from,to)};require('node:module').syncBuiltinESMExports();`,
  );
  value.environment = { NODE_OPTIONS: `--require=${hook}` };
  await start(value);
  const body = {
    requestId: id,
    argv: [process.execPath, "-e", "require('node:fs').writeFileSync('effects','unexpected')"],
  };
  const admission = await call(value, "POST", "/v1/exec", body);
  expect(admission.status).toBe(503);
  expect(JSON.parse(admission.bytes.toString())).toMatchObject({
    error: { code: "WORKSPACE_OUTCOME_UNCONFIRMED" },
  });
  const member = readFileSync(p.member);
  for (const [method, path, input] of [
    ["GET", `/v1/operations/${id}`, undefined],
    ["POST", "/v1/exec", body],
  ]) {
    const refused = await call(value, method, path, input);
    expect(refused.status).toBe(409);
    expect(JSON.parse(refused.bytes.toString())).toMatchObject({ error: { code: "UNSAFE_STATE" } });
  }
  await stop(value);
  const { createWorkspaceOwner } =
    await import("../../../packages/workspace-service/src/owner.mjs");
  for (let attempt = 0; attempt < 2; attempt++)
    await expect(
      createWorkspaceOwner({
        stateRoot: value.stateRoot,
        binding: value.binding,
        searchExecutable: value.searchExecutable,
      }),
    ).rejects.toMatchObject({ publicCode: "UNSAFE_STATE" });
  expect(readFileSync(p.member)).toEqual(member);
  expect(existsSync(join(p.directory, "accepted.json"))).toBe(false);
  expect(existsSync(join(value.root, "effects"))).toBe(false);
});

test("a missing initialized index refuses startup without recreating an empty recovery inventory", async () => {
  const value = fixture();
  await start(value);
  await stop(value);
  const root = join(value.stateRoot, "active-requests");
  renameSync(root, join(value.directory, "preserved-index"));
  const { createWorkspaceOwner } =
    await import("../../../packages/workspace-service/src/owner.mjs");
  for (let attempt = 0; attempt < 2; attempt++) {
    await expect(
      createWorkspaceOwner({
        stateRoot: value.stateRoot,
        binding: value.binding,
        searchExecutable: value.searchExecutable,
      }),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(existsSync(root)).toBe(false);
  }
});

test("a present corrupt membership refuses collection and preserves live input and admission", async () => {
  const value = fixture(),
    id = requestId(),
    bytes = Buffer.from("retained live input");
  await start(value);
  await heldInput(value, id, bytes);
  const p = paths(value, id),
    accepted = readFileSync(join(p.directory, "accepted.json")),
    runner = JSON.parse(readFileSync(join(p.engine, "runner-pid"), "utf8")).pid;
  try {
    writeFileSync(p.member, "corrupt", { mode: 0o600 });
    const response = await call(value, "GET", `/v1/operations/${id}`);
    expect(response.status).toBe(409);
    expect(JSON.parse(response.bytes.toString())).toMatchObject({
      error: { code: "UNSAFE_STATE" },
    });
    expect(readFileSync(p.member, "utf8")).toBe("corrupt");
    expect(readFileSync(join(p.directory, "accepted.json"))).toEqual(accepted);
    expect(readFileSync(join(p.directory, "input"))).toEqual(bytes);
  } finally {
    writeFileSync(join(value.root, "release"), "release");
    // Service shutdown leaves accepted commands alive. The detached observer still
    // publishes its receipt after the command exits, so fixture removal must await it.
    await until(() => {
      try {
        process.kill(runner, 0);
        return false;
      } catch (error) {
        if (error.code === "ESRCH") return true;
        throw error;
      }
    });
  }
});

test("collection tolerates the same terminal membership disappearing during its guarded read", async () => {
  const value = fixture(),
    id = requestId(),
    p = paths(value, id);
  const held = join(value.directory, "terminal-removal-held"),
    released = join(value.directory, "terminal-removal-release");
  const hook = join(value.directory, "terminal-removal-race.cjs");
  writeFileSync(
    hook,
    `const fs=require('node:fs'),p=require('node:fs/promises'),path=require('node:path');const remove=p.rm,inspect=p.lstat;const owner=process.execArgv.includes('--input-type=module');const selected=name=>path.basename(String(name))===${JSON.stringify(id + ".json")};p.rm=async(name,...rest)=>{if(!owner&&selected(name)){fs.writeFileSync(${JSON.stringify(held)},'terminal');while(!fs.existsSync(${JSON.stringify(released)}))await new Promise(r=>setTimeout(r,1))}return remove(name,...rest)};p.lstat=async(name,...rest)=>{if(owner&&selected(name)&&fs.existsSync(${JSON.stringify(held)})&&!fs.existsSync(${JSON.stringify(released)})){const result=JSON.parse(fs.readFileSync(${JSON.stringify(join(p.engine, "result.json"))}));const accepted=JSON.parse(fs.readFileSync(${JSON.stringify(join(p.directory, "accepted.json"))}));if(result.state!=='succeeded'||result.requestDigest!==accepted.digest)throw new Error('missing terminal proof');await remove(name);fs.writeFileSync(${JSON.stringify(released)},'released')}return inspect(name,...rest)};require('node:module').syncBuiltinESMExports();`,
  );
  value.environment = { NODE_OPTIONS: `--require=${hook}` };
  try {
    await start(value);
    await json(value, "POST", "/v1/exec", {
      requestId: id,
      argv: [process.execPath, "-e", "require('node:fs').appendFileSync('effects','once')"],
    });
    try {
      await until(() => existsSync(held));
    } catch (error) {
      error.message += `\nOriginal runner evidence: ${JSON.stringify(
        readdirSync(p.engine)
          .filter((name) => name.endsWith(".json"))
          .map((name) => {
            try {
              const record = JSON.parse(readFileSync(join(p.engine, name), "utf8"));
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
    const accepted = readFileSync(join(p.directory, "accepted.json"));
    const response = await call(value, "GET", `/v1/operations/${id}`);
    expect({ status: response.status, body: JSON.parse(response.bytes.toString()) }).toMatchObject({
      status: 200,
      body: { state: "succeeded" },
    });
    expect(readFileSync(join(p.directory, "accepted.json"))).toEqual(accepted);
    expect(readFileSync(join(value.root, "effects"), "utf8")).toBe("once");
  } finally {
    writeFileSync(released, "released");
  }
});
