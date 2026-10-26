import parser from "stream-json";
import Assembler from "stream-json/assembler.js";
import { Transform } from "node:stream";
import { Buffer } from "node:buffer";

export class RequestBodyLimitError extends Error {
  publicCode = "BODY_TOO_LARGE";
  status = 413;

  constructor(limitBytes, receivedBytes) {
    super("Request body exceeds its byte budget");
    this.limitBytes = limitBytes;
    this.receivedBytes = receivedBytes;
  }
}

/** Incremental JSON value reader; binary file bytes remain outside JSON control bodies. */
export async function readJsonBody(request, options = {}) {
  const { maxBytes } = options;
  if (maxBytes !== undefined && (!Number.isSafeInteger(maxBytes) || maxBytes < 0))
    throw new RangeError("A request byte budget must be a nonnegative safe integer");
  const tokens = parser({ streamValues: false });
  const assembler = new Assembler();
  const failed = (error) => tokens.destroy(error);
  let receivedBytes = 0;
  const gate =
    maxBytes === undefined
      ? undefined
      : new Transform({
          transform(chunk, encoding, callback) {
            receivedBytes += Buffer.isBuffer(chunk)
              ? chunk.length
              : Buffer.byteLength(chunk, encoding);
            if (receivedBytes > maxBytes)
              callback(new RequestBodyLimitError(maxBytes, receivedBytes));
            else callback(null, chunk);
          },
        });
  request.once("error", failed);
  if (gate) {
    gate.once("error", failed);
    request.pipe(gate).pipe(tokens);
  } else request.pipe(tokens);
  try {
    for await (const token of tokens) assembler.consume(token);
    if (!assembler.done) throw new Error();
    return assembler.current;
  } catch (error) {
    if (error instanceof RequestBodyLimitError) throw error;
    throw Object.assign(new Error("INVALID_JSON"), { publicCode: "INVALID_JSON", status: 400 });
  } finally {
    request.off("error", failed);
    request.unpipe(tokens);
    if (gate) {
      request.unpipe(gate);
      gate.unpipe(tokens);
      gate.destroy();
    }
    tokens.destroy();
  }
}

/** Owner control protocols accept objects; MCP retains its own JSON-RPC root validation. */
export async function readOwnerJsonBody(request) {
  const value = await readJsonBody(request);
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw Object.assign(new Error("INVALID_JSON"), { publicCode: "INVALID_JSON", status: 400 });
  return value;
}
