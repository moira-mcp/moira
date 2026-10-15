import { randomBytes, createHash } from "node:crypto";
import { lstat, mkdir, readdir, realpath, rm, rmdir } from "node:fs/promises";
import { URL } from "node:url";
import { join } from "node:path";
import process from "node:process";
import { Buffer } from "node:buffer";
import {
  currentFile,
  fileIdentity,
  sameFileIdentity,
  inspectPath,
  stageStream,
  cleanupStaged,
  commitStaged,
  cleanupFileTransaction,
  recoverFileTransaction,
  writeDurableJson,
  persistDirectory,
} from "./file-primitives.mjs";

const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const MIME = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i;

function refuse(code, status = 409) {
  throw Object.assign(new Error(code), { publicCode: code, status });
}

async function privateDirectory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const stat = await lstat(path);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o077) !== 0 ||
    (await realpath(path)) !== path
  )
    refuse("UNSAFE_PUBLICATION_STATE");
  await persistDirectory(path);
  return { path, dev: stat.dev, ino: stat.ino };
}

function scopeValue(value) {
  const controller = value?.kind === "controller";
  if (
    !value ||
    (controller
      ? typeof value.userId !== "string" ||
        !value.userId ||
        !UUID.test(value.deviceId ?? "") ||
        !Number.isSafeInteger(value.deviceGeneration) ||
        value.deviceGeneration < 1 ||
        !UUID.test(value.connectionId ?? "")
      : !UUID.test(value.resourceId ?? "") ||
        !Number.isSafeInteger(value.resourceGeneration) ||
        value.resourceGeneration < 1 ||
        !Number.isSafeInteger(value.authorizationGeneration) ||
        value.authorizationGeneration < 1)
  )
    refuse("FILE_PUBLICATION_UNAVAILABLE", 503);
  let origin;
  try {
    origin = new URL(value.publicOrigin);
  } catch {
    refuse("FILE_PUBLICATION_UNAVAILABLE", 503);
  }
  if (
    origin.protocol !== "https:" ||
    origin.username ||
    origin.password ||
    origin.search ||
    origin.hash
  )
    refuse("FILE_PUBLICATION_UNAVAILABLE", 503);
  return {
    ...(controller
      ? {
          kind: "controller",
          userId: value.userId,
          deviceId: value.deviceId,
          deviceGeneration: value.deviceGeneration,
          connectionId: value.connectionId,
        }
      : {
          resourceId: value.resourceId,
          resourceGeneration: value.resourceGeneration,
          authorizationGeneration: value.authorizationGeneration,
        }),
    publicOrigin: origin.href.replace(/\/$/, ""),
  };
}

function sameScope(left, right) {
  return left && right && Object.keys(right).every((key) => left[key] === right[key]);
}

function disposition(name) {
  const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  const encoded = encodeURIComponent(name).replace(
    /['()*]/g,
    (value) => `%${value.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

function validName(value) {
  return (
    typeof value === "string" && value.length > 0 && !/[\0\r\n]/.test(value) && value.isWellFormed()
  );
}

/** Immutable owner sources. Public reads never consume a capability or dispatch work. */
export async function createOwnerPublications({
  stateRoot,
  scope,
  environmentIdentity,
  engine,
  withSource = engine?.withRegularFile,
  withCommitLock = engine?.withFileCommitLock,
  now = Date.now,
}) {
  const root = await privateDirectory(join(stateRoot, "publications"));
  const objects = await privateDirectory(join(root.path, "objects"));
  const records = await privateDirectory(join(root.path, "records"));
  const opened = new Map();
  let closed = false;

  const checkDirectory = async (binding) => {
    const stat = await lstat(binding.path);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      stat.uid !== process.getuid?.() ||
      (stat.mode & 0o077) !== 0 ||
      stat.dev !== binding.dev ||
      stat.ino !== binding.ino ||
      (await realpath(binding.path)) !== binding.path
    )
      refuse("UNSAFE_PUBLICATION_STATE");
  };
  const checkRoots = async () => {
    if (closed) refuse("FILE_PUBLICATION_UNAVAILABLE", 503);
    await checkDirectory(root);
    await checkDirectory(objects);
    await checkDirectory(records);
  };
  const recordDirectory = async (token) => {
    if (!TOKEN.test(token ?? "")) refuse("FILE_PUBLICATION_NOT_FOUND", 404);
    const path = join(records.path, token),
      stat = await lstat(path);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      stat.uid !== process.getuid?.() ||
      (stat.mode & 0o077) !== 0 ||
      (await realpath(path)) !== path
    )
      refuse("UNSAFE_PUBLICATION_STATE");
    return { path, dev: stat.dev, ino: stat.ino };
  };
  const readRecord = async (token) => {
    await checkRoots();
    const directory = await recordDirectory(token);
    const value = await currentFile(directory, "manifest.json", { keepOpen: true });
    if (
      !value ||
      value.stat.mode & 0o077 ||
      (await value.handle.stat()).uid !== process.getuid?.()
    ) {
      await value?.handle?.close();
      refuse("UNSAFE_PUBLICATION_STATE");
    }
    try {
      const record = JSON.parse(await value.handle.readFile("utf8"));
      if (
        record.version !== 1 ||
        record.token !== token ||
        !record.scope ||
        typeof record.environmentIdentity !== "string" ||
        !Number.isSafeInteger(record.size) ||
        record.size < 0 ||
        !/^[a-f0-9]{64}$/.test(record.sha256 ?? "") ||
        !Number.isSafeInteger(record.expiresAt) ||
        record.expiresAt < 1 ||
        !validName(record.fileName) ||
        !MIME.test(record.mimeType ?? "") ||
        !record.identity ||
        !sameFileIdentity(record.identity, record.identity)
      )
        refuse("UNSAFE_PUBLICATION_STATE");
      // Reading JSON must retain the same manifest inode and bytes as its initial proof.
      if (
        !sameFileIdentity(
          value.stat.identity,
          fileIdentity(await value.handle.stat({ bigint: true })),
        )
      )
        refuse("UNSAFE_PUBLICATION_STATE");
      const named = await inspectPath(directory, "manifest.json");
      try {
        if (
          !sameFileIdentity(
            value.stat.identity,
            fileIdentity(await named.handle.stat({ bigint: true })),
          )
        )
          refuse("UNSAFE_PUBLICATION_STATE");
      } finally {
        await named.handle.close();
      }
      return { record, directory, manifest: value };
    } catch (error) {
      await value.handle.close();
      throw error;
    }
  };
  const metadata = (record) => ({
    referenceId:
      record.scope.kind === "controller"
        ? `owner-file://controller/${record.scope.deviceId}/${record.token}`
        : `owner-file://workspace/${record.scope.resourceId}/${record.token}`,
    uri:
      record.scope.kind === "controller"
        ? `${record.scope.publicOrigin}/api/communication/files/${record.scope.deviceId}/${record.token}`
        : `${record.scope.publicOrigin}/api/codespaces/files/${record.scope.resourceId}/${record.token}`,
    fileName: record.fileName,
    mimeType: record.mimeType,
    size: record.size,
    sha256: record.sha256,
    expiresAt: record.expiresAt,
  });

  const publish = async ({
    path,
    fileName,
    mimeType = "application/octet-stream",
    maxBytes,
    expiresInSeconds = 3600,
    stream,
    sourceIdentity,
  }) => {
    await checkRoots();
    const selectedScope = scopeValue(scope);
    if (
      !validName(fileName) ||
      typeof mimeType !== "string" ||
      !MIME.test(mimeType) ||
      (maxBytes !== undefined && (!Number.isSafeInteger(maxBytes) || maxBytes < 1)) ||
      !Number.isSafeInteger(expiresInSeconds) ||
      expiresInSeconds < 1 ||
      !Number.isSafeInteger(now() + expiresInSeconds * 1000)
    )
      refuse("INVALID_PUBLICATION_INPUT", 400);
    if ((!stream && typeof withSource !== "function") || typeof withCommitLock !== "function")
      refuse("FILE_PUBLICATION_UNAVAILABLE", 503);
    const token = randomBytes(32).toString("base64url"),
      marker = `moira-op-${randomBytes(16).toString("hex")}`;
    const directory = await privateDirectory(join(records.path, token));
    let staged;
    try {
      // No capability becomes live inside this callback: its final source/path proof is later.
      const source = stream
        ? await (async () => {
            staged = await stageStream(objects, token, stream, { exists: false }, marker);
            return { stat: { identity: sourceIdentity } };
          })()
        : await withSource(path, async (handle, size) => {
            if (maxBytes !== undefined && size > maxBytes)
              refuse("CODESPACE_DOWNLOAD_BOUND_EXCEEDED");
            async function* bytes() {
              const buffer = Buffer.alloc(64 * 1024);
              for (let offset = 0; offset < size;) {
                const read = await handle.read(
                  buffer,
                  0,
                  Math.min(buffer.length, size - offset),
                  offset,
                );
                if (!read.bytesRead) refuse("FILE_CHANGED");
                offset += read.bytesRead;
                yield buffer.subarray(0, read.bytesRead);
              }
            }
            staged = await stageStream(objects, token, bytes(), { exists: false }, marker);
            return {};
          });
      await withCommitLock(() => commitStaged([staged], marker, directory.path));
      const object = await currentFile(objects, token, { keepOpen: true });
      if (!object) refuse("FILE_CHANGED");
      try {
        if (object.stat.size !== staged.size || object.sha256 !== staged.sha256)
          refuse("FILE_CHANGED");
        const record = {
          version: 1,
          token,
          scope: selectedScope,
          environmentIdentity,
          fileName,
          mimeType,
          size: staged.size,
          sha256: staged.sha256,
          sourceVersion: source.stat.identity,
          identity: object.stat.identity,
          expiresAt: now() + expiresInSeconds * 1000,
        };
        await writeDurableJson(directory.path, "manifest.json", record);
        await cleanupFileTransaction(directory.path, objects);
        return metadata(record);
      } finally {
        await object.handle.close();
      }
    } finally {
      if (staged && !staged.closed) await cleanupStaged([staged]);
    }
  };

  const openSource = async (token, signal) => {
    const selectedScope = scopeValue(scope);
    const loaded = await readRecord(token);
    await loaded.manifest.handle.close();
    const { record } = loaded;
    if (
      !sameScope(record.scope, selectedScope) ||
      record.environmentIdentity !== environmentIdentity ||
      now() >= record.expiresAt
    )
      refuse("FILE_PUBLICATION_NOT_FOUND", 404);
    const file = await currentFile(objects, token, { keepOpen: true });
    if (
      !file ||
      file.stat.size !== record.size ||
      file.sha256 !== record.sha256 ||
      !sameFileIdentity(record.identity, file.stat.identity)
    ) {
      await file?.handle?.close();
      refuse("FILE_PUBLICATION_CHANGED");
    }
    let settledResolve,
      stopping = false,
      closing;
    const settled = new Promise((resolve) => {
      settledResolve = resolve;
    });
    const streams = opened.get(token) ?? new Set();
    opened.set(token, streams);
    const close = () =>
      (closing ??= (async () => {
        stopping = true;
        signal?.removeEventListener("abort", aborted);
        try {
          await file.handle.close();
        } finally {
          streams.delete(source);
          if (!streams.size) opened.delete(token);
          settledResolve();
        }
      })());
    const aborted = () => {
      void close().catch(() => undefined);
    };
    const source = {
      ...metadata(record),
      settled,
      close,
      async *[Symbol.asyncIterator]() {
        const hash = createHash("sha256");
        let pending;
        try {
          for (let offset = 0; offset < record.size && !stopping;) {
            const chunk = Buffer.alloc(Math.min(64 * 1024, record.size - offset));
            const read = await file.handle.read(chunk, 0, chunk.length, offset);
            if (stopping) return;
            if (!read.bytesRead) refuse("FILE_PUBLICATION_CHANGED");
            offset += read.bytesRead;
            const bytes = chunk.subarray(0, read.bytesRead);
            hash.update(bytes);
            if (pending) yield pending;
            pending = bytes;
          }
          if (stopping) return;
          const named = await inspectPath(objects, token);
          try {
            if (
              hash.digest("hex") !== record.sha256 ||
              !sameFileIdentity(
                record.identity,
                fileIdentity(await file.handle.stat({ bigint: true })),
              ) ||
              !sameFileIdentity(
                record.identity,
                fileIdentity(await named.handle.stat({ bigint: true })),
              )
            )
              refuse("FILE_PUBLICATION_CHANGED");
          } finally {
            await named.handle.close();
          }
          if (pending && !stopping) yield pending;
        } finally {
          await close();
        }
      },
    };
    streams.add(source);
    signal?.addEventListener("abort", aborted, { once: true });
    if (signal?.aborted || now() >= record.expiresAt) {
      await close();
      refuse("FILE_PUBLICATION_NOT_FOUND", 404);
    }
    return source;
  };

  const cleanup = async () => {
    if (closed) return;
    await checkRoots();
    for (const token of await readdir(records.path)) {
      if (!TOKEN.test(token)) continue;
      let loaded;
      try {
        loaded = await readRecord(token);
      } catch {
        continue;
      }
      const { record, directory, manifest } = loaded;
      try {
        if (now() < record.expiresAt) continue;
        await Promise.all([...(opened.get(token) ?? [])].map((source) => source.settled));
        const object = await currentFile(objects, token, { keepOpen: true });
        try {
          if (
            object &&
            (object.sha256 !== record.sha256 ||
              !sameFileIdentity(record.identity, object.stat.identity))
          )
            continue;
          // Retain foreign replacements; only exact private source/manifest custody allows disposal.
          const namedManifest = await currentFile(directory, "manifest.json");
          if (
            !namedManifest ||
            !sameFileIdentity(manifest.stat.identity, namedManifest.stat.identity)
          )
            continue;
          if (object) {
            const named = await inspectPath(objects, token);
            try {
              if (
                !sameFileIdentity(
                  record.identity,
                  fileIdentity(await named.handle.stat({ bigint: true })),
                ) ||
                !sameFileIdentity(
                  record.identity,
                  fileIdentity(await object.handle.stat({ bigint: true })),
                )
              )
                continue;
              await rm(join(objects.path, token));
              await persistDirectory(objects.path);
            } finally {
              await named.handle.close();
            }
          }
          await rm(join(directory.path, "manifest.json"));
          await persistDirectory(directory.path);
          // Unknown transaction evidence is never erased with the expired capability.
          if (!(await readdir(directory.path)).length) {
            await checkDirectory(directory);
            await rmdir(directory.path);
          }
          await persistDirectory(records.path);
        } finally {
          await object?.handle?.close();
        }
      } finally {
        await manifest.handle.close();
      }
    }
  };

  // Recovery settles this private snapshot transaction; it never reacquires a source or publishes a token.
  for (const token of await readdir(records.path)) {
    if (!TOKEN.test(token)) continue;
    const directory = await recordDirectory(token);
    const manifest = await lstat(join(directory.path, "manifest.json")).catch((error) => {
      if (error.code !== "ENOENT") throw error;
      return null;
    });
    if (manifest) await cleanupFileTransaction(directory.path, objects);
    else
      await recoverFileTransaction(directory.path, objects).catch((error) => {
        if (error.fileReason !== "concurrent_change") throw error;
      });
  }
  let cleaning;
  const timer = globalThis.setInterval(() => {
    if (!cleaning)
      cleaning = cleanup()
        .catch(() => undefined)
        .finally(() => {
          cleaning = null;
        });
  }, 30_000);
  timer.unref();
  return {
    publish,
    capture(input) {
      if (
        !input.stream ||
        typeof input.stream[Symbol.asyncIterator] !== "function" ||
        !input.sourceIdentity
      )
        refuse("INVALID_PUBLICATION_INPUT", 400);
      return publish(input);
    },
    openSource,
    async serve(token, response) {
      const abort = new globalThis.AbortController();
      const disconnected = () => abort.abort();
      response.once("close", disconnected);
      let source;
      try {
        source = await openSource(token, abort.signal);
        response.writeHead(200, {
          "content-type": source.mimeType,
          "content-length": source.size,
          "content-disposition": disposition(source.fileName),
          "cache-control": "private, no-store, max-age=0",
          "x-content-type-options": "nosniff",
          "x-robots-tag": "noindex, nofollow, noarchive",
          "referrer-policy": "no-referrer",
        });
        for await (const bytes of source) {
          if (response.destroyed) break;
          await new Promise((resolve, reject) => {
            const closed = () => resolve();
            response.once("close", closed);
            response.write(bytes, (error) => {
              response.off("close", closed);
              if (error && !response.destroyed) reject(error);
              else resolve();
            });
          });
        }
        if (!response.destroyed) response.end();
      } finally {
        response.off("close", disconnected);
        await source?.close();
      }
    },
    async close() {
      closed = true;
      globalThis.clearInterval(timer);
      await Promise.all(
        [...opened.values()].flatMap((streams) => [...streams].map((source) => source.close())),
      );
      await cleaning;
    },
  };
}
