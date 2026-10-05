import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { DEFAULT_TEMPLATE } from "../packages/local/dist/config.js";

function docker(argv, input = "") {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", argv, { stdio: ["pipe", "pipe", "pipe"], shell: false });
    const output = [];
    const errors = [];
    let length = 0;
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("Guest image check timed out"));
    }, 120_000);
    child.stdout.on("data", (chunk) => {
      length += chunk.length;
      if (length > 8 * 1024 * 1024) child.kill("SIGKILL");
      else output.push(chunk);
    });
    child.stderr.on("data", (chunk) => {
      if (errors.reduce((sum, item) => sum + item.length, 0) < 65536) errors.push(chunk);
    });
    child.stdin.on("error", (error) => {
      if (error.code !== "EPIPE") reject(error);
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(Buffer.concat(output).toString());
      else
        reject(
          new Error(`Docker image check failed (${code}): ${Buffer.concat(errors).toString()}`),
        );
    });
    child.stdin.end(input);
  });
}

const name = `moira-local-guest-check-${randomBytes(8).toString("hex")}`;
let container;
try {
  try {
    await docker(["image", "inspect", DEFAULT_TEMPLATE, "--format", "{{.Id}}"]);
  } catch {
    throw new Error(
      `Guest diagnostic requires its pinned image locally; pull ${DEFAULT_TEMPLATE} first.`,
    );
  }
  container = (
    await docker([
      "run",
      "--detach",
      "--name",
      name,
      "--network",
      "none",
      "--read-only",
      "--memory",
      "512m",
      "--cpus",
      "1",
      "--pids-limit",
      "128",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--tmpfs",
      "/tmp:rw,nosuid,nodev,mode=1777",
      "--tmpfs",
      "/workspaces:rw,nosuid,nodev,mode=1777",
      "--tmpfs",
      "/home/agent:rw,nosuid,nodev,mode=700,uid=1000,gid=1000",
      DEFAULT_TEMPLATE,
      "sleep",
      "300",
    ])
  ).trim();
  assert.match(container, /^[a-f0-9]{64}$/);
  for (const [source, target] of [
    ["packages/local/dist/guest-worker.js", "/tmp/worker.mjs"],
    ["packages/local/dist/guest-bootstrap.js", "/tmp/bootstrap.mjs"],
  ]) {
    await docker(
      [
        "exec",
        "--interactive",
        container,
        "node",
        "-e",
        "require('node:fs').writeFileSync(process.argv[1],require('node:fs').readFileSync(0),{mode:384})",
        target,
      ],
      await readFile(source),
    );
  }
  const binding = {
    repository: "owner/project",
    spaceId: randomUUID(),
    brokerToken: randomBytes(32).toString("hex"),
  };
  // Prepare the real broker-origin Git repository and invoke the shipped bootstrap's binding routine.
  // This network-disabled container cannot establish a real host broker or sbx isolation.
  await docker(
    [
      "exec",
      "--interactive",
      container,
      "node",
      "--input-type=module",
      "-e",
      "import{bindGuestRepository}from'/tmp/bootstrap.mjs';import f from'node:fs';import{homedir}from'node:os';import{execFileSync}from'node:child_process';const input=JSON.parse(f.readFileSync(0,'utf8'));const p=homedir()+'/.local/share/moira-local';f.mkdirSync(p,{recursive:true});f.mkdirSync('/workspaces/project/nested',{recursive:true});execFileSync('git',['init','/workspaces/project']);execFileSync('git',['-C','/workspaces/project','remote','add','origin',`http://${input.binding.spaceId}:${input.binding.brokerToken}@127.0.0.1:3437/git/${input.binding.repository}.git`]);f.writeFileSync(p+'/environment.json',JSON.stringify(input.environment));await bindGuestRepository(input.binding);",
    ],
    JSON.stringify({
      binding,
      environment: {
        HTTP_PROXY: "http://127.0.0.1:1",
        HTTPS_PROXY: "http://127.0.0.1:1",
        http_proxy: "http://127.0.0.1:1",
        https_proxy: "http://127.0.0.1:1",
        NO_PROXY: "localhost",
        no_proxy: "localhost",
      },
    }),
  );
  const call = async (request) => {
    const output = JSON.parse(
      await docker(
        ["exec", "--interactive", container, "node", "/tmp/worker.mjs"],
        JSON.stringify({
          kind: "operation",
          request: { version: 1, repositoryFullName: "owner/project", ...request },
        }),
      ),
    );
    assert.equal(output.ok, true);
    return output.result;
  };
  const marker = () => `moira-op-${randomBytes(16).toString("hex")}`;
  const command = async (properties) => {
    const remoteMarker = marker();
    let result = await call({
      action: "execute",
      remoteMarker,
      stdin: "",
      timeoutMs: 30_000,
      maxStdoutBytes: 65536,
      maxStderrBytes: 65536,
      maxRetainedBytes: 1024 * 1024,
      ...properties,
    });
    for (let attempt = 0; result.state === "running" && attempt < 100; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      result = await call({ action: "inspect", remoteMarker });
    }
    assert.equal(result.state, "succeeded");
    assert.equal(result.exitCode, 0);
    return Buffer.from(result.stdoutBase64, "base64").toString();
  };
  assert.equal(
    await command({
      argv: ["node", "-e", "process.stdout.write(require('node:fs').readFileSync(0))"],
      stdin: Buffer.from("guest-stdin").toString("base64"),
    }),
    "guest-stdin",
  );
  const bytes = Buffer.from([0, 1, 255, 13, 10, 128]);
  const written = await call({
    action: "file-execute",
    remoteMarker: marker(),
    request: {
      action: "write",
      path: "binary.dat",
      expected: { exists: false },
      bytesBase64: bytes.toString("base64"),
    },
  });
  assert.equal(written.state, "succeeded");
  const read = await call({
    action: "file-execute",
    remoteMarker: marker(),
    request: { action: "read", path: "binary.dat", offset: 0, length: 64 },
  });
  assert.equal(read.state, "succeeded");
  assert.deepEqual(Buffer.from(read.value.bytesBase64, "base64"), bytes);
  await command({
    script: "export MOIRA_LOCAL_CHECK=retained; cd nested",
    session: "local-check",
    sessionStart: true,
  });
  assert.equal(
    await command({
      script: 'printf \'%s|%s\' "$MOIRA_LOCAL_CHECK" "$PWD"',
      session: "local-check",
    }),
    "retained|/workspaces/project/nested",
  );
  await assert.rejects(
    call({
      action: "execute",
      remoteMarker: marker(),
      repositoryFullName: "other/project",
      argv: ["true"],
      stdin: "",
      timeoutMs: 1000,
      maxStdoutBytes: 1024,
      maxStderrBytes: 1024,
      maxRetainedBytes: 4096,
    }),
  );
  const rejected = await call({
    action: "file-execute",
    remoteMarker: marker(),
    request: {
      action: "write",
      path: "../outside.dat",
      expected: { exists: false },
      bytesBase64: "",
    },
  });
  assert.equal(rejected.state, "failed");
  assert.equal(rejected.value.code, "CODESPACE_FILE_REJECTED");
  const running = marker();
  assert.equal(
    (
      await call({
        action: "execute",
        remoteMarker: running,
        argv: ["node", "-e", "setInterval(()=>{},1000)"],
        stdin: "",
        timeoutMs: 30_000,
        maxStdoutBytes: 1024,
        maxStderrBytes: 1024,
        maxRetainedBytes: 65536,
      })
    ).state,
    "running",
  );
  const cancelled = await call({ action: "cancel", remoteMarker: running });
  assert.equal(cancelled.state, "cancelled");
  console.log(
    "Guest image compatibility passed: execution, stdin, binary files, persistent sessions and cancellation.",
  );
  console.log(
    "Prepared broker-origin repository uses the production binding routine; mismatched repository and escaped file path are refused.",
  );
  console.log(
    "This container-only check does not validate complete network bootstrap, sbx microVM or host-network isolation.",
  );
} finally {
  if (container && /^[a-f0-9]{64}$/.test(container)) await docker(["rm", "--force", container]);
}
