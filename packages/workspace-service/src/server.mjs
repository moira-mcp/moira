import { createServer } from "node:http";
import { constants, watch } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, rename, rm } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { Buffer } from "node:buffer";
import process from "node:process";
import { URL } from "node:url";
import { clearTimeout, setTimeout } from "node:timers";
import { once } from "node:events";
import { connect } from "node:net";
import { createWorkspaceEngine } from "./engine.mjs";
import { canonicalJson } from "../../shared/src/utils/canonical-json.ts";
import {
  WORKSPACE_REQUEST_ID_PATTERN,
  createWorkspaceRequestId,
  workspaceRequestUuid,
} from "../../shared/src/codespaces/workspace-request-id.ts";
import parser from "stream-json";
import Assembler from "stream-json/assembler.js";

const DEFAULT_SEARCH_RESPONSE_BYTES = 1024 * 1024;

function refuse(code, status = 400) {
  const error = new Error(code);
  error.publicCode = code;
  error.status = status;
  throw error;
}

async function jsonBody(request) {
  const tokens = parser({ streamValues: false });
  const assembler = new Assembler();
  const failed = (error) => tokens.destroy(error);
  request.once("error", failed);
  request.pipe(tokens);
  try {
    for await (const token of tokens) assembler.consume(token);
    if (
      !assembler.done ||
      !assembler.current ||
      typeof assembler.current !== "object" ||
      Array.isArray(assembler.current)
    )
      refuse("INVALID_JSON");
    return assembler.current;
  } catch {
    refuse("INVALID_JSON");
  } finally {
    request.off("error", failed);
    request.unpipe(tokens);
    tokens.destroy();
  }
}

function json(response, value, status = 200) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

async function optionalJson(path) {
  try {
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await handle.stat();
      if (
        !info.isFile() ||
        info.nlink !== 1 ||
        (info.mode & 0o077) !== 0 ||
        info.uid !== process.getuid?.()
      )
        refuse("UNSAFE_STATE", 409);
      return JSON.parse(await handle.readFile("utf8"));
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function id(value) {
  if (typeof value !== "string" || !WORKSPACE_REQUEST_ID_PATTERN.test(value))
    refuse("INVALID_REQUEST_ID");
  return value;
}

function marker(requestId) {
  return `moira-op-${workspaceRequestUuid(requestId).replaceAll("-", "")}`;
}
function digest(value) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}
function expectedContentSize(request) {
  const value = request.headers["x-moira-content-size"];
  if (value === undefined) return null;
  if (
    typeof value !== "string" ||
    !/^(0|[1-9][0-9]*)$/.test(value) ||
    !Number.isSafeInteger(Number(value))
  )
    refuse("INVALID_CONTENT_SIZE");
  return Number(value);
}

async function streamRange(handle, response, offset, end, buffer = Buffer.alloc(64 * 1024)) {
  let position = offset;
  while (position < end && !response.destroyed) {
    const { bytesRead } = await handle.read(
      buffer,
      0,
      Math.min(buffer.length, end - position),
      position,
    );
    if (!bytesRead) refuse("FILE_CHANGED", 409);
    position += bytesRead;
    await new Promise((resolve, reject) => {
      const closed = () => resolve();
      response.once("close", closed);
      response.write(buffer.subarray(0, bytesRead), (error) => {
        response.off("close", closed);
        if (error && !response.destroyed) reject(error);
        else resolve();
      });
    });
  }
}

export async function startWorkspaceService({
  socketPath,
  stateRoot,
  binding,
  releaseIdentity,
  searchExecutable,
}) {
  const engine = createWorkspaceEngine({
    stateRoot: join(stateRoot, "engine"),
    binding,
    searchExecutable,
  });
  await engine.verifyBinding();
  const life = await engine.environmentIdentity();
  const requestsRoot = join(stateRoot, "requests");
  const engineRoot = join(stateRoot, "engine");
  await mkdir(stateRoot, { recursive: true, mode: 0o700 });
  await mkdir(dirname(socketPath), { recursive: true, mode: 0o700 });
  const directoryInfo = await lstat(stateRoot);
  if (
    !directoryInfo.isDirectory() ||
    directoryInfo.isSymbolicLink() ||
    (directoryInfo.mode & 0o077) !== 0 ||
    directoryInfo.uid !== process.getuid?.()
  )
    refuse("UNSAFE_STATE", 409);
  await mkdir(engineRoot, { mode: 0o700 }).catch((error) => {
    if (error.code !== "EEXIST") throw error;
  });
  const engineInfo = await lstat(engineRoot);
  if (
    !engineInfo.isDirectory() ||
    engineInfo.isSymbolicLink() ||
    engineInfo.uid !== process.getuid?.() ||
    (engineInfo.mode & 0o077) !== 0
  )
    refuse("UNSAFE_STATE", 409);
  await mkdir(requestsRoot, { mode: 0o700 }).catch((error) => {
    if (error.code !== "EEXIST") throw error;
  });
  const requestsInfo = await lstat(requestsRoot);
  if (
    !requestsInfo.isDirectory() ||
    requestsInfo.isSymbolicLink() ||
    requestsInfo.uid !== process.getuid?.() ||
    (requestsInfo.mode & 0o077) !== 0
  )
    refuse("UNSAFE_STATE", 409);
  await engine.persistDirectory(engineRoot);
  await engine.persistDirectory(requestsRoot);
  await engine.persistDirectory(dirname(socketPath));
  const lanes = new Map();
  const launches = new Map();
  const inLane = async (requestId, work) => {
    const predecessor = lanes.get(requestId) ?? Promise.resolve();
    const action = predecessor.catch(() => undefined).then(work);
    const tail = action.catch(() => undefined);
    lanes.set(requestId, tail);
    try {
      return await action;
    } finally {
      if (lanes.get(requestId) === tail) lanes.delete(requestId);
    }
  };
  const requestDirectory = async (requestId) => {
    const directory = join(requestsRoot, requestId);
    await mkdir(directory, { mode: 0o700 }).catch((error) => {
      if (error.code !== "EEXIST") throw error;
    });
    const info = await lstat(directory);
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      info.uid !== process.getuid?.() ||
      (info.mode & 0o077) !== 0
    )
      refuse("UNSAFE_STATE", 409);
    await engine.persistDirectory(directory);
    return directory;
  };
  const assertLife = async () => {
    if (life !== (await engine.environmentIdentity())) refuse("WORKSPACE_REPLACED", 409);
    await engine.verifyBinding();
  };
  const spool = async (request, directory) => {
    if (await optionalJson(join(directory, "accepted.json"))) refuse("INPUT_ALREADY_ACCEPTED", 409);
    const expectedSize = expectedContentSize(request);
    const previous = await optionalJson(join(directory, "input.json"));
    const temporary = join(directory, `input-${randomUUID()}.tmp`);
    const target = join(directory, "input");
    const handle = await open(temporary, "wx", 0o600);
    let size = 0;
    const hash = createHash("sha256");
    try {
      for await (const chunk of request) {
        await engine.writeAll(handle, chunk, size);
        hash.update(chunk);
        size += chunk.length;
        if (expectedSize !== null && size > expectedSize) refuse("CONTENT_SIZE_MISMATCH", 409);
      }
      if (expectedSize !== null && size !== expectedSize) refuse("CONTENT_SIZE_MISMATCH", 409);
      await handle.sync();
      const identity = await handle.stat();
      await handle.close();
      const receipt = { size, sha256: hash.digest("hex") };
      if (previous) {
        if (previous.size !== receipt.size || previous.sha256 !== receipt.sha256)
          refuse("REQUEST_ID_CONFLICT", 409);
        return previous;
      }
      await rename(temporary, target);
      await engine.writeDurableJson(directory, "input.json", receipt);
      await engine.writeDurableJson(directory, "input-identity.json", {
        dev: identity.dev,
        ino: identity.ino,
      });
      return receipt;
    } finally {
      await handle.close().catch(() => undefined);
      await rm(temporary, { force: true });
    }
  };
  const operation = async (requestId) => {
    const directory = await requestDirectory(requestId);
    const accepted = await optionalJson(join(directory, "accepted.json"));
    if (!accepted) return { requestId, state: "absent" };
    const recorded = await optionalJson(join(directory, "result.json"));
    if (recorded && !(accepted.kind === "exec" && recorded.state === "unknown")) {
      if (accepted.kind !== "exec" && recorded.state === "succeeded")
        await engine.withFileCommitLock(() => engine.cleanupFileTransaction(directory));
      return { requestId, ...recorded };
    }
    const result =
      accepted.kind === "exec"
        ? await engine.inspect({ version: 1, remoteMarker: marker(requestId) })
        : ((await optionalJson(join(directory, "result.json"))) ?? { state: "outcome_unknown" });
    const status = result;
    return {
      requestId,
      ...status,
      state:
        launches.has(requestId) && ["absent", "outcome_unknown"].includes(status.state)
          ? "starting"
          : status.state === "outcome_unknown" || status.state === "absent"
            ? "unknown"
            : status.state,
    };
  };
  const observeOperation = async (requestId, waitMs, response) => {
    if (!Number.isSafeInteger(waitMs) || waitMs < 0) refuse("INVALID_WAIT_WINDOW");
    let status = await operation(requestId);
    if (!waitMs || !["starting", "running", "unknown"].includes(status.state)) return status;
    const path = engine.operationDirectory(marker(requestId));
    await new Promise((resolve, reject) => {
      let watcher;
      let timer;
      let checking = false;
      let dirty = false;
      let watchingParent = false;
      const settle = (error) => {
        clearTimeout(timer);
        watcher?.close();
        response.off("close", closed);
        if (error) reject(error);
        else resolve();
      };
      const closed = () => settle();
      const changed = async () => {
        if (checking) {
          dirty = true;
          return;
        }
        checking = true;
        try {
          do {
            dirty = false;
            status = await operation(requestId);
            if (watchingParent) {
              try {
                const child = watch(path, changed);
                watcher.close();
                watcher = child;
                watchingParent = false;
              } catch (error) {
                if (error.code !== "ENOENT") throw error;
              }
            }
          } while (dirty);
          if (!["starting", "running", "unknown"].includes(status.state)) settle();
        } catch (error) {
          settle(error);
        } finally {
          checking = false;
        }
      };
      try {
        watcher = watch(path, changed);
      } catch (error) {
        if (error.code !== "ENOENT") return settle(error);
        watchingParent = true;
        watcher = watch(engineRoot, changed);
      }
      response.once("close", closed);
      timer = setTimeout(() => settle(), Math.min(waitMs, 2147483647));
      void changed();
    });
    return status;
  };
  const sendFile = async (response, path, offset, length) => {
    const buffer = Buffer.alloc(64 * 1024);
    const current = await engine.withRegularFile(path, async (handle, size) => {
      if (offset > size) refuse("INVALID_RANGE", 416);
      const end = length === null ? size : Math.min(size, offset + length);
      response.writeHead(200, {
        "content-type": "application/octet-stream",
        "content-length": end - offset,
        "x-moira-range-size": end - offset,
        "x-moira-total-size": size,
      });
      const finalStart = Math.max(offset, end - buffer.length);
      await streamRange(handle, response, offset, finalStart, buffer);
      let finalLength = 0;
      while (finalStart + finalLength < end) {
        const read = await handle.read(
          buffer,
          finalLength,
          end - finalStart - finalLength,
          finalStart + finalLength,
        );
        if (!read.bytesRead) refuse("FILE_CHANGED", 409);
        finalLength += read.bytesRead;
      }
      return { finalLength };
    });
    response.end(buffer.subarray(0, current.finalLength));
  };
  const server = createServer(async (request, response) => {
    try {
      await assertLife();
      const url = new URL(request.url, "http://workspace");
      const parts = url.pathname.split("/").filter(Boolean);
      if (request.method === "GET" && url.pathname === "/v1/health")
        return json(response, {
          version: 1,
          releaseIdentity,
          processId: process.pid,
          repositoryFullName: binding.repositoryFullName,
          environmentIdentity: life,
        });
      if (request.method === "POST" && url.pathname === "/v1/exec") {
        const body = await jsonBody(request);
        const requestId = id(body.requestId);
        const result = await inLane(requestId, async () => {
          const directory = await requestDirectory(requestId);
          if (body.stdinText !== undefined && typeof body.stdinText !== "string")
            refuse("INVALID_STDIN");
          if (body.inputReady !== undefined && typeof body.inputReady !== "boolean")
            refuse("INVALID_INPUT_READY");
          if (body.inputReady && body.stdinText !== undefined) refuse("AMBIGUOUS_STDIN");
          const input = body.inputReady ? await optionalJson(join(directory, "input.json")) : null;
          if (body.inputReady && !input) refuse("INPUT_NOT_READY", 409);
          const canonical = { ...body, requestId, input };
          const existing = await optionalJson(join(directory, "accepted.json"));
          if (existing && (existing.kind !== "exec" || existing.digest !== digest(canonical)))
            refuse("REQUEST_ID_CONFLICT", 409);
          const execution = {
            version: 1,
            action: "execute",
            repositoryFullName: binding.repositoryFullName,
            remoteMarker: marker(requestId),
            requestDigest: digest(canonical),
            argv: body.argv,
            script: body.script,
            cwd: body.cwd,
            env: body.env,
            session: body.session,
            sessionStart: body.sessionStart,
            sessionEnd: body.sessionEnd,
            stdin: Buffer.from(body.stdinText ?? "").toString("base64"),
            inputReady: Boolean(input),
            timeoutMs: body.timeoutMs ?? null,
          };
          let refusalReason = "COMMAND_REJECTED";
          let inputHandle;
          try {
            engine.validateCommand(execution);
            await engine.verifyCommand(execution);
            if (input) {
              refusalReason = "INPUT_CHANGED";
              const expectedIdentity = await optionalJson(join(directory, "input-identity.json"));
              inputHandle = await open(
                join(directory, "input"),
                constants.O_RDONLY | constants.O_NOFOLLOW,
              );
              const info = await inputHandle.stat();
              if (
                !info.isFile() ||
                info.nlink !== 1 ||
                info.uid !== process.getuid?.() ||
                (info.mode & 0o077) !== 0 ||
                info.size !== input.size ||
                info.dev !== expectedIdentity?.dev ||
                info.ino !== expectedIdentity?.ino ||
                (await engine.hashRegular(inputHandle, info.size)) !== input.sha256
              )
                refuse("INPUT_CHANGED", 409);
            }
          } catch {
            await inputHandle?.close();
            if (!existing) {
              await engine.writeDurableJson(directory, "accepted.json", {
                kind: "exec",
                digest: digest(canonical),
                environmentIdentity: life,
              });
              await engine.writeDurableJson(directory, "result.json", {
                state: "not_started",
                reason: refusalReason,
                exitCode: null,
              });
            }
            return operation(requestId);
          }
          try {
            if (!existing)
              await engine.writeDurableJson(directory, "accepted.json", {
                kind: "exec",
                digest: digest(canonical),
                environmentIdentity: life,
              });
            if (await optionalJson(join(directory, "result.json"))) return operation(requestId);
            if (existing) return operation(requestId);
            const retainedInput = inputHandle;
            inputHandle = undefined;
            const launch = engine
              .execute(execution, retainedInput?.fd)
              .catch(async () => {
                const settled = await engine
                  .inspect({ version: 1, remoteMarker: marker(requestId) })
                  .catch(() => null);
                if (
                  settled &&
                  ["succeeded", "failed", "cancelled", "timed_out", "not_started"].includes(
                    settled.state,
                  )
                )
                  return;
                const proof = await optionalJson(
                  join(engine.operationDirectory(marker(requestId)), "execution.json"),
                );
                // Only a retained negative launch proof may settle a refusal. An attempted
                // launch remains unknown even when the observer failed to collect its result.
                await engine.writeDurableJson(
                  directory,
                  "result.json",
                  proof?.launchAttempted === false
                    ? { state: "not_started", reason: "COMMAND_START_REJECTED", exitCode: null }
                    : { state: "unknown", reason: "COMMAND_OUTCOME_UNKNOWN" },
                );
              })
              .finally(async () => {
                try {
                  await retainedInput?.close();
                } finally {
                  if (launches.get(requestId) === launch) launches.delete(requestId);
                }
              });
            launches.set(requestId, launch);
            void launch.catch(() => undefined);
            return operation(requestId);
          } finally {
            await inputHandle?.close();
          }
        });
        return json(response, result);
      }
      if (parts[0] === "v1" && parts[1] === "operations") {
        const requestId = id(parts[2]);
        const directory = await requestDirectory(requestId);
        if (request.method === "PUT" && parts[3] === "input")
          return json(response, await inLane(requestId, () => spool(request, directory)));
        if (request.method === "POST" && parts[3] === "cancel") {
          await inLane(requestId, async () => {
            const accepted = await optionalJson(join(directory, "accepted.json"));
            if (!accepted || accepted.kind !== "exec") refuse("OPERATION_NOT_FOUND", 404);
            await engine.cancel({
              version: 1,
              remoteMarker: marker(requestId),
              requestDigest: accepted.digest,
            });
          });
          return json(response, await operation(requestId));
        }
        if (request.method === "GET" && parts[3] === "output") {
          const name = url.searchParams.get("stream") ?? "stdout";
          if (!["stdout", "stderr"].includes(name)) refuse("INVALID_STREAM");
          const offset = Number(url.searchParams.get("offset") ?? 0);
          const length = url.searchParams.has("length")
            ? Number(url.searchParams.get("length"))
            : null;
          if (
            !Number.isSafeInteger(offset) ||
            offset < 0 ||
            (length !== null && (!Number.isSafeInteger(length) || length < 0))
          )
            refuse("INVALID_RANGE");
          const handle = await open(
            join(engine.operationDirectory(marker(requestId)), `${name}.log`),
            constants.O_RDONLY | constants.O_NOFOLLOW,
          );
          try {
            const info = await handle.stat();
            if (!info.isFile() || info.nlink !== 1) refuse("UNSAFE_OUTPUT", 409);
            const end = length === null ? info.size : Math.min(info.size, offset + length);
            if (offset > info.size) refuse("INVALID_RANGE", 416);
            response.writeHead(200, {
              "content-type": "application/octet-stream",
              "content-length": end - offset,
              "x-moira-total-size": info.size,
            });
            await streamRange(handle, response, offset, end);
            response.end();
          } finally {
            await handle.close();
          }
          return;
        }
        if (request.method === "GET" && parts.length === 3)
          return json(
            response,
            await observeOperation(
              requestId,
              Number(url.searchParams.get("waitMs") ?? 0),
              response,
            ),
          );
      }
      if (parts[0] === "v1" && parts[1] === "files") {
        if (request.method === "GET" && ["read", "download"].includes(parts[2])) {
          const offset = Number(url.searchParams.get("offset") ?? 0);
          const length = url.searchParams.has("length")
            ? Number(url.searchParams.get("length"))
            : null;
          if (
            !Number.isSafeInteger(offset) ||
            offset < 0 ||
            (length !== null && (!Number.isSafeInteger(length) || length < 0))
          )
            refuse("INVALID_RANGE");
          await sendFile(response, url.searchParams.get("path"), offset, length);
          return;
        }
        if (request.method === "PUT" && ["write", "upload"].includes(parts[2])) {
          const requestId = id(url.searchParams.get("requestId"));
          const expectedSize = expectedContentSize(request);
          let expected;
          try {
            expected = JSON.parse(request.headers["x-moira-expected"] ?? "");
          } catch {
            refuse("INVALID_PRECONDITION");
          }
          const result = await inLane(requestId, async () => {
            const directory = await requestDirectory(requestId);
            const path = url.searchParams.get("path");
            const existing = await optionalJson(join(directory, "accepted.json"));
            if (existing) {
              if (
                existing.kind !== "write" ||
                existing.path !== path ||
                digest(existing.expected) !== digest(expected)
              )
                refuse("REQUEST_ID_CONFLICT", 409);
              const hash = createHash("sha256");
              let size = 0;
              for await (const chunk of request) {
                hash.update(chunk);
                size += chunk.length;
              }
              if (expectedSize !== null && size !== expectedSize)
                refuse("CONTENT_SIZE_MISMATCH", 409);
              if (hash.digest("hex") !== existing.sha256 || size !== existing.size)
                refuse("REQUEST_ID_CONFLICT", 409);
              return operation(requestId);
            }
            const staged = await engine.stageStream(path, request, expected, marker(requestId));
            try {
              if (expectedSize !== null && staged.size !== expectedSize)
                refuse("CONTENT_SIZE_MISMATCH", 409);
              await engine.writeDurableJson(directory, "accepted.json", {
                kind: "write",
                path,
                expected,
                size: staged.size,
                sha256: staged.sha256,
                environmentIdentity: life,
              });
              await engine.withFileCommitLock(() =>
                engine.commitStaged([staged], marker(requestId), directory),
              );
              const current = await engine.currentFile(path, { stream: true });
              if (
                !current ||
                current.stat.size !== staged.size ||
                current.stat.sha256 !== staged.sha256
              )
                refuse("FILE_CHANGED", 409);
              const result = {
                state: "succeeded",
                path,
                current: engine.version(current.bytes, current.stat),
              };
              await engine.writeDurableJson(directory, "result.json", result);
              await engine.withFileCommitLock(() => engine.cleanupFileTransaction(directory));
              return { requestId, ...result };
            } finally {
              await engine.cleanupStaged([staged]);
            }
          });
          return json(response, result);
        }
        if (request.method === "POST" && ["stat", "search", "patch"].includes(parts[2])) {
          const body = await jsonBody(request);
          if (parts[2] !== "patch") {
            const controller = new globalThis.AbortController();
            const closed = () => controller.abort();
            response.once("close", closed);
            try {
              return json(
                response,
                await engine.fileRequest(
                  {
                    ...body,
                    action: parts[2],
                    signal: controller.signal,
                    maxMatches: body.maxMatches ?? 1000,
                    maxBytes: body.maxBytes ?? DEFAULT_SEARCH_RESPONSE_BYTES,
                  },
                  marker(createWorkspaceRequestId()),
                  stateRoot,
                ),
              );
            } finally {
              response.off("close", closed);
            }
          }
          const requestId = id(body.requestId);
          return json(
            response,
            await inLane(requestId, async () => {
              const directory = await requestDirectory(requestId);
              const existing = await optionalJson(join(directory, "accepted.json"));
              if (existing) {
                if (existing.digest !== digest(body)) refuse("REQUEST_ID_CONFLICT", 409);
                return operation(requestId);
              }
              await engine.writeDurableJson(directory, "accepted.json", {
                kind: "patch",
                digest: digest(body),
                environmentIdentity: life,
              });
              let result;
              try {
                const files = body.files?.map((file) => ({
                  ...file,
                  edits: file.edits?.map((edit) => ({
                    start: edit.start,
                    end: edit.end,
                    bytesBase64: Buffer.from(edit.text, "utf8").toString("base64"),
                  })),
                }));
                const value = await engine.withFileCommitLock(() =>
                  engine.fileRequest(
                    { action: "apply_patch", files },
                    marker(requestId),
                    directory,
                  ),
                );
                result = { state: "succeeded", ...value };
              } catch (error) {
                if (
                  error.fileCommitAttempted ||
                  (await optionalJson(join(directory, "file-transaction.json")))
                )
                  throw error;
                result = { state: "not_started", reason: error.fileReason ?? "INVALID_PATCH" };
              }
              await engine.writeDurableJson(directory, "result.json", result);
              if (result.state === "succeeded")
                await engine.withFileCommitLock(() => engine.cleanupFileTransaction(directory));
              return { requestId, ...result };
            }),
          );
        }
      }
      refuse("NOT_FOUND", 404);
    } catch (error) {
      if (response.headersSent) {
        response.destroy();
        return;
      }
      json(
        response,
        {
          error: {
            code:
              error.publicCode ??
              (error.code === "ENOENT"
                ? "NOT_FOUND"
                : error.fileReason
                  ? "FILE_REJECTED"
                  : "WORKSPACE_OPERATION_ERROR"),
            ...(error.fileReason ? { reason: error.fileReason } : {}),
          },
        },
        error.status ?? (error.code === "ENOENT" ? 404 : 409),
      );
    }
  });
  server.requestTimeout = 0;
  server.timeout = 0;
  const stale = await lstat(socketPath).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (stale) {
    if (!stale.isSocket() || stale.uid !== process.getuid?.()) refuse("UNSAFE_SOCKET", 409);
    await new Promise((resolve, reject) => {
      const probe = connect(socketPath);
      probe.once("connect", () => {
        probe.destroy();
        reject(new Error("WORKSPACE_SERVICE_ALREADY_RUNNING"));
      });
      probe.once("error", (error) =>
        ["ECONNREFUSED", "ENOENT"].includes(error.code) ? resolve() : reject(error),
      );
    });
    const current = await lstat(socketPath).catch(() => null);
    if (current && (current.dev !== stale.dev || current.ino !== stale.ino))
      refuse("SOCKET_OWNER_CHANGED", 409);
    if (current) await rm(socketPath);
  }
  // Only the new service's private namespace owns these transactions. An interrupted
  // commit is rolled back from retained inode proof; it is never replayed as a request.
  for (const entry of await readdir(requestsRoot)) {
    if (!WORKSPACE_REQUEST_ID_PATTERN.test(entry)) refuse("UNSAFE_STATE", 409);
    const directory = await requestDirectory(entry);
    const accepted = await optionalJson(join(directory, "accepted.json"));
    if (!accepted || accepted.kind === "exec") continue;
    const recorded = await optionalJson(join(directory, "result.json"));
    if (recorded) {
      if (recorded.state === "succeeded")
        await engine.withFileCommitLock(() => engine.cleanupFileTransaction(directory));
    } else {
      try {
        await engine.withFileCommitLock(() => engine.recoverFileTransaction(directory));
        await engine.writeDurableJson(directory, "result.json", {
          state: "interrupted",
          reason: "FILE_TRANSACTION_INTERRUPTED",
        });
      } catch (error) {
        if (error.fileReason !== "concurrent_change") throw error;
        await engine.writeDurableJson(directory, "result.json", {
          state: "unknown",
          reason: "FILE_TRANSACTION_CONFLICT",
        });
      }
    }
  }
  server.listen(socketPath);
  await once(server, "listening");
  await chmod(socketPath, 0o600);
  const socketIdentity = await lstat(socketPath);
  return {
    server,
    socketPath,
    close: async () => {
      server.closeAllConnections();
      await new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      const current = await lstat(socketPath).catch(() => null);
      if (current?.dev === socketIdentity.dev && current?.ino === socketIdentity.ino)
        await rm(socketPath);
    },
  };
}
