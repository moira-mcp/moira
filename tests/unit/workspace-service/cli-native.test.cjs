const { afterEach, expect, test } = require("@jest/globals");
const { spawnSync } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const { writeFileSync, readFileSync, existsSync, readdirSync, mkdirSync } = require("node:fs");
const { join, resolve } = require("node:path");
const { pathToFileURL } = require("node:url");
const sharp = require("sharp");
const { createFixture, start, call, dispose } = require("../../fixtures/workspace-service.cjs");
const fixtures = [];
afterEach(async () => {
  for (const value of fixtures.splice(0)) await dispose(value);
});
async function service(configure = () => {}) {
  const value = createFixture();
  fixtures.push(value);
  value.publicationScope = {
    resourceId: randomUUID(),
    resourceGeneration: 1,
    authorizationGeneration: 1,
    publicOrigin: "https://moira.example",
  };
  value.ownerSelector = { kind: "github", resourceId: value.publicationScope.resourceId };
  configure(value);
  await start(value);
  return value;
}
function cli(value, args, input) {
  return spawnSync(process.execPath, [resolve("packages/workspace-service/src/cli.mjs"), ...args], {
    env: { ...process.env, MOIRA_WORKSPACE_SOCKET: value.socketPath },
    input,
    encoding: "utf8",
  });
}
const payload = (reply) => JSON.parse(reply.stdout).structuredContent;
const descriptor = {
  file_id: "file_fixture",
  download_url: "https://127.0.0.1/source?sig=private-source-secret",
  size_bytes: 3,
};
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

test("ordinary CLI preserves script/session cwd, environment and explicit timeout through the common owner", async () => {
  const value = await service();
  mkdirSync(join(value.root, "nested"));
  const script = join(value.directory, "script");
  writeFileSync(script, 'printf "%s|%s" "$CLI_VALUE" "$PWD"; export CLI_VALUE="retained value"');
  const started = cli(value, [
    "exec",
    "--script",
    script,
    "--session",
    "cli-context",
    "--cwd",
    "nested",
    "--env",
    "CLI_VALUE=authored value",
    "--timeout",
    "10",
  ]);
  expect(started.status).toBe(0);
  expect(payload(started)).toMatchObject({
    state: "completed",
    stdout: "authored value|" + join(value.root, "nested"),
  });
  writeFileSync(script, 'printf "%s|%s" "$CLI_VALUE" "$PWD"');
  const continued = cli(value, [
    "exec",
    "--script",
    script,
    "--session",
    "cli-context",
    "--continue",
  ]);
  expect(continued.status).toBe(0);
  expect(payload(continued)).toMatchObject({
    state: "completed",
    stdout: "retained value|" + join(value.root, "nested"),
  });
  expect(payload(started).operation).not.toBe(payload(continued).operation);
});

test("CLI returned process/operation references collect and continue output without repeating the effect", async () => {
  const value = await service();
  const submitted = cli(value, [
    "exec",
    "--max-stdout",
    "4",
    "--",
    process.execPath,
    "-e",
    "require('node:fs').appendFileSync('effect','once\\n');process.stdout.write('Я🙂аб🙂z')",
  ]);
  expect(submitted.status).toBe(0);
  const first = payload(submitted);
  const collected = cli(value, ["get", first.operation]);
  expect(collected.status).toBe(0);
  expect(payload(collected).state).toBe("completed");
  expect(cli(value, ["get", first.operation]).stdout).toBe(collected.stdout);
  let text = first.stdout,
    cursor = first.stdout_cursor;
  while (cursor) {
    const result = cli(value, ["output", first.process, "--cursor", cursor, "--max-bytes", "4"]);
    expect(result.status).toBe(0);
    const next = payload(result);
    text += next.text;
    cursor = next.next_cursor;
  }
  expect(text).toBe("Я🙂аб🙂z");
  expect(readFileSync(join(value.root, "effect"), "utf8")).toBe("once\n");
});

test("CLI upload/raw stdin preserve opaque bytes and download derives original name/type", async () => {
  const value = await service();
  const bytes = Buffer.from([0, 255, 42, 13, 10, 128]);
  const uploaded = cli(value, ["upload", "owner.bin", "-"], bytes);
  expect(uploaded.status).toBe(0);
  expect(readFileSync(join(value.root, "owner.bin"))).toEqual(bytes);
  const run = cli(
    value,
    [
      "exec",
      "--stdin",
      "--",
      process.execPath,
      "-e",
      "process.stdin.pipe(require('node:fs').createWriteStream('stdin.bin'))",
    ],
    bytes,
  );
  expect(run.status).toBe(0);
  expect(readFileSync(join(value.root, "stdin.bin"))).toEqual(bytes);
  const published = cli(value, ["download", "owner.bin"]);
  expect(published.status).toBe(0);
  const result = JSON.parse(published.stdout);
  expect(result.content[0]).toMatchObject({
    type: "resource_link",
    name: "owner.bin",
    mimeType: "application/octet-stream",
    size: bytes.length,
  });
  const token = result.structuredContent.file.reference_id.split("/").at(-1);
  expect((await call(value, "GET", "/v1/publications/" + token)).bytes).toEqual(bytes);
});

test("CLI collects a controlled publication delivery through the unified original operation reference", async () => {
  const value = await service();
  const requestId = "ws1-" + randomUUID();
  const bytes = Buffer.from([0, 255, 42]);
  const original = JSON.parse(
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
            fileName: "owner.bin",
            mimeType: "application/octet-stream",
          },
        },
        { "content-type": "application/json" },
      )
    ).bytes,
  );
  const found = cli(value, ["find", "--kind", "delivery"]);
  expect(found.status).toBe(0);
  const reference = payload(found).operations[0].operation;
  expect(payload(cli(value, ["get", reference])).outcome).toEqual(original.outcome);
  expect(payload(cli(value, ["get", reference])).outcome).toEqual(original.outcome);
  expect(readdirSync(join(value.stateRoot, "publications", "objects"))).toHaveLength(1);
});

function scopedService(code, securityRequestId) {
  return service((fixture) => {
    const module = join(fixture.directory, "scoped-refusal.mjs");
    writeFileSync(
      module,
      "import {appendFile} from 'node:fs/promises';export async function pullRequest(){await appendFile(" +
        JSON.stringify(join(fixture.directory, "issuer-calls")) +
        ",'acquire\\n');throw Object.assign(new Error('private-provider-secret'),{publicCode:" +
        JSON.stringify(code) +
        ",status:503,securityRequestId:" +
        JSON.stringify(securityRequestId) +
        "})}",
    );
    fixture.pullRequestFixture = pathToFileURL(module).href;
  });
}
test.each([
  "SCOPED_CREDENTIAL_OUTCOME_UNCONFIRMED",
  "SCOPED_CREDENTIAL_CUSTODY_UNCONFIRMED",
  "SCOPED_CREDENTIAL_DISPOSAL_PENDING",
])(
  "CLI preserves %s with original operation/security references without another issuance",
  async (code) => {
    const value = await scopedService(code, "ws1-" + randomUUID());
    const submitted = cli(value, ["pr-create", "work", "main", "Owner PR"]);
    expect(submitted.status).toBe(1);
    const original = payload(submitted);
    expect(original).toMatchObject({
      state: "unconfirmed",
      original: { error: { code } },
      security_operation: expect.any(String),
    });
    const collected = cli(value, ["get", original.operation]);
    expect(collected.status).toBe(1);
    expect(payload(collected)).toEqual(original);
    const found = cli(value, ["find", "--kind", "pull-request"]);
    expect(found.status).toBe(0);
    expect(payload(found).operations).toMatchObject([
      { operation: original.operation, state: "unconfirmed" },
    ]);
    expect(readFileSync(join(value.directory, "issuer-calls"), "utf8")).toBe("acquire\n");
    expect(submitted.stdout + submitted.stderr).not.toContain("private-provider-secret");
  },
);
test("confirmed scoped refusal stays a completed refusal in discovery and collection", async () => {
  const value = await scopedService("SCOPED_CREDENTIAL_AUTHORITY_REFUSED", "ws1-" + randomUUID());
  const original = payload(cli(value, ["pr-create", "work", "main", "Owner PR"]));
  expect(original).toMatchObject({
    state: "completed",
    outcome: { ok: false, error: { code: "SCOPED_CREDENTIAL_AUTHORITY_REFUSED" } },
  });
  expect(payload(cli(value, ["find", "--kind", "pull-request"])).operations).toMatchObject([
    { operation: original.operation, state: "completed" },
  ]);
  expect(payload(cli(value, ["get", original.operation]))).toEqual(original);
  expect(readFileSync(join(value.directory, "issuer-calls"), "utf8")).toBe("acquire\n");
});
test.each([
  ["pr-get", ["7"]],
  ["pr-find", ["work", "main"]],
])(
  "CLI %s preserves scoped read uncertainty without provider metadata leakage",
  async (command, args) => {
    const value = await scopedService("SCOPED_CREDENTIAL_DISPOSAL_PENDING", "ws1-" + randomUUID());
    const result = cli(value, [command, ...args]);
    expect(result.status).toBe(1);
    expect(payload(result)).toMatchObject({
      error: { code: "SCOPED_CREDENTIAL_DISPOSAL_PENDING" },
      security_operation: expect.any(String),
    });
    expect(result.stdout + result.stderr).not.toContain("private-provider-secret");
    expect(readFileSync(join(value.directory, "issuer-calls"), "utf8")).toBe("acquire\n");
  },
);
test("post-dispatch PR uncertainty retains the original security reference through pure get", async () => {
  const value = await scopedService("WORKSPACE_OUTCOME_UNCONFIRMED", "ws1-" + randomUUID());
  const submitted = cli(value, ["pr-create", "work", "main", "Owner PR"]);
  expect(submitted.status).toBe(1);
  const original = payload(submitted);
  expect(original).toMatchObject({ state: "unconfirmed", security_operation: expect.any(String) });
  expect(payload(cli(value, ["get", original.operation]))).toEqual(original);
  expect(payload(cli(value, ["find", "--kind", "pull-request"])).operations).toMatchObject([
    { operation: original.operation, state: "unconfirmed" },
  ]);
  expect(readFileSync(join(value.directory, "issuer-calls"), "utf8")).toBe("acquire\n");
});

test.each(["native-upload", "native-stdin"])(
  "CLI %s preserves confirmed source refusal without an effect",
  async (mode) => {
    const value = await service();
    const result = cli(
      value,
      mode === "native-upload"
        ? ["native-upload", "target.bin"]
        : [
            "exec",
            "--native-stdin",
            "--",
            process.execPath,
            "-e",
            "require('node:fs').writeFileSync('effect','started')",
          ],
      JSON.stringify(descriptor),
    );
    expect(result.status).toBe(1);
    expect(payload(result)).toMatchObject({
      error: { code: "SOURCE_REFUSED" },
      operation: expect.any(String),
    });
    expect(result.stdout + result.stderr).not.toContain("private-source-secret");
    expect(result.stdout + result.stderr).not.toContain("127.0.0.1");
    expect(existsSync(join(value.root, "target.bin"))).toBe(false);
    expect(existsSync(join(value.root, "effect"))).toBe(false);
    expect(payload(cli(value, ["get", payload(result).operation])).state).toBe("absent");
  },
);

test("CLI refuses old control JSON, caller identity and mutually exclusive stdin before submission", async () => {
  const value = await service();
  const before = readdirSync(join(value.stateRoot, "requests"));
  for (const args of [
    ["action", "-"],
    ["exec", "--request-id", "ws1-" + randomUUID(), "--", "true"],
    ["exec", "--stdin", "--native-stdin", "--", "true"],
  ]) {
    const result = cli(value, args, JSON.stringify(descriptor));
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("refused before dispatch");
  }
  expect(readdirSync(join(value.stateRoot, "requests"))).toEqual(before);
});

test.each(["create", "upload"])(
  "CLI %s preserves a precondition refusal and the existing target",
  async (action) => {
    const value = await service();
    writeFileSync(join(value.root, "target.txt"), "original");
    const result = cli(value, [action, "target.txt", "-"], "replacement");
    expect(result.status).toBe(1);
    expect(payload(result).error).toMatchObject({ code: "FILE_REJECTED", reason: "precondition" });
    expect(readFileSync(join(value.root, "target.txt"), "utf8")).toBe("original");
  },
);

test("internal original stdin conflict still refuses before command launch", async () => {
  const value = await service();
  const requestId = "ws1-" + randomUUID();
  await call(value, "PUT", "/v1/operations/" + requestId + "/input", Buffer.from("original"));
  const refused = JSON.parse(
    (await call(value, "PUT", "/v1/operations/" + requestId + "/input", Buffer.from("replacement")))
      .bytes,
  );
  expect(refused.error.code).toBe("REQUEST_ID_CONFLICT");
  expect(existsSync(join(value.root, "effect"))).toBe(false);
});

test("post-effect publication failure retains original uncertainty through the semantic owner", async () => {
  const value = await service(),
    requestId = "ws1-" + randomUUID();
  mkdirSync(join(value.stateRoot, "requests", requestId, "result.json"), {
    recursive: true,
    mode: 0o700,
  });
  const result = await tool(
    value,
    "file_create",
    { path: "written.txt", text: "written" },
    requestId,
  );
  expect(result.isError).toBe(true);
  expect(result.structuredContent).toMatchObject({
    operation: expect.any(String),
    error: { code: "WORKSPACE_OUTCOME_UNCONFIRMED" },
  });
  expect(readFileSync(join(value.root, "written.txt"), "utf8")).toBe("written");
});

test("CLI preview retains native image output and its selected whole-file bound", async () => {
  const value = await service();
  const image = await sharp({ create: { width: 3, height: 2, channels: 3, background: "#aabbcc" } })
    .png()
    .toBuffer();
  writeFileSync(join(value.root, "image.png"), image);
  const result = cli(value, ["preview", "image.png"]);
  expect(result.status).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual(
    await tool(value, "file_preview", { path: "image.png" }),
  );
  expect(cli(value, ["preview", "image.png", "--max-bytes", String(image.length - 1)]).status).toBe(
    1,
  );
});
