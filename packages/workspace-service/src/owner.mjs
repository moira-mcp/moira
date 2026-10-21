import { constants, watch } from "node:fs";
import { lstat, mkdir, open, readdir, rename, rm } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { Buffer } from "node:buffer";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { clearTimeout, setTimeout } from "node:timers";
import { createWorkspaceEngine } from "./engine.mjs";
import {
  openNativeFile,
  nativeFileIdentity as nativeIdentity,
  nativeFileBytes,
} from "./native-source.mjs";
import { createOwnerPublications } from "./publications.mjs";
import { createOwnerCommunication } from "./owner-communication.mjs";
import { deliverOwnerExtension as deliverExtension } from "./extension-owner.mjs";
import { canonicalJson } from "../../shared/src/utils/canonical-json.ts";
import {
  WORKSPACE_REQUEST_ID_PATTERN,
  createWorkspaceRequestId,
  workspaceRequestUuid,
} from "../../shared/src/codespaces/workspace-request-id.ts";
import { validateOwnerPullRequestInput } from "./github-owner.mjs";
import { readPrivateOwnerJson as optionalJson } from "./private-json.mjs";
import { createSemanticOwner } from "./semantic-owner.mjs";

const DEFAULT_SEARCH_RESPONSE_BYTES = 1024 * 1024;

function refuse(code, status = 400) {
  const error = new Error(code);
  error.publicCode = code;
  error.status = status;
  throw error;
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
/** Common operation owner; its host establishes exclusive custody before construction. */
export async function createWorkspaceOwner({
  stateRoot,
  binding,
  releaseIdentity,
  searchExecutable,
  sourceProxy,
  sourceOpener = openNativeFile,
  publicationScope,
  ownerSelector,
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
  const lanes = new Map();
  const launches = new Map();
  const sourceAbort = new globalThis.AbortController();
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
    await engine.verifyBindingIdentity();
    assertOpen();
  };
  const spool = async (request, directory, expectedSize = null) => {
    if (await optionalJson(join(directory, "accepted.json"))) refuse("INPUT_ALREADY_ACCEPTED", 409);
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
      // Source acquisition is a real access boundary before any private bytes are fetched.
      // The eventual command/file effect checks its binding again after this asynchronous work.
      await engine.verifyBinding();
      const source = await nativeFileBytes(reference, {
        sourceOpener,
        proxy: sourceProxy,
        signal: sourceAbort.signal,
      });
      try {
        yield* source.body;
      } finally {
        await source.close();
        await source.settled;
      }
    })();
  const operation = async (requestId) => {
    id(requestId);
    const directory = join(requestsRoot, requestId);
    const accepted = await optionalJson(join(directory, "accepted.json"));
    if (!accepted) return { requestId, state: "absent" };
    if (accepted.kind === "security-acquisition") {
      const record =
        typeof collectCredentialRequest === "function"
          ? await collectCredentialRequest(requestId)
          : ((await optionalJson(join(directory, "result.json"))) ?? accepted.security);
      return { requestId, security: true, ...record };
    }
    if (accepted.kind === "communication") {
      if (!communication) return { requestId, state: "unconfirmed" };
      const receipt = await communication.inspect(requestId);
      return receipt.state === "absent" ? { requestId, state: "unconfirmed" } : receipt;
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
  const observeOperation = async (requestId, waitMs, signal) => {
    if (!Number.isSafeInteger(waitMs) || waitMs < 0) refuse("INVALID_WAIT_WINDOW");
    let status = await operation(requestId);
    if (signal?.aborted || !waitMs || !["starting", "running", "unknown"].includes(status.state))
      return status;
    const path = engine.operationDirectory(marker(requestId));
    await new Promise((resolve, reject) => {
      let watcher;
      let timer;
      let checking = false;
      let dirty = false;
      let watchingParent = false;
      let finished = false;
      const settle = (error) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        watcher?.close();
        signal?.removeEventListener("abort", closed);
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
            if (finished) return;
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
      signal?.addEventListener("abort", closed, { once: true });
      timer = setTimeout(() => settle(), Math.min(waitMs, 2147483647));
      void changed();
    });
    return status;
  };
  const range = async (handle, size, offset, length, consume) => {
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      (length !== null && (!Number.isSafeInteger(length) || length < 0))
    )
      refuse("INVALID_RANGE");
    if (offset > size) refuse("INVALID_RANGE", 416);
    const end = length === null ? size : Math.min(size, offset + length);
    const body = (async function* () {
      let position = offset;
      while (position < end) {
        const buffer = Buffer.alloc(Math.min(64 * 1024, end - position));
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
        if (!bytesRead) refuse("FILE_CHANGED", 409);
        position += bytesRead;
        yield buffer.subarray(0, bytesRead);
      }
    })();
    return consume({ body, total: size, size: end - offset });
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
  const commitWrite = (requestId, directory, path, expected, staged, source, intent) =>
    journalOutcome(directory, async () => {
      await engine.writeDurableJson(directory, "accepted.json", {
        kind: source ? "native-upload" : "write",
        path,
        expected,
        size: staged.size,
        sha256: staged.sha256,
        environmentIdentity: life,
        intent: {
          ...(intent ?? { kind: "file-change", description: `Write ${path}` }),
          createdAt: Date.now(),
        },
        ...(source ? { source, digest: digest({ path, expected, source }) } : {}),
      });
      await engine.withFileCommitLock(async () => {
        await engine.verifyBinding();
        return engine.commitStaged([staged], marker(requestId), directory);
      });
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
  const pullRequestAction = async (body) => {
    if (Object.keys(body).some((key) => !["action", "input", "requestId", "intent"].includes(key)))
      refuse("INVALID_PULL_REQUEST_INPUT");
    if (typeof pullRequest !== "function") refuse("CODESPACE_PROVIDER_UNAVAILABLE", 503);
    if (body.action !== "pull_request_create") {
      const input = validateOwnerPullRequestInput(body.action, body.input);
      return await pullRequest(body.action, input);
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
          intent: {
            ...(body.intent ?? { kind: "pull-request", description: "Create pull request" }),
            createdAt: Date.now(),
          },
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
    return result;
  };
  const nativeUpload = async (body) => {
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
            body.intent,
          );
        } finally {
          await engine.cleanupStaged([staged]);
        }
      });
    });
    return result;
  };
  const execute = async (body) => {
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
        return journalOutcome(
          directory,
          async () => {
            if (!existing) {
              await engine.writeDurableJson(directory, "accepted.json", {
                kind: "exec",
                digest: digest(canonical),
                environmentIdentity: life,
                intent: {
                  ...(body.intent ?? { kind: "command", description: "Command" }),
                  createdAt: Date.now(),
                },
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
                intent: {
                  ...(body.intent ?? { kind: "command", description: "Command" }),
                  createdAt: Date.now(),
                },
                ...(native ? { source: native } : {}),
              });
            if (await optionalJson(join(directory, "result.json"))) return operation(requestId);
            if (existing) return operation(requestId);
            const retainedInput = inputHandle;
            inputHandle = undefined;
            const launch = engine
              .execute(execution, retainedInput?.fd)
              // Only the engine's physical launch/result evidence decides the outcome.
              // Observer failure never publishes a second logical command result.
              .catch(() => undefined)
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
    return result;
  };
  const write = async ({ requestId, path, expected, source, expectedSize = null, intent }) => {
    id(requestId);
    const result = await inLane(requestId, async () => {
      const directory = await requestDirectory(requestId);
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
        for await (const chunk of source) {
          hash.update(chunk);
          size += chunk.length;
        }
        if (expectedSize !== null && size !== expectedSize) refuse("CONTENT_SIZE_MISMATCH", 409);
        if (hash.digest("hex") !== existing.sha256 || size !== existing.size)
          refuse("REQUEST_ID_CONFLICT", 409);
        return operation(requestId);
      }
      const staged = await engine.stageStream(path, source, expected, marker(requestId));
      return journalOutcome(directory, async () => {
        try {
          if (expectedSize !== null && staged.size !== expectedSize)
            refuse("CONTENT_SIZE_MISMATCH", 409);
          return await commitWrite(requestId, directory, path, expected, staged, undefined, intent);
        } finally {
          await engine.cleanupStaged([staged]);
        }
      });
    });
    return result;
  };
  const patch = async (body) => {
    const requestId = id(body.requestId);
    return inLane(requestId, async () => {
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
          intent: {
            ...(body.intent ?? { kind: "file-change", description: "Patch files" }),
            createdAt: Date.now(),
          },
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
            engine.fileRequest({ action: "apply_patch", files }, marker(requestId), directory),
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
    });
  };

  const owner = {
    execute,
    nativeUpload,
    write,
    patch,
    pullRequestAction,
    inspect: operation,
    observe: (requestId, waitMs, signal) =>
      observeOperation(
        requestId,
        waitMs,
        signal ? globalThis.AbortSignal.any([signal, sourceAbort.signal]) : sourceAbort.signal,
      ),
    input: (requestId, source, declaredSize) =>
      inLane(id(requestId), async () =>
        spool(source, await requestDirectory(requestId), declaredSize),
      ),
    cancel: (requestId) =>
      inLane(id(requestId), async () => {
        const directory = await requestDirectory(requestId);
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
      }),
    file: (body, signal) =>
      engine.fileRequest(
        {
          ...body,
          signal: signal
            ? globalThis.AbortSignal.any([signal, sourceAbort.signal])
            : sourceAbort.signal,
          maxMatches: body.maxMatches ?? 1000,
          maxBytes: body.maxBytes ?? DEFAULT_SEARCH_RESPONSE_BYTES,
        },
        marker(createWorkspaceRequestId()),
        stateRoot,
      ),
    publish: (body) => publications.publish(body),
    fileRange: (path, offset, length, consume) =>
      engine.withRegularFile(path, (handle, size) => range(handle, size, offset, length, consume)),
    outputRange: async (requestId, stream, offset, length, consume) => {
      id(requestId);
      if (!["stdout", "stderr"].includes(stream)) refuse("INVALID_STREAM");
      const handle = await open(
        join(engine.operationDirectory(marker(requestId)), `${stream}.log`),
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      try {
        const info = await handle.stat();
        if (!info.isFile() || info.nlink !== 1) refuse("UNSAFE_OUTPUT", 409);
        return await range(handle, info.size, offset, length, consume);
      } finally {
        await handle.close();
      }
    },
  };
  // Recovery and expiry custody belong to this admitted owner. The HTTP host
  // establishes socket custody before constructing the common operation API.
  publications = await createOwnerPublications({
    stateRoot,
    scope: publicationScope,
    environmentIdentity: life,
    engine,
  });
  const communicationScope = (scope) =>
    scope
      ? {
          kind: "workspace",
          resourceId: scope.resourceId,
          resourceGeneration: scope.resourceGeneration,
          authorizationGeneration: scope.authorizationGeneration,
          environmentIdentity: life,
        }
      : undefined;
  communication = await createOwnerCommunication({
    stateRoot,
    publications,
    scope: communicationScope(publicationScope),
    transport: communicationTransport,
    sourceProxy,
    sourceOpener,
    renderProgress,
    renderMaterialize,
    deliverExtension,
    extensionArtifact: communicationTransport?.artifact,
    handlerHost: join(ownerRuntimeDirectory, "extension-handler-host.mjs"),
    admit: (requestId, inputDigest, work, descriptor) =>
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
          intent: descriptor,
        });
        return journalOutcome(directory, work);
      }),
  });
  owner.configureRemote = (configuration = {}) => {
    publications.configureScope(configuration.publicationScope);
    communication.configure({
      scope: communicationScope(configuration.publicationScope),
      transport: configuration.communicationTransport,
      extensionArtifact: configuration.communicationTransport?.artifact,
    });
    publicationScope = configuration.publicationScope;
  };
  const semantic = createSemanticOwner({
    owner,
    engine,
    binding,
    ownerSelector,
    requestsRoot,
    publicationScope: () => publicationScope,
    readAccepted: (requestId) => optionalJson(join(requestsRoot, id(requestId), "accepted.json")),
    readInput: (requestId) => optionalJson(join(requestsRoot, id(requestId), "input.json")),
    readResult: (requestId, accepted) =>
      optionalJson(
        accepted.kind === "exec"
          ? join(engine.operationDirectory(marker(requestId)), "result.json")
          : accepted.kind === "communication"
            ? join(stateRoot, "communication", `${requestId}.json`)
            : join(requestsRoot, id(requestId), "result.json"),
      ),
    listRequests: () => readdir(requestsRoot),
  });
  owner.semantic = semantic.execute;
  owner.operation_find = semantic.find;
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

  owner.health = () => ({
    version: 1,
    releaseIdentity,
    processId: process.pid,
    repositoryFullName: binding.repositoryFullName,
    environmentIdentity: life,
  });
  owner.submitCommunication = (input, options) => {
    if (!communication) refuse("COMMUNICATION_OWNER_UNAVAILABLE", 503);
    return communication.submit(input, options);
  };
  owner.inspectCommunication = async (requestId) => {
    id(requestId);
    if (!communication) refuse("COMMUNICATION_OWNER_UNAVAILABLE", 503);
    const receipt = await communication.inspect(requestId);
    return receipt.state === "absent" &&
      (await optionalJson(join(await requestDirectory(requestId), "accepted.json")))?.kind ===
        "communication"
      ? { requestId, state: "unconfirmed" }
      : receipt;
  };
  owner.openPublication = (token, signal) =>
    publications.openSource(
      token,
      signal ? globalThis.AbortSignal.any([signal, sourceAbort.signal]) : sourceAbort.signal,
    );
  const active = new Set();
  const repositoryReads = new Set([
    "health",
    "publish",
    "fileRange",
    "pullRequestAction",
    "submitCommunication",
    "openPublication",
  ]);
  const operations = Object.fromEntries(
    Object.entries(owner).map(([name, perform]) => [
      name,
      (...args) => {
        const work = (async () => {
          try {
            await assertLife();
            if (repositoryReads.has(name)) await engine.verifyBinding();
            return await perform(...args);
          } catch (error) {
            // All adapters receive the same owner refusal. Accepted effects are
            // already fenced by journalOutcome and retain their uncertainty.
            if (!error.publicCode && !error.fileReason)
              error.publicCode =
                error.code === "ENOENT" ? "NOT_FOUND" : "WORKSPACE_OPERATION_ERROR";
            throw error;
          }
        })();
        active.add(work);
        void work.finally(() => active.delete(work)).catch(() => undefined);
        return work;
      },
    ]),
  );
  return {
    ...operations,
    close: () => {
      if (closing) return closing;
      closing = Promise.resolve().then(async () => {
        sourceAbort.abort();
        await communication?.close();
        await Promise.allSettled([...active]);
        await Promise.all([...lanes.values()]);
        await publications.close();
      });
      return closing;
    },
  };
}
