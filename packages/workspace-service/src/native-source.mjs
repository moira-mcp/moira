import { request } from "node:https";
import { isIP } from "node:net";
import { URL } from "node:url";
import { setTimeout, clearTimeout } from "node:timers";
import { connectHttps } from "./tls-transport.mjs";

const HEADER_ADMISSION_MS = 30_000;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const MIME = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i;

export class SourceRefusal extends Error {
  publicCode = "SOURCE_REFUSED";
  constructor() {
    super("Native file source refused");
    this.name = "SourceRefusal";
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
export async function openNativeFile(reference, { proxy, signal } = {}) {
  if (
    !reference ||
    typeof reference.fileId !== "string" ||
    !reference.fileId ||
    typeof reference.downloadUrl !== "string" ||
    (reference.declaredSize !== undefined &&
      (!Number.isSafeInteger(reference.declaredSize) || reference.declaredSize < 0))
  )
    throw new SourceRefusal();
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
  const cancel = () => {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
    closing = Promise.all(
      [incoming, socket]
        .filter((stream) => stream && !stream.closed)
        .map((stream) => new Promise((done) => stream.once("close", done))),
    ).then(() => undefined);
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
      if (
        contentLength !== null &&
        (!Number.isSafeInteger(contentLength) ||
          contentLength < 0 ||
          (reference.declaredSize !== undefined && reference.declaredSize !== contentLength))
      )
        throw new SourceRefusal();
      const header = incoming.headers["content-type"] ?? "application/octet-stream";
      if (typeof header !== "string" || header.length > 256) throw new SourceRefusal();
      const mimeType = header.split(";", 1)[0].trim().toLowerCase();
      if (!MIME.test(mimeType)) throw new SourceRefusal();
      const body = (async function* () {
        let received = 0;
        try {
          for await (const chunk of incoming) {
            received += chunk.byteLength;
            if (
              !Number.isSafeInteger(received) ||
              (reference.declaredSize !== undefined && received > reference.declaredSize)
            )
              throw new SourceRefusal();
            yield chunk;
          }
          if (
            (contentLength !== null && received !== contentLength) ||
            (reference.declaredSize !== undefined && received !== reference.declaredSize)
          )
            throw new SourceRefusal();
        } catch {
          throw new SourceRefusal();
        } finally {
          cancel();
        }
      })();
      return { body, contentLength, mimeType, close, cancel };
    }
  } catch {
    cancel();
    throw new SourceRefusal();
  }
}
