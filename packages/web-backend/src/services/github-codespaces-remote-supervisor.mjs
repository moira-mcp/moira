import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";

const VERSION = 1;
const MAX_CONTROL_BYTES = 4 * 1024 * 1024;
const MAX_RESULT_BYTES = 8 * 1024 * 1024;
const MARKER = /^moira-op-[a-f0-9]{32}$/;
const REPOSITORY = /^[A-Za-z0-9_.-]{1,100}\/([A-Za-z0-9_.-]{1,100})$/;
const TERMINAL = new Set(["succeeded", "failed", "cancelled", "timed_out"]);
const STATE_ROOT = process.env.MOIRA_OPERATION_STATE_DIR
  ? resolve(process.env.MOIRA_OPERATION_STATE_DIR)
  : join(homedir(), ".local", "state", "moira", "operations");
const WORKSPACES_ROOT = resolve(process.env.MOIRA_WORKSPACES_ROOT || "/workspaces");

function fail(message) {
  throw new Error(message);
}

function operationDirectory(marker) {
  if (!MARKER.test(marker)) fail("invalid operation marker");
  return join(STATE_ROOT, marker);
}

function validateBase(request) {
  if (!request || request.version !== VERSION || !MARKER.test(request.remoteMarker ?? "")) {
    fail("invalid supervisor request");
  }
  return operationDirectory(request.remoteMarker);
}

function validateExecution(request) {
  const match = request.repositoryFullName?.match(REPOSITORY);
  if (
    !match ||
    !Array.isArray(request.argv) ||
    request.argv.length < 1 ||
    request.argv.length > 128 ||
    request.argv.some(
      (value) =>
        typeof value !== "string" || !value || value.length > 16_384 || value.includes("\0"),
    ) ||
    typeof request.cwd !== "string" ||
    Buffer.byteLength(request.cwd, "utf8") > 4096 ||
    request.cwd.startsWith("/") ||
    (request.cwd !== "." &&
      request.cwd.split("/").some((part) => !part || part === "." || part === "..")) ||
    typeof request.stdin !== "string" ||
    !Number.isSafeInteger(request.timeoutMs) ||
    request.timeoutMs < 1 ||
    request.timeoutMs > 15 * 60_000 ||
    !Number.isSafeInteger(request.maxStdoutBytes) ||
    request.maxStdoutBytes < 1 ||
    request.maxStdoutBytes > MAX_RESULT_BYTES ||
    !Number.isSafeInteger(request.maxStderrBytes) ||
    request.maxStderrBytes < 1 ||
    request.maxStderrBytes > MAX_RESULT_BYTES
  ) {
    fail("invalid execution request");
  }
  const stdin = Buffer.from(request.stdin, "base64");
  if (stdin.toString("base64") !== request.stdin || stdin.length > MAX_CONTROL_BYTES) {
    fail("invalid execution input");
  }
  return { repositoryName: match[1], stdin };
}

async function verifyRepository(request, repositoryName) {
  const root = join(WORKSPACES_ROOT, repositoryName);
  const value = await stat(root);
  if (!value.isDirectory() || value.uid === 0) fail("invalid workspace repository");
  const result = await capture("/usr/bin/git", [
    "-c",
    `safe.directory=${root}`,
    "-C",
    root,
    "remote",
    "get-url",
    "origin",
  ]);
  const normalized = result.stdout
    .trim()
    .replace(/^git@github\.com:/, "")
    .replace(/^https:\/\/github\.com\//, "")
    .replace(/\.git$/, "")
    .toLowerCase();
  if (normalized !== request.repositoryFullName.toLowerCase()) fail("repository identity mismatch");
  const cwd = resolve(root, request.cwd);
  if (cwd !== root && !cwd.startsWith(`${root}${sep}`)) fail("working directory escaped workspace");
  await access(cwd, constants.R_OK | constants.X_OK);
  return cwd;
}

function capture(executable, argv) {
  return new Promise((resolveValue, reject) => {
    const child = spawn(executable, argv, {
      env: { PATH: process.env.PATH, HOME: homedir(), LANG: "C.UTF-8", LC_ALL: "C.UTF-8" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    let size = 0;
    child.stdout.on("data", (chunk) => {
      size += chunk.length;
      if (size > 64 * 1024) child.kill("SIGKILL");
      else stdout.push(Buffer.from(chunk));
    });
    child.stderr.on("data", (chunk) => {
      size += chunk.length;
      if (size > 64 * 1024) child.kill("SIGKILL");
      else stderr.push(Buffer.from(chunk));
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code !== 0) reject(new Error("control command failed"));
      else
        resolveValue({
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8"),
        });
    });
  });
}

const RUNNER = String.raw`
const {spawn}=require("node:child_process");
const {access,readFile,rename,writeFile}=require("node:fs/promises");
(async()=>{let raw="";for await(const chunk of process.stdin)raw+=chunk;const input=JSON.parse(raw);const out=[];const err=[];let stdoutBytes=0;let stderrBytes=0;let terminal=false;let outputExceeded=false;let timedOut=false;
let runnerStartTime=null;if(process.platform==="linux"){const value=await readFile('/proc/self/stat','utf8');runnerStartTime=value.slice(value.lastIndexOf(') ')+2).split(' ')[19]??null;if(!/^[0-9]+$/.test(runnerStartTime))throw new Error("invalid runner start time")}
await writeFile(input.runnerPidPath,JSON.stringify({pid:process.pid,startTime:runnerStartTime}),{mode:0o600});
const child=spawn(input.argv[0],input.argv.slice(1),{cwd:input.cwd,env:process.env,detached:true,stdio:["pipe","pipe","pipe"]});
let startTime=null;if(process.platform==="linux"){try{const value=await readFile('/proc/'+child.pid+'/stat','utf8');startTime=value.slice(value.lastIndexOf(') ')+2).split(' ')[19]??null;if(!/^[0-9]+$/.test(startTime))throw new Error("invalid process start time")}catch(error){try{process.kill(-child.pid,"SIGKILL")}catch{}throw error}}
await writeFile(input.pidPath,JSON.stringify({pid:child.pid,startTime}),{mode:0o600});
const collect=(target,stream)=>(chunk)=>{if(stream==="stdout")stdoutBytes+=chunk.length;else stderrBytes+=chunk.length;const limit=stream==="stdout"?input.maxStdoutBytes:input.maxStderrBytes;if((stream==="stdout"?stdoutBytes:stderrBytes)>limit){outputExceeded=true;try{process.kill(-child.pid,"SIGKILL")}catch{}}else target.push(Buffer.from(chunk));};
child.stdout.on("data",collect(out,"stdout"));child.stderr.on("data",collect(err,"stderr"));child.stdin.end(Buffer.from(input.stdin,"base64"));
const timer=setTimeout(()=>{if(terminal)return;timedOut=true;try{process.kill(-child.pid,"SIGKILL")}catch{}},input.timeoutMs);timer.unref();
child.once("close",async(code,signal)=>{terminal=true;clearTimeout(timer);let cancelled=false;try{await access(input.cancelPath);cancelled=true}catch{}
const state=cancelled?"cancelled":outputExceeded?"failed":timedOut?"timed_out":code===0?"succeeded":"failed";
const stderr=outputExceeded?Buffer.from("output limit exceeded"):Buffer.concat(err);
await writeFile(input.resultTempPath,JSON.stringify({state,stdout:Buffer.concat(out).toString("base64"),stderr:stderr.toString("base64"),exitCode:Number.isInteger(code)?code:null}),{mode:0o600});await rename(input.resultTempPath,input.resultPath);});
})().catch(async()=>{process.exitCode=1});`;

async function execute(request) {
  const directory = validateBase(request);
  const { repositoryName } = validateExecution(request);
  const cwd = await verifyRepository(request, repositoryName);
  await mkdir(dirname(directory), { recursive: true, mode: 0o700 });
  await mkdir(directory, { mode: 0o700 });
  const pidPath = join(directory, "pid");
  const runnerPidPath = join(directory, "runner-pid");
  const resultPath = join(directory, "result.json");
  const resultTempPath = join(directory, "result.tmp");
  const cancelPath = join(directory, "cancel-requested");
  const runner = spawn(process.execPath, ["-e", RUNNER], {
    detached: true,
    stdio: ["pipe", "ignore", "ignore"],
    env: process.env,
  });
  runner.stdin.end(
    JSON.stringify({
      argv: request.argv,
      cwd,
      stdin: request.stdin,
      timeoutMs: request.timeoutMs,
      maxStdoutBytes: request.maxStdoutBytes,
      maxStderrBytes: request.maxStderrBytes,
      pidPath,
      runnerPidPath,
      resultPath,
      resultTempPath,
      cancelPath,
    }),
  );
  runner.unref();
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      await access(pidPath, constants.R_OK);
      break;
    } catch {
      await new Promise((resolveValue) => setTimeout(resolveValue, 25));
    }
  }
  await access(pidPath, constants.R_OK);
  return { state: "running" };
}

async function readResult(directory) {
  try {
    const value = JSON.parse(await readFile(join(directory, "result.json"), "utf8"));
    if (!TERMINAL.has(value.state)) fail("invalid operation result");
    return {
      state: value.state,
      stdoutBase64: value.stdout,
      stderrBase64: value.stderr,
      exitCode: Number.isInteger(value.exitCode) ? value.exitCode : null,
    };
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    return null;
  }
}

async function linuxStartTime(pid) {
  try {
    const value = await readFile(`/proc/${pid}/stat`, "utf8");
    return value.slice(value.lastIndexOf(") ") + 2).split(" ")[19] ?? null;
  } catch {
    return null;
  }
}

async function processExists(identity) {
  const { pid, startTime } = identity;
  try {
    process.kill(pid, 0);
    return startTime === null || (await linuxStartTime(pid)) === startTime;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

async function readProcessIdentity(directory, fileName = "pid") {
  const value = JSON.parse(await readFile(join(directory, fileName), "utf8"));
  if (!Number.isSafeInteger(value.pid) || value.pid <= 1)
    fail("invalid operation process identity");
  if (process.platform === "linux" && value.startTime === null) {
    fail("operation process start time is required on Linux");
  }
  if (value.startTime !== null && !/^[0-9]+$/.test(value.startTime)) {
    fail("invalid operation process start time");
  }
  return value;
}

async function readOptionalProcessIdentity(directory, fileName) {
  try {
    return await readProcessIdentity(directory, fileName);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function inspect(request) {
  const directory = validateBase(request);
  try {
    await access(directory, constants.R_OK);
    const result = await readResult(directory);
    if (result) return result;
    const identity = await readOptionalProcessIdentity(directory, "pid");
    if (identity && (await processExists(identity))) return { state: "running" };
    const runnerIdentity = await readOptionalProcessIdentity(directory, "runner-pid");
    if (runnerIdentity && (await processExists(runnerIdentity))) return { state: "running" };
    const publishedAfterRunnerExit = await readResult(directory);
    if (publishedAfterRunnerExit) return publishedAfterRunnerExit;
    return {
      state: "failed",
      stdoutBase64: "",
      stderrBase64: Buffer.from("operation supervisor exited without a result").toString("base64"),
      exitCode: null,
    };
  } catch (error) {
    if (error?.code === "ENOENT") return { state: "absent" };
    throw error;
  }
}

async function cancel(request) {
  const directory = validateBase(request);
  const current = await inspect(request);
  if (current.state !== "running") return current;
  const identity = await readProcessIdentity(directory);
  const { pid } = identity;
  await writeFile(join(directory, "cancel-requested"), "1", { mode: 0o600 });
  try {
    process.kill(-pid, "SIGTERM");
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
  await new Promise((resolveValue) => setTimeout(resolveValue, 250));
  if (await processExists(identity)) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch (error) {
      if (error?.code !== "ESRCH") throw error;
    }
  }
  await new Promise((resolveValue) => setTimeout(resolveValue, 100));
  if (await processExists(identity)) return { state: "running" };
  const result = { state: "cancelled", stdoutBase64: "", stderrBase64: "", exitCode: null };
  await writeFile(join(directory, "result.json"), JSON.stringify(result), { mode: 0o600 });
  return result;
}

async function finalize(request) {
  const directory = validateBase(request);
  const current = await inspect(request);
  if (current.state === "running") fail("operation is still running");
  await rm(directory, { recursive: true, force: true });
  return { state: "absent" };
}

export async function runRequest(request) {
  if (request.action === "execute") return execute(request);
  if (request.action === "inspect") return inspect(request);
  if (request.action === "cancel") return cancel(request);
  if (request.action === "finalize") return finalize(request);
  fail("unsupported supervisor action");
}

export async function runEncoded(encoded) {
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.length > MAX_CONTROL_BYTES) fail("request too large");
  const result = await runRequest(JSON.parse(bytes.toString("utf8")));
  process.stdout.write(JSON.stringify({ ok: true, result }));
}
