import { spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import { URL } from "node:url";
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
  unlink,
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
  "probe",
  "describe_transfer",
  "stat",
  "search",
  "read",
  "write",
  "upload",
  "apply_patch",
  "download",
]);
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const TRANSFER_CHUNK_BYTES = 256 * 1024;
const TRANSFER_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
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

async function installedAssetHash(path, { executable = false } = {}) {
  let handle;
  try {
    const before = await lstat(path, { bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.size > BigInt(MAX_FILE_BYTES))
      fail("installed guest asset is unsafe");
    if (executable) await access(path, constants.X_OK);
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = await handle.stat({ bigint: true });
    if (!sameFileIdentity(fileIdentity(before), fileIdentity(opened)))
      fail("installed guest asset changed");
    const sha256 = await hashRegular(handle, Number(opened.size));
    const after = await handle.stat({ bigint: true });
    const named = await lstat(path, { bigint: true });
    if (
      !sameFileIdentity(fileIdentity(opened), fileIdentity(after)) ||
      !sameFileIdentity(fileIdentity(opened), fileIdentity(named))
    )
      fail("installed guest asset changed");
    return sha256;
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  } finally {
    await handle?.close();
  }
}

async function probeFileRuntime(binding) {
  const identity = await environmentIdentity();
  if (!identity) fail("guest environment identity is unavailable");
  const command = join(homedir(), ".local/bin/moira-files");
  return {
    action: "probe",
    abi: 1,
    environmentIdentity: identity,
    workerSha256: binding ? await installedAssetHash("/tmp/moira-local-runtime/worker.mjs") : null,
    cliSha256: await installedAssetHash(join(homedir(), ".local/share/moira-files/client.mjs")),
    command,
    executableSha256: await installedAssetHash(command, { executable: true }),
  };
}

async function fileClientConfiguration() {
  const value = await readBoundedJson(
    join(homedir(), ".local/share/moira-files/config.json"),
    16384,
  );
  const origin = new URL(value.origin);
  if (
    Object.keys(value).sort().join(",") !==
      "bootstrapCapability,environmentIdentity,origin,repositoryFullName,resourceId,version" ||
    value.version !== 1 ||
    origin.protocol !== "https:" ||
    origin.origin !== value.origin ||
    origin.username ||
    origin.password ||
    !TRANSFER_ID.test(value.resourceId) ||
    !REPOSITORY.test(value.repositoryFullName) ||
    !/^[a-f0-9]{64}$/.test(value.environmentIdentity) ||
    typeof value.bootstrapCapability !== "string" ||
    value.bootstrapCapability.length > 8192 ||
    !/^[A-Za-z0-9._~-]{20,}$/.test(value.bootstrapCapability)
  )
    fail("invalid file client configuration");
  if ((await environmentIdentity()) !== value.environmentIdentity)
    fail("file client belongs to a previous guest life");
  return value;
}

function transferDescriptor(value, configuration) {
  if (
    !value ||
    value.version !== 1 ||
    !TRANSFER_ID.test(value.transferId) ||
    !TRANSFER_ID.test(value.requestId) ||
    !["guest_to_server", "server_to_guest"].includes(value.direction) ||
    !Number.isSafeInteger(value.size) ||
    value.size < 0 ||
    !/^[a-f0-9]{64}$/.test(value.sha256) ||
    typeof value.mimeType !== "string" ||
    value.mimeType.length > 256 ||
    value.chunkBytes !== TRANSFER_CHUNK_BYTES ||
    !Number.isSafeInteger(value.expiresAt) ||
    value.expiresAt <= Date.now() ||
    value.environmentIdentity !== configuration.environmentIdentity ||
    value.origin !== configuration.origin ||
    typeof value.capability !== "string" ||
    value.capability.length > 8192 ||
    !/^[A-Za-z0-9._~-]{20,}$/.test(value.capability)
  )
    fail("invalid transfer descriptor");
  return value;
}

/** Curl owns TLS/proxy handling; each invocation carries only one bounded HTTP body. */
async function fileHttp(
  configuration,
  capability,
  method,
  path,
  bytes,
  maximum = 65536,
  json = false,
) {
  if ((await environmentIdentity()) !== configuration.environmentIdentity)
    fail("transfer guest life changed");
  if (
    !path.startsWith("/api/public/codespace-files/") ||
    path.includes("\n") ||
    path.includes("\r")
  )
    fail("invalid file endpoint");
  const directory = join(STATE_ROOT, "file-http");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const nonce = randomBytes(16).toString("hex");
  const headersPath = join(directory, `${nonce}.request`);
  const responsePath = join(directory, `${nonce}.response`);
  const headers = [`Authorization: Bearer ${capability}`];
  if (bytes !== undefined) {
    if (bytes.length > TRANSFER_CHUNK_BYTES) fail("file HTTP body exceeds its bound");
    headers.push(`Content-Type: ${json ? "application/json" : "application/octet-stream"}`);
    if (method === "PUT")
      headers.push(`X-Chunk-SHA256: ${createHash("sha256").update(bytes).digest("hex")}`);
  }
  await writeFile(headersPath, headers.join("\n"), { mode: 0o600, flag: "wx" });
  try {
    const argv = [
      "--silent",
      "--show-error",
      "--fail",
      "--proto",
      "=https",
      "--proto-redir",
      "=https",
      "--max-redirs",
      "0",
      "--connect-timeout",
      "15",
      "--max-time",
      "120",
      "--request",
      method,
      "--header",
      `@${headersPath}`,
      "--dump-header",
      responsePath,
    ];
    if (bytes !== undefined) argv.push("--data-binary", "@-");
    argv.push(configuration.origin + path);
    const outcome = await new Promise((done) => {
      const child = spawn("curl", argv, { stdio: ["pipe", "pipe", "pipe"], env: process.env });
      const chunks = [];
      let length = 0;
      let failure;
      const refuse = (kind) => {
        if (failure) return;
        failure = kind;
        child.kill("SIGKILL");
      };
      child.stderr.resume();
      child.stdin.on("error", () => undefined);
      child.stdout.on("data", (chunk) => {
        length += chunk.length;
        if (length > maximum) refuse("response_limit");
        else chunks.push(Buffer.from(chunk));
      });
      child.once("error", () => refuse("process"));
      child.once("close", (code) => {
        done({
          kind: failure ?? (code === 0 ? null : "transport"),
          processExitCode: Number.isInteger(code) && code > 0 && code <= 255 ? code : null,
          body: !failure && code === 0 ? Buffer.concat(chunks, length) : null,
        });
      });
      child.stdin.end(bytes);
    });
    const responseHeaders = await (async () => {
      const headerStat = await lstat(responsePath);
      if (
        !headerStat.isFile() ||
        headerStat.isSymbolicLink() ||
        headerStat.nlink !== 1 ||
        headerStat.size > 16384
      )
        fail("invalid transfer response headers");
      return readFile(responsePath, "utf8");
    })().catch((error) => {
      // Missing/invalid headers cannot replace a genuinely unconfirmed process outcome.
      if (!outcome.kind) throw error;
      return "";
    });
    if (outcome.kind) {
      const statuses = [...responseHeaders.matchAll(/^HTTP\/\d(?:\.\d)? ([0-9]{3})(?: |\r?$)/gm)];
      const observed = Number(statuses.at(-1)?.[1]);
      const httpStatus = observed >= 400 && observed <= 599 ? observed : null;
      const error = new Error("file HTTP operation is unconfirmed");
      error.code = "TRANSFER_OUTCOME_UNKNOWN";
      error.diagnostic = {
        kind: outcome.kind === "transport" && httpStatus !== null ? "http" : outcome.kind,
        ...(httpStatus !== null && outcome.kind === "transport" ? { httpStatus } : {}),
        ...(outcome.processExitCode === null ? {} : { processExitCode: outcome.processExitCode }),
      };
      throw error;
    }
    return { body: outcome.body, headers: responseHeaders };
  } finally {
    await rm(headersPath, { force: true });
    await rm(responsePath, { force: true });
  }
}

async function fileHttpJson(configuration, capability, method, path, value) {
  const body = value === undefined ? undefined : Buffer.from(JSON.stringify(value));
  const response = await fileHttp(configuration, capability, method, path, body, 65536, true);
  return JSON.parse(response.body.toString("utf8"));
}

function transferPath(descriptor, suffix = "") {
  return `/api/public/codespace-files/transfers/${descriptor.transferId}${suffix}`;
}

function validateTransferStatus(value, descriptor) {
  if (
    !value ||
    value.transferId !== descriptor.transferId ||
    value.requestId !== descriptor.requestId ||
    value.size !== descriptor.size ||
    value.sha256 !== descriptor.sha256 ||
    !Number.isSafeInteger(value.offset) ||
    value.offset < 0 ||
    value.offset > descriptor.size
  )
    fail("transfer status differs from accepted descriptor");
  return value;
}

async function transferStatus(configuration, descriptor) {
  return validateTransferStatus(
    await fileHttpJson(configuration, descriptor.capability, "GET", transferPath(descriptor)),
    descriptor,
  );
}

function publicationReceipt(value, descriptor) {
  if (
    !value ||
    value.state !== "ready" ||
    value.transferId !== descriptor.transferId ||
    value.size !== descriptor.size ||
    value.sha256 !== descriptor.sha256 ||
    typeof value.referenceId !== "string" ||
    !value.referenceId ||
    value.referenceId.length > 8192
  )
    fail("transfer publication receipt is invalid");
  return value;
}

async function transferCheckpoint(directory, descriptor, path, expected) {
  const identity = {
    transferId: descriptor.transferId,
    requestId: descriptor.requestId,
    direction: descriptor.direction,
    size: descriptor.size,
    sha256: descriptor.sha256,
    mimeType: descriptor.mimeType,
    origin: descriptor.origin,
    environmentIdentity: descriptor.environmentIdentity,
    expiresAt: descriptor.expiresAt,
    capabilitySha256: createHash("sha256").update(descriptor.capability).digest("hex"),
    path,
    expected: expected ?? null,
  };
  const digest = createHash("sha256").update(JSON.stringify(identity)).digest("hex");
  let checkpoint;
  try {
    checkpoint = await readBoundedJson(join(directory, "transfer.json"), 65536);
    if (checkpoint.digest !== digest) fail("transfer checkpoint intent changed");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    checkpoint = { digest, offset: 0, state: "streaming", expiresAt: descriptor.expiresAt };
    await writeDurableJson(directory, "transfer.json", checkpoint);
  }
  return checkpoint;
}

async function pushTransfer(root, path, configuration, descriptor, directory) {
  const checkpoint = await transferCheckpoint(directory, descriptor, path);
  if (checkpoint.receipt) return checkpoint.receipt;
  const status = await transferStatus(configuration, descriptor);
  if (status.state === "ready" && status.receipt)
    return publicationReceipt(status.receipt, descriptor);
  if (status.offset !== descriptor.size && status.offset % TRANSFER_CHUNK_BYTES !== 0)
    fail("invalid persisted transfer offset");
  await withRegularFile(
    root,
    path,
    async (handle, size) => {
      if (size !== descriptor.size) failFile("concurrent_change", "transfer source size changed");
      const hash = createHash("sha256");
      const buffer = Buffer.alloc(Math.min(size, TRANSFER_CHUNK_BYTES));
      for (let offset = 0; offset < size;) {
        const length = Math.min(buffer.length, size - offset);
        await readExact(handle, buffer.subarray(0, length), offset);
        const bytes = buffer.subarray(0, length);
        hash.update(bytes);
        if (offset >= status.offset) {
          let acknowledged;
          try {
            const reply = await fileHttp(
              configuration,
              descriptor.capability,
              "PUT",
              transferPath(descriptor, `/chunks?offset=${offset}&length=${length}`),
              bytes,
            );
            acknowledged = validateTransferStatus(
              JSON.parse(reply.body.toString("utf8")),
              descriptor,
            );
          } catch (error) {
            if (error?.code !== "TRANSFER_OUTCOME_UNKNOWN") throw error;
            acknowledged = await transferStatus(configuration, descriptor);
          }
          if (acknowledged.offset !== offset + length) fail("transfer chunk was not confirmed");
          checkpoint.offset = acknowledged.offset;
          await writeDurableJson(directory, "transfer.json", checkpoint);
        }
        offset += length;
      }
      if (hash.digest("hex") !== descriptor.sha256)
        failFile("concurrent_change", "transfer source digest changed");
      return {};
    },
    { maximum: descriptor.size },
  );
  // Publication follows the held descriptor's final path/identity observation.
  const receipt = publicationReceipt(
    await fileHttpJson(
      configuration,
      descriptor.capability,
      "POST",
      transferPath(descriptor, "/finalize"),
    ),
    descriptor,
  );
  checkpoint.state = "committed";
  checkpoint.receipt = receipt;
  await writeDurableJson(directory, "transfer.json", checkpoint);
  return receipt;
}

async function pullTransfer(root, path, expected, configuration, descriptor, directory, marker) {
  let checkpoint = await transferCheckpoint(directory, descriptor, path, expected);
  if (checkpoint.receipt) return checkpoint.receipt;
  const location = await parentDirectory(root, path);
  let current;
  let handle;
  let staged;
  try {
    const parent = await directoryIdentity(location.handle);
    if (checkpoint.parent && !sameDirectoryIdentity(parent, checkpoint.parent))
      failFile("concurrent_change", "transfer target parent changed");
    current = await currentFile(root, path, { keepOpen: true, stream: true });
    if (checkpoint.state === "committing") {
      // A durable staged inode proves our rename; matching bytes alone cannot identify an effect.
      if (
        current &&
        checkpoint.identity &&
        sameFileIdentity(checkpoint.identity, current.stat.identity, { afterRename: true }) &&
        version(current.bytes, current.stat).sha256 === descriptor.sha256
      ) {
        const receipt = {
          path,
          size: descriptor.size,
          sha256: descriptor.sha256,
          previous: checkpoint.previous,
          current: version(current.bytes, current.stat),
        };
        checkpoint = { ...checkpoint, state: "committed", receipt };
        await writeDurableJson(directory, "transfer.json", checkpoint);
        await cleanupFileTransaction(directory, root);
        return receipt;
      }
      await recoverFileTransaction(directory, root);
      failFile("concurrent_change", "transfer commit did not settle with its staged inode");
    }
    validateExpected(expected, current);
    const previous = current ? version(current.bytes, current.stat) : null;
    if (
      checkpoint.original !== undefined &&
      JSON.stringify(checkpoint.original) !== JSON.stringify(current?.stat.identity ?? null)
    )
      failFile("concurrent_change", "transfer target changed during resume");
    const temporaryName =
      checkpoint.temporaryName ?? `.moira-${marker}-${randomBytes(8).toString("hex")}.tmp`;
    if (!/^\.moira-[a-z0-9-]+\.tmp$/.test(temporaryName)) fail("invalid transfer staging name");
    handle = await open(
      descriptorPath(location.handle, temporaryName),
      constants.O_RDWR |
        constants.O_NOFOLLOW |
        (checkpoint.temporaryName ? 0 : constants.O_CREAT | constants.O_EXCL),
      current?.stat.mode ? current.stat.mode & 0o777 : 0o600,
    );
    const partial = await handle.stat();
    if (
      !partial.isFile() ||
      partial.nlink !== 1 ||
      partial.size < checkpoint.offset ||
      partial.size > descriptor.size
    )
      fail("invalid transfer partial file");
    const partialIdentity = fileIdentity(await handle.stat({ bigint: true }));
    if (checkpoint.temporaryName) {
      const retained = checkpoint.partialIdentity;
      const unchanged = sameFileIdentity(retained, partialIdentity);
      const ownedTail =
        retained &&
        retained.birthtimeNs &&
        retained.birthtimeNs !== "0" &&
        partialIdentity.birthtimeNs !== partialIdentity.ctimeNs &&
        retained.birthtimeNs === partialIdentity.birthtimeNs &&
        retained.dev === partialIdentity.dev &&
        retained.ino === partialIdentity.ino &&
        retained.nlink === "1" &&
        partialIdentity.nlink === "1" &&
        retained.size === String(checkpoint.offset) &&
        partial.size > checkpoint.offset &&
        typeof checkpoint.partialSha256 === "string";
      if (!unchanged && !ownedTail)
        failFile("concurrent_change", "transfer partial identity changed during resume");
      if (
        checkpoint.partialSha256 &&
        (await hashRegular(handle, checkpoint.offset)) !== checkpoint.partialSha256
      )
        failFile("concurrent_change", "transfer partial prefix changed during resume");
    }
    if (partial.size > checkpoint.offset) await handle.truncate(checkpoint.offset);
    const prefixHash = createHash("sha256");
    const prefixBuffer = Buffer.alloc(Math.min(checkpoint.offset, TRANSFER_CHUNK_BYTES));
    for (let offset = 0; offset < checkpoint.offset;) {
      const read = await handle.read(
        prefixBuffer,
        0,
        Math.min(prefixBuffer.length, checkpoint.offset - offset),
        offset,
      );
      if (!read.bytesRead) fail("transfer retained prefix is incomplete");
      prefixHash.update(prefixBuffer.subarray(0, read.bytesRead));
      offset += read.bytesRead;
    }
    checkpoint = {
      ...checkpoint,
      parent,
      original: current?.stat.identity ?? null,
      previous,
      temporaryName,
      partialIdentity: fileIdentity(await handle.stat({ bigint: true })),
      partialSha256: prefixHash.copy().digest("hex"),
    };
    await writeDurableJson(directory, "transfer.json", checkpoint);
    for (let offset = checkpoint.offset; offset < descriptor.size;) {
      const length = Math.min(TRANSFER_CHUNK_BYTES, descriptor.size - offset);
      const response = await fileHttp(
        configuration,
        descriptor.capability,
        "GET",
        transferPath(descriptor, `/chunks?offset=${offset}&length=${length}`),
        undefined,
        length,
      );
      const hashes = [
        ...response.headers.matchAll(/(?:^|\n)x-chunk-sha256:\s*([a-f0-9]{64})\s*\r?$/gim),
      ];
      const offsets = [
        ...response.headers.matchAll(/(?:^|\n)x-chunk-offset:\s*([0-9]+)\s*\r?$/gim),
      ];
      if (
        response.body.length !== length ||
        hashes.length !== 1 ||
        offsets.length !== 1 ||
        Number(offsets[0][1]) !== offset ||
        createHash("sha256").update(response.body).digest("hex") !== hashes[0][1]
      )
        fail("transfer chunk integrity failed");
      let written = 0;
      while (written < length) {
        const result = await handle.write(
          response.body,
          written,
          length - written,
          offset + written,
        );
        if (!result.bytesWritten) fail("transfer partial write failed");
        written += result.bytesWritten;
      }
      await handle.sync();
      prefixHash.update(response.body);
      offset += length;
      checkpoint.offset = offset;
      checkpoint.partialIdentity = fileIdentity(await handle.stat({ bigint: true }));
      checkpoint.partialSha256 = prefixHash.copy().digest("hex");
      await writeDurableJson(directory, "transfer.json", checkpoint);
    }
    if ((await hashRegular(handle, descriptor.size)) !== descriptor.sha256)
      fail("transfer full digest failed");
    const identity = fileIdentity(await handle.stat({ bigint: true }));
    staged = {
      ...location,
      root,
      parentIdentity: parent,
      temporaryName,
      current,
      size: descriptor.size,
      sha256: descriptor.sha256,
      identity,
      stagingHandle: handle,
      stream: true,
      closed: false,
    };
    handle = undefined;
    publicationReceipt(
      await fileHttpJson(
        configuration,
        descriptor.capability,
        "POST",
        transferPath(descriptor, "/finalize"),
      ),
      descriptor,
    );
    await withFileCommitLock(async () => {
      if (
        Date.now() >= descriptor.expiresAt ||
        (await environmentIdentity()) !== descriptor.environmentIdentity
      )
        fail("transfer commit authority expired or changed");
      await recoverAbandonedFileCommits(root, configuration.repositoryFullName, directory);
      checkpoint = { ...checkpoint, state: "committing", identity };
      await writeDurableJson(directory, "transfer.json", checkpoint);
      await commitStaged([staged], marker, directory);
      const after = await currentFile(root, path, { stream: true });
      try {
        if (
          !after ||
          !sameFileIdentity(identity, after.stat.identity, { afterRename: true }) ||
          version(after.bytes, after.stat).sha256 !== descriptor.sha256
        )
          failFile("concurrent_change", "committed transfer target changed");
        const receipt = {
          path,
          size: descriptor.size,
          sha256: descriptor.sha256,
          previous,
          current: version(after.bytes, after.stat),
        };
        checkpoint = { ...checkpoint, state: "committed", receipt };
        await writeDurableJson(directory, "transfer.json", checkpoint);
        await cleanupFileTransaction(directory, root);
      } finally {
        await after?.handle?.close();
      }
    });
    return checkpoint.receipt;
  } finally {
    await handle?.close();
    if (!staged?.closed) {
      await staged?.stagingHandle?.close();
      await current?.handle?.close();
      await location.handle.close();
    }
  }
}

async function executeTransfer(root, request, directory, marker) {
  const configuration = await fileClientConfiguration();
  const descriptor = transferDescriptor(request.transfer, configuration);
  const path = safeRelativePath(request.path);
  if (request.action === "download" && descriptor.direction === "guest_to_server") {
    const receipt = await withTransferLock(descriptor, () =>
      pushTransfer(root, path, configuration, descriptor, directory),
    );
    return {
      action: "download",
      transferId: descriptor.transferId,
      path,
      size: descriptor.size,
      sha256: descriptor.sha256,
      referenceId: receipt.referenceId,
    };
  }
  if (request.action === "upload" && descriptor.direction === "server_to_guest") {
    const receipt = await withTransferLock(descriptor, () =>
      pullTransfer(root, path, request.expected, configuration, descriptor, directory, marker),
    );
    return { action: "upload", transferId: descriptor.transferId, ...receipt };
  }
  fail("transfer direction differs from file operation");
}

async function discardTransferPartial(root, intent, checkpoint) {
  if (!checkpoint?.temporaryName) return;
  const location = await parentDirectory(root, intent.request.path);
  let held;
  try {
    if (!sameDirectoryIdentity(await directoryIdentity(location.handle), checkpoint.parent))
      failFile("concurrent_change", "expired transfer parent changed");
    if (!/^\.moira-[a-z0-9-]+\.tmp$/.test(checkpoint.temporaryName))
      fail("invalid transfer staging name");
    const path = descriptorPath(location.handle, checkpoint.temporaryName);
    try {
      held = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
    const stat = await held.stat({ bigint: true });
    if (!stat.isFile() || !sameFileIdentity(fileIdentity(stat), checkpoint.partialIdentity))
      failFile("concurrent_change", "expired transfer staging changed");
    await verifyParentIdentity(root, intent.request.path, checkpoint.parent);
    if (
      !sameFileIdentity(
        fileIdentity(await lstat(path, { bigint: true })),
        checkpoint.partialIdentity,
      )
    )
      failFile("concurrent_change", "expired transfer staging changed");
    await unlink(path);
    await location.handle.sync();
  } finally {
    await held?.close();
    await location.handle.close();
  }
}

/** Expiry releases only a staged file whose last durable identity still belongs to this transfer. */
async function expireTransfer(directory, binding) {
  const intent = await readFileIntent(directory);
  if (!intent?.request?.transfer || Date.now() < intent.request.transfer.expiresAt) return null;
  const owner = await readOptionalProcessIdentity(directory, "file-runner-pid");
  if (owner && (await processExists(owner))) return null;
  const root = await repositoryRootForFile(intent, binding);
  return withFileCommitLock(async () => {
    const result = await readFileOperationResult(directory);
    if (result) return result;
    const checkpoint = await readBoundedJson(join(directory, "transfer.json"), 65536);
    if (checkpoint.state === "committed" && checkpoint.receipt) {
      const transfer = intent.request.transfer;
      const value =
        intent.request.action === "upload"
          ? { action: "upload", transferId: transfer.transferId, ...checkpoint.receipt }
          : {
              action: "download",
              transferId: transfer.transferId,
              path: intent.request.path,
              size: transfer.size,
              sha256: transfer.sha256,
              referenceId: checkpoint.receipt.referenceId,
            };
      await writeDurableJson(directory, "result.json", { kind: "file", state: "succeeded", value });
      await cleanupFileTransaction(directory, root);
      await rm(join(directory, "file-intent.json"), { force: true });
      return { state: "succeeded", value };
    }
    if (checkpoint.state === "committing") {
      const settled = await settleTransferCommit(directory, root, intent);
      if (settled) return settled;
      await recoverFileTransaction(directory, root);
    } else await discardTransferPartial(root, intent, checkpoint);
    const terminal = {
      kind: "file",
      state: "failed",
      value: {
        action: intent.request.action,
        state: "failed",
        code: "CODESPACE_FILE_REJECTED",
        reason: "precondition",
      },
    };
    await writeDurableJson(directory, "result.json", terminal);
    await rm(join(directory, "file-intent.json"), { force: true });
    return { state: terminal.state, value: terminal.value };
  });
}

async function withTransferLock(descriptor, work) {
  const directory = join(STATE_ROOT, "transfer-locks");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const lock = await acquireKernelLock(
    join(directory, `${descriptor.transferId}.lock`),
    Date.now() + 60_000,
  );
  if (!lock) fail("transfer is already in use");
  try {
    return await work();
  } finally {
    lock.release();
  }
}

/** Installed remote client: only scoped files API, never the local workflow engine. */
export async function runFilesClient(args) {
  const parsed = parseArgs({
    args,
    allowPositionals: true,
    strict: true,
    options: {
      "request-id": { type: "string" },
      mime: { type: "string" },
      "replace-sha256": { type: "string" },
      help: { type: "boolean" },
    },
  });
  const [action, source, destination] = parsed.positionals;
  if (action === "operation") {
    if (!MARKER.test(source)) fail("invalid transfer worker marker");
    const chunks = [];
    let length = 0;
    for await (const chunk of process.stdin) {
      length += chunk.length;
      if (length > MAX_CONTROL_BYTES) fail("transfer worker input exceeds its bound");
      chunks.push(Buffer.from(chunk));
    }
    const input = JSON.parse(Buffer.concat(chunks, length).toString("utf8"));
    if (input.request?.remoteMarker !== source || !input.request.request?.transfer)
      fail("invalid fixed transfer worker intent");
    return fileExecute(input.request, input.binding, { worker: true });
  }
  if (parsed.values.help || !action) {
    process.stdout.write(
      "moira-files upload PATH [--request-id UUID] [--mime TYPE]\nmoira-files download REFERENCE PATH [--request-id UUID] [--replace-sha256 SHA256]\nmoira-files status REQUEST_ID\n",
    );
    return;
  }
  const configuration = await fileClientConfiguration();
  if (action === "status") {
    if (!TRANSFER_ID.test(source)) fail("invalid transfer request identity");
    const status = await fileHttpJson(
      configuration,
      configuration.bootstrapCapability,
      "POST",
      "/api/public/codespace-files/lookup",
      { requestId: source.toLowerCase() },
    );
    process.stdout.write(`${JSON.stringify(status)}\n`);
    return;
  }
  if (!["upload", "download"].includes(action)) fail("unknown file client operation");
  const requestId = (parsed.values["request-id"] ?? randomUUID()).toLowerCase();
  if (!TRANSFER_ID.test(requestId)) fail("invalid transfer request identity");
  // Printed before the first admission request so a lost reply remains recoverable.
  process.stdout.write(`${JSON.stringify({ requestId, state: "request_prepared" })}\n`);
  const name = configuration.repositoryFullName.match(REPOSITORY)[1];
  let binding;
  try {
    binding = await readBoundedJson(
      join(homedir(), ".local/share/moira-local/repository.json"),
      16384,
    );
    if (
      binding.repositoryFullName !== configuration.repositoryFullName ||
      typeof binding.root !== "string" ||
      typeof binding.origin !== "string" ||
      !Number.isSafeInteger(binding.dev) ||
      !Number.isSafeInteger(binding.ino)
    )
      fail("file client repository binding changed");
    const environment = await readBoundedJson(
      join(homedir(), ".local/share/moira-local/environment.json"),
      16384,
    );
    for (const key of [
      "HTTP_PROXY",
      "HTTPS_PROXY",
      "http_proxy",
      "https_proxy",
      "NO_PROXY",
      "no_proxy",
    ]) {
      if (typeof environment[key] !== "string" || environment[key].length > 512)
        fail("file client proxy binding changed");
      process.env[key] = environment[key];
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const rootPath = await verifyRepository(
    { repositoryFullName: configuration.repositoryFullName, cwd: "." },
    name,
    binding,
  );
  const metadata = await lstat(rootPath);
  const root = { path: rootPath, dev: metadata.dev, ino: metadata.ino };
  const path = safeRelativePath(action === "upload" ? source : destination);
  const marker = `moira-op-${createHash("sha256").update(`moira-files|${requestId}`).digest("hex").slice(0, 32)}`;
  const directory = operationDirectory(marker);
  if (await expireTransfer(directory, binding)) fail("retained transfer expired");
  let input;
  if (action === "upload") {
    const description = await withRegularFile(root, path, async (handle, size) => ({
      sha256: await hashRegular(handle, size),
    }));
    input = {
      requestId,
      direction: "guest_to_server",
      size: description.stat.size,
      sha256: description.sha256,
      fileName: path.split("/").at(-1),
      mimeType: parsed.values.mime ?? "application/octet-stream",
    };
  } else {
    if (typeof source !== "string" || source.length > 8192)
      fail("invalid transfer source reference");
    input = { requestId, direction: "server_to_guest", referenceId: source };
  }
  const minted = await fileHttpJson(
    configuration,
    configuration.bootstrapCapability,
    "POST",
    "/api/public/codespace-files/transfers",
    input,
  );
  const descriptor = transferDescriptor(minted.descriptor, configuration);
  if (descriptor.requestId !== requestId || descriptor.direction !== input.direction)
    fail("minted transfer identity changed");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const sha256 = parsed.values["replace-sha256"];
  if (sha256 !== undefined && !/^[a-f0-9]{64}$/.test(sha256))
    fail("invalid expected target digest");
  const expected = sha256 ? { exists: true, sha256 } : { exists: false };
  const receipt = await withTransferLock(descriptor, async () => {
    await transferCheckpoint(
      directory,
      descriptor,
      path,
      action === "download" ? expected : undefined,
    );
    const intent = {
      repositoryFullName: configuration.repositoryFullName,
      request: {
        action: action === "upload" ? "download" : "upload",
        path,
        transfer: descriptor,
        ...(action === "download" ? { expected } : {}),
      },
    };
    await writeDurableJson(directory, "file-intent.json", intent);
    return action === "upload"
      ? pushTransfer(root, path, configuration, descriptor, directory)
      : pullTransfer(root, path, expected, configuration, descriptor, directory, marker);
  });
  process.stdout.write(
    `${JSON.stringify({ requestId, transferId: descriptor.transferId, ...receipt })}\n`,
  );
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
    size: bytes ? bytes.length : value.size,
    sha256: value.sha256 ?? createHash("sha256").update(bytes).digest("hex"),
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
    birthtimeNs: value.birthtimeNs.toString(),
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
    (!left.birthtimeNs || left.birthtimeNs === right.birthtimeNs) &&
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
    if (options.stream) {
      const current = await withRegularFile(
        root,
        relative,
        async (handle, size) => ({ sha256: await hashRegular(handle, size) }),
        { keepOpen: options.keepOpen },
      );
      return { ...current, stat: { ...current.stat, sha256: current.sha256 } };
    }
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
  let stagingHandle;
  try {
    const parentIdentity = await directoryIdentity(location.handle);
    current = await currentFile(root, relative, { keepOpen: true });
    validateExpected(expected, current);
    temporaryName = `.moira-${marker}-${randomBytes(8).toString("hex")}.tmp`;
    stagingHandle = await open(
      descriptorPath(location.handle, temporaryName),
      constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      current?.stat.mode ? current.stat.mode & 0o777 : 0o600,
    );
    await writeAll(stagingHandle, bytes);
    await stagingHandle.sync();
    const identity = fileIdentity(await stagingHandle.stat({ bigint: true }));
    await syncDirectory(location.handle);
    return {
      ...location,
      root,
      parentIdentity,
      temporaryName,
      current,
      bytes,
      identity,
      stagingHandle,
      closed: false,
    };
  } catch (error) {
    let failure = error;
    if (temporaryName && stagingHandle) {
      try {
        const identity = fileIdentity(await stagingHandle.stat({ bigint: true }));
        await verifyEntryIdentity(location.handle, temporaryName, identity);
        await rm(descriptorPath(location.handle, temporaryName));
        await syncDirectory(location.handle);
      } catch (cleanupError) {
        if (cleanupError?.code !== "ENOENT") failure = cleanupError;
      }
    }
    if (current?.handle) await current.handle.close().catch(() => undefined);
    await stagingHandle?.close().catch(() => undefined);
    await location.handle.close().catch(() => undefined);
    throw failure;
  }
}

async function cleanupStaged(staged) {
  let cleanupError = null;
  for (const item of staged) {
    if (item.closed) continue;
    try {
      try {
        await verifyEntryIdentity(item.handle, item.temporaryName, item.identity);
        await rm(descriptorPath(item.handle, item.temporaryName));
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
      await syncDirectory(item.handle);
    } catch (error) {
      cleanupError ??= error;
    } finally {
      await item.stagingHandle?.close().catch((error) => {
        cleanupError ??= error;
      });
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
  const entries = staged.map((item) => ({
    target: item.relative,
    parentDev: item.parentIdentity.dev,
    parentIno: item.parentIdentity.ino,
    temporaryName: item.temporaryName,
    backup: item.current ? `.moira-${marker}-${randomBytes(8).toString("hex")}.bak` : null,
    hadOriginal: Boolean(item.current),
    commitAttempted: false,
    originalSha256: item.current ? version(item.current.bytes, item.current.stat).sha256 : null,
    originalIdentity: item.current?.stat.identity ?? null,
    desiredSha256: item.sha256 ?? createHash("sha256").update(item.bytes).digest("hex"),
    ...(item.identity ? { desiredIdentity: item.identity } : {}),
  }));
  await writeDurableJson(directory, "file-transaction.json", entries);
  let commitError = null;
  let cleanupError = null;
  try {
    for (let index = 0; index < staged.length; index++) {
      const item = staged[index];
      const entry = entries[index];
      await verifyParentIdentity(item.root, item.relative, item.parentIdentity);
      {
        if (
          !sameFileIdentity(
            item.identity,
            fileIdentity(await item.stagingHandle.stat({ bigint: true })),
          )
        )
          failFile("concurrent_change", "held staging inode changed before commit");
        const temporary = await open(
          descriptorPath(item.handle, item.temporaryName),
          constants.O_RDONLY | constants.O_NOFOLLOW,
        );
        try {
          const identity = fileIdentity(await temporary.stat({ bigint: true }));
          if (
            !sameFileIdentity(item.identity, identity) ||
            (await hashRegular(temporary, item.size ?? item.bytes.length)) !== entry.desiredSha256
          )
            failFile("concurrent_change", "staged transfer changed before commit");
        } finally {
          await temporary.close();
        }
      }
      const current = await currentFile(item.root, item.relative, { stream: item.stream });
      validateExpected(
        item.current
          ? {
              exists: true,
              size: item.current.stat.size,
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
      // Persist the possibility of a rename before granting that effect. A staged
      // journal alone does not authorize recovery to touch a changed target.
      entry.commitAttempted = true;
      await writeDurableJson(directory, "file-transaction.json", entries);
      if (item.current) {
        await rename(target, backup);
        await syncDirectory(item.handle);
        await verifyEntryIdentity(item.handle, entry.backup, item.current.stat.identity);
      }
      await verifyEntryIdentity(item.handle, item.temporaryName, item.identity);
      await rename(temporary, target);
      await syncDirectory(item.handle);
      await verifyEntryIdentity(item.handle, item.name, item.identity);
    }
  } catch (error) {
    commitError = error;
    await recoverFileTransaction(directory, staged[0].root);
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
    (entry.commitAttempted !== undefined && typeof entry.commitAttempted !== "boolean") ||
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

async function preserveFileTransactionConflict(directory) {
  await rename(
    join(directory, "file-transaction.json"),
    join(directory, "file-transaction.conflicted.json"),
  );
  const stateDirectory = await openDirectory(directory);
  try {
    await syncDirectory(stateDirectory);
  } finally {
    await stateDirectory.close();
  }
}

async function cleanupFileTransaction(directory, root) {
  try {
    const entries = await readBoundedJson(join(directory, "file-transaction.json"), 512 * 1024);
    if (!Array.isArray(entries)) fail("invalid file transaction journal");
    if (
      entries.some(
        (entry) => !entry.desiredIdentity || (entry.hadOriginal && !entry.originalIdentity),
      )
    ) {
      // Historical terminal receipts remain collectible; absent inode proof cannot
      // authorize disposal of their old pathname entries or manufacture new proof.
      await preserveFileTransactionConflict(directory);
      return;
    }
    for (const entry of entries) {
      validateTransactionEntry(entry, root);
      await verifyParentIdentity(root, entry.target, {
        dev: entry.parentDev,
        ino: entry.parentIno,
      });
      const location = await parentDirectory(root, entry.target);
      try {
        const temporary = await ownedTransactionEntry(
          location.handle,
          entry.temporaryName,
          entry.desiredIdentity,
          entry.desiredSha256,
        );
        let backup;
        try {
          backup = entry.backup
            ? await ownedTransactionEntry(
                location.handle,
                entry.backup,
                entry.originalIdentity,
                entry.originalSha256,
              )
            : null;
          if (temporary) {
            await verifyEntryIdentity(location.handle, entry.temporaryName, entry.desiredIdentity);
            await rm(descriptorPath(location.handle, entry.temporaryName));
          }
          if (backup) {
            await verifyEntryIdentity(location.handle, entry.backup, entry.originalIdentity);
            await rm(descriptorPath(location.handle, entry.backup));
          }
        } finally {
          await temporary?.close();
          await backup?.close();
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
    if (error?.fileReason === "concurrent_change" || ["ELOOP", "ENOTDIR"].includes(error?.code)) {
      await preserveFileTransactionConflict(directory);
      return;
    }
    if (error?.code !== "ENOENT") throw error;
  }
}

async function ownedTransactionEntry(parent, name, expected, sha256) {
  let handle;
  try {
    handle = await open(
      descriptorPath(parent, name),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const value = await handle.stat({ bigint: true });
    if (
      !value.isFile() ||
      !sameFileIdentity(expected, fileIdentity(value), { afterRename: true }) ||
      (await hashRegular(handle, Number(value.size))) !== sha256
    )
      failFile("concurrent_change", "file transaction entry ownership changed");
    return handle;
  } catch (error) {
    await handle?.close();
    if (error?.code === "ENOENT") return null;
    throw error;
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
  const prepared = [];
  try {
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
      try {
        await verifyParentIdentity(root, entry.target, {
          dev: entry.parentDev,
          ino: entry.parentIno,
        });
      } catch (error) {
        if (
          (["concurrent_change", "unsafe_access"].includes(error?.fileReason) ||
            ["ELOOP", "ENOTDIR"].includes(error?.code)) &&
          entries.every((candidate) => candidate.commitAttempted === false)
        ) {
          await preserveFileTransactionConflict(directory);
          return;
        }
        throw error;
      }
      if (!entry.desiredIdentity || (entry.hadOriginal && !entry.originalIdentity))
        failFile("concurrent_change", "file transaction has no retained inode ownership proof");
      const location = await parentDirectory(root, entry.target);
      const item = {
        entry,
        location,
        current: null,
        temporary: null,
        backup: null,
        targetWasDesired: false,
      };
      prepared.push(item);
      if (entry.commitAttempted === false) {
        item.temporary = await ownedTransactionEntry(
          location.handle,
          entry.temporaryName,
          entry.desiredIdentity,
          entry.desiredSha256,
        );
        item.backup = entry.backup
          ? await ownedTransactionEntry(
              location.handle,
              entry.backup,
              entry.originalIdentity,
              entry.originalSha256,
            )
          : null;
        if (item.backup)
          failFile("concurrent_change", "unattempted transaction has an unexpected backup");
        continue;
      }
      item.current = await currentFile(root, entry.target, { stream: true, keepOpen: true });
      if (item.current) {
        const identity = item.current.stat.identity;
        const digest = version(item.current.bytes, item.current.stat).sha256;
        item.targetWasDesired =
          sameFileIdentity(entry.desiredIdentity, identity, { afterRename: true }) &&
          digest === entry.desiredSha256;
        const original =
          entry.hadOriginal &&
          sameFileIdentity(entry.originalIdentity, identity, { afterRename: true }) &&
          digest === entry.originalSha256;
        if (!item.targetWasDesired && !original)
          failFile("concurrent_change", "codespace target ownership changed during recovery");
      }
      item.temporary = await ownedTransactionEntry(
        location.handle,
        entry.temporaryName,
        entry.desiredIdentity,
        entry.desiredSha256,
      );
      item.backup = entry.backup
        ? await ownedTransactionEntry(
            location.handle,
            entry.backup,
            entry.originalIdentity,
            entry.originalSha256,
          )
        : null;
      if (entry.hadOriginal && (!item.current || item.targetWasDesired) && !item.backup)
        fail("codespace backup is missing during recovery");
    }
    // Validate every retained inode before the first rollback effect; a later foreign
    // backup must not cause an earlier owned target to be removed.
    for (const item of prepared) {
      const { entry, location, current, targetWasDesired } = item;
      await verifyParentIdentity(root, entry.target, {
        dev: entry.parentDev,
        ino: entry.parentIno,
      });
      const target = descriptorPath(location.handle, location.name);
      if (entry.commitAttempted === false) {
        if (item.temporary) {
          await verifyEntryIdentity(location.handle, entry.temporaryName, entry.desiredIdentity);
          await rm(descriptorPath(location.handle, entry.temporaryName));
          await syncDirectory(location.handle);
        }
        continue;
      }
      if (current) {
        const expected = targetWasDesired ? entry.desiredIdentity : entry.originalIdentity;
        if (
          !sameFileIdentity(expected, fileIdentity(await current.handle.stat({ bigint: true })), {
            afterRename: true,
          })
        )
          failFile("concurrent_change", "held recovery target changed");
        await verifyEntryIdentity(location.handle, location.name, expected);
      } else if (await currentFile(root, entry.target, { stream: true })) {
        failFile("concurrent_change", "recovery target appeared");
      }
      if (item.backup)
        await verifyEntryIdentity(location.handle, entry.backup, entry.originalIdentity);
      if (item.temporary)
        await verifyEntryIdentity(location.handle, entry.temporaryName, entry.desiredIdentity);
      if (targetWasDesired) await rm(target);
      if (item.backup) {
        if (!current || targetWasDesired)
          await rename(descriptorPath(location.handle, entry.backup), target);
        else await rm(descriptorPath(location.handle, entry.backup));
      }
      if (item.temporary) await rm(descriptorPath(location.handle, entry.temporaryName));
      await syncDirectory(location.handle);
    }
    await rm(join(directory, "file-transaction.json"), { force: true });
    const stateDirectory = await openDirectory(directory);
    await syncDirectory(stateDirectory);
    await stateDirectory.close();
  } finally {
    for (const item of prepared) {
      await item.current?.handle?.close();
      await item.temporary?.close();
      await item.backup?.close();
      await item.location.handle.close();
    }
  }
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

async function executeFileRequest(root, request, marker, directory, binding) {
  if (!request || !FILE_ACTIONS.has(request.action)) fail("invalid file request");
  if (request.action === "probe") return probeFileRuntime(binding);
  if (request.transfer !== undefined) return executeTransfer(root, request, directory, marker);
  if (request.action === "describe_transfer") {
    if (!Number.isSafeInteger(request.maxBytes) || request.maxBytes < 0)
      failFile("size_limit", "invalid transfer size bound");
    const current = await withRegularFile(
      root,
      request.path,
      async (handle, size) => ({ sha256: await hashRegular(handle, size) }),
      { maximum: request.maxBytes },
    );
    return {
      action: "describe_transfer",
      path: current.path,
      size: current.stat.size,
      sha256: current.sha256,
      environmentIdentity: await environmentIdentity(),
    };
  }
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

async function fileProof(directory, request) {
  let proof;
  try {
    proof = await readBoundedJson(join(directory, "file-proof.json"), 4096);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    return null;
  }
  if (
    !/^[a-f0-9]{64}$/.test(proof.requestDigest) ||
    !/^[a-f0-9]{64}$/.test(proof.inputSha256) ||
    !Number.isSafeInteger(proof.admissionDeadlineAt) ||
    proof.admissionDeadlineAt < 1 ||
    (request.admissionDeadlineAt !== undefined &&
      request.admissionDeadlineAt !== proof.admissionDeadlineAt) ||
    (request.requestDigest !== undefined && request.requestDigest !== proof.requestDigest) ||
    (request.request !== undefined &&
      createHash("sha256")
        .update(JSON.stringify([request.repositoryFullName, request.request]))
        .digest("hex") !== proof.inputSha256)
  )
    fail("file operation immutable proof mismatch");
  return proof;
}

function fileReceipt(value, proof) {
  return proof
    ? {
        ...value,
        requestDigest: proof.requestDigest,
        ...(proof.notStarted && value.state === "failed" ? { notStarted: true } : {}),
      }
    : value;
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

async function settleTransferCommit(directory, root, intent) {
  const checkpoint = await readBoundedJson(join(directory, "transfer.json"), 65536);
  if (checkpoint.state !== "committing" || !checkpoint.identity) return null;
  const transfer = intent.request.transfer;
  const current = await currentFile(root, intent.request.path, { stream: true });
  try {
    if (
      !current ||
      !sameFileIdentity(checkpoint.identity, current.stat.identity, { afterRename: true }) ||
      version(current.bytes, current.stat).sha256 !== transfer.sha256
    )
      return null;
    const receipt = {
      path: intent.request.path,
      size: transfer.size,
      sha256: transfer.sha256,
      previous: checkpoint.previous,
      current: version(current.bytes, current.stat),
    };
    await writeDurableJson(directory, "transfer.json", {
      ...checkpoint,
      state: "committed",
      receipt,
    });
    const value = { action: "upload", transferId: transfer.transferId, ...receipt };
    await writeDurableJson(directory, "result.json", { kind: "file", state: "succeeded", value });
    await cleanupFileTransaction(directory, root);
    return { state: "succeeded", value };
  } finally {
    await current?.handle?.close();
  }
}

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
    else if (intent.request.transfer && (await settleTransferCommit(directory, root, intent))) {
      // Settlement recognizes our durable staged inode; it does not repeat the replacement.
    } else await interruptFileCommit(directory, root, intent.request.action);
    await rm(join(directory, "file-intent.json"), { force: true });
  }
}

async function launchTransferRunner(request, binding, directory, proof) {
  const path = join(homedir(), ".local/share/moira-files/client.mjs");
  if ((await installedAssetHash(path)) === null) fail("fixed transfer client is unavailable");
  const child = spawn(process.execPath, [path, "operation", request.remoteMarker], {
    detached: true,
    stdio: ["pipe", "ignore", "ignore"],
    env: process.env,
  });
  await new Promise((done, reject) => {
    child.once("spawn", done);
    child.once("error", reject);
  });
  const startTime = process.platform === "linux" ? await linuxStartTime(child.pid) : null;
  if (process.platform === "linux" && startTime === null)
    fail("transfer runner identity is unavailable");
  await writeDurableJson(directory, "file-runner-pid", { pid: child.pid, startTime });
  child.stdin.on("error", () => undefined);
  child.stdin.end(JSON.stringify({ request, binding }));
  child.unref();
  return fileReceipt({ state: "running" }, proof);
}

async function fileExecute(request, binding, { worker = false } = {}) {
  const directory = validateBase(request);
  if (
    request.requestDigest !== undefined &&
    (!/^[a-f0-9]{64}$/.test(request.requestDigest) ||
      !Number.isSafeInteger(request.admissionDeadlineAt) ||
      request.admissionDeadlineAt < 1)
  )
    fail("invalid file admission proof");
  for (;;) {
    const proof = await fileProof(directory, request);
    const existing = await readFileOperationResult(directory);
    if (existing) {
      const savedIntent = await readFileIntent(directory);
      if (savedIntent) {
        await cleanupFileTransaction(directory, await repositoryRootForFile(savedIntent, binding));
      }
      await rm(join(directory, "file-intent.json"), { force: true });
      return fileReceipt(existing, proof);
    }
    await mkdir(dirname(directory), { recursive: true, mode: 0o700 });
    await mkdir(directory, { mode: 0o700 }).catch((error) => {
      if (error?.code !== "EEXIST") throw error;
    });
    if (worker) {
      const owner = await readOptionalProcessIdentity(directory, "file-runner-pid");
      const startTime = process.platform === "linux" ? await linuxStartTime(process.pid) : null;
      if (!owner || owner.pid !== process.pid || owner.startTime !== startTime)
        fail("transfer runner ownership changed");
      break;
    }
    const ownership = await claimFileRunner(directory);
    if (ownership === "busy") return fileReceipt({ state: "running" }, proof);
    if (ownership === "retry") continue;
    break;
  }
  let proof = await fileProof(directory, request);
  if (!proof && request.requestDigest !== undefined) {
    proof = {
      requestDigest: request.requestDigest,
      admissionDeadlineAt: request.admissionDeadlineAt,
      action: request.request?.action,
      inputSha256: createHash("sha256")
        .update(JSON.stringify([request.repositoryFullName, request.request]))
        .digest("hex"),
    };
    await writeDurableJson(directory, "file-proof.json", proof);
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
  const notStarted = async () => {
    proof = { ...proof, launchAttempted: false, notStarted: true };
    await writeDurableJson(directory, "file-proof.json", proof);
    const negative = {
      kind: "file",
      state: "failed",
      value: { action: intent.request.action, state: "failed", code: "CODESPACE_FILE_REJECTED" },
    };
    await writeDurableJson(directory, "result.json", negative);
    return fileReceipt({ state: negative.state, value: negative.value }, proof);
  };
  const perform = async () => {
    if (proof && !proof.launchAttempted && Date.now() >= proof.admissionDeadlineAt)
      return notStarted();
    if (FILE_MUTATIONS.has(intent.request.action) && !intent.request.transfer)
      await recoverAbandonedFileCommits(root, intent.repositoryFullName, directory);
    if (resumed && FILE_MUTATIONS.has(intent.request.action) && !intent.request.transfer)
      return fileReceipt(await interruptFileCommit(directory, root, intent.request.action), proof);
    if (!intent.request.transfer) await recoverFileTransaction(directory, root);
    if (proof && !proof.launchAttempted) {
      proof = { ...proof, launchAttempted: true };
      await writeDurableJson(directory, "file-proof.json", proof);
      if (Date.now() >= proof.admissionDeadlineAt) return notStarted();
    }
    if (intent.request.transfer && !worker)
      return launchTransferRunner(
        { ...request, request: intent.request },
        binding,
        directory,
        proof,
      );
    if (intent.request.transfer && worker && proof && !proof.transferStarted) {
      if (Date.now() >= proof.admissionDeadlineAt) return notStarted();
      proof = { ...proof, transferStarted: true };
      await writeDurableJson(directory, "file-proof.json", proof);
    }
    let state = "succeeded";
    let value;
    try {
      value = await executeFileRequest(
        root,
        intent.request,
        request.remoteMarker,
        directory,
        binding,
      );
    } catch (error) {
      if (intent.request.transfer && error?.code === "TRANSFER_OUTCOME_UNKNOWN")
        return fileReceipt({ state: "running" }, proof);
      await recoverFileTransaction(directory, root);
      if (intent.request.transfer) {
        try {
          const checkpoint = await readBoundedJson(join(directory, "transfer.json"), 65536);
          await discardTransferPartial(root, intent, checkpoint);
        } catch (cleanupError) {
          if (cleanupError?.code !== "ENOENT") throw cleanupError;
        }
      }
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
    return fileReceipt({ state, value }, proof);
  };
  return FILE_MUTATIONS.has(intent.request.action) && !intent.request.transfer
    ? withFileCommitLock(perform)
    : perform();
}

async function fileInspect(request, binding) {
  const directory = validateBase(request);
  if (["probe", "describe_transfer"].includes(request.request?.action)) {
    const root = await repositoryRootForFile(request, binding);
    return {
      state: "succeeded",
      value: await executeFileRequest(
        root,
        request.request,
        request.remoteMarker,
        directory,
        binding,
      ),
    };
  }
  try {
    const proof = await fileProof(directory, request);
    await access(directory, constants.R_OK);
    const result = await readFileOperationResult(directory);
    if (result) {
      const intent = await readFileIntent(directory);
      if (intent)
        await cleanupFileTransaction(directory, await repositoryRootForFile(intent, binding));
      await rm(join(directory, "file-intent.json"), { force: true });
      return fileReceipt(result, proof);
    }
    if (proof?.notStarted) {
      return fileReceipt(
        {
          state: "failed",
          value: { action: proof.action, state: "failed", code: "CODESPACE_FILE_REJECTED" },
        },
        proof,
      );
    }
    const runner = await readOptionalProcessIdentity(directory, "file-runner-pid");
    if (runner && (await processExists(runner))) return fileReceipt({ state: "running" }, proof);
    const expired = await expireTransfer(directory, binding);
    if (expired) return fileReceipt(expired, proof);
    try {
      const intent = await readFileIntent(directory);
      if (!intent) return fileReceipt({ state: "absent" }, proof);
      if (intent.request?.transfer) {
        if (request.request?.transfer)
          return fileExecute(
            { ...request, action: "file-execute", repositoryFullName: intent.repositoryFullName },
            binding,
          );
        const checkpoint = await readBoundedJson(join(directory, "transfer.json"), 65536);
        if (!checkpoint.receipt && intent.request.transfer.direction === "guest_to_server") {
          const configuration = await fileClientConfiguration();
          const descriptor = transferDescriptor(intent.request.transfer, configuration);
          const status = await transferStatus(configuration, descriptor);
          if (status.state === "ready" && status.receipt) {
            checkpoint.state = "committed";
            checkpoint.receipt = publicationReceipt(status.receipt, descriptor);
            await writeDurableJson(directory, "transfer.json", checkpoint);
          }
        }
        if (checkpoint.state === "committing") {
          const settled = await withFileCommitLock(async () =>
            settleTransferCommit(directory, await repositoryRootForFile(intent, binding), intent),
          );
          if (settled) return fileReceipt(settled, proof);
        }
        if (checkpoint.receipt) {
          const transfer = intent.request.transfer;
          const value =
            intent.request.action === "upload"
              ? { action: "upload", transferId: transfer.transferId, ...checkpoint.receipt }
              : {
                  action: "download",
                  transferId: transfer.transferId,
                  path: intent.request.path,
                  size: transfer.size,
                  sha256: transfer.sha256,
                  referenceId: checkpoint.receipt.referenceId,
                };
          await writeDurableJson(directory, "result.json", {
            kind: "file",
            state: "succeeded",
            value,
          });
          return fileReceipt({ state: "succeeded", value }, proof);
        }
        return fileReceipt({ state: "running" }, proof);
      }
      if (FILE_MUTATIONS.has(intent.request?.action)) {
        return withFileCommitLock(async () => {
          const completed = await readFileOperationResult(directory);
          if (completed) return fileReceipt(completed, proof);
          return fileReceipt(
            await interruptFileCommit(
              directory,
              await repositoryRootForFile(intent, binding),
              intent.request.action,
            ),
            proof,
          );
        });
      }
      return fileReceipt({ state: "absent" }, proof);
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
    // A marker can be visible before its accepted runner publishes proof or PID.
    // Missing publication also cannot determine a historical command's outcome.
    return { state: "outcome_unknown", ...receiptMetadata(proof ?? cancellation) };
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

async function finalize(request, binding) {
  const directory = validateBase(request);
  const file = await fileProof(directory, request);
  const intent = await readFileIntent(directory);
  if (intent?.request?.transfer) {
    const owner = await readOptionalProcessIdentity(directory, "file-runner-pid");
    if (owner && (await processExists(owner))) fail("operation is still running");
    if (Date.now() < intent.request.transfer.expiresAt)
      return fileReceipt({ state: "outcome_unknown" }, file);
    await expireTransfer(directory, binding);
  }
  if (file && file.admissionDeadlineAt > Date.now()) {
    return { state: "outcome_unknown", requestDigest: file.requestDigest };
  }
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
  if (request.action === "finalize") return finalize(request, binding);
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
