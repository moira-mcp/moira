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
const descriptor = {
  file_id: "file_fixture",
  download_url: "https://127.0.0.1/source?sig=private-source-secret",
  size_bytes: 3,
};

test("CLI action preserves session cwd, environment and scripts through the common owner contract", async () => {
  const value = await service();
  mkdirSync(join(value.root, "nested"));
  const requestId = `ws1-${randomUUID()}`;
  const started = cli(
    value,
    ["action", "-"],
    JSON.stringify({
      action: "exec",
      request: {
        request_id: requestId,
        session: "cli-context",
        session_start: true,
        cwd: "nested",
        env: { CLI_VALUE: "authored value" },
        script: 'printf "%s|%s" "$CLI_VALUE" "$PWD"; export CLI_VALUE="retained value"',
        timeout_seconds: 10,
      },
    }),
  );
  expect(started.status).toBe(0);
  const [printed, payload] = started.stdout.trim().split("\n");
  expect(printed).toBe(requestId);
  expect(JSON.parse(payload).structuredContent).toMatchObject({
    request_id: requestId,
    state: "succeeded",
    runtimeMs: 10_000,
    stdout: `authored value|${join(value.root, "nested")}`,
  });
  const continuedId = `ws1-${randomUUID()}`;
  const continued = cli(
    value,
    ["action", "-"],
    JSON.stringify({
      action: "exec",
      request: {
        request_id: continuedId,
        session: "cli-context",
        script: 'printf "%s|%s" "$CLI_VALUE" "$PWD"',
      },
    }),
  );
  expect(continued.status).toBe(0);
  expect(JSON.parse(continued.stdout.trim().split("\n")[1]).structuredContent).toMatchObject({
    request_id: continuedId,
    state: "succeeded",
    stdout: `retained value|${join(value.root, "nested")}`,
  });
});

test("CLI action collects the original process and reads its requested range without repeating its effect", async () => {
  const value = await service();
  const requestId = `ws1-${randomUUID()}`;
  const inputPath = join(value.directory, "action.json");
  writeFileSync(
    inputPath,
    JSON.stringify({
      action: "process_start",
      request: {
        request_id: requestId,
        argv: [
          process.execPath,
          "-e",
          "require('node:fs').appendFileSync('effect','once\\n');process.stdout.write('0123456789abcdef')",
        ],
      },
    }),
  );
  const submitted = cli(value, ["action", inputPath]);
  expect(submitted.status).toBe(0);
  expect(submitted.stdout.split("\n")[0]).toBe(requestId);
  const collect = () =>
    cli(
      value,
      ["action", "-"],
      JSON.stringify({ action: "exec", request: { request_id: requestId } }),
    );
  const collected = collect();
  expect(collected.status).toBe(0);
  const original = JSON.parse(collected.stdout.trim().split("\n")[1]);
  expect(original.structuredContent).toMatchObject({
    request_id: requestId,
    state: "succeeded",
    stdout: "0123456789abcdef",
  });
  expect(collect().stdout).toBe(collected.stdout);
  const ranged = cli(
    value,
    ["action", "-"],
    JSON.stringify({
      action: "process_read",
      request: { process_id: requestId, stream: "stdout", offset: 3, length: 5 },
    }),
  );
  expect(ranged.status).toBe(0);
  expect(JSON.parse(ranged.stdout.trim().split("\n")[1]).structuredContent).toEqual({
    process_id: requestId,
    stream: "stdout",
    offset: 3,
    total_bytes: 16,
    text: "34567",
  });
  expect(readFileSync(join(value.root, "effect"), "utf8")).toBe("once\n");
});

test("CLI communication publishes exact bytes and collects its original receipt without a second publication", async () => {
  const value = await service();
  const requestId = `ws1-${randomUUID()}`;
  const bytes = Buffer.from([0, 255, 42, 13, 10, 128]);
  const input = JSON.stringify({
    action: "publish",
    requestId,
    source: {
      type: "inline",
      data: bytes.toString("base64"),
      fileName: "owner.bin",
      mimeType: "application/octet-stream",
    },
  });
  const submitted = cli(value, ["communication", "-"], input);
  expect(submitted.status).toBe(0);
  const [printed, payload] = submitted.stdout.trim().split("\n");
  expect(printed).toBe(requestId);
  const receipt = JSON.parse(payload);
  expect(receipt).toMatchObject({
    requestId,
    state: "completed",
    outcome: { ok: true, result: { file: { fileName: "owner.bin", size: bytes.length } } },
  });
  const collected = cli(value, ["status", requestId]);
  expect(collected.status).toBe(0);
  expect(JSON.parse(collected.stdout)).toEqual(receipt);
  const repeated = cli(value, ["communication", "-"], input);
  expect(repeated.status).toBe(0);
  const [repeatedId, repeatedPayload] = repeated.stdout.trim().split("\n");
  expect(repeatedId).toBe(requestId);
  expect(JSON.parse(repeatedPayload)).toEqual(receipt);
  expect(readdirSync(join(value.stateRoot, "publications", "objects"))).toHaveLength(1);
  const token = receipt.outcome.result.file.referenceId.split("/").at(-1);
  const downloaded = await call(value, "GET", `/v1/publications/${token}`);
  expect(downloaded.status).toBe(200);
  expect(downloaded.bytes).toEqual(bytes);
});

function scopedService(code, securityRequestId) {
  return service((fixture) => {
    const module = join(fixture.directory, "scoped-refusal.mjs");
    writeFileSync(
      module,
      `import {appendFile} from 'node:fs/promises';export async function pullRequest(){await appendFile(${JSON.stringify(join(fixture.directory, "issuer-calls"))},'acquire\\n');throw Object.assign(new Error('private-provider-secret'),{publicCode:${JSON.stringify(code)},status:503,securityRequestId:${JSON.stringify(securityRequestId)}})}`,
    );
    fixture.pullRequestFixture = pathToFileURL(module).href;
  });
}

test.each([
  "SCOPED_CREDENTIAL_OUTCOME_UNCONFIRMED",
  "SCOPED_CREDENTIAL_CUSTODY_UNCONFIRMED",
  "SCOPED_CREDENTIAL_DISPOSAL_PENDING",
])(
  "CLI preserves %s as original security uncertainty rather than PR dispatch uncertainty",
  async (code) => {
    const securityRequestId = `ws1-${randomUUID()}`;
    const value = await scopedService(code, securityRequestId);
    const requestId = `ws1-${randomUUID()}`;
    const submitted = cli(
      value,
      ["pull-request-create", "--request-id", requestId, "-"],
      JSON.stringify({ head: "work", base: "main", title: "Owner PR" }),
    );
    expect(submitted.status).toBe(1);
    const [printed, payload] = submitted.stdout.trim().split("\n");
    expect(printed).toBe(requestId);
    expect(JSON.parse(payload).structuredContent).toMatchObject({
      request_id: requestId,
      state: "not_started",
      error: { code },
      security_request_id: securityRequestId,
    });
    expect(submitted.stderr).toContain(code);
    expect(submitted.stderr).toContain(securityRequestId);
    expect(submitted.stderr).toContain("unconfirmed");
    expect(submitted.stderr).not.toContain("confirmed result is not a lost reply");
    expect(submitted.stdout + submitted.stderr).not.toContain("private-provider-secret");
    const collected = cli(value, ["pull-request-create", "--request-id", requestId]);
    expect(collected.status).toBe(1);
    expect(collected.stdout).toBe(submitted.stdout);
    expect(collected.stderr).toBe(submitted.stderr);
    expect(readFileSync(join(value.directory, "issuer-calls"), "utf8")).toBe("acquire\n");
  },
);

test.each([
  ["pull-request-get", ["7"]],
  ["pull-request-find", ["work", "main"]],
])(
  "CLI %s retains original security uncertainty through the owner HTTP refusal",
  async (action, args) => {
    const securityRequestId = `ws1-${randomUUID()}`;
    const code = "SCOPED_CREDENTIAL_DISPOSAL_PENDING";
    const value = await scopedService(code, securityRequestId);
    const result = cli(value, [action, ...args]);
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      isError: true,
      structuredContent: {
        error: { code, message: "Scoped credential operation outcome is unconfirmed" },
        security_request_id: securityRequestId,
      },
    });
    expect(result.stderr).toContain(securityRequestId);
    expect(result.stderr).toContain("unconfirmed");
    expect(result.stderr).not.toContain("confirmed result is not a lost reply");
    expect(result.stdout + result.stderr).not.toContain("private-provider-secret");
    expect(readFileSync(join(value.directory, "issuer-calls"), "utf8")).toBe("acquire\n");
  },
);

test("post-dispatch PR uncertainty retains the original security identity through receipt collection", async () => {
  const securityRequestId = `ws1-${randomUUID()}`;
  const value = await scopedService("WORKSPACE_OUTCOME_UNCONFIRMED", securityRequestId);
  const requestId = `ws1-${randomUUID()}`;
  const submit = async (request) =>
    JSON.parse(
      (
        await call(
          value,
          "POST",
          "/v1/tools",
          { action: "pull_request_create", request },
          { "content-type": "application/json" },
        )
      ).bytes.toString(),
    ).structuredContent;
  const result = await submit({
    request_id: requestId,
    head: "work",
    base: "main",
    title: "Owner PR",
  });
  expect(result).toMatchObject({
    request_id: requestId,
    state: "unknown",
    reason: "PULL_REQUEST_OUTCOME_UNKNOWN",
    security_request_id: securityRequestId,
  });
  expect(await submit({ request_id: requestId })).toEqual(result);
  const collected = cli(value, ["pull-request-create", "--request-id", requestId]);
  expect(collected.status).toBe(1);
  const [printed, payload] = collected.stdout.trim().split("\n");
  expect(printed).toBe(requestId);
  expect(JSON.parse(payload)).toMatchObject({
    isError: true,
    structuredContent: {
      request_id: requestId,
      state: "unknown",
      reason: "PULL_REQUEST_OUTCOME_UNKNOWN",
      error: { code: "WORKSPACE_OUTCOME_UNCONFIRMED" },
      security_request_id: securityRequestId,
    },
  });
  expect(collected.stderr).toContain("could not be confirmed");
  expect(readFileSync(join(value.directory, "issuer-calls"), "utf8")).toBe("acquire\n");
  expect(JSON.stringify(result)).not.toContain("private-provider-secret");
});

test.each(["native-upload", "native-stdin"])(
  "CLI %s reports a confirmed owner source refusal with original identity and no effect",
  async (mode) => {
    const value = await service();
    const requestId = `ws1-${randomUUID()}`;
    const args =
      mode === "native-upload"
        ? ["native-upload", "--request-id", requestId, "target.bin"]
        : [
            "exec",
            "--request-id",
            requestId,
            "--native-stdin",
            "--",
            process.execPath,
            "-e",
            "require('node:fs').writeFileSync('effect','started')",
          ];
    const result = cli(value, args, JSON.stringify(descriptor));
    expect(result.status).toBe(1);
    const [printed, payload] = result.stdout.trim().split("\n");
    expect(printed).toBe(requestId);
    expect(JSON.parse(payload)).toMatchObject({
      isError: true,
      structuredContent: { error: { code: "SOURCE_REFUSED" }, request_id: requestId },
    });
    expect(result.stderr).toContain("confirmed result is not a lost reply");
    expect(result.stderr).not.toContain("could not be confirmed");
    expect(result.stdout + result.stderr).not.toContain("private-source-secret");
    expect(result.stdout + result.stderr).not.toContain("127.0.0.1");
    expect(existsSync(join(value.root, "target.bin"))).toBe(false);
    expect(existsSync(join(value.root, "effect"))).toBe(false);
    const collected = await call(value, "GET", `/v1/operations/${requestId}`);
    expect(JSON.parse(collected.bytes.toString())).toMatchObject({ state: "absent" });
  },
);

test("CLI refuses mutually exclusive stdin forms before submission", async () => {
  const value = await service();
  const before = readdirSync(join(value.stateRoot, "requests"));
  const result = cli(
    value,
    ["exec", "--stdin", "--native-stdin", "--", "true"],
    JSON.stringify(descriptor),
  );
  expect(result.status).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain("refused before dispatch");
  expect(readdirSync(join(value.stateRoot, "requests"))).toEqual(before);
});

test.each(["write", "upload"])(
  "CLI raw %s preserves a confirmed owner precondition refusal and its original identity",
  async (action) => {
    const value = await service();
    const requestId = `ws1-${randomUUID()}`;
    writeFileSync(join(value.root, "target.txt"), "original");
    const result = cli(
      value,
      [action, "--request-id", requestId, "target.txt", "-"],
      "replacement",
    );
    expect(result.status).toBe(1);
    const [printed, payload] = result.stdout.trim().split("\n");
    expect(printed).toBe(requestId);
    expect(JSON.parse(payload)).toMatchObject({
      isError: true,
      structuredContent: {
        request_id: requestId,
        error: { code: "FILE_REJECTED", reason: "precondition" },
      },
    });
    expect(result.stderr).toContain("confirmed result is not a lost reply");
    expect(result.stderr).not.toContain("could not be confirmed");
    expect(readFileSync(join(value.root, "target.txt"), "utf8")).toBe("original");
    expect(
      JSON.parse((await call(value, "GET", `/v1/operations/${requestId}`)).bytes),
    ).toMatchObject({ state: "absent" });
  },
);

test("CLI stdin preparation preserves a confirmed original-input conflict without launching its command", async () => {
  const value = await service();
  const requestId = `ws1-${randomUUID()}`;
  expect(
    (await call(value, "PUT", `/v1/operations/${requestId}/input`, Buffer.from("original"))).status,
  ).toBe(200);
  const result = cli(
    value,
    [
      "exec",
      "--request-id",
      requestId,
      "--stdin",
      "--",
      process.execPath,
      "-e",
      "require('node:fs').writeFileSync('effect','started')",
    ],
    "replacement",
  );
  expect(result.status).toBe(1);
  const [printed, payload] = result.stdout.trim().split("\n");
  expect(printed).toBe(requestId);
  expect(JSON.parse(payload)).toMatchObject({
    isError: true,
    structuredContent: { request_id: requestId, error: { code: "REQUEST_ID_CONFLICT" } },
  });
  expect(result.stderr).toContain("confirmed result is not a lost reply");
  expect(existsSync(join(value.root, "effect"))).toBe(false);
  expect(JSON.parse((await call(value, "GET", `/v1/operations/${requestId}`)).bytes)).toMatchObject(
    { state: "absent" },
  );
});

test("CLI raw write retains post-effect publication uncertainty instead of claiming a refusal", async () => {
  const value = await service();
  const requestId = `ws1-${randomUUID()}`;
  const directory = join(value.stateRoot, "requests", requestId);
  mkdirSync(join(directory, "result.json"), { recursive: true, mode: 0o700 });
  const result = cli(value, ["write", "--request-id", requestId, "written.txt", "-"], "written");
  expect(result.status).toBe(1);
  const [printed, payload] = result.stdout.trim().split("\n");
  expect(printed).toBe(requestId);
  expect(JSON.parse(payload)).toMatchObject({
    isError: true,
    structuredContent: { request_id: requestId, error: { code: "WORKSPACE_OUTCOME_UNCONFIRMED" } },
  });
  expect(result.stderr).toContain("could not be confirmed");
  expect(result.stderr).not.toContain("confirmed result is not a lost reply");
  expect(readFileSync(join(value.root, "written.txt"), "utf8")).toBe("written");
});

test("CLI preview uses the owner payload and publication preserves the exact original bytes", async () => {
  const value = await service();
  const image = await sharp({ create: { width: 3, height: 2, channels: 3, background: "#aabbcc" } })
    .png()
    .toBuffer();
  writeFileSync(join(value.root, "image.png"), image);
  const result = cli(value, ["preview", "image.png"]);
  expect(result.status).toBe(0);
  const owner = await call(
    value,
    "POST",
    "/v1/tools",
    { action: "preview_image", request: { path: "image.png" } },
    { "content-type": "application/json" },
  );
  expect(JSON.parse(result.stdout)).toEqual(JSON.parse(owner.bytes.toString()));
  const bound = cli(value, ["preview", "image.png", String(image.length - 1)]);
  expect(bound.status).toBe(1);
  expect(bound.stderr).not.toContain("could not be confirmed");
  const published = cli(value, ["publish", "image.png", "image.png", "image/png"]);
  expect(published.status).toBe(0);
  const payload = JSON.parse(published.stdout);
  expect(payload.content[0]).toMatchObject({
    type: "resource_link",
    mimeType: "image/png",
    size: image.length,
  });
  expect(payload.structuredContent.file.reference_id).toMatch(/^owner-file:\/\/workspace\//);
  const token = payload.structuredContent.file.reference_id.split("/").at(-1);
  const downloaded = await call(value, "GET", `/v1/publications/${token}`);
  expect(downloaded.status).toBe(200);
  expect(downloaded.bytes).toEqual(image);
});
