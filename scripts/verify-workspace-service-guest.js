import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { createWorkspaceRequestId } from "../packages/shared/src/codespaces/workspace-request-id.ts";
import {
  WORKSPACE_INSTALL_SCRIPT,
  WORKSPACE_PROBE_SCRIPT,
  WORKSPACE_CONFIGURE_SCRIPT,
  WORKSPACE_START_SCRIPT,
  WORKSPACE_HEALTH_SCRIPT,
  loadWorkspacePayload,
  workspaceInstallInput,
} from "../packages/workspace-service/src/bootstrap.mjs";
import { DEFAULT_TEMPLATE } from "../packages/local/dist/config.js";

function docker(argv, input) {
  return new Promise((done, failed) => {
    const child = spawn("docker", argv, { stdio: ["pipe", "pipe", "pipe"] });
    const stdout = [],
      stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.once("error", failed);
    child.once("close", (code) =>
      code === 0
        ? done(Buffer.concat(stdout))
        : failed(new Error(`Guest verification exit ${code}: ${Buffer.concat(stderr)}`)),
    );
    child.stdin.on("error", (error) => {
      if (error.code !== "EPIPE") failed(error);
    });
    if (input && Symbol.asyncIterator in Object(input)) {
      void (async () => {
        try {
          for await (const bytes of input)
            await new Promise((accept, reject) =>
              child.stdin.write(bytes, (error) => (error ? reject(error) : accept())),
            );
          child.stdin.end();
        } catch (error) {
          child.kill();
          failed(error);
        }
      })();
    } else child.stdin.end(input);
  });
}

const payload = await loadWorkspacePayload(
  resolve("packages/workspace-service/dist"),
  process.arch,
);
let container;
try {
  await docker(["image", "inspect", DEFAULT_TEMPLATE, "--format", "{{.Id}}"]);
  container = (
    await docker([
      "run",
      "--detach",
      "--network",
      "none",
      "--read-only",
      "--user",
      "1000:1000",
      "--env",
      "HOME=/home/agent",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--tmpfs",
      "/tmp:rw,nosuid,nodev,mode=1777",
      "--tmpfs",
      "/workspaces:rw,nosuid,nodev,mode=1777",
      "--tmpfs",
      "/home/agent:rw,exec,nosuid,nodev,mode=700,uid=1000,gid=1000",
      "--entrypoint",
      "/bin/sh",
      DEFAULT_TEMPLATE,
      "-c",
      "exec tail -f /dev/null",
    ])
  )
    .toString()
    .trim();
  assert.match(container, /^[a-f0-9]{64}$/);
  const fixed = (script, input) =>
    docker(["exec", "--interactive", container, "/bin/sh", "-c", script], input);
  const installed = JSON.parse(
    await fixed(WORKSPACE_INSTALL_SCRIPT, workspaceInstallInput(payload)),
  );
  assert.equal(installed.releaseIdentity, payload.release);
  const program = `/home/agent/.local/share/moira-workspace/releases/${payload.release}`;
  const node = `${program}/runtime/bin/node`;
  const cli = (...args) =>
    docker(["exec", "--interactive", container, "/home/agent/.local/bin/moira-workspace", ...args]);
  await docker([
    "exec",
    container,
    "/bin/sh",
    "-c",
    "mkdir /workspaces/project; git init /workspaces/project; git -C /workspaces/project remote add origin https://github.com/owner/project.git",
  ]);
  const measured = JSON.parse(await fixed(WORKSPACE_PROBE_SCRIPT));
  // Missing configuration must fail the actual startup owner. A request to
  // start is not readiness, and offline health must settle without a waiter.
  await assert.rejects(fixed(WORKSPACE_START_SCRIPT));
  await assert.rejects(fixed(WORKSPACE_HEALTH_SCRIPT));
  const configuration = {
    version: 1,
    repositoryFullName: "owner/project",
    root: "/workspaces/project",
    remote: {
      version: 1,
      origin: "https://moira.example.invalid",
      resourceId: randomUUID(),
      resourceGeneration: 1,
      authorizationGeneration: 1,
      environmentIdentity: measured.environmentIdentity,
      credential: "x".repeat(43),
    },
  };
  await fixed(
    WORKSPACE_CONFIGURE_SCRIPT,
    JSON.stringify({
      ...configuration,
      remote: { ...configuration.remote, origin: "http://moira.example.invalid" },
    }),
  );
  // This refusal occurs after the private HTTP service has opened: the failed
  // child must close that partial owner and report failure to its controller.
  await assert.rejects(fixed(WORKSPACE_START_SCRIPT));
  await assert.rejects(fixed(WORKSPACE_HEALTH_SCRIPT));
  await fixed(WORKSPACE_CONFIGURE_SCRIPT, JSON.stringify(configuration));
  const ready = JSON.parse(await fixed(WORKSPACE_START_SCRIPT));
  assert.equal(ready.releaseIdentity, payload.release);
  assert.ok(Number.isSafeInteger(ready.processId) && ready.processId > 1);
  const health = JSON.parse(await fixed(WORKSPACE_HEALTH_SCRIPT));
  assert.equal(health.processId, ready.processId);
  await assert.rejects(
    docker(["exec", container, node, `${program}/service/daemon.mjs`, "--start"]),
  );
  assert.equal(JSON.parse(await fixed(WORKSPACE_HEALTH_SCRIPT)).processId, ready.processId);
  assert.equal(
    JSON.parse(await fixed(WORKSPACE_HEALTH_SCRIPT)).environmentIdentity,
    measured.environmentIdentity,
  );
  assert.match((await cli("--help")).toString(), /moira-workspace exec/);
  const id = createWorkspaceRequestId();
  const accepted = (
    await cli(
      "exec",
      "--request-id",
      id,
      "--",
      "/bin/sh",
      "-c",
      "printf owned-runtime; printf error-stream >&2; exit 23",
    )
  )
    .toString()
    .trim()
    .split("\n");
  assert.equal(accepted[0], id);
  let status;
  do {
    status = JSON.parse(await cli("status", id));
  } while (["running", "starting"].includes(status.state));
  assert.equal(status.exitCode, 23);
  assert.equal((await cli("output", id, "stdout")).toString(), "owned-runtime");
  assert.equal((await cli("output", id, "stderr")).toString(), "error-stream");
  // The command receives valid per-string Linux argv/env values, while their
  // aggregate JSON crosses the collector pipe's UTF-8 chunk boundaries.
  const unicode = "€🙂Ж".repeat(6000);
  const unicodeBytes = Buffer.from(unicode);
  const unicodeInput = Buffer.from(unicode.repeat(2));
  const unicodeId = createWorkspaceRequestId();
  const unicodeAccepted = await docker(
    [
      "exec",
      "--interactive",
      container,
      "/home/agent/.local/bin/moira-workspace",
      "exec",
      "--request-id",
      unicodeId,
      "--stdin",
      "--",
      "/usr/bin/env",
      `FIRST_UNICODE=${unicode}`,
      `SECOND_UNICODE=${unicode}`,
      `THIRD_UNICODE=${unicode}`,
      node,
      "-e",
      "const {createHash}=require('node:crypto');const chunks=[];process.stdin.on('data',chunk=>chunks.push(chunk));process.stdin.on('end',()=>{const bytes=Buffer.concat(chunks);process.stdout.write(JSON.stringify({environments:['FIRST_UNICODE','SECOND_UNICODE','THIRD_UNICODE'].map(key=>({size:Buffer.byteLength(process.env[key]),sha256:createHash('sha256').update(process.env[key]).digest('hex')})),stdin:{size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')}}))})",
    ],
    unicodeInput,
  );
  assert.equal(unicodeAccepted.toString().split("\n")[0], unicodeId);
  do {
    status = JSON.parse(await cli("status", unicodeId));
  } while (["running", "starting"].includes(status.state));
  assert.equal(status.state, "succeeded");
  assert.deepEqual(JSON.parse(await cli("output", unicodeId, "stdout")), {
    environments: Array(3).fill({
      size: unicodeBytes.length,
      sha256: createHash("sha256").update(unicodeBytes).digest("hex"),
    }),
    stdin: {
      size: unicodeInput.length,
      sha256: createHash("sha256").update(unicodeInput).digest("hex"),
    },
  });
  const bytes = Buffer.from([0, 255, 1, 13, 10]);
  await docker(
    [
      "exec",
      "--interactive",
      container,
      node,
      "-e",
      "require('node:fs').writeFileSync('/tmp/binary',require('node:fs').readFileSync(0))",
    ],
    bytes,
  );
  await cli("write", "binary.dat", "/tmp/binary");
  assert.deepEqual(await cli("read", "binary.dat"), bytes);
  await fixed(WORKSPACE_INSTALL_SCRIPT, workspaceInstallInput(payload));
  await fixed(WORKSPACE_START_SCRIPT);
  assert.equal(JSON.parse(await fixed(WORKSPACE_HEALTH_SCRIPT)).releaseIdentity, payload.release);
  assert.equal((await cli("output", id, "stdout")).toString(), "owned-runtime");
  assert.deepEqual(await cli("read", "binary.dat"), bytes);
  await assert.rejects(cli("read", "../outside"));
  await docker(["exec", container, node, `${program}/service/daemon.mjs`, "--stop"]);
  await assert.rejects(fixed(WORKSPACE_HEALTH_SCRIPT));
  console.log(
    "Verified pinned Linux runtime installation, actual startup readiness and failure, single-owner locking, offline Unix CLI, exact exit/output, binary files and in-place restart preserving workspace data and receipts.",
  );
} finally {
  if (container && /^[a-f0-9]{64}$/.test(container)) await docker(["rm", "--force", container]);
}
