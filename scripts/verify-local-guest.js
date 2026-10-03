import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
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
  await docker(["cp", "packages/local/dist/guest-worker.js", `${container}:/tmp/worker.mjs`]);
  await docker(
    [
      "exec",
      "--interactive",
      container,
      "node",
      "-e",
      "const f=require('node:fs');const p=require('node:os').homedir()+'/.local/share/moira-local';f.mkdirSync(p,{recursive:true});f.mkdirSync('/workspaces/project');f.writeFileSync(p+'/environment.json',JSON.stringify(JSON.parse(f.readFileSync(0,'utf8'))));",
    ],
    JSON.stringify({
      HTTP_PROXY: "http://127.0.0.1:1",
      HTTPS_PROXY: "http://127.0.0.1:1",
      http_proxy: "http://127.0.0.1:1",
      https_proxy: "http://127.0.0.1:1",
      NO_PROXY: "localhost",
      no_proxy: "localhost",
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
    return Buffer.from(result.stdout, "base64").toString();
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
    file: {
      kind: "write",
      path: "binary.dat",
      expected: { exists: false },
      content: bytes.toString("base64"),
    },
  });
  assert.equal(written.state, "succeeded");
  const read = await call({
    action: "file-execute",
    remoteMarker: marker(),
    file: { kind: "read", path: "binary.dat", offset: 0, length: 64 },
  });
  assert.deepEqual(Buffer.from(read.bytes, "base64"), bytes);
  await command({
    script: "export MOIRA_LOCAL_CHECK=retained; cd /workspaces/project",
    session: "local-check",
    sessionStart: true,
  });
  assert.equal(
    await command({ script: "printf '%s' \"$MOIRA_LOCAL_CHECK\"", session: "local-check" }),
    "retained",
  );
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
  console.log("This container-only check does not validate sbx microVM or host-network isolation.");
} finally {
  if (container && /^[a-f0-9]{64}$/.test(container)) await docker(["rm", "--force", container]);
}
