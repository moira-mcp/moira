const { beforeAll, afterEach, expect, test } = require("@jest/globals");
const { execFileSync } = require("node:child_process");
const {
  writeFileSync,
  readFileSync,
  existsSync,
  mkdtempSync,
  realpathSync,
  rmSync,
} = require("node:fs");
const { join } = require("node:path");
const { pathToFileURL } = require("node:url");
const { createFixture, start, call, dispose } = require("../../fixtures/workspace-service.cjs");
let configureOwnerGit, originalGitOrigin, createWorkspaceEngine, createWorkspaceRequestId;
let serveOwnerGit;
const fixtures = [];
const socketDirectories = [];
beforeAll(async () => {
  ({ configureOwnerGit, originalGitOrigin } =
    await import("../../../packages/workspace-service/src/github-config.mjs"));
  ({ createWorkspaceEngine } = await import("../../../packages/workspace-service/src/engine.mjs"));
  ({ createWorkspaceRequestId } =
    await import("../../../packages/shared/src/codespaces/workspace-request-id.ts"));
  ({ serveOwnerGit } = await import("../../../packages/workspace-service/src/github-owner.mjs"));
});
afterEach(async () => {
  try {
    for (const value of fixtures.splice(0)) await dispose(value);
  } finally {
    for (const directory of socketDirectories.splice(0))
      rmSync(directory, { recursive: true, force: true });
  }
});
function fixture() {
  const value = createFixture();
  fixtures.push(value);
  return value;
}
function git(value, ...args) {
  return execFileSync("git", ["-C", value.root, ...args], { encoding: "utf8" }).trim();
}

test("anonymous Git admission has no work expiry and still obeys owner cancellation before transport", async () => {
  const controller = new AbortController();
  controller.abort();
  let disposed = false;
  await expect(
    serveOwnerGit(
      {
        url: "/git/owner/project.git/info/refs?service=git-upload-pack",
        method: "GET",
        headers: {},
      },
      {},
      {
        repositoryFullName: "owner/project",
        allowPush: false,
        signal: controller.signal,
        acquire: async () => ({
          mode: "anonymous",
          repositoryFullName: "owner/project",
          useUntil: null,
          dispose: async () => {
            disposed = true;
          },
        }),
      },
    ),
  ).rejects.toThrow("TLS transport refused");
  expect(disposed).toBe(true);
});

test("owned Git transport retains canonical remote and unchanged life but refuses a foreign effective push mapping", async () => {
  const value = fixture();
  const original = value.binding.origin;
  const broker = "http://resource:capability@127.0.0.1:3437/git/owner/project.git";
  const previousLife = process.env.MOIRA_ENVIRONMENT_ID;
  process.env.MOIRA_ENVIRONMENT_ID ??= "owner-git-binding-test";
  try {
    const engine = createWorkspaceEngine({ stateRoot: value.stateRoot, binding: value.binding });
    const life = await engine.environmentIdentity();
    expect(life).toMatch(/^[a-f0-9]{64}$/);
    await configureOwnerGit(value.root, original, broker);
    expect(await originalGitOrigin(value.root)).toBe(original);
    expect(git(value, "remote", "get-url", "origin")).toBe(broker);
    expect(git(value, "remote", "get-url", "--push", "origin")).toBe(broker);
    const bound = createWorkspaceEngine({
      stateRoot: value.stateRoot,
      binding: { ...value.binding, origin: broker, canonicalOrigin: original },
    });
    expect(await bound.environmentIdentity()).toBe(life);
    await expect(bound.verifyBinding()).resolves.toBeDefined();
    git(value, "config", "--local", "remote.origin.pushurl", broker);
    await expect(bound.verifyBinding()).rejects.toThrow("push URL");
    git(value, "config", "--local", "--unset-all", "remote.origin.pushurl");
    git(
      value,
      "config",
      "--local",
      "url.http://foreign.invalid/repository.git.pushInsteadOf",
      original,
    );
    await expect(bound.verifyBinding()).rejects.toThrow();
    git(
      value,
      "config",
      "--local",
      "--unset-all",
      "url.http://foreign.invalid/repository.git.pushInsteadOf",
    );
    git(value, "config", "--local", "--add", `url.${broker}.insteadOf`, original);
    expect(git(value, "remote", "get-url", "origin")).toBe(broker);
    await expect(bound.verifyBinding()).rejects.toThrow("rewrite authority");
  } finally {
    if (previousLife === undefined) delete process.env.MOIRA_ENVIRONMENT_ID;
    else process.env.MOIRA_ENVIRONMENT_ID = previousLife;
  }
});

test.each(["foreign", "self-shadow"])(
  "existing %s URL rewrite refuses owner installation before replacing repository config",
  async (kind) => {
    const value = fixture();
    git(
      value,
      "config",
      "--local",
      `url.${kind === "foreign" ? "http://foreign.invalid/repository.git" : value.binding.origin}.insteadOf`,
      value.binding.origin,
    );
    const before = readFileSync(join(value.root, ".git/config"));
    await expect(
      configureOwnerGit(value.root, value.binding.origin, "http://broker.invalid/repository.git"),
    ).rejects.toThrow("transport changed");
    expect(readFileSync(join(value.root, ".git/config"))).toEqual(before);
  },
);

test("original PR create identity collects the retained owner result across replay and refuses changed input", async () => {
  const value = fixture();
  const effect = join(value.directory, "vendor-calls");
  const module = join(value.directory, "pull-request-fixture.mjs");
  writeFileSync(
    module,
    `import {appendFile} from 'node:fs/promises';export async function pullRequest(action,input){await appendFile(${JSON.stringify(effect)},action+'\\n');return {pull_request:{number:7,url:'https://github.com/owner/project/pull/7',state:'open',title:input.title,head:input.head,base:input.base,draft:false}}}`,
  );
  value.pullRequestFixture = pathToFileURL(module).href;
  await start(value);
  const requestId = createWorkspaceRequestId();
  const request = { request_id: requestId, head: "work", base: "main", title: "Owner PR" };
  const send = async (input) =>
    call(
      value,
      "POST",
      "/v1/tools",
      { action: "pull_request_create", request: input },
      { "content-type": "application/json" },
    );
  const created = await send(request);
  expect(created.status).toBe(200);
  const result = JSON.parse(created.bytes.toString()).structuredContent;
  expect(result).toMatchObject({
    request_id: requestId,
    state: "succeeded",
    pull_request: { number: 7 },
  });
  const collected = JSON.parse(
    (await send({ request_id: requestId })).bytes.toString(),
  ).structuredContent;
  expect(collected).toEqual(result);
  expect(JSON.parse((await send(request)).bytes.toString()).structuredContent).toEqual(result);
  expect(readFileSync(effect, "utf8")).toBe("pull_request_create\n");
  const conflict = JSON.parse((await send({ ...request, title: "Other intent" })).bytes.toString());
  expect(conflict.structuredContent.error.code).toBe("REQUEST_ID_CONFLICT");
  expect(readFileSync(effect, "utf8")).toBe("pull_request_create\n");
});

test.each([false, true])(
  "PR broker connection proof distinguishes absent dispatch from lost reply (connected: %s)",
  async (connected) => {
    const value = fixture();
    const effect = join(value.directory, "physical-dispatch");
    const socketDirectory = realpathSync(mkdtempSync("/tmp/moira-pr-"));
    socketDirectories.push(socketDirectory);
    const brokerSocket = join(socketDirectory, "broker.sock");
    const module = join(value.directory, "broker-socket-fixture.mjs");
    const brokerUrl = pathToFileURL(
      join(process.cwd(), "packages/workspace-service/src/github-broker.mjs"),
    ).href;
    writeFileSync(
      module,
      `
    import http from 'node:http';import {once} from 'node:events';import {appendFile} from 'node:fs/promises';import {syncBuiltinESMExports} from 'node:module';
    const socketPath=${JSON.stringify(brokerSocket)};
    if(${connected}){const server=http.createServer(request=>{request.resume();request.once('end',()=>{void appendFile(${JSON.stringify(effect)},'dispatch\\n').then(()=>request.socket.destroy())})});server.listen(socketPath);await once(server,'listening')}
    const original=http.request;http.request=function(options,...args){if(options.hostname==='127.0.0.1'&&options.port===3437){const{hostname,port,...rest}=options;return original.call(this,{...rest,socketPath},...args)}return original.call(this,options,...args)};syncBuiltinESMExports();
    const {brokerPullRequest}=await import(${JSON.stringify(brokerUrl)});export const pullRequest=(action,input)=>brokerPullRequest('http://resource:capability@127.0.0.1:3437',action,input);
  `,
    );
    value.pullRequestFixture = pathToFileURL(module).href;
    await start(value);
    const requestId = createWorkspaceRequestId();
    const request = { request_id: requestId, head: "work", base: "main", title: "Socket proof" };
    const send = async (input) =>
      JSON.parse(
        (
          await call(
            value,
            "POST",
            "/v1/tools",
            { action: "pull_request_create", request: input },
            { "content-type": "application/json" },
          )
        ).bytes.toString(),
      ).structuredContent;
    const result = await send(request);
    expect(result).toMatchObject({
      request_id: requestId,
      state: connected ? "unknown" : "not_started",
      reason: connected ? "PULL_REQUEST_OUTCOME_UNKNOWN" : "CODESPACE_PROVIDER_UNAVAILABLE",
    });
    expect(existsSync(effect)).toBe(connected);
    if (connected) expect(readFileSync(effect, "utf8")).toBe("dispatch\n");
    expect(await send({ request_id: requestId })).toEqual(result);
    expect(await send(request)).toEqual(result);
    if (connected) expect(readFileSync(effect, "utf8")).toBe("dispatch\n");
    expect(
      JSON.parse(readFileSync(join(value.stateRoot, "requests", requestId, "result.json"), "utf8")),
    ).toMatchObject({ state: connected ? "unknown" : "not_started" });
  },
);
