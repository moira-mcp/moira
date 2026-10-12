import { afterEach, describe, expect, test } from "@jest/globals";
import { CODESPACE_CONNECTOR_LIMITS } from "@mcp-moira/shared";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:https";
import type { ChildProcess } from "node:child_process";
import type { Duplex } from "node:stream";
import {
  existsSync,
  closeSync,
  fsyncSync,
  ftruncateSync,
  linkSync,
  mkdtempSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const supervisorPath = resolve(
  process.cwd(),
  "packages/web-backend/src/services/github-codespaces-remote-supervisor.mjs",
);
const directories: string[] = [];
const children = new Set<ChildProcess>();
const tlsClosures = new Set<() => Promise<void>>();

function parentIdentity(path: string) {
  const value = statSync(path, { bigint: true });
  return { parentDev: value.dev.toString(), parentIno: value.ino.toString() };
}

function regularIdentity(path: string) {
  const value = statSync(path, { bigint: true });
  return Object.fromEntries(
    ["dev", "ino", "nlink", "size", "mtimeNs", "ctimeNs", "birthtimeNs"].map((key) => [
      key,
      String(value[key as keyof typeof value]),
    ]),
  );
}

function processStartTime(pid: number): string | null {
  if (process.platform !== "linux") return null;
  const value = readFileSync(`/proc/${pid}/stat`, "utf8");
  return value.slice(value.lastIndexOf(") ") + 2).split(" ")[19] ?? null;
}

afterEach(async () => {
  for (const close of [...tlsClosures]) await close();
  for (const directory of directories) {
    const state = join(directory, "state");
    if (!existsSync(state)) continue;
    for (const marker of readdirSync(state).filter((name) =>
      /^moira-op-[a-f0-9]{32}$/.test(name),
    )) {
      try {
        const owner = JSON.parse(readFileSync(join(state, marker, "file-runner-pid"), "utf8"));
        const belongs =
          process.platform === "linux"
            ? owner.startTime !== null && processStartTime(owner.pid) === owner.startTime
            : spawnSync("ps", ["-p", String(owner.pid), "-o", "command="], {
                encoding: "utf8",
              }).stdout.includes(
                `${join(directory, "home/.local/share/moira-files/client.mjs")} operation ${marker}`,
              );
        if (belongs) process.kill(-owner.pid, "SIGKILL");
      } catch (error) {
        if (!["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
      }
    }
  }
  const owned = [...children];
  const closed = owned.map(
    (child) => new Promise<void>((done) => child.once("close", () => done())),
  );
  for (const child of owned) child.kill("SIGKILL");
  await Promise.all(closed);
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "moira-direct-supervisor-"));
  directories.push(directory);
  const codespacesRoot = join(directory, "codespaces");
  const repository = join(codespacesRoot, "repository");
  const home = join(directory, "home");
  const stateRoot = join(directory, "state");
  mkdirSync(repository, { recursive: true });
  mkdirSync(home);
  for (const argv of [
    ["init", "--initial-branch=main", repository],
    ["-C", repository, "remote", "add", "origin", "https://github.com/owner/repository.git"],
  ]) {
    const result = spawnSync("git", argv, { encoding: "utf8" });
    if (result.status !== 0) throw new Error(result.stderr);
  }
  return {
    environment: {
      ...process.env,
      HOME: home,
      MOIRA_CODESPACES_ROOT: codespacesRoot,
      MOIRA_OPERATION_STATE_DIR: stateRoot,
    },
    stateRoot,
    repository,
  };
}

async function transferFixture() {
  const value = fixture();
  const home = value.environment.HOME!;
  const directory = join(home, ".local/share/moira-files");
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, "client.mjs"),
    readFileSync(join(process.cwd(), "packages/web-backend/dist/guest-assets/guest-files-cli.js")),
    { mode: 0o700 },
  );
  const certificate = join(directory, "certificate.pem");
  const key = join(directory, "key.pem");
  const generated = spawnSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      key,
      "-out",
      certificate,
      "-days",
      "1",
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=IP:127.0.0.1",
    ],
    { encoding: "utf8" },
  );
  if (generated.status !== 0) throw new Error(generated.stderr);
  const identity = createHash("sha256")
    .update(
      process.platform === "linux"
        ? `${readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim()}|${processStartTime(1)}`
        : "override:transfer-life",
    )
    .digest("hex");
  const origin = "https://127.0.0.1:3099";
  const capability = "t".repeat(43);
  const bootstrap = "b".repeat(43);
  const records = new Map<string, any>();
  let privateBytes: Buffer = Buffer.alloc(0);
  const controls: {
    dropPut: boolean;
    dropFinalize: boolean;
    dropGetOffset: number | null;
    holdChunk?: Promise<void>;
    beforeFinalize?: () => void;
    httpFailure?: "http" | "reset" | "overflow";
  } = {
    dropPut: false,
    dropFinalize: false,
    dropGetOffset: null,
  };
  let maximumBody = 0;
  let chunkStarted!: () => void;
  const firstChunk = new Promise<void>((done) => {
    chunkStarted = done;
  });
  const observedGets: number[] = [];
  const status = (record: any) => ({
    transferId: record.descriptor.transferId,
    requestId: record.descriptor.requestId,
    state: record.ready ? "ready" : "reserved",
    offset: record.offset,
    size: record.descriptor.size,
    sha256: record.descriptor.sha256,
    ...(record.receipt ? { receipt: record.receipt } : {}),
  });
  const create = (input: any) => {
    const existing = records.get(input.requestId);
    if (existing) return existing;
    const descriptor = {
      version: 1,
      transferId: randomUUID(),
      requestId: input.requestId,
      direction: input.direction,
      size: input.size ?? privateBytes.length,
      sha256: input.sha256 ?? createHash("sha256").update(privateBytes).digest("hex"),
      mimeType: input.mimeType ?? "application/octet-stream",
      chunkBytes: 262144,
      origin,
      capability,
      environmentIdentity: identity,
      expiresAt: Date.now() + 600_000,
    };
    const record = {
      descriptor,
      offset: input.direction === "server_to_guest" ? descriptor.size : 0,
      chunks: [] as Buffer[],
      ready: input.direction === "server_to_guest",
    };
    records.set(input.requestId, record);
    return record;
  };
  const server = createServer(
    { key: readFileSync(key), cert: readFileSync(certificate) },
    async (incoming, response) => {
      try {
        if (controls.httpFailure === "reset") {
          response.destroy();
          return;
        }
        if (controls.httpFailure === "http") {
          response.writeHead(503, { "x-private": "private-header-sentinel" });
          response.end("private-body-sentinel");
          return;
        }
        if (controls.httpFailure === "overflow") {
          response.writeHead(200);
          response.end("private-body-sentinel".repeat(4000));
          return;
        }
        const url = new URL(incoming.url!, origin);
        const chunks: Buffer[] = [];
        let length = 0;
        for await (const chunk of incoming) {
          length += chunk.length;
          if (length > 262144) throw new Error("fixture HTTP chunk bound");
          chunks.push(Buffer.from(chunk));
        }
        maximumBody = Math.max(maximumBody, length);
        const body = Buffer.concat(chunks, length);
        const json = (result: unknown) => {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify(result));
        };
        if (
          ["/api/public/codespace-files/transfers", "/api/public/codespace-files/lookup"].includes(
            url.pathname,
          )
        ) {
          if (incoming.headers.authorization !== `Bearer ${bootstrap}`)
            throw new Error("bootstrap refused");
          const input = JSON.parse(body.toString("utf8"));
          if (url.pathname.endsWith("lookup")) return json(status(records.get(input.requestId)));
          const record = create(input);
          return json({ descriptor: record.descriptor, status: status(record) });
        }
        if (incoming.headers.authorization !== `Bearer ${capability}`)
          throw new Error("transfer refused");
        const record: any = [...records.values()].find(
          (item) => item.descriptor.transferId === url.pathname.split("/")[5],
        );
        if (!record) throw new Error("missing transfer");
        if (url.pathname.endsWith("/chunks")) {
          chunkStarted();
          await controls.holdChunk;
          const offset = Number(url.searchParams.get("offset"));
          const selectedLength = Number(url.searchParams.get("length"));
          if (incoming.method === "PUT") {
            if (
              offset !== record.offset ||
              selectedLength !== body.length ||
              createHash("sha256").update(body).digest("hex") !== incoming.headers["x-chunk-sha256"]
            )
              throw new Error("changed chunk");
            record.chunks.push(body);
            record.offset += body.length;
            if (controls.dropPut) {
              controls.dropPut = false;
              response.destroy();
              return;
            }
            return json(status(record));
          }
          observedGets.push(offset);
          const selected = privateBytes.subarray(offset, offset + selectedLength);
          response.writeHead(200, {
            "content-length": selected.length,
            "x-chunk-offset": offset,
            "x-chunk-sha256": createHash("sha256").update(selected).digest("hex"),
          });
          if (controls.dropGetOffset === offset) {
            controls.dropGetOffset = null;
            response.write(selected.subarray(0, 4));
            response.destroy();
            return;
          }
          response.end(selected);
          return;
        }
        if (url.pathname.endsWith("/finalize")) {
          controls.beforeFinalize?.();
          if (record.descriptor.direction === "guest_to_server")
            privateBytes = Buffer.concat(record.chunks);
          if (
            privateBytes.length !== record.descriptor.size ||
            createHash("sha256").update(privateBytes).digest("hex") !== record.descriptor.sha256
          )
            throw new Error("whole digest");
          record.ready = true;
          record.receipt = {
            transferId: record.descriptor.transferId,
            state: "ready",
            referenceId: "private-reference",
            fileName: "artifact.bin",
            mimeType: record.descriptor.mimeType,
            size: privateBytes.length,
            sha256: record.descriptor.sha256,
            expiresAt: Date.now() + 600_000,
          };
          if (controls.dropFinalize) {
            controls.dropFinalize = false;
            response.destroy();
            return;
          }
          return json(record.receipt);
        }
        json(status(record));
      } catch {
        response.writeHead(400).end();
      }
    },
  );
  const sockets = new Set<Duplex>();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  const close = async () => {
    tlsClosures.delete(close);
    await new Promise<void>((done) => {
      server.close(() => done());
      server.closeAllConnections();
      for (const socket of sockets) socket.destroy();
    });
  };
  tlsClosures.add(close);
  await new Promise<void>((done, reject) => {
    server.once("error", reject);
    server.listen(3099, "127.0.0.1", done);
  });
  writeFileSync(
    join(directory, "config.json"),
    JSON.stringify({
      version: 1,
      origin,
      bootstrapCapability: bootstrap,
      environmentIdentity: identity,
      resourceId: "11111111-1111-4111-8111-111111111111",
      repositoryFullName: "owner/repository",
    }),
  );
  return {
    ...value,
    environment: {
      ...value.environment,
      MOIRA_ENVIRONMENT_ID: "transfer-life",
      CURL_CA_BUNDLE: certificate,
      NO_PROXY: "127.0.0.1",
      no_proxy: "127.0.0.1",
    },
    create,
    records,
    get privateBytes() {
      return privateBytes;
    },
    set privateBytes(bytes: Buffer) {
      privateBytes = bytes;
    },
    controls,
    firstChunk,
    get maximumBody() {
      return maximumBody;
    },
    observedGets,
    close,
  };
}

function client(
  environment: NodeJS.ProcessEnv,
  args: string[],
): Promise<{ code: number; lines: any[]; stderr: string }> {
  return new Promise((done, reject) => {
    const child = spawn(
      process.execPath,
      [join(process.cwd(), "packages/web-backend/dist/guest-assets/guest-files-cli.js"), ...args],
      { env: environment, stdio: ["ignore", "pipe", "pipe"] },
    );
    children.add(child);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
      if (Buffer.byteLength(stderr) > 4096) {
        child.kill("SIGKILL");
        reject(new Error("File client diagnostic exceeded its bound"));
      }
    });
    child.once("error", reject);
    child.once("close", (code) => {
      children.delete(child);
      done({
        code: code ?? -1,
        stderr,
        lines: stdout
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line)),
      });
    });
  });
}

async function collectFile(environment: NodeJS.ProcessEnv, marker: string, digest?: string) {
  for (let attempt = 0; attempt < 160; attempt++) {
    const result = (await request(environment, {
      action: "file-inspect",
      version: 1,
      remoteMarker: marker,
      ...(digest ? { requestDigest: digest } : {}),
    })) as any;
    if (result.state !== "running") return result;
    await new Promise<void>((done) => setTimeout(done, 25));
  }
  throw new Error("file transfer did not settle");
}

async function waitForFileRunnerExit(stateRoot: string, marker: string) {
  const path = join(stateRoot, marker, "file-runner-pid");
  for (let attempt = 0; attempt < 160; attempt++) {
    const owner = JSON.parse(readFileSync(path, "utf8"));
    try {
      process.kill(owner.pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
      throw error;
    }
    await new Promise<void>((done) => setTimeout(done, 25));
  }
  throw new Error("transfer runner did not exit");
}

/**
 * Make what is stored look as if an earlier life of the environment wrote it.
 *
 * The environment's identity comes from the running Linux kernel wherever those sources exist, so a
 * test cannot move the environment to another life by setting a variable — on Linux the variable is
 * deliberately powerless. What a test can do is state the other half of the comparison: that the
 * stored file was written by a life that is not this one, which is exactly the situation the
 * behaviour is about, and it reads the same on every platform.
 */
function storeForeignLife(path: string): void {
  const foreign = "0".repeat(64);
  const raw = readFileSync(path, "utf8");
  if (!raw.trimStart().startsWith("{")) {
    writeFileSync(path, foreign, { mode: 0o600 });
    return;
  }
  const stored = JSON.parse(raw) as Record<string, unknown>;
  stored.environment = foreign;
  writeFileSync(path, `${JSON.stringify(stored)}\n`, { mode: 0o600 });
}

function request(
  environment: NodeJS.ProcessEnv,
  value: Record<string, unknown>,
  transformSource?: (source: string) => string,
  completionBoundMs?: number,
): Promise<unknown> {
  const source = readFileSync(supervisorPath, "utf8");
  const supervisor = transformSource ? transformSource(source) : source;
  const encoded = Buffer.from(JSON.stringify(value)).toString("base64");
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, ["--input-type=module"], {
      env: environment,
      stdio: ["pipe", "pipe", "pipe"],
    });
    children.add(child);
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const timer =
      completionBoundMs === undefined
        ? undefined
        : setTimeout(() => {
            let state = "no receipt";
            try {
              state = JSON.parse(Buffer.concat(stdout).toString("utf8")).result.state;
            } catch {
              // A missing or partial frame is itself the diagnostic observation.
            }
            child.kill("SIGKILL");
            reject(new Error(`supervisor process did not close after admission: ${state}`));
          }, completionBoundMs);
    child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
    child.once("error", reject);
    child.once("close", (code) => {
      clearTimeout(timer);
      children.delete(child);
      if (code !== 0) {
        reject(new Error(Buffer.concat(stderr).toString("utf8")));
        return;
      }
      const envelope = JSON.parse(Buffer.concat(stdout).toString("utf8"));
      const result = envelope.result as Record<string, unknown>;
      resolveResult(
        typeof result?.stdoutBase64 === "string" && typeof result?.stderrBase64 === "string"
          ? {
              ...result,
              stdout: Buffer.from(result.stdoutBase64, "base64").toString("utf8"),
              stderr: Buffer.from(result.stderrBase64, "base64").toString("utf8"),
              stdoutBase64: undefined,
              stderrBase64: undefined,
            }
          : result,
      );
    });
    child.stdin.end(`${supervisor}\nawait runEncoded("${encoded}");\n`);
  });
}

async function inspectUntilTerminal(
  environment: NodeJS.ProcessEnv,
  remoteMarker: string,
): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < 80; attempt++) {
    const result = (await request(environment, {
      action: "inspect",
      version: 1,
      remoteMarker,
    })) as Record<string, unknown>;
    if (result.state !== "running") return result;
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  throw new Error("remote operation did not become terminal");
}

describe("direct Codespace operation supervisor", () => {
  test.each(["http", "reset", "overflow", "missing-process", "older-curl"] as const)(
    "installed client preserves uncertainty and emits only safe diagnostics for %s",
    async (failure) => {
      const value = await transferFixture();
      try {
        value.controls.httpFailure =
          failure === "older-curl" ? "http" : failure === "missing-process" ? undefined : failure;
        const environment: NodeJS.ProcessEnv = { ...value.environment };
        if (failure === "missing-process" || failure === "older-curl") {
          const bin = join(value.environment.HOME!, "bin");
          mkdirSync(bin);
          environment.PATH = bin;
          if (failure === "older-curl") {
            const curl = spawnSync("which", ["curl"], { encoding: "utf8" }).stdout.trim();
            writeFileSync(
              join(bin, "curl"),
              `#!${process.execPath}\nconst {spawnSync}=require('node:child_process'),fs=require('node:fs');const args=process.argv.slice(2);process.stderr.write('private-stderr-sentinel '+args.at(-1)+' '+fs.readFileSync(args[args.indexOf('--header')+1].slice(1),'utf8'));if(args.includes('--fail-with-body'))process.exit(2);const result=spawnSync(${JSON.stringify(curl)},args,{stdio:'inherit'});const headers=args[args.indexOf('--dump-header')+1];fs.writeFileSync(headers,['HTTP/1.1 200 Connection Established','X-Private: private-header-sentinel','',''].join(String.fromCharCode(13,10))+fs.readFileSync(headers,'utf8'));process.exit(result.status??1);`,
              { mode: 0o700 },
            );
          }
        }
        const result = await client(environment, ["status", randomUUID()]);
        expect(result.code).toBe(1);
        expect(result.lines).toEqual([]);
        const error = JSON.parse(result.stderr).error;
        expect(error.code).toBe("TRANSFER_OUTCOME_UNKNOWN");
        expect(error.diagnostic).toEqual(
          failure === "http" || failure === "older-curl"
            ? { kind: "http", httpStatus: 503, processExitCode: 22 }
            : failure === "reset"
              ? { kind: "transport", processExitCode: 52 }
              : { kind: failure === "overflow" ? "response_limit" : "process" },
        );
        expect(result.stderr).not.toMatch(/private-|127\.0\.0\.1|Bearer|tttttttt|bbbbbbbb/);
        expect(Object.keys(error)).toEqual(["code", "diagnostic"]);
      } finally {
        await value.close();
      }
    },
  );
  test.each(["guard changed", "reply lost"])(
    "guarded native target settles %s without a second effect",
    async (mode) => {
      const value = await transferFixture();
      try {
        const bytes = Buffer.alloc(512 * 1024 + 3, 70);
        value.privateBytes = bytes;
        const record = value.create({ requestId: randomUUID(), direction: "server_to_guest" });
        const target = join(value.repository, "guarded-transfer.bin");
        if (mode === "guard changed")
          value.controls.beforeFinalize = () => {
            writeFileSync(target, "external winner");
          };
        else {
          const clientPath = join(value.environment.HOME!, ".local/share/moira-files/client.mjs");
          const source = readFileSync(clientPath, "utf8");
          const boundary = "await commitStaged([staged], marker, directory);\n      const after";
          expect(source).toContain(boundary);
          writeFileSync(
            clientPath,
            source.replace(
              boundary,
              "await commitStaged([staged], marker, directory);\n      throw Object.assign(new Error('fixture receipt unavailable'), {code:'TRANSFER_OUTCOME_UNKNOWN'});\n      const after",
            ),
          );
        }
        const marker = `moira-op-${"4".repeat(32)}`;
        const digest = "b".repeat(64);
        const original = {
          action: "file-execute",
          version: 1,
          remoteMarker: marker,
          repositoryFullName: "owner/repository",
          requestDigest: digest,
          admissionDeadlineAt: Date.now() + 60_000,
          request: {
            action: "upload",
            path: "guarded-transfer.bin",
            expected: { exists: false },
            transfer: record.descriptor,
          },
        };
        expect(await request(value.environment, original)).toMatchObject({ state: "running" });
        await waitForFileRunnerExit(value.stateRoot, marker);
        const inode = statSync(target).ino;
        const observed = value.observedGets.length;
        const result = await collectFile(value.environment, marker, digest);
        if (mode === "guard changed") {
          expect(result).toMatchObject({ state: "failed", value: { reason: "precondition" } });
          expect(readFileSync(target, "utf8")).toBe("external winner");
          expect(readdirSync(value.repository).some((name) => name.endsWith(".tmp"))).toBe(false);
        } else {
          expect(result).toMatchObject({
            state: "succeeded",
            value: {
              action: "upload",
              current: { size: bytes.length, sha256: record.descriptor.sha256 },
            },
          });
          expect(readFileSync(target).equals(bytes)).toBe(true);
          expect(await request(value.environment, original)).toEqual(result);
        }
        expect(statSync(target).ino).toBe(inode);
        expect(value.observedGets.length).toBe(observed);
      } finally {
        await value.close();
      }
    },
    15000,
  );

  test("ambiguous native commit refuses a same-digest foreign target without rolling it back", async () => {
    const value = await transferFixture();
    try {
      value.privateBytes = Buffer.alloc(512 * 1024, 73);
      const record = value.create({ requestId: randomUUID(), direction: "server_to_guest" });
      const marker = `moira-op-${"f2".repeat(16)}`;
      const digest = "c".repeat(64);
      const operation = {
        action: "file-execute",
        version: 1,
        remoteMarker: marker,
        repositoryFullName: "owner/repository",
        requestDigest: digest,
        admissionDeadlineAt: Date.now() + 60_000,
        request: {
          action: "upload",
          path: "ambiguous.bin",
          expected: { exists: false },
          transfer: record.descriptor,
        },
      };
      const cliPath = join(value.environment.HOME!, ".local", "share", "moira-files", "client.mjs");
      const source = readFileSync(cliPath, "utf8");
      const changed = source.replace(
        "await commitStaged([staged], marker, directory);",
        'await commitStaged([staged], marker, directory); throw Object.assign(new Error("lost commit reply"), {code:"TRANSFER_OUTCOME_UNKNOWN"});',
      );
      expect(changed).not.toBe(source);
      writeFileSync(cliPath, changed);
      expect(await request(value.environment, operation)).toMatchObject({ state: "running" });
      await waitForFileRunnerExit(value.stateRoot, marker);
      const target = join(value.repository, "ambiguous.bin");
      const ownedInode = statSync(target).ino;
      renameSync(target, `${target}.pinned`);
      writeFileSync(target, value.privateBytes);
      const foreignInode = statSync(target).ino;
      expect(foreignInode).not.toBe(ownedInode);
      const observed = value.observedGets.length;
      await request(value.environment, { ...operation, action: "file-inspect" });
      await waitForFileRunnerExit(value.stateRoot, marker);
      expect(statSync(target).ino).toBe(foreignInode);
      expect(readFileSync(target).equals(value.privateBytes)).toBe(true);
      expect(value.observedGets.length).toBe(observed);
    } finally {
      await value.close();
    }
  }, 15000);

  test.each(["foreign inode", "owned fsynced tail"] as const)(
    "retained pull resumes only its own partial: %s",
    async (condition) => {
      const value = await transferFixture();
      try {
        value.privateBytes = Buffer.alloc(512 * 1024, 71);
        const record = value.create({ requestId: randomUUID(), direction: "server_to_guest" });
        const marker = `moira-op-${"f1".repeat(16)}`;
        const digest = "b".repeat(64);
        const operation = {
          action: "file-execute",
          version: 1,
          remoteMarker: marker,
          repositoryFullName: "owner/repository",
          requestDigest: digest,
          admissionDeadlineAt: Date.now() + 60_000,
          request: {
            action: "upload",
            path: "resumed.bin",
            expected: { exists: false },
            transfer: record.descriptor,
          },
        };
        value.controls.dropGetOffset = 262144;
        expect(await request(value.environment, operation)).toMatchObject({ state: "running" });
        await waitForFileRunnerExit(value.stateRoot, marker);
        const checkpoint = JSON.parse(
          readFileSync(join(value.stateRoot, marker, "transfer.json"), "utf8"),
        );
        const partial = join(value.repository, checkpoint.temporaryName);
        const prefix = readFileSync(partial);
        const originalInode = statSync(partial).ino;
        if (condition === "foreign inode") {
          renameSync(partial, `${partial}.pinned`);
          writeFileSync(partial, Buffer.concat([prefix, Buffer.from("foreign tail")]));
        } else {
          const fd = openSync(partial, "a");
          try {
            writeSync(fd, Buffer.from("uncheckpointed tail"));
            fsyncSync(fd);
          } finally {
            closeSync(fd);
          }
        }
        const inode = statSync(partial).ino;
        const retained = readFileSync(partial);
        expect(inode === originalInode).toBe(condition === "owned fsynced tail");
        const observed = value.observedGets.length;
        await request(value.environment, { ...operation, action: "file-inspect" });
        await waitForFileRunnerExit(value.stateRoot, marker);
        if (condition === "foreign inode") {
          expect(existsSync(join(value.repository, "resumed.bin"))).toBe(false);
          expect(statSync(partial).ino).toBe(inode);
          expect(readFileSync(partial).equals(retained)).toBe(true);
          expect(value.observedGets.length).toBe(observed);
        } else {
          expect(await collectFile(value.environment, marker, digest)).toMatchObject({
            state: "succeeded",
          });
          expect(
            readFileSync(join(value.repository, "resumed.bin")).equals(value.privateBytes),
          ).toBe(true);
          expect(statSync(join(value.repository, "resumed.bin")).ino).toBe(originalInode);
        }
      } finally {
        await value.close();
      }
    },
    15000,
  );

  test.each([false, true])(
    "cancel before delayed dispatch survives early finalize=%s without launching the accepted effect",
    async (earlyFinalize) => {
      const value = fixture();
      const remoteMarker = `moira-op-${"e1".repeat(16)}`;
      const requestDigest = "1".repeat(64);
      const admissionDeadlineAt = Date.now() + 10000;
      const effect = join(value.repository, "cancel-before-dispatch-effect");
      const cancellation = await request(value.environment, {
        action: "cancel",
        version: 1,
        remoteMarker,
        requestDigest,
        admissionDeadlineAt,
      });
      if (earlyFinalize)
        await request(value.environment, {
          action: "finalize",
          version: 1,
          remoteMarker,
          requestDigest,
        });
      await request(value.environment, {
        action: "execute",
        version: 1,
        remoteMarker,
        requestDigest,
        admissionDeadlineAt,
        repositoryFullName: "owner/repository",
        stdin: "",
        timeoutMs: 5000,
        maxStdoutBytes: 1024,
        maxStderrBytes: 1024,
        maxRetainedBytes: 1024,
        argv: [
          process.execPath,
          "-e",
          "require('node:fs').appendFileSync(process.argv[1],'x')",
          effect,
        ],
      });
      const result = await inspectUntilTerminal(value.environment, remoteMarker);
      expect(existsSync(effect)).toBe(false);
      expect(cancellation).toMatchObject({ state: "not_started", requestDigest });
      expect(result).toMatchObject({ state: "not_started", requestDigest });
      expect(result.startedAt).toBeUndefined();
    },
  );
  test("completed modern work cannot replay after output cleanup while its original admission remains open", async () => {
    const value = fixture();
    const remoteMarker = `moira-op-${"e3".repeat(16)}`;
    const effect = join(value.repository, "completed-cleanup-effect");
    const admissionDeadlineAt = Date.now() + 10000;
    const operation = {
      action: "execute",
      version: 1,
      remoteMarker,
      requestDigest: "3".repeat(64),
      admissionDeadlineAt,
      repositoryFullName: "owner/repository",
      stdin: "",
      timeoutMs: 5000,
      maxStdoutBytes: 1024,
      maxStderrBytes: 1024,
      maxRetainedBytes: 1024,
      argv: [
        process.execPath,
        "-e",
        "require('node:fs').appendFileSync(process.argv[1],'x');process.stdout.write('printed')",
        effect,
      ],
    };
    await request(value.environment, operation);
    const original = await inspectUntilTerminal(value.environment, remoteMarker);
    expect(original).toMatchObject({ state: "succeeded", stdout: "printed" });
    await request(value.environment, {
      action: "finalize",
      version: 1,
      remoteMarker,
      requestDigest: operation.requestDigest,
    });
    await request(value.environment, operation);
    const replay = await inspectUntilTerminal(value.environment, remoteMarker);
    expect(readFileSync(effect, "utf8")).toBe("x");
    expect(replay).toMatchObject({
      state: "outcome_unknown",
      requestDigest: operation.requestDigest,
      startedAt: original.startedAt,
      runtimeMs: original.runtimeMs,
    });
    for (const file of ["stdout.log", "stderr.log", "result.json"])
      expect(existsSync(join(value.stateRoot, remoteMarker, file))).toBe(false);
    expect(
      await request(
        value.environment,
        { action: "finalize", version: 1, remoteMarker, requestDigest: operation.requestDigest },
        (source) => `Date.now=()=>${admissionDeadlineAt + 1};\n${source}`,
      ),
    ).toEqual({ state: "absent" });
    expect(existsSync(join(value.stateRoot, remoteMarker))).toBe(false);
  });

  test("an expired admission never launches a command and leaves a collectible not_started receipt", async () => {
    const value = fixture();
    const remoteMarker = `moira-op-${"a1".repeat(16)}`;
    const requestDigest = "1".repeat(64);
    const effect = join(value.repository, "expired-effect");
    const result = await request(value.environment, {
      action: "execute",
      version: 1,
      remoteMarker,
      repositoryFullName: "owner/repository",
      argv: [
        process.execPath,
        "-e",
        "require('node:fs').writeFileSync(process.argv[1],'effect')",
        effect,
      ],
      stdin: "",
      timeoutMs: 5000,
      maxStdoutBytes: 1024,
      maxStderrBytes: 1024,
      maxRetainedBytes: 1024,
      admissionDeadlineAt: Date.now() - 1,
      requestDigest,
    });
    // Drain a wrong implementation's already launched command before inspecting its effect.
    const collected = await inspectUntilTerminal(value.environment, remoteMarker);
    expect(existsSync(effect)).toBe(false);
    expect(result).toMatchObject({ state: "not_started", requestDigest });
    expect(collected).toMatchObject({ state: "not_started", requestDigest });
    expect(collected.startedAt).toBeUndefined();
  });

  test("a launch receipt survives replay without executing the same marker twice", async () => {
    const value = fixture();
    const remoteMarker = `moira-op-${"a2".repeat(16)}`;
    const effect = join(value.repository, "once-effect");
    const operation = {
      action: "execute",
      version: 1,
      remoteMarker,
      repositoryFullName: "owner/repository",
      argv: [
        process.execPath,
        "-e",
        "require('node:fs').appendFileSync(process.argv[1],'x')",
        effect,
      ],
      stdin: "",
      timeoutMs: 5000,
      maxStdoutBytes: 1024,
      maxStderrBytes: 1024,
      maxRetainedBytes: 1024,
      admissionDeadlineAt: Date.now() + 10000,
      requestDigest: "2".repeat(64),
    };
    await request(value.environment, operation);
    const original = await inspectUntilTerminal(value.environment, remoteMarker);
    expect(original.startedAt).toEqual(expect.any(Number));
    expect(original.requestDigest).toBe(operation.requestDigest);
    expect(original.runtimeMs).toBe(operation.timeoutMs);
    await expect(request(value.environment, operation)).resolves.toMatchObject({
      state: "succeeded",
      startedAt: original.startedAt,
      requestDigest: operation.requestDigest,
      runtimeMs: operation.timeoutMs,
    });
    await expect(
      request(value.environment, { ...operation, requestDigest: "3".repeat(64) }),
    ).rejects.toThrow();
    expect(readFileSync(effect, "utf8")).toBe("x");
  });

  test("spawn callback delay does not move a proved launch beyond its admitted window", async () => {
    const value = fixture();
    const remoteMarker = `moira-op-${"b4".repeat(16)}`;
    const admissionDeadlineAt = Date.now() + 1500;
    await request(
      value.environment,
      {
        action: "execute",
        version: 1,
        remoteMarker,
        repositoryFullName: "owner/repository",
        argv: ["/bin/echo", "launched"],
        stdin: "",
        timeoutMs: 5000,
        maxStdoutBytes: 1024,
        maxStderrBytes: 1024,
        maxRetainedBytes: 1024,
        admissionDeadlineAt,
        requestDigest: "b".repeat(64),
      },
      (source) =>
        source.replace(
          /child\.once\('spawn',\(\)=>resolve\((.*?)\)\);/,
          (_match, expression: string) =>
            `child.once('spawn',()=>{const now=Date.now;Date.now=()=>now()+2000;resolve(${expression})});`,
        ),
    );
    const result = await inspectUntilTerminal(value.environment, remoteMarker);
    expect(result).toMatchObject({ state: "succeeded", stdout: "launched\n" });
    expect(result.startedAt).toEqual(expect.any(Number));
    expect(result.startedAt as number).toBeLessThan(admissionDeadlineAt);
    expect(result.runtimeMs).toBe(5000);
  });

  test("a refused child spawn has a durable not_started receipt without launch metadata", async () => {
    const value = fixture();
    const remoteMarker = `moira-op-${"a7".repeat(16)}`;
    const operation = {
      action: "execute",
      version: 1,
      remoteMarker,
      repositoryFullName: "owner/repository",
      argv: [join(value.repository, "missing-executable")],
      stdin: "",
      timeoutMs: 5000,
      maxStdoutBytes: 1024,
      maxStderrBytes: 1024,
      maxRetainedBytes: 1024,
      admissionDeadlineAt: Date.now() + 10000,
      requestDigest: "7".repeat(64),
    };
    await request(value.environment, operation);
    const result = await inspectUntilTerminal(value.environment, remoteMarker);
    expect(result).toMatchObject({ state: "not_started", requestDigest: operation.requestDigest });
    expect(result.startedAt).toBeUndefined();
    expect(result.runtimeMs).toBeUndefined();
    await expect(request(value.environment, operation)).resolves.toEqual(result);
  });

  test("queued session commands see committed context while unrelated commands remain independent", async () => {
    const value = fixture();
    const environment = { ...value.environment, MOIRA_ENVIRONMENT_ID: "session-order" };
    const send = (suffix: string, extra: Record<string, unknown>) =>
      request(environment, {
        action: "execute",
        version: 1,
        remoteMarker: `moira-op-${suffix.repeat(16)}`,
        repositoryFullName: "owner/repository",
        stdin: "",
        timeoutMs: 10000,
        maxStdoutBytes: 1024,
        maxStderrBytes: 1024,
        maxRetainedBytes: 1024,
        ...extra,
      });
    const ready = join(value.repository, "session-ready");
    const release = join(value.repository, "session-release");
    await send("a3", {
      session: "ordered",
      sessionStart: true,
      script: `"${process.execPath}" -e "const fs=require('node:fs');fs.writeFileSync(process.argv[1],'ready');const t=setInterval(()=>{if(fs.existsSync(process.argv[2])){clearInterval(t)}},10)" "${ready}" "${release}"\nexport ORDERED_VALUE=committed\n`,
    });
    for (let index = 0; index < 200 && !existsSync(ready); index++)
      await new Promise((done) => setTimeout(done, 5));
    expect(existsSync(ready)).toBe(true);
    const queued = send("a4", {
      session: "ordered",
      argv: [process.execPath, "-e", "process.stdout.write(process.env.ORDERED_VALUE??'missing')"],
    });
    const cancelledMarker = `moira-op-${"e2".repeat(16)}`;
    const cancelledEffect = join(value.repository, "cancelled-queued-effect");
    const cancelDeadline = Date.now() + 10000;
    const cancelledQueue = send("e2", {
      session: "ordered",
      requestDigest: "2".repeat(64),
      admissionDeadlineAt: cancelDeadline,
      argv: [
        process.execPath,
        "-e",
        "require('node:fs').writeFileSync(process.argv[1],'effect')",
        cancelledEffect,
      ],
    });
    let queuedCancellation: unknown;
    try {
      for (
        let attempt = 0;
        attempt < 200 && !existsSync(join(value.stateRoot, cancelledMarker, "execution.json"));
        attempt++
      )
        await new Promise((done) => setTimeout(done, 5));
      expect(existsSync(join(value.stateRoot, cancelledMarker, "execution.json"))).toBe(true);
      queuedCancellation = await request(environment, {
        action: "cancel",
        version: 1,
        remoteMarker: cancelledMarker,
        requestDigest: "2".repeat(64),
        admissionDeadlineAt: cancelDeadline,
      });
      await send("aa", {
        session: "independent",
        sessionStart: true,
        argv: ["/bin/echo", "new-session"],
        admissionDeadlineAt: Date.now() + 1000,
        requestDigest: "f".repeat(64),
      });
      expect(await inspectUntilTerminal(environment, `moira-op-${"aa".repeat(16)}`)).toMatchObject({
        state: "succeeded",
        stdout: "new-session\n",
      });
      const expiredEffect = join(value.repository, "expired-session-effect");
      const expired = await send("a8", {
        session: "ordered",
        admissionDeadlineAt: Date.now() + 1000,
        requestDigest: "8".repeat(64),
        argv: [
          process.execPath,
          "-e",
          "require('node:fs').writeFileSync(process.argv[1],'effect')",
          expiredEffect,
        ],
      });
      expect(expired).toMatchObject({ state: "not_started", requestDigest: "8".repeat(64) });
      expect(expired).not.toHaveProperty("startedAt");
      expect(existsSync(expiredEffect)).toBe(false);
      expect(
        await send("a9", {
          session: "ordered",
          sessionEnd: true,
          admissionDeadlineAt: Date.now() + 1000,
          requestDigest: "d".repeat(64),
        }),
      ).toMatchObject({
        state: "not_started",
        requestDigest: "d".repeat(64),
      });
      await send("a5", { argv: ["/bin/echo", "independent"] });
      expect(await inspectUntilTerminal(environment, `moira-op-${"a5".repeat(16)}`)).toMatchObject({
        stdout: "independent\n",
      });
    } finally {
      writeFileSync(release, "release");
      await inspectUntilTerminal(environment, `moira-op-${"a3".repeat(16)}`);
      await queued;
      await cancelledQueue;
    }
    expect(await inspectUntilTerminal(environment, `moira-op-${"a4".repeat(16)}`)).toMatchObject({
      stdout: "committed",
    });
    expect(existsSync(cancelledEffect)).toBe(false);
    expect(queuedCancellation).toMatchObject({
      state: "not_started",
      requestDigest: "2".repeat(64),
    });
  });

  test("modern session_end checks its actual effect timestamp and persists success without a child spawn", async () => {
    const value = fixture();
    const environment = { ...value.environment, MOIRA_ENVIRONMENT_ID: "modern-end-life" };
    const base = {
      action: "execute",
      version: 1,
      repositoryFullName: "owner/repository",
      stdin: "",
      timeoutMs: 5000,
      maxStdoutBytes: 1024,
      maxStderrBytes: 1024,
      maxRetainedBytes: 1024,
    };
    const openingMarker = `moira-op-${"d1".repeat(16)}`;
    await request(environment, {
      ...base,
      remoteMarker: openingMarker,
      session: "ending",
      sessionStart: true,
      argv: ["/bin/echo", "open"],
    });
    await inspectUntilTerminal(environment, openingMarker);
    const remoteMarker = `moira-op-${"d2".repeat(16)}`;
    const admissionDeadlineAt = Date.now() + 10000;
    const end = {
      ...base,
      remoteMarker,
      session: "ending",
      sessionEnd: true,
      admissionDeadlineAt,
      requestDigest: "e".repeat(64),
    };
    const result = (await request(environment, end, (source) =>
      source.replace(
        "if (session.ended) {",
        "if (session.ended) { let reads=0;Date.now=()=>reads++===0?request.admissionDeadlineAt-1:request.admissionDeadlineAt+1;",
      ),
    )) as Record<string, unknown>;
    expect(result).toMatchObject({
      state: "succeeded",
      requestDigest: end.requestDigest,
      runtimeMs: 5000,
    });
    expect(result.startedAt as number).toBeLessThan(admissionDeadlineAt);
    expect(existsSync(join(value.stateRoot, "sessions", "ending.json"))).toBe(false);
    expect(existsSync(join(value.stateRoot, remoteMarker, "pid"))).toBe(false);
    expect(await request(environment, end)).toEqual(result);
  });

  test("concurrent distinct session starts preserve the sixteen-session admission bound", async () => {
    const value = fixture();
    const environment = { ...value.environment, MOIRA_ENVIRONMENT_ID: "capacity-life" };
    const base = {
      action: "execute",
      version: 1,
      repositoryFullName: "owner/repository",
      argv: ["/bin/echo", "started"],
      stdin: "",
      timeoutMs: 5000,
      maxStdoutBytes: 1024,
      maxStderrBytes: 1024,
      maxRetainedBytes: 1024,
      sessionStart: true,
    };
    const initialMarker = `moira-op-${"c1".repeat(16)}`;
    await request(environment, { ...base, remoteMarker: initialMarker, session: "initial" });
    await inspectUntilTerminal(environment, initialMarker);
    const sessionRoot = join(value.stateRoot, "sessions");
    const stored = readFileSync(join(sessionRoot, "initial.json"));
    for (let index = 1; index < 15; index++)
      writeFileSync(join(sessionRoot, `existing-${index}.json`), stored, { mode: 0o600 });
    const firstMarker = `moira-op-${"c2".repeat(16)}`;
    const ready = join(value.stateRoot, firstMarker, "execution.json.capacity-ready");
    const release = join(value.stateRoot, "capacity-release");
    const first = request(
      environment,
      { ...base, remoteMarker: firstMarker, session: "first-new" },
      (source) =>
        source.replace(
          "if(startedAt!==null&&input.session){await durable(input.session.path,",
          `if(startedAt!==null&&input.session){await writeFile(input.executionPath+'.capacity-ready','ready');while(!await access(${JSON.stringify(release)}).then(()=>true,()=>false))await new Promise(done=>setTimeout(done,5));await durable(input.session.path,`,
        ),
    );
    let second: Record<string, unknown> | undefined;
    try {
      for (let attempt = 0; attempt < 200 && !existsSync(ready); attempt++)
        await new Promise((done) => setTimeout(done, 5));
      expect(existsSync(ready)).toBe(true);
      second = (await request(environment, {
        ...base,
        remoteMarker: `moira-op-${"c3".repeat(16)}`,
        session: "second-new",
        requestDigest: "c".repeat(64),
        admissionDeadlineAt: Date.now() + 1000,
      })) as Record<string, unknown>;
    } finally {
      writeFileSync(release, "release");
      await first;
      await inspectUntilTerminal(environment, firstMarker);
    }
    expect(readdirSync(sessionRoot).filter((name) => name.endsWith(".json"))).toHaveLength(16);
    expect(["not_started", "session_limit"]).toContain(second?.state);
  });

  test("a committed session releases its lock while an unrelated background descendant remains alive", async () => {
    const value = fixture();
    const environment = { ...value.environment, MOIRA_ENVIRONMENT_ID: "background-session" };
    const pidPath = join(value.repository, "background-pid");
    const send = (suffix: string, extra: Record<string, unknown>) =>
      request(environment, {
        action: "execute",
        version: 1,
        remoteMarker: `moira-op-${suffix.repeat(16)}`,
        repositoryFullName: "owner/repository",
        stdin: "",
        timeoutMs: 5000,
        maxStdoutBytes: 1024,
        maxStderrBytes: 1024,
        maxRetainedBytes: 1024,
        ...extra,
      });
    try {
      await send("b1", {
        session: "background",
        sessionStart: true,
        script: `"${process.execPath}" -e 'setInterval(()=>{},10000)' </dev/null >/dev/null 2>&1 &\necho $! > "${pidPath}"\nexport BACKGROUND_VALUE=committed\n`,
      });
      expect(await inspectUntilTerminal(environment, `moira-op-${"b1".repeat(16)}`)).toMatchObject({
        state: "succeeded",
      });
      process.kill(Number(readFileSync(pidPath, "utf8")), 0);
      await send("b2", {
        session: "background",
        admissionDeadlineAt: Date.now() + 2000,
        requestDigest: "9".repeat(64),
        argv: [
          process.execPath,
          "-e",
          "process.stdout.write(process.env.BACKGROUND_VALUE??'missing')",
        ],
      });
      expect(await inspectUntilTerminal(environment, `moira-op-${"b2".repeat(16)}`)).toMatchObject({
        state: "succeeded",
        stdout: "committed",
      });
    } finally {
      if (existsSync(pidPath)) {
        try {
          process.kill(Number(readFileSync(pidPath, "utf8")), "SIGKILL");
        } catch {
          // The background process may already have exited during test cleanup.
        }
      }
    }
  });

  test("an incomplete launch intent remains outcome_unknown and is never dispatched again", async () => {
    const value = fixture();
    const remoteMarker = `moira-op-${"a6".repeat(16)}`;
    const effect = join(value.repository, "incomplete-effect");
    const operation = {
      action: "execute",
      version: 1,
      remoteMarker,
      repositoryFullName: "owner/repository",
      argv: [
        process.execPath,
        "-e",
        "require('node:fs').writeFileSync(process.argv[1],'effect')",
        effect,
      ],
      stdin: "",
      timeoutMs: 5000,
      maxStdoutBytes: 1024,
      maxStderrBytes: 1024,
      maxRetainedBytes: 1024,
      admissionDeadlineAt: Date.now() + 10000,
      requestDigest: "6".repeat(64),
    };
    await expect(
      request(value.environment, operation, (source) =>
        source.replace(
          'await writeDurableJson(directory, "execution.json", execution);',
          'await writeDurableJson(directory, "execution.json", execution); throw new Error("lost launch observer");',
        ),
      ),
    ).rejects.toThrow("lost launch observer");
    expect(await request(value.environment, operation)).toEqual({
      state: "outcome_unknown",
      requestDigest: operation.requestDigest,
    });
    expect(
      await request(value.environment, { action: "inspect", version: 1, remoteMarker }),
    ).toEqual({ state: "outcome_unknown", requestDigest: operation.requestDigest });
    expect(existsSync(effect)).toBe(false);
  });

  test("a launch attempt lost before PID publication cannot become a negative cancellation proof", async () => {
    const value = fixture();
    const remoteMarker = `moira-op-${"d4".repeat(16)}`;
    const effect = join(value.repository, "lost-start-effect");
    const operation = {
      action: "execute",
      version: 1,
      remoteMarker,
      repositoryFullName: "owner/repository",
      argv: [
        process.execPath,
        "-e",
        "require('node:fs').appendFileSync(process.argv[1],'x')",
        effect,
      ],
      stdin: "",
      timeoutMs: 5000,
      maxStdoutBytes: 1024,
      maxStderrBytes: 1024,
      maxRetainedBytes: 1024,
      admissionDeadlineAt: Date.now() + 10000,
      requestDigest: "d".repeat(64),
    };
    await expect(
      request(value.environment, operation, (source) =>
        source.replace(
          "if(startedAt!==null){await durable(input.executionPath,",
          "if(startedAt!==null){process.exit(1);await durable(input.executionPath,",
        ),
      ),
    ).rejects.toThrow();
    const proof = JSON.parse(
      readFileSync(join(value.stateRoot, remoteMarker, "execution.json"), "utf8"),
    );
    expect(proof.launchAttempted).toBe(true);
    expect(proof.startedAt).toBeUndefined();
    const unknown = { state: "outcome_unknown", requestDigest: operation.requestDigest };
    expect(
      await request(value.environment, {
        action: "cancel",
        version: 1,
        remoteMarker,
        requestDigest: operation.requestDigest,
        admissionDeadlineAt: operation.admissionDeadlineAt,
      }),
    ).toEqual(unknown);
    expect(await request(value.environment, operation)).toEqual(unknown);
    expect(readFileSync(effect, "utf8")).toBe("x");
  });

  test("a proved effect with a lost terminal receipt remains unknown instead of inventing a failure or repeating it", async () => {
    const value = fixture();
    const remoteMarker = `moira-op-${"b3".repeat(16)}`;
    const effect = join(value.repository, "lost-terminal-effect");
    const operation = {
      action: "execute",
      version: 1,
      remoteMarker,
      repositoryFullName: "owner/repository",
      argv: [
        process.execPath,
        "-e",
        "require('node:fs').appendFileSync(process.argv[1],'x')",
        effect,
      ],
      stdin: "",
      timeoutMs: 5000,
      maxStdoutBytes: 1024,
      maxStderrBytes: 1024,
      maxRetainedBytes: 1024,
      admissionDeadlineAt: Date.now() + 10000,
      requestDigest: "a".repeat(64),
    };
    await request(value.environment, operation, (source) =>
      source.replace(
        "const code=await closed;let cancelled=false;",
        "const code=await closed;process.exit(1);let cancelled=false;",
      ),
    );
    const outcome = await inspectUntilTerminal(value.environment, remoteMarker);
    const proof = JSON.parse(
      readFileSync(join(value.stateRoot, remoteMarker, "execution.json"), "utf8"),
    );
    expect(proof).toMatchObject({ startedAt: expect.any(Number), runtimeMs: operation.timeoutMs });
    expect(outcome).toEqual({
      state: "outcome_unknown",
      requestDigest: operation.requestDigest,
      startedAt: proof.startedAt,
      runtimeMs: operation.timeoutMs,
    });
    await expect(
      request(value.environment, {
        action: "finalize",
        version: 1,
        remoteMarker,
        requestDigest: operation.requestDigest,
      }),
    ).rejects.toThrow("unresolved");
    expect(await request(value.environment, operation)).toEqual({
      state: "outcome_unknown",
      requestDigest: operation.requestDigest,
      startedAt: proof.startedAt,
      runtimeMs: operation.timeoutMs,
    });
    expect(readFileSync(effect, "utf8")).toBe("x");
  });

  test("combined result prefixes fit the control frame without killing or losing retained output", async () => {
    const value = fixture();
    const remoteMarker = `moira-op-${"a7".repeat(16)}`;
    const bytes = 8 * 1024 * 1024;
    await request(value.environment, {
      action: "execute",
      version: 1,
      remoteMarker,
      repositoryFullName: "owner/repository",
      argv: [
        process.execPath,
        "-e",
        "process.stdout.write('x'.repeat(Number(process.argv[1])-4)+'TAIL');process.stderr.write('e'.repeat(Number(process.argv[1])));",
        String(bytes),
      ],
      stdin: "",
      timeoutMs: 10000,
      maxStdoutBytes: bytes,
      maxStderrBytes: bytes,
      maxRetainedBytes: bytes,
    });
    const terminal = await inspectUntilTerminal(value.environment, remoteMarker);
    expect(terminal).toMatchObject({
      state: "succeeded",
      exitCode: 0,
      stdoutBytes: bytes,
      stderrBytes: bytes,
      outputLimitExceeded: false,
    });
    expect(statSync(join(value.stateRoot, remoteMarker, "result.json")).size).toBeLessThan(
      8 * 1024 * 1024,
    );
    expect(statSync(join(value.stateRoot, remoteMarker, "stdout.log")).size).toBe(bytes);
    expect(statSync(join(value.stateRoot, remoteMarker, "stderr.log")).size).toBe(bytes);
    const tail = (await request(value.environment, {
      action: "output",
      version: 1,
      remoteMarker,
      stream: "stdout",
      offset: bytes - 4,
      length: 4,
    })) as { bytesBase64: string };
    expect(Buffer.from(tail.bytesBase64, "base64").toString()).toBe("TAIL");
  });

  test("defaults to the GitHub Codespaces /workspaces repository mount", () => {
    const source = readFileSync(supervisorPath, "utf8");
    expect(source).toContain('process.env.MOIRA_CODESPACES_ROOT || "/workspaces"');
  });

  test.each(["stat", "read"] as const)(
    "large sparse %s uses metadata or only the selected descriptor bytes",
    async (action) => {
      const value = fixture();
      const path = join(value.repository, "large.bin");
      const audit = join(value.stateRoot, "descriptor-reads.jsonl");
      const size = 64 * 1024 * 1024;
      const offset = 8 * 1024 * 1024 + 7;
      const selected = Buffer.from("selected range");
      const fd = openSync(path, "w", 0o600);
      try {
        ftruncateSync(fd, size);
        writeSync(fd, selected, 0, selected.length, offset);
      } finally {
        closeSync(fd);
      }
      const observe = (source: string) =>
        source.replace(
          "handle.moiraPath = join(parent.moiraPath, name);",
          `handle.moiraPath = join(parent.moiraPath, name);
if(handle.moiraPath===${JSON.stringify(path)}){
  const actualRead=handle.read.bind(handle);
  handle.read=async(buffer,bufferOffset,length,position)=>{
    await writeFile(${JSON.stringify(audit)},JSON.stringify({bufferBytes:buffer.length,length,position})+'\\n',{flag:'a'});
    if(${JSON.stringify(action)}==='stat'||position<${offset}||length>${selected.length}||position+length>${offset + selected.length})throw new Error('unexpected whole-file content access');
    return actualRead(buffer,bufferOffset,length,position);
  };
}`,
        );
      const outcome = await request(
        value.environment,
        {
          action: "file-execute",
          version: 1,
          remoteMarker: `moira-op-${(action === "stat" ? "d5" : "d6").repeat(16)}`,
          repositoryFullName: "owner/repository",
          request:
            action === "stat"
              ? { action, path: "large.bin" }
              : {
                  action,
                  path: "large.bin",
                  offset,
                  length: selected.length,
                },
        },
        observe,
      );
      const reads = existsSync(audit)
        ? readFileSync(audit, "utf8")
            .trim()
            .split("\n")
            .map(
              (line) =>
                JSON.parse(line) as { bufferBytes: number; length: number; position: number },
            )
        : [];
      expect(outcome).toMatchObject({ state: "succeeded" });
      if (action === "stat") {
        expect(outcome).toMatchObject({ value: { action, stat: { size, version: null } } });
        expect(reads).toEqual([]);
      } else {
        expect(outcome).toMatchObject({
          value: {
            action,
            offset,
            totalSize: size,
            bytesBase64: selected.toString("base64"),
            sha256: null,
            rangeSha256: createHash("sha256").update(selected).digest("hex"),
          },
        });
        expect(reads.length).toBeGreaterThan(0);
        expect(reads.reduce((total, read) => total + read.length, 0)).toBe(selected.length);
        for (const read of reads) {
          expect(read.bufferBytes).toBeLessThanOrEqual(selected.length);
          expect(read.position).toBeGreaterThanOrEqual(offset);
          expect(read.position + read.length).toBeLessThanOrEqual(offset + selected.length);
        }
      }
    },
  );

  test("a fresh fixed probe observes actual guest life without changing repository content", async () => {
    const value = fixture();
    const environment = { ...value.environment, MOIRA_ENVIRONMENT_ID: "probe-life" };
    writeFileSync(join(value.repository, "preserved.txt"), "preserved");
    const probe = (await request(environment, {
      action: "file-execute",
      version: 1,
      remoteMarker: `moira-op-${"5".repeat(32)}`,
      repositoryFullName: "owner/repository",
      request: { action: "probe" },
    })) as { state: string; value: { abi: number; environmentIdentity: string } };
    expect(probe.state).toBe("succeeded");
    expect(probe.value.abi).toBe(1);
    const identity =
      process.platform === "linux"
        ? `${readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim()}|${processStartTime(1)}`
        : "override:probe-life";
    expect(probe.value.environmentIdentity).toBe(
      createHash("sha256").update(identity).digest("hex"),
    );
    expect(readFileSync(join(value.repository, "preserved.txt"), "utf8")).toBe("preserved");
  });

  test("fresh file-client probe measures an executable command usable outside the guest PATH", async () => {
    const value = fixture();
    const home = value.environment.HOME!;
    const clientDirectory = join(home, ".local/share/moira-files");
    const bin = join(home, ".local/bin");
    mkdirSync(clientDirectory, { recursive: true });
    mkdirSync(bin, { recursive: true });
    const bytes = readFileSync(
      join(process.cwd(), "packages/web-backend/dist/guest-assets/guest-files-cli.js"),
    );
    const executable = join(bin, "moira-files");
    writeFileSync(join(clientDirectory, "client.mjs"), bytes, { mode: 0o700 });
    writeFileSync(executable, bytes, { mode: 0o700 });
    const environment: NodeJS.ProcessEnv = {
      ...value.environment,
      MOIRA_ENVIRONMENT_ID: "command-path-life",
    };
    expect((environment.PATH ?? "").split(":")).not.toContain(bin);
    const probe = (await request(environment, {
      action: "file-execute",
      version: 1,
      remoteMarker: `moira-op-${"5".repeat(32)}`,
      repositoryFullName: "owner/repository",
      request: { action: "probe" },
    })) as any;
    expect(probe).toMatchObject({
      state: "succeeded",
      value: {
        command: executable,
        cliSha256: createHash("sha256").update(bytes).digest("hex"),
        executableSha256: createHash("sha256").update(bytes).digest("hex"),
      },
    });
    const marker = `moira-op-${"6".repeat(32)}`;
    let command = (await request(environment, {
      action: "execute",
      version: 1,
      remoteMarker: marker,
      repositoryFullName: "owner/repository",
      argv: [probe.value.command, "--help"],
      stdin: "",
      timeoutMs: 1000,
      maxStdoutBytes: 4096,
      maxStderrBytes: 4096,
      maxRetainedBytes: 8192,
    })) as any;
    for (let attempt = 0; command.state === "running" && attempt < 20; attempt++)
      command = await request(environment, { action: "inspect", version: 1, remoteMarker: marker });
    expect(command).toMatchObject({
      state: "succeeded",
      exitCode: 0,
      stdout: expect.stringContaining("moira-files upload PATH"),
    });
    writeFileSync(executable, "independent executable bytes");
    const changed = (await request(environment, {
      action: "file-inspect",
      version: 1,
      remoteMarker: `moira-op-${"5".repeat(32)}`,
      repositoryFullName: "owner/repository",
      request: { action: "probe" },
    })) as any;
    expect(changed.value.executableSha256).toBe(
      createHash("sha256").update("independent executable bytes").digest("hex"),
    );
    expect(changed.value.executableSha256).not.toBe(changed.value.cliSha256);
  });

  test("a modern file arriving after admission closes never creates its target", async () => {
    const value = fixture();
    const marker = `moira-op-${"4".repeat(32)}`;
    const digest = "f".repeat(64);
    const result = await request(value.environment, {
      action: "file-execute",
      version: 1,
      remoteMarker: marker,
      repositoryFullName: "owner/repository",
      requestDigest: digest,
      admissionDeadlineAt: Date.now() - 1,
      request: {
        action: "write",
        path: "late.txt",
        bytesBase64: Buffer.from("late").toString("base64"),
        expected: { exists: false },
      },
    });
    expect(result).toMatchObject({ state: "failed", requestDigest: digest, notStarted: true });
    expect(existsSync(join(value.repository, "late.txt"))).toBe(false);
    expect(
      await request(value.environment, {
        action: "file-inspect",
        version: 1,
        remoteMarker: marker,
        requestDigest: digest,
      }),
    ).toEqual(result);
  });

  test("completed modern file identity refuses changed replay after intent cleanup", async () => {
    const value = fixture();
    const marker = `moira-op-${"3".repeat(32)}`;
    const original = {
      action: "file-execute",
      version: 1,
      remoteMarker: marker,
      repositoryFullName: "owner/repository",
      requestDigest: "e".repeat(64),
      admissionDeadlineAt: Date.now() + 60_000,
      request: {
        action: "write",
        path: "once.txt",
        bytesBase64: Buffer.from("once").toString("base64"),
        expected: { exists: false },
      },
    };
    const result = await request(value.environment, original);
    expect(result).toMatchObject({ state: "succeeded", requestDigest: original.requestDigest });
    expect(existsSync(join(value.stateRoot, marker, "file-intent.json"))).toBe(false);
    const inode = statSync(join(value.repository, "once.txt")).ino;
    expect(
      await request(value.environment, {
        action: "finalize",
        version: 1,
        remoteMarker: marker,
        requestDigest: original.requestDigest,
      }),
    ).toMatchObject({ state: "outcome_unknown" });
    expect(await request(value.environment, original)).toEqual(result);
    expect(statSync(join(value.repository, "once.txt")).ino).toBe(inode);
    await expect(
      request(value.environment, {
        ...original,
        request: { ...original.request, path: "another.txt" },
      }),
    ).rejects.toThrow("file operation immutable proof mismatch");
    expect(existsSync(join(value.repository, "another.txt"))).toBe(false);
    expect(readFileSync(join(value.repository, "once.txt"), "utf8")).toBe("once");
  });

  test("a fixed probe on a terminal maintenance anchor observes fresh life rather than its cached command result", async () => {
    const value = fixture();
    const marker = `moira-op-${"2".repeat(32)}`;
    const environment = { ...value.environment, MOIRA_ENVIRONMENT_ID: "anchor-life" };
    await request(environment, {
      action: "execute",
      version: 1,
      remoteMarker: marker,
      repositoryFullName: "owner/repository",
      argv: [process.execPath, "-e", "process.stdout.write('original')"],
      cwd: ".",
      stdin: "",
      timeoutMs: 10_000,
      maxStdoutBytes: 1024,
      maxStderrBytes: 1024,
      maxRetainedBytes: 4096,
    });
    const completed = await inspectUntilTerminal(environment, marker);
    expect(completed.stdout).toBe("original");
    const first = await request(environment, {
      action: "file-inspect",
      version: 1,
      remoteMarker: marker,
      repositoryFullName: "owner/repository",
      request: { action: "probe" },
    });
    const second = await request(
      { ...environment, MOIRA_ENVIRONMENT_ID: "next-life" },
      {
        action: "file-inspect",
        version: 1,
        remoteMarker: marker,
        repositoryFullName: "owner/repository",
        request: { action: "probe" },
      },
    );
    expect(first).toMatchObject({ state: "succeeded", value: { action: "probe", abi: 1 } });
    if (process.platform === "linux") expect(second).toEqual(first);
    else expect(second).not.toEqual(first);
    expect(
      await request(environment, { action: "inspect", version: 1, remoteMarker: marker }),
    ).toEqual(completed);
  });

  test("detached native transfer recovers lost chunk and publication replies with bounded exact bytes", async () => {
    const value = await transferFixture();
    let release!: () => void;
    value.controls.holdChunk = new Promise<void>((done) => {
      release = done;
    });
    try {
      const bytes = Buffer.alloc(5 * 1024 * 1024 + 19, 65);
      writeFileSync(join(value.repository, "artifact.bin"), bytes);
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      const record = value.create({
        requestId: randomUUID(),
        direction: "guest_to_server",
        size: bytes.length,
        sha256,
      });
      value.controls.dropPut = true;
      value.controls.dropFinalize = true;
      const marker = `moira-op-${"1".repeat(32)}`;
      const digest = "d".repeat(64);
      const acknowledgement = await request(
        value.environment,
        {
          action: "file-execute",
          version: 1,
          remoteMarker: marker,
          repositoryFullName: "owner/repository",
          requestDigest: digest,
          admissionDeadlineAt: Date.now() + 60_000,
          request: { action: "download", path: "artifact.bin", transfer: record.descriptor },
        },
        undefined,
        3000,
      );
      expect(acknowledgement).toMatchObject({ state: "running", requestDigest: digest });
      await value.firstChunk;
      expect(
        await request(
          value.environment,
          { action: "file-inspect", version: 1, remoteMarker: marker, requestDigest: digest },
          undefined,
          3000,
        ),
      ).toMatchObject({ state: "running", requestDigest: digest });
      expect(record.offset).toBe(0);
      expect(
        await request(
          value.environment,
          {
            action: "file-execute",
            version: 1,
            remoteMarker: `moira-op-${"3".repeat(32)}`,
            repositoryFullName: "owner/repository",
            request: { action: "stat", path: "artifact.bin" },
          },
          undefined,
          3000,
        ),
      ).toMatchObject({
        state: "succeeded",
        value: { stat: { size: bytes.length, version: null } },
      });
      release();
      const result = await collectFile(value.environment, marker, digest);
      expect(result).toMatchObject({
        state: "succeeded",
        requestDigest: digest,
        value: {
          action: "download",
          transferId: record.descriptor.transferId,
          size: bytes.length,
          sha256,
          referenceId: "private-reference",
        },
      });
      expect(value.privateBytes.equals(bytes)).toBe(true);
      expect(value.maximumBody).toBe(262144);
      expect(JSON.stringify(result)).not.toContain("bytesBase64");
      expect(readFileSync(join(value.repository, "artifact.bin")).equals(bytes)).toBe(true);
      const reference = record.receipt;
      expect(await collectFile(value.environment, marker, digest)).toEqual(result);
      expect(record.receipt).toBe(reference);
    } finally {
      release();
      await value.close();
    }
  }, 15000);

  test("detached native pull resumes retained chunks and commits a guarded large target once", async () => {
    const value = await transferFixture();
    try {
      const bytes = Buffer.alloc(5 * 1024 * 1024 + 31, 66);
      value.privateBytes = bytes;
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      const record = value.create({ requestId: randomUUID(), direction: "server_to_guest" });
      const marker = `moira-op-${"0".repeat(32)}`;
      const digest = "c".repeat(64);
      const original = {
        action: "file-execute",
        version: 1,
        remoteMarker: marker,
        repositoryFullName: "owner/repository",
        requestDigest: digest,
        admissionDeadlineAt: Date.now() + 60_000,
        request: {
          action: "upload",
          path: "received.bin",
          expected: { exists: false },
          transfer: record.descriptor,
        },
      };
      value.controls.dropGetOffset = 524288;
      expect(await request(value.environment, original)).toMatchObject({ state: "running" });
      await waitForFileRunnerExit(value.stateRoot, marker);
      expect(existsSync(join(value.repository, "received.bin"))).toBe(false);
      const checkpoint = JSON.parse(
        readFileSync(join(value.stateRoot, marker, "transfer.json"), "utf8"),
      );
      expect(checkpoint.offset).toBe(524288);
      const observed = value.observedGets.length;
      expect(
        await request(value.environment, { ...original, action: "file-inspect" }),
      ).toMatchObject({ state: "running" });
      const result = await collectFile(value.environment, marker, digest);
      expect(result).toMatchObject({
        state: "succeeded",
        value: {
          action: "upload",
          transferId: record.descriptor.transferId,
          previous: null,
          current: { size: bytes.length, sha256 },
        },
      });
      expect(value.observedGets[observed]).toBe(checkpoint.offset);
      expect(readFileSync(join(value.repository, "received.bin")).equals(bytes)).toBe(true);
      const inode = statSync(join(value.repository, "received.bin")).ino;
      expect(await request(value.environment, original)).toEqual(result);
      expect(statSync(join(value.repository, "received.bin")).ino).toBe(inode);
    } finally {
      await value.close();
    }
  }, 15000);

  test.each([false, true])(
    "expired transfer cleans only its unchanged retained partial (replaced=%s)",
    async (replaced) => {
      const value = await transferFixture();
      try {
        value.privateBytes = Buffer.alloc(512 * 1024, 68);
        const record = value.create({ requestId: randomUUID(), direction: "server_to_guest" });
        const marker = `moira-op-${"2".repeat(32)}`;
        const digest = "a".repeat(64);
        value.controls.dropGetOffset = 262144;
        expect(
          await request(value.environment, {
            action: "file-execute",
            version: 1,
            remoteMarker: marker,
            repositoryFullName: "owner/repository",
            requestDigest: digest,
            admissionDeadlineAt: Date.now() + 60_000,
            request: {
              action: "upload",
              path: "expired.bin",
              expected: { exists: false },
              transfer: record.descriptor,
            },
          }),
        ).toMatchObject({ state: "running" });
        await waitForFileRunnerExit(value.stateRoot, marker);
        const checkpoint = JSON.parse(
          readFileSync(join(value.stateRoot, marker, "transfer.json"), "utf8"),
        );
        const partial = join(value.repository, checkpoint.temporaryName);
        expect(statSync(partial).size).toBe(262144);
        if (replaced) {
          rmSync(partial);
          writeFileSync(partial, "foreign file");
        }
        const observed = value.observedGets.length;
        const inspection = request(
          value.environment,
          { action: "file-inspect", version: 1, remoteMarker: marker, requestDigest: digest },
          (source) => `${source}\nDate.now=()=>${record.descriptor.expiresAt + 1};`,
        );
        if (replaced) {
          await expect(inspection).rejects.toThrow("expired transfer staging changed");
          expect(readFileSync(partial, "utf8")).toBe("foreign file");
        } else {
          expect(await inspection).toMatchObject({
            state: "failed",
            requestDigest: digest,
            value: { reason: "precondition" },
          });
          expect(existsSync(partial)).toBe(false);
        }
        expect(value.observedGets.length).toBe(observed);
        expect(existsSync(join(value.repository, "expired.bin"))).toBe(false);
      } finally {
        await value.close();
      }
    },
    15000,
  );

  test("installed moira-files prints recovery identity and uses pure status with exact streamed upload and pull", async () => {
    const value = await transferFixture();
    try {
      const bytes = Buffer.alloc(5 * 1024 * 1024 + 7, 67);
      writeFileSync(join(value.repository, "cli.bin"), bytes);
      const requestId = randomUUID();
      value.controls.dropFinalize = true;
      const lost = await client(value.environment, [
        "upload",
        "cli.bin",
        "--request-id",
        requestId.toUpperCase(),
      ]);
      expect(lost.code).toBe(1);
      expect(lost.lines[0]).toEqual({ requestId, state: "request_prepared" });
      const uploaded = await client(value.environment, [
        "upload",
        "cli.bin",
        "--request-id",
        requestId,
      ]);
      expect(uploaded.code).toBe(0);
      expect(uploaded.lines.at(-1)).toMatchObject({
        requestId,
        referenceId: "private-reference",
        size: bytes.length,
      });
      const record = value.records.get(requestId);
      const receipt = record.receipt;
      const snapshot = await client(value.environment, ["status", requestId.toUpperCase()]);
      expect(snapshot.code).toBe(0);
      expect(snapshot.lines).toHaveLength(1);
      expect(snapshot.lines[0]).toMatchObject({ requestId, state: "ready", offset: bytes.length });
      expect(record.receipt).toBe(receipt);
      const pulled = await client(value.environment, [
        "download",
        "private-reference",
        "cli-received.bin",
        "--request-id",
        randomUUID(),
      ]);
      expect(pulled.code).toBe(0);
      expect(readFileSync(join(value.repository, "cli-received.bin")).equals(bytes)).toBe(true);
      expect(value.maximumBody).toBe(262144);
    } finally {
      await value.close();
    }
  }, 15000);

  test("performs bounded stat, search, ranges and atomic binary writes without shell paths", async () => {
    const value = fixture();
    writeFileSync(join(value.repository, "source.txt"), "alpha\nbeta needle\ngamma\n");
    const statMarker = `moira-op-${"6".repeat(32)}`;
    const statResult = (await request(value.environment, {
      action: "file-execute",
      version: 1,
      remoteMarker: statMarker,
      repositoryFullName: "owner/repository",
      request: { action: "stat", path: "source.txt" },
    })) as { state: string; value: { stat: { version: { sha256: string } } } };
    expect(statResult.state).toBe("succeeded");
    expect(statResult.value.stat.version.sha256).toMatch(/^[a-f0-9]{64}$/);

    const readResult = (await request(value.environment, {
      action: "file-execute",
      version: 1,
      remoteMarker: `moira-op-${"7".repeat(32)}`,
      repositoryFullName: "owner/repository",
      request: { action: "read", path: "source.txt", offset: 6, length: 4 },
    })) as {
      value: {
        bytesBase64: string;
        offset: number;
        totalSize: number;
        sha256: string;
        rangeSha256: string;
      };
    };
    expect(Buffer.from(readResult.value.bytesBase64, "base64").toString()).toBe("beta");
    expect(readResult.value).toMatchObject({ offset: 6, totalSize: 24 });
    expect(readResult.value.sha256).toBe(
      createHash("sha256").update("alpha\nbeta needle\ngamma\n").digest("hex"),
    );
    expect(readResult.value.rangeSha256).toBe(createHash("sha256").update("beta").digest("hex"));

    mkdirSync(join(value.repository, "sub"));
    writeFileSync(join(value.repository, "sub", "match.txt"), "needle\n");
    const searchResult = (await request(value.environment, {
      action: "file-execute",
      version: 1,
      remoteMarker: `moira-op-${"8".repeat(32)}`,
      repositoryFullName: "owner/repository",
      request: {
        action: "search",
        path: "sub",
        query: "needle",
        mode: "literal",
        maxMatches: 10,
        maxBytes: 4096,
      },
    })) as { value: { matches: Array<{ path: string; line: number }> } };
    expect(searchResult.value.matches).toEqual([
      { path: "sub/match.txt", line: 1, column: 1, preview: "needle" },
    ]);
    const regexSearch = (await request(value.environment, {
      action: "file-execute",
      version: 1,
      remoteMarker: `moira-op-${"ac".repeat(16)}`,
      repositoryFullName: "owner/repository",
      request: {
        action: "search",
        path: "sub",
        query: "nee[a-z]+",
        mode: "regex",
        maxMatches: 10,
        maxBytes: 4096,
      },
    })) as { value: { matches: Array<{ path: string; line: number }>; truncated: boolean } };
    expect(regexSearch.value).toEqual({
      action: "search",
      matches: [{ path: "sub/match.txt", line: 1, column: 1, preview: "needle" }],
      truncated: false,
    });
    const truncatedBound = Buffer.byteLength(
      JSON.stringify({ action: "search", matches: [], truncated: false }),
    );
    const truncatedSearch = (await request(value.environment, {
      action: "file-execute",
      version: 1,
      remoteMarker: `moira-op-${"ab".repeat(16)}`,
      repositoryFullName: "owner/repository",
      request: {
        action: "search",
        path: "sub",
        query: "needle",
        mode: "literal",
        maxMatches: 10,
        maxBytes: truncatedBound,
      },
    })) as { value: { action: string; matches: unknown[]; truncated: boolean } };
    expect(truncatedSearch.value).toEqual({ action: "search", matches: [], truncated: true });
    expect(Buffer.byteLength(JSON.stringify(truncatedSearch.value))).toBeLessThanOrEqual(
      truncatedBound,
    );
    const equivalent = (await request(value.environment, {
      action: "file-execute",
      version: 1,
      remoteMarker: `moira-op-${"9".repeat(32)}`,
      repositoryFullName: "owner/repository",
      request: { action: "stat", path: "sub\\match.txt" },
    })) as { value: { stat: { path: string } } };
    expect(equivalent.value.stat.path).toBe("sub/match.txt");

    const binary = Buffer.from([0, 255, 1, 2, 3]);
    const writeResult = (await request(value.environment, {
      action: "file-execute",
      version: 1,
      remoteMarker: `moira-op-${"a".repeat(32)}`,
      repositoryFullName: "owner/repository",
      request: {
        action: "write",
        path: "binary.dat",
        bytesBase64: binary.toString("base64"),
        expected: { exists: false },
      },
    })) as { value: { current: { sha256: string } } };
    expect(readFileSync(join(value.repository, "binary.dat"))).toEqual(binary);
    expect(writeResult.value.current.sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  test("a small partial read streams its whole-file hash with bounded buffers", async () => {
    const value = fixture();
    const bytes = Buffer.alloc(1024 * 1024, "a");
    const path = join(value.repository, "small.bin");
    writeFileSync(path, bytes);
    const audit = join(value.stateRoot, "small-reads.jsonl");
    const outcome = await request(
      value.environment,
      {
        action: "file-execute",
        version: 1,
        remoteMarker: `moira-op-${"d7".repeat(16)}`,
        repositoryFullName: "owner/repository",
        request: { action: "read", path: "small.bin", offset: 7, length: 11 },
      },
      (source) =>
        source.replace(
          "handle.moiraPath = join(parent.moiraPath, name);",
          `handle.moiraPath = join(parent.moiraPath, name);
if(handle.moiraPath===${JSON.stringify(path)}){
 const actualRead=handle.read.bind(handle);
 handle.read=async(buffer,offset,length,position)=>{
  await writeFile(${JSON.stringify(audit)},JSON.stringify({bufferBytes:buffer.length,length})+'\\n',{flag:'a'});
  return actualRead(buffer,offset,length,position);
 };
}`,
        ),
    );
    expect(outcome).toMatchObject({
      state: "succeeded",
      value: {
        sha256: createHash("sha256").update(bytes).digest("hex"),
        rangeSha256: createHash("sha256").update(bytes.subarray(7, 18)).digest("hex"),
        bytesBase64: bytes.subarray(7, 18).toString("base64"),
      },
    });
    const reads = readFileSync(audit, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { bufferBytes: number; length: number });
    expect(reads.reduce((total, read) => total + read.length, 0)).toBe(bytes.length + 11);
    for (const read of reads) expect(read.bufferBytes).toBeLessThanOrEqual(256 * 1024);
  });

  test.each(["parent", "content"] as const)(
    "a range rejects concurrent %s substitution",
    async (change) => {
      const value = fixture();
      const parent = join(value.repository, "sub");
      mkdirSync(parent);
      const path = join(parent, "file.txt");
      writeFileSync(path, "abc");
      const oldParent = join(value.repository, "old-sub");
      const result = await request(
        value.environment,
        {
          action: "file-execute",
          version: 1,
          remoteMarker: `moira-op-${(change === "parent" ? "d8" : "d9").repeat(16)}`,
          repositoryFullName: "owner/repository",
          request: { action: "read", path: "sub/file.txt", offset: 0, length: 1 },
        },
        (source) =>
          source.replace(
            "handle.moiraPath = join(parent.moiraPath, name);",
            `handle.moiraPath = join(parent.moiraPath, name);
if(handle.moiraPath===${JSON.stringify(path)}){
 const actualRead=handle.read.bind(handle);let changed=false;
 handle.read=async(...args)=>{
  const read=await actualRead(...args);
  if(!changed){changed=true;${change === "parent" ? `await rename(${JSON.stringify(parent)},${JSON.stringify(oldParent)});await mkdir(${JSON.stringify(parent)});await writeFile(${JSON.stringify(path)},'abc');` : `await writeFile(${JSON.stringify(path)},'changed');`}}
  return read;
 };
}`,
          ),
      );
      expect(result).toMatchObject({
        state: "failed",
        value: { code: "CODESPACE_FILE_REJECTED", reason: "concurrent_change" },
      });
      if (change === "parent") {
        expect(statSync(join(oldParent, "file.txt")).nlink).toBe(1);
        expect(readFileSync(join(oldParent, "file.txt"), "utf8")).toBe("abc");
      }
    },
  );

  test("EOF ranges remain empty while invalid ranges and oversized whole-file edits stay refused", async () => {
    const value = fixture();
    const path = join(value.repository, "large.bin");
    const size = 8 * 1024 * 1024;
    const fd = openSync(path, "w");
    try {
      ftruncateSync(fd, size);
    } finally {
      closeSync(fd);
    }
    const send = (suffix: string, requestValue: Record<string, unknown>) =>
      request(value.environment, {
        action: "file-execute",
        version: 1,
        remoteMarker: `moira-op-${suffix.repeat(16)}`,
        repositoryFullName: "owner/repository",
        request: requestValue,
      });
    expect(
      await send("e3", { action: "read", path: "large.bin", offset: size, length: 1 }),
    ).toMatchObject({
      state: "succeeded",
      value: {
        totalSize: size,
        bytesBase64: "",
        sha256: null,
        rangeSha256: createHash("sha256").update("").digest("hex"),
      },
    });
    expect(
      await send("e4", { action: "read", path: "large.bin", offset: size + 1, length: 1 }),
    ).toMatchObject({ state: "failed", value: { reason: "invalid_range" } });
    expect(
      await send("e5", {
        action: "read",
        path: "large.bin",
        offset: 0,
        length: 4 * 1024 * 1024 + 1,
      }),
    ).toMatchObject({ state: "failed", value: { reason: "size_limit" } });
    expect(
      await send("e6", { action: "download", path: "large.bin", maxBytes: 4 * 1024 * 1024 }),
    ).toMatchObject({ state: "failed", value: { reason: "size_limit" } });
    expect(
      await send("e7", {
        action: "write",
        path: "large.bin",
        bytesBase64: Buffer.from("replacement").toString("base64"),
        expected: { exists: true, size },
      }),
    ).toMatchObject({ state: "failed", value: { reason: "size_limit" } });
    expect(statSync(path).size).toBe(size);
    expect(
      await send("e8", {
        action: "write",
        path: "new.bin",
        bytesBase64: Buffer.alloc(4 * 1024 * 1024 + 1).toString("base64"),
        expected: { exists: false },
      }),
    ).toMatchObject({ state: "failed", value: { reason: "size_limit" } });
    expect(existsSync(join(value.repository, "new.bin"))).toBe(false);
    writeFileSync(join(value.repository, "empty.bin"), "");
    expect(await send("e9", { action: "download", path: "empty.bin", maxBytes: 1 })).toMatchObject({
      state: "succeeded",
      value: {
        totalSize: 0,
        offset: 0,
        bytesBase64: "",
        sha256: createHash("sha256").update("").digest("hex"),
      },
    });
  });

  test("searches repository content without descending into version-control internals", async () => {
    const value = fixture();
    // The fixture repository is a real one, so .git already holds refs, config and logs.
    writeFileSync(join(value.repository, ".git", "description"), "needle in the git directory\n");
    writeFileSync(join(value.repository, ".gitignore"), "needle in an ordinary dot-file\n");

    const onlyInsideGit = (await request(value.environment, {
      action: "file-execute",
      version: 1,
      remoteMarker: `moira-op-${"7a".repeat(16)}`,
      repositoryFullName: "owner/repository",
      request: {
        action: "search",
        path: ".",
        query: "needle in the git directory",
        mode: "literal",
        maxMatches: 10,
        maxBytes: 4096,
      },
    })) as { value: { matches: unknown[]; truncated: boolean } };
    // No match, and skipping a directory is not a truncated result.
    expect(onlyInsideGit.value).toEqual({ action: "search", matches: [], truncated: false });

    writeFileSync(join(value.repository, "notes.txt"), "shared needle\n");
    writeFileSync(join(value.repository, ".git", "shared.txt"), "shared needle\n");
    const insideAndOutside = (await request(value.environment, {
      action: "file-execute",
      version: 1,
      remoteMarker: `moira-op-${"7b".repeat(16)}`,
      repositoryFullName: "owner/repository",
      request: {
        action: "search",
        path: ".",
        query: "shared needle",
        mode: "literal",
        maxMatches: 10,
        maxBytes: 4096,
      },
    })) as { value: { matches: Array<{ path: string }> } };
    expect(insideAndOutside.value.matches).toEqual([
      { path: "notes.txt", line: 1, column: 1, preview: "shared needle" },
    ]);

    const ordinaryDotFile = (await request(value.environment, {
      action: "file-execute",
      version: 1,
      remoteMarker: `moira-op-${"7c".repeat(16)}`,
      repositoryFullName: "owner/repository",
      request: {
        action: "search",
        path: ".",
        query: "ordinary dot-file",
        mode: "literal",
        maxMatches: 10,
        maxBytes: 4096,
      },
    })) as { value: { matches: Array<{ path: string }> } };
    expect(ordinaryDotFile.value.matches).toEqual([
      { path: ".gitignore", line: 1, column: 14, preview: "needle in an ordinary dot-file" },
    ]);

    const rootedAtGit = (await request(value.environment, {
      action: "file-execute",
      version: 1,
      remoteMarker: `moira-op-${"7d".repeat(16)}`,
      repositoryFullName: "owner/repository",
      request: {
        action: "search",
        path: ".git",
        query: "needle",
        mode: "literal",
        maxMatches: 10,
        maxBytes: 4096,
      },
    })) as { state: string };
    expect(rootedAtGit.state).toBe("failed");

    // The directory must exist, or the refusal would be indistinguishable from a missing path.
    mkdirSync(join(value.repository, ".git", "logs"), { recursive: true });
    writeFileSync(join(value.repository, ".git", "logs", "HEAD"), "needle in a reflog\n");
    const rootedInsideGit = (await request(value.environment, {
      action: "file-execute",
      version: 1,
      remoteMarker: `moira-op-${"7f".repeat(16)}`,
      repositoryFullName: "owner/repository",
      request: {
        action: "search",
        path: ".git/logs",
        query: "needle",
        mode: "literal",
        maxMatches: 10,
        maxBytes: 4096,
      },
    })) as { state: string };
    expect(rootedInsideGit.state).toBe("failed");

    // A file inside the git directory is still readable when the caller names it exactly.
    const readInsideGit = (await request(value.environment, {
      action: "file-execute",
      version: 1,
      remoteMarker: `moira-op-${"7e".repeat(16)}`,
      repositoryFullName: "owner/repository",
      request: { action: "read", path: ".git/description", offset: 0, length: 64 },
    })) as { state: string; value: { bytesBase64: string } };
    expect(readInsideGit.state).toBe("succeeded");
    expect(Buffer.from(readInsideGit.value.bytesBase64, "base64").toString()).toContain("needle");
  });

  test("terminates catastrophic regex matching at the search deadline", async () => {
    const value = fixture();
    mkdirSync(join(value.repository, "regex"));
    writeFileSync(join(value.repository, "regex", "adversarial.txt"), `${"a".repeat(10_000)}!`);
    // The deadline is shortened to 100 ms in the supervisor under test. Matching `(a+)+$` on this
    // line is exponential, so a search the deadline did not stop would never return and the test
    // would fail on its timeout; a truncated result is the deadline's own evidence, independent of
    // how busy the machine running the test is.
    let deadlineShortened = false;
    const result = await request(
      value.environment,
      {
        action: "file-execute",
        version: 1,
        remoteMarker: `moira-op-${"aa".repeat(16)}`,
        repositoryFullName: "owner/repository",
        request: {
          action: "search",
          path: "regex",
          query: "(a+)+$",
          mode: "regex",
          maxMatches: 10,
          maxBytes: 64 * 1024,
        },
      },
      (source) => {
        const shortened = source.replace(
          "const SEARCH_DEADLINE_MS = 5_000;",
          "const SEARCH_DEADLINE_MS = 100;",
        );
        deadlineShortened = shortened !== source;
        return shortened;
      },
    );
    // Otherwise the shipped five-second deadline would stop it too, and the test would prove less.
    expect(deadlineShortened).toBe(true);
    expect(result).toEqual({
      state: "succeeded",
      value: { action: "search", matches: [], truncated: true },
    });
  });

  test("rejects traversal, symlink, hard-link, special-file and stale write targets", async () => {
    const value = fixture();
    const outside = join(value.repository, "..", "outside.txt");
    writeFileSync(outside, "outside");
    symlinkSync(outside, join(value.repository, "linked.txt"));
    writeFileSync(join(value.repository, "original.txt"), "original");
    linkSync(join(value.repository, "original.txt"), join(value.repository, "hard.txt"));
    const fifo = join(value.repository, "special");
    expect(spawnSync("mkfifo", [fifo]).status).toBe(0);

    for (const [suffix, path] of [
      ["b", "../outside.txt"],
      ["c", "linked.txt"],
      ["d", "hard.txt"],
      ["e", "special"],
    ]) {
      await expect(
        request(value.environment, {
          action: "file-execute",
          version: 1,
          remoteMarker: `moira-op-${suffix.repeat(32)}`,
          repositoryFullName: "owner/repository",
          request: { action: "read", path, offset: 0, length: 64 },
        }),
      ).resolves.toMatchObject({
        state: "failed",
        value: {
          action: "read",
          state: "failed",
          code: "CODESPACE_FILE_REJECTED",
          reason: "unsafe_access",
        },
      });
      await expect(
        request(value.environment, {
          action: "file-execute",
          version: 1,
          remoteMarker: `moira-op-${suffix.repeat(31)}0`,
          repositoryFullName: "owner/repository",
          request: { action: "stat", path },
        }),
      ).resolves.toMatchObject({
        state: "failed",
        value: { action: "stat", reason: "unsafe_access" },
      });
    }
    // Restore a single-link target so the next refusal observes the expected-version guard.
    rmSync(join(value.repository, "hard.txt"));
    await expect(
      request(value.environment, {
        action: "file-execute",
        version: 1,
        remoteMarker: `moira-op-${"f".repeat(32)}`,
        repositoryFullName: "owner/repository",
        request: {
          action: "write",
          path: "original.txt",
          bytesBase64: Buffer.from("changed").toString("base64"),
          expected: { exists: true, sha256: "0".repeat(64) },
        },
      }),
    ).resolves.toMatchObject({
      state: "failed",
      value: {
        action: "write",
        state: "failed",
        code: "CODESPACE_FILE_REJECTED",
        reason: "precondition",
      },
    });
    expect(readFileSync(outside, "utf8")).toBe("outside");
    expect(readFileSync(join(value.repository, "original.txt"), "utf8")).toBe("original");
  });

  test("fails closed when a target or parent is substituted after staging", async () => {
    const value = fixture();
    const injectSubstitution = (source: string) =>
      source.replace(
        'await writeDurableJson(directory, "file-transaction.json", entries);',
        `await writeDurableJson(directory, "file-transaction.json", entries);
if (process.env.MOIRA_TEST_FILE_SUBSTITUTION === "target") {
  const injectedFs = await import("node:fs/promises");
  await injectedFs.rm(join(staged[0].root.path, "race.txt"));
  await injectedFs.writeFile(join(staged[0].root.path, "race.txt"), "original");
} else if (process.env.MOIRA_TEST_FILE_SUBSTITUTION === "parent") {
  const injectedFs = await import("node:fs/promises");
  await injectedFs.rename(join(staged[0].root.path, "sub"), join(staged[0].root.path, "sub-moved"));
  await injectedFs.symlink(process.env.MOIRA_TEST_OUTSIDE_DIR, join(staged[0].root.path, "sub"));
} else if (process.env.MOIRA_TEST_FILE_SUBSTITUTION === "absent-parent") {
  const injectedFs = await import("node:fs/promises");
  await injectedFs.rename(join(staged[0].root.path, "empty"), join(staged[0].root.path, "empty-moved"));
  await injectedFs.mkdir(join(staged[0].root.path, "empty"));
}`,
      );

    writeFileSync(join(value.repository, "race.txt"), "original");
    await expect(
      request(
        { ...value.environment, MOIRA_TEST_FILE_SUBSTITUTION: "target" },
        {
          action: "file-execute",
          version: 1,
          remoteMarker: `moira-op-${"3a".repeat(16)}`,
          repositoryFullName: "owner/repository",
          request: {
            action: "write",
            path: "race.txt",
            bytesBase64: Buffer.from("desired").toString("base64"),
            expected: { exists: true },
          },
        },
        injectSubstitution,
      ),
    ).resolves.toMatchObject({
      state: "failed",
      value: { action: "write", state: "failed", code: "CODESPACE_FILE_REJECTED" },
    });
    expect(readFileSync(join(value.repository, "race.txt"), "utf8")).toBe("original");

    const outside = join(value.repository, "..", "outside-directory");
    mkdirSync(join(value.repository, "sub"));
    mkdirSync(outside);
    writeFileSync(join(value.repository, "sub", "inside.txt"), "inside");
    writeFileSync(join(outside, "inside.txt"), "outside");
    await expect(
      request(
        {
          ...value.environment,
          MOIRA_TEST_FILE_SUBSTITUTION: "parent",
          MOIRA_TEST_OUTSIDE_DIR: outside,
        },
        {
          action: "file-execute",
          version: 1,
          remoteMarker: `moira-op-${"3b".repeat(16)}`,
          repositoryFullName: "owner/repository",
          request: {
            action: "write",
            path: "sub/inside.txt",
            bytesBase64: Buffer.from("desired").toString("base64"),
            expected: { exists: true },
          },
        },
        injectSubstitution,
      ),
    ).resolves.toMatchObject({
      state: "failed",
      value: { action: "write", state: "failed", code: "CODESPACE_FILE_REJECTED" },
    });
    expect(readFileSync(join(outside, "inside.txt"), "utf8")).toBe("outside");
    expect(readFileSync(join(value.repository, "sub-moved", "inside.txt"), "utf8")).toBe("inside");

    mkdirSync(join(value.repository, "empty"));
    await expect(
      request(
        { ...value.environment, MOIRA_TEST_FILE_SUBSTITUTION: "absent-parent" },
        {
          action: "file-execute",
          version: 1,
          remoteMarker: `moira-op-${"3f".repeat(16)}`,
          repositoryFullName: "owner/repository",
          request: {
            action: "write",
            path: "empty/new.txt",
            bytesBase64: Buffer.from("desired").toString("base64"),
            expected: { exists: false },
          },
        },
        injectSubstitution,
      ),
    ).resolves.toMatchObject({
      state: "failed",
      value: { action: "write", state: "failed", code: "CODESPACE_FILE_REJECTED" },
    });
    expect(existsSync(join(value.repository, "empty", "new.txt"))).toBe(false);
    expect(existsSync(join(value.repository, "empty-moved", "new.txt"))).toBe(false);
    if (process.platform === "linux") {
      expect(readdirSync(join(value.repository, "empty-moved"))).toEqual([]);
    }
  });

  test("gives one runner atomic ownership of an overlapping exact-marker mutation", async () => {
    const value = fixture();
    const remoteMarker = `moira-op-${"3c".repeat(16)}`;
    const operation = {
      action: "file-execute",
      version: 1,
      remoteMarker,
      repositoryFullName: "owner/repository",
      request: {
        action: "write",
        path: "exact-marker.txt",
        bytesBase64: Buffer.from("once").toString("base64"),
        expected: { exists: false },
      },
    };
    const delayOwner = (source: string) =>
      source.replace(
        'if (ownership === "retry") continue;',
        `if (ownership === "retry") continue;
if (process.env.MOIRA_TEST_HOLD_FILE_RUNNER === "1") {
  await new Promise((resolveHold) => setTimeout(resolveHold, 250));
}`,
      );
    const first = request(
      { ...value.environment, MOIRA_TEST_HOLD_FILE_RUNNER: "1" },
      operation,
      delayOwner,
    );
    const runnerPath = join(value.stateRoot, remoteMarker, "file-runner-pid");
    for (let attempt = 0; attempt < 100 && !existsSync(runnerPath); attempt++) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 5));
    }
    expect(existsSync(runnerPath)).toBe(true);
    await expect(request(value.environment, operation)).resolves.toEqual({ state: "running" });
    await expect(first).resolves.toMatchObject({
      state: "succeeded",
      value: { action: "write", path: "exact-marker.txt" },
    });
    await expect(
      request(value.environment, { action: "file-inspect", version: 1, remoteMarker }),
    ).resolves.toMatchObject({
      state: "succeeded",
      value: { action: "write", path: "exact-marker.txt" },
    });
    expect(readFileSync(join(value.repository, "exact-marker.txt"), "utf8")).toBe("once");
  });

  test("publishes a complete ownership candidate before the canonical marker", async () => {
    const value = fixture();
    const remoteMarker = `moira-op-${"3e".repeat(16)}`;
    const operation = {
      action: "file-execute",
      version: 1,
      remoteMarker,
      repositoryFullName: "owner/repository",
      request: {
        action: "write",
        path: "candidate-race.txt",
        bytesBase64: Buffer.from("winner").toString("base64"),
        expected: { exists: false },
      },
    };
    const delayPublication = (source: string) =>
      source.replace(
        "await link(candidate, target);",
        `if (process.env.MOIRA_TEST_HOLD_FILE_CANDIDATE === "1") {
  await new Promise((resolveHold) => setTimeout(resolveHold, 1000));
}
      await link(candidate, target);`,
      );
    const first = request(
      { ...value.environment, MOIRA_TEST_HOLD_FILE_CANDIDATE: "1" },
      operation,
      delayPublication,
    );
    const operationDirectory = join(value.stateRoot, remoteMarker);
    for (let attempt = 0; attempt < 100; attempt++) {
      if (
        existsSync(operationDirectory) &&
        readdirSync(operationDirectory).some((name) => name.startsWith(".file-runner-candidate-"))
      ) {
        break;
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, 5));
    }
    expect(readdirSync(operationDirectory)).toEqual(
      expect.arrayContaining([expect.stringMatching(/^\.file-runner-candidate-/)]),
    );
    await expect(request(value.environment, operation)).resolves.toMatchObject({
      state: "succeeded",
      value: { action: "write", path: "candidate-race.txt" },
    });
    await expect(first).resolves.toMatchObject({
      state: "succeeded",
      value: { action: "write", path: "candidate-race.txt" },
    });
    expect(readFileSync(join(value.repository, "candidate-race.txt"), "utf8")).toBe("winner");
  });

  test("atomically displaces a dead exact-marker owner before recovery", async () => {
    const value = fixture();
    const remoteMarker = `moira-op-${"3d".repeat(16)}`;
    const operationDirectory = join(value.stateRoot, remoteMarker);
    mkdirSync(operationDirectory, { recursive: true });
    writeFileSync(
      join(operationDirectory, "file-runner-pid"),
      JSON.stringify({ pid: 2_147_483_647, startTime: null }),
    );
    await expect(
      request(value.environment, {
        action: "file-execute",
        version: 1,
        remoteMarker,
        repositoryFullName: "owner/repository",
        request: {
          action: "write",
          path: "recovered-owner.txt",
          bytesBase64: Buffer.from("recovered").toString("base64"),
          expected: { exists: false },
        },
      }),
    ).resolves.toMatchObject({
      state: "succeeded",
      value: { action: "write", path: "recovered-owner.txt" },
    });
    expect(readFileSync(join(value.repository, "recovered-owner.txt"), "utf8")).toBe("recovered");
    expect(existsSync(join(operationDirectory, "file-runner-pid"))).toBe(true);
  });

  test("a dead commit holder releases the OS lock while reads and a conflicting new write remain safe", async () => {
    const value = fixture();
    const firstMarker = `moira-op-${"4a".repeat(16)}`;
    const target = join(value.repository, "concurrent.txt");
    writeFileSync(target, "original");
    const held = join(value.stateRoot, "commit-held");
    const write = (remoteMarker: string, content: string) => ({
      action: "file-execute",
      version: 1,
      remoteMarker,
      repositoryFullName: "owner/repository",
      request: {
        action: "write",
        path: "concurrent.txt",
        bytesBase64: Buffer.from(content).toString("base64"),
        expected: { exists: true, sha256: createHash("sha256").update("original").digest("hex") },
      },
    });
    const first = request(value.environment, write(firstMarker, "first"), (source) =>
      source.replace(
        'await writeDurableJson(directory, "file-transaction.json", entries);',
        'await writeDurableJson(directory, "file-transaction.json", entries);\nawait writeFile(join(STATE_ROOT, "commit-held"), "1");\nawait new Promise(() => {});',
      ),
    ).then(
      () => {
        throw new Error("Held commit unexpectedly completed");
      },
      () => undefined,
    );
    for (let attempt = 0; attempt < 1000 && !existsSync(held); attempt++)
      await new Promise((done) => setTimeout(done, 5));
    expect(existsSync(held)).toBe(true);
    const runner = JSON.parse(
      readFileSync(join(value.stateRoot, firstMarker, "file-runner-pid"), "utf8"),
    ) as { pid: number };
    const second = request(value.environment, write(`moira-op-${"4b".repeat(16)}`, "second"));
    try {
      const read = (await request(value.environment, {
        action: "file-execute",
        version: 1,
        remoteMarker: `moira-op-${"4c".repeat(16)}`,
        repositoryFullName: "owner/repository",
        request: { action: "read", path: "concurrent.txt", offset: 0, length: 20 },
      })) as { value: { bytesBase64: string } };
      expect(Buffer.from(read.value.bytesBase64, "base64").toString()).toBe("original");
    } finally {
      process.kill(runner.pid, "SIGKILL");
      await first;
    }
    await expect(second).resolves.toMatchObject({ state: "succeeded" });
    expect(readFileSync(target, "utf8")).toBe("second");
    await expect(
      request(value.environment, { action: "file-inspect", version: 1, remoteMarker: firstMarker }),
    ).resolves.toMatchObject({
      state: "failed",
      value: { code: "CODESPACE_OPERATION_INTERRUPTED" },
    });
    expect(readFileSync(target, "utf8")).toBe("second");
  });

  test.each(["write", "upload", "apply_patch"] as const)(
    "crashed %s recovery preserves substituted target and backup inodes",
    async (action) => {
      for (const substituted of ["target", "backup"] as const) {
        const value = fixture();
        const marker = `moira-op-${randomUUID().replaceAll("-", "")}`;
        const target = join(value.repository, "recover.txt");
        writeFileSync(target, "original");
        const replacement = Buffer.from("desired").toString("base64");
        const requestValue =
          action === "apply_patch"
            ? {
                action,
                summaryMaxBytes: 4096,
                files: [
                  {
                    path: "recover.txt",
                    expected: { exists: true },
                    edits: [{ start: 0, end: 8, bytesBase64: replacement }],
                  },
                ],
              }
            : { action, path: "recover.txt", expected: { exists: true }, bytesBase64: replacement };
        let injected = false;
        await expect(
          request(
            value.environment,
            {
              action: "file-execute",
              version: 1,
              remoteMarker: marker,
              repositoryFullName: "owner/repository",
              request: requestValue,
            },
            (source) => {
              const changed = source.replace(
                "await verifyEntryIdentity(item.handle, item.name, item.identity);",
                "await verifyEntryIdentity(item.handle, item.name, item.identity); process.exit(91);",
              );
              injected = changed !== source;
              return changed;
            },
          ),
        ).rejects.toThrow();
        expect(injected).toBe(true);
        const directory = join(value.stateRoot, marker);
        const [entry] = JSON.parse(readFileSync(join(directory, "file-transaction.json"), "utf8"));
        const backup = join(value.repository, entry.backup);
        expect(readFileSync(target, "utf8")).toBe("desired");
        expect(readFileSync(backup, "utf8")).toBe("original");
        const foreign = substituted === "target" ? target : backup;
        const untouched = substituted === "target" ? backup : target;
        const untouchedInode = statSync(untouched).ino;
        const untouchedBytes = readFileSync(untouched);
        const bytes = readFileSync(foreign);
        const oldInode = statSync(foreign).ino;
        renameSync(foreign, `${foreign}.pinned`);
        writeFileSync(foreign, bytes);
        const foreignInode = statSync(foreign).ino;
        expect(foreignInode).not.toBe(oldInode);
        expect(
          await request(value.environment, {
            action: "file-inspect",
            version: 1,
            remoteMarker: marker,
          }),
        ).toMatchObject({ state: "failed", value: { code: "CODESPACE_OPERATION_INTERRUPTED" } });
        expect(statSync(foreign).ino).toBe(foreignInode);
        expect(readFileSync(foreign).equals(bytes)).toBe(true);
        expect(statSync(untouched).ino).toBe(untouchedInode);
        expect(readFileSync(untouched).equals(untouchedBytes)).toBe(true);
        expect(existsSync(join(directory, "file-transaction.conflicted.json"))).toBe(true);
      }
    },
  );

  test.each(["target", "backup"] as const)(
    "live rollback refuses a substituted %s instead of overwriting foreign bytes",
    async (substituted) => {
      const value = fixture();
      const marker = `moira-op-${randomUUID().replaceAll("-", "")}`;
      const target = join(value.repository, "rollback.txt");
      const audit = join(value.stateRoot, "foreign-entry.json");
      writeFileSync(target, "original");
      let injected = false;
      const result = await request(
        value.environment,
        {
          action: "file-execute",
          version: 1,
          remoteMarker: marker,
          repositoryFullName: "owner/repository",
          request: {
            action: "write",
            path: "rollback.txt",
            expected: { exists: true },
            bytesBase64: Buffer.from("desired").toString("base64"),
          },
        },
        (source) => {
          const changed = source.replace(
            "await verifyEntryIdentity(item.handle, item.name, item.identity);",
            `await verifyEntryIdentity(item.handle, item.name, item.identity);
const foreign = ${substituted === "target" ? "target" : "backup"};
const foreignBytes = await readFile(foreign);
await rename(foreign, foreign + '.pinned');
await writeFile(foreign, foreignBytes);
await writeFile(${JSON.stringify(audit)}, JSON.stringify({path:await realpath(foreign),ino:(await stat(foreign)).ino,bytes:foreignBytes.toString('base64')}));
fail('injected commit failure');`,
          );
          injected = changed !== source;
          return changed;
        },
      ).catch(() => ({ state: "refused" }));
      expect(injected).toBe(true);
      expect(["failed", "refused"]).toContain((result as { state: string }).state);
      const foreign = JSON.parse(readFileSync(audit, "utf8"));
      expect(statSync(foreign.path).ino).toBe(foreign.ino);
      expect(readFileSync(foreign.path).toString("base64")).toBe(foreign.bytes);
    },
  );

  test("preflights every structured patch target before committing any file", async () => {
    const value = fixture();
    writeFileSync(join(value.repository, "one.txt"), "one");
    writeFileSync(join(value.repository, "two.txt"), "two");
    await expect(
      request(value.environment, {
        action: "file-execute",
        version: 1,
        remoteMarker: `moira-op-${"1a".repeat(16)}`,
        repositoryFullName: "owner/repository",
        request: {
          action: "apply_patch",
          summaryMaxBytes: 4096,
          files: [
            {
              path: "one.txt",
              expected: { exists: true },
              edits: [{ start: 0, end: 3, bytesBase64: Buffer.from("ONE").toString("base64") }],
            },
            {
              path: "two.txt",
              expected: { exists: true, sha256: "0".repeat(64) },
              edits: [{ start: 0, end: 3, bytesBase64: Buffer.from("TWO").toString("base64") }],
            },
          ],
        },
      }),
    ).resolves.toMatchObject({
      state: "failed",
      value: { action: "apply_patch", state: "failed", code: "CODESPACE_FILE_REJECTED" },
    });
    expect(readFileSync(join(value.repository, "one.txt"), "utf8")).toBe("one");
    expect(readFileSync(join(value.repository, "two.txt"), "utf8")).toBe("two");
    expect(readdirSync(value.repository).filter((name) => name.startsWith(".moira-"))).toEqual([]);
  });

  test.each([
    ["missing", undefined],
    ["below minimum", 255],
    ["above hard ceiling", 65_537],
  ] as const)(
    "rejects a %s patch-summary budget without target mutation",
    async (_name, budget) => {
      const value = fixture();
      writeFileSync(join(value.repository, "bounded.txt"), "original");
      const requestValue = {
        action: "apply_patch",
        ...(budget === undefined ? {} : { summaryMaxBytes: budget }),
        files: [
          {
            path: "bounded.txt",
            expected: { exists: true },
            edits: [{ start: 0, end: 8, bytesBase64: Buffer.from("changed").toString("base64") }],
          },
        ],
      };
      await expect(
        request(value.environment, {
          action: "file-execute",
          version: 1,
          remoteMarker: `moira-op-${String(budget ?? 0).padStart(32, "0")}`,
          repositoryFullName: "owner/repository",
          request: requestValue,
        }),
      ).resolves.toMatchObject({
        state: "failed",
        value: { action: "apply_patch", state: "failed", code: "CODESPACE_FILE_REJECTED" },
      });
      expect(readFileSync(join(value.repository, "bounded.txt"), "utf8")).toBe("original");
      expect(readdirSync(value.repository).filter((entry) => entry.startsWith(".moira-"))).toEqual(
        [],
      );
    },
  );

  test("commits a structured multi-file patch as one preconditioned result", async () => {
    const value = fixture();
    writeFileSync(join(value.repository, "one.txt"), "one");
    writeFileSync(join(value.repository, "two.txt"), "two");
    const result = (await request(value.environment, {
      action: "file-execute",
      version: 1,
      remoteMarker: `moira-op-${"1b".repeat(16)}`,
      repositoryFullName: "owner/repository",
      request: {
        action: "apply_patch",
        summaryMaxBytes: 4096,
        files: [
          {
            path: "one.txt",
            expected: { exists: true },
            edits: [{ start: 0, end: 3, bytesBase64: Buffer.from("ONE").toString("base64") }],
          },
          {
            path: "two.txt",
            expected: { exists: true },
            edits: [{ start: 0, end: 3, bytesBase64: Buffer.from("TWO").toString("base64") }],
          },
        ],
      },
    })) as {
      value: {
        files: Array<{ path: string; current: { sha256: string } }>;
        summary: Record<string, unknown>;
      };
    };
    expect(readFileSync(join(value.repository, "one.txt"), "utf8")).toBe("ONE");
    expect(readFileSync(join(value.repository, "two.txt"), "utf8")).toBe("TWO");
    expect(result.value.files).toEqual([
      {
        path: "one.txt",
        previous: expect.any(Object),
        current: expect.objectContaining({ sha256: expect.stringMatching(/^[a-f0-9]{64}$/) }),
      },
      {
        path: "two.txt",
        previous: expect.any(Object),
        current: expect.objectContaining({ sha256: expect.stringMatching(/^[a-f0-9]{64}$/) }),
      },
    ]);
    expect(result.value.summary).toEqual({
      filesChanged: 2,
      editsApplied: 2,
      insertedBytes: 6,
      deletedBytes: 6,
      entries: [
        { path: "one.txt", edits: 1, insertedBytes: 3, deletedBytes: 3 },
        { path: "two.txt", edits: 1, insertedBytes: 3, deletedBytes: 3 },
      ],
      truncated: false,
    });
  });

  test("bounds a structured patch summary while retaining complete aggregate totals", async () => {
    const value = fixture();
    mkdirSync(join(value.repository, "many"));
    const files = Array.from({ length: 64 }, (_, index) => {
      const path = `many/file-${index.toString().padStart(2, "0")}.txt`;
      writeFileSync(join(value.repository, path), "a");
      return {
        path,
        expected: { exists: true },
        edits: [{ start: 0, end: 1, bytesBase64: Buffer.from("b").toString("base64") }],
      };
    });
    const result = (await request(value.environment, {
      action: "file-execute",
      version: 1,
      remoteMarker: `moira-op-${"1c".repeat(16)}`,
      repositoryFullName: "owner/repository",
      request: { action: "apply_patch", summaryMaxBytes: 512, files },
    })) as {
      value: {
        summary: {
          filesChanged: number;
          editsApplied: number;
          insertedBytes: number;
          deletedBytes: number;
          entries: unknown[];
          truncated: boolean;
        };
      };
    };
    expect(result.value.summary).toMatchObject({
      filesChanged: 64,
      editsApplied: 64,
      insertedBytes: 64,
      deletedBytes: 64,
      truncated: true,
    });
    expect(result.value.summary.entries.length).toBeLessThan(64);
    expect(Buffer.byteLength(JSON.stringify(result.value.summary))).toBeLessThanOrEqual(512);
    for (const file of files)
      expect(readFileSync(join(value.repository, file.path), "utf8")).toBe("b");
  });

  test.each(["recoverable", "externally changed", "historical without identities"] as const)(
    "new work proceeds after an abandoned %s commit without replaying or overwriting later edits",
    async (condition) => {
      const value = fixture();
      const remoteMarker = `moira-op-${"2a".repeat(16)}`;
      const operationDirectory = join(value.stateRoot, remoteMarker);
      mkdirSync(operationDirectory, { recursive: true });
      const target = join(value.repository, "recover.txt");
      const backup = join(value.repository, `.moira-${remoteMarker}-backup.bak`);
      const temporary = join(value.repository, `.moira-${remoteMarker}-staged.tmp`);
      const original = Buffer.from("original");
      const desired = Buffer.from("desired");
      writeFileSync(target, desired);
      if (condition === "externally changed") writeFileSync(target, "external edit");
      writeFileSync(backup, original);
      const requestValue = {
        action: "write",
        path: "recover.txt",
        bytesBase64: desired.toString("base64"),
        expected: {
          exists: true,
          size: original.length,
          sha256: createHash("sha256").update(original).digest("hex"),
        },
      };
      writeFileSync(
        join(operationDirectory, "file-intent.json"),
        JSON.stringify({
          action: "file-execute",
          version: 1,
          remoteMarker,
          repositoryFullName: "owner/repository",
          request: requestValue,
        }),
      );
      writeFileSync(
        join(operationDirectory, "file-transaction.json"),
        JSON.stringify([
          {
            target: "recover.txt",
            ...parentIdentity(value.repository),
            temporaryName: temporary.split("/").at(-1),
            backup: backup.split("/").at(-1),
            hadOriginal: true,
            originalSha256: createHash("sha256").update(original).digest("hex"),
            desiredSha256: createHash("sha256").update(desired).digest("hex"),
            ...(condition === "historical without identities"
              ? {}
              : {
                  originalIdentity: regularIdentity(backup),
                  desiredIdentity: regularIdentity(target),
                }),
          },
        ]),
      );

      const newer = Buffer.from("newer content");
      await expect(
        request(value.environment, {
          action: "file-execute",
          version: 1,
          remoteMarker: `moira-op-${"5a".repeat(16)}`,
          repositoryFullName: "owner/repository",
          request: {
            action: "write",
            path: condition === "recoverable" ? "recover.txt" : "unrelated.txt",
            bytesBase64: newer.toString("base64"),
            expected: condition === "recoverable" ? requestValue.expected : { exists: false },
          },
        }),
      ).resolves.toMatchObject({ state: "succeeded" });
      const result = (await request(value.environment, {
        action: "file-inspect",
        version: 1,
        remoteMarker,
      })) as { state: string; value: { action: string } };
      expect(result).toMatchObject({
        state: "failed",
        value: { action: "write", code: "CODESPACE_OPERATION_INTERRUPTED" },
      });
      expect(
        readFileSync(
          join(value.repository, condition === "recoverable" ? "recover.txt" : "unrelated.txt"),
        ),
      ).toEqual(newer);
      expect(readFileSync(target)).toEqual(
        condition === "recoverable"
          ? newer
          : condition === "externally changed"
            ? Buffer.from("external edit")
            : desired,
      );
      expect(existsSync(backup)).toBe(condition !== "recoverable");
      expect(existsSync(join(operationDirectory, "file-transaction.conflicted.json"))).toBe(
        condition !== "recoverable",
      );
      expect(existsSync(join(operationDirectory, "file-transaction.json"))).toBe(false);
      await expect(
        request(value.environment, { action: "finalize", version: 1, remoteMarker }),
      ).resolves.toEqual({ state: "absent" });
      expect(existsSync(join(operationDirectory, "file-transaction.conflicted.json"))).toBe(
        condition !== "recoverable",
      );
      expect(condition !== "recoverable" ? readFileSync(backup) : null).toEqual(
        condition !== "recoverable" ? original : null,
      );
    },
  );

  test.each([false, true])(
    "terminal receipt remains collectible while unowned journal entries stay untouched (modern=%s)",
    async (modern) => {
      const value = fixture();
      const marker = `moira-op-${"fa".repeat(16)}`;
      const directory = join(value.stateRoot, marker);
      mkdirSync(directory, { recursive: true });
      const target = join(value.repository, "historical.txt");
      const backupName = `.moira-${marker}-original.bak`;
      const backup = join(value.repository, backupName);
      writeFileSync(target, "desired");
      writeFileSync(backup, "original");
      const targetInode = statSync(target).ino;
      let backupInode = statSync(backup).ino;
      const operation = {
        action: "file-execute",
        version: 1,
        remoteMarker: marker,
        repositoryFullName: "owner/repository",
        request: {
          action: "write",
          path: "historical.txt",
          expected: { exists: true },
          bytesBase64: Buffer.from("desired").toString("base64"),
        },
      };
      writeFileSync(join(directory, "file-intent.json"), JSON.stringify(operation));
      writeFileSync(
        join(directory, "file-transaction.json"),
        JSON.stringify([
          {
            target: "historical.txt",
            ...parentIdentity(value.repository),
            temporaryName: `.moira-${marker}-staged.tmp`,
            backup: backupName,
            hadOriginal: true,
            originalSha256: createHash("sha256").update("original").digest("hex"),
            desiredSha256: createHash("sha256").update("desired").digest("hex"),
            ...(modern
              ? {
                  originalIdentity: regularIdentity(backup),
                  desiredIdentity: regularIdentity(target),
                }
              : {}),
          },
        ]),
      );
      if (modern) {
        renameSync(backup, `${backup}.pinned`);
        writeFileSync(backup, "original");
        expect(statSync(backup).ino).not.toBe(backupInode);
        backupInode = statSync(backup).ino;
      }
      const terminal = JSON.stringify({
        kind: "file",
        state: "succeeded",
        value: {
          action: "write",
          path: "historical.txt",
          previous: null,
          current: {
            size: 7,
            sha256: createHash("sha256").update("desired").digest("hex"),
            modifiedAt: 1,
          },
        },
      });
      writeFileSync(join(directory, "result.json"), terminal);
      expect(
        await request(value.environment, {
          action: "file-inspect",
          version: 1,
          remoteMarker: marker,
        }),
      ).toMatchObject({ state: "succeeded", value: { action: "write" } });
      expect(readFileSync(join(directory, "result.json"), "utf8")).toBe(terminal);
      expect(statSync(target).ino).toBe(targetInode);
      expect(statSync(backup).ino).toBe(backupInode);
      expect(readFileSync(target, "utf8")).toBe("desired");
      expect(readFileSync(backup, "utf8")).toBe("original");
      expect(existsSync(join(directory, "file-transaction.conflicted.json"))).toBe(true);
    },
  );

  test("fails crash recovery closed when an absent target parent was substituted", async () => {
    const value = fixture();
    const remoteMarker = `moira-op-${"2c".repeat(16)}`;
    const operationDirectory = join(value.stateRoot, remoteMarker);
    const parent = join(value.repository, "empty");
    const movedParent = join(value.repository, "empty-moved");
    mkdirSync(operationDirectory, { recursive: true });
    mkdirSync(parent);
    const identity = parentIdentity(parent);
    const temporaryName = `.moira-${remoteMarker}-staged.tmp`;
    const desired = Buffer.from("desired");
    writeFileSync(join(parent, temporaryName), desired);
    const requestValue = {
      action: "write",
      path: "empty/new.txt",
      bytesBase64: desired.toString("base64"),
      expected: { exists: false },
    };
    writeFileSync(
      join(operationDirectory, "file-intent.json"),
      JSON.stringify({
        action: "file-execute",
        version: 1,
        remoteMarker,
        repositoryFullName: "owner/repository",
        request: requestValue,
      }),
    );
    writeFileSync(
      join(operationDirectory, "file-transaction.json"),
      JSON.stringify([
        {
          target: "empty/new.txt",
          ...identity,
          temporaryName,
          backup: null,
          hadOriginal: false,
          originalSha256: null,
          desiredSha256: createHash("sha256").update(desired).digest("hex"),
        },
      ]),
    );
    renameSync(parent, movedParent);
    mkdirSync(parent);

    await expect(
      request(value.environment, { action: "file-inspect", version: 1, remoteMarker }),
    ).resolves.toMatchObject({
      state: "failed",
      value: { code: "CODESPACE_OPERATION_INTERRUPTED" },
    });
    expect(existsSync(join(parent, "new.txt"))).toBe(false);
    expect(existsSync(join(movedParent, "new.txt"))).toBe(false);
    expect(readFileSync(join(movedParent, temporaryName))).toEqual(desired);
  });

  test("rolls a partially committed multi-file journal back without replaying the mutation", async () => {
    const value = fixture();
    const remoteMarker = `moira-op-${"2b".repeat(16)}`;
    const operationDirectory = join(value.stateRoot, remoteMarker);
    mkdirSync(operationDirectory, { recursive: true });
    const originalOne = Buffer.from("one");
    const originalTwo = Buffer.from("two");
    const desiredOne = Buffer.from("ONE");
    const desiredTwo = Buffer.from("TWO");
    const targetOne = join(value.repository, "one.txt");
    const targetTwo = join(value.repository, "two.txt");
    const backupOne = join(value.repository, `.moira-${remoteMarker}-one.bak`);
    const backupTwo = join(value.repository, `.moira-${remoteMarker}-two.bak`);
    const temporaryOne = join(value.repository, `.moira-${remoteMarker}-one.tmp`);
    const temporaryTwo = join(value.repository, `.moira-${remoteMarker}-two.tmp`);
    writeFileSync(targetOne, desiredOne);
    writeFileSync(backupOne, originalOne);
    writeFileSync(targetTwo, originalTwo);
    writeFileSync(temporaryTwo, desiredTwo);
    const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
    const patchRequest = {
      action: "apply_patch",
      summaryMaxBytes: 4096,
      files: [
        {
          path: "one.txt",
          expected: { exists: true, size: 3, sha256: digest(originalOne) },
          edits: [{ start: 0, end: 3, bytesBase64: desiredOne.toString("base64") }],
        },
        {
          path: "two.txt",
          expected: { exists: true, size: 3, sha256: digest(originalTwo) },
          edits: [{ start: 0, end: 3, bytesBase64: desiredTwo.toString("base64") }],
        },
      ],
    };
    writeFileSync(
      join(operationDirectory, "file-intent.json"),
      JSON.stringify({
        action: "file-execute",
        version: 1,
        remoteMarker,
        repositoryFullName: "owner/repository",
        request: patchRequest,
      }),
    );
    writeFileSync(
      join(operationDirectory, "file-transaction.json"),
      JSON.stringify([
        {
          target: "one.txt",
          ...parentIdentity(value.repository),
          temporaryName: temporaryOne.split("/").at(-1),
          backup: backupOne.split("/").at(-1),
          hadOriginal: true,
          originalSha256: digest(originalOne),
          desiredSha256: digest(desiredOne),
          originalIdentity: regularIdentity(backupOne),
          desiredIdentity: regularIdentity(targetOne),
        },
        {
          target: "two.txt",
          ...parentIdentity(value.repository),
          temporaryName: temporaryTwo.split("/").at(-1),
          backup: backupTwo.split("/").at(-1),
          hadOriginal: true,
          originalSha256: digest(originalTwo),
          desiredSha256: digest(desiredTwo),
          originalIdentity: regularIdentity(targetTwo),
          desiredIdentity: regularIdentity(temporaryTwo),
        },
      ]),
    );

    const result = (await request(value.environment, {
      action: "file-inspect",
      version: 1,
      remoteMarker,
    })) as { state: string; value: { action: string; files: unknown[] } };
    expect(result).toMatchObject({
      state: "failed",
      value: { action: "apply_patch", code: "CODESPACE_OPERATION_INTERRUPTED" },
    });
    expect(readFileSync(targetOne)).toEqual(originalOne);
    expect(readFileSync(targetTwo)).toEqual(originalTwo);
    for (const path of [backupOne, backupTwo, temporaryOne, temporaryTwo]) {
      expect(existsSync(path)).toBe(false);
    }
  });

  test.each([
    [0, "succeeded"],
    [23, "failed"],
  ] as const)("preserves argv/stdin and reports exact exit %i", async (exitCode, state) => {
    const value = fixture();
    const remoteMarker = `moira-op-${exitCode === 0 ? "0" : "1".repeat(32)}`.padEnd(
      "moira-op-".length + 32,
      "0",
    );
    const script =
      "let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>{process.stdout.write(process.argv[1]+'|'+s);process.stderr.write('err');process.exit(Number(process.argv[2]));});";
    await expect(
      request(value.environment, {
        action: "execute",
        version: 1,
        remoteMarker,
        repositoryFullName: "owner/repository",
        argv: [process.execPath, "-e", script, "argument with spaces;$(false)", String(exitCode)],
        cwd: ".",
        stdin: Buffer.from("native stdin").toString("base64"),
        timeoutMs: 5_000,
        maxStdoutBytes: 4096,
        maxStderrBytes: 4096,
        maxRetainedBytes: 1024 * 1024,
      }),
    ).resolves.toEqual({ state: "running" });
    const terminal = {
      state,
      stdout: "argument with spaces;$(false)|native stdin",
      stderr: "err",
      exitCode,
      stdoutBytes: "argument with spaces;$(false)|native stdin".length,
      stderrBytes: 3,
      outputLimitExceeded: false,
      sessionCaptureDropped: false,
    };
    await expect(inspectUntilTerminal(value.environment, remoteMarker)).resolves.toEqual(terminal);
    await expect(
      request(value.environment, { action: "inspect", version: 1, remoteMarker }),
    ).resolves.toEqual(terminal);
    await expect(
      request(value.environment, { action: "finalize", version: 1, remoteMarker }),
    ).resolves.toEqual({ state: "absent" });
    await expect(
      request(value.environment, { action: "inspect", version: 1, remoteMarker }),
    ).resolves.toEqual({ state: "absent" });
  });

  test("publishes the result of a command that exits before its stdin is written", async () => {
    const value = fixture();
    const remoteMarker = `moira-op-${"6".repeat(32)}`;
    // /bin/echo exits without reading stdin, so a large payload reaches a closed pipe while
    // the runner is still recording the child's identity.
    await expect(
      request(value.environment, {
        action: "execute",
        version: 1,
        remoteMarker,
        repositoryFullName: "owner/repository",
        argv: ["/bin/echo", "fast"],
        cwd: ".",
        stdin: Buffer.from("x".repeat(256 * 1024)).toString("base64"),
        timeoutMs: 5_000,
        maxStdoutBytes: 4096,
        maxStderrBytes: 4096,
        maxRetainedBytes: 1024 * 1024,
      }),
    ).resolves.toEqual({ state: "running" });
    await expect(inspectUntilTerminal(value.environment, remoteMarker)).resolves.toEqual({
      state: "succeeded",
      stdout: "fast\n",
      stderr: "",
      exitCode: 0,
      stdoutBytes: 5,
      stderrBytes: 0,
      outputLimitExceeded: false,
      sessionCaptureDropped: false,
    });
  });

  test("keeps a noisy command's own outcome and every byte it printed", async () => {
    const value = fixture();
    const remoteMarker = `moira-op-${"7".repeat(32)}`;
    // Far more than the response payload may carry, ending with a marker that only a reader of
    // the last bytes can see, and then an exit code and standard error of the command's own.
    const script =
      "for(let i=0;i<200;i++)process.stdout.write('x'.repeat(1024));" +
      "process.stdout.write('TAIL');process.stderr.write('real failure');process.exitCode=7";
    await request(value.environment, {
      action: "execute",
      version: 1,
      remoteMarker,
      repositoryFullName: "owner/repository",
      argv: [process.execPath, "-e", script],
      cwd: ".",
      stdin: "",
      timeoutMs: 10_000,
      maxStdoutBytes: 4096,
      maxStderrBytes: 4096,
      maxRetainedBytes: 1024 * 1024,
    });
    const terminal = (await inspectUntilTerminal(value.environment, remoteMarker)) as Record<
      string,
      unknown
    >;
    const totalStdout = 200 * 1024 + 4;
    expect(terminal).toMatchObject({
      state: "failed",
      exitCode: 7,
      stderr: "real failure",
      stdoutBytes: totalStdout,
      outputLimitExceeded: false,
    });
    // The payload is a bounded prefix of the real stream, not a replacement for it.
    expect(Buffer.byteLength(terminal.stdout as string)).toBe(4096);

    const tail = (await request(value.environment, {
      action: "output",
      version: 1,
      remoteMarker,
      stream: "stdout",
      offset: totalStdout - 4,
      length: 64,
    })) as { totalBytes: number; bytesBase64: string; offset: number; stream: string };
    expect(tail).toMatchObject({
      stream: "stdout",
      offset: totalStdout - 4,
      totalBytes: totalStdout,
    });
    expect(Buffer.from(tail.bytesBase64, "base64").toString("utf8")).toBe("TAIL");

    const middle = (await request(value.environment, {
      action: "output",
      version: 1,
      remoteMarker,
      stream: "stdout",
      offset: 4096,
      length: 8,
    })) as { bytesBase64: string };
    expect(Buffer.from(middle.bytesBase64, "base64").toString("utf8")).toBe("x".repeat(8));

    // A read that starts at the end answers with no bytes and the current size, so a caller can
    // find the end of a stream without provoking an error.
    for (const offset of [12, 4096]) {
      const past = (await request(value.environment, {
        action: "output",
        version: 1,
        remoteMarker,
        stream: "stderr",
        offset,
        length: 64,
      })) as { totalBytes: number; bytesBase64: string };
      expect(past).toMatchObject({ totalBytes: 12, bytesBase64: "" });
    }

    await expect(
      request(value.environment, { action: "finalize", version: 1, remoteMarker }),
    ).resolves.toEqual({ state: "absent" });
    // Cleanup removes the retained streams with the result they belong to.
    await expect(
      request(value.environment, {
        action: "output",
        version: 1,
        remoteMarker,
        stream: "stdout",
        offset: 0,
        length: 8,
      }),
    ).resolves.toEqual({ state: "absent" });
  });

  test("accepts a command whose own timer outlives any request", async () => {
    const value = fixture();
    const remoteMarker = `moira-op-${"8".repeat(32)}`;
    // Three hours is far past the bound a single request could wait for; the command itself is
    // short, so the test observes admission and collection rather than elapsed time.
    await expect(
      request(value.environment, {
        action: "execute",
        version: 1,
        remoteMarker,
        repositoryFullName: "owner/repository",
        argv: ["/bin/echo", "long"],
        cwd: ".",
        stdin: "",
        timeoutMs: 3 * 60 * 60_000,
        maxStdoutBytes: 4096,
        maxStderrBytes: 4096,
        maxRetainedBytes: 1024 * 1024,
      }),
    ).resolves.toEqual({ state: "running" });
    await expect(inspectUntilTerminal(value.environment, remoteMarker)).resolves.toMatchObject({
      state: "succeeded",
      stdout: "long\n",
      exitCode: 0,
    });
  });

  test("admits a command timer up to the connector's 240-minute ceiling and refuses one past it", async () => {
    // The supervisor runs inside the codespace and cannot import the shared limits, so its own
    // ceiling is written out; this keeps the two equal. A command stops with its codespace, and
    // GitHub stops a silent codespace after at most 240 minutes.
    const ceiling = CODESPACE_CONNECTOR_LIMITS.maxBackgroundMs;
    expect(ceiling).toBe(240 * 60_000);
    const value = fixture();
    const execute = (remoteMarker: string, timeoutMs: number) =>
      request(value.environment, {
        action: "execute",
        version: 1,
        remoteMarker,
        repositoryFullName: "owner/repository",
        argv: ["/bin/echo", "bounded"],
        cwd: ".",
        stdin: "",
        timeoutMs,
        maxStdoutBytes: 4096,
        maxStderrBytes: 4096,
        maxRetainedBytes: 1024 * 1024,
      });

    await expect(execute(`moira-op-${"c".repeat(32)}`, ceiling + 1)).rejects.toThrow();

    const admitted = `moira-op-${"d".repeat(32)}`;
    await expect(execute(admitted, ceiling)).resolves.toEqual({ state: "running" });
    await expect(inspectUntilTerminal(value.environment, admitted)).resolves.toMatchObject({
      state: "succeeded",
      stdout: "bounded\n",
    });
  });

  test("carries a session's directory and variables and refuses one from an earlier life", async () => {
    const value = fixture();
    mkdirSync(join(value.repository, "packages"), { recursive: true });
    const environment = { ...value.environment, MOIRA_ENVIRONMENT_ID: "life-one" };
    const observe = [
      process.execPath,
      "-e",
      "process.stdout.write(process.cwd()+'|'+(process.env.SESSION_VARIABLE??'none'))",
    ];
    const run = async (remoteMarker: string, extra: Record<string, unknown>) => {
      await request(environment, {
        action: "execute",
        version: 1,
        remoteMarker,
        repositoryFullName: "owner/repository",
        argv: observe,
        stdin: "",
        timeoutMs: 10_000,
        maxStdoutBytes: 4096,
        maxStderrBytes: 4096,
        maxRetainedBytes: 1024 * 1024,
        ...extra,
      });
      return inspectUntilTerminal(environment, remoteMarker);
    };
    const marker = (character: string) => `moira-op-${character.repeat(32)}`;

    // The opening call establishes the context its command runs in.
    const opened = (await run(marker("a"), {
      session: "build",
      sessionStart: true,
      cwd: "packages",
      env: { SESSION_VARIABLE: "carried" },
    })) as Record<string, string>;
    expect(opened.stdout).toBe(`${realpathSync(join(value.repository, "packages"))}|carried`);

    // A later command in the same session names neither and observes both.
    const continued = (await run(marker("b"), { session: "build" })) as Record<string, string>;
    expect(continued.stdout).toBe(`${realpathSync(join(value.repository, "packages"))}|carried`);

    // A command outside the session observes neither, and a second session is independent.
    const outside = (await run(marker("c"), {})) as Record<string, string>;
    expect(outside.stdout).toBe(`${realpathSync(value.repository)}|none`);
    const other = (await run(marker("d"), { session: "other", sessionStart: true })) as Record<
      string,
      string
    >;
    expect(other.stdout).toBe(`${realpathSync(value.repository)}|none`);

    // The stored context belongs to the life of the environment that opened it: one written by an
    // earlier life is refused, and a session that was never opened is refused too.
    storeForeignLife(join(value.stateRoot, "sessions", "build.json"));
    await expect(
      request(environment, {
        action: "execute",
        version: 1,
        remoteMarker: marker("e"),
        repositoryFullName: "owner/repository",
        argv: observe,
        stdin: "",
        timeoutMs: 10_000,
        maxStdoutBytes: 4096,
        maxStderrBytes: 4096,
        maxRetainedBytes: 1024 * 1024,
        session: "build",
      }),
    ).resolves.toEqual({ state: "session_unavailable" });
    await expect(
      request(environment, {
        action: "execute",
        version: 1,
        remoteMarker: marker("f"),
        repositoryFullName: "owner/repository",
        argv: observe,
        stdin: "",
        timeoutMs: 10_000,
        maxStdoutBytes: 4096,
        maxStderrBytes: 4096,
        maxRetainedBytes: 1024 * 1024,
        session: "never-opened",
      }),
    ).resolves.toEqual({ state: "session_unavailable" });
  });

  test("carries what a script leaves behind and refuses a context that would not fit", async () => {
    const value = fixture();
    mkdirSync(join(value.repository, "service"), { recursive: true });
    const environment: Record<string, string> = {
      ...value.environment,
      MOIRA_ENVIRONMENT_ID: "life-one",
      INHERITED_TOOL: "old",
      REMOVE_ME: "present",
    };
    const marker = (character: string) => `moira-op-${character.repeat(32)}`;
    const send = (remoteMarker: string, extra: Record<string, unknown>) =>
      request(environment, {
        action: "execute",
        version: 1,
        remoteMarker,
        repositoryFullName: "owner/repository",
        stdin: "",
        timeoutMs: 20_000,
        maxStdoutBytes: 4096,
        maxStderrBytes: 4096,
        maxRetainedBytes: 1024 * 1024,
        ...extra,
      });
    const observe = [
      process.execPath,
      "-e",
      "process.stdout.write([require('node:path').basename(process.cwd()),process.env.TOOL_HOME??'none',process.env.INHERITED_TOOL??'gone',process.env.REMOVE_ME??'gone',process.env.PATH.split(':')[0]].join('|'))",
    ];

    // A script activates something: it changes directory, adds a variable, changes an inherited one
    // and removes another.
    await send(marker("1"), {
      session: "build",
      sessionStart: true,
      script:
        "cd service\nexport TOOL_HOME=/opt/tool\nexport INHERITED_TOOL=new\nexport PATH=/opt/tool/bin:$PATH\nunset REMOVE_ME\n",
    });
    expect(await inspectUntilTerminal(environment, marker("1"))).toMatchObject({
      state: "succeeded",
      sessionCaptureDropped: false,
    });

    // An ordinary argv command in that session sees every one of those changes and nothing else.
    await send(marker("2"), { session: "build", argv: observe });
    const continued = (await inspectUntilTerminal(environment, marker("2"))) as Record<
      string,
      string
    >;
    expect(continued.stdout).toBe("service|/opt/tool|new|gone|/opt/tool/bin");

    // A command outside the session is untouched by all of it.
    await send(marker("3"), { argv: observe });
    const outside = (await inspectUntilTerminal(environment, marker("3"))) as Record<
      string,
      string
    >;
    expect(outside.stdout).toBe(
      "repository|none|old|present|/opt/tool/bin".replace(
        "/opt/tool/bin",
        environment.PATH!.split(":")[0],
      ),
    );

    // A call whose declared context would not fit the stored-context ceiling is refused, and the
    // session it names still works afterwards.
    const oversized = Object.fromEntries(
      Array.from({ length: 40 }, (_, index) => [`BIG_${index}`, "x".repeat(4000)]),
    );
    await expect(
      send(marker("4"), { session: "build", argv: observe, env: oversized }),
    ).resolves.toEqual({ state: "session_limit", limit: "context" });
    await send(marker("5"), { session: "build", argv: observe });
    expect(
      ((await inspectUntilTerminal(environment, marker("5"))) as Record<string, string>).stdout,
    ).toBe("service|/opt/tool|new|gone|/opt/tool/bin");

    // The stored context holds only what the script touched: an inherited variable it never named
    // is absent from the file, which is what keeps the codespace's own environment out of it.
    const storedSession = JSON.parse(
      readFileSync(join(value.stateRoot, "sessions", "build.json"), "utf8"),
    ) as { env: Record<string, string | null> };
    expect(Object.keys(storedSession.env).sort()).toEqual([
      "INHERITED_TOOL",
      "PATH",
      "REMOVE_ME",
      "TOOL_HOME",
    ]);
    expect(JSON.stringify(storedSession)).not.toContain("MOIRA_ENVIRONMENT_ID");

    // A script that fails still leaves its end state behind, while one that ends the shell itself
    // cannot report an end state at all and the answer says its capture was dropped.
    await send(marker("8"), {
      session: "build",
      script: "export AFTER_FAILURE=kept\nfalse\n",
    });
    expect(await inspectUntilTerminal(environment, marker("8"))).toMatchObject({
      state: "failed",
      exitCode: 1,
      sessionCaptureDropped: false,
    });
    await send(marker("c"), { session: "build", script: "export NEVER_SEEN=x\nexit 3\n" });
    expect(await inspectUntilTerminal(environment, marker("c"))).toMatchObject({
      state: "failed",
      exitCode: 3,
      sessionCaptureDropped: true,
    });
    await send(marker("9"), {
      session: "build",
      argv: [process.execPath, "-e", "process.stdout.write(process.env.AFTER_FAILURE??'lost')"],
    });
    expect(
      ((await inspectUntilTerminal(environment, marker("9"))) as Record<string, string>).stdout,
    ).toBe("kept");

    await send(marker("a"), {
      session: "build",
      script: `export TOO_LONG=${"x".repeat(5000)}\n`,
    });
    expect(await inspectUntilTerminal(environment, marker("a"))).toMatchObject({
      state: "succeeded",
      sessionCaptureDropped: true,
    });
    // The session still works, with the context it had before that script.
    await send(marker("b"), {
      session: "build",
      argv: [process.execPath, "-e", "process.stdout.write(process.env.TOOL_HOME??'none')"],
    });
    expect(
      ((await inspectUntilTerminal(environment, marker("b"))) as Record<string, string>).stdout,
    ).toBe("/opt/tool");

    // Ending the session frees its slot and removes the stored context, so naming it is refused.
    await expect(send(marker("6"), { session: "build", sessionEnd: true })).resolves.toEqual({
      state: "session_ended",
    });
    await expect(send(marker("7"), { session: "build", argv: observe })).resolves.toEqual({
      state: "session_unavailable",
    });
  });

  test("distinguishes an unreported command outcome from an actual environment restart", async () => {
    const value = fixture();
    const marker = (character: string) => `moira-op-${character.repeat(32)}`;
    const environment = { ...value.environment, MOIRA_ENVIRONMENT_ID: "life-one" };
    const start = (remoteMarker: string) =>
      request(environment, {
        action: "execute",
        version: 1,
        remoteMarker,
        repositoryFullName: "owner/repository",
        argv: [process.execPath, "-e", "setTimeout(() => {}, 300000)"],
        stdin: "",
        timeoutMs: 300_000,
        maxStdoutBytes: 1024,
        maxStderrBytes: 1024,
        maxRetainedBytes: 1024 * 1024,
      });

    await expect(start(marker("d"))).resolves.toEqual({ state: "running" });
    // A restart leaves the operation's files and identity behind and takes every process with it.
    const directory = join(value.stateRoot, marker("d"));
    const identity = JSON.parse(readFileSync(join(directory, "pid"), "utf8")) as { pid: number };
    const runner = JSON.parse(readFileSync(join(directory, "runner-pid"), "utf8")) as {
      pid: number;
    };
    const proof = JSON.parse(readFileSync(join(directory, "execution.json"), "utf8"));
    expect(proof.launchAttempted).toBe(true);
    expect(proof.startedAt).toBeGreaterThan(0);
    for (const pid of [identity.pid, runner.pid]) {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        process.kill(pid, "SIGKILL");
      }
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 200));
    expect(existsSync(join(directory, "result.json"))).toBe(false);

    // The required state: the same absence of a result means one thing when the operation belongs to
    // this life and another when it belongs to an earlier one. The recorded life is what separates
    // them, so it is asked about first as it stands and then as a restart would have left it.
    await expect(
      request(environment, { action: "inspect", version: 1, remoteMarker: marker("d") }),
    ).resolves.toEqual({ state: "outcome_unknown" });
    storeForeignLife(join(directory, "environment"));
    await expect(
      request(environment, { action: "inspect", version: 1, remoteMarker: marker("d") }),
    ).resolves.toEqual({ state: "interrupted" });
  });

  test("counts only the sessions this life can use and lets a dead one free its slot", async () => {
    const value = fixture();
    const environment = { ...value.environment, MOIRA_ENVIRONMENT_ID: "life-one" };
    const marker = (index: number) => `moira-op-${index.toString(16).padStart(32, "0")}`;
    const open = (environment: NodeJS.ProcessEnv, session: string, remoteMarker: string) =>
      request(environment, {
        action: "execute",
        version: 1,
        remoteMarker,
        repositoryFullName: "owner/repository",
        argv: ["/bin/echo", "open"],
        stdin: "",
        timeoutMs: 10_000,
        maxStdoutBytes: 4096,
        maxStderrBytes: 4096,
        maxRetainedBytes: 1024 * 1024,
        session,
        sessionStart: true,
      });

    // Fill the codespace's sessions in one life of the environment.
    for (let index = 0; index < 16; index++) {
      await expect(open(environment, `session-${index}`, marker(index))).resolves.toEqual({
        state: "running",
      });
    }
    await expect(open(environment, "one-too-many", marker(100))).resolves.toEqual({
      state: "session_limit",
      limit: "sessions",
    });

    // A restart leaves every one of those files behind, written by a life that has ended. None of
    // them can be used any more, so none of them holds a slot either.
    for (let index = 0; index < 16; index++) {
      storeForeignLife(join(value.stateRoot, "sessions", `session-${index}.json`));
    }
    await expect(open(environment, "fresh", marker(101))).resolves.toEqual({ state: "running" });

    // A session left by an earlier life is removed by the call that ends it, rather than lingering.
    await expect(
      request(environment, {
        action: "execute",
        version: 1,
        remoteMarker: marker(102),
        repositoryFullName: "owner/repository",
        stdin: "",
        timeoutMs: 10_000,
        maxStdoutBytes: 4096,
        maxStderrBytes: 4096,
        maxRetainedBytes: 1024 * 1024,
        session: "session-0",
        sessionEnd: true,
      }),
    ).resolves.toEqual({ state: "session_ended" });
    expect(existsSync(join(value.stateRoot, "sessions", "session-0.json"))).toBe(false);
  });

  test("reports cancellation only after the foreground process group is absent", async () => {
    const value = fixture();
    const remoteMarker = `moira-op-${"2".repeat(32)}`;
    const effectPath = join(value.stateRoot, "..", "foreground-effect");
    await request(value.environment, {
      action: "execute",
      version: 1,
      remoteMarker,
      repositoryFullName: "owner/repository",
      argv: [
        process.execPath,
        "-e",
        "const fs=require('node:fs');setInterval(()=>fs.appendFileSync(process.argv[1],'x'),10)",
        effectPath,
      ],
      cwd: ".",
      stdin: "",
      timeoutMs: 30_000,
      maxStdoutBytes: 4096,
      maxStderrBytes: 4096,
      maxRetainedBytes: 1024 * 1024,
    });
    for (let attempt = 0; attempt < 40 && !existsSync(effectPath); attempt++) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 10));
    }
    expect(existsSync(effectPath)).toBe(true);
    const identity = JSON.parse(
      readFileSync(join(value.stateRoot, remoteMarker, "pid"), "utf8"),
    ) as { pid: number; startTime: string | null };
    expect(identity.pid).toBeGreaterThan(1);
    expect(identity.startTime).toEqual(
      process.platform === "linux" ? expect.stringMatching(/^[0-9]+$/) : null,
    );
    let result = (await request(value.environment, {
      action: "cancel",
      version: 1,
      remoteMarker,
    })) as Record<string, unknown>;
    if (result.state === "running") {
      result = await inspectUntilTerminal(value.environment, remoteMarker);
    }
    expect(result.state).toBe("cancelled");
    const bytesAfterCancel = readFileSync(effectPath).length;
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    expect(readFileSync(effectPath).length).toBe(bytesAfterCancel);
  });

  test("does not infer a terminal outcome from a disappeared legacy runner marker", async () => {
    const value = fixture();
    const remoteMarker = `moira-op-${"5".repeat(32)}`;
    const operationDirectory = join(value.stateRoot, remoteMarker);
    mkdirSync(operationDirectory, { recursive: true });
    const runnerStartTime = processStartTime(process.pid);
    writeFileSync(
      join(operationDirectory, "pid"),
      JSON.stringify({ pid: 2_147_483_647, startTime: process.platform === "linux" ? "1" : null }),
    );
    writeFileSync(
      join(operationDirectory, "runner-pid"),
      JSON.stringify({ pid: process.pid, startTime: runnerStartTime }),
    );

    await expect(
      request(value.environment, { action: "inspect", version: 1, remoteMarker }),
    ).resolves.toEqual({ state: "running" });

    rmSync(join(operationDirectory, "runner-pid"));
    await expect(
      request(value.environment, { action: "inspect", version: 1, remoteMarker }),
    ).resolves.toEqual({ state: "outcome_unknown" });
    expect(existsSync(join(operationDirectory, "result.json"))).toBe(false);
    expect(JSON.parse(readFileSync(join(operationDirectory, "pid"), "utf8"))).toEqual({
      pid: 2_147_483_647,
      startTime: process.platform === "linux" ? "1" : null,
    });
  });

  test.each([
    [
      "retained output",
      "setInterval(()=>process.stdout.write('x'.repeat(1024)),0)",
      5_000,
      16 * 1024,
      "failed",
    ],
    ["timeout", "setInterval(()=>{},1000)", 50, 1024 * 1024, "timed_out"],
  ] as const)(
    "enforces the %s bound on the remote foreground group",
    async (_name, script, timeoutMs, retainedLimitBytes, expectedState) => {
      const value = fixture();
      const remoteMarker = `moira-op-${expectedState === "failed" ? "3" : "4".repeat(32)}`.padEnd(
        "moira-op-".length + 32,
        expectedState === "failed" ? "3" : "4",
      );
      await request(value.environment, {
        action: "execute",
        version: 1,
        remoteMarker,
        repositoryFullName: "owner/repository",
        argv: [process.execPath, "-e", script],
        cwd: ".",
        stdin: "",
        timeoutMs,
        maxStdoutBytes: 64,
        maxStderrBytes: 64,
        maxRetainedBytes: retainedLimitBytes,
      });
      const result = await inspectUntilTerminal(value.environment, remoteMarker);
      expect(result.state).toBe(expectedState);
      // Only the retained ceiling stops a command for its volume, and it says so instead of
      // presenting itself as the command's own failure.
      expect(result.outputLimitExceeded).toBe(expectedState === "failed");
      if (expectedState === "failed") {
        expect(result.stdoutBytes).toBe(retainedLimitBytes);
      }
    },
  );
});
