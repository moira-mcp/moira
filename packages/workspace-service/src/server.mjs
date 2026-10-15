import { createServer } from "node:http";
import { constants, watch } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, rename, rm } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { Buffer } from "node:buffer";
import process from "node:process";
import { URL, fileURLToPath, pathToFileURL } from "node:url";
import { clearTimeout, setTimeout } from "node:timers";
import { once } from "node:events";
import { connect } from "node:net";
import { createWorkspaceEngine } from "./engine.mjs";
import { openNativeFile } from "./native-source.mjs";
import { executeOwnerTool } from "./presentation.mjs";
import { createOwnerPublications } from "./publications.mjs";
import { createOwnerCommunication } from "./owner-communication.mjs";
import { readOwnerFrame, settleOwnerFrame, OWNER_STREAM_CONTENT_TYPE } from "./stream-frame.mjs";
import { deliverOwnerExtension as deliverExtension } from "./extension-owner.mjs";
import { canonicalJson } from "../../shared/src/utils/canonical-json.ts";
import { scopedCredentialFailureOutcome } from "../../shared/src/codespaces/scoped-credential-types.ts";
import {
  WORKSPACE_REQUEST_ID_PATTERN,
  createWorkspaceRequestId,
  workspaceRequestUuid,
} from "../../shared/src/codespaces/workspace-request-id.ts";
import { readOwnerJsonBody as jsonBody } from "./request-body.mjs";
import { validateOwnerPullRequestInput } from "./github-owner.mjs";
import { readPrivateOwnerJson as optionalJson } from "./private-json.mjs";

const DEFAULT_SEARCH_RESPONSE_BYTES = 1024 * 1024;

function refuse(code, status = 400) {
  const error = new Error(code);
  error.publicCode = code;
  error.status = status;
  throw error;
}

function json(response, value, status = 200) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
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

function nativeIdentity(reference) {
  if (
    !reference ||
    typeof reference !== "object" ||
    Array.isArray(reference) ||
    Object.keys(reference).some(
      (key) => !["fileId", "downloadUrl", "fileName", "mimeType", "declaredSize"].includes(key),
    ) ||
    typeof reference.fileId !== "string" ||
    !reference.fileId ||
    typeof reference.downloadUrl !== "string" ||
    (reference.fileName !== undefined && typeof reference.fileName !== "string") ||
    (reference.mimeType !== undefined && typeof reference.mimeType !== "string") ||
    (reference.declaredSize !== undefined &&
      (!Number.isSafeInteger(reference.declaredSize) || reference.declaredSize < 0))
  )
    refuse("INVALID_NATIVE_SOURCE");
  // Signed download authority is deliberately excluded from durable action identity.
  return {
    fileId: reference.fileId,
    ...(reference.fileName !== undefined ? { fileName: reference.fileName } : {}),
    ...(reference.mimeType !== undefined ? { mimeType: reference.mimeType } : {}),
    ...(reference.declaredSize !== undefined ? { declaredSize: reference.declaredSize } : {}),
  };
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
  sourceProxy,
  sourceOpener = openNativeFile,
  publicationScope,
  pullRequest,
  collectCredentialRequest,
  communicationTransport,
  ownerRuntimeDirectory = dirname(fileURLToPath(import.meta.url)),
  renderProgress = async (descriptor, options) =>
    (
      await import(pathToFileURL(join(ownerRuntimeDirectory, "owner-renderer.mjs")).href)
    ).renderOwnerProgress(descriptor, options),
  renderMaterialize = async (files, options) =>
    (
      await import(pathToFileURL(join(ownerRuntimeDirectory, "owner-renderer.mjs")).href)
    ).renderOwnerMaterialize(files, options),
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
  const sourceAbort = new globalThis.AbortController();
  const activeRequests = new Map();
  let closing;
  const assertOpen = () => {
    if (closing) refuse("WORKSPACE_SERVICE_CLOSING", 503);
  };
  const inLane = async (requestId, work) => {
    assertOpen();
    const predecessor = lanes.get(requestId) ?? Promise.resolve();
    const action = predecessor
      .catch(() => undefined)
      .then(() => {
        assertOpen();
        return work();
      });
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
    assertOpen();
    if (life !== (await engine.environmentIdentity())) refuse("WORKSPACE_REPLACED", 409);
    await engine.verifyBinding();
    assertOpen();
  };
  const spool = async (request, directory, declaredSize) => {
    if (await optionalJson(join(directory, "accepted.json"))) refuse("INPUT_ALREADY_ACCEPTED", 409);
    const expectedSize = declaredSize === undefined ? expectedContentSize(request) : declaredSize;
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
  const nativeBytes = (reference) =>
    (async function* () {
      let source;
      const cancel = () => source?.cancel();
      sourceAbort.signal.addEventListener("abort", cancel, { once: true });
      try {
        if (sourceAbort.signal.aborted) refuse("SOURCE_REFUSED", 422);
        source = await sourceOpener(reference, {
          proxy: sourceProxy,
          signal: sourceAbort.signal,
        });
        if (sourceAbort.signal.aborted) {
          cancel();
          refuse("SOURCE_REFUSED", 422);
        }
        if (
          source.contentLength !== null &&
          (!Number.isSafeInteger(source.contentLength) || source.contentLength < 0)
        )
          refuse("SOURCE_REFUSED", 422);
        if (
          reference.declaredSize !== undefined &&
          source.contentLength !== null &&
          source.contentLength !== reference.declaredSize
        )
          refuse("SOURCE_REFUSED", 422);
        let size = 0;
        for await (const chunk of source.body) {
          if (sourceAbort.signal.aborted) refuse("SOURCE_REFUSED", 422);
          if (!(chunk instanceof Uint8Array)) refuse("SOURCE_REFUSED", 422);
          size += chunk.byteLength;
          if (
            !Number.isSafeInteger(size) ||
            (reference.declaredSize !== undefined && size > reference.declaredSize) ||
            (source.contentLength !== null && size > source.contentLength)
          )
            refuse("SOURCE_REFUSED", 422);
          yield chunk;
        }
        if (sourceAbort.signal.aborted) refuse("SOURCE_REFUSED", 422);
        if (
          (reference.declaredSize !== undefined && size !== reference.declaredSize) ||
          (source.contentLength !== null && size !== source.contentLength)
        )
          refuse("SOURCE_REFUSED", 422);
      } catch {
        refuse("SOURCE_REFUSED", 422);
      } finally {
        sourceAbort.signal.removeEventListener("abort", cancel);
        try {
          await source?.close();
        } catch {
          refuse("SOURCE_REFUSED", 422);
        }
      }
    })();
  const operation = async (requestId) => {
    const directory = await requestDirectory(requestId);
    const accepted = await optionalJson(join(directory, "accepted.json"));
    if (!accepted) return { requestId, state: "absent" };
    if (accepted.kind === "security-acquisition") {
      const record =
        typeof collectCredentialRequest === "function"
          ? await collectCredentialRequest(requestId)
          : ((await optionalJson(join(directory, "result.json"))) ?? accepted.security);
      return { requestId, security: true, ...record };
    }
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
    if (response.destroyed || !waitMs || !["starting", "running", "unknown"].includes(status.state))
      return status;
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
  const journalOutcome = async (directory, work, admitted = false) => {
    try {
      return await work();
    } catch (error) {
      // An unreadable admission record cannot prove that no effect was accepted.
      const accepted =
        admitted || (await optionalJson(join(directory, "accepted.json")).catch(() => true));
      if (accepted) refuse("WORKSPACE_OUTCOME_UNCONFIRMED", 503);
      throw error;
    }
  };
  const commitWrite = (requestId, directory, path, expected, staged, source) =>
    journalOutcome(directory, async () => {
      await engine.writeDurableJson(directory, "accepted.json", {
        kind: source ? "native-upload" : "write",
        path,
        expected,
        size: staged.size,
        sha256: staged.sha256,
        environmentIdentity: life,
        ...(source ? { source, digest: digest({ path, expected, source }) } : {}),
      });
      await engine.withFileCommitLock(() =>
        engine.commitStaged([staged], marker(requestId), directory),
      );
      const current = await engine.currentFile(path, { stream: true });
      if (!current || current.stat.size !== staged.size || current.stat.sha256 !== staged.sha256)
        refuse("FILE_CHANGED", 409);
      const result = {
        state: "succeeded",
        path,
        current: engine.version(current.bytes, current.stat),
      };
      await engine.writeDurableJson(directory, "result.json", result);
      await engine.withFileCommitLock(() => engine.cleanupFileTransaction(directory));
      return { requestId, ...result };
    });
  let publications, communication;
  const server = createServer(async (request, response) => {
    let settled;
    const completion = new Promise((resolve) => {
      settled = resolve;
    });
    activeRequests.set(request, { response, completion });
    try {
      await assertLife();
      const url = new URL(request.url, "http://workspace");
      const parts = url.pathname.split("/").filter(Boolean);
      if (url.pathname.startsWith("/v1/communication")) {
        if (!communication) refuse("COMMUNICATION_OWNER_UNAVAILABLE", 503);
        if (
          request.method === "GET" &&
          /^\/v1\/communication\/operations\/ws1-[a-f0-9-]+$/.test(url.pathname)
        ) {
          const requestId = parts.at(-1),
            receipt = await communication.inspect(requestId);
          if (
            receipt.state === "absent" &&
            (await optionalJson(join(await requestDirectory(requestId), "accepted.json")))?.kind ===
              "communication"
          )
            return json(response, { requestId, state: "unconfirmed" });
          return json(response, receipt);
        }
        if (request.method === "POST" && url.pathname === "/v1/communication")
          return json(response, await communication.submit(await jsonBody(request)));
        if (request.method === "POST" && url.pathname === "/v1/communication/stream") {
          if (request.headers["content-type"] !== OWNER_STREAM_CONTENT_TYPE)
            refuse("COMMUNICATION_REQUEST_INVALID", 400);
          const frame = await readOwnerFrame(request);
          try {
            if (frame.control?.source?.type !== "stream")
              refuse("COMMUNICATION_REQUEST_INVALID", 400);
            const result = await communication.submit(frame.control, { stream: frame.body });
            settleOwnerFrame(request, response, frame);
            return json(response, result);
          } finally {
            settleOwnerFrame(request, response, frame);
          }
        }
        refuse("COMMUNICATION_REQUEST_INVALID", 404);
      }
      if (request.method === "GET" && url.pathname === "/v1/health")
        return json(response, {
          version: 1,
          releaseIdentity,
          processId: process.pid,
          repositoryFullName: binding.repositoryFullName,
          environmentIdentity: life,
        });
      if (request.method === "POST" && url.pathname === "/v1/tools")
        return json(response, await executeOwnerTool(socketPath, await jsonBody(request)));
      if (request.method === "POST" && url.pathname === "/v1/github/pull-requests") {
        const body = await jsonBody(request);
        if (Object.keys(body).some((key) => !["action", "input", "requestId"].includes(key)))
          refuse("INVALID_PULL_REQUEST_INPUT");
        if (typeof pullRequest !== "function") refuse("CODESPACE_PROVIDER_UNAVAILABLE", 503);
        if (body.action !== "pull_request_create") {
          const input = validateOwnerPullRequestInput(body.action, body.input);
          return json(response, await pullRequest(body.action, input));
        }
        const requestId = id(body.requestId);
        const result = await inLane(requestId, async () => {
          const directory = await requestDirectory(requestId);
          const existing = await optionalJson(join(directory, "accepted.json"));
          if (body.input === undefined) {
            if (existing && existing.kind !== "pull-request") refuse("REQUEST_ID_CONFLICT", 409);
            return operation(requestId);
          }
          const input = validateOwnerPullRequestInput(body.action, body.input);
          const identity = digest({ action: body.action, input });
          if (existing) {
            if (existing.kind !== "pull-request" || existing.digest !== identity)
              refuse("REQUEST_ID_CONFLICT", 409);
            return operation(requestId);
          }
          return journalOutcome(directory, async () => {
            await engine.writeDurableJson(directory, "accepted.json", {
              kind: "pull-request",
              digest: identity,
              environmentIdentity: life,
            });
            let receipt;
            try {
              const value = await pullRequest(body.action, input);
              receipt = { state: "succeeded", ...value };
            } catch (error) {
              if (error.publicCode === "WORKSPACE_OUTCOME_UNCONFIRMED" || !error.publicCode)
                receipt = { state: "unknown", reason: "PULL_REQUEST_OUTCOME_UNKNOWN" };
              else
                receipt = {
                  state: "not_started",
                  error: { code: error.publicCode },
                  reason: error.publicCode,
                };
              if (WORKSPACE_REQUEST_ID_PATTERN.test(error.securityRequestId ?? ""))
                receipt.security_request_id = error.securityRequestId;
            }
            await engine.writeDurableJson(directory, "result.json", receipt);
            return { requestId, ...receipt };
          });
        });
        return json(response, result);
      }
      if (request.method === "POST" && url.pathname === "/v1/files/publish")
        return json(response, await publications.publish(await jsonBody(request)));
      if (
        request.method === "GET" &&
        parts[0] === "v1" &&
        parts[1] === "publications" &&
        parts.length === 3
      ) {
        await publications.serve(parts[2], response);
        return;
      }
      if (request.method === "POST" && url.pathname === "/v1/files/native-upload") {
        const body = await jsonBody(request);
        const requestId = id(body.requestId);
        const source = nativeIdentity(body.file);
        const result = await inLane(requestId, async () => {
          const directory = await requestDirectory(requestId);
          const existing = await optionalJson(join(directory, "accepted.json"));
          if (existing) {
            if (
              existing.kind !== "native-upload" ||
              existing.digest !== digest({ path: body.path, expected: body.expected, source })
            )
              refuse("REQUEST_ID_CONFLICT", 409);
            return operation(requestId);
          }
          const staged = await engine.stageStream(
            body.path,
            nativeBytes(body.file),
            body.expected,
            marker(requestId),
          );
          return journalOutcome(directory, async () => {
            try {
              return await commitWrite(
                requestId,
                directory,
                body.path,
                body.expected,
                staged,
                source,
              );
            } finally {
              await engine.cleanupStaged([staged]);
            }
          });
        });
        return json(response, result);
      }
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
          const native = body.nativeInput === undefined ? null : nativeIdentity(body.nativeInput);
          if (native && (body.inputReady !== undefined || body.stdinText !== undefined))
            refuse("AMBIGUOUS_STDIN");
          let input =
            body.inputReady || native ? await optionalJson(join(directory, "input.json")) : null;
          if (body.inputReady && !input) refuse("INPUT_NOT_READY", 409);
          const canonical = {
            ...body,
            requestId,
            input,
            ...(native ? { nativeInput: native } : {}),
          };
          const existing = await optionalJson(join(directory, "accepted.json"));
          if (existing && (existing.kind !== "exec" || existing.digest !== digest(canonical)))
            refuse("REQUEST_ID_CONFLICT", 409);
          if (existing && native) return operation(requestId);
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
            inputReady: Boolean(input || native),
            timeoutMs: body.timeoutMs ?? null,
          };
          let refusalReason = "COMMAND_REJECTED";
          let inputHandle;
          try {
            engine.validateCommand(execution);
            await engine.verifyCommand(execution);
            if (native) {
              input = await spool(
                nativeBytes(body.nativeInput),
                directory,
                body.nativeInput.declaredSize ?? null,
              );
              canonical.input = input;
              execution.requestDigest = digest(canonical);
            }
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
          } catch (error) {
            await inputHandle?.close();
            if (error.publicCode === "SOURCE_REFUSED") throw error;
            if (error.commandReason === "SESSION_UNAVAILABLE")
              refusalReason = "SESSION_UNAVAILABLE";
            return journalOutcome(
              directory,
              async () => {
                if (!existing) {
                  await engine.writeDurableJson(directory, "accepted.json", {
                    kind: "exec",
                    digest: digest(canonical),
                    environmentIdentity: life,
                    ...(native ? { source: native } : {}),
                  });
                  await engine.writeDurableJson(directory, "result.json", {
                    state: "not_started",
                    reason: refusalReason,
                    exitCode: null,
                  });
                }
                return operation(requestId);
              },
              Boolean(existing),
            );
          }
          return journalOutcome(
            directory,
            async () => {
              try {
                if (!existing)
                  await engine.writeDurableJson(directory, "accepted.json", {
                    kind: "exec",
                    digest: digest(canonical),
                    environmentIdentity: life,
                    ...(native ? { source: native } : {}),
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
            },
            Boolean(existing),
          );
        });
        return json(response, result);
      }
      if (parts[0] === "v1" && parts[1] === "operations") {
        const requestId = id(parts[2]);
        const directory = await requestDirectory(requestId);
        if (request.method === "PUT" && parts[3] === "input")
          return json(response, await inLane(requestId, () => spool(request, directory)));
        if (request.method === "POST" && parts[3] === "cancel") {
          const result = await inLane(requestId, async () => {
            const accepted = await optionalJson(join(directory, "accepted.json"));
            if (!accepted || accepted.kind !== "exec") refuse("OPERATION_NOT_FOUND", 404);
            return journalOutcome(
              directory,
              async () => {
                await engine.cancel({
                  version: 1,
                  remoteMarker: marker(requestId),
                  requestDigest: accepted.digest,
                });
                return operation(requestId);
              },
              true,
            );
          });
          return json(response, result);
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
            return journalOutcome(directory, async () => {
              try {
                if (expectedSize !== null && staged.size !== expectedSize)
                  refuse("CONTENT_SIZE_MISMATCH", 409);
                return await commitWrite(requestId, directory, path, expected, staged);
              } finally {
                await engine.cleanupStaged([staged]);
              }
            });
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
                if (existing.kind !== "patch" || existing.digest !== digest(body))
                  refuse("REQUEST_ID_CONFLICT", 409);
                return operation(requestId);
              }
              return journalOutcome(directory, async () => {
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
              });
            }),
          );
        }
      }
      refuse("NOT_FOUND", 404);
    } catch (error) {
      if (request.url === "/v1/communication/stream") settleOwnerFrame(request, response);
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
          ...(scopedCredentialFailureOutcome(error.publicCode) !== null &&
          WORKSPACE_REQUEST_ID_PATTERN.test(error.securityRequestId ?? "")
            ? { security_request_id: error.securityRequestId }
            : {}),
        },
        error.status ?? (error.code === "ENOENT" ? 404 : 409),
      );
    } finally {
      activeRequests.delete(request);
      settled();
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
  // Recovery and expiry custody belong to the elected socket owner, never a
  // second service instance that has yet to prove the previous owner absent.
  publications = await createOwnerPublications({
    stateRoot,
    scope: publicationScope,
    environmentIdentity: life,
    engine,
  });
  if (publicationScope)
    communication = await createOwnerCommunication({
      stateRoot,
      publications,
      scope: {
        kind: "workspace",
        resourceId: publicationScope.resourceId,
        resourceGeneration: publicationScope.resourceGeneration,
        authorizationGeneration: publicationScope.authorizationGeneration,
        environmentIdentity: life,
      },
      transport: communicationTransport,
      sourceProxy,
      sourceOpener,
      renderProgress,
      renderMaterialize,
      deliverExtension,
      extensionArtifact: communicationTransport?.artifact,
      handlerHost: join(ownerRuntimeDirectory, "extension-handler-host.mjs"),
      admit: (requestId, inputDigest, work) =>
        inLane(requestId, async () => {
          const directory = await requestDirectory(requestId),
            accepted = await optionalJson(join(directory, "accepted.json"));
          if (accepted) {
            if (accepted.kind !== "communication" || accepted.digest !== inputDigest)
              refuse("REQUEST_ID_CONFLICT", 409);
            const receipt = await communication.inspect(requestId);
            return receipt.state === "absent" ? { requestId, state: "unconfirmed" } : receipt;
          }
          await engine.writeDurableJson(directory, "accepted.json", {
            kind: "communication",
            digest: inputDigest,
            environmentIdentity: life,
          });
          return journalOutcome(directory, async () => {
            const receipt = await work();
            await engine.writeDurableJson(directory, "result.json", receipt);
            return receipt;
          });
        }),
    });
  // Only the new service's private namespace owns these transactions. An interrupted
  // commit is rolled back from retained inode proof; it is never replayed as a request.
  for (const entry of await readdir(requestsRoot)) {
    if (!WORKSPACE_REQUEST_ID_PATTERN.test(entry)) refuse("UNSAFE_STATE", 409);
    const directory = await requestDirectory(entry);
    const accepted = await optionalJson(join(directory, "accepted.json"));
    if (
      !accepted ||
      ["exec", "pull-request", "security-acquisition", "communication"].includes(accepted.kind)
    )
      continue;
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
    close: () => {
      if (closing) return closing;
      // Fence before aborting preparation. Detached accepted commands retain their
      // journals and execution lifetime independently of these HTTP observers.
      closing = Promise.resolve().then(async () => {
        const httpClosed = new Promise((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
        sourceAbort.abort();
        const requests = [...activeRequests.entries()];
        for (const [request, { response }] of requests) {
          // Release stalled raw inputs and read observers, while allowing a fully
          // received native preparation to return its confirmed SOURCE_REFUSED.
          if (!request.complete || request.method === "GET") response.destroy();
        }
        await communication?.close();
        await Promise.all(requests.map(([, { completion }]) => completion));
        await Promise.all([...lanes.values()]);
        await publications.close();
        server.closeAllConnections();
        await httpClosed;
        const current = await lstat(socketPath).catch(() => null);
        if (current?.dev === socketIdentity.dev && current?.ino === socketIdentity.ino)
          await rm(socketPath);
      });
      return closing;
    },
  };
}
