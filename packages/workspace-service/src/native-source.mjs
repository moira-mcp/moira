import { request } from "node:https";
import { isIP } from "node:net";
import { URL } from "node:url";
import { setTimeout, clearTimeout } from "node:timers";
import { connectHttps, transportClosed } from "./tls-transport.mjs";

const HEADER_ADMISSION_MS = 30_000;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const MIME = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i;

export class SourceRefusal extends Error {
  publicCode = "SOURCE_REFUSED";
  status = 422;
  constructor() {
    super("Native file source refused");
    this.name = "SourceRefusal";
  }
}

/** Stable operation identity excludes the transient signed download authority. */
export function nativeFileIdentity(reference) {
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
    throw Object.assign(new Error("Invalid native file source"), {
      publicCode: "INVALID_NATIVE_SOURCE",
      status: 400,
    });
  return {
    fileId: reference.fileId,
    ...(reference.fileName !== undefined ? { fileName: reference.fileName } : {}),
    ...(reference.mimeType !== undefined ? { mimeType: reference.mimeType } : {}),
    ...(reference.declaredSize !== undefined ? { declaredSize: reference.declaredSize } : {}),
  };
}

/** Apply the same byte and lifetime contract to HTTPS and trusted in-process source transports. */
export async function nativeFileBytes(reference, { sourceOpener, proxy, signal } = {}) {
  nativeFileIdentity(reference);
  let source;
  let closing;
  let resolveSettled, rejectSettled;
  const settled = new Promise((resolve, reject) => {
    resolveSettled = resolve;
    rejectSettled = reject;
  });
  settled.catch(() => {});
  const close = () => {
    if (!closing) {
      signal?.removeEventListener("abort", cancel);
      closing = (async () => {
        try {
          source?.cancel?.();
        } finally {
          try {
            await source?.close();
          } finally {
            await source?.settled;
          }
        }
      })().then(resolveSettled, () => {
        const error = new SourceRefusal();
        rejectSettled(error);
        throw error;
      });
    }
    return closing;
  };
  const cancel = () => {
    void close().catch(() => {});
  };
  try {
    if (signal?.aborted) throw new SourceRefusal();
    const open =
      !sourceOpener || sourceOpener === openNativeFile ? openNativeTransport : sourceOpener;
    source = await open(reference, { proxy, signal });
    if (signal?.aborted) throw new SourceRefusal();
    signal?.addEventListener("abort", cancel, { once: true });
    const contentLength = source.contentLength;
    const mimeType = source.mimeType ?? "application/octet-stream";
    if (
      !source.body ||
      typeof source.body[Symbol.asyncIterator] !== "function" ||
      (contentLength !== null && (!Number.isSafeInteger(contentLength) || contentLength < 0)) ||
      (reference.declaredSize !== undefined &&
        contentLength !== null &&
        contentLength !== reference.declaredSize) ||
      typeof mimeType !== "string" ||
      mimeType.length > 256 ||
      !MIME.test(mimeType)
    )
      throw new SourceRefusal();
    const body = (async function* () {
      let received = 0;
      try {
        if (closing) throw new SourceRefusal();
        for await (const chunk of source.body) {
          if (signal?.aborted || !(chunk instanceof Uint8Array)) throw new SourceRefusal();
          received += chunk.byteLength;
          if (
            !Number.isSafeInteger(received) ||
            (reference.declaredSize !== undefined && received > reference.declaredSize) ||
            (contentLength !== null && received > contentLength)
          )
            throw new SourceRefusal();
          yield chunk;
        }
        if (
          signal?.aborted ||
          (reference.declaredSize !== undefined && received !== reference.declaredSize) ||
          (contentLength !== null && received !== contentLength)
        )
          throw new SourceRefusal();
      } catch {
        throw new SourceRefusal();
      } finally {
        await close();
      }
    })();
    return { body, contentLength, mimeType, close, cancel, settled };
  } catch {
    await close();
    throw new SourceRefusal();
  }
}

export function trustedNativeFileHost(host) {
  const normalized = host.toLowerCase().replace(/\.$/, "");
  return (
    (normalized.endsWith(".oaiusercontent.com") &&
      normalized.length > ".oaiusercontent.com".length) ||
    /^oaisdmntpr[a-z0-9-]{1,80}\.blob\.core\.windows\.net$/.test(normalized)
  );
}

function sourceUrl(value, base) {
  try {
    const url = base ? new URL(value, base) : new URL(value);
    if (
      url.protocol !== "https:" ||
      (url.port && url.port !== "443") ||
      url.username ||
      url.password ||
      url.hash ||
      isIP(url.hostname) ||
      !trustedNativeFileHost(url.hostname)
    )
      throw new SourceRefusal();
    return url;
  } catch {
    throw new SourceRefusal();
  }
}

/** Acquire source bytes at the owner; signed download authority never leaves this call. */
export function openNativeFile(reference, options) {
  return nativeFileBytes(reference, options);
}

async function openNativeTransport(reference, { proxy, signal } = {}) {
  let url = sourceUrl(reference.downloadUrl);
  const controller = new globalThis.AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  let timer;
  let outgoing;
  let incoming;
  let socket;
  let closed = false;
  let closing = Promise.resolve();
  const held = [];
  const cancel = () => {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
    closing = Promise.all(held).then(() => undefined);
    controller.abort();
    incoming?.destroy();
    outgoing?.destroy();
    socket?.destroy();
  };
  const close = async () => {
    cancel();
    await closing;
  };
  try {
    for (let redirects = 0; ; redirects++) {
      // This bounds header admission (including DNS/CONNECT/TLS), never body consumption.
      timer = setTimeout(() => controller.abort(), HEADER_ADMISSION_MS);
      timer.unref();
      socket = await connectHttps({
        hostname: url.hostname,
        proxy,
        signal: controller.signal,
        publicTarget: true,
      });
      held.push(transportClosed(socket));
      incoming = await new Promise((resolve, reject) => {
        outgoing = request(
          {
            hostname: url.hostname,
            port: 443,
            method: "GET",
            path: `${url.pathname}${url.search}`,
            createConnection: () => socket,
            signal: controller.signal,
            maxHeaderSize: 8192,
            headers: { accept: "*/*", "user-agent": "Moira-Workspace-Source/1" },
          },
          resolve,
        );
        outgoing.once("error", () => reject(new SourceRefusal()));
        outgoing.end();
      });
      held.push(transportClosed(incoming));
      clearTimeout(timer);
      const status = incoming.statusCode ?? 0;
      if (REDIRECTS.has(status)) {
        const next = incoming.headers.location;
        incoming.destroy();
        outgoing.destroy();
        socket.destroy();
        if (!next || redirects >= 3) throw new SourceRefusal();
        url = sourceUrl(next, url);
        continue;
      }
      if (status !== 200) throw new SourceRefusal();
      const length = incoming.headers["content-length"];
      const contentLength = length === undefined ? null : Number(length);
      const header = incoming.headers["content-type"] ?? "application/octet-stream";
      if (typeof header !== "string" || header.length > 256) throw new SourceRefusal();
      const mimeType = header.split(";", 1)[0].trim().toLowerCase();
      return { body: incoming, contentLength, mimeType, close, cancel };
    }
  } catch {
    await close();
    throw new SourceRefusal();
  }
}
