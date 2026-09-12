import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { Buffer } from "node:buffer";
import { constants } from "node:fs";
import {
  access,
  link,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import process from "node:process";
import { clearTimeout, setTimeout } from "node:timers";
import { Worker } from "node:worker_threads";

const VERSION = 1;
const MAX_CONTROL_BYTES = 8 * 1024 * 1024;
const MAX_RESULT_BYTES = 8 * 1024 * 1024;
const MARKER = /^moira-op-[a-f0-9]{32}$/;
const REPOSITORY = /^[A-Za-z0-9_.-]{1,100}\/([A-Za-z0-9_.-]{1,100})$/;
const TERMINAL = new Set(["succeeded", "failed", "cancelled", "timed_out"]);
const FILE_ACTIONS = new Set([
  "stat",
  "search",
  "read",
  "write",
  "upload",
  "apply_patch",
  "download",
]);
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_FILE_PATH_BYTES = 4096;
const SEARCH_DEADLINE_MS = 5_000;
const STATE_ROOT = process.env.MOIRA_OPERATION_STATE_DIR
  ? resolve(process.env.MOIRA_OPERATION_STATE_DIR)
  : join(homedir(), ".local", "state", "moira", "operations");
const WORKSPACES_ROOT = resolve(process.env.MOIRA_WORKSPACES_ROOT || "/workspaces");
const DESCRIPTOR_ROOT = process.platform === "linux" ? "/proc/self/fd" : "/dev/fd";

const REGEX_WORKER = String.raw`
const { parentPort, workerData } = require("node:worker_threads");
const expression = new RegExp(workerData.source, "gu");
parentPort.on("message", ({ line, limit }) => {
  const indices = [];
  expression.lastIndex = 0;
  for (let match; indices.length < limit && (match = expression.exec(line));) {
    indices.push(match.index);
    if (!match[0]) expression.lastIndex++;
  }
  parentPort.postMessage(indices);
});`;

function fail(message) {
  throw new Error(message);
}

async function readBoundedJson(path, maximumBytes) {
  const value = await lstat(path);
  if (!value.isFile() || value.isSymbolicLink() || value.nlink !== 1 || value.size > maximumBytes) {
    fail("invalid supervisor state file");
  }
  return JSON.parse(await readFile(path, "utf8"));
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

function safeRelativePath(value, allowRoot = false) {
  if (allowRoot && value === ".") return ".";
  if (
    typeof value !== "string" ||
    !value ||
    Buffer.byteLength(value, "utf8") > MAX_FILE_PATH_BYTES ||
    value.includes("\0") ||
    value.startsWith("/") ||
    value.startsWith("\\") ||
    /^[A-Za-z]:/.test(value) ||
    value.split(/[\\/]/).some((part) => !part || part === "." || part === "..")
  ) {
    fail("invalid workspace path");
  }
  return value.replaceAll("\\", "/");
}

async function repositoryRootForFile(request) {
  const match = request.repositoryFullName?.match(REPOSITORY);
  if (!match) fail("invalid repository identity");
  const path = await verifyRepository({ ...request, cwd: "." }, match[1]);
  const value = await lstat(path);
  if (!value.isDirectory() || value.isSymbolicLink()) fail("workspace root is invalid");
  return { path, dev: value.dev, ino: value.ino };
}

function descriptorPath(handle, name = "") {
  if (process.platform !== "linux" && handle.moiraPath) {
    return name ? join(handle.moiraPath, name) : handle.moiraPath;
  }
  return name ? `${DESCRIPTOR_ROOT}/${handle.fd}/${name}` : `${DESCRIPTOR_ROOT}/${handle.fd}`;
}

async function syncDirectory(handle) {
  try {
    await handle.sync();
  } catch (error) {
    if (process.platform === "linux" || !["EINVAL", "ENOTSUP"].includes(error?.code)) throw error;
  }
}

async function openDirectory(root, relative = ".") {
  const normalized = safeRelativePath(relative, true);
  const rootPath = typeof root === "string" ? root : root.path;
  const inspectedRoot = await lstat(rootPath);
  const rootHandle = await open(
    rootPath,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  rootHandle.moiraPath = rootPath;
  let current = rootHandle;
  try {
    const openedRoot = await rootHandle.stat();
    if (
      !openedRoot.isDirectory() ||
      openedRoot.dev !== inspectedRoot.dev ||
      openedRoot.ino !== inspectedRoot.ino ||
      (typeof root !== "string" && (openedRoot.dev !== root.dev || openedRoot.ino !== root.ino))
    ) {
      fail("workspace root changed during validation");
    }
    if (normalized === ".") return current;
    for (const part of normalized.split("/")) {
      const child = await open(
        descriptorPath(current, part),
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      child.moiraPath = join(current.moiraPath, part);
      const value = await child.stat();
      if (!value.isDirectory()) {
        await child.close();
        fail("workspace parent is not a directory");
      }
      if (current !== rootHandle) await current.close();
      current = child;
    }
    if (current !== rootHandle) await rootHandle.close();
    return current;
  } catch (error) {
    if (current !== rootHandle) await current.close().catch(() => undefined);
    await rootHandle.close().catch(() => undefined);
    throw error;
  }
}

async function inspectPath(root, relative, allowDirectory = false) {
  const normalized = safeRelativePath(relative, allowDirectory);
  if (normalized === ".") {
    const handle = await openDirectory(root);
    return { handle, stat: await handle.stat(), relative: normalized };
  }
  const parts = normalized.split("/");
  const name = parts.pop();
  const parent = await openDirectory(root, parts.length ? parts.join("/") : ".");
  try {
    const handle = await open(
      descriptorPath(parent, name),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    handle.moiraPath = join(parent.moiraPath, name);
    const value = await handle.stat();
    if (!(value.isDirectory() && allowDirectory) && (!value.isFile() || value.nlink !== 1)) {
      await handle.close();
      fail("workspace path is not an allowed file type");
    }
    return { handle, stat: value, relative: normalized };
  } finally {
    await parent.close();
  }
}

async function readRegular(root, relative, maximum = MAX_FILE_BYTES, { keepOpen = false } = {}) {
  const inspected = await inspectPath(root, relative);
  const handle = inspected.handle;
  let transferred = false;
  try {
    const current = await handle.stat({ bigint: true });
    if (!current.isFile() || current.nlink !== 1n || current.size > BigInt(maximum)) {
      fail("workspace file exceeds its bound or has an unsafe type");
    }
    const bytes = Buffer.alloc(Number(current.size));
    let offset = 0;
    while (offset < bytes.length) {
      const read = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (read.bytesRead === 0) fail("workspace file changed during read");
      offset += read.bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    if (
      after.dev !== current.dev ||
      after.ino !== current.ino ||
      after.size !== current.size ||
      after.mtimeNs !== current.mtimeNs ||
      after.ctimeNs !== current.ctimeNs ||
      after.nlink !== 1n
    ) {
      fail("workspace file changed during read");
    }
    transferred = keepOpen;
    return {
      bytes,
      stat: {
        ...inspected.stat,
        mtimeMs: Number(after.mtimeNs / 1_000_000n),
        identity: fileIdentity(after),
      },
      path: inspected.relative,
      // With keepOpen the caller owns this descriptor. While it stays open the inode
      // cannot be recycled, and an unlinked original reports zero links on it.
      handle: keepOpen ? handle : null,
    };
  } finally {
    if (!transferred) await handle.close();
  }
}

async function writeAll(handle, bytes) {
  let offset = 0;
  while (offset < bytes.length) {
    const written = await handle.write(bytes, offset, bytes.length - offset, offset);
    if (written.bytesWritten === 0) fail("workspace write made no progress");
    offset += written.bytesWritten;
  }
}

function version(bytes, value) {
  return {
    size: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    modifiedAt: Math.trunc(value.mtimeMs),
  };
}

function validateExpected(expected, current) {
  if (!expected || typeof expected.exists !== "boolean") fail("invalid file precondition");
  if (expected.exists !== Boolean(current)) fail("file precondition failed");
  if (!current) return;
  const actual = version(current.bytes, current.stat);
  if (expected.size !== undefined && expected.size !== actual.size)
    fail("file size precondition failed");
  if (expected.sha256 !== undefined && expected.sha256 !== actual.sha256)
    fail("file digest precondition failed");
}

/**
 * Identity of a regular file captured from a bigint stat. Device and inode alone are
 * not enough: Linux filesystems recycle a freed inode number immediately, so a file
 * removed and recreated with the same bytes between staging and commit would pass an
 * inode check. Size and nanosecond timestamps distinguish that substitution.
 */
function fileIdentity(value) {
  return {
    dev: value.dev.toString(),
    ino: value.ino.toString(),
    nlink: value.nlink.toString(),
    size: value.size.toString(),
    mtimeNs: value.mtimeNs.toString(),
    ctimeNs: value.ctimeNs.toString(),
  };
}

/**
 * Compare two file identities. A rename we performed ourselves updates the change
 * time, so the post-rename check keeps every other field and skips ctime.
 */
function sameFileIdentity(left, right, { afterRename = false } = {}) {
  return Boolean(
    left &&
    right &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.nlink === right.nlink &&
    left.nlink === "1" &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    (afterRename || left.ctimeNs === right.ctimeNs),
  );
}

async function directoryIdentity(handle) {
  const value = await handle.stat({ bigint: true });
  if (!value.isDirectory()) fail("workspace parent is not a directory");
  return { dev: value.dev.toString(), ino: value.ino.toString() };
}

function sameDirectoryIdentity(left, right) {
  return Boolean(left && right && left.dev === right.dev && left.ino === right.ino);
}

async function verifyParentIdentity(root, relative, expected) {
  const location = await parentDirectory(root, relative);
  try {
    const current = await directoryIdentity(location.handle);
    if (!sameDirectoryIdentity(current, expected)) {
      fail("workspace parent identity changed during commit");
    }
  } finally {
    await location.handle.close();
  }
}

async function verifyEntryIdentity(parentHandle, name, expected) {
  const handle = await open(
    descriptorPath(parentHandle, name),
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const current = await handle.stat({ bigint: true });
    if (
      !current.isFile() ||
      !sameFileIdentity(expected, fileIdentity(current), { afterRename: true })
    ) {
      fail("workspace target identity changed during commit");
    }
  } finally {
    await handle.close();
  }
}

async function parentDirectory(root, relative) {
  const normalized = safeRelativePath(relative);
  const parts = normalized.split("/");
  const name = parts.pop();
  const handle = await openDirectory(root, parts.length ? parts.join("/") : ".");
  return { handle, name, relative: normalized };
}

async function currentFile(root, relative, options = {}) {
  try {
    return await readRegular(root, relative, MAX_FILE_BYTES, options);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function stageReplacement(root, relative, bytes, expected, marker) {
  if (!Buffer.isBuffer(bytes) || bytes.length > MAX_FILE_BYTES)
    fail("workspace write exceeds its bound");
  const location = await parentDirectory(root, relative);
  let temporaryName = null;
  let current = null;
  try {
    const parentIdentity = await directoryIdentity(location.handle);
    current = await currentFile(root, relative, { keepOpen: true });
    validateExpected(expected, current);
    temporaryName = `.moira-${marker}-${randomBytes(8).toString("hex")}.tmp`;
    const handle = await open(
      descriptorPath(location.handle, temporaryName),
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      current?.stat.mode ? current.stat.mode & 0o777 : 0o600,
    );
    try {
      await writeAll(handle, bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await syncDirectory(location.handle);
    return { ...location, root, parentIdentity, temporaryName, current, bytes, closed: false };
  } catch (error) {
    if (temporaryName) {
      await rm(descriptorPath(location.handle, temporaryName), { force: true }).catch(
        () => undefined,
      );
      await syncDirectory(location.handle).catch(() => undefined);
    }
    if (current?.handle) await current.handle.close().catch(() => undefined);
    await location.handle.close().catch(() => undefined);
    throw error;
  }
}

async function cleanupStaged(staged) {
  let cleanupError = null;
  for (const item of staged) {
    if (item.closed) continue;
    try {
      await rm(descriptorPath(item.handle, item.temporaryName), { force: true });
      await syncDirectory(item.handle);
    } catch (error) {
      cleanupError ??= error;
    } finally {
      if (item.current?.handle) {
        await item.current.handle.close().catch((error) => {
          cleanupError ??= error;
        });
      }
      try {
        await item.handle.close();
      } catch (error) {
        cleanupError ??= error;
      }
      item.closed = true;
    }
  }
  return cleanupError;
}

async function writeDurableJson(directory, name, value) {
  const parent = await openDirectory(directory);
  const temporaryName = `.${name}.${randomBytes(8).toString("hex")}.tmp`;
  const temporary = descriptorPath(parent, temporaryName);
  try {
    const handle = await open(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await writeAll(handle, Buffer.from(JSON.stringify(value)));
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, descriptorPath(parent, name));
    await syncDirectory(parent);
  } finally {
    await rm(temporary, { force: true });
    await parent.close();
  }
}

async function commitStaged(staged, marker, directory) {
  const committed = [];
  const entries = staged.map((item) => ({
    target: item.relative,
    parentDev: item.parentIdentity.dev,
    parentIno: item.parentIdentity.ino,
    temporaryName: item.temporaryName,
    backup: item.current ? `.moira-${marker}-${randomBytes(8).toString("hex")}.bak` : null,
    hadOriginal: Boolean(item.current),
    originalSha256: item.current
      ? createHash("sha256").update(item.current.bytes).digest("hex")
      : null,
    desiredSha256: createHash("sha256").update(item.bytes).digest("hex"),
  }));
  await writeDurableJson(directory, "file-transaction.json", entries);
  let commitError = null;
  let cleanupError = null;
  try {
    for (let index = 0; index < staged.length; index++) {
      const item = staged[index];
      const entry = entries[index];
      await verifyParentIdentity(item.root, item.relative, item.parentIdentity);
      const current = await currentFile(item.root, item.relative);
      validateExpected(
        item.current
          ? {
              exists: true,
              size: item.current.bytes.length,
              sha256: version(item.current.bytes, item.current.stat).sha256,
            }
          : { exists: false },
        current,
      );
      if (item.current) {
        // The descriptor held since staging pins the original inode: a removed or
        // replaced original shows zero links there even when the path now resolves to
        // a recreated file with an identical inode number and timestamps.
        const held = fileIdentity(await item.current.handle.stat({ bigint: true }));
        if (
          !sameFileIdentity(item.current.stat.identity, held) ||
          !sameFileIdentity(item.current.stat.identity, current?.stat.identity)
        ) {
          fail("workspace target identity changed during commit");
        }
      }
      const target = descriptorPath(item.handle, item.name);
      const temporary = descriptorPath(item.handle, item.temporaryName);
      const backup = entry.backup ? descriptorPath(item.handle, entry.backup) : null;
      if (item.current) {
        await rename(target, backup);
        await syncDirectory(item.handle);
        try {
          await verifyEntryIdentity(item.handle, entry.backup, item.current.stat.identity);
        } catch (error) {
          await rename(backup, target);
          await syncDirectory(item.handle);
          throw error;
        }
      }
      try {
        await rename(temporary, target);
        await syncDirectory(item.handle);
      } catch (error) {
        if (item.current) {
          await rename(backup, target);
          await syncDirectory(item.handle);
        }
        throw error;
      }
      committed.push({ ...item, target, backup });
    }
  } catch (error) {
    commitError = error;
    for (const item of committed.reverse()) {
      await rm(item.target, { force: true });
      if (item.backup) await rename(item.backup, item.target);
      await syncDirectory(item.handle);
    }
    await rm(join(directory, "file-transaction.json"), { force: true });
    const stateDirectory = await openDirectory(directory);
    await syncDirectory(stateDirectory);
    await stateDirectory.close();
    throw error;
  } finally {
    cleanupError = await cleanupStaged(staged);
  }
  if (!commitError && cleanupError) throw cleanupError;
}

function validateTransactionEntry(entry, root) {
  if (
    !root ||
    !entry ||
    typeof entry.target !== "string" ||
    safeRelativePath(entry.target) !== entry.target ||
    typeof entry.parentDev !== "string" ||
    !/^[0-9]+$/.test(entry.parentDev) ||
    typeof entry.parentIno !== "string" ||
    !/^[0-9]+$/.test(entry.parentIno) ||
    typeof entry.temporaryName !== "string" ||
    !entry.temporaryName.startsWith(".moira-") ||
    entry.temporaryName.includes("/") ||
    entry.temporaryName.includes("\\") ||
    !(
      entry.backup === null ||
      (typeof entry.backup === "string" &&
        entry.backup.startsWith(".moira-") &&
        !entry.backup.includes("/") &&
        !entry.backup.includes("\\"))
    )
  ) {
    fail("invalid file transaction journal");
  }
}

async function cleanupFileTransaction(directory, root) {
  try {
    const entries = await readBoundedJson(join(directory, "file-transaction.json"), 512 * 1024);
    if (!Array.isArray(entries)) fail("invalid file transaction journal");
    for (const entry of entries) {
      validateTransactionEntry(entry, root);
      await verifyParentIdentity(root, entry.target, {
        dev: entry.parentDev,
        ino: entry.parentIno,
      });
      const location = await parentDirectory(root, entry.target);
      try {
        await rm(descriptorPath(location.handle, entry.temporaryName), { force: true });
        if (entry.backup !== null) {
          if (typeof entry.backup !== "string") fail("invalid file transaction journal");
          await rm(descriptorPath(location.handle, entry.backup), { force: true });
        }
        await syncDirectory(location.handle);
      } finally {
        await location.handle.close();
      }
    }
    await rm(join(directory, "file-transaction.json"), { force: true });
    const stateDirectory = await openDirectory(directory);
    await syncDirectory(stateDirectory);
    await stateDirectory.close();
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

async function recoverFileTransaction(directory, root) {
  let entries;
  try {
    entries = await readBoundedJson(join(directory, "file-transaction.json"), 512 * 1024);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  if (!Array.isArray(entries)) fail("invalid file transaction journal");
  for (const entry of [...entries].reverse()) {
    validateTransactionEntry(entry, root);
    if (
      typeof entry.hadOriginal !== "boolean" ||
      !(
        entry.originalSha256 === null ||
        (typeof entry.originalSha256 === "string" && /^[a-f0-9]{64}$/.test(entry.originalSha256))
      ) ||
      typeof entry.desiredSha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(entry.desiredSha256) ||
      !(entry.backup === null || typeof entry.backup === "string")
    ) {
      fail("invalid file transaction journal");
    }
    await verifyParentIdentity(root, entry.target, {
      dev: entry.parentDev,
      ino: entry.parentIno,
    });
    let targetPresent = false;
    let targetWasDesired = false;
    const location = await parentDirectory(root, entry.target);
    const target = descriptorPath(location.handle, location.name);
    const temporary = descriptorPath(location.handle, entry.temporaryName);
    const backup = entry.backup ? descriptorPath(location.handle, entry.backup) : null;
    try {
      const current = await readRegular(root, entry.target);
      targetPresent = true;
      const digest = createHash("sha256").update(current.bytes).digest("hex");
      if (digest === entry.desiredSha256) {
        targetWasDesired = true;
        await rm(target);
        await syncDirectory(location.handle);
      } else if (digest !== entry.originalSha256) {
        fail("workspace target changed during recovery");
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    if (entry.hadOriginal && backup && (!targetPresent || targetWasDesired)) {
      try {
        await rename(backup, target);
        await syncDirectory(location.handle);
      } catch (error) {
        if (error?.code === "ENOENT") fail("workspace backup is missing during recovery");
        throw error;
      }
    } else if (entry.hadOriginal && backup) {
      await rm(backup, { force: true });
      await syncDirectory(location.handle);
    }
    await rm(temporary, { force: true });
    await syncDirectory(location.handle);
    await location.handle.close();
  }
  await rm(join(directory, "file-transaction.json"), { force: true });
  const stateDirectory = await openDirectory(directory);
  await syncDirectory(stateDirectory);
  await stateDirectory.close();
}

async function readFileIntent(directory) {
  try {
    return await readBoundedJson(join(directory, "file-intent.json"), MAX_CONTROL_BYTES);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function claimFileRunner(directory) {
  const startTime = process.platform === "linux" ? await linuxStartTime(process.pid) : null;
  if (process.platform === "linux" && !startTime) fail("file runner identity is unavailable");
  const target = join(directory, "file-runner-pid");
  const candidate = join(
    directory,
    `.file-runner-candidate-${process.pid}-${randomBytes(8).toString("hex")}`,
  );
  const handle = await open(
    candidate,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await writeAll(handle, Buffer.from(JSON.stringify({ pid: process.pid, startTime })));
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    try {
      await link(candidate, target);
      const stateDirectory = await openDirectory(directory);
      await syncDirectory(stateDirectory);
      await stateDirectory.close();
      return "acquired";
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }

    let previous = null;
    try {
      previous = await readOptionalProcessIdentity(directory, "file-runner-pid");
    } catch {
      // A malformed dead/tampered owner is displaced atomically below.
    }
    if (previous && (await processExists(previous))) return "busy";

    const stale = join(directory, `.file-runner-stale-${randomBytes(8).toString("hex")}`);
    try {
      await rename(target, stale);
    } catch (error) {
      if (error?.code === "ENOENT") return "retry";
      throw error;
    }
    const stateDirectory = await openDirectory(directory);
    await syncDirectory(stateDirectory);
    await stateDirectory.close();
    await rm(stale, { force: true });
    return "retry";
  } finally {
    await rm(candidate, { force: true });
  }
}

function decodeBytes(value, maximum = MAX_FILE_BYTES) {
  if (typeof value !== "string") fail("invalid encoded file bytes");
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value || bytes.length > maximum)
    fail("invalid encoded file bytes");
  return bytes;
}

function patchSummary(entries, totals, maximumBytes) {
  const included = [];
  let truncated = false;
  for (const entry of entries) {
    const candidate = { ...totals, entries: [...included, entry], truncated: false };
    if (
      candidate.entries.length > 64 ||
      Buffer.byteLength(JSON.stringify(candidate)) > maximumBytes
    ) {
      truncated = true;
      break;
    }
    included.push(entry);
  }
  const result = { ...totals, entries: included, truncated };
  if (Buffer.byteLength(JSON.stringify(result)) > maximumBytes) {
    fail("patch summary exceeds its bound");
  }
  return result;
}

function searchResultBytes(matches, truncated) {
  return Buffer.byteLength(JSON.stringify({ action: "search", matches, truncated }));
}

function matchRegex(worker, line, limit, deadline) {
  return new Promise((resolveMatch, reject) => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      resolveMatch(null);
      return;
    }
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      worker.off("message", onMessage);
      worker.off("error", onError);
    };
    const onMessage = (indices) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (
        !Array.isArray(indices) ||
        indices.length > limit ||
        indices.some((index) => !Number.isSafeInteger(index) || index < 0 || index > line.length)
      ) {
        reject(new Error("regex worker returned an invalid result"));
        return;
      }
      resolveMatch(indices);
    };
    const onError = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      void worker.terminate();
      resolveMatch(null);
    }, remaining);
    timer.unref();
    worker.once("message", onMessage);
    worker.once("error", onError);
    worker.postMessage({ line, limit });
  });
}

async function executeFileRequest(root, request, marker, directory) {
  if (!request || !FILE_ACTIONS.has(request.action)) fail("invalid file request");
  if (request.action === "stat") {
    const inspected = await inspectPath(root, request.path, true);
    if (inspected.stat.isDirectory()) {
      try {
        return {
          action: "stat",
          stat: {
            path: inspected.relative,
            type: "directory",
            size: 0,
            mode: inspected.stat.mode & 0o777,
            modifiedAt: Math.trunc(inspected.stat.mtimeMs),
            version: null,
          },
        };
      } finally {
        await inspected.handle.close();
      }
    }
    await inspected.handle.close();
    const current = await readRegular(root, request.path);
    return {
      action: "stat",
      stat: {
        path: current.path,
        type: "file",
        size: current.bytes.length,
        mode: current.stat.mode & 0o777,
        modifiedAt: Math.trunc(current.stat.mtimeMs),
        version: version(current.bytes, current.stat),
      },
    };
  }
  if (request.action === "read" || request.action === "download") {
    const current = await readRegular(
      root,
      request.path,
      request.action === "download" ? request.maxBytes : MAX_FILE_BYTES,
    );
    const offset = request.action === "read" ? request.offset : 0;
    const length = request.action === "read" ? request.length : current.bytes.length;
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      !Number.isSafeInteger(length) ||
      length < 1 ||
      offset > current.bytes.length
    )
      fail("invalid read range");
    const selected = current.bytes.subarray(
      offset,
      Math.min(current.bytes.length, offset + length),
    );
    return {
      action: request.action,
      path: current.path,
      offset,
      totalSize: current.bytes.length,
      bytesBase64: selected.toString("base64"),
      sha256: version(current.bytes, current.stat).sha256,
    };
  }
  if (request.action === "write" || request.action === "upload") {
    const bytes = decodeBytes(request.bytesBase64);
    const staged = await stageReplacement(root, request.path, bytes, request.expected, marker);
    await commitStaged([staged], marker, directory);
    const current = await readRegular(root, request.path);
    return {
      action: request.action,
      path: current.path,
      previous: staged.current ? version(staged.current.bytes, staged.current.stat) : null,
      current: version(current.bytes, current.stat),
    };
  }
  if (request.action === "apply_patch") {
    if (
      !Array.isArray(request.files) ||
      request.files.length < 1 ||
      request.files.length > 64 ||
      !Number.isSafeInteger(request.summaryMaxBytes) ||
      request.summaryMaxBytes < 256 ||
      request.summaryMaxBytes > 64 * 1024
    )
      fail("invalid patch files");
    const staged = [];
    const summaryEntries = [];
    const summaryTotals = {
      filesChanged: request.files.length,
      editsApplied: 0,
      insertedBytes: 0,
      deletedBytes: 0,
    };
    const paths = new Set();
    try {
      for (const file of request.files) {
        const relative = safeRelativePath(file.path);
        if (paths.has(relative)) fail("duplicate patch path");
        paths.add(relative);
        const current = await currentFile(root, relative);
        validateExpected(file.expected, current);
        const original = current?.bytes ?? Buffer.alloc(0);
        if (!Array.isArray(file.edits)) fail("invalid patch edits");
        const parts = [];
        let cursor = 0;
        let insertedBytes = 0;
        let deletedBytes = 0;
        for (const edit of file.edits) {
          if (
            !Number.isSafeInteger(edit.start) ||
            !Number.isSafeInteger(edit.end) ||
            edit.start < cursor ||
            edit.end < edit.start ||
            edit.end > original.length
          )
            fail("invalid patch range");
          const inserted = decodeBytes(edit.bytesBase64);
          parts.push(original.subarray(cursor, edit.start), inserted);
          insertedBytes += inserted.length;
          deletedBytes += edit.end - edit.start;
          cursor = edit.end;
        }
        parts.push(original.subarray(cursor));
        const bytes = Buffer.concat(parts);
        if (bytes.length > MAX_FILE_BYTES) fail("patched file exceeds its bound");
        staged.push(await stageReplacement(root, relative, bytes, file.expected, marker));
        summaryEntries.push({
          path: relative,
          edits: file.edits.length,
          insertedBytes,
          deletedBytes,
        });
        summaryTotals.editsApplied += file.edits.length;
        summaryTotals.insertedBytes += insertedBytes;
        summaryTotals.deletedBytes += deletedBytes;
      }
      await commitStaged(staged, marker, directory);
      const files = [];
      for (const item of staged) {
        const current = await readRegular(root, item.relative);
        files.push({
          path: item.relative,
          previous: item.current ? version(item.current.bytes, item.current.stat) : null,
          current: version(current.bytes, current.stat),
        });
      }
      return {
        action: "apply_patch",
        files,
        summary: patchSummary(summaryEntries, summaryTotals, request.summaryMaxBytes),
      };
    } catch (error) {
      await cleanupStaged(staged);
      throw error;
    }
  }
  const base = await inspectPath(root, request.path, true);
  if (!base.stat.isDirectory()) fail("search root must be a directory");
  if (
    typeof request.query !== "string" ||
    !request.query ||
    !["literal", "regex"].includes(request.mode) ||
    !Number.isSafeInteger(request.maxMatches) ||
    request.maxMatches < 1 ||
    request.maxMatches > 1000 ||
    !Number.isSafeInteger(request.maxBytes) ||
    request.maxBytes < searchResultBytes([], false) ||
    request.maxBytes > 1024 * 1024
  )
    fail("invalid search request");
  const regexWorker =
    request.mode === "regex"
      ? new Worker(REGEX_WORKER, {
          eval: true,
          execArgv: [],
          workerData: { source: request.query },
        })
      : null;
  const matches = [];
  const searchEnvelopeBytes = searchResultBytes([], false);
  let matchPayloadBytes = 0;
  let scannedBytes = 0;
  const searchDeadline = Date.now() + SEARCH_DEADLINE_MS;
  let truncated = false;
  const visit = async (directoryHandle, directoryPath, prefix) => {
    const openedDirectory =
      process.platform === "linux" ? descriptorPath(directoryHandle) : directoryPath;
    const entries = await readdir(openedDirectory, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (Date.now() > searchDeadline) {
        truncated = true;
        return;
      }
      if (matches.length >= request.maxMatches) {
        truncated = true;
        return;
      }
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      let value;
      try {
        value = await lstat(join(openedDirectory, entry.name));
      } catch {
        continue;
      }
      if (value.isSymbolicLink()) continue;
      if (value.isDirectory()) {
        let child;
        try {
          child = await open(
            join(openedDirectory, entry.name),
            constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
          );
          await visit(child, join(directoryPath, entry.name), relative);
        } finally {
          await child?.close();
        }
        continue;
      }
      if (!value.isFile() || value.nlink !== 1 || value.size > MAX_FILE_BYTES) continue;
      if (scannedBytes + value.size > request.maxBytes) {
        truncated = true;
        return;
      }
      scannedBytes += value.size;
      const current = await readRegular(
        root,
        base.relative === "." ? relative : `${base.relative}/${relative}`,
      );
      const text = current.bytes.toString("utf8");
      if (!Buffer.from(text, "utf8").equals(current.bytes)) continue;
      const lines = text.split("\n");
      for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
        const line = lines[lineIndex];
        const indices = [];
        if (regexWorker) {
          const matched = await matchRegex(
            regexWorker,
            line,
            request.maxMatches - matches.length,
            searchDeadline,
          );
          if (matched === null) {
            truncated = true;
            return;
          }
          indices.push(...matched);
        } else {
          for (
            let index = line.indexOf(request.query);
            index >= 0;
            index = line.indexOf(request.query, index + Math.max(1, request.query.length))
          )
            indices.push(index);
        }
        for (const index of indices) {
          const item = {
            path: base.relative === "." ? relative : `${base.relative}/${relative}`,
            line: lineIndex + 1,
            column: index + 1,
            preview: line.slice(0, 512),
          };
          const itemBytes = Buffer.byteLength(JSON.stringify(item));
          if (
            matches.length >= request.maxMatches ||
            searchEnvelopeBytes + matchPayloadBytes + itemBytes + matches.length > request.maxBytes
          ) {
            truncated = true;
            return;
          }
          matches.push(item);
          matchPayloadBytes += itemBytes;
        }
      }
    }
  };
  try {
    const rootPath = typeof root === "string" ? root : root.path;
    const basePath = base.relative === "." ? rootPath : join(rootPath, base.relative);
    await visit(base.handle, basePath, "");
    return { action: "search", matches, truncated };
  } finally {
    await regexWorker?.terminate();
    await base.handle.close();
  }
}

async function readFileOperationResult(directory) {
  try {
    const value = await readBoundedJson(join(directory, "result.json"), MAX_RESULT_BYTES);
    if (value.kind !== "file" || !["succeeded", "failed"].includes(value.state) || !value.value)
      fail("invalid file operation result");
    return { state: value.state, value: value.value };
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function fileExecute(request) {
  const directory = validateBase(request);
  for (;;) {
    const existing = await readFileOperationResult(directory);
    if (existing) {
      const savedIntent = await readFileIntent(directory);
      if (savedIntent) {
        await cleanupFileTransaction(directory, await repositoryRootForFile(savedIntent));
      }
      await rm(join(directory, "file-intent.json"), { force: true });
      return existing;
    }
    await mkdir(dirname(directory), { recursive: true, mode: 0o700 });
    await mkdir(directory, { mode: 0o700 }).catch((error) => {
      if (error?.code !== "EEXIST") throw error;
    });
    const ownership = await claimFileRunner(directory);
    if (ownership === "busy") return { state: "running" };
    if (ownership === "retry") continue;
    break;
  }
  let intent;
  try {
    intent = await readFileIntent(directory);
    if (!intent) {
      const missing = new Error("missing file intent");
      missing.code = "ENOENT";
      throw missing;
    }
    if (
      JSON.stringify(intent.request) !== JSON.stringify(request.request) ||
      intent.repositoryFullName !== request.repositoryFullName
    ) {
      fail("file operation intent mismatch");
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    intent = {
      action: "file-execute",
      version: VERSION,
      remoteMarker: request.remoteMarker,
      repositoryFullName: request.repositoryFullName,
      request: request.request,
    };
    await writeDurableJson(directory, "file-intent.json", intent);
  }
  const root = await repositoryRootForFile(intent);
  await recoverFileTransaction(directory, root);
  let state = "succeeded";
  let value;
  try {
    value = await executeFileRequest(root, intent.request, request.remoteMarker, directory);
  } catch {
    await recoverFileTransaction(directory, root);
    state = "failed";
    value = {
      action: intent.request?.action,
      state: "failed",
      code: "WORKSPACE_FILE_REJECTED",
    };
  }
  await writeDurableJson(directory, "result.json", { kind: "file", state, value });
  await cleanupFileTransaction(directory, root);
  await rm(join(directory, "file-intent.json"), { force: true });
  return { state, value };
}

async function fileInspect(request) {
  const directory = validateBase(request);
  try {
    await access(directory, constants.R_OK);
    const result = await readFileOperationResult(directory);
    if (result) {
      const intent = await readFileIntent(directory);
      if (intent) await cleanupFileTransaction(directory, await repositoryRootForFile(intent));
      await rm(join(directory, "file-intent.json"), { force: true });
      return result;
    }
    const runner = await readOptionalProcessIdentity(directory, "file-runner-pid");
    if (runner && (await processExists(runner))) return { state: "running" };
    try {
      const intent = await readFileIntent(directory);
      if (!intent) return { state: "absent" };
      return fileExecute(intent);
    } catch (error) {
      if (error?.code === "ENOENT") return { state: "absent" };
      throw error;
    }
  } catch (error) {
    if (error?.code === "ENOENT") return { state: "absent" };
    throw error;
  }
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
  if (request.action === "file-execute") return fileExecute(request);
  if (request.action === "file-inspect") return fileInspect(request);
  fail("unsupported supervisor action");
}

export async function runEncoded(encoded) {
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.length > MAX_CONTROL_BYTES) fail("request too large");
  const result = await runRequest(JSON.parse(bytes.toString("utf8")));
  process.stdout.write(JSON.stringify({ ok: true, result }));
}
