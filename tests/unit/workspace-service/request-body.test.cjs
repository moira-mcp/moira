const { test, expect } = require("@jest/globals");
const { Readable, PassThrough } = require("node:stream");

test("incremental JSON preserves split Unicode and MCP batches while owner controls remain object-only", async () => {
  const { readJsonBody, readOwnerJsonBody } =
    await import("../../../packages/shared/src/http/request-body.mjs");
  const value = [{ jsonrpc: "2.0", method: "通知", params: { text: "🙂" } }];
  const bytes = Buffer.from(JSON.stringify(value));
  expect(await readJsonBody(Readable.from([...bytes].map((byte) => Buffer.from([byte]))))).toEqual(
    value,
  );
  await expect(readOwnerJsonBody(Readable.from([bytes]))).rejects.toMatchObject({
    publicCode: "INVALID_JSON",
    status: 400,
  });
  expect(await readOwnerJsonBody(Readable.from(['{"text":"🙂"}']))).toEqual({ text: "🙂" });
});

test.each(['{"text":', '{"text":1}garbage', ""])(
  "invalid JSON is a controlled refusal (%s)",
  async (text) => {
    const { readJsonBody } = await import("../../../packages/shared/src/http/request-body.mjs");
    await expect(readJsonBody(Readable.from([text]))).rejects.toMatchObject({
      publicCode: "INVALID_JSON",
      status: 400,
    });
  },
);

test("an interrupted pending JSON read rejects and releases its parser listeners", async () => {
  const { readJsonBody } = await import("../../../packages/shared/src/http/request-body.mjs");
  const incoming = new PassThrough();
  const pending = readJsonBody(incoming);
  const refused = expect(pending).rejects.toMatchObject({ publicCode: "INVALID_JSON" });
  incoming.write('{"text":"partial');
  incoming.destroy(new Error("Caller disconnected"));
  await refused;
  expect(incoming.listenerCount("error")).toBe(0);
});

test("an optional byte budget accepts its UTF-8 boundary and refuses streamed excess as size, not malformed JSON", async () => {
  const { readJsonBody } = await import("../../../packages/shared/src/http/request-body.mjs");
  const bytes = Buffer.from('{"text":"🙂"}');
  expect(await readJsonBody(Readable.from([bytes]), { maxBytes: bytes.length })).toEqual({
    text: "🙂",
  });
  const incoming = new PassThrough();
  const pending = readJsonBody(incoming, { maxBytes: bytes.length - 1 });
  const refused = expect(pending).rejects.toMatchObject({
    publicCode: "BODY_TOO_LARGE",
    status: 413,
    limitBytes: bytes.length - 1,
  });
  incoming.write(bytes.subarray(0, 5));
  incoming.end(bytes.subarray(5));
  await refused;
  expect(incoming.listenerCount("error")).toBe(0);
});
