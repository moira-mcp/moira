const { test, expect } = require("@jest/globals");
const { Readable, PassThrough } = require("node:stream");

test("incremental JSON preserves split Unicode and MCP batches while owner controls remain object-only", async () => {
  const { readJsonBody, readOwnerJsonBody } =
    await import("../../../packages/workspace-service/src/request-body.mjs");
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
    const { readJsonBody } =
      await import("../../../packages/workspace-service/src/request-body.mjs");
    await expect(readJsonBody(Readable.from([text]))).rejects.toMatchObject({
      publicCode: "INVALID_JSON",
      status: 400,
    });
  },
);

test("an interrupted pending JSON read rejects and releases its parser listeners", async () => {
  const { readJsonBody } = await import("../../../packages/workspace-service/src/request-body.mjs");
  const incoming = new PassThrough();
  const pending = readJsonBody(incoming);
  const refused = expect(pending).rejects.toMatchObject({ publicCode: "INVALID_JSON" });
  incoming.write('{"text":"partial');
  incoming.destroy(new Error("Caller disconnected"));
  await refused;
  expect(incoming.listenerCount("error")).toBe(0);
});
