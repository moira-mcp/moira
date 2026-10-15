import parser from "stream-json";
import Assembler from "stream-json/assembler.js";

/** Shared streaming JSON metadata reader; binary file bytes never use this representation. */
export async function readOwnerJsonBody(request) {
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
      throw new Error();
    return assembler.current;
  } catch {
    throw Object.assign(new Error("INVALID_JSON"), { publicCode: "INVALID_JSON", status: 400 });
  } finally {
    request.off("error", failed);
    request.unpipe(tokens);
    tokens.destroy();
  }
}
