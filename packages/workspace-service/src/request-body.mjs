import parser from "stream-json";
import Assembler from "stream-json/assembler.js";

/** Incremental JSON value reader; binary file bytes never use this representation. */
export async function readJsonBody(request) {
  const tokens = parser({ streamValues: false });
  const assembler = new Assembler();
  const failed = (error) => tokens.destroy(error);
  request.once("error", failed);
  request.pipe(tokens);
  try {
    for await (const token of tokens) assembler.consume(token);
    if (!assembler.done) throw new Error();
    return assembler.current;
  } catch {
    throw Object.assign(new Error("INVALID_JSON"), { publicCode: "INVALID_JSON", status: 400 });
  } finally {
    request.off("error", failed);
    request.unpipe(tokens);
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
