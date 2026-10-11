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
  realpath,
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
// Complete output is retained beside the result, so a range read is bounded like a file read and
// the retained streams themselves are bounded by what the caller declares, never by the payload.
// A command runs detached inside the codespace, so its own timer is bounded by the codespace's
// lifetime rather than by any request: GitHub stops a silent codespace after at most 240 minutes,
// and a command stops with it. This script runs inside the codespace and cannot import the shared
// limits, so the value is written out; it equals CODESPACE_CONNECTOR_LIMITS.maxBackgroundMs, which
// the supervisor's unit test holds. Job requests remain bounded separately by the connector.
const MAX_OPERATION_TIMEOUT_MS = 240 * 60_000;
const MAX_RETAINED_OUTPUT_BYTES = 4 * 1024 * 1024 * 1024;
const MAX_OUTPUT_RANGE_BYTES = 4 * 1024 * 1024;
const OUTPUT_STREAMS = new Map([
  ["stdout", "stdout.log"],
  ["stderr", "stderr.log"],
]);
const MARKER = /^moira-op-[a-f0-9]{32}$/;
const REPOSITORY = /^[A-Za-z0-9_.-]{1,100}\/([A-Za-z0-9_.-]{1,100})$/;
const TERMINAL = new Set(["succeeded", "failed", "cancelled", "timed_out", "not_started"]);
const MAX_RESULT_PREFIX_BYTES = Math.floor(((MAX_RESULT_BYTES - 64 * 1024) * 3) / 4);
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
/**
 * Version-control internals are not repository content: searching them returns pack files, refs
 * and reflogs that bury the caller's actual matches. They stay readable by exact path.
 */
const UNSEARCHABLE_DIRECTORY = ".git";
const STATE_ROOT = process.env.MOIRA_OPERATION_STATE_DIR
  ? resolve(process.env.MOIRA_OPERATION_STATE_DIR)
  : join(homedir(), ".local", "state", "moira", "operations");
const CODESPACES_ROOT = resolve(process.env.MOIRA_CODESPACES_ROOT || "/workspaces");
// A session outlives the commands that use it, so it lives beside the operation directories rather
// than inside one of them, and it is removed with the codespace rather than with an operation.
const SESSION_ROOT = join(STATE_ROOT, "sessions");
const SESSION_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const MAX_SESSION_BYTES = 64 * 1024;
const MAX_SESSION_VARIABLES = 64;
const MAX_SESSIONS_PER_CODESPACE = 16;
const MAX_SESSION_VALUE_LENGTH = 4096;
const MAX_SCRIPT_BYTES = 64 * 1024;
const ENVIRONMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
// A shell sets these for itself; they describe the shell rather than anything the script changed.
const SHELL_OWNED_VARIABLES = new Set(["PWD", "OLDPWD", "SHLVL", "_"]);
/** Marks a variable a script removed, so a later command in the session does not see it again. */
const REMOVED = null;
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

function failFile(reason, message) {
  const error = new Error(message);
  error.fileReason = reason;
  throw error;
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
    (request.admissionDeadlineAt !== undefined &&
      (!Number.isSafeInteger(request.admissionDeadlineAt) || request.admissionDeadlineAt < 1)) ||
    (request.requestDigest !== undefined && !/^[a-f0-9]{64}$/.test(request.requestDigest)) ||
    (request.argv !== undefined && request.argv !== null && !Array.isArray(request.argv)) ||
    (request.script === undefined &&
      !request.sessionEnd &&
      (!Array.isArray(request.argv) || request.argv.length < 1)) ||
    (request.script !== undefined &&
      (typeof request.script !== "string" ||
        request.script.length < 1 ||
        Buffer.byteLength(request.script, "utf8") > MAX_SCRIPT_BYTES ||
        request.argv !== undefined)) ||
    (request.argv !== undefined &&
      request.argv !== null &&
      (request.argv.length > 128 ||
        request.argv.some(
          (value) =>
            typeof value !== "string" || !value || value.length > 16_384 || value.includes("\0"),
        ))) ||
    (request.cwd !== undefined &&
      (typeof request.cwd !== "string" ||
        Buffer.byteLength(request.cwd, "utf8") > 4096 ||
        request.cwd.startsWith("/") ||
        (request.cwd !== "." &&
          request.cwd.split("/").some((part) => !part || part === "." || part === "..")))) ||
    (request.session !== undefined && !SESSION_NAME.test(request.session)) ||
    (request.sessionStart !== undefined && typeof request.sessionStart !== "boolean") ||
    (request.sessionEnd !== undefined && typeof request.sessionEnd !== "boolean") ||
    (request.script !== undefined && request.session === undefined) ||
    typeof request.stdin !== "string" ||
    !Number.isSafeInteger(request.timeoutMs) ||
    request.timeoutMs < 1 ||
    request.timeoutMs > MAX_OPERATION_TIMEOUT_MS ||
    !Number.isSafeInteger(request.maxStdoutBytes) ||
    request.maxStdoutBytes < 1 ||
    request.maxStdoutBytes > MAX_RESULT_BYTES ||
    !Number.isSafeInteger(request.maxStderrBytes) ||
    request.maxStderrBytes < 1 ||
    request.maxStderrBytes > MAX_RESULT_BYTES ||
    !Number.isSafeInteger(request.maxRetainedBytes) ||
    request.maxRetainedBytes < Math.max(request.maxStdoutBytes, request.maxStderrBytes) ||
    request.maxRetainedBytes > MAX_RETAINED_OUTPUT_BYTES
  ) {
    fail("invalid execution request");
  }
  const stdin = Buffer.from(request.stdin, "base64");
  if (stdin.toString("base64") !== request.stdin || stdin.length > MAX_CONTROL_BYTES) {
    fail("invalid execution input");
  }
  return { repositoryName: match[1], stdin };
}

/**
 * Identifies the codespace's current running environment. It changes when that environment is
 * restarted or replaced, which is what binds a session to the life it was opened in. On Linux it is
 * the kernel's boot identity together with the start time of the first process; elsewhere only an
 * explicit override can establish it, which is how the suite exercises two different lives.
 */
async function environmentIdentity() {
  if (process.platform === "linux") {
    // Where the running environment can identify itself it does, and an override never outranks it.
    const bootId = await readFile("/proc/sys/kernel/random/boot_id", "utf8").catch(() => null);
    const firstProcess = await linuxStartTime(1);
    if (!bootId || firstProcess === null) return null;
    return createHash("sha256").update(`${bootId.trim()}|${firstProcess}`).digest("hex");
  }
  const override = process.env.MOIRA_ENVIRONMENT_ID;
  return override ? createHash("sha256").update(`override:${override}`).digest("hex") : null;
}

function sessionPath(name) {
  if (!SESSION_NAME.test(name ?? "")) fail("invalid session name");
  return join(SESSION_ROOT, `${name}.json`);
}

function validateSessionEnvironment(value, allowRemovals = false) {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail("invalid session variables");
  const entries = Object.entries(value);
  if (entries.length > MAX_SESSION_VARIABLES) fail("invalid session variables");
  for (const [name, entry] of entries) {
    const removal = allowRemovals && entry === REMOVED;
    if (
      !ENVIRONMENT_NAME.test(name) ||
      (!removal && (typeof entry !== "string" || entry.length > MAX_SESSION_VALUE_LENGTH))
    ) {
      fail("invalid session variables");
    }
  }
  return Object.fromEntries(entries);
}

/**
 * Resolves the context a command runs in. A session that was opened in an earlier life of this
 * environment is refused rather than resumed, and so is one that was never opened: an agent must be
 * able to tell "your context is gone" from "your context is here".
 */
/** Applies a stored context to an environment: a value sets a variable, a removal takes it away. */
function applyContext(base, context) {
  const applied = { ...base };
  for (const [name, value] of Object.entries(context)) {
    if (value === REMOVED) delete applied[name];
    else applied[name] = value;
  }
  return applied;
}

/**
 * Counts the sessions this life of the environment can actually use. A file written by an earlier
 * life is not a session any more: it cannot be continued, so it must not hold a slot either.
 */
async function countSessions(identity) {
  let entries;
  try {
    entries = await readdir(SESSION_ROOT);
  } catch (error) {
    if (error?.code === "ENOENT") return 0;
    throw error;
  }
  let live = 0;
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const stored = await readBoundedJson(join(SESSION_ROOT, entry), MAX_SESSION_BYTES).catch(
      () => null,
    );
    if (stored?.environment === identity) live += 1;
  }
  return live;
}

/**
 * A stored context must fit the same bounds when it is written as when it is read, or a session
 * becomes unusable the moment it exceeds them. A call that would cross a ceiling is refused, and the
 * previous context survives untouched.
 */
function withinStoredContextBounds(identity, cwd, context) {
  return (
    Object.keys(context).length <= MAX_SESSION_VARIABLES &&
    Buffer.byteLength(JSON.stringify({ environment: identity, cwd, env: context }), "utf8") <=
      MAX_SESSION_BYTES
  );
}

async function resolveSession(request) {
  const requested = validateSessionEnvironment(request.env);
  if (!request.session) return { cwd: request.cwd ?? ".", env: requested, store: null, end: null };
  const identity = await environmentIdentity();
  if (identity === null) return null;
  const path = sessionPath(request.session);
  // Ending a session removes whatever stands under that name, including a file an earlier life of
  // this environment left behind, so a dead session can never hold a slot no call can free.
  if (request.sessionEnd && !request.argv && !request.script) {
    return { ended: true, end: async () => rm(path, { force: true }) };
  }
  const stored = request.sessionStart
    ? null
    : await readBoundedJson(path, MAX_SESSION_BYTES).catch((error) => {
        if (error?.code === "ENOENT") return undefined;
        throw error;
      });
  if (stored === undefined) return null;
  if (stored && stored.environment !== identity) return null;
  if (request.sessionStart) {
    const current = await readBoundedJson(path, MAX_SESSION_BYTES).catch(() => null);
    const replacing = current?.environment === identity;
    if (!replacing && (await countSessions(identity)) >= MAX_SESSIONS_PER_CODESPACE) {
      return { limit: "sessions" };
    }
  }
  const context = { ...validateSessionEnvironment(stored?.env, true), ...requested };
  const cwd = request.cwd ?? stored?.cwd ?? ".";
  if (!withinStoredContextBounds(identity, cwd, context)) return { limit: "context" };
  return {
    cwd,
    context,
    env: applyContext({}, context),
    /**
     * Stores the context this command ran with, plus whatever a script left behind. A capture keeps
     * only the difference from the environment the script started with, so the codespace's own
     * environment never enters the file.
     */
    store: async (captured) => {
      const merged = captured ? { ...context, ...captured.context } : context;
      const finalCwd = captured?.cwd ?? cwd;
      if (!withinStoredContextBounds(identity, finalCwd, merged)) return { limit: "context" };
      await mkdir(SESSION_ROOT, { recursive: true, mode: 0o700 });
      const temporary = `${path}.${randomBytes(8).toString("hex")}`;
      await writeFile(
        temporary,
        JSON.stringify({ environment: identity, cwd: finalCwd, env: merged }),
        { mode: 0o600 },
      );
      await rename(temporary, path);
      return null;
    },
    end: async () => {
      await rm(path, { force: true });
    },
  };
}

async function verifyRepository(request, repositoryName, binding) {
  const root = binding?.root ?? join(CODESPACES_ROOT, repositoryName);
  if (binding && binding.repositoryFullName !== request.repositoryFullName) {
    fail("repository identity mismatch");
  }
  const value = await stat(root);
  if (!value.isDirectory() || value.uid === 0) fail("invalid codespace repository");
  if (binding) {
    const inspected = await lstat(root);
    if (
      inspected.isSymbolicLink() ||
      (await realpath(root)) !== root ||
      inspected.dev !== binding.dev ||
      inspected.ino !== binding.ino ||
      value.dev !== inspected.dev ||
      value.ino !== inspected.ino
    ) {
      fail("repository root identity mismatch");
    }
  }
  const result = await capture("/usr/bin/git", [
    "-c",
    `safe.directory=${root}`,
    "-C",
    root,
    "remote",
    "get-url",
    "origin",
  ]);
  const origin = result.stdout.trim();
  const normalized = origin
    .trim()
    .replace(/^git@github\.com:/, "")
    .replace(/^https:\/\/github\.com\//, "")
    .replace(/\.git$/, "")
    .toLowerCase();
  if (
    binding ? origin !== binding.origin : normalized !== request.repositoryFullName.toLowerCase()
  ) {
    fail("repository identity mismatch");
  }
  const cwd = resolve(root, request.cwd);
  if (cwd !== root && !cwd.startsWith(`${root}${sep}`)) fail("working directory escaped codespace");
  if (binding) {
    const canonical = await realpath(cwd);
    if (canonical !== root && !canonical.startsWith(`${root}${sep}`)) {
      fail("working directory escaped codespace");
    }
  }
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
    failFile("unsafe_access", "invalid codespace path");
  }
  return value.replaceAll("\\", "/");
}

async function repositoryRootForFile(request, binding) {
  const match = request.repositoryFullName?.match(REPOSITORY);
  if (!match) fail("invalid repository identity");
  const path = await verifyRepository({ ...request, cwd: "." }, match[1], binding);
  const value = await lstat(path);
  if (!value.isDirectory() || value.isSymbolicLink()) fail("codespace root is invalid");
  return { path, dev: binding?.dev ?? value.dev, ino: binding?.ino ?? value.ino };
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
      failFile("concurrent_change", "codespace root changed during validation");
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
        failFile("unsafe_access", "codespace parent is not a directory");
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
      failFile("unsafe_access", "codespace path is not an allowed file type");
    }
    return { handle, stat: value, relative: normalized };
  } finally {
    await parent.close();
  }
}

/** One confined descriptor owns both content access and the final path/identity observation. */
async function withRegularFile(
  root,
  relative,
  work,
  { maximum = Number.MAX_SAFE_INTEGER, keepOpen = false, inspected: opened } = {},
) {
  const inspected = opened ?? (await inspectPath(root, relative));
  const handle = inspected.handle;
  let transferred = false;
  try {
    const current = await handle.stat({ bigint: true });
    if (!current.isFile() || current.nlink !== 1n)
      failFile("unsafe_access", "codespace path is not an allowed regular file");
    if (current.size > BigInt(maximum) || current.size > BigInt(Number.MAX_SAFE_INTEGER))
      failFile("size_limit", "codespace file exceeds its size bound");
    const result = await work(handle, Number(current.size));
    const after = await handle.stat({ bigint: true });
    if (
      after.dev !== current.dev ||
      after.ino !== current.ino ||
      after.size !== current.size ||
      after.mtimeNs !== current.mtimeNs ||
      after.ctimeNs !== current.ctimeNs ||
      after.nlink !== 1n
    ) {
      failFile("concurrent_change", "codespace file changed during read");
    }
    // The held inode can remain linked after its parent is moved out of this path.
    // Resolve the confined path again rather than treating an unchanged descriptor as enough.
    let named;
    try {
      named = await inspectPath(root, inspected.relative);
      if (
        !sameFileIdentity(
          fileIdentity(current),
          fileIdentity(await named.handle.stat({ bigint: true })),
        )
      )
        failFile("concurrent_change", "codespace path changed during read");
    } catch {
      failFile("concurrent_change", "codespace path changed during read");
    } finally {
      await named?.handle.close();
    }
    transferred = keepOpen;
    return {
      ...result,
      stat: {
        size: Number(after.size),
        mode: Number(after.mode),
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

async function readExact(handle, bytes, position = 0) {
  let offset = 0;
  while (offset < bytes.length) {
    const read = await handle.read(bytes, offset, bytes.length - offset, position + offset);
    if (read.bytesRead === 0) failFile("concurrent_change", "codespace file changed during read");
    offset += read.bytesRead;
  }
}

async function readRegular(root, relative, maximum = MAX_FILE_BYTES, { keepOpen = false } = {}) {
  return withRegularFile(
    root,
    relative,
    async (handle, size) => {
      const bytes = Buffer.alloc(size);
      await readExact(handle, bytes);
      return { bytes };
    },
    { maximum, keepOpen },
  );
}

async function hashRegular(handle, size) {
  const hash = createHash("sha256");
  const chunk = Buffer.alloc(Math.min(size, 256 * 1024));
  for (let offset = 0; offset < size;) {
    const length = Math.min(chunk.length, size - offset);
    const read = await handle.read(chunk, 0, length, offset);
    if (read.bytesRead === 0)
      failFile("concurrent_change", "codespace file changed during hashing");
    hash.update(chunk.subarray(0, read.bytesRead));
    offset += read.bytesRead;
  }
  return hash.digest("hex");
}

async function writeAll(handle, bytes) {
  let offset = 0;
  while (offset < bytes.length) {
    const written = await handle.write(bytes, offset, bytes.length - offset, offset);
    if (written.bytesWritten === 0) fail("codespace write made no progress");
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
  if (expected.exists !== Boolean(current)) failFile("precondition", "file precondition failed");
  if (!current) return;
  const actual = version(current.bytes, current.stat);
  if (expected.size !== undefined && expected.size !== actual.size)
    failFile("precondition", "file size precondition failed");
  if (expected.sha256 !== undefined && expected.sha256 !== actual.sha256)
    failFile("precondition", "file digest precondition failed");
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
  if (!value.isDirectory()) fail("codespace parent is not a directory");
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
      failFile("concurrent_change", "codespace parent identity changed during commit");
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
      failFile("concurrent_change", "codespace target identity changed during commit");
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
    failFile("size_limit", "codespace write exceeds its bound");
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
          failFile("concurrent_change", "codespace target identity changed during commit");
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
        fail("codespace target changed during recovery");
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    if (entry.hadOriginal && backup && (!targetPresent || targetWasDesired)) {
      try {
        await rename(backup, target);
        await syncDirectory(location.handle);
      } catch (error) {
        if (error?.code === "ENOENT") fail("codespace backup is missing during recovery");
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
  if (bytes.toString("base64") !== value) fail("invalid encoded file bytes");
  if (bytes.length > maximum) failFile("size_limit", "encoded file bytes exceed their bound");
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
    const current = await withRegularFile(
      root,
      request.path,
      async (handle, size) => ({
        sha256: size <= MAX_FILE_BYTES ? await hashRegular(handle, size) : null,
      }),
      { inspected },
    );
    return {
      action: "stat",
      stat: {
        path: current.path,
        type: "file",
        size: current.stat.size,
        mode: current.stat.mode & 0o777,
        modifiedAt: Math.trunc(current.stat.mtimeMs),
        version:
          current.sha256 === null
            ? null
            : {
                size: current.stat.size,
                sha256: current.sha256,
                modifiedAt: Math.trunc(current.stat.mtimeMs),
              },
      },
    };
  }
  if (request.action === "read") {
    const { offset, length } = request;
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 1)
      failFile("invalid_range", "invalid read range");
    if (length > MAX_FILE_BYTES) failFile("size_limit", "read range exceeds its bound");
    const current = await withRegularFile(root, request.path, async (handle, size) => {
      if (offset > size) failFile("invalid_range", "read offset exceeds the file size");
      const bytes = Buffer.alloc(Math.min(length, size - offset));
      await readExact(handle, bytes, offset);
      return { bytes, sha256: size <= MAX_FILE_BYTES ? await hashRegular(handle, size) : null };
    });
    return {
      action: "read",
      path: current.path,
      offset,
      totalSize: current.stat.size,
      bytesBase64: current.bytes.toString("base64"),
      sha256: current.sha256,
      rangeSha256: createHash("sha256").update(current.bytes).digest("hex"),
    };
  }
  if (request.action === "download") {
    if (!Number.isSafeInteger(request.maxBytes) || request.maxBytes < 1)
      failFile("invalid_range", "invalid download bound");
    if (request.maxBytes > MAX_FILE_BYTES) failFile("size_limit", "download exceeds its bound");
    const current = await readRegular(root, request.path, request.maxBytes);
    return {
      action: "download",
      path: current.path,
      offset: 0,
      totalSize: current.bytes.length,
      bytesBase64: current.bytes.toString("base64"),
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
        if (bytes.length > MAX_FILE_BYTES) failFile("size_limit", "patched file exceeds its bound");
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
    base.relative === UNSEARCHABLE_DIRECTORY ||
    base.relative.startsWith(`${UNSEARCHABLE_DIRECTORY}/`) ||
    base.relative.includes(`/${UNSEARCHABLE_DIRECTORY}/`) ||
    base.relative.endsWith(`/${UNSEARCHABLE_DIRECTORY}`)
  ) {
    fail("search root is not searchable");
  }
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
      // Skipping a directory is not truncation: the bounds still mean what they meant.
      if (value.isDirectory() && entry.name === UNSEARCHABLE_DIRECTORY) continue;
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

/** The kernel owns this short commit lock; a dead worker leaves no admission fence. */
async function withFileCommitLock(work) {
  await mkdir(STATE_ROOT, { recursive: true, mode: 0o700 });
  const lockPath = join(STATE_ROOT, "file-commit.lock");
  const holder =
    process.platform === "linux"
      ? spawn(
          "/usr/bin/flock",
          ["--exclusive", lockPath, "/bin/sh", "-c", "printf 1; cat >/dev/null"],
          { stdio: ["pipe", "pipe", "pipe"] },
        )
      : spawn(
          "python3",
          [
            "-c",
            "import fcntl,sys; f=open(sys.argv[1],'a'); fcntl.flock(f,fcntl.LOCK_EX); print('1',flush=True); sys.stdin.buffer.read()",
            lockPath,
          ],
          { stdio: ["pipe", "pipe", "pipe"] },
        );
  let acquired = false;
  let releasing = false;
  const closed = new Promise((done) => holder.once("close", done));
  holder.stdin.on("error", () => undefined);
  holder.stderr.resume();
  await new Promise((done, reject) => {
    holder.once("error", reject);
    holder.once("close", () => {
      if (!acquired) reject(new Error("file commit lock is unavailable"));
      // Losing the lock while committing cannot permit unprotected filesystem writes.
      else if (!releasing) process.kill(process.pid, "SIGKILL");
    });
    holder.stdout.once("data", () => {
      acquired = true;
      done();
    });
  });
  try {
    return await work();
  } finally {
    releasing = true;
    holder.stdin.end();
    await closed;
  }
}

const FILE_MUTATIONS = new Set(["write", "upload", "apply_patch"]);

async function interruptFileCommit(directory, root, action) {
  try {
    await recoverFileTransaction(directory, root);
  } catch {
    // Preserve the unsafe journal and its backups, but never retry its rollback over later edits.
    await rename(
      join(directory, "file-transaction.json"),
      join(directory, "file-transaction.conflicted.json"),
    );
  }
  const value = { action, state: "failed", code: "CODESPACE_OPERATION_INTERRUPTED" };
  await writeDurableJson(directory, "result.json", { kind: "file", state: "failed", value });
  await rm(join(directory, "file-intent.json"), { force: true });
  return { state: "failed", value };
}

/** Roll back a dead commit before a different request can change its targets. Never replay it. */
async function recoverAbandonedFileCommits(root, repositoryFullName, currentDirectory) {
  for (const marker of await readdir(STATE_ROOT)) {
    if (!MARKER.test(marker)) continue;
    const directory = operationDirectory(marker);
    if (directory === currentDirectory) continue;
    const intent = await readFileIntent(directory);
    if (!intent || intent.repositoryFullName !== repositoryFullName) continue;
    try {
      await access(join(directory, "file-transaction.json"));
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    const result = await readFileOperationResult(directory);
    if (result) await cleanupFileTransaction(directory, root);
    else await interruptFileCommit(directory, root, intent.request.action);
    await rm(join(directory, "file-intent.json"), { force: true });
  }
}

async function fileExecute(request, binding) {
  const directory = validateBase(request);
  for (;;) {
    const existing = await readFileOperationResult(directory);
    if (existing) {
      const savedIntent = await readFileIntent(directory);
      if (savedIntent) {
        await cleanupFileTransaction(directory, await repositoryRootForFile(savedIntent, binding));
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
  let resumed = true;
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
    resumed = false;
    intent = {
      action: "file-execute",
      version: VERSION,
      remoteMarker: request.remoteMarker,
      repositoryFullName: request.repositoryFullName,
      request: request.request,
    };
    await writeDurableJson(directory, "file-intent.json", intent);
  }
  const root = await repositoryRootForFile(intent, binding);
  const perform = async () => {
    if (FILE_MUTATIONS.has(intent.request.action))
      await recoverAbandonedFileCommits(root, intent.repositoryFullName, directory);
    if (resumed && FILE_MUTATIONS.has(intent.request.action))
      return interruptFileCommit(directory, root, intent.request.action);
    await recoverFileTransaction(directory, root);
    let state = "succeeded";
    let value;
    try {
      value = await executeFileRequest(root, intent.request, request.remoteMarker, directory);
    } catch (error) {
      await recoverFileTransaction(directory, root);
      state = "failed";
      const reason =
        error?.fileReason ??
        (["ELOOP", "ENOTDIR"].includes(error?.code) ? "unsafe_access" : undefined);
      value = {
        action: intent.request?.action,
        state: "failed",
        code: "CODESPACE_FILE_REJECTED",
        ...([
          "unsafe_access",
          "size_limit",
          "invalid_range",
          "concurrent_change",
          "precondition",
        ].includes(reason)
          ? { reason }
          : {}),
      };
    }
    await writeDurableJson(directory, "result.json", { kind: "file", state, value });
    await cleanupFileTransaction(directory, root);
    await rm(join(directory, "file-intent.json"), { force: true });
    return { state, value };
  };
  return FILE_MUTATIONS.has(intent.request.action) ? withFileCommitLock(perform) : perform();
}

async function fileInspect(request, binding) {
  const directory = validateBase(request);
  try {
    await access(directory, constants.R_OK);
    const result = await readFileOperationResult(directory);
    if (result) {
      const intent = await readFileIntent(directory);
      if (intent)
        await cleanupFileTransaction(directory, await repositoryRootForFile(intent, binding));
      await rm(join(directory, "file-intent.json"), { force: true });
      return result;
    }
    const runner = await readOptionalProcessIdentity(directory, "file-runner-pid");
    if (runner && (await processExists(runner))) return { state: "running" };
    try {
      const intent = await readFileIntent(directory);
      if (!intent) return { state: "absent" };
      if (FILE_MUTATIONS.has(intent.request?.action)) {
        return withFileCommitLock(async () => {
          const completed = await readFileOperationResult(directory);
          if (completed) return completed;
          return interruptFileCommit(
            directory,
            await repositoryRootForFile(intent, binding),
            intent.request.action,
          );
        });
      }
      return { state: "absent" };
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
const {createWriteStream}=require("node:fs");
const {access,readFile,rename,rm,writeFile,open}=require("node:fs/promises");
const durable=async(path,value)=>{const temporary=path+'.'+process.pid+'.tmp';const f=await open(temporary,'wx',0o600);try{await f.writeFile(JSON.stringify(value));await f.sync()}finally{await f.close()}await rename(temporary,path);const parent=await open(require('node:path').dirname(path),'r');try{await parent.sync().catch(e=>{if(process.platform==='linux'||!['EINVAL','ENOTSUP'].includes(e.code))throw e})}finally{await parent.close()}};
const startTimeOf=async(path)=>{try{const value=await readFile(path,'utf8');const field=value.slice(value.lastIndexOf(') ')+2).split(' ')[19]??null;return /^[0-9]+$/.test(field)?field:null}catch{return null}};
(async()=>{let raw="";for await(const chunk of process.stdin)raw+=chunk;const input=JSON.parse(raw);
if(input.admissionDeadlineAt!==undefined&&Date.now()>=input.admissionDeadlineAt){await durable(input.resultPath,{state:'not_started',stdout:'',stderr:'',exitCode:null,stdoutBytes:0,stderrBytes:0,outputLimitExceeded:false,sessionCaptureDropped:false,requestDigest:input.requestDigest});return}
// The payload prefix is what a response may carry; the file beside it keeps the complete stream.
// Only the retained ceiling stops the command, so an ordinary noisy command keeps its own exit
// code and its own standard error.
const prefix={stdout:[],stderr:[]};const prefixBytes={stdout:0,stderr:0};const total={stdout:0,stderr:0};
const sink={stdout:createWriteStream(input.stdoutPath,{mode:0o600}),stderr:createWriteStream(input.stderrPath,{mode:0o600})};
for(const stream of ["stdout","stderr"])sink[stream].on("error",()=>{});
let terminal=false;let retainedExceeded=false;let timedOut=false;
let runnerStartTime=null;if(process.platform==="linux"){runnerStartTime=await startTimeOf('/proc/self/stat');if(runnerStartTime===null)throw new Error("invalid runner start time")}
await writeFile(input.runnerPidPath,JSON.stringify({pid:process.pid,startTime:runnerStartTime}),{mode:0o600});
const childEnv={...process.env};
for(const [name,value] of Object.entries(input.env??{})){if(value===null)delete childEnv[name];else childEnv[name]=value}
// One launch boundary governs admission and runtime; the later spawn event proves
// success without replacing it with the time its notification was delivered.
// A crash after this durable intent cannot be mistaken for proof of nonexecution.
await durable(input.executionPath,{...input.execution,launchAttempted:true});
const launchAt=Date.now();
if(input.admissionDeadlineAt!==undefined&&launchAt>=input.admissionDeadlineAt){await durable(input.resultPath,{state:'not_started',stdout:'',stderr:'',exitCode:null,stdoutBytes:0,stderrBytes:0,outputLimitExceeded:false,sessionCaptureDropped:false,requestDigest:input.requestDigest});for(const stream of ['stdout','stderr'])sink[stream].end();return}
// A script runs under the codespace's own shell, sourced so that its directory changes and exports
// take effect in that shell, and the shell then reports where it ended and what it ended with. An
// argv command is spawned exactly as before, with no shell anywhere near it.
const spawned=input.script
?spawn("/bin/sh",["-c",'. "$1"; __moira_status=$?; { pwd; "$2" -e "process.stdout.write(JSON.stringify(process.env))"; } > "$3"; exit $__moira_status',"sh",input.script,process.execPath,input.capturePath],{cwd:input.cwd,env:childEnv,detached:true,stdio:input.sessionLock?["pipe","pipe","pipe",3]:["pipe","pipe","pipe"]})
:spawn(input.argv[0],input.argv.slice(1),{cwd:input.cwd,env:childEnv,detached:true,stdio:input.sessionLock?["pipe","pipe","pipe",3]:["pipe","pipe","pipe"]});
const child=spawned;
const started=new Promise(resolve=>{child.once('spawn',()=>resolve(launchAt));child.once('error',()=>resolve(null))});
const payloadLimit=(stream)=>stream==="stdout"?input.maxStdoutBytes:input.maxStderrBytes;
const collect=(stream)=>(chunk)=>{if(retainedExceeded)return;const buffer=Buffer.from(chunk);
const room=input.maxRetainedBytes-total[stream];const kept=buffer.length>room?buffer.subarray(0,room):buffer;
if(kept.length>0){total[stream]+=kept.length;sink[stream].write(kept);
const headroom=Math.min(payloadLimit(stream)-prefixBytes[stream],input.maxPrefixBytes-prefixBytes.stdout-prefixBytes.stderr);
if(headroom>0){const head=kept.length>headroom?kept.subarray(0,headroom):kept;prefix[stream].push(head);prefixBytes[stream]+=head.length}}
if(buffer.length>room){retainedExceeded=true;try{process.kill(-child.pid,"SIGKILL")}catch{}}};
// Output collection, exit observation and pipe-error tolerance are installed before any
// await: a command that exits immediately must not close before the runner is listening,
// and writing its stdin after it exited must not abort the runner without a result.
child.stdout.on("data",collect("stdout"));child.stderr.on("data",collect("stderr"));
child.on("error",()=>{});for(const stream of [child.stdin,child.stdout,child.stderr])stream.on("error",()=>{});
const timer=setTimeout(()=>{if(terminal)return;timedOut=true;try{process.kill(-child.pid,"SIGKILL")}catch{}},Math.max(0,input.timeoutMs-(Date.now()-launchAt)));timer.unref();
const closed=new Promise((resolveClose)=>child.once("close",(code)=>{terminal=true;clearTimeout(timer);resolveClose(code)}));
const startedAt=await started;
if(startedAt!==null){await durable(input.executionPath,{...input.execution,launchAttempted:true,startedAt,runtimeMs:input.timeoutMs})}
if(startedAt!==null&&input.session){await durable(input.session.path,{environment:input.session.identity,cwd:input.session.cwd,env:input.session.context})}
// Capacity serializes only new-slot publication, never the command's lifetime.
if(input.sessionCapacityLock){require('node:fs').writeSync(4,'release\n');require('node:fs').closeSync(4)}
try{child.stdin.end(Buffer.from(input.stdin,"base64"))}catch{}
// A start time is unreadable only once the child is gone; the published result is then the
// authority, and an unverifiable identity is never reported as a live process.
const startTime=process.platform==="linux"?await startTimeOf('/proc/'+child.pid+'/stat'):null;
await writeFile(input.pidPath,JSON.stringify({pid:child.pid,startTime}),{mode:0o600});
// FD5 is held only until launch proof and process identity are published. Neither
// it nor the capacity gate is inherited by the actual command or descendants.
if(input.admissionLock){require('node:fs').writeSync(5,'release\n');require('node:fs').closeSync(5)}
const code=await closed;let cancelled=false;try{await access(input.cancelPath);cancelled=true}catch{}
// The retained streams must be complete on disk before the result announces their size.
await Promise.all(["stdout","stderr"].map((stream)=>new Promise((done)=>{sink[stream].end(done)})));
const state=startedAt===null&&input.requestDigest!==undefined?"not_started":cancelled?"cancelled":timedOut?"timed_out":retainedExceeded?"failed":code===0?"succeeded":"failed";
// What the script left behind is the difference from the environment it started with, and only that.
let captureDropped=false;
if(input.session&&input.script&&(state==="succeeded"||state==="failed")){
try{
const raw=await readFile(input.capturePath,"utf8");
const split=raw.indexOf("\n");
const endedIn=raw.slice(0,split);
const ended=JSON.parse(raw.slice(split+1));
const shellOwned=new Set(input.shellOwned);
const difference={};
// A capture obeys every rule the reader applies, name and value alike, so a stored context can
// always be read back; anything the reader would refuse means the capture is dropped instead.
const nameRule=new RegExp(input.session.namePattern);
let refused=false;
const keep=(name,value)=>{if(!nameRule.test(name)||(value!==null&&(typeof value!=="string"||value.length>input.session.maxValueLength))){refused=true;return}difference[name]=value};
for(const [name,value] of Object.entries(ended))if(!shellOwned.has(name)&&childEnv[name]!==value)keep(name,value);
for(const name of Object.keys(childEnv))if(!shellOwned.has(name)&&!(name in ended))keep(name,null);
// The shell reports the path it actually stands in, which may differ from the configured root by a
// symbolic link, so both sides are resolved before they are compared.
const {realpathSync}=require("node:fs");const {relative:relativeTo}=require("node:path");
let relative=null;try{const inside=relativeTo(realpathSync(input.repositoryRoot),realpathSync(endedIn));relative=inside===""?".":(inside.startsWith("..")?null:inside)}catch{relative=null}
const merged={...input.session.context,...difference};
const cwd=relative??input.session.cwd;
const encoded=JSON.stringify({environment:input.session.identity,cwd,env:merged});
if(!refused&&Object.keys(merged).length<=input.session.maxVariables&&Buffer.byteLength(encoded,"utf8")<=input.session.maxBytes){
const temporary=input.session.path+"."+Math.random().toString(16).slice(2);
await writeFile(temporary,encoded,{mode:0o600});await rename(temporary,input.session.path);
}else captureDropped=true;
}catch{captureDropped=true}
}
else if(input.session&&input.script)captureDropped=true;
if(input.session&&input.sessionEnd)await rm(input.session.path,{force:true}).catch(()=>{});
await durable(input.resultPath,{state,stdout:Buffer.concat(prefix.stdout).toString("base64"),stderr:Buffer.concat(prefix.stderr).toString("base64"),exitCode:Number.isInteger(code)?code:null,stdoutBytes:total.stdout,stderrBytes:total.stderr,outputLimitExceeded:retainedExceeded,sessionCaptureDropped:captureDropped,...(input.requestDigest===undefined?{}:{requestDigest:input.requestDigest,...(startedAt===null?{}:{startedAt,runtimeMs:input.timeoutMs})})});
if(input.sessionLock){require('node:fs').writeSync(3,'release\n');require('node:fs').closeSync(3)}
})().catch(async()=>{process.exitCode=1});`;

async function executionMetadata(directory) {
  try {
    return await readBoundedJson(join(directory, "execution.json"), 4096);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function receiptMetadata(value) {
  return value?.requestDigest === undefined
    ? {}
    : {
        requestDigest: value.requestDigest,
        ...(Number.isSafeInteger(value.startedAt) && value.startedAt > 0
          ? {
              startedAt: value.startedAt,
              ...(Number.isSafeInteger(value.runtimeMs) && value.runtimeMs > 0
                ? { runtimeMs: value.runtimeMs }
                : {}),
            }
          : {}),
      };
}

async function readCancellation(directory, request) {
  let value;
  try {
    value = await readBoundedJson(join(directory, "cancel-intent.json"), 4096);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  if (
    typeof value.noStart !== "boolean" ||
    (value.requestDigest !== undefined && !/^[a-f0-9]{64}$/.test(value.requestDigest)) ||
    (value.admissionDeadlineAt !== undefined &&
      (!Number.isSafeInteger(value.admissionDeadlineAt) || value.admissionDeadlineAt < 1))
  )
    fail("invalid operation cancellation intent");
  if (request.requestDigest !== undefined && request.requestDigest !== value.requestDigest)
    fail("operation cancellation intent mismatch");
  if (
    request.admissionDeadlineAt !== undefined &&
    value.admissionDeadlineAt !== undefined &&
    request.admissionDeadlineAt !== value.admissionDeadlineAt
  )
    fail("operation cancellation deadline mismatch");
  return value;
}

async function publishNotStarted(directory, metadata) {
  await writeDurableJson(directory, "result.json", {
    state: "not_started",
    stdout: "",
    stderr: "",
    exitCode: null,
    stdoutBytes: 0,
    stderrBytes: 0,
    outputLimitExceeded: false,
    sessionCaptureDropped: false,
    ...(metadata.requestDigest === undefined ? {} : { requestDigest: metadata.requestDigest }),
  });
  return readResult(directory);
}

/** The existing kernel-lock pattern, scoped to one explicit session and handed to its runner. */
async function acquireSessionLock(request, capacity = false) {
  if (!request.session || (capacity && !request.sessionStart)) return null;
  await mkdir(SESSION_ROOT, { recursive: true, mode: 0o700 });
  const path = join(SESSION_ROOT, capacity ? ".capacity.lock" : `${request.session}.lock`);
  return acquireKernelLock(path, request.admissionDeadlineAt);
}

/** One kernel-owned primitive also fences cancellation against the actual launch boundary. */
async function acquireKernelLock(path, deadlineAt) {
  const holder =
    process.platform === "linux"
      ? spawn(
          "/usr/bin/flock",
          [
            "--exclusive",
            path,
            "/bin/sh",
            "-c",
            'printf 1; while IFS= read -r line; do [ "$line" = release ] && break; done',
          ],
          { stdio: ["pipe", "pipe", "pipe"] },
        )
      : spawn(
          "python3",
          [
            "-c",
            "import fcntl,sys; f=open(sys.argv[1],'a'); fcntl.flock(f,fcntl.LOCK_EX); print('1',flush=True);\nfor line in sys.stdin:\n if line.rstrip('\\n') == 'release': break",
            path,
          ],
          { stdio: ["pipe", "pipe", "pipe"] },
        );
  holder.stdin.on("error", () => undefined);
  holder.stderr.resume();
  let timer;
  try {
    const acquired = await new Promise((done, reject) => {
      holder.once("error", reject);
      holder.once("close", () => reject(new Error("lock owner exited before admission")));
      holder.stdout.once("data", () => done(true));
      if (deadlineAt !== undefined)
        timer = setTimeout(() => done(false), Math.max(0, deadlineAt - Date.now()));
    });
    if (!acquired) {
      holder.kill("SIGTERM");
      holder.stdin.destroy();
      return null;
    }
    return {
      stream: holder.stdin,
      release: () => {
        holder.stdin.destroy();
        holder.stdout.destroy();
        holder.stderr.destroy();
        holder.unref();
      },
    };
  } catch (error) {
    holder.kill("SIGTERM");
    holder.stdin.destroy();
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function execute(request, binding) {
  const directory = validateBase(request);
  const { repositoryName } = validateExecution(request);
  const requestHash = createHash("sha256").update(JSON.stringify(request)).digest("hex");
  await mkdir(dirname(directory), { recursive: true, mode: 0o700 });
  try {
    await mkdir(directory, { mode: 0o700 });
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    const cancellation = await readCancellation(directory, request);
    if (cancellation) {
      if (cancellation.requestDigest !== request.requestDigest)
        fail("operation cancellation intent mismatch");
      return inspect(request);
    }
    const accepted = await executionMetadata(directory);
    if (
      !accepted ||
      accepted.requestHash !== requestHash ||
      accepted.requestDigest !== request.requestDigest
    )
      fail("operation execution intent mismatch");
    return inspect(request);
  }
  const execution = {
    requestHash,
    launchAttempted: false,
    ...(request.requestDigest === undefined ? {} : { requestDigest: request.requestDigest }),
    ...(request.admissionDeadlineAt === undefined
      ? {}
      : { admissionDeadlineAt: request.admissionDeadlineAt }),
  };
  await writeDurableJson(directory, "execution.json", execution);
  const notStarted = async () => {
    await writeDurableJson(directory, "result.json", {
      state: "not_started",
      stdout: "",
      stderr: "",
      exitCode: null,
      stdoutBytes: 0,
      stderrBytes: 0,
      outputLimitExceeded: false,
      sessionCaptureDropped: false,
      ...receiptMetadata(execution),
    });
    return readResult(directory);
  };
  if (request.admissionDeadlineAt !== undefined && Date.now() >= request.admissionDeadlineAt)
    return notStarted();
  const sessionLock = await acquireSessionLock(request);
  let capacityLock = null;
  let admissionLock = null;
  try {
    if (request.session && !sessionLock) return notStarted();
    if (request.admissionDeadlineAt !== undefined && Date.now() >= request.admissionDeadlineAt)
      return notStarted();
    capacityLock = await acquireSessionLock(request, true);
    if (request.session && request.sessionStart && !capacityLock) return notStarted();
    if (request.admissionDeadlineAt !== undefined && Date.now() >= request.admissionDeadlineAt)
      return notStarted();
    const session = await resolveSession(request);
    // A command whose session belongs to an earlier life of this environment does not run at all.
    if (session === null) return { state: "session_unavailable", ...receiptMetadata(execution) };
    if (session.limit)
      return { state: "session_limit", limit: session.limit, ...receiptMetadata(execution) };
    admissionLock = await acquireKernelLock(
      join(directory, "admission.lock"),
      request.admissionDeadlineAt,
    );
    if (!admissionLock) return notStarted();
    if (request.admissionDeadlineAt !== undefined && Date.now() >= request.admissionDeadlineAt)
      return notStarted();
    const cancellation = await readCancellation(directory, request);
    if (cancellation) return inspect(request);
    // Ending a session is answered here: the stored context is removed and nothing is dispatched.
    if (session.ended) {
      await writeDurableJson(directory, "execution.json", { ...execution, launchAttempted: true });
      const startedAt = Date.now();
      if (request.admissionDeadlineAt !== undefined && startedAt >= request.admissionDeadlineAt)
        return notStarted();
      await session.end?.();
      await writeDurableJson(directory, "execution.json", {
        ...execution,
        launchAttempted: true,
        startedAt,
        runtimeMs: request.timeoutMs,
      });
      await writeDurableJson(directory, "result.json", {
        state: "succeeded",
        stdout: "",
        stderr: "",
        exitCode: 0,
        stdoutBytes: 0,
        stderrBytes: 0,
        outputLimitExceeded: false,
        sessionCaptureDropped: false,
        requestDigest: request.requestDigest,
        startedAt,
        runtimeMs: request.timeoutMs,
      });
      if (request.requestDigest === undefined) return { state: "session_ended" };
      return readResult(directory);
    }
    const cwd = await verifyRepository({ ...request, cwd: session.cwd }, repositoryName, binding);
    // The life of the environment the command runs in, so a later inspection can tell a command whose
    // codespace restarted underneath it from a supervisor that exited without publishing a result.
    const life = await environmentIdentity();
    if (life) await writeFile(join(directory, "environment"), life, { mode: 0o600 });
    const pidPath = join(directory, "pid");
    const runnerPidPath = join(directory, "runner-pid");
    const stdoutPath = join(directory, OUTPUT_STREAMS.get("stdout"));
    const stderrPath = join(directory, OUTPUT_STREAMS.get("stderr"));
    const resultPath = join(directory, "result.json");
    const resultTempPath = join(directory, "result.tmp");
    const cancelPath = join(directory, "cancel-requested");
    const capturePath = join(directory, "session-capture.json");
    let scriptPath = null;
    if (request.script !== undefined) {
      scriptPath = join(directory, "script.sh");
      await writeFile(scriptPath, request.script, { mode: 0o600 });
    }
    const runner = spawn(process.execPath, ["-e", RUNNER], {
      detached: true,
      stdio: [
        "pipe",
        "ignore",
        "ignore",
        sessionLock?.stream ?? "ignore",
        capacityLock?.stream ?? "ignore",
        admissionLock.stream,
      ],
      env: process.env,
    });
    // The runner records initial context only after an actual launch, so an expired admission
    // cannot modify a session before returning its not_started receipt.
    runner.stdin.end(
      JSON.stringify({
        argv: request.argv ?? null,
        script: scriptPath,
        capturePath,
        shellOwned: [...SHELL_OWNED_VARIABLES],
        sessionEnd: Boolean(request.sessionEnd),
        repositoryRoot: binding?.root ?? join(CODESPACES_ROOT, repositoryName),
        session: session.store
          ? {
              path: sessionPath(request.session),
              identity: await environmentIdentity(),
              context: session.context,
              cwd: session.cwd,
              maxVariables: MAX_SESSION_VARIABLES,
              maxBytes: MAX_SESSION_BYTES,
              maxValueLength: MAX_SESSION_VALUE_LENGTH,
              namePattern: ENVIRONMENT_NAME.source,
            }
          : null,
        cwd,
        // The context travels as it is stored, so a removal reaches the child as a removal.
        env: session.context ?? session.env,
        stdin: request.stdin,
        timeoutMs: request.timeoutMs,
        maxStdoutBytes: request.maxStdoutBytes,
        maxStderrBytes: request.maxStderrBytes,
        maxRetainedBytes: request.maxRetainedBytes,
        maxPrefixBytes: MAX_RESULT_PREFIX_BYTES,
        admissionDeadlineAt: request.admissionDeadlineAt,
        requestDigest: request.requestDigest,
        execution,
        executionPath: join(directory, "execution.json"),
        sessionLock: Boolean(sessionLock),
        sessionCapacityLock: Boolean(capacityLock),
        admissionLock: true,
        pidPath,
        runnerPidPath,
        stdoutPath,
        stderrPath,
        resultPath,
        resultTempPath,
        cancelPath,
      }),
    );
    runner.unref();
    // Dispatch is proven by the child's identity or by a result the runner already published;
    // a command that outlives neither is not silently left running.
    for (let attempt = 0; attempt < 80; attempt++) {
      if (await dispatched(pidPath, resultPath)) break;
      await new Promise((resolveValue) => setTimeout(resolveValue, 25));
    }
    if (!(await dispatched(pidPath, resultPath))) {
      await access(pidPath, constants.R_OK);
    }
    const proof = await executionMetadata(directory);
    if (request.requestDigest !== undefined)
      return (
        (await readResult(directory)) ?? {
          state: proof?.startedAt ? "running" : "outcome_unknown",
          ...receiptMetadata(proof),
        }
      );
    return { state: "running" };
  } finally {
    admissionLock?.release();
    capacityLock?.release();
    sessionLock?.release();
  }
}

async function dispatched(pidPath, resultPath) {
  for (const path of [pidPath, resultPath]) {
    try {
      await access(path, constants.R_OK);
      return true;
    } catch {
      // The next evidence path is checked before the caller waits again.
    }
  }
  return false;
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
      stdoutBytes: Number.isSafeInteger(value.stdoutBytes) ? value.stdoutBytes : 0,
      stderrBytes: Number.isSafeInteger(value.stderrBytes) ? value.stderrBytes : 0,
      outputLimitExceeded: value.outputLimitExceeded === true,
      sessionCaptureDropped: value.sessionCaptureDropped === true,
      ...receiptMetadata(value),
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
  // Recorded without a start time on Linux: the process was already gone when its identity
  // was published, so it is never reported as live and its result file is the authority.
  if (process.platform === "linux" && startTime === null) return false;
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

/**
 * Whether this operation belongs to an earlier life of the environment. A command's processes do not
 * survive a codespace restart while its state directory does, so a recorded life that is not the
 * current one is what separates a restart from a supervisor that failed inside this life.
 */
async function lostWithEnvironment(directory) {
  const recorded = await readFile(join(directory, "environment"), "utf8").catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (!recorded) return false;
  const current = await environmentIdentity();
  return Boolean(current) && recorded.trim() !== current;
}

async function inspect(request) {
  const directory = validateBase(request);
  try {
    await access(directory, constants.R_OK);
    const proof = await executionMetadata(directory);
    const cancellation = await readCancellation(directory, request);
    if (cancellation?.noStart && proof?.startedAt !== undefined)
      fail("cancellation contradicts a proved launch");
    if (
      request.requestDigest !== undefined &&
      proof?.requestDigest !== undefined &&
      request.requestDigest !== proof.requestDigest
    )
      fail("operation inspection intent mismatch");
    const result = await readResult(directory);
    if (result && !proof?.finalized) return result;
    if (cancellation?.noStart) {
      if (proof?.startedAt !== undefined) fail("cancellation contradicts a proved launch");
      return {
        state: "not_started",
        stdoutBase64: "",
        stderrBase64: "",
        exitCode: null,
        stdoutBytes: 0,
        stderrBytes: 0,
        outputLimitExceeded: false,
        sessionCaptureDropped: false,
        ...receiptMetadata(cancellation),
      };
    }
    const running = () => ({
      state: proof?.requestDigest !== undefined && !proof.startedAt ? "outcome_unknown" : "running",
      ...receiptMetadata(proof),
    });
    const identity = await readOptionalProcessIdentity(directory, "pid");
    if (identity && (await processExists(identity))) return running();
    const runnerIdentity = await readOptionalProcessIdentity(directory, "runner-pid");
    if (runnerIdentity && (await processExists(runnerIdentity))) return running();
    const publishedAfterRunnerExit = await readResult(directory);
    if (publishedAfterRunnerExit) return publishedAfterRunnerExit;
    if (await lostWithEnvironment(directory))
      return { state: "interrupted", ...receiptMetadata(proof) };
    if (
      proof?.requestDigest !== undefined ||
      cancellation ||
      proof?.launchAttempted === false ||
      (proof?.launchAttempted === true && proof.startedAt === undefined)
    )
      return { state: "outcome_unknown", ...receiptMetadata(proof ?? cancellation) };
    return {
      state: "failed",
      stdoutBase64: "",
      stderrBase64: Buffer.from("operation supervisor exited without a result").toString("base64"),
      exitCode: null,
      stdoutBytes: 0,
      stderrBytes: 0,
      outputLimitExceeded: false,
      sessionCaptureDropped: false,
      ...receiptMetadata(proof),
    };
  } catch (error) {
    if (error?.code === "ENOENT")
      return {
        state: "absent",
        ...(request.requestDigest === undefined ? {} : { requestDigest: request.requestDigest }),
      };
    throw error;
  }
}

async function cancel(request) {
  const directory = validateBase(request);
  if (
    (request.requestDigest !== undefined && !/^[a-f0-9]{64}$/.test(request.requestDigest)) ||
    (request.admissionDeadlineAt !== undefined &&
      (!Number.isSafeInteger(request.admissionDeadlineAt) || request.admissionDeadlineAt < 1))
  )
    fail("invalid cancellation request");
  await mkdir(dirname(directory), { recursive: true, mode: 0o700 });
  let created = false;
  try {
    await mkdir(directory, { mode: 0o700 });
    created = true;
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
  // Cancellation is control authority, so its gate does not reopen or extend admission.
  const gate = await acquireKernelLock(join(directory, "admission.lock"));
  try {
    const proof = await executionMetadata(directory);
    if (
      request.requestDigest !== undefined &&
      proof?.requestDigest !== undefined &&
      proof.requestDigest !== request.requestDigest
    )
      fail("operation cancellation intent mismatch");
    if (
      request.admissionDeadlineAt !== undefined &&
      proof?.admissionDeadlineAt !== undefined &&
      proof.admissionDeadlineAt !== request.admissionDeadlineAt
    )
      fail("operation cancellation deadline mismatch");
    const previous = await readCancellation(directory, request);
    const current = await inspect(request);
    if (current.state !== "not_started" && (await readResult(directory))) return current;
    const noStart =
      previous?.noStart === true ||
      current.state === "not_started" ||
      (proof?.startedAt === undefined && (created || proof?.launchAttempted === false));
    const intent = {
      noStart,
      ...(request.requestDigest === undefined ? {} : { requestDigest: request.requestDigest }),
      ...((previous?.admissionDeadlineAt ??
        proof?.admissionDeadlineAt ??
        request.admissionDeadlineAt) === undefined
        ? {}
        : {
            admissionDeadlineAt:
              previous?.admissionDeadlineAt ??
              proof?.admissionDeadlineAt ??
              request.admissionDeadlineAt,
          }),
    };
    await writeDurableJson(directory, "cancel-intent.json", intent);
    if (noStart) return publishNotStarted(directory, intent);
    // An attempted launch without durable proof is ambiguous even if its gate owner crashed.
    if (current.state !== "running")
      return { state: "outcome_unknown", ...receiptMetadata(proof ?? intent) };
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
    if (await processExists(identity))
      return { state: "running", ...receiptMetadata(await executionMetadata(directory)) };
    const completed = await readResult(directory);
    if (completed) return completed;
    const runnerIdentity = await readOptionalProcessIdentity(directory, "runner-pid");
    if (runnerIdentity && (await processExists(runnerIdentity)))
      return { state: "running", ...receiptMetadata(proof) };
    const result = {
      state: "cancelled",
      stdoutBase64: "",
      stderrBase64: "",
      exitCode: null,
      stdoutBytes: await retainedSize(directory, "stdout"),
      stderrBytes: await retainedSize(directory, "stderr"),
      outputLimitExceeded: false,
      sessionCaptureDropped: false,
      ...receiptMetadata(await executionMetadata(directory)),
    };
    // A cancelled command still produced whatever it printed; the published result names those
    // sizes so the retained streams stay readable by range until cleanup removes them.
    await writeDurableJson(directory, "result.json", {
      state: result.state,
      stdout: "",
      stderr: "",
      exitCode: null,
      stdoutBytes: result.stdoutBytes,
      stderrBytes: result.stderrBytes,
      outputLimitExceeded: false,
      ...receiptMetadata(result),
    });
    return result;
  } finally {
    gate.release();
  }
}

async function retainedSize(directory, stream) {
  try {
    const value = await stat(join(directory, OUTPUT_STREAMS.get(stream)));
    return value.isFile() ? value.size : 0;
  } catch {
    return 0;
  }
}

async function readOutput(request) {
  const directory = validateBase(request);
  if ((await executionMetadata(directory))?.finalized) return { state: "absent" };
  const fileName = OUTPUT_STREAMS.get(request.stream);
  if (
    !fileName ||
    !Number.isSafeInteger(request.offset) ||
    request.offset < 0 ||
    !Number.isSafeInteger(request.length) ||
    request.length < 1 ||
    request.length > MAX_OUTPUT_RANGE_BYTES
  ) {
    fail("invalid output range");
  }
  let handle = null;
  try {
    handle = await open(join(directory, fileName), "r");
    const totalBytes = (await handle.stat()).size;
    // A read that starts at or past the end is answered with no bytes and the true size, which is
    // how a caller learns where the stream currently ends without an error.
    const bytes = Buffer.alloc(Math.max(0, Math.min(request.length, totalBytes - request.offset)));
    if (bytes.length > 0) await handle.read(bytes, 0, bytes.length, request.offset);
    return {
      action: "output",
      stream: request.stream,
      offset: request.offset,
      totalBytes,
      bytesBase64: bytes.toString("base64"),
    };
  } catch (error) {
    if (error?.code === "ENOENT") return { state: "absent" };
    throw error;
  } finally {
    await handle?.close();
  }
}

async function finalize(request) {
  const directory = validateBase(request);
  const current = await inspect(request);
  const proof = await executionMetadata(directory);
  if (current.state === "running") fail("operation is still running");
  if (current.state === "outcome_unknown" && !proof?.finalized)
    fail("operation outcome is unresolved");
  const cancellation = await readCancellation(directory, request);
  if (
    cancellation?.noStart &&
    (cancellation.admissionDeadlineAt === undefined ||
      cancellation.admissionDeadlineAt > Date.now())
  )
    return current;
  if (
    proof?.requestDigest !== undefined &&
    (proof.admissionDeadlineAt === undefined || proof.admissionDeadlineAt > Date.now())
  ) {
    // Output retention does not reopen launch authority. Remove bytes now, but
    // retain the immutable marker until the original admission has closed.
    await writeDurableJson(directory, "execution.json", { ...proof, finalized: true });
    for (const entry of await readdir(directory))
      if (!["execution.json", "cancel-intent.json", "admission.lock"].includes(entry))
        await rm(join(directory, entry), { recursive: true, force: true });
    return { state: "outcome_unknown", ...receiptMetadata(proof) };
  }
  try {
    await access(join(directory, "file-transaction.conflicted.json"));
    for (const entry of await readdir(directory))
      if (entry !== "file-transaction.conflicted.json")
        await rm(join(directory, entry), { recursive: true, force: true });
    return { state: "absent" };
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  await rm(directory, { recursive: true, force: true });
  return { state: "absent" };
}

/** Binding is supplied by the installed provider worker, never decoded from a job request. */
export async function runRequest(request, binding) {
  if (
    binding !== undefined &&
    (!binding ||
      typeof binding !== "object" ||
      Array.isArray(binding) ||
      Object.keys(binding).sort().join(",") !== "dev,ino,origin,repositoryFullName,root" ||
      typeof binding.repositoryFullName !== "string" ||
      !REPOSITORY.test(binding.repositoryFullName) ||
      typeof binding.root !== "string" ||
      resolve(binding.root) !== binding.root ||
      typeof binding.origin !== "string" ||
      binding.origin.length < 1 ||
      binding.origin.length > 4096 ||
      !Number.isSafeInteger(binding.dev) ||
      binding.dev < 0 ||
      !Number.isSafeInteger(binding.ino) ||
      binding.ino < 1)
  )
    fail("invalid provider repository binding");
  if (request.action === "execute") return execute(request, binding);
  if (request.action === "inspect") return inspect(request);
  if (request.action === "cancel") return cancel(request);
  if (request.action === "finalize") return finalize(request);
  if (request.action === "output") return readOutput(request);
  if (request.action === "file-execute") return fileExecute(request, binding);
  if (request.action === "file-inspect") return fileInspect(request, binding);
  fail("unsupported supervisor action");
}

export async function runEncoded(encoded) {
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.length > MAX_CONTROL_BYTES) fail("request too large");
  const result = await runRequest(JSON.parse(bytes.toString("utf8")));
  process.stdout.write(JSON.stringify({ ok: true, result }));
}
