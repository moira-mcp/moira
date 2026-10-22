import { Buffer } from "node:buffer";
import { Readable } from "node:stream";
import { readOwnerJsonBody } from "./request-body.mjs";

export const OWNER_STREAM_CONTENT_TYPE = "application/vnd.moira.owner-stream";

function invalid() {
  return Object.assign(new Error("Invalid owner stream framing"), {
    publicCode: "COMMUNICATION_REQUEST_INVALID",
    status: 400,
  });
}

/** Shared owner framing: structural metadata followed by opaque bytes under backpressure. */
export function encodeOwnerFrame(control, source) {
  const metadata = Buffer.from(JSON.stringify(control), "utf8");
  if (!metadata.length || metadata.length > 0xffffffff) throw invalid();
  const header = Buffer.alloc(4);
  header.writeUInt32BE(metadata.length);
  return {
    prefixLength: 4 + metadata.length,
    body: (async function* () {
      yield header;
      yield metadata;
      yield* source;
    })(),
  };
}

/** Read only the declared JSON prefix; even a coalesced file remainder stays opaque. */
export async function readOwnerFrame(request) {
  const iterator = request.iterator({ destroyOnReturn: false });
  let chunk = Buffer.alloc(0),
    offset = 0,
    metadata;
  const take = async (size) => {
    while (offset === chunk.length) {
      const next = await iterator.next();
      if (next.done) throw invalid();
      chunk = next.value;
      offset = 0;
    }
    const value = chunk.subarray(offset, offset + Math.min(size, chunk.length - offset));
    offset += value.length;
    return value;
  };
  try {
    const header = Buffer.alloc(4);
    for (let read = 0; read < 4;) {
      const part = await take(4 - read);
      header.set(part, read);
      read += part.length;
    }
    const length = header.readUInt32BE();
    if (!length) throw invalid();
    metadata = Readable.from(
      (async function* () {
        for (let remaining = length; remaining;) {
          const part = await take(remaining);
          remaining -= part.length;
          yield part;
        }
      })(),
    );
    const control = await readOwnerJsonBody(metadata);
    let complete = false;
    const body = Readable.from(
      (async function* () {
        try {
          if (offset < chunk.length) yield chunk.subarray(offset);
          while (true) {
            const next = await iterator.next();
            if (next.done) break;
            yield next.value;
          }
          complete = true;
        } finally {
          if (!complete) request.destroy();
          await iterator.return?.();
        }
      })(),
      {
        destroy(error, callback) {
          // Cancel the pending next() before Readable.from waits for iterator.return().
          if (!complete) request.destroy();
          callback(error);
        },
      },
    );
    request.once("close", () => {
      if (!request.readableEnded) body.destroy();
    });
    return { control, body, prefixLength: 4 + length };
  } catch {
    metadata?.once("error", () => undefined);
    metadata?.destroy();
    // The HTTP boundary flushes its confirmed refusal before closing unread ingress.
    // A pending input read must not prevent that reply from being sent.
    void iterator.return?.().catch(() => undefined);
    throw invalid();
  }
}

/** Reuse Node's flush-and-close response lifetime instead of discarding an unread body. */
export function settleOwnerFrame(request, response, frame) {
  if (frame?.body.readableEnded) frame.body.destroy();
  else {
    if (!response.headersSent) response.setHeader("Connection", "close");
    const cancel = () => {
      // Node removes an early-replied request from its incoming queue; physical
      // socket close alone does not end that request's pending Readable iterator.
      request.destroy();
      frame?.body.destroy();
    };
    if (request.socket.destroyed) cancel();
    else request.socket.once("close", cancel);
  }
}
