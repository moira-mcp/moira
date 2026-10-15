const { spawn, spawnSync } = require("node:child_process");
const { randomUUID, createHash } = require("node:crypto");
const { once } = require("node:events");
const {
  mkdtempSync,
  mkdirSync,
  realpathSync,
  statSync,
  rmSync,
  readFileSync,
  writeFileSync,
  existsSync,
  symlinkSync,
} = require("node:fs");
const { request } = require("node:http");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const { pathToFileURL } = require("node:url");

const serviceUrl = pathToFileURL(resolve("packages/workspace-service/src/server.mjs")).href;

function createFixture() {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "moira-workspace-service-")));
  const root = join(directory, "project");
  mkdirSync(root);
  const origin = "https://github.com/owner/project.git";
  for (const argv of [
    ["init", root],
    ["-C", root, "remote", "add", "origin", origin],
  ]) {
    const result = spawnSync("git", argv, { encoding: "utf8" });
    if (result.status !== 0) throw new Error(result.stderr);
  }
  const metadata = statSync(root);
  const searchExecutable = spawnSync("which", ["rg"], { encoding: "utf8" }).stdout.trim();
  if (!searchExecutable || spawnSync(searchExecutable, ["--version"]).status !== 0)
    throw new Error("Workspace search fixture requires ripgrep");
  const value = {
    directory,
    root,
    searchExecutable,
    stateRoot: join(directory, "state"),
    socketPath: join(directory, "service.sock"),
    binding: {
      repositoryFullName: "owner/project",
      root,
      origin,
      dev: metadata.dev,
      ino: metadata.ino,
    },
    child: null,
  };
  return value;
}

async function start(value) {
  const child = spawn(process.execPath, ["--input-type=module"], {
    env: {
      ...process.env,
      ...value.environment,
      HOME: value.directory,
      MOIRA_ENVIRONMENT_ID: "service-test",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  value.child = child;
  const errors = (value.diagnostics ??= []);
  child.stderr.on("data", (bytes) => errors.push(bytes));
  const ready = new Promise((resolveReady, reject) => {
    child.stdout.once("data", (bytes) =>
      bytes.toString().trim() === "ready" ? resolveReady() : reject(new Error(bytes.toString())),
    );
    child.once("error", reject);
    child.once("exit", (code) =>
      reject(new Error(`Service exited ${code}: ${Buffer.concat(errors)}`)),
    );
  });
  child.stdin.end(`import {startWorkspaceService} from ${JSON.stringify(serviceUrl)};
    const options=${JSON.stringify({ socketPath: value.socketPath, stateRoot: value.stateRoot, binding: value.binding, searchExecutable: value.searchExecutable, publicationScope: value.publicationScope })};
    const sourceFixture=${JSON.stringify(value.sourceFixture ?? null)};
    if(sourceFixture){const {createSourceOpener}=await import(sourceFixture.moduleUrl);options.sourceOpener=createSourceOpener({socketPath:sourceFixture.socketPath});}
    const pullRequestFixture=${JSON.stringify(value.pullRequestFixture ?? null)};
    if(pullRequestFixture)options.pullRequest=(await import(pullRequestFixture)).pullRequest;
    const service=await startWorkspaceService(options);
    process.on('SIGTERM',async()=>{await service.close();process.exit(0)});process.stdout.write('ready\\n');`);
  await ready;
}

async function stop(value) {
  if (!value.child || value.child.exitCode !== null) return;
  const closed = once(value.child, "exit");
  value.child.kill("SIGTERM");
  await closed;
  value.child = null;
}

async function call(value, method, path, body, headers = {}) {
  return new Promise((done, reject) => {
    const outgoing = request(
      { socketPath: value.socketPath, method, path, headers, agent: false },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.once("error", reject);
        response.once("end", () =>
          done({
            status: response.statusCode,
            bytes: Buffer.concat(chunks),
            headers: response.headers,
          }),
        );
      },
    );
    outgoing.once("error", reject);
    outgoing.end(
      Buffer.isBuffer(body) ? body : body === undefined ? undefined : JSON.stringify(body),
    );
  });
}

async function dispose(value) {
  await stop(value);
  rmSync(value.directory, { recursive: true, force: true });
}
module.exports = { createFixture, start, stop, call, dispose };
