import { describe, expect, jest, test } from "@jest/globals";
import { EventEmitter } from "node:events";
import { redeemProgressImage } from "../../../packages/web-backend/src/routes/execution-progress-image.js";

function response(mode: "finish" | "close" | "throw") {
  const emitter = new EventEmitter() as any;
  emitter.status = jest.fn(() => emitter);
  emitter.json = jest.fn();
  emitter.setHeader = jest.fn();
  emitter.send = jest.fn(() => {
    if (mode === "throw") throw new Error("write failed");
    emitter.emit(mode);
  });
  return emitter;
}

describe("progress image HTTP completion lifecycle", () => {
  test.each([
    ["finish", 1, 0],
    ["close", 0, 1],
    ["throw", 0, 1],
  ] as const)("%s commits only a finished response", async (mode, completed, released) => {
    const service = {
      redeem: jest.fn(async () => ({ png: Buffer.from("png"), claimId: "claim" })),
      complete: jest.fn(() => true),
      release: jest.fn(() => true),
    } as any;
    const res = response(mode);
    const next = jest.fn();
    await redeemProgressImage({ params: { token: "token" } } as any, res, next, service);
    expect(service.complete).toHaveBeenCalledTimes(completed);
    expect(service.release).toHaveBeenCalledTimes(released);
    expect(next).toHaveBeenCalledTimes(mode === "throw" ? 1 : 0);
  });
});
