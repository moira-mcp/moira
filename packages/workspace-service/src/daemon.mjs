import { constants } from "node:fs";
import process from "node:process";
import { Buffer } from "node:buffer";
import { setTimeout } from "node:timers";
import { open, readFile, mkdir, rename, rm, lstat, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { request } from "node:http";
import { pathToFileURL, fileURLToPath, URL } from "node:url";
import { startWorkspaceService } from "./server.mjs";
import { createWorkspaceEngine } from "./engine.mjs";
import { startWorkspaceRemote } from "./remote.ts";

const execute = promisify(execFile);
const installation = join(homedir(), ".local/share/moira-workspace");
const stateRoot = join(homedir(), ".local/state/moira/workspace-service");
const socketPath = join(stateRoot, "service.sock");
const configurationPath = join(installation, "config.json");
const ownerPath = join(stateRoot, "daemon.json");

async function privateDirectory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const value = await lstat(path);
  if (
    !value.isDirectory() ||
    value.isSymbolicLink() ||
    value.uid !== process.getuid() ||
    (value.mode & 0o077) !== 0 ||
    (await realpath(path)) !== path
  )
    throw new Error("Workspace private directory is unsafe");
}

async function privateJson(path) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const value = await handle.stat();
    if (
      !value.isFile() ||
      value.nlink !== 1 ||
      value.uid !== process.getuid() ||
      (value.mode & 0o077) !== 0 ||
      value.size > 64 * 1024
    )
      throw new Error("Workspace private configuration is unsafe");
    return JSON.parse(await handle.readFile("utf8"));
  } finally {
    await handle.close();
  }
}

async function publish(path, value) {
  await privateDirectory(dirname(path));
  const temporary = `${path}.next-${randomUUID()}`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    try {
      await handle.writeFile(JSON.stringify(value));
      await handle.sync();
    } finally {
      await handle.close();
    }
    const previous = await lstat(path).catch((error) => {
      if (error.code !== "ENOENT") throw error;
      return null;
    });
    if (
      previous &&
      (!previous.isFile() ||
        previous.isSymbolicLink() ||
        previous.nlink !== 1 ||
        previous.uid !== process.getuid())
    )
      throw new Error("Workspace configuration target is unsafe");
    await rename(temporary, path);
    const parent = await open(
      dirname(path),
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      await parent.sync();
    } finally {
      await parent.close();
    }
  } finally {
    await rm(temporary, { force: true });
  }
}

async function life(binding) {
  return createWorkspaceEngine({ stateRoot, binding }).environmentIdentity();
}

async function releaseIdentity() {
  const bytes = await readFile(new URL("../release.json", import.meta.url));
  const manifest = JSON.parse(bytes);
  if (
    manifest.version !== 1 ||
    manifest.nodeVersion !== "24.21.0" ||
    manifest.libc !== "glibc" ||
    manifest.architecture !== process.arch ||
    process.version !== `v${manifest.nodeVersion}`
  )
    throw new Error("Workspace owned runtime does not match its release");
  return createHash("sha256").update(bytes).digest("hex");
}

/** Called by the fixed installer, after its exact archive hash was verified. */
export async function configureWorkspace(input) {
  if (
    !input ||
    input.version !== 1 ||
    typeof input.repositoryFullName !== "string" ||
    !/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/.test(input.repositoryFullName) ||
    typeof input.root !== "string" ||
    resolve(input.root) !== input.root ||
    !input.remote
  )
    throw new Error("Invalid workspace bootstrap configuration");
  const metadata = await lstat(input.root);
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    metadata.uid !== process.getuid() ||
    (await realpath(input.root)) !== input.root
  )
    throw new Error("Workspace bootstrap repository is unsafe");
  const origin = (
    await execute("git", ["-C", input.root, "remote", "get-url", "origin"])
  ).stdout.trim();
  if (input.expectedOrigin !== undefined && origin !== input.expectedOrigin)
    throw new Error("Workspace bootstrap repository origin changed");
  if (input.expectedOrigin === undefined) {
    const normalized = origin
      .replace(/^git@github\.com:/, "")
      .replace(/^https:\/\/github\.com\//, "")
      .replace(/\.git$/, "");
    if (normalized.toLowerCase() !== input.repositoryFullName.toLowerCase())
      throw new Error("Workspace bootstrap repository identity changed");
  }
  const binding = {
    repositoryFullName: input.repositoryFullName,
    root: input.root,
    origin,
    dev: metadata.dev,
    ino: metadata.ino,
  };
  if (input.remote.environmentIdentity !== (await life(binding)))
    throw new Error("Workspace bootstrap guest life changed");
  let proxy;
  try {
    const environment = await privateJson(
      join(homedir(), ".local/share/moira-local/environment.json"),
    );
    const target = new URL(environment.HTTPS_PROXY);
    if (
      target.protocol !== "http:" ||
      target.hostname !== "127.0.0.1" ||
      target.port !== "3437" ||
      target.pathname !== "/" ||
      target.search ||
      target.hash ||
      !target.username ||
      !target.password
    )
      throw new Error("Workspace installed proxy binding is invalid");
    proxy = target.href;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  await publish(configurationPath, {
    version: 1,
    binding,
    remote: { ...input.remote, ...(proxy ? { proxy } : {}) },
    releaseIdentity: await releaseIdentity(),
  });
  return {
    configured: true,
    releaseIdentity: await releaseIdentity(),
    environmentIdentity: await life(binding),
  };
}

function health() {
  return new Promise((done, failed) => {
    const call = request({ socketPath, path: "/v1/health", agent: false }, (response) => {
      const chunks = [];
      let size = 0;
      response.on("data", (chunk) => {
        size += chunk.length;
        if (size > 64 * 1024) response.destroy(new Error("Invalid workspace health response"));
        else chunks.push(chunk);
      });
      response.once("error", failed);
      response.once("end", () => {
        if (response.statusCode !== 200) {
          failed(new Error("Workspace service is unavailable"));
          return;
        }
        try {
          done(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        } catch (error) {
          failed(error);
        }
      });
    });
    call.once("error", failed);
    call.end();
  });
}

async function processStart(pid) {
  const value = await readFile(`/proc/${pid}/stat`, "utf8");
  const fields = value.slice(value.lastIndexOf(") ") + 2).split(" ");
  if (["Z", "X"].includes(fields[0])) return null;
  const start = fields[19];
  if (!/^[0-9]+$/.test(start ?? "")) throw new Error("Workspace process identity is unavailable");
  return start;
}

/** Replace only this owned observer. Admitted detached commands are never signalled here. */
async function stopOwnedService() {
  const owner = await privateJson(ownerPath).catch((error) => {
    if (error.code !== "ENOENT") throw error;
    return null;
  });
  if (!owner) return;
  const config = await privateJson(configurationPath);
  if (owner.environmentIdentity !== (await life(config.binding))) return;
  if (
    !Number.isSafeInteger(owner.pid) ||
    owner.pid < 2 ||
    typeof owner.program !== "string" ||
    !owner.program.startsWith(`${installation}/releases/`) ||
    !owner.program.endsWith("/service/daemon.mjs") ||
    !/^[0-9]+$/.test(owner.startTime ?? "")
  )
    throw new Error("Invalid workspace owner receipt");
  const identity = async () => {
    try {
      const cmdline = (await readFile(`/proc/${owner.pid}/cmdline`)).toString("utf8").split("\0");
      const startTime = await processStart(owner.pid);
      if (startTime === null) return false;
      if (startTime !== owner.startTime || !cmdline.includes(owner.program))
        throw new Error("Workspace daemon process identity changed");
      return true;
    } catch (error) {
      if (error.code === "ENOENT" || error.code === "ESRCH") return false;
      throw error;
    }
  };
  if (!(await identity())) return;
  process.kill(owner.pid, "SIGTERM");
  while (await identity()) await new Promise((done) => setTimeout(done, 25));
}

async function serve() {
  const config = await privateJson(configurationPath);
  const release = await releaseIdentity();
  if (
    config.version !== 1 ||
    config.releaseIdentity !== release ||
    config.remote.environmentIdentity !== (await life(config.binding))
  )
    throw new Error("Workspace service configuration no longer matches this release and guest");
  if (config.remote.proxy) {
    const proxy = new URL(config.remote.proxy);
    if (
      proxy.protocol !== "http:" ||
      proxy.hostname !== "127.0.0.1" ||
      proxy.port !== "3437" ||
      !proxy.username ||
      !proxy.password
    )
      throw new Error("Workspace installed network proxy changed");
    for (const name of ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"])
      process.env[name] = proxy.href;
    process.env.NO_PROXY = process.env.no_proxy = "localhost,127.0.0.1,::1";
  }
  await privateDirectory(stateRoot);
  const service = await startWorkspaceService({
    socketPath,
    stateRoot,
    binding: config.binding,
    releaseIdentity: release,
    searchExecutable: fileURLToPath(new URL("../runtime/bin/rg", import.meta.url)),
  });
  let remote;
  try {
    remote = await startWorkspaceRemote({ socketPath, ...config.remote });
    const owner = {
      pid: process.pid,
      startTime: await processStart(process.pid),
      program: fileURLToPath(import.meta.url),
      releaseIdentity: release,
      environmentIdentity: await life(config.binding),
    };
    await publish(ownerPath, owner);
    let closing;
    const close = () =>
      (closing ??= (async () => {
        await remote.close();
        await service.close();
        const current = await privateJson(ownerPath).catch((error) => {
          if (error.code !== "ENOENT") throw error;
          return null;
        });
        if (JSON.stringify(current) === JSON.stringify(owner)) await rm(ownerPath);
      })());
    for (const signal of ["SIGTERM", "SIGINT"])
      process.once(signal, () => {
        void close().then(
          () => process.exit(0),
          () => process.exit(1),
        );
      });
    const ready = await health();
    if (ready.releaseIdentity !== release)
      throw new Error("Workspace service release is not current");
    if (process.connected)
      process.send({ type: "workspace-service-ready", health: ready }, () => {});
    process.stdout.write(
      `${JSON.stringify({ workspaceService: "ready", releaseIdentity: release })}\n`,
    );
  } catch (error) {
    await remote?.close();
    await service.close();
    throw error;
  }
}

async function startOwnedService() {
  await privateDirectory(stateRoot);
  const release = await releaseIdentity();
  const ownedFile = async (path, flags) => {
    const handle = await open(
      path,
      flags | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      0o600,
    );
    try {
      const info = await handle.stat();
      const named = await lstat(path);
      if (
        !info.isFile() ||
        info.nlink !== 1 ||
        info.uid !== process.getuid() ||
        (info.mode & 0o077) !== 0 ||
        named.dev !== info.dev ||
        named.ino !== info.ino
      )
        throw new Error("Workspace startup file is unsafe");
      return handle;
    } catch (error) {
      await handle.close();
      throw error;
    }
  };
  const lock = await ownedFile(join(stateRoot, "daemon.lock"), constants.O_RDWR);
  let log;
  try {
    log = await ownedFile(join(stateRoot, "daemon.log"), constants.O_WRONLY | constants.O_APPEND);
    // The fixed shell claims the inherited descriptor, then execs the daemon
    // while preserving the private IPC channel and held kernel lock. The
    // controller waits for actual readiness or child failure, then leaves this
    // detached owner alive without retaining its IPC handle.
    const child = spawn(
      "/bin/sh",
      [
        "-c",
        '/usr/bin/flock --exclusive --nonblock 4 || exit $?; exec "$1" "$2"',
        "sh",
        process.execPath,
        fileURLToPath(import.meta.url),
      ],
      {
        detached: true,
        stdio: ["ignore", log.fd, log.fd, "ipc", lock.fd],
        env: process.env,
      },
    );
    const result = await new Promise((done, reject) => {
      child.once("error", reject);
      child.once("exit", () => reject(new Error("Workspace service exited before readiness")));
      child.on("message", (message) => {
        if (
          message?.type === "workspace-service-ready" &&
          message.health?.releaseIdentity === release
        )
          done(message.health);
      });
    });
    if (child.connected) child.disconnect();
    child.unref();
    return result;
  } finally {
    await log?.close();
    await lock.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv[2] === "--configure") {
      const chunks = [];
      let size = 0;
      for await (const chunk of process.stdin) {
        size += chunk.length;
        if (size > 64 * 1024) throw new Error("Workspace bootstrap metadata is too large");
        chunks.push(chunk);
      }
      process.stdout.write(
        `${JSON.stringify(await configureWorkspace(JSON.parse(Buffer.concat(chunks).toString("utf8"))))}\n`,
      );
    } else if (process.argv[2] === "--stop") await stopOwnedService();
    else if (process.argv[2] === "--start") {
      process.stdout.write(`${JSON.stringify(await startOwnedService())}\n`);
    } else if (process.argv[2] === "--health") {
      const result = await health();
      if (result.releaseIdentity !== (await releaseIdentity()))
        throw new Error("Workspace service release is not current");
      process.stdout.write(`${JSON.stringify(result)}\n`);
    } else if (process.argv.length === 2) await serve();
    else throw new Error("Unknown fixed workspace service action");
  } catch {
    process.stderr.write(`${JSON.stringify({ error: "WORKSPACE_SERVICE_UNAVAILABLE" })}\n`);
    process.exitCode = 1;
  }
}
