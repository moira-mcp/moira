import { afterEach, expect, test } from "@jest/globals";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const directories: string[] = [];
const supervisor = pathToFileURL(
  resolve("packages/web-backend/src/services/github-codespaces-remote-supervisor.mjs"),
).href;
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function fixture() {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "moira-local-repository-")));
  directories.push(directory);
  const root = join(directory, "project");
  mkdirSync(root);
  mkdirSync(join(root, "nested"));
  const origin = `http://device:${"a".repeat(64)}@127.0.0.1:3437/git/owner/project.git`;
  for (const argv of [
    ["init", root],
    ["-C", root, "remote", "add", "origin", origin],
  ]) {
    const initialized = spawnSync("git", argv, { encoding: "utf8" });
    if (initialized.status !== 0) throw new Error(initialized.stderr);
  }
  const metadata = statSync(root);
  return {
    binding: {
      repositoryFullName: "owner/project",
      root,
      origin,
      dev: metadata.dev,
      ino: metadata.ino,
    },
    environment: {
      ...process.env,
      HOME: directory,
      MOIRA_CODESPACES_ROOT: directory,
      MOIRA_OPERATION_STATE_DIR: join(directory, "operations"),
      MOIRA_ENVIRONMENT_ID: "local-repository-test",
    },
  };
}

type Result = Record<string, unknown>;
function call(
  local: ReturnType<typeof fixture>,
  request: Result,
  binding: unknown = local.binding,
): Promise<Result> {
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, ["--input-type=module"], {
      env: local.environment,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const output: Buffer[] = [];
    const errors: Buffer[] = [];
    child.stdout.on("data", (bytes) => output.push(Buffer.from(bytes)));
    child.stderr.on("data", (bytes) => errors.push(Buffer.from(bytes)));
    child.once("error", fail);
    child.once("close", (code) => {
      if (code !== 0) fail(new Error(Buffer.concat(errors).toString()));
      else done(JSON.parse(Buffer.concat(output).toString()));
    });
    child.stdin.end(`import {runRequest} from ${JSON.stringify(supervisor)};
      process.stdout.write(JSON.stringify(await runRequest(${JSON.stringify(request)}${binding === null ? "" : `,${JSON.stringify(binding)}`})));`);
  });
}

const marker = () => `moira-op-${randomBytes(16).toString("hex")}`;
const command = (properties: Result): Result => ({
  version: 1,
  action: "execute",
  remoteMarker: marker(),
  repositoryFullName: "owner/project",
  argv: [process.execPath, "-e", "process.stdout.write('local')"],
  stdin: "",
  timeoutMs: 5000,
  maxStdoutBytes: 1024,
  maxStderrBytes: 1024,
  maxRetainedBytes: 4096,
  ...properties,
});
async function finish(local: ReturnType<typeof fixture>, request: Result): Promise<Result> {
  let result = await call(local, request);
  const deadline = Date.now() + 5000;
  while (result.state === "running" && Date.now() < deadline) {
    await new Promise((done) => setTimeout(done, 25));
    result = await call(local, {
      version: 1,
      action: "inspect",
      remoteMarker: request.remoteMarker,
    });
  }
  expect(result.state).toBe("succeeded");
  expect(result.exitCode).toBe(0);
  return result;
}

test("a locally bound broker repository executes stdin and preserves session directory and variables", async () => {
  const local = fixture();
  const echoed = await finish(
    local,
    command({
      argv: [process.execPath, "-e", "process.stdout.write(require('node:fs').readFileSync(0))"],
      stdin: Buffer.from("local stdin").toString("base64"),
    }),
  );
  expect(Buffer.from(echoed.stdoutBase64 as string, "base64").toString()).toBe("local stdin");
  await finish(
    local,
    command({
      argv: undefined,
      script: "cd nested; export LOCAL_VALUE=retained",
      session: "local",
      sessionStart: true,
    }),
  );
  const continued = await finish(
    local,
    command({
      argv: undefined,
      script: 'printf \'%s|%s\' "$LOCAL_VALUE" "$PWD"',
      session: "local",
    }),
  );
  expect(Buffer.from(continued.stdoutBase64 as string, "base64").toString()).toBe(
    `retained|${join(local.binding.root, "nested")}`,
  );
});

test("local file operations use the same bound repository and retain exact binary bytes", async () => {
  const local = fixture();
  const bytes = Buffer.from([0, 255, 128, 13, 10]);
  const written = await call(local, {
    version: 1,
    action: "file-execute",
    remoteMarker: marker(),
    repositoryFullName: "owner/project",
    request: {
      action: "write",
      path: "binary.dat",
      expected: { exists: false },
      bytesBase64: bytes.toString("base64"),
    },
  });
  expect(written.state).toBe("succeeded");
  const read = await call(local, {
    version: 1,
    action: "file-execute",
    remoteMarker: marker(),
    repositoryFullName: "owner/project",
    request: { action: "read", path: "binary.dat", offset: 0, length: 64 },
  });
  expect(read.state).toBe("succeeded");
  expect(Buffer.from((read.value as Result).bytesBase64 as string, "base64")).toEqual(bytes);
});

test("GitHub defaults reject a broker origin even when a request claims another binding", async () => {
  const local = fixture();
  await expect(
    call(local, command({ repositoryBinding: local.binding, skipVerification: true }), null),
  ).rejects.toThrow("repository identity mismatch");
});

test("file inspection does not replay a persisted intent and a fresh write uses the locally bound repository", async () => {
  const local = fixture();
  const remoteMarker = marker();
  const write = {
    version: 1,
    action: "file-execute",
    remoteMarker,
    repositoryFullName: "owner/project",
    request: {
      action: "write",
      path: "resumed.dat",
      expected: { exists: false },
      bytesBase64: Buffer.from("recovered").toString("base64"),
    },
  };
  // Inspecting an old intent settles its outcome; only a new request may initiate the write.
  await expect(call(local, write, null)).rejects.toThrow("repository identity mismatch");
  const result = await call(local, { version: 1, action: "file-inspect", remoteMarker });
  expect(result).toMatchObject({
    state: "failed",
    value: { action: "write", code: "CODESPACE_OPERATION_INTERRUPTED" },
  });
  expect(existsSync(join(local.binding.root, "resumed.dat"))).toBe(false);
  const fresh = await call(local, { ...write, remoteMarker: marker() });
  expect(fresh.state).toBe("succeeded");
  const read = await call(local, {
    version: 1,
    action: "file-execute",
    remoteMarker: marker(),
    repositoryFullName: "owner/project",
    request: { action: "read", path: "resumed.dat", offset: 0, length: 64 },
  });
  expect(Buffer.from((read.value as Result).bytesBase64 as string, "base64").toString()).toBe(
    "recovered",
  );
});

test("a local binding refuses another repository and a replaced root identity", async () => {
  const local = fixture();
  await expect(call(local, command({ repositoryFullName: "other/project" }))).rejects.toThrow(
    "repository identity mismatch",
  );
  await expect(
    call(local, command({}), { ...local.binding, ino: local.binding.ino + 1 }),
  ).rejects.toThrow("repository root identity mismatch");
});
