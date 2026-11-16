const { afterEach, expect, test } = require("@jest/globals");
const { randomUUID } = require("node:crypto");
const { existsSync, writeFileSync, symlinkSync } = require("node:fs");
const { join } = require("node:path");
const { createFixture, start, call, dispose } = require("../../fixtures/workspace-service.cjs");

const fixtures = [];
afterEach(async () => {
  for (const value of fixtures.splice(0)) await dispose(value);
});
async function service() {
  const value = createFixture();
  fixtures.push(value);
  value.ownerSelector = { kind: "github", resourceId: randomUUID() };
  await start(value);
  return value;
}
async function tool(value, action, request, requestId) {
  const response = await call(value, "POST", "/v1/tools", {
    action,
    request,
    ...(requestId ? { requestId } : {}),
  });
  expect(response.status).toBe(200);
  return JSON.parse(response.bytes);
}

test.each([
  ["parent traversal", () => "..", "COMMAND_CWD_OUTSIDE_WORKSPACE"],
  ["absolute outside path", (value) => value.directory, "COMMAND_CWD_OUTSIDE_WORKSPACE"],
  ["outside symlink", () => "escape", "COMMAND_CWD_OUTSIDE_WORKSPACE"],
  ["missing directory", () => "missing-private-name", "COMMAND_CWD_NOT_FOUND"],
  ["ordinary file", () => "ordinary-file", "COMMAND_CWD_NOT_DIRECTORY"],
])(
  "%s produces a precise collectible no-start result without running the command",
  async (_name, cwd, code) => {
    const value = await service();
    symlinkSync(value.directory, join(value.root, "escape"));
    writeFileSync(join(value.root, "ordinary-file"), "data");
    const requestId = "ws1-" + randomUUID();
    const result = await tool(
      value,
      "command_run",
      {
        command: {
          argv: [process.execPath, "-e", "require('node:fs').writeFileSync('must-not-run','bad')"],
        },
        cwd: cwd(value),
      },
      requestId,
    );
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      state: "completed",
      outcome: {
        ok: false,
        error: { code, message: expect.stringContaining("did not start") },
        result: { state: "not_started", exitCode: null },
      },
    });
    expect(JSON.stringify(result)).not.toContain(value.directory);
    expect(JSON.stringify(result)).not.toContain("missing-private-name");
    expect(existsSync(join(value.root, "must-not-run"))).toBe(false);
    expect(existsSync(join(value.directory, "must-not-run"))).toBe(false);
    const collected = await tool(value, "operation_get", {
      reference: result.structuredContent.operation,
    });
    expect(collected).toEqual(result);
  },
);

test("the advised repository-relative folder supports commands and file tools", async () => {
  const value = await service();
  const created = await tool(value, "command_run", {
    command: { script: "mkdir -p moira-ws/task; printf ready > moira-ws/task/result.txt" },
    cwd: ".",
  });
  expect(created.structuredContent).toMatchObject({ state: "completed", outcome: { ok: true } });
  const continued = await tool(value, "command_run", {
    command: {
      argv: [
        process.execPath,
        "-e",
        "process.stdout.write(require('node:fs').readFileSync('result.txt','utf8'))",
      ],
    },
    cwd: "moira-ws/task",
  });
  expect(continued.structuredContent).toMatchObject({ outcome: { ok: true }, stdout: "ready" });
  const read = await tool(value, "file_read", { path: "moira-ws/task/result.txt" });
  expect(read.isError).not.toBe(true);
  expect(JSON.stringify(read.structuredContent)).toContain("ready");
});

test("file containment refusal explains the permitted path without leaking a private outside path", async () => {
  const value = await service();
  const outside = join(value.directory, "private-outside-name");
  writeFileSync(outside, "private-outside-content");
  symlinkSync(outside, join(value.root, "outside-link"));
  for (const path of [outside, "../private-outside-name", "outside-link"]) {
    const refused = await tool(value, "file_read", { path });
    expect(refused.isError).toBe(true);
    expect(refused.structuredContent.error).toMatchObject({
      code: "FILE_REJECTED",
      reason: "unsafe_access",
      message: expect.stringContaining("relative to the selected workspace repository"),
    });
    expect(JSON.stringify(refused)).not.toContain(outside);
    expect(JSON.stringify(refused)).not.toContain("private-outside-content");
  }
});
